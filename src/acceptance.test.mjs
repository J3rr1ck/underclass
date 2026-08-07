/**
 * Acceptance suite — automates the model-free acceptance criteria from
 * docs/USER-STORIES.md.
 *
 * Two different eval axes exist in this repo and they measure different things:
 *
 *   bench/            CAPABILITY. Can an agent do coding work? 40 tasks with
 *                     ground-truth verifiers. Needs a model, takes hours,
 *                     compares agents against each other.
 *   this file         BEHAVIOR. Does `under` keep the promises its user stories
 *                     make? No model, seconds, deterministic, CI-able.
 *
 * The bench cannot tell you that a typo started a mutating run, that a dirty
 * tree was clobbered, or that telemetry ignored its opt-out. Those are product
 * guarantees, and until now they were verified by hand — which is exactly the
 * kind of check that silently rots.
 *
 * Every test names the story it enforces, so a failure points at a promise
 * rather than at an implementation detail.
 *
 * Usage: node packages/under/src/acceptance.test.mjs   (requires a build)
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "dist", "index.js");
if (!existsSync(CLI)) {
  console.error(`acceptance: ${CLI} missing — run \`npm run build\` first.`);
  process.exit(1);
}

let pass = 0;
let fail = 0;
const failures = [];

function check(story, name, fn) {
  const label = `${story} — ${name}`;
  try {
    fn();
    console.log(`  ok   ${label}`);
    pass++;
  } catch (err) {
    console.log(`  FAIL ${label}\n         ${err.message}`);
    failures.push(label);
    fail++;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

/** Run the CLI, never throwing. */
function under(args, opts = {}) {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    timeout: opts.timeout ?? 30_000,
    cwd: opts.cwd ?? process.cwd(),
    env: { ...process.env, ...(opts.env ?? {}) },
    input: opts.input,
  });
  return { status: res.status, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

function scratch() {
  return mkdtempSync(join(tmpdir(), "under-acceptance-"));
}

function gitRepo() {
  const dir = scratch();
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "a@b.invalid"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "seed\n");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "seed"], { cwd: dir });
  return dir;
}

console.log("acceptance — model-free user-story criteria\n");

// ---------------------------------------------------------------- A. First run
check("A1", "--help lists the documented flag surface", () => {
  const { status, out } = under(["--help"]);
  assert(status === 0, `exit ${status}`);
  for (const flag of ["--lmstudio", "--ollama", "--base-url", "--tier", "--tools", "--list-models", "--timeout"]) {
    assert(out.includes(flag), `--help omits ${flag}`);
  }
  for (const sub of ["fan-out", "learn", "remember"]) {
    assert(out.includes(sub), `--help omits subcommand ${sub}`);
  }
});

check("A3", "an unreachable endpoint fails fast with a named cause", () => {
  const t0 = Date.now();
  // A high port nothing listens on. (Low ports like 1 are refused by the fetch
  // spec's blocked-port list, which is a different failure than "not running".)
  const { status, out } = under(["--base-url", "http://127.0.0.1:45999/v1", "-m", "custom/x", "do a thing"]);
  const elapsed = Date.now() - t0;
  assert(status === 1, `expected exit 1, got ${status}`);
  assert(/cannot reach/i.test(out), `no diagnosis in output: ${out.slice(0, 200)}`);
  assert(/ECONNREFUSED|nothing is listening/i.test(out), `cause not named: ${out.slice(0, 200)}`);
  assert(elapsed < 20_000, `took ${elapsed}ms — should fail fast, not after retries`);
});

check("A5", "a mistyped flag is rejected instead of becoming prompt text", () => {
  const dir = scratch();
  try {
    const { status, out } = under(["--dry-run", "delete everything"], { cwd: dir });
    assert(status === 1, `expected exit 1, got ${status}`);
    assert(/unknown option/i.test(out), `no unknown-option error: ${out.slice(0, 160)}`);
    // and it must not have started a run: nothing written, no model contacted
    assert(!out.includes("under →"), "a run was started despite the bad flag");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check("A5", "-- escapes a leading-dash prompt", () => {
  // Should get past arg parsing and fail on the endpoint, not on the flag.
  const { out } = under(["--base-url", "http://127.0.0.1:45999/v1", "-m", "custom/x", "--", "--not-a-flag"]);
  assert(!/unknown option/i.test(out), `-- did not escape: ${out.slice(0, 160)}`);
});

// ---------------------------------------------------------------- B. Fan-out
check("B1", "fan-out --dry-run prints a plan and touches nothing", () => {
  const dir = gitRepo();
  try {
    const before = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
    const { status, out } = under(
      ["fan-out", "--dry-run", "--task", "feat/a:do a", "--task", "feat/b:do b"],
      { cwd: dir },
    );
    assert(status === 0, `exit ${status}: ${out.slice(0, 200)}`);
    assert(/feat\/a/.test(out) && /feat\/b/.test(out), "plan omits a task");
    const after = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
    assert(before === after, "HEAD moved during a dry run");
    const branches = execFileSync("git", ["branch", "--list"], { cwd: dir, encoding: "utf8" });
    assert(!/feat\//.test(branches), "a dry run created branches");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check("B3", "fan-out refuses to run on a dirty tree", () => {
  const dir = gitRepo();
  try {
    writeFileSync(join(dir, "uncommitted.txt"), "work in progress\n");
    const { status, out } = under(["fan-out", "--task", "feat/a:do a"], { cwd: dir });
    assert(status === 1, `expected exit 1, got ${status}`);
    assert(/uncommitted changes/i.test(out), `wrong refusal: ${out.slice(0, 200)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check("B4", "fan-out validates --concurrency instead of silently ignoring it", () => {
  const dir = gitRepo();
  try {
    const { status, out } = under(["fan-out", "--concurrency", "ten", "--task", "feat/a:x"], { cwd: dir });
    assert(status === 1, `expected exit 1, got ${status}`);
    assert(/concurrency/i.test(out), `no concurrency error: ${out.slice(0, 160)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- C. Routing
check("C1", "task text selects a tier, and --tier overrides it", async () => {
  const mod = await import(join(HERE, "..", "dist", "model-map.js"));
  assert(mod.classifyTask("Fix the typo in README.md") === "tiny", "mechanical one-file task should route tiny");
  assert(
    mod.classifyTask("Why does the worker pool deadlock intermittently?") === "thinking",
    "diagnosis task should route thinking",
  );
  assert(
    mod.classifyTask("Rename fetchData across every call site") === "thinking",
    "breadth task should route thinking",
  );
  // A tier whose endpoint is undefined must be skipped, not crash.
  const resolved = mod.tierModel({ models: {}, tiers: { tiny: { endpoint: "missing", model: "m" } } }, "tiny");
  assert(resolved === undefined, "an undefined endpoint should yield no target");
});

check("C1", "an explicit -m disables routing entirely", () => {
  const { out } = under(["--base-url", "http://127.0.0.1:45999/v1", "-m", "custom/pinned-model", "x"]);
  assert(!/tier:/.test(out), `routing ran despite an explicit -m: ${out.slice(0, 160)}`);
});

// ---------------------------------------------------------------- E. Learning loop
check("E1", "remember stores a preference and it is loaded back", async () => {
  const home = scratch();
  const proj = scratch();
  try {
    const { status } = under(["remember", "prefer node:test over vitest"], { cwd: proj, env: { HOME: home } });
    assert(status === 0, `remember exited ${status}`);
    const prefs = await import(join(HERE, "..", "dist", "preferences.js"));
    const file = join(home, ".underclass", "preferences.md");
    assert(existsSync(file), "global preferences file was not created");
    assert(readFileSync(file, "utf8").includes("node:test"), "preference text not stored");
    // project scope is a separate file and wins by being appended last
    mkdirSync(join(proj, ".underclass"), { recursive: true });
    writeFileSync(join(proj, ".underclass", "preferences.md"), "- never touch generated/\n");
    const loaded = prefs.loadPreferences(proj);
    assert(loaded && loaded.includes("never touch generated/"), "project preferences not loaded");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
  }
});

check("E3", "telemetry stays local and honours its opt-out", async () => {
  const home = scratch();
  try {
    const tel = await import(join(HERE, "..", "dist", "telemetry.js"));
    const rec = {
      ts: new Date().toISOString(),
      provider: "p",
      model: "m",
      promptHead: "x",
      promptLength: 1,
      tokensIn: 0,
      tokensOut: 0,
      durationMs: 1,
      toolCalls: 0,
      tools: [],
      outcome: "ok",
    };
    process.env.HOME = home;
    process.env.UNDER_NO_TELEMETRY = "1";
    tel.recordRun(rec);
    assert(!existsSync(join(home, ".underclass", "runs.jsonl")), "opt-out did not suppress the write");
    delete process.env.UNDER_NO_TELEMETRY;
    tel.recordRun(rec);
    const p = join(home, ".underclass", "runs.jsonl");
    assert(existsSync(p), "no telemetry written when enabled");
    const line = JSON.parse(readFileSync(p, "utf8").trim().split("\n").pop());
    assert(line.model === "m", "record did not round-trip");
    // The path must be under the user's own directory — never a shared or remote sink.
    assert(p.startsWith(home), "telemetry escaped the user's home directory");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

check("E2", "learn refuses to assert a verdict without repeated evidence", async () => {
  const learn = await import(join(HERE, "..", "dist", "learn.js"));
  const one = [{ provider: "p", model: "m", outcome: "error", tokensIn: 10, toolCalls: 0, tools: [] }];
  assert(learn.analyze(one).length === 0, "a single run produced a verdict");
  const many = Array.from({ length: 4 }, () => ({
    provider: "p",
    model: "m",
    outcome: "error",
    tokensIn: 10,
    toolCalls: 0,
    tools: [],
  }));
  const proposals = learn.analyze(many);
  assert(proposals.some((p) => p.change.avoid), "repeated failure did not produce an avoid verdict");
});

// ---------------------------------------------------------------- report
const total = pass + fail;
console.log(`\n${pass}/${total} acceptance criteria hold.`);
if (fail) {
  console.log("\nBroken promises:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
