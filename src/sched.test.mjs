// Scheduler suite: priority slot handoff and adaptive width, no model.
//   node packages/under/src/sched.test.mjs
// Runs against packages/under/dist (build first); UNDER_DIST overrides that.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const distUrl = process.env.UNDER_DIST
  ? pathToFileURL(join(process.env.UNDER_DIST, "/"))
  : new URL("../dist/", import.meta.url);
let runWorkflow, WorkflowRuntime;
try {
  ({ runWorkflow } = await import(new URL("workflow/index.js", distUrl).href));
  ({ WorkflowRuntime } = await import(new URL("workflow/runtime.js", distUrl).href));
} catch (err) {
  console.error(`cannot load the workflow runtime from ${distUrl}: ${err.message}\nBuild first (npm run build).`);
  process.exit(2);
}

const temps = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function tmp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function makeRepo() {
  const dir = tmp("under-sched-");
  git(["init", "-b", "main"], dir);
  git(["config", "user.email", "test@example.com"], dir);
  git(["config", "user.name", "test"], dir);
  writeFileSync(join(dir, "README.md"), "base\n");
  git(["add", "-A"], dir);
  git(["commit", "-m", "init"], dir);
  return dir;
}

/**
 * Agent stand-in. `reply` decides what each call answers, and every call is
 * recorded so a test can assert on concurrency, arguments and call counts
 * without a model anywhere in the loop.
 */
function stubRunner(reply) {
  const calls = [];
  let inFlight = 0;
  let peak = 0;
  return {
    calls,
    get peak() {
      return peak;
    },
    async run(task) {
      const index = calls.length;
      calls.push(task);
      inFlight++;
      peak = Math.max(peak, inFlight);
      try {
        const out = await reply(task, index);
        return { text: typeof out === "string" ? out : String(out ?? ""), stderr: "", truncated: false };
      } finally {
        inFlight--;
      }
    },
  };
}

/**
 * The adaptive tests drive WorkflowRuntime directly because the live `width`
 * is only observable on the runtime instance — runWorkflow passes "auto"
 * through but exposes no handle to it. No git repo needed: agents without
 * worktree isolation run in ctx.root as-is.
 */
function makeRuntime(runner) {
  const dir = tmp("under-sched-rt-");
  return new WorkflowRuntime({
    ctx: {
      runner,
      root: dir,
      runId: "schedtest",
      worktreeDir: join(dir, "worktrees"),
      log: () => {},
      usage: () => ({ tokensIn: 0, tokensOut: 0 }),
    },
    concurrency: "auto",
  });
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

const run = (source, opts = {}) =>
  runWorkflow({ source, repoDir: opts.repoDir ?? makeRepo(), runner: opts.runner, ...opts });

// ---- priority: a queued deep stage beats an earlier-queued shallow one ----
await test("a stage-2 agent takes the slot ahead of a stage-1 agent queued first", async () => {
  const runner = stubRunner(async (task) => {
    if (task.prompt === "a s1") await sleep(80);
    else if (task.prompt === "b s1") await sleep(250);
    else await sleep(10);
    return "x";
  });
  await run(
    `export const meta = { name: 'prio', description: 'd' }
     const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
     await pipeline(['a', 'b', 'c'],
       async (item) => {
         if (item === 'b') await sleep(10)
         if (item === 'c') await sleep(25)
         return agent(item + ' s1')
       },
       (_prev, item) => agent(item + ' s2'))`,
    { runner, concurrency: 1 },
  );
  // With one slot: 'a s1' runs first while 'b s1' and 'c s1' queue behind it in
  // that order. When 'a s1' releases, FIFO within a depth hands the slot to
  // 'b s1', and 'a s2' joins the queue behind the still-waiting 'c s1'. At
  // 'b s1's release both are waiting, and depth must beat arrival order.
  const order = runner.calls.map((c) => c.prompt);
  const at = (p) => order.indexOf(p);
  assert(order.length === 6, `expected 6 agents, got: ${order.join(", ")}`);
  assert(at("a s2") !== -1 && at("c s1") !== -1, `missing calls: ${order.join(", ")}`);
  assert(
    at("a s2") < at("c s1"),
    `the earlier-queued stage-1 agent ran first (${order.join(", ")}) — the slot went by arrival, not depth`,
  );
});

await test("equal-priority waiters run in submission order", async () => {
  const runner = stubRunner(async () => {
    await sleep(20);
    return "x";
  });
  await run(
    `export const meta = { name: 'fifo', description: 'd' }
     await parallel([() => agent('first'), () => agent('second'), () => agent('third')])`,
    { runner, concurrency: 1 },
  );
  const order = runner.calls.map((c) => c.prompt).join(",");
  assert(order === "first,second,third", `submission order not kept: ${order}`);
});

// ---- the numeric contract is untouched by all of the above ----
await test("numeric concurrency still peaks at exactly its cap", async () => {
  const runner = stubRunner(async () => {
    await sleep(40);
    return "x";
  });
  await run(
    `export const meta = { name: 'c', description: 'd' }
     await parallel(Array.from({ length: 9 }, (_, i) => () => agent('task ' + i)))`,
    { runner, concurrency: 3 },
  );
  assert(runner.calls.length === 9, `expected 9 agents, got ${runner.calls.length}`);
  assert(runner.peak <= 3, `cap breached: ${runner.peak} agents ran at once`);
  assert(runner.peak === 3, `cap undershot: only ${runner.peak} ran at once, so slots were wasted`);
});

// ---- "auto": the width finds the endpoint's pace instead of guessing it ----
await test("auto width grows past its starting 2 while agents stay fast", async () => {
  const runner = stubRunner(async () => {
    await sleep(25);
    return "x";
  });
  const rt = makeRuntime(runner);
  const hooks = rt.hooks({}, () => {});
  await hooks.parallel(Array.from({ length: 12 }, (_, i) => () => hooks.agent("fast " + i)));
  await rt.drain();
  assert(runner.calls.length === 12, `expected 12 agents, got ${runner.calls.length}`);
  assert(runner.peak > 2, `identical fast agents never widened the pool: peak ${runner.peak}`);
  assert(rt.width > 2, `width should have grown, still ${rt.width}`);
  assert(runner.peak <= 8, `the cap is 8, but ${runner.peak} ran at once`);
});

await test("auto width comes back down when agents slow", async () => {
  let rt;
  let widthPeak = 0;
  const runner = stubRunner(async (task, i) => {
    widthPeak = Math.max(widthPeak, rt.width);
    // The first wave is quick; everything after runs an order slower, the way
    // an endpoint behaves once the pool is past what it can actually feed.
    await sleep(i < 4 ? 20 : 250);
    widthPeak = Math.max(widthPeak, rt.width);
    return "x";
  });
  rt = makeRuntime(runner);
  const hooks = rt.hooks({}, () => {});
  await hooks.parallel(Array.from({ length: 12 }, (_, i) => () => hooks.agent("job " + i)));
  await rt.drain();
  assert(runner.calls.length === 12, `expected 12 agents, got ${runner.calls.length}`);
  assert(widthPeak >= 3, `the width never grew before the slowdown: peak ${widthPeak}`);
  assert(rt.width < widthPeak, `the width never came back down: peak ${widthPeak}, final ${rt.width}`);
});

// A lifetime-minimum baseline let one freak-fast completion (an endpoint
// answering from cache) condemn every honest completion after it as
// congestion: the width collapsed to 1 and stayed there for the rest of the
// run. The baseline is windowed now, so the anomaly ages out and the width
// recovers.
await test("one anomalously fast completion does not pin the width at 1 forever", async () => {
  const rt0 = makeRuntime(
    stubRunner(async (task, i) => {
      await sleep(i === 0 ? 1 : 120);
      return "x";
    }),
  );
  const hooks = rt0.hooks({}, () => {});
  // Sequential on purpose: the poisoned regime runs at width 1 anyway, and the
  // point is what the width does across enough completions for the 1ms sample
  // to leave the baseline window.
  for (let i = 0; i < 16; i++) await hooks.agent("steady " + i);
  await rt0.drain();
  assert(rt0.width > 1, `the width never recovered from the poisoned baseline: ${rt0.width}`);
});

// ---- a slot is never leaked, whatever an agent does with it ----
await test("a dead agent hands its slot on instead of leaking it", async () => {
  const runner = stubRunner(async (task) => {
    await sleep(10);
    if (task.prompt === "boom") throw new Error("agent died");
    return "fine";
  });
  // With one slot, a leak behind the thrower is a run that never finishes —
  // convert that hang into a clean failure instead of wedging the suite.
  let timer;
  const wedged = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("the run never finished — a slot was leaked")), 8000);
  });
  try {
    const report = await Promise.race([
      run(
        `export const meta = { name: 'leak', description: 'd' }
         await parallel([() => agent('boom'), () => agent('ok 1'), () => agent('ok 2')])
         await parallel([() => agent('ok 3'), () => agent('ok 4')])
         return 'done'`,
        { runner, concurrency: 1 },
      ),
      wedged,
    ]);
    assert(report.value === "done", `the run did not complete: ${JSON.stringify(report.value)}`);
    assert(runner.calls.length === 5, `expected all 5 agents to run, got ${runner.calls.length}`);
    assert(
      report.agents.filter((a) => a.status === "failed").length === 1,
      "only the throwing agent should be recorded failed",
    );
  } finally {
    clearTimeout(timer);
  }
});

// ---- failures must not feed the width tuner ----
await test("a fast failure does not poison the adaptive baseline", async () => {
  const repoDir = makeRepo();
  // One agent fails instantly (~0ms), then a steady stream of healthy ~60ms
  // agents. If the failure's duration reached the tuner it would set the
  // baseline near zero, every healthy completion would read as >2.5x baseline,
  // and the width would halve to the floor instead of growing — so the
  // discriminating observable is the peak concurrency among the healthy
  // agents: growth needs a sane baseline; a poisoned one caps the peak at the
  // starting width on its way down to 1.
  let inFlight = 0;
  let peak = 0;
  const runner = {
    async run(task) {
      if (task.prompt.includes("dies")) throw new Error("instant failure");
      inFlight++;
      peak = Math.max(peak, inFlight);
      try {
        await sleep(60);
        return { text: "ok", stderr: "", truncated: false };
      } finally {
        inFlight--;
      }
    },
  };
  const report = await runWorkflow({
    source: `export const meta = { name: 'p', description: 'd' }
      await agent('dies')
      await parallel(Array.from({ length: 12 }, (_, i) => () => agent('steady ' + i)))
      return 'done'`,
    repoDir,
    runner,
    concurrency: "auto",
  });
  assert(!report.error, `run errored: ${report.error}`);
  const ok = report.agents.filter((a) => a.status === "ok").length;
  assert(ok === 12, `expected 12 healthy agents, got ${ok}`);
  assert(peak >= 3, `width never grew past its starting 2 (peak ${peak}) — the failure poisoned the baseline`);
});

for (const dir of temps) rmSync(dir, { recursive: true, force: true });
const failed = results.filter(([ok]) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
