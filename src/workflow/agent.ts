import { closeSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  addWorktree,
  branchSha,
  commitAll,
  currentBranch,
  deleteBranch,
  removeWorktree,
} from "../git.js";
import type { AgentRunner } from "../runner.js";
import { telemetryPath, type RunRecord } from "../telemetry.js";
import type { EndpointPool } from "./pool.js";
import { answerContract, retryContract, validateAgainst } from "./json.js";
import { WORKFLOW_CHILD_ENV, type AgentOptions, type AgentRecord } from "./types.js";

/**
 * Tools an agent gets when it shares the repo with every other agent in the
 * run. Read-only is the only safe default there: two concurrent agents editing
 * one working tree corrupt each other's work in a way no report can untangle.
 * An agent that needs to write asks for `isolation: "worktree"` and gets a
 * checkout of its own — and the full set below.
 */
export const READ_ONLY_TOOLS = ["read", "grep", "find", "ls", "repo_search"];

export const MUTATING_TOOLS = [
  "read", "bash", "edit", "write", "grep", "find", "ls",
  "repo_search", "hash_edit", "batch_edit", "line_anchored_edit",
];

/**
 * Headroom between an agent's soft `--timeout` and the hard kill behind it.
 * Wide enough that the child's own graceful abort is what normally fires: the
 * SDK import alone costs ~14s before a session exists to abort.
 */
const HARD_KILL_MARGIN_MS = 60_000;

export interface AgentContext {
  runner: AgentRunner;
  /** Repo root; also the cwd for agents without worktree isolation. */
  root: string;
  runId: string;
  worktreeDir: string;
  defaultTimeoutSec?: number;
  defaultModel?: string;
  log: (msg: string) => void;
  /**
   * Where an agent's token usage is read back from. Defaults to the telemetry
   * log; injected by the suite, which must not read or write the user's own
   * `~/.underclass/runs.jsonl` to check that a budget is enforced.
   */
  usage?: (tag: string) => { tokensIn: number; tokensOut: number };
  /** Stall watchdog window for every child (see RunWorkflowOptions.stallSec). */
  defaultStallSec?: number;
  /** Endpoint pool; agents without an explicit `model:` are spread across it. */
  pool?: EndpointPool;
}

export interface AgentOutcome {
  value: unknown;
  record: AgentRecord;
}

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "agent"
  );
}

function labelFor(prompt: string, opts: AgentOptions): string {
  if (opts.label) return opts.label;
  const firstLine = prompt.split("\n").find((l) => l.trim()) ?? "agent";
  return firstLine.trim().slice(0, 60);
}

/**
 * Tokens the child reported for itself.
 *
 * Read back by tag rather than by "rows appended since we started": every
 * `under` process on the machine appends to one shared file, and the timestamp
 * approach has already produced a wrong headline number in this repo once
 * (see the RunRecord.tag comment). One tag per agent, summed across retries.
 */
function usageForTag(tag: string): { tokensIn: number; tokensOut: number } {
  let tokensIn = 0;
  let tokensOut = 0;
  for (const row of recentRuns()) {
    if (row.tag === tag) {
      tokensIn += row.tokensIn ?? 0;
      tokensOut += row.tokensOut ?? 0;
    }
  }
  return { tokensIn, tokensOut };
}

/**
 * Tail of the telemetry log, not the whole thing.
 *
 * This is read once per finished agent, and `readRuns()` parses up to 5,000 rows
 * every call — on a long run that is the file re-parsed once per agent, forever,
 * for the sake of the handful of rows this run just wrote. The rows we want are
 * always the newest, so read the end and stop.
 */
function recentRuns(): RunRecord[] {
  const path = telemetryPath();
  try {
    const size = statSync(path).size;
    const from = Math.max(0, size - TELEMETRY_TAIL_BYTES);
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(size - from);
      readSync(fd, buf, 0, buf.length, from);
      const text = buf.toString("utf8");
      // A non-zero offset almost certainly lands mid-row; that partial line is
      // older than anything this run wrote, so dropping it costs nothing.
      const lines = text.split("\n").slice(from > 0 ? 1 : 0);
      const rows: RunRecord[] = [];
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          rows.push(JSON.parse(line) as RunRecord);
        } catch {
          /* a torn final line is normal while children are still writing */
        }
      }
      return rows;
    } finally {
      closeSync(fd);
    }
  } catch {
    // No telemetry yet, or it is unreadable. Usage stays zero; a run must not
    // fail because its accounting is missing.
    return [];
  }
}

/** How much of the tail to read. Comfortably more than any single run writes. */
const TELEMETRY_TAIL_BYTES = 512 * 1024;

/**
 * Run one agent to completion and return what it produced.
 *
 * Worktree isolation, when asked for, is symmetric with fan-out's: branch from
 * the current head, run, commit whatever appeared. An agent that changed
 * nothing leaves no branch behind — the alternative is a run that litters the
 * repo with empty branches nobody will ever read.
 */
export async function runOneAgent(
  ctx: AgentContext,
  id: number,
  prompt: string,
  opts: AgentOptions = {},
): Promise<AgentOutcome> {
  const startedAt = Date.now();
  const label = labelFor(prompt, opts);
  const phase = opts.phase ?? "";
  const isolated = opts.isolation === "worktree";
  const tag = `${ctx.runId}#${id}`;
  const record: AgentRecord = { id, label, phase, status: "ok", ms: 0, tokensIn: 0, tokensOut: 0 };

  let cwd = ctx.root;
  let branch: string | undefined;
  let worktreePath: string | undefined;
  let baseSha: string | undefined;
  let settled = false;

  const tools = opts.tools ?? (isolated ? MUTATING_TOOLS : READ_ONLY_TOOLS);
  const timeoutSec = opts.timeoutSec ?? ctx.defaultTimeoutSec;
  const model = opts.model ?? ctx.defaultModel;
  const args = ["--tools", tools.join(",")];
  if (model) args.push("-m", model);
  if (timeoutSec) args.push("--timeout", String(timeoutSec));

  // Endpoint assignment. Held for the agent's whole life — retry included — so
  // a schema retry lands on the endpoint that saw the first attempt. An explicit
  // per-call `model:` is a statement about where this work must run; only
  // unpinned agents are the pool's to place. The entry's args go AFTER the
  // model default above and the CLI passthrough (argv order is passthrough,
  // then these), and under's arg parser is last-wins, so the pool's -m and
  // --base-url override both.
  const placed = !model && ctx.pool ? ctx.pool.pick() : undefined;
  if (placed) {
    args.push(...placed.entry.args);
    record.endpoint = placed.entry.label;
  }

  // Two timeouts, deliberately. `--timeout` aborts the child's session from
  // inside; the hard kill below is the backstop for a child that wedges before
  // a session exists at all, and it is set well above the soft one so the
  // graceful path is what normally fires.
  const hardKillMs = timeoutSec ? timeoutSec * 1000 + HARD_KILL_MARGIN_MS : undefined;
  // The stall watchdog needs no margin: silence is silence whichever phase the
  // child is in, and prefill on the slowest local model stays well under this.
  const stallMs = ctx.defaultStallSec ? ctx.defaultStallSec * 1000 : undefined;
  const childTimeouts = {
    ...(hardKillMs ? { timeoutMs: hardKillMs } : {}),
    ...(stallMs ? { stallMs } : {}),
  };

  const env: Record<string, string> = { ...WORKFLOW_CHILD_ENV, UNDER_RUN_TAG: tag };
  // The silent-no-op detector exists to catch a run that consumed a prompt,
  // called no tools and did nothing. That is exactly what a correct
  // reasoning-only agent looks like — a judge handed all its evidence in the
  // prompt has nothing to read. Keep the detector for agents that were sent to
  // change files, and for the rest judge success by the answer we got back,
  // which is stronger evidence than the heuristic anyway.
  if (!isolated) env.UNDER_ALLOW_NO_TOOLS = "1";

  // Set when the agent's work could not be committed. Consulted by `finish` so
  // that every `finish("ok")` site — present and future — is covered by one
  // check rather than each remembering to ask.
  let commitFailed = false;

  const finish = (status: AgentRecord["status"], error?: string): void => {
    // An agent whose work could not be committed did not succeed, whatever its
    // answer said. This used to report "ok": the caller ran `settleWorktree()`
    // and then `finish("ok")` unconditionally, so the script received the
    // agent's confident prose as a successful answer, the human report stayed
    // silent (only `failed` agents print their error), and the journal recorded
    // `ok` — which meant `--resume` replayed the success forever and never
    // retried. The single most expensive artefact a workflow produces, lost to
    // one dim stderr line.
    if (status === "ok" && commitFailed) {
      status = "failed";
      error ??= record.error;
    }
    record.status = status;
    if (error) record.error = error;
    record.ms = Date.now() - startedAt;
    const usage = (ctx.usage ?? usageForTag)(tag);
    record.tokensIn = usage.tokensIn;
    record.tokensOut = usage.tokensOut;
  };

  /** Commit whatever the agent did; drop the branch when it did nothing. */
  const settleWorktree = (): void => {
    if (!isolated || !worktreePath || !branch || settled) return;
    settled = true;
    let sha: string | null = null;
    try {
      sha = commitAll(worktreePath, `under workflow: ${label}`.slice(0, 72));
    } catch (err) {
      // The commit is the part that can fail on the agent's own output, and it
      // does not take an exotic repo: a `core.hooksPath` pre-commit that exits
      // 1 (husky, lint-staged, gitleaks), no committer identity, or
      // `commit.gpgsign` with no key in a headless run.
      //
      // This used to fall through to `removeWorktree(--force)` and, because
      // `sha` was null and the branch still equalled `baseSha`,
      // `deleteBranch(…, true)` — destroying the work and the branch both, then
      // reporting `ok`. The old comment argued the worktree "still has to come
      // off"; that trades a registered worktree the report can name for silent
      // data loss, which is the wrong way round. `git add -A` ran before the
      // failure so the content is in the object store and `git fsck
      // --lost-found` could recover a dangling tree until gc prunes it — but
      // nothing told the user that, and no path survived in the report.
      //
      // So: preserve both, name the path, and let `finish` mark it failed. This
      // mirrors fan-out's convention for a failed task.
      commitFailed = true;
      record.error ??= `could not commit the agent's work: ${err instanceof Error ? err.message : String(err)}`;
      record.worktree = worktreePath;
      ctx.log(`  ⚠ ${label}: ${record.error}`);
      ctx.log(`     work preserved at ${worktreePath} (branch ${branch})`);
      return;
    }
    removeWorktree(ctx.root, worktreePath);
    if (sha) record.committed = sha;
    else if (baseSha && branchSha(ctx.root, branch) !== baseSha) {
      // Compared against the sha this worktree forked from, not the repo's live
      // HEAD: HEAD can move under a long run, and then every idle agent would
      // look like it had committed and leave an empty branch behind.
      record.committed = branchSha(ctx.root, branch);
    } else {
      deleteBranch(ctx.root, branch, true);
      delete record.branch;
    }
  };

  try {
    if (isolated) {
      // Inside the try on purpose. A worktree that cannot be created — a stale
      // directory from a killed run, a branch that already exists — is this
      // agent's failure, not the whole script's. Creating it outside meant the
      // exception escaped past every `finish()` call and aborted the run with
      // no records at all, which is precisely the contract this layer sells.
      const wantBranch = `wf/${ctx.runId}/${id}-${slug(label)}`;
      // The run id belongs in the path as well as the branch: without it two
      // concurrent workflows in one repo, or one leftover directory, collide on
      // `<worktrees>/1-<slug>` and the second run dies at its first agent.
      const wantPath = join(ctx.worktreeDir, ctx.runId, `${id}-${slug(label)}`);
      const base = currentBranch(ctx.root);
      addWorktree(ctx.root, wantPath, wantBranch, base);
      baseSha = branchSha(ctx.root, wantBranch);
      // Recorded only once it exists, so teardown never runs against a worktree
      // that was never created.
      branch = wantBranch;
      worktreePath = wantPath;
      cwd = wantPath;
      record.branch = wantBranch;
    }

    const basePrompt = opts.schema ? `${prompt}\n\n${answerContract(opts.schema)}` : prompt;
    let result = await ctx.runner.run({ prompt: basePrompt, cwd, branch: label, args, env, ...childTimeouts });

    if (!opts.schema) {
      if (!result.text && !isolated) {
        settleWorktree();
        finish("failed", "the agent produced no answer");
        return { value: null, record };
      }
      settleWorktree();
      finish("ok");
      return { value: result.text, record };
    }

    let check = validateAgainst(opts.schema, result.text);
    if (!check.ok) {
      // One retry, naming the exact violations. Separate process, so the only
      // way to carry the correction is to restate it in the prompt.
      ctx.log(`  ↻ ${label}: answer did not match the schema (${check.errors[0]}) — retrying once`);
      const retryPrompt = [
        prompt,
        "",
        retryContract(opts.schema, check.errors),
        "",
        "Your previous answer was:",
        result.text.slice(0, 4000),
      ].join("\n");
      result = await ctx.runner.run({ prompt: retryPrompt, cwd, branch: label, args, env, ...childTimeouts });
      check = validateAgainst(opts.schema, result.text);
    }

    settleWorktree();
    if (!check.ok) {
      finish("failed", `answer never matched the schema: ${check.errors.join("; ")}`);
      return { value: null, record };
    }
    finish("ok");
    return { value: check.value, record };
  } catch (err) {
    settleWorktree();
    finish("failed", err instanceof Error ? err.message : String(err));
    return { value: null, record };
  } finally {
    // Idempotent by the pool's contract, so the error paths above are free to
    // have reached it first.
    placed?.release();
  }
}
