// Stall-watchdog regression suite: real child processes, no git, no model.
//   node packages/under/src/stall.test.mjs
// Runs against packages/under/dist (build first); UNDER_DIST overrides that.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const distUrl = process.env.UNDER_DIST
  ? pathToFileURL(join(process.env.UNDER_DIST, "/"))
  : new URL("../dist/", import.meta.url);
let SpawnUnderRunner;
try {
  ({ SpawnUnderRunner } = await import(new URL("runner.js", distUrl).href));
} catch (err) {
  console.error(`cannot load the runner from ${distUrl}: ${err.message}\nBuild first (npm run build).`);
  process.exit(2);
}

const temps = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tmp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

/** Fake agent that never writes to either pipe; only a kill ends it. */
function silentAgent() {
  const file = join(tmp("under-agent-"), "silent.mjs");
  writeFileSync(file, "setInterval(() => {}, 1000);\n");
  return file;
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

// ---- a wedged child is killed after one silent window, not the full budget ----
await test("silent child is killed by the stall watchdog", async () => {
  const dir = tmp("under-stall-");
  const started = Date.now();
  const err = await new SpawnUnderRunner({ entry: silentAgent(), stallMs: 600 })
    .run({ prompt: "x", cwd: dir, branch: "b" })
    .then(
      () => null,
      (e) => e,
    );
  const took = Date.now() - started;
  assert(err && /stalled: no output for 1s/.test(err.message), `expected a stall, got ${err && err.message}`);
  assert(took < 3000, `watchdog took ${took}ms to act`);
});

// ---- the reason the watchdog exists: slowness is not death ----
await test("slow-but-chatty child outlives its stall window", async () => {
  const dir = tmp("under-chatty-");
  const chatty = join(dir, "chatty.mjs");
  // 15 bytes at 100ms spacing: total runtime is three whole stall windows,
  // but no single gap comes near one. A wall clock of the same 500ms would
  // have killed this child; the watchdog must let it finish.
  writeFileSync(
    chatty,
    `let n = 0;\n` +
      `const t = setInterval(() => {\n` +
      `  process.stdout.write("x");\n` +
      `  if (++n === 15) clearInterval(t);\n` +
      `}, 100);\n`,
  );
  const result = await new SpawnUnderRunner({ entry: chatty, stallMs: 500 }).run({
    prompt: "x",
    cwd: dir,
    branch: "b",
  });
  assert(result.text === "x".repeat(15), `output not intact: ${JSON.stringify(result.text)}`);
});

// ---- the two kill causes must stay distinguishable in reports ----
await test("timeout and stall report distinct causes", async () => {
  const dir = tmp("under-causes-");
  const err = await new SpawnUnderRunner({ entry: silentAgent(), timeoutMs: 500 })
    .run({ prompt: "x", cwd: dir, branch: "b" })
    .then(
      () => null,
      (e) => e,
    );
  assert(err && /timed out after \d+s/.test(err.message), `expected the timeout, got ${err && err.message}`);
  assert(!/stalled/.test(err.message), `timeout must not read as a stall: ${err.message}`);
});

// ---- early output must not immunize a child that wedges afterwards ----
await test("child that goes quiet after early output is still caught", async () => {
  const dir = tmp("under-quiet-");
  const quiet = join(dir, "quiet.mjs");
  writeFileSync(quiet, `setTimeout(() => process.stdout.write("early"), 100);\n` + `setInterval(() => {}, 1000);\n`);
  const err = await new SpawnUnderRunner({ entry: quiet, stallMs: 600 })
    .run({ prompt: "x", cwd: dir, branch: "b" })
    .then(
      () => null,
      (e) => e,
    );
  assert(err && /stalled/.test(err.message), `expected a stall, got ${err && err.message}`);
});

// ---- task-level window overrides the runner's, same as timeoutMs ----
await test("task stallMs overrides the runner's", async () => {
  const dir = tmp("under-override-");
  const started = Date.now();
  const err = await new SpawnUnderRunner({ entry: silentAgent(), stallMs: 60_000 })
    .run({ prompt: "x", cwd: dir, branch: "b", stallMs: 500 })
    .then(
      () => null,
      (e) => e,
    );
  assert(err && /stalled/.test(err.message), `expected a stall, got ${err && err.message}`);
  assert(Date.now() - started < 3000, "runner-level window was used instead of the task's");
});

// ---- mirror of UNDER-14: the stall kill must take the whole tree down ----
await test("stall kill takes down bash grandchildren", async () => {
  const dir = tmp("under-stallkill-");
  const marker = join(dir, "grandchild.log");
  // 4s, not 700ms: the fake agent is silent from spawn, so the watchdog's
  // clock starts at boot — a busy host can take over a second to even start
  // the bash grandchild, and a kill that lands before it exists proves
  // nothing about killing it (same load-flake fixed in fanout's UNDER-14).
  const runner = new SpawnUnderRunner({ entry: grandchildAgent(marker), stallMs: 4000 });
  const err = await runner.run({ prompt: "x", cwd: dir, branch: "b" }).then(
    () => null,
    (e) => e,
  );
  assert(err && /stalled/.test(err.message), `expected a stall, got ${err && err.message}`);
  const atKill = existsSync(marker) ? statSync(marker).size : 0;
  assert(atKill > 0, "grandchild never started — test is not exercising the kill");
  await sleep(1200);
  const later = existsSync(marker) ? statSync(marker).size : 0;
  assert(later === atKill, `grandchild survived the stall kill (${atKill} -> ${later} bytes)`);
});

// ---- the condemned get no more chances ----
// A child that traps SIGTERM and prints a byte in response used to be
// unkillable: the byte re-armed the watchdog, the next stall re-entered
// terminate(), and every terminate() discarded the pending SIGKILL and
// scheduled a fresh one — reproduced as a child that survived 24 SIGTERMs.
await test("a SIGTERM-trapping child that prints on the signal is still killed", async () => {
  const dir = tmp("under-immortal-");
  const immortal = join(dir, "immortal.mjs");
  writeFileSync(
    immortal,
    `process.on("SIGTERM", () => process.stdout.write("[shutting down…]"));\n` + `setInterval(() => {}, 1000);\n`,
  );
  const started = Date.now();
  const err = await new SpawnUnderRunner({ entry: immortal, stallMs: 600 })
    .run({ prompt: "x", cwd: dir, branch: "b" })
    .then(
      () => null,
      (e) => e,
    );
  // stall(600ms after boot) + 5s escalation + drain, plus load headroom.
  const took = Date.now() - started;
  assert(err && /stalled/.test(err.message), `expected a stall, got ${err && err.message}`);
  assert(took < 15_000, `the SIGKILL escalation was deferred: ${took}ms — the child was immortal`);
});

await test("a second guard firing does not push out the first guard's SIGKILL", async () => {
  const dir = tmp("under-delayedkill-");
  const trap = join(dir, "trap.mjs");
  writeFileSync(trap, `process.on("SIGTERM", () => {});\n` + `setInterval(() => {}, 1000);\n`);
  const started = Date.now();
  // Wall clock at 500ms arms a SIGKILL for ~5.5s; the stall firing at 5s used
  // to discard it and re-schedule for 10s. The kill must honour the EARLIEST.
  const err = await new SpawnUnderRunner({ entry: trap, timeoutMs: 500, stallMs: 5000 })
    .run({ prompt: "x", cwd: dir, branch: "b" })
    .then(
      () => null,
      (e) => e,
    );
  const took = Date.now() - started;
  assert(err && /timed out/.test(err.message), `expected the timeout, got ${err && err.message}`);
  assert(took < 8500, `SIGKILL was rescheduled by the second guard: ${took}ms (should be ~5.8s)`);
});

// ---- a settled run must not leave the caller's event loop pinned ----
await test("a daemon grandchild holding stdout does not keep the caller alive", async () => {
  const dir = tmp("under-pipehold-");
  const entry = join(dir, "answer-and-daemon.mjs");
  writeFileSync(
    entry,
    `import { spawn } from "node:child_process";\n` +
      `spawn("sleep", ["8"], { stdio: "inherit" }).unref();\n` +
      `process.stdout.write("ANSWER");\n`,
  );
  const driver = join(dir, "driver.mjs");
  // A separate process, because the assertion is about process exit: the
  // driver must be able to exit as soon as the promise settles, not when the
  // 8s daemon lets go of the pipes it inherited.
  writeFileSync(
    driver,
    `const { SpawnUnderRunner } = await import(${JSON.stringify(new URL("runner.js", distUrl).href)});\n` +
      `const r = await new SpawnUnderRunner({ entry: ${JSON.stringify(entry)} }).run({ prompt: "x", cwd: ${JSON.stringify(dir)}, branch: "b" });\n` +
      `process.stdout.write("settled:" + r.text.slice(0, 6));\n`,
  );
  const started = Date.now();
  const out = await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [driver], { stdio: ["ignore", "pipe", "ignore"] });
    let s = "";
    p.stdout.on("data", (c) => (s += c));
    p.on("error", reject);
    p.on("exit", () => resolve(s));
  });
  const took = Date.now() - started;
  assert(/settled:ANSWER/.test(out), `driver did not settle cleanly: ${out}`);
  assert(took < 5000, `the caller was pinned by the grandchild's pipes for ${took}ms`);
});

// ---- prompts are data, not flags ----
await test("a prompt that looks like a flag reaches the child as prompt text", async () => {
  const dir = tmp("under-dashprompt-");
  const echo = join(dir, "echo.mjs");
  writeFileSync(echo, `process.stdout.write(JSON.stringify(process.argv.slice(2)));\n`);
  const out = await new SpawnUnderRunner({ entry: echo }).run({
    prompt: "--help",
    cwd: dir,
    branch: "b",
  });
  const argv = JSON.parse(out.text);
  // The separator must precede the prompt so the real CLI parses it as text —
  // "--help" as a prompt used to return under's help screen as the answer.
  assert(argv[argv.length - 1] === "--help", `prompt missing: ${out.text}`);
  assert(argv[argv.length - 2] === "--", `no -- separator before the prompt: ${out.text}`);
});

for (const dir of temps) rmSync(dir, { recursive: true, force: true });
const failed = results.filter(([ok]) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
