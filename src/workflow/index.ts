import { existsSync, readFileSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { gitOk, repoRoot } from "../git.js";
import type { AgentContext } from "./agent.js";
import { Journal } from "./journal.js";
import { EndpointPool } from "./pool.js";
import { WorkflowRuntime } from "./runtime.js";
import { executeScript, extractMeta } from "./script.js";
import type { RunWorkflowOptions, WorkflowReport } from "./types.js";

export { extractMeta, toFunctionBody } from "./script.js";
export { listWorkflows, resolveWorkflow, type WorkflowListing } from "./resolve.js";
export { EndpointPool, parsePoolSpec, type PoolEntry } from "./pool.js";
export { answerContract, coerceToSchema, jsonCandidates, validateAgainst } from "./json.js";
export { MUTATING_TOOLS, READ_ONLY_TOOLS } from "./agent.js";
export * from "./types.js";

/** Unique enough for a branch name and a filename, and sorts by time. */
function newRunId(): string {
  return `wf${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36).padStart(2, "0")}`;
}

/**
 * Run a workflow script against a repo.
 *
 * The runner is injected for the same reason fan-out injects one: the whole
 * orchestration layer — concurrency, schema retries, worktree isolation, resume
 * — is testable against a stub child, with no model and no endpoint.
 */
export async function runWorkflow(o: RunWorkflowOptions): Promise<WorkflowReport> {
  const log = o.log ?? (() => {});
  const startedAt = Date.now();
  const source = o.source ?? readFileSync(o.scriptPath!, "utf8");
  const meta = extractMeta(source);
  const runId = newRunId();

  if (o.dryRun) {
    return {
      runId,
      meta,
      value: null,
      agents: [],
      ms: 0,
      tokensIn: 0,
      tokensOut: 0,
      dryRun: true,
      branches: [],
    };
  }

  const root = repoRoot(o.repoDir);
  // A killed run leaves worktree directories git still has registered. They are
  // namespaced by run id so they cannot collide with this run, but pruning the
  // dead ones keeps `git worktree list` and `.underclass/worktrees` honest.
  gitOk(["worktree", "prune"], root);
  const stateDir = o.stateDir ?? join(root, ".underclass", "workflows");
  // The run-level model lives in the runner's passthrough args, not in any
  // per-call option, so it has to be folded into the resume key explicitly:
  // otherwise resuming with a different `-m` replays the old model's answers.
  // A resume id that matches nothing must refuse, not shrug. Resume exists to
  // avoid re-paying for a run; a one-character typo silently re-running the
  // whole thing at full cost — exit 0, no warning — defeats it while looking
  // like it worked.
  if (o.resumeFromRunId && !existsSync(join(stateDir, `${o.resumeFromRunId}.jsonl`))) {
    throw new Error(
      `cannot resume '${o.resumeFromRunId}': no journal at ${join(stateDir, `${o.resumeFromRunId}.jsonl`)}`,
    );
  }
  const journal = new Journal(stateDir, runId, o.modelSalt ?? "", o.resumeFromRunId);

  const ctx: AgentContext = {
    runner: o.runner,
    root,
    runId,
    worktreeDir: join(root, ".underclass", "worktrees"),
    log,
    ...(o.timeoutSec ? { defaultTimeoutSec: o.timeoutSec } : {}),
    ...(o.stallSec ? { defaultStallSec: o.stallSec } : {}),
    ...(o.usage ? { usage: o.usage } : {}),
    ...(o.pool?.length ? { pool: new EndpointPool(o.pool) } : {}),
  };

  const runtime = new WorkflowRuntime({
    ctx,
    concurrency: o.concurrency === "auto" ? "auto" : Math.max(1, Math.floor(o.concurrency ?? 4) || 1),
    ...(o.budgetTokens ? { budgetTokens: o.budgetTokens } : {}),
    replay: (prompt, opts) => journal.replay(prompt, opts),
    onRecord: (record, value, prompt, opts) => journal.append(record.id, prompt, opts, value, record),
  });

  log(`${meta.name}: ${meta.description}`);
  let value: unknown = null;
  let error: string | undefined;
  try {
    value = await executeScript(source, runtime.hooks(o.args, log));
  } catch (err) {
    // A script that throws still leaves finished agents worth reporting —
    // discarding them would throw away the expensive part of the run.
    error = err instanceof Error ? err.message : String(err);
  }
  // The script is done, its agents may not be: one launched without an await
  // would otherwise outlive this call and strand a worktree behind the report.
  await runtime.drain();
  // A ceiling that fired inside parallel()/pipeline() was swallowed there.
  // Surfacing it is the difference between "here is your result" and "this run
  // was cut short and what you are holding is partial".
  error ??= runtime.fatal ?? undefined;

  // `git worktree remove` reclaims the leaf it created but not the per-run
  // parent we made to namespace them, and prune never touches a directory git
  // does not own — so without this every run leaves one empty directory behind.
  // `rmdir`, NOT a recursive delete. The intent is only ever to reclaim a
  // parent git left empty, and `recursive: true` quietly went further than the
  // comment above claims: it deleted whatever was still inside, which is
  // precisely the worktree an agent preserves when its work could not be
  // committed. ENOTEMPTY is the correct outcome there, and the catch already
  // treats "still occupied" as unremarkable.
  try {
    rmdirSync(join(ctx.worktreeDir, runId));
  } catch {
    /* still occupied, or never created: neither is worth failing a run over */
  }

  const agents = runtime.records;
  return {
    runId,
    meta,
    value,
    agents,
    ms: Date.now() - startedAt,
    tokensIn: agents.reduce((n, r) => n + r.tokensIn, 0),
    tokensOut: agents.reduce((n, r) => n + r.tokensOut, 0),
    branches: agents.filter((r) => r.branch).map((r) => r.branch!),
    ...(error ? { error } : {}),
  };
}
