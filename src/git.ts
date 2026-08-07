import { execFileSync } from "node:child_process";

/** Error carrying git's captured stdout/stderr for diagnostics. */
export class GitError extends Error {
  stdout: string;
  stderr: string;
  constructor(message: string, opts: { stdout?: string; stderr?: string } = {}) {
    super(message);
    this.name = "GitError";
    this.stdout = opts.stdout ?? "";
    this.stderr = opts.stderr ?? "";
  }
}

/** Run git, throwing {@link GitError} with captured output on failure. */
export function git(args: string[], cwd: string): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 32 * 1024 * 1024,
    }).trim();
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    throw new GitError(`git ${args.join(" ")} failed`, { stdout: e.stdout, stderr: e.stderr });
  }
}

/** Run git, returning true on success and false on any failure (never throws). */
export function gitOk(args: string[], cwd: string): boolean {
  try {
    git(args, cwd);
    return true;
  } catch {
    return false;
  }
}

export function repoRoot(cwd: string): string {
  return git(["rev-parse", "--show-toplevel"], cwd);
}

export function currentBranch(cwd: string): string {
  return git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
}

/**
 * True when there are no uncommitted changes (staged, unstaged, or untracked).
 * Excludes .underclass/ — preserved fan-out worktrees live there and must not
 * block subsequent runs (nor bait the user into `git clean`-ing them away).
 */
export function isClean(cwd: string): boolean {
  return git(["status", "--porcelain", "--", ".", ":(exclude).underclass"], cwd) === "";
}

/** Number of commits on `branch` that are not on `base`. */
export function aheadCount(root: string, base: string, branch: string): number {
  return Number(git(["rev-list", "--count", `${base}..${branch}`], root)) || 0;
}

export function branchSha(root: string, branch: string): string {
  return git(["rev-parse", branch], root);
}

/** True when `ref` resolves to a commit (branch, tag, or sha). */
export function commitExists(root: string, ref: string): boolean {
  return gitOk(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], root);
}

export function hasChanges(cwd: string): boolean {
  return git(["status", "--porcelain"], cwd) !== "";
}

export function branchExists(root: string, branch: string): boolean {
  return gitOk(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], root);
}

/** True when `remote/branch` exists as a remote-tracking ref (no network). */
export function remoteBranchExists(root: string, branch: string, remote = "origin"): boolean {
  return gitOk(["show-ref", "--verify", "--quiet", `refs/remotes/${remote}/${branch}`], root);
}

/**
 * Path of the worktree that has `branch` checked out, or null. Includes the
 * main worktree, so callers wanting only *other* worktrees must first establish
 * that `branch` is not the root's current branch.
 */
export function worktreeForBranch(root: string, branch: string): string | null {
  let out: string;
  try {
    out = git(["worktree", "list", "--porcelain"], root);
  } catch {
    return null;
  }
  let path: string | null = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length).trim();
    else if (line.trim() === `branch refs/heads/${branch}`) return path;
  }
  return null;
}

/** Create a worktree at `path` on a fresh branch `branch` based on `base`. */
export function addWorktree(root: string, path: string, branch: string, base: string): void {
  git(["worktree", "add", "-b", branch, path, base], root);
}

/** Remove a worktree dir (force discards anything uncommitted inside it) and prune. */
export function removeWorktree(root: string, path: string): void {
  gitOk(["worktree", "remove", "--force", path], root);
  gitOk(["worktree", "prune"], root);
}

export function deleteBranch(root: string, branch: string, force = false): boolean {
  return gitOk(["branch", force ? "-D" : "-d", branch], root);
}

export function checkout(root: string, branch: string): void {
  git(["checkout", branch], root);
}

export function hasRemote(root: string, name = "origin"): boolean {
  return gitOk(["remote", "get-url", name], root);
}

export function push(root: string, branch: string, remote = "origin"): void {
  git(["push", "-u", remote, branch], root);
}

/** Stage everything and commit. Returns the new commit sha, or null if nothing to commit. */
export function commitAll(cwd: string, message: string): string | null {
  if (!hasChanges(cwd)) return null;
  git(["add", "-A"], cwd);
  git(["commit", "-m", message], cwd);
  return git(["rev-parse", "HEAD"], cwd);
}

export interface MergeResult {
  ok: boolean;
  conflict: boolean;
  output: string;
}

/**
 * Merge `branch` into whatever is checked out at `targetCwd`.
 * Conflict-safe: on any failure the merge is aborted, so the target tree is
 * left exactly as it was. Returns a structured result instead of throwing.
 */
export function mergeBranch(branch: string, targetCwd: string): MergeResult {
  try {
    const output = git(["merge", "--no-ff", "-m", `Merge branch '${branch}'`, branch], targetCwd);
    return { ok: true, conflict: false, output };
  } catch (err) {
    const e = err as GitError;
    const combined = `${e.stdout ?? ""}\n${e.stderr ?? ""}`.trim();
    const conflict = /conflict/i.test(combined);
    gitOk(["merge", "--abort"], targetCwd);
    return { ok: false, conflict, output: combined };
  }
}
