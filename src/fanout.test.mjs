// Fan-out regression suite: real temp git repos, a stub runner, no model.
//   node packages/under/src/fanout.test.mjs
// Runs against packages/under/dist (build first); UNDER_DIST overrides that.
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const distUrl = process.env.UNDER_DIST
  ? pathToFileURL(join(process.env.UNDER_DIST, "/"))
  : new URL("../dist/", import.meta.url);
let fanOut, SpawnUnderRunner, createFanOutRunner;
try {
  ({ fanOut } = await import(new URL("fanout.js", distUrl).href));
  ({ SpawnUnderRunner, createFanOutRunner } = await import(new URL("runner.js", distUrl).href));
} catch (err) {
  console.error(`cannot load fan-out from ${distUrl}: ${err.message}\nBuild first (npm run build).`);
  process.exit(2);
}

const temps = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Poll until `cond` holds; false on deadline. For load-independent setup waits. */
async function until(cond, deadlineMs) {
  const end = Date.now() + deadlineMs;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(50);
  }
  return cond();
}
const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function tmp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function makeRepo() {
  const dir = tmp("under-fanout-");
  git(["init", "-b", "main"], dir);
  git(["config", "user.email", "test@example.com"], dir);
  git(["config", "user.name", "test"], dir);
  writeFileSync(join(dir, "README.md"), "base\n");
  git(["add", "-A"], dir);
  git(["commit", "-m", "init"], dir);
  return dir;
}

/** Agent stand-in: writes one file per task into its worktree. */
const stubRunner = {
  async run(task) {
    writeFileSync(join(task.cwd, `${task.branch.replace(/\W+/g, "_")}.txt`), "work\n");
  },
};

/** Fake `gh` on PATH so PR paths are exercised without the real CLI. */
function withGh(behavior, fn) {
  const dir = tmp("under-gh-");
  writeFileSync(
    join(dir, "gh"),
    behavior === "ok"
      ? '#!/bin/sh\n[ "$1" = "--version" ] && { echo "gh 2.0.0"; exit 0; }\necho "https://example.test/pr/1"\n'
      : '#!/bin/sh\n[ "$1" = "--version" ] && { echo "gh 2.0.0"; exit 0; }\necho "gh: Not Found (HTTP 404) no such base branch" >&2\nexit 1\n',
  );
  chmodSync(join(dir, "gh"), 0o755);
  const prev = process.env.PATH;
  process.env.PATH = `${dir}:${prev}`;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      process.env.PATH = prev;
    });
}

function withOrigin(dir) {
  const bare = tmp("under-origin-");
  git(["init", "--bare", bare], dir);
  git(["remote", "add", "origin", bare], dir);
  git(["push", "-u", "origin", "main"], dir);
  return bare;
}

/**
 * Stands in for the `under` binary on both sides of a fan-out. Run as
 * `<entry> fan-out …` it hands off to the real CLI, so children are spawned by
 * runFanOut itself with this file as their entry; run as a child agent it
 * records the depth env it was handed and does a scrap of work to commit.
 */
function depthProbeEntry(log) {
  const file = join(tmp("under-depth-entry-"), "under.mjs");
  writeFileSync(
    file,
    `import { appendFileSync, writeFileSync } from "node:fs";\n` +
      `if (process.argv[2] === "fan-out") {\n` +
      `  await import(${JSON.stringify(new URL("index.js", distUrl).href)});\n` +
      `} else {\n` +
      `  appendFileSync(${JSON.stringify(log)}, (process.env.UNDER_FANOUT_DEPTH ?? "<unset>") + "\\n");\n` +
      `  writeFileSync("child.txt", "work\\n");\n` +
      `}\n`,
  );
  return file;
}

/** Run a CLI entry to completion, collecting both streams. */
function runCli(entry, args, cwd) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [entry, ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (c) => (out += c));
    p.stderr.on("data", (c) => (out += c));
    p.on("error", reject);
    p.on("exit", (code) => resolve({ code, out }));
  });
}

/** Fake agent entry that leaves a bash grandchild writing into the worktree. */
function grandchildAgent(marker) {
  const dir = tmp("under-agent-");
  const file = join(dir, "agent.mjs");
  writeFileSync(
    file,
    `import { spawn } from "node:child_process";\n` +
      `spawn("bash", ["-c", "for i in $(seq 1 60); do echo ${marker} >> ${marker}; sleep 0.1; done"], { stdio: "ignore" });\n` +
      `setInterval(() => {}, 1000);\n`,
  );
  return file;
}

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push([true, name]);
    console.log(`  ok   ${name}`);
  } catch (err) {
    results.push([false, name]);
    console.log(`  FAIL ${name}\n       ${err && err.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// ---- UNDER-16: --pr target is validated before any agent runs ----
await test("UNDER-16 --pr rejects a bad --target up front", async () => {
  const repo = makeRepo();
  withOrigin(repo);
  let ran = 0;
  const err = await withGh("ok", () =>
    fanOut({
      repoDir: repo,
      tasks: [{ branch: "feat/a", prompt: "a" }],
      target: "mian",
      pr: true,
      runner: { run: async (t) => (ran++, stubRunner.run(t)) },
    }).then(
      () => null,
      (e) => e,
    ),
  );
  assert(err, "expected a preflight rejection");
  assert(/PR target 'mian'/.test(err.message), `unexpected message: ${err && err.message}`);
  assert(ran === 0, "agents ran before the target was validated");
});

// ---- UNDER-17: merge target held by another worktree is caught in preflight ----
await test("UNDER-17 merge target checked out elsewhere is caught up front", async () => {
  const repo = makeRepo();
  git(["branch", "release"], repo);
  const other = join(tmp("under-otherwt-"), "wt");
  git(["worktree", "add", other, "release"], repo);
  let ran = 0;
  const err = await fanOut({
    repoDir: repo,
    tasks: [{ branch: "feat/a", prompt: "a" }],
    target: "release",
    runner: { run: async (t) => (ran++, stubRunner.run(t)) },
  }).then(
    () => null,
    (e) => e,
  );
  assert(err, "expected a preflight rejection");
  assert(/another worktree/.test(err.message), `unexpected message: ${err && err.message}`);
  assert(ran === 0, "agents ran before the target was validated");
});

// ---- UNDER-17: a checkout that only becomes impossible mid-run keeps the report ----
await test("UNDER-17 mid-run checkout failure still returns a report", async () => {
  const repo = makeRepo();
  git(["branch", "release"], repo);
  const other = join(tmp("under-otherwt-"), "wt");
  const report = await fanOut({
    repoDir: repo,
    tasks: [{ branch: "feat/a", prompt: "a" }],
    target: "release",
    runner: {
      async run(t) {
        await stubRunner.run(t);
        git(["worktree", "add", other, "release"], repo); // races in after preflight
      },
    },
  });
  assert(report.conflicted.length === 1, `expected 1 unmerged branch, got ${report.conflicted.length}`);
  assert(/cannot check out 'release'/.test(report.conflicted[0].mergeOutput ?? ""), "reason not recorded");
  assert(report.conflicted[0].committed, "work should still be committed on its branch");
});

// ---- UNDER-15: push/PR failure causes reach the record and the log ----
await test("UNDER-15 PR failure surfaces gh's reason", async () => {
  const repo = makeRepo();
  withOrigin(repo);
  const log = [];
  const report = await withGh("fail", () =>
    fanOut({ repoDir: repo, tasks: [{ branch: "feat/a", prompt: "a" }], pr: true, runner: stubRunner, log: (m) => log.push(m) }),
  );
  assert(report.failed.length === 1, "expected the task to fail");
  assert(/no such base branch/.test(report.failed[0].error ?? ""), `cause missing: ${report.failed[0].error}`);
  assert(log.some((l) => /no such base branch/.test(l)), "cause missing from the log");
});

await test("UNDER-15 push failure surfaces git's reason", async () => {
  const repo = makeRepo();
  git(["remote", "add", "origin", join(tmp("under-gone-"), "missing.git")], repo);
  const log = [];
  const report = await withGh("ok", () =>
    fanOut({
      repoDir: repo,
      tasks: [{ branch: "feat/a", prompt: "a" }],
      pr: true,
      target: "main",
      runner: stubRunner,
      log: (m) => log.push(m),
    }),
  );
  assert(report.failed.length === 1, "expected the task to fail");
  assert(/repository/i.test(report.failed[0].error ?? ""), `cause missing: ${report.failed[0].error}`);
});

// ---- UNDER-14: the timeout kills the agent's whole process tree ----
await test("UNDER-14 task timeout kills bash grandchildren", async () => {
  const dir = tmp("under-timeout-");
  const marker = join(dir, "grandchild.log");
  // 4s, not 700ms: the deadline must outlive node's boot plus bash's first
  // write on a machine that is busy running other suites — a load-30 host
  // took over a second just to start the grandchild, and a kill that lands
  // before the grandchild exists proves nothing about killing it.
  const runner = new SpawnUnderRunner({ entry: grandchildAgent(marker), timeoutMs: 4000 });
  const err = await runner.run({ prompt: "x", cwd: dir, branch: "b" }).then(
    () => null,
    (e) => e,
  );
  assert(err && /timed out/.test(err.message), `expected a timeout, got ${err && err.message}`);
  const atKill = existsSync(marker) ? statSync(marker).size : 0;
  assert(atKill > 0, "grandchild never started — test is not exercising the kill");
  await sleep(1200);
  const later = existsSync(marker) ? statSync(marker).size : 0;
  assert(later === atKill, `grandchild survived the timeout (${atKill} -> ${later} bytes)`);
});

// ---- UNDER-14 regression: parent signals still reach detached children ----
await test("UNDER-14 SIGINT on the parent tears the agent tree down", async () => {
  const dir = tmp("under-sigint-");
  const marker = join(dir, "grandchild.log");
  const driver = join(dir, "driver.mjs");
  writeFileSync(
    driver,
    `const { SpawnUnderRunner } = await import(${JSON.stringify(new URL("runner.js", distUrl).href)});\n` +
      `const r = new SpawnUnderRunner({ entry: ${JSON.stringify(grandchildAgent(marker))} });\n` +
      `r.run({ prompt: "x", cwd: ${JSON.stringify(dir)}, branch: "b" }).catch(() => {});\n`,
  );
  const parent = spawn(process.execPath, [driver], { stdio: "ignore" });
  // Wait for the observable precondition instead of assuming a boot speed:
  // a fixed sleep here flaked whenever the host was busy enough that the
  // grandchild had not written its first byte yet.
  const started = await until(() => existsSync(marker) && statSync(marker).size > 0, 8000);
  assert(started, "grandchild never started — test is not exercising the teardown");
  parent.kill("SIGINT");
  const exited = await Promise.race([
    new Promise((r) => parent.on("exit", () => r(true))),
    sleep(3000).then(() => false),
  ]);
  assert(exited, "parent ignored SIGINT");
  await sleep(300);
  const settled = existsSync(marker) ? statSync(marker).size : 0;
  await sleep(900);
  const later = existsSync(marker) ? statSync(marker).size : 0;
  assert(later === settled, `grandchild outlived the parent (${settled} -> ${later} bytes)`);
});

// ---- depth gate: children must never be handed a fan_out tool of their own ----
// The tool path set UNDER_FANOUT_DEPTH and the CLI path did not, so children of
// `under fan-out` came up believing they were top level and could recurse.
await test("createFanOutRunner marks children below top level", async () => {
  const dir = tmp("under-depthenv-");
  const probe = join(dir, "probe.mjs");
  writeFileSync(probe, 'console.log("depth=" + (process.env.UNDER_FANOUT_DEPTH ?? "<unset>"));\n');
  const chunks = [];
  await createFanOutRunner({ entry: probe, onOutput: (_b, c) => chunks.push(c) }).run({
    prompt: "x",
    cwd: dir,
    branch: "b",
  });
  assert(/depth=1/.test(chunks.join("")), `child not marked below top level: ${chunks.join("").trim()}`);
});

await test("under fan-out spawns children below top level", async () => {
  const repo = makeRepo();
  const log = join(tmp("under-depthlog-"), "child-env.log");
  const { code, out } = await runCli(
    depthProbeEntry(log),
    ["fan-out", "--task", "feat/depth:write the file"],
    repo,
  );
  assert(code === 0, `fan-out exited ${code}: ${out}`);
  assert(existsSync(log), `no child ran, so the depth env was never observed: ${out}`);
  const seen = readFileSync(log, "utf8").trim().split("\n");
  assert(seen.length === 1, `expected one child, got ${seen.length}`);
  assert(seen[0] === "1", `child was handed UNDER_FANOUT_DEPTH=${seen[0]} — it can recurse`);
});

// ---- happy paths must keep working ----
await test("runner forwards agent output and settles on exit", async () => {
  const dir = tmp("under-runner-");
  const ok = join(dir, "ok.mjs");
  // The prompt is the last argv entry — the runner precedes it with `--` so
  // flag-looking prompts stay prompts, which is also why argv[2] is wrong here.
  writeFileSync(ok, 'console.log("hello " + process.argv[process.argv.length - 1]);\n');
  const bad = join(dir, "bad.mjs");
  writeFileSync(bad, 'console.error("boom");\nprocess.exit(3);\n');
  const chunks = [];
  await new SpawnUnderRunner({ entry: ok, onOutput: (_b, c) => chunks.push(c) }).run({
    prompt: "task",
    cwd: dir,
    branch: "b",
  });
  assert(chunks.join("").includes("hello task"), "stdout not forwarded");
  const err = await new SpawnUnderRunner({ entry: bad }).run({ prompt: "x", cwd: dir, branch: "b" }).then(
    () => null,
    (e) => e,
  );
  assert(err && /code 3/.test(err.message), `expected the exit code, got ${err && err.message}`);
  assert(/boom/.test(err.message), "stderr tail missing from the failure");
});


await test("merge loop merges, cleans worktrees and branches", async () => {
  const repo = makeRepo();
  const report = await fanOut({
    repoDir: repo,
    tasks: [
      { branch: "feat/a", prompt: "a" },
      { branch: "feat/b", prompt: "b" },
    ],
    runner: stubRunner,
    concurrency: 2,
  });
  assert(report.merged.length === 2, `expected 2 merges, got ${report.merged.length}`);
  assert(existsSync(join(repo, "feat_a.txt")) && existsSync(join(repo, "feat_b.txt")), "merged files missing");
  assert(git(["branch", "--list", "feat/a"], repo) === "", "branch not deleted");
  assert(!existsSync(join(repo, ".underclass", "worktrees", "feat-a")), "worktree not removed");
  assert(git(["rev-parse", "--abbrev-ref", "HEAD"], repo) === "main", "left on the wrong branch");
});

await test("PR mode pushes and opens one PR per branch", async () => {
  const repo = makeRepo();
  const bare = withOrigin(repo);
  const report = await withGh("ok", () =>
    fanOut({ repoDir: repo, tasks: [{ branch: "feat/a", prompt: "a" }], pr: true, runner: stubRunner }),
  );
  assert(report.prOpened.length === 1, `expected 1 PR, got ${report.prOpened.length}`);
  assert(report.prOpened[0].prUrl === "https://example.test/pr/1", "PR url not captured");
  assert(git(["branch", "--list", "feat/a"], bare) !== "", "branch was not pushed to origin");
});

await test("empty task is cleaned up, not merged", async () => {
  const repo = makeRepo();
  const report = await fanOut({
    repoDir: repo,
    tasks: [{ branch: "feat/none", prompt: "n" }],
    runner: { async run() {} },
  });
  assert(report.empty.length === 1, "expected the task in the empty bucket");
  assert(git(["branch", "--list", "feat/none"], repo) === "", "empty branch not deleted");
});

await test("non-integer concurrency still runs every task", async () => {
  const repo = makeRepo();
  const report = await fanOut({
    repoDir: repo,
    tasks: [
      { branch: "feat/a", prompt: "a" },
      { branch: "feat/b", prompt: "b" },
    ],
    concurrency: Number.NaN,
    runner: stubRunner,
  });
  assert(report.merged.length === 2, `expected 2 merges, got ${report.merged.length}`);
});

/**
 * A static guard to go with the behavioural one above.
 *
 * "under fan-out spawns children below top level" proves the CLI path is
 * correct today by running it; this proves it stays correct by construction.
 * The bug it closes was a missing argument at one call site, which no
 * behavioural test of the OTHER call site could ever have caught — the
 * in-session `fan_out` tool set the env inline and passed its tests throughout.
 */
await test("createFanOutRunner is the only way fan-out builds a runner", async () => {
  const srcDir = join(import.meta.dirname);
  const offenders = [];
  for (const f of ["index.ts", "tools/fan-out-tool.ts", "workflow/agent.ts", "workflow/index.ts"]) {
    const text = readFileSync(join(srcDir, f), "utf8");
    if (/new\s+SpawnUnderRunner\s*\(/.test(text)) offenders.push(f);
  }
  assert(
    offenders.length === 0,
    `${offenders.join(", ")} constructs SpawnUnderRunner directly; use createFanOutRunner so the ` +
      `recursion guard cannot be omitted`,
  );
});

// ---- G1: a branch with no ASCII word characters must not collapse the worktree ----
// slug() mapped everything outside [a-zA-Z0-9._-] to "-" then stripped edge
// dashes, so a Cyrillic/CJK/emoji branch — all legal git refs — slugged to ""
// and join(worktreeDir, "") IS worktreeDir. The empty-slug task's worktree then
// CONTAINED its siblings: git add -A recorded each as a mode-160000 gitlink and
// merged it onto the user's branch, and cleanup --force-removed the whole
// worktrees tree including preserved failed-task worktrees.
await test("G1 a non-ASCII branch name gets its own worktree, not the worktrees dir", async () => {
  const repo = makeRepo();
  const report = await fanOut({
    repoDir: repo,
    tasks: [
      { branch: "\u0438\u0441\u043f\u0440\u0430\u0432\u043b\u0435\u043d\u0438\u0435", prompt: "p" },
      { branch: "feat/real-work", prompt: "p" },
    ],
    runner: stubRunner,
    merge: true,
    log: () => {},
  });
  assert(report.merged.length === 2, `expected both merged, got ${JSON.stringify(report)}`);

  const wtDir = join(realpathSync(repo), ".underclass", "worktrees");
  for (const rec of report.merged) {
    assert(rec.path !== wtDir, `worktree for '${rec.branch}' collapsed onto ${wtDir}`);
    assert(rec.path.startsWith(wtDir + "/"), `worktree ${rec.path} is not inside ${wtDir}`);
  }
  assert(report.merged[0].path !== report.merged[1].path, "two branches shared one worktree path");

  // The actual damage was a gitlink on the merged branch. Assert the outcome,
  // not just the path: mode 160000 is a committed submodule reference.
  const tree = git(["ls-tree", "-r", "HEAD"], repo);
  assert(!/160000/.test(tree), `a gitlink was committed to main:\n${tree}`);
});

await test("G1 an emoji-only branch and a CJK branch do not share a worktree", async () => {
  const repo = makeRepo();
  const report = await fanOut({
    repoDir: repo,
    tasks: [
      { branch: "\ud83d\udd25", prompt: "p" },
      { branch: "\u4fee\u5fa9", prompt: "p" },
    ],
    runner: stubRunner,
    merge: false,
    log: () => {},
  });
  const paths = [...report.merged, ...report.committedNotMerged, ...report.empty, ...report.failed].map((r) => r.path);
  assert(new Set(paths).size === paths.length, `worktree paths collided: ${paths.join(", ")}`);
  const wtDir = join(realpathSync(repo), ".underclass", "worktrees");
  for (const p of paths) assert(p.startsWith(wtDir + "/"), `${p} escaped ${wtDir}`);
});

await test("G1 a failed sibling's preserved worktree survives an empty-slug task", async () => {
  const repo = makeRepo();
  const failing = {
    async run(task) {
      if (task.branch === "\u4fee\u5fa9") {
        writeFileSync(join(task.cwd, "ok.txt"), "work\n");
        return;
      }
      writeFileSync(join(task.cwd, "half-done.txt"), "partial\n");
      throw new Error("agent failed");
    },
  };
  const report = await fanOut({
    repoDir: repo,
    tasks: [{ branch: "\u4fee\u5fa9", prompt: "p" }, { branch: "feat/doomed", prompt: "p" }],
    runner: failing,
    merge: true,
    log: () => {},
  });
  assert(report.failed.length === 1, `expected one failure, got ${report.failed.length}`);
  // The report names the preserved path; it must actually still be there.
  const kept = report.failed[0].path;
  assert(existsSync(kept), `report preserves ${kept} but it was deleted`);
  assert(existsSync(join(kept, "half-done.txt")), "the failed agent's work was destroyed");
});

// ---- G3: emptiness was judged from the ref, not from where the agent left HEAD ----
// `git checkout -b` before touching anything is one of the most reliable habits
// a model has, and nothing in the child's prompt says it is already on a branch
// of its own. Judging by base..task.branch then reads 0, the tree is clean so
// commitAll returns null, and the task is bucketed `empty` and printed as
// "no changes" — then its worktree is force-removed and its branch -D'd.
await test("G3 an agent that commits on its own branch is not reported as empty", async () => {
  const repo = makeRepo();
  const wanderer = {
    async run(task) {
      git(["checkout", "-b", "agent/my-fix"], task.cwd);
      writeFileSync(join(task.cwd, "fix.txt"), "the work\n");
      git(["add", "-A"], task.cwd);
      git(["commit", "-m", "agent's own commit"], task.cwd);
    },
  };
  const report = await fanOut({
    repoDir: repo,
    tasks: [{ branch: "feat/a", prompt: "p" }],
    runner: wanderer,
    merge: true,
    log: () => {},
  });
  assert(report.empty.length === 0, "work committed on another branch must not be bucketed empty");
  assert(report.failed.length === 1, `expected it reported as failed, got ${JSON.stringify(report)}`);
  assert(/agent\/my-fix/.test(report.failed[0].error ?? ""), `the report must name where the work went: ${report.failed[0].error}`);
  // The branch the agent made must survive, and so must its worktree.
  assert(git(["rev-parse", "--verify", "agent/my-fix"], repo), "the agent's branch was deleted");
  assert(existsSync(report.failed[0].path), "the worktree holding the work was removed");
});

await test("G3 a detached-HEAD commit is preserved, not left to gc", async () => {
  const repo = makeRepo();
  const detached = {
    async run(task) {
      git(["checkout", "--detach"], task.cwd);
      writeFileSync(join(task.cwd, "fix.txt"), "the work\n");
      git(["add", "-A"], task.cwd);
      git(["commit", "-m", "detached commit"], task.cwd);
    },
  };
  const report = await fanOut({
    repoDir: repo,
    tasks: [{ branch: "feat/a", prompt: "p" }],
    runner: detached,
    merge: true,
    log: () => {},
  });
  assert(report.empty.length === 0, "a detached commit must not be bucketed empty");
  assert(report.failed.length === 1, `expected failed, got ${JSON.stringify(report)}`);
  assert(/detached/.test(report.failed[0].error ?? ""), `the report must say it is detached: ${report.failed[0].error}`);
  // This is the arm where the work is otherwise practically lost: no ref, and
  // `worktree remove --force` takes the worktree reflog with it.
  const kept = report.failed[0].path;
  assert(existsSync(join(kept, "fix.txt")), "the detached work was destroyed");
});

await test("G3 the ordinary case still merges (control)", async () => {
  const repo = makeRepo();
  const report = await fanOut({
    repoDir: repo,
    tasks: [{ branch: "feat/a", prompt: "p" }],
    runner: stubRunner,
    merge: true,
    log: () => {},
  });
  assert(report.merged.length === 1, `expected merged, got ${JSON.stringify(report)}`);
  assert(report.failed.length === 0, "a well-behaved agent must not be failed");
});

for (const dir of temps) rmSync(dir, { recursive: true, force: true });
const failed = results.filter(([ok]) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
