import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join, relative, isAbsolute } from "node:path";
import {
  repoRoot,
  currentBranch,
  isClean,
  branchExists,
  aheadCount,
  branchSha,
  commitExists,
  addWorktree,
  removeWorktree,
  deleteBranch,
  commitAll,
  hasChanges,
  hasRemote,
  remoteBranchExists,
  worktreeForBranch,
  push,
  checkout,
  mergeBranch,
} from "./git.js";
import type { AgentRunner } from "./runner.js";

export interface FanOutTask {
  /** New branch name for this task's isolated worktree. */
  branch: string;
  /** Prompt handed to the agent inside the worktree. */
  prompt: string;
  /** Optional commit message (defaults to a slug of the prompt). */
  message?: string;
}

export interface FanOutOptions {
  /** Any directory inside the target repo. */
  repoDir: string;
  tasks: FanOutTask[];
  /** Base branch every worktree forks from (default: repo's current branch). */
  base?: string;
  /** Merge target for the full loop (default: base). */
  target?: string;
  /** Full loop (branch→commit→merge). Set false to stop after per-branch commit. */
  merge?: boolean;
  /** Push each committed branch to origin and open a GitHub PR via `gh` instead of merging. */
  pr?: boolean;
  /** Max agents running at once (default: number of tasks). */
  concurrency?: number;
  /** Where worktrees are created (default: <root>/.underclass/worktrees). */
  worktreeDir?: string;
  keepWorktrees?: boolean;
  dryRun?: boolean;
  runner: AgentRunner;
  log?: (msg: string) => void;
}

export interface TaskRecord {
  branch: string;
  path: string;
  ran: boolean;
  changed: boolean;
  committed: string | null;
  error: string | null;
  mergeOutput?: string;
  prUrl?: string;
}

export interface FanOutReport {
  dryRun?: boolean;
  base: string;
  target: string;
  merged: TaskRecord[];
  prOpened: TaskRecord[];
  committedNotMerged: TaskRecord[];
  conflicted: TaskRecord[];
  empty: TaskRecord[];
  failed: TaskRecord[];
  worktreesKept: string[];
  tasks?: Array<{ branch: string; path: string; planned: boolean }>;
}

/** Bounded-concurrency map that preserves input order in the result array. */
async function pool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  // A non-integer limit must not shrink the pool to zero workers: that leaves
  // every result slot undefined and the caller dereferencing holes.
  const width = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  const workers = Array.from({ length: width }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) break;
      results[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Branch name → a directory name under the worktrees dir.
 *
 * The fallback is not decoration. This mapped everything outside
 * `[a-zA-Z0-9._-]` to `-` and then stripped leading/trailing dashes, so a
 * branch named in Cyrillic, Greek, Chinese, Japanese or an emoji — all of which
 * git accepts as ref names — slugged to `""`. And `join(worktreeDir, "")` **is
 * `worktreeDir`**, so that task's worktree became the worktrees directory
 * itself. Every sibling worktree then sat *inside* it, `git add -A` recorded
 * each one as a mode-160000 gitlink, and that got committed and merged onto the
 * user's target branch — surviving a clone, with `git status` clean and
 * `git submodule status` failing on it. Cleanup made it worse: removing that
 * worktree `--force` deleted the whole `.underclass/worktrees` subtree,
 * including preserved worktrees from *failed* tasks whose paths the report was
 * simultaneously printing as intact.
 *
 * The dupe guard upstream compares slugs against each other, so it catches two
 * names colliding — never one name collapsing to nothing.
 *
 * Not exotic to trigger: `fan_out`'s `branch` field is free text written by the
 * model, and a model working in a Japanese or Russian codebase names branches
 * in the repo's language.
 */
function slug(branch: string): string {
  const s = branch.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  // `.` and `..` are guarded too, though no git-legal branch name reaches them
  // (`check-ref-format` rejects a component that is `.` or ends in `.lock`, and
  // `..` outright) — the cost of covering it is one alternation.
  if (!s || /^\.+$/.test(s)) {
    return `task-${createHash("sha256").update(branch).digest("hex").slice(0, 12)}`;
  }
  return s;
}

/**
 * Refuse a worktree path that is not strictly *inside* the worktrees directory.
 *
 * Defence in depth behind `slug()`: with the fallback above there is no known
 * input that reaches this, which is exactly why it is worth asserting — the
 * damage from a path equal to (or above) `worktreeDir` is destructive and
 * silent, and it reached a merged commit last time.
 */
function assertInsideWorktreeDir(worktreeDir: string, path: string, branch: string): void {
  const rel = relative(worktreeDir, path);
  if (!rel || rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(
      `refusing to use '${path}' as a worktree for branch '${branch}': ` +
        `it is not strictly inside ${worktreeDir}`,
    );
  }
}

/** Last meaningful line of a captured command output (the diagnosis, usually). */
function lastLine(output: string): string {
  const lines = output.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines[lines.length - 1] ?? "";
}

/** Error text plus any stderr/stdout the failing git/gh command captured. */
function describeError(err: unknown): string {
  const base = (err instanceof Error ? err.message : String(err)).trim();
  const src = err as { stderr?: unknown; stdout?: unknown };
  const extra = [src?.stderr, src?.stdout]
    .map((v) => (typeof v === "string" ? v : Buffer.isBuffer(v) ? v.toString("utf8") : ""))
    .join("\n")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !base.includes(l))
    .slice(-3)
    .join("; ");
  return extra ? `${base}: ${extra}` : base;
}

function ensureGh(): void {
  try {
    execFileSync("gh", ["--version"], { stdio: "ignore" });
  } catch {
    throw new Error("--pr requires the GitHub CLI ('gh') on PATH.");
  }
}

/** Open a PR for `branch` against `base` via `gh`; returns the PR URL. */
function openPr(root: string, branch: string, base: string, title: string, body: string): string {
  try {
    // stdin ignored: gh must fail fast rather than block on an interactive prompt;
    // stderr piped so its diagnosis lands in the task record instead of the void.
    return execFileSync(
      "gh",
      ["pr", "create", "--head", branch, "--base", base, "--title", title, "--body", body],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  } catch (err) {
    // execFileSync's own message quotes the entire command (PR body included);
    // report gh's diagnosis instead.
    const raw = (err as { stderr?: unknown }).stderr;
    const detail = lastLine(typeof raw === "string" ? raw : Buffer.isBuffer(raw) ? raw.toString("utf8") : "");
    throw new Error(`gh pr create --head ${branch} --base ${base} failed${detail ? `: ${detail}` : ""}`);
  }
}

/**
 * Fan a set of tasks out across isolated git worktrees, run one agent in each
 * concurrently, then (full loop) sequentially merge every committed branch into
 * the target. Every merge is conflict-safe: a conflicting branch is left intact
 * for manual resolution and the target tree is never left half-merged.
 */
export async function fanOut(o: FanOutOptions): Promise<FanOutReport> {
  const log = o.log ?? (() => {});
  const root = repoRoot(o.repoDir);
  const baseBranch = o.base ?? currentBranch(root);
  const targetBranch = o.target ?? baseBranch;
  const doPr = o.pr === true;
  const doMerge = !doPr && o.merge !== false;
  const worktreeDir = o.worktreeDir ?? join(root, ".underclass", "worktrees");
  const concurrency = o.concurrency ?? o.tasks.length;

  // ---- Pre-flight safety checks (fail fast, mutate nothing) ----
  if (o.tasks.length === 0) throw new Error("No tasks provided.");
  // A dry run mutates nothing, so a dirty tree (e.g. a checked-in tasks.json) is fine.
  if (!o.dryRun && !isClean(root)) {
    throw new Error("Working tree has uncommitted changes. Commit or stash before fan-out.");
  }
  if (o.base && !commitExists(root, o.base)) {
    throw new Error(`Base '${o.base}' does not resolve to a commit.`);
  }
  if (currentBranch(root) === "HEAD" && !o.base) {
    throw new Error("Detached HEAD: pass --base/--target explicitly.");
  }
  const branches = o.tasks.map((t) => t.branch);
  const dupes = branches.filter((b, i) => branches.indexOf(b) !== i);
  if (dupes.length) throw new Error(`Duplicate task branches: ${[...new Set(dupes)].join(", ")}`);
  const slugs = branches.map(slug);
  const slugDupes = slugs.filter((s, i) => slugs.indexOf(s) !== i);
  if (slugDupes.length) {
    throw new Error(`Branch names collide after slugging (same worktree path): ${[...new Set(slugDupes)].join(", ")}`);
  }
  const existing = branches.filter((b) => branchExists(root, b));
  if (existing.length) throw new Error(`Branches already exist: ${existing.join(", ")}`);
  if (doMerge && targetBranch !== currentBranch(root)) {
    if (!branchExists(root, targetBranch)) throw new Error(`Merge target '${targetBranch}' does not exist.`);
    // Checking the target out is impossible while another worktree holds it, and
    // that only bites after every agent has run — check before mutating anything.
    const held = worktreeForBranch(root, targetBranch);
    if (held) {
      throw new Error(
        `Merge target '${targetBranch}' is checked out in another worktree (${held}). ` +
          `Merge there manually, or pass a different --target.`,
      );
    }
  }
  if (doPr) {
    if (!hasRemote(root)) throw new Error("--pr requires an 'origin' remote.");
    if (!branchExists(root, targetBranch) && !remoteBranchExists(root, targetBranch)) {
      throw new Error(`PR target '${targetBranch}' does not exist locally or as 'origin/${targetBranch}'.`);
    }
    ensureGh();
  }

  if (o.dryRun) {
    log(
      `[dry-run] would fan out ${o.tasks.length} task(s) from '${baseBranch}', ` +
        `${
          doPr
            ? "opening a PR per branch"
            : doMerge
              ? `merging into '${targetBranch}'`
              : "committing per-branch (no merge)"
        }.`,
    );
    return {
      dryRun: true,
      base: baseBranch,
      target: targetBranch,
      merged: [],
      prOpened: [],
      committedNotMerged: [],
      conflicted: [],
      empty: [],
      failed: [],
      worktreesKept: [],
      tasks: o.tasks.map((t) => ({ branch: t.branch, path: join(worktreeDir, slug(t.branch)), planned: true })),
    };
  }

  // ---- Phase 1: run every agent in its own worktree, concurrently, then commit ----
  log(`Fanning out ${o.tasks.length} task(s) from '${baseBranch}' (concurrency ${concurrency}).`);
  const runs = await pool(o.tasks, concurrency, async (task): Promise<TaskRecord> => {
    const path = join(worktreeDir, slug(task.branch));
    const rec: TaskRecord = { branch: task.branch, path, ran: false, changed: false, committed: null, error: null };
    try {
      assertInsideWorktreeDir(worktreeDir, path, task.branch);
      addWorktree(root, path, task.branch, baseBranch);
      await o.runner.run({ prompt: task.prompt, cwd: path, branch: task.branch });
      rec.ran = true;
      rec.changed = hasChanges(path);

      // Where did the agent actually leave HEAD? The old check asked
      // `aheadCount(root, base, task.branch)` — a question about the *ref* we
      // created, which says nothing about where the worktree's HEAD went. So an
      // agent that ran `git checkout -b agent/my-fix` and committed left
      // task.branch still at base: the count was 0, the tree was clean so
      // commitAll returned null, and the task was bucketed `empty` — printed as
      // `· no changes`, the least alarming line in the report — then its
      // worktree was force-removed and its branch `-D`'d.
      //
      // On its own branch the commits stay reachable, so that is a misreport and
      // a silent non-delivery. From a detached HEAD it is worse: no ref survives,
      // `worktree remove --force` takes the worktree reflog with it, and the
      // commit is recoverable only via `git fsck --lost-found` until gc prunes
      // it. Practically lost.
      //
      // `git checkout -b` before touching anything is one of the most reliable
      // habits a model has, and nothing in the child's prompt tells it that it is
      // already on a branch of its own.
      const head = currentBranch(path);
      if (head !== task.branch) {
        // Deliberately no commit, no merge, no cleanup: this is bucketed failed,
        // which preserves worktree and branch. Reporting where the work went is
        // the whole point — the user can recover it by name.
        const where = head === "HEAD" ? `a detached HEAD at ${branchSha(path, "HEAD").slice(0, 8)}` : `'${head}'`;
        rec.error =
          `agent left its work on ${where} instead of '${task.branch}'; ` +
          `worktree preserved at ${path}`;
        log(`  ✗ ${task.branch}: ${rec.error}`);
        return rec;
      }

      // The agent may have committed its own work: a clean tree does NOT mean an
      // empty task. Judged from the worktree's HEAD rather than the ref, so this
      // cannot disagree with the check above.
      rec.committed =
        commitAll(path, task.message ?? `under: ${task.prompt.slice(0, 60)}`) ??
        (aheadCount(path, baseBranch, "HEAD") > 0 ? branchSha(root, task.branch) : null);
      log(`  ✓ ${task.branch}: ${rec.committed ? `committed ${rec.committed.slice(0, 8)}` : "no changes"}`);
    } catch (err) {
      rec.error = describeError(err);
      log(`  ✗ ${task.branch}: ${rec.error}`);
    }
    return rec;
  });

  const report: FanOutReport = {
    base: baseBranch,
    target: targetBranch,
    merged: [],
    prOpened: [],
    committedNotMerged: [],
    conflicted: [],
    empty: [],
    failed: [],
    worktreesKept: [],
  };

  // ---- Phase 2: full loop — sequentially merge each committed branch into target ----
  let restoreBranch: string | null = null;
  let mergeBlocked: string | null = null;
  if (doMerge) {
    const startBranch = currentBranch(root);
    if (targetBranch !== startBranch) {
      // Phase 1 is already on disk; a checkout failure here must degrade to
      // "committed but unmerged", never discard the report.
      try {
        checkout(root, targetBranch);
        restoreBranch = startBranch;
      } catch (err) {
        mergeBlocked = `cannot check out '${targetBranch}': ${describeError(err)}`;
        log(`  ✗ ${mergeBlocked} — committed branches left for manual merge.`);
      }
    }
  }

  for (let i = 0; i < runs.length; i++) {
    const rec = runs[i]!;
    const task = o.tasks[i]!;
    if (rec.error) {
      report.failed.push(rec);
      continue;
    }
    if (!rec.committed) {
      report.empty.push(rec);
      if (!o.keepWorktrees) {
        removeWorktree(root, rec.path);
        deleteBranch(root, rec.branch, true);
      }
      continue;
    }
    if (doPr) {
      try {
        push(root, rec.branch);
        rec.prUrl = openPr(
          root,
          rec.branch,
          targetBranch,
          task.message ?? `under: ${task.prompt.slice(0, 60)}`,
          `Automated change by \`under fan-out\`.\n\nTask prompt:\n\n> ${task.prompt}`,
        );
        report.prOpened.push(rec);
        if (!o.keepWorktrees) removeWorktree(root, rec.path);
        log(`  ⇒ opened PR for ${rec.branch}: ${rec.prUrl}`);
      } catch (err) {
        rec.error = describeError(err);
        report.failed.push(rec);
        log(`  ✗ ${rec.branch}: push/PR failed: ${rec.error} — branch and worktree preserved.`);
      }
      continue;
    }
    if (!doMerge) {
      report.committedNotMerged.push(rec);
      if (!o.keepWorktrees) removeWorktree(root, rec.path);
      continue;
    }
    // Worktree must be removed before its branch can be deleted post-merge —
    // but only when we intend to delete; --keep-worktrees keeps both.
    if (!o.keepWorktrees) removeWorktree(root, rec.path);
    const res = mergeBlocked
      ? { ok: false, conflict: false, output: mergeBlocked }
      : mergeBranch(rec.branch, root);
    if (res.ok) {
      report.merged.push(rec);
      if (!o.keepWorktrees) deleteBranch(root, rec.branch, false);
      log(`  ⇒ merged ${rec.branch} into ${targetBranch}`);
    } else {
      rec.mergeOutput = res.output;
      report.conflicted.push(rec);
      const why = res.conflict
        ? `conflicts with ${targetBranch}`
        : `failed to merge into ${targetBranch}: ${lastLine(res.output)}`;
      log(`  ⚠ ${rec.branch} ${why}; branch preserved for manual resolution.`);
    }
  }

  if (restoreBranch) {
    try {
      checkout(root, restoreBranch);
    } catch (err) {
      log(`  ⚠ left on '${targetBranch}': ${describeError(err)}`);
    }
  }
  report.worktreesKept = o.keepWorktrees ? runs.filter((r) => r.committed).map((r) => r.path) : [];
  return report;
}

/** Parse a repeatable `--task "branch:prompt"` value into a {@link FanOutTask}. */
export function parseTaskSpec(spec: string): FanOutTask {
  const idx = spec.indexOf(":");
  if (idx === -1) throw new Error(`Invalid --task "${spec}" (expected "branch:prompt")`);
  const branch = spec.slice(0, idx).trim();
  const prompt = spec.slice(idx + 1).trim();
  if (!branch || !prompt) throw new Error(`Invalid --task "${spec}" (empty branch or prompt)`);
  return { branch, prompt };
}
