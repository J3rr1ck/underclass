// Workflow orchestration suite: real temp git repos, stub agents, no model.
//   node packages/under/src/workflow.test.mjs
// Runs against packages/under/dist (build first); UNDER_DIST overrides that.
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Type } from "typebox";

const distUrl = process.env.UNDER_DIST
  ? pathToFileURL(join(process.env.UNDER_DIST, "/"))
  : new URL("../dist/", import.meta.url);
let runWorkflow, extractMeta, validateAgainst, jsonCandidates, createWorkflowRunner;
try {
  ({ runWorkflow, extractMeta, validateAgainst, jsonCandidates } = await import(
    new URL("workflow/index.js", distUrl).href
  ));
  ({ createWorkflowRunner } = await import(new URL("runner.js", distUrl).href));
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
  const dir = tmp("under-wf-");
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

// ---- the header is readable without executing the body ----
await test("dry run reports the declared plan without spawning anything", async () => {
  const runner = stubRunner(() => "never");
  const report = await run(
    `export const meta = { name: 'plan', description: 'd', phases: [{ title: 'One' }, { title: 'Two' }] }
     await agent('should never run')`,
    { runner, dryRun: true },
  );
  assert(report.dryRun, "expected a dry-run report");
  assert(report.meta.phases.length === 2, `expected 2 phases, got ${report.meta.phases?.length}`);
  assert(runner.calls.length === 0, "dry run spawned an agent");
});

await test("a script without a literal meta header is rejected", async () => {
  const bad = ["const meta = { name: 'x', description: 'y' }", "export const meta = someCall()"];
  for (const source of bad) {
    let threw = false;
    try {
      extractMeta(source);
    } catch {
      threw = true;
    }
    assert(threw, `expected a rejection for: ${source}`);
  }
  const ok = extractMeta("export const meta = { name: 'a', description: 'b' }\nphase('x')");
  assert(ok.name === "a", "a valid header should parse");
});

// ---- agents return data, which is the whole point ----
await test("agent() returns the child's answer text", async () => {
  const runner = stubRunner(() => "the answer");
  const report = await run(
    `export const meta = { name: 'a', description: 'd' }
     const said = await agent('ask')
     return { said }`,
    { runner },
  );
  assert(report.value.said === "the answer", `got ${JSON.stringify(report.value)}`);
  assert(report.agents.length === 1 && report.agents[0].status === "ok", "agent should be recorded ok");
});

await test("a non-isolated agent that answers nothing is a failure, not an empty success", async () => {
  const runner = stubRunner(() => "");
  const report = await run(
    `export const meta = { name: 'a', description: 'd' }
     return { said: await agent('ask') }`,
    { runner },
  );
  assert(report.value.said === null, "an empty answer must not read as data");
  assert(report.agents[0].status === "failed", "expected the agent to be recorded failed");
});

// ---- structured output against small-model behaviour ----
await test("schema answers survive fences and surrounding prose", async () => {
  const runner = stubRunner(
    () => 'Sure! Here is my answer:\n```json\n{ "count": 3, "why": "because" }\n```\nHope that helps.',
  );
  const report = await run(
    `export const meta = { name: 's', description: 'd' }
     return await agent('count', { schema: args.schema })`,
    { runner, args: { schema: Type.Object({ count: Type.Number(), why: Type.String() }) } },
  );
  assert(report.value && report.value.count === 3, `got ${JSON.stringify(report.value)}`);
});

await test("the answer is taken from the end, not from a worked example", () => {
  const text = 'First I might answer {"n": 1} but on reflection the answer is {"n": 2}';
  const best = jsonCandidates(text)[0];
  assert(best && best.n === 2, `picked ${JSON.stringify(best)}`);
});

await test("a stringly-typed answer is coerced rather than burning a retry", () => {
  const schema = Type.Object({ n: Type.Number(), ok: Type.Boolean() });
  const out = validateAgainst(schema, '{"n": "3", "ok": "true"}');
  assert(out.ok, `expected coercion to succeed: ${out.errors.join(", ")}`);
  assert(out.value.n === 3 && out.value.ok === true, `got ${JSON.stringify(out.value)}`);
});

await test("undeclared properties are dropped, not rejected", () => {
  const out = validateAgainst(Type.Object({ a: Type.String() }), '{"a":"x","chatty":"extra"}');
  assert(out.ok && out.value.chatty === undefined, `got ${JSON.stringify(out.value)}`);
});

// Scripts declare schemas as plain object literals so they need no imports at
// all. typebox's own Convert/Clean quietly do nothing to those, so coercion has
// to work against the schema as data — every shipped workflow depends on it.
await test("coercion works on a hand-written JSON Schema, not just a typebox one", () => {
  const schema = {
    type: "object",
    properties: {
      n: { type: "number" },
      ok: { type: "boolean" },
      name: { type: "string" },
      tags: { type: "array", items: { type: "number" } },
      nested: { type: "object", properties: { deep: { type: "integer" } } },
    },
    required: ["n", "ok", "name", "tags", "nested"],
  };
  const out = validateAgainst(
    schema,
    '{"n":"3","ok":"true","name":42,"tags":["1","2"],"nested":{"deep":"7","junk":1},"extra":"drop me"}',
  );
  assert(out.ok, `expected coercion to succeed: ${out.errors.join(", ")}`);
  assert(out.value.n === 3 && out.value.ok === true, `scalars not coerced: ${JSON.stringify(out.value)}`);
  assert(out.value.name === "42", `a number for a string field should stringify: ${out.value.name}`);
  assert(out.value.tags[0] === 1 && out.value.tags[1] === 2, `array items not coerced: ${JSON.stringify(out.value.tags)}`);
  assert(out.value.nested.deep === 7, `nested object not coerced: ${JSON.stringify(out.value.nested)}`);
  assert(out.value.extra === undefined && out.value.nested.junk === undefined, "undeclared keys must be dropped");
});

await test("a free-form object schema is not emptied and called a success", () => {
  // Stripping to the declared keys when nothing is declared discards the whole
  // answer — and {} satisfies such a schema, so total data loss returned ok.
  const schema = { type: "object", properties: { meta: { type: "object" } }, required: ["meta"] };
  const out = validateAgainst(schema, '{"meta":{"anything":1,"nested":{"deep":true}}}');
  assert(out.ok, `expected success: ${out.errors.join(", ")}`);
  assert(out.value.meta.anything === 1, `free-form contents were dropped: ${JSON.stringify(out.value)}`);
  assert(out.value.meta.nested.deep === true, "nested free-form contents were dropped");
});

await test("an answer wrapped in an envelope is still found", () => {
  // The scanner used to skip past a matched span entirely, so nothing nested
  // inside one was ever a candidate.
  const schema = { type: "object", properties: { n: { type: "number" } }, required: ["n"] };
  const out = validateAgainst(schema, 'Here you go: {"result": {"n": 5}, "ok": true}');
  assert(out.ok, `the nested answer was never considered: ${out.errors.join(", ")}`);
  assert(out.value.n === 5, `got ${JSON.stringify(out.value)}`);
});

await test("an unbalanced brace does not send the scanner quadratic", () => {
  // 8MB of stdout with many unmatched openers used to rescan the tail once per
  // opener, synchronously, on every agent answer.
  const text = "{".repeat(20000) + "x".repeat(200000);
  const started = Date.now();
  const found = jsonCandidates(text);
  const ms = Date.now() - started;
  assert(found.length === 0, "there is no valid JSON in that text");
  assert(ms < 2000, `scanning took ${ms}ms — the unbalanced path is still quadratic`);
});

await test("an integer field refuses a fractional string rather than silently truncating", () => {
  const schema = { type: "object", properties: { n: { type: "integer" } }, required: ["n"] };
  assert(!validateAgainst(schema, '{"n":"2.5"}').ok, "2.5 is not an integer and must not be coerced into one");
  assert(validateAgainst(schema, '{"n":"2"}').ok, "an integral string should still coerce");
});

await test("a schema miss is retried once, naming what was wrong", async () => {
  const runner = stubRunner((task, i) => (i === 0 ? "no json here at all" : '{"count": 7}'));
  const report = await run(
    `export const meta = { name: 's', description: 'd' }
     return await agent('count', { schema: args.schema })`,
    { runner, args: { schema: Type.Object({ count: Type.Number() }) } },
  );
  assert(runner.calls.length === 2, `expected one retry, got ${runner.calls.length} calls`);
  assert(/did not satisfy/.test(runner.calls[1].prompt), "the retry must say what was wrong");
  assert(report.value.count === 7, `got ${JSON.stringify(report.value)}`);
});

await test("an agent that never matches the schema fails instead of returning junk", async () => {
  const runner = stubRunner(() => "still not json");
  const report = await run(
    `export const meta = { name: 's', description: 'd' }
     return { got: await agent('count', { schema: args.schema }) }`,
    { runner, args: { schema: Type.Object({ count: Type.Number() }) } },
  );
  assert(report.value.got === null, "a failed agent must return null, not text");
  assert(report.agents[0].status === "failed", "expected a failed record");
  assert(runner.calls.length === 2, "expected exactly one retry");
});

// ---- the concurrency and control-flow contract ----
await test("concurrency is capped across the whole run", async () => {
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

await test("parallel() turns a failed agent into null instead of losing its siblings", async () => {
  const runner = stubRunner((task) => {
    if (task.prompt.includes("boom")) throw new Error("agent died");
    return "fine";
  });
  const report = await run(
    `export const meta = { name: 'p', description: 'd' }
     return await parallel([() => agent('ok one'), () => agent('boom'), () => agent('ok two')])`,
    { runner },
  );
  assert(report.value.length === 3, `expected 3 slots, got ${report.value.length}`);
  assert(report.value[1] === null, "the dead agent should be null");
  assert(report.value[0] === "fine" && report.value[2] === "fine", "siblings must survive");
});

await test("pipeline() has no barrier between stages", async () => {
  const marks = [];
  const runner = stubRunner(async (task) => {
    if (task.prompt.startsWith("slow")) await sleep(150);
    marks.push({ at: Date.now(), prompt: task.prompt });
    return "done";
  });
  await run(
    `export const meta = { name: 'pl', description: 'd' }
     await pipeline(['slow', 'fast'],
       (item) => agent(item + ' stage1'),
       (_prev, item) => agent(item + ' stage2'))`,
    { runner, concurrency: 4 },
  );
  const slowStage1 = marks.find((m) => m.prompt === "slow stage1");
  const fastStage2 = marks.find((m) => m.prompt === "fast stage2");
  assert(slowStage1 && fastStage2, `missing marks: ${marks.map((m) => m.prompt).join(", ")}`);
  assert(
    fastStage2.at < slowStage1.at,
    "the fast item waited for the slow item's stage 1 — that is a barrier, and pipeline() must not have one",
  );
});

await test("a stage that throws drops its own item and spares the rest", async () => {
  const runner = stubRunner((task) => (task.prompt.includes("bad") ? "" : "ok"));
  const report = await run(
    `export const meta = { name: 'pl', description: 'd' }
     return await pipeline(['good', 'bad'],
       (item) => agent(item + ' one'),
       (prev) => { if (!prev) throw new Error('nothing to work with'); return prev })`,
    { runner },
  );
  assert(report.value[0] === "ok", "the healthy item should complete");
  assert(report.value[1] === null, "the failing item should be null");
});

await test("phase() groups the agents that follow it", async () => {
  const runner = stubRunner(() => "x");
  const report = await run(
    `export const meta = { name: 'ph', description: 'd' }
     phase('Find'); await agent('a')
     phase('Verify'); await agent('b')
     await agent('c', { phase: 'Find' })`,
    { runner },
  );
  assert(report.agents.map((a) => a.phase).join(",") === "Find,Verify,Find", report.agents.map((a) => a.phase).join(","));
});

await test("a script can scale itself to the budget it was given", async () => {
  const runner = stubRunner(() => "x");
  const report = await run(
    `export const meta = { name: 'b', description: 'd' }
     let n = 0
     while (budget.total && budget.remaining() > 100) { await agent('spend ' + n++) }
     return { n, spent: budget.spent() }`,
    { runner, budgetTokens: 1000, usage: () => ({ tokensIn: 50, tokensOut: 300 }) },
  );
  // 300 output tokens an agent against a 1,000 ceiling: three fit, the fourth
  // would leave under the 100 the script asked to keep in hand.
  assert(report.value.n === 3, `expected the loop to stop after 3 agents, ran ${report.value.n}`);
  assert(report.value.spent === 900, `spent should track real usage, got ${report.value.spent}`);
});

// The sequential form of this test passed while the concurrent form did not:
// the ceiling was read before the concurrency slot, so a whole parallel batch
// cleared it in one microtask drain while nothing had yet been spent.
await test("the budget is enforced inside a parallel batch, not just between batches", async () => {
  const runner = stubRunner(() => "x");
  const report = await run(
    `export const meta = { name: 'b', description: 'd' }
     await parallel(Array.from({ length: 20 }, (_, i) => () => agent('spend ' + i)))
     return 'done'`,
    { runner, concurrency: 4, budgetTokens: 500, usage: () => ({ tokensIn: 10, tokensOut: 300 }) },
  );
  assert(runner.calls.length < 20, `the whole batch bypassed the ceiling: ${runner.calls.length} agents ran`);
  assert(runner.calls.length <= 5, `overshoot beyond one slot-width: ${runner.calls.length} agents ran`);
  assert(/exhausted its 500 output-token budget/.test(report.error ?? ""), `truncation not reported: ${report.error}`);
});

await test("a run cut short by its ceiling is not reported as a success", async () => {
  const runner = stubRunner(() => "x");
  // parallel() swallows the budget throw by design; the report must still say so.
  const report = await run(
    `export const meta = { name: 'b', description: 'd' }
     await parallel(Array.from({ length: 10 }, (_, i) => () => agent('spend ' + i)))
     return { looksFine: true }`,
    { runner, concurrency: 2, budgetTokens: 300, usage: () => ({ tokensIn: 5, tokensOut: 300 }) },
  );
  assert(report.error, "a truncated run reported no error at all");
  assert(/budget/.test(report.error), `unexpected error: ${report.error}`);
});

await test("the budget is a ceiling, not a suggestion", async () => {
  const runner = stubRunner(() => "x");
  const report = await run(
    `export const meta = { name: 'b', description: 'd' }
     for (let i = 0; i < 10; i++) await agent('spend ' + i)
     return 'never reached'`,
    { runner, budgetTokens: 500, usage: () => ({ tokensIn: 10, tokensOut: 300 }) },
  );
  // A script that ignores budget.remaining() must still be stopped.
  assert(/exhausted its 500 output-token budget/.test(report.error ?? ""), `got: ${report.error}`);
  assert(runner.calls.length === 2, `expected the ceiling to bite after 2 agents, ran ${runner.calls.length}`);
});

await test("a runaway script is stopped by the agent backstop", async () => {
  const runner = stubRunner(() => "x");
  const report = await run(
    `export const meta = { name: 'r', description: 'd' }
     while (true) { await agent('forever') }`,
    { runner, concurrency: 8 },
  );
  assert(/exceeded 1000 agents/.test(report.error ?? ""), `expected the backstop, got: ${report.error}`);
  assert(report.agents.length >= 1000, `expected the recorded agents to survive the throw, got ${report.agents.length}`);
});

await test("a script that throws still reports the agents that finished", async () => {
  const runner = stubRunner(() => "kept");
  const report = await run(
    `export const meta = { name: 't', description: 'd' }
     await agent('one')
     throw new Error('script blew up')`,
    { runner },
  );
  assert(/script blew up/.test(report.error ?? ""), `got ${report.error}`);
  assert(report.agents.length === 1 && report.agents[0].status === "ok", "the finished agent must survive the throw");
});

// ---- resume ----
await test("resume replays an unchanged prefix and re-runs from the first edit", async () => {
  const repoDir = makeRepo();
  const stateDir = tmp("under-wf-state-");
  const script = (third) => `export const meta = { name: 'res', description: 'd' }
     const a = await agent('first')
     const b = await agent('second')
     const c = await agent('${third}')
     return { a, b, c }`;

  const first = stubRunner(() => "v1");
  const one = await run(script("third"), { runner: first, repoDir, stateDir });
  assert(first.calls.length === 3, `expected 3 agents, got ${first.calls.length}`);

  const replayed = stubRunner(() => "v2");
  const two = await run(script("third"), {
    runner: replayed,
    repoDir,
    stateDir,
    resumeFromRunId: one.runId,
  });
  assert(replayed.calls.length === 0, `an unchanged script must spawn nothing, spawned ${replayed.calls.length}`);
  assert(two.value.c === "v1", "replayed values must come from the journal");

  const edited = stubRunner(() => "v3");
  const three = await run(script("third, but different"), {
    runner: edited,
    repoDir,
    stateDir,
    resumeFromRunId: one.runId,
  });
  assert(edited.calls.length === 1, `only the edited call should re-run, ran ${edited.calls.length}`);
  assert(three.value.a === "v1" && three.value.c === "v3", `got ${JSON.stringify(three.value)}`);
});

await test("resume survives the completion-order ids that pipeline() produces", async () => {
  const repoDir = makeRepo();
  const stateDir = tmp("under-wf-state-");
  // Two items, three stages, the first item slow: agent ids fall in completion
  // order, so they differ run to run. Keying resume on them re-ran everything.
  const script = `export const meta = { name: 'p', description: 'd' }
     return await pipeline(['slow', 'fast'],
       (item) => agent(item + ' one'),
       (_p, item) => agent(item + ' two'),
       (_p, item) => agent(item + ' three'))`;
  const delayed = () =>
    stubRunner(async (task) => {
      if (task.prompt.startsWith("slow")) await sleep(40);
      return "v:" + task.prompt;
    });

  const first = delayed();
  const one = await run(script, { runner: first, repoDir, stateDir });
  assert(first.calls.length === 6, `expected 6 agents, got ${first.calls.length}`);

  const second = delayed();
  const two = await run(script, { runner: second, repoDir, stateDir, resumeFromRunId: one.runId });
  assert(
    second.calls.length === 0,
    `an unchanged pipeline must replay entirely, but re-ran ${second.calls.length} of 6 agents`,
  );
  assert(JSON.stringify(two.value) === JSON.stringify(one.value), "replayed values diverged");
});

await test("resume retries a failed agent instead of replaying the failure", async () => {
  const repoDir = makeRepo();
  const stateDir = tmp("under-wf-state-");
  const script = `export const meta = { name: 'r', description: 'd' }
     const a = await agent('always works')
     const b = await agent('flaky one')
     return { a, b }`;

  // First run: the second agent dies, the way a timeout or a flat endpoint does.
  const failing = stubRunner((task) => (task.prompt.includes("flaky") ? "" : "ok"));
  const one = await run(script, { runner: failing, repoDir, stateDir });
  assert(one.value.b === null, "the flaky agent should have failed");

  // Resume: the healthy agent replays, the failed one is retried for real.
  const healthy = stubRunner(() => "ok");
  const two = await run(script, { runner: healthy, repoDir, stateDir, resumeFromRunId: one.runId });
  assert(
    healthy.calls.length === 1,
    `resume should retry only the failure, but ran ${healthy.calls.length} agents`,
  );
  assert(two.value.b === "ok", "resume replayed the failure instead of recovering the run");
});

await test("resuming a resumed run keeps the whole prefix", async () => {
  const repoDir = makeRepo();
  const stateDir = tmp("under-wf-state-");
  const script = `export const meta = { name: 'r', description: 'd' }
     return [await agent('one'), await agent('two')]`;

  const first = stubRunner(() => "v1");
  const a = await run(script, { runner: first, repoDir, stateDir });
  const second = stubRunner(() => "v2");
  const b = await run(script, { runner: second, repoDir, stateDir, resumeFromRunId: a.runId });
  assert(second.calls.length === 0, "the first resume should have replayed everything");
  // The second resume reads b's journal, which only exists if replayed entries
  // were carried into it.
  const third = stubRunner(() => "v3");
  const c = await run(script, { runner: third, repoDir, stateDir, resumeFromRunId: b.runId });
  assert(third.calls.length === 0, `resuming a resume re-ran ${third.calls.length} agents`);
  assert(JSON.stringify(c.value) === '["v1","v1"]', `values lost across two resumes: ${JSON.stringify(c.value)}`);
});

await test("resume does not replay another model's answers", async () => {
  const repoDir = makeRepo();
  const stateDir = tmp("under-wf-state-");
  const script = `export const meta = { name: 'm', description: 'd' }
     return await agent('ask')`;
  const first = stubRunner(() => "answered by model A");
  const a = await run(script, { runner: first, repoDir, stateDir, modelSalt: "-m provider/model-a" });

  const second = stubRunner(() => "answered by model B");
  const b = await run(script, {
    runner: second,
    repoDir,
    stateDir,
    resumeFromRunId: a.runId,
    modelSalt: "-m provider/model-b",
  });
  assert(second.calls.length === 1, "a different model must re-run, not replay");
  assert(b.value === "answered by model B", `replayed the wrong model's answer: ${b.value}`);
});

// ---- worktree isolation ----
await test("an isolated agent that changes nothing leaves no branch behind", async () => {
  const repoDir = makeRepo();
  const runner = stubRunner(() => "looked, changed nothing");
  const report = await run(
    `export const meta = { name: 'w', description: 'd' }
     return await agent('look around', { isolation: 'worktree' })`,
    { runner, repoDir },
  );
  assert(report.branches.length === 0, `expected no branches, got ${report.branches.join(", ")}`);
  assert(git(["branch", "--list"], repoDir).replace(/[* ]/g, "") === "main", git(["branch", "--list"], repoDir));
});

await test("an isolated agent's work is committed on its own branch", async () => {
  const repoDir = makeRepo();
  const runner = stubRunner((task) => {
    writeFileSync(join(task.cwd, "made.txt"), "by the agent\n");
    return "wrote the file";
  });
  const report = await run(
    `export const meta = { name: 'w', description: 'd' }
     return await agent('write a file', { isolation: 'worktree', label: 'writer' })`,
    { runner, repoDir },
  );
  assert(report.branches.length === 1, `expected one branch, got ${report.branches.length}`);
  const branch = report.branches[0];
  assert(git(["show", `${branch}:made.txt`], repoDir) === "by the agent", "the work is not on the branch");
  assert(!existsSync(join(repoDir, "made.txt")), "an isolated agent must not touch the main tree");
  assert(report.agents[0].committed, "the commit should be recorded");
});

// ---- W3: a commit that fails must not be reported as success ----
// A pre-commit hook exiting 1 is the ordinary trigger — husky, lint-staged,
// gitleaks — as is a missing committer identity or commit.gpgsign with no key
// in a headless run. `settleWorktree()` used to stash the error on the record
// and fall through to removeWorktree(--force) + deleteBranch(--force), then the
// caller called finish("ok"): work destroyed, script handed the agent's prose
// as a successful answer, report silent (only failed agents print errors), and
// the journal recorded ok so --resume replayed the success forever.
function blockCommits(repoDir) {
  const hooks = join(repoDir, ".githooks");
  mkdirSync(hooks, { recursive: true });
  const hook = join(hooks, "pre-commit");
  writeFileSync(hook, "#!/bin/sh\necho 'pre-commit says no' >&2\nexit 1\n");
  chmodSync(hook, 0o755);
  git(["config", "core.hooksPath", hooks], repoDir);
}

await test("W3 an agent whose work cannot be committed is failed, not ok", async () => {
  const repoDir = makeRepo();
  blockCommits(repoDir);
  const runner = stubRunner((task) => {
    writeFileSync(join(task.cwd, "work.txt"), "expensive\n");
    return "I fixed the off-by-one in fix.js";
  });
  const report = await run(
    `export const meta = { name: 'w', description: 'd' }
     return await agent('do the work', { isolation: 'worktree', label: 'doomed' })`,
    { runner, repoDir },
  );
  const a = report.agents[0];
  assert(a.status === "failed", `expected failed, got ${a.status}`);
  assert(/could not commit/.test(a.error ?? ""), `error should name the commit failure, got ${a.error}`);
});

await test("W3 the uncommittable work is preserved and its path is reported", async () => {
  const repoDir = makeRepo();
  blockCommits(repoDir);
  const runner = stubRunner((task) => {
    writeFileSync(join(task.cwd, "work.txt"), "expensive\n");
    return "done";
  });
  const report = await run(
    `export const meta = { name: 'w', description: 'd' }
     return await agent('do the work', { isolation: 'worktree', label: 'doomed' })`,
    { runner, repoDir },
  );
  const a = report.agents[0];
  assert(a.worktree, "the preserved worktree path must be in the record");
  assert(existsSync(a.worktree), `report names ${a.worktree} but it was deleted`);
  assert(
    readFileSync(join(a.worktree, "work.txt"), "utf8") === "expensive\n",
    "the agent's work was destroyed",
  );
});

await test("W3 a failed commit is not journalled, so --resume retries it", async () => {
  const repoDir = makeRepo();
  blockCommits(repoDir);
  const runner = stubRunner((task) => {
    writeFileSync(join(task.cwd, "work.txt"), "expensive\n");
    return "done";
  });
  // Two agents on purpose. The read-only one commits nothing, so it succeeds and
  // IS journalled — without it the run journals nothing at all and the resume
  // refuses for want of a file, testing the wrong thing entirely.
  const script = `export const meta = { name: 'w', description: 'd' }
     const a = await agent('survey')
     const b = await agent('do the work', { isolation: 'worktree', label: 'doomed' })
     return [a, b]`;
  // A shared stateDir and `resumeFromRunId` — the real option names. Passing a
  // `resume:` the runner ignores makes this test pass against the bug it exists
  // to catch, which is the failure mode this whole suite is here to prevent.
  const stateDir = tmp("under-wf-state-");
  const first = await run(script, { runner, repoDir, stateDir });
  const runner2 = stubRunner((task) => {
    writeFileSync(join(task.cwd, "work.txt"), "expensive\n");
    return "done";
  });
  await run(script, { runner: runner2, repoDir, stateDir, resumeFromRunId: first.runId });
  // The survivor replays from the journal (0 calls); the uncommittable one must
  // be re-run (1 call). Journalled as "ok", it would replay too and never retry.
  assert(
    runner2.calls.length === 1,
    `a failed commit must be retried on resume, not replayed (${runner2.calls.length} runner calls)`,
  );
});

await test("isolated agents get write tools and shared ones do not", async () => {
  const repoDir = makeRepo();
  const runner = stubRunner(() => "ok");
  await run(
    `export const meta = { name: 'w', description: 'd' }
     await agent('read only')
     await agent('may write', { isolation: 'worktree' })`,
    { runner, repoDir },
  );
  const toolsOf = (call) => call.args[call.args.indexOf("--tools") + 1].split(",");
  assert(!toolsOf(runner.calls[0]).includes("write"), "a shared-tree agent must not get write");
  assert(!toolsOf(runner.calls[0]).includes("bash"), "a shared-tree agent must not get bash");
  assert(toolsOf(runner.calls[1]).includes("write"), "an isolated agent should be able to write");
});

await test("a worktree that cannot be created fails one agent, not the run", async () => {
  const repoDir = makeRepo();
  // Block worktree creation for certain: a regular file where the worktree
  // parent directory must go makes `git worktree add` fail for every path
  // under it. This is the shape of a stale or unwritable .underclass.
  writeFileSync(join(repoDir, ".underclass"), "not a directory\n");

  const runner = stubRunner(() => "ok");
  const report = await run(
    `export const meta = { name: 'w', description: 'd' }
     const first = await agent('one', { isolation: 'worktree', label: 'blocked' })
     const second = await agent('two')
     return { first, second }`,
    { runner, repoDir, stateDir: tmp("under-wf-state-") },
  );
  assert(!report.error, `the run must not be aborted by one agent's worktree: ${report.error}`);
  assert(report.agents.length === 2, `expected 2 records, got ${report.agents.length}`);
  assert(report.agents[0].status === "failed", "the isolated agent should be recorded failed");
  assert(report.value.first === null, "a failed agent returns null");
  assert(report.value.second === "ok", "the agent after a worktree failure must still run");
  assert(runner.calls.length === 1, "the blocked agent must not have been spawned");
});

await test("concurrent runs in one repo do not collide on worktree paths", async () => {
  const repoDir = makeRepo();
  const script = `export const meta = { name: 'w', description: 'd' }
     return await agent('write', { isolation: 'worktree', label: 'same-label' })`;
  const mk = () =>
    stubRunner(async (task) => {
      await sleep(60);
      writeFileSync(join(task.cwd, "out.txt"), "x\n");
      return "wrote";
    });
  const [a, b] = await Promise.all([
    run(script, { runner: mk(), repoDir }),
    run(script, { runner: mk(), repoDir }),
  ]);
  for (const [name, r] of [["first", a], ["second", b]]) {
    assert(!r.error, `${name} run errored: ${r.error}`);
    assert(r.agents[0].status === "ok", `${name} run's agent failed: ${r.agents[0].error}`);
    assert(r.branches.length === 1, `${name} run should have kept its branch`);
  }
  assert(a.branches[0] !== b.branches[0], "the two runs must not share a branch");
});

await test("a per-agent hard timeout is passed to the child", async () => {
  const repoDir = makeRepo();
  const runner = stubRunner(() => "ok");
  await run(
    `export const meta = { name: 't', description: 'd' }
     await agent('quick', { timeoutSec: 30 })`,
    { runner, repoDir },
  );
  const call = runner.calls[0];
  assert(call.args.includes("--timeout"), "the soft in-session timeout should be forwarded");
  assert(
    call.timeoutMs > 30_000,
    `the hard kill must sit above the soft timeout, got ${call.timeoutMs}`,
  );
});

await test("a wedged child is killed instead of holding its slot forever", async () => {
  const dir = tmp("under-wf-wedge-");
  const entry = join(dir, "wedged.mjs");
  // Never writes, never exits — a child stuck before its session ever exists.
  writeFileSync(entry, "setInterval(() => {}, 1000);\n");
  const started = Date.now();
  const err = await createWorkflowRunner({ entry })
    .run({ prompt: "x", cwd: dir, branch: "b", timeoutMs: 700 })
    .then(() => null, (e) => e);
  assert(err && /timed out after/.test(err.message), `expected a timeout, got ${err && err.message}`);
  assert(Date.now() - started < 5000, "the per-task timeout did not fire promptly");
});

// ---- the recursion guard, end to end through the real CLI ----
await test("workflow children are marked so they cannot orchestrate", async () => {
  const repoDir = makeRepo();
  const runner = stubRunner(() => "ok");
  await run(
    `export const meta = { name: 'g', description: 'd' }
     await agent('anything')`,
    { runner, repoDir },
  );
  const env = runner.calls[0].env;
  assert(env.UNDER_WORKFLOW_DEPTH === "1", `child not marked: ${JSON.stringify(env)}`);
  assert(env.UNDER_FANOUT_DEPTH === "1", "a workflow child must not get fan_out either");
  assert(/#1$/.test(env.UNDER_RUN_TAG ?? ""), `expected a per-agent telemetry tag, got ${env.UNDER_RUN_TAG}`);
});

await test("createWorkflowRunner spawns children below top level", async () => {
  const dir = tmp("under-wf-depth-");
  const probe = join(dir, "probe.mjs");
  writeFileSync(
    probe,
    'console.log(JSON.stringify({ wf: process.env.UNDER_WORKFLOW_DEPTH ?? null, fan: process.env.UNDER_FANOUT_DEPTH ?? null }));\n',
  );
  const out = await createWorkflowRunner({ entry: probe }).run({ prompt: "x", cwd: dir, branch: "b" });
  const seen = JSON.parse(out.text);
  assert(seen.wf === "1" && seen.fan === "1", `child was not gated: ${out.text}`);
});

await test("under workflow refuses to nest", async () => {
  const repoDir = makeRepo();
  const script = join(repoDir, "wf.mjs");
  writeFileSync(script, "export const meta = { name: 'n', description: 'd' }\nreturn 1\n");
  const entry = new URL("index.js", distUrl).pathname;
  const res = await new Promise((resolve) => {
    const p = spawn(process.execPath, [entry, "workflow", script, "--dry-run"], {
      cwd: repoDir,
      env: { ...process.env, UNDER_WORKFLOW_DEPTH: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    p.stdout.on("data", (c) => (out += c));
    p.stderr.on("data", (c) => (out += c));
    p.on("exit", (code) => resolve({ code, out }));
  });
  assert(res.code === 1, `expected a refusal, exited ${res.code}: ${res.out}`);
  assert(/nested orchestration is not supported/.test(res.out), `unexpected message: ${res.out}`);
});

// ---- the runner contract the whole layer rests on ----
await test("the runner returns stdout as data and keeps stderr out of it", async () => {
  const dir = tmp("under-wf-io-");
  const entry = join(dir, "agent.mjs");
  writeFileSync(
    entry,
    'process.stderr.write("[read] tool noise\\n");\nprocess.stdout.write("the answer");\nprocess.stderr.write("more noise\\n");\n',
  );
  const out = await createWorkflowRunner({ entry }).run({ prompt: "x", cwd: dir, branch: "b" });
  assert(out.text === "the answer", `stdout was polluted: ${JSON.stringify(out.text)}`);
  assert(/tool noise/.test(out.stderr), "stderr should still be captured for diagnostics");
});

await test("a failed agent reports its diagnosis, not its whole stderr", async () => {
  const dir = tmp("under-wf-noise-");
  const entry = join(dir, "noisy.mjs");
  // A real failing agent's tail is mostly dim-coloured progress chatter, with
  // the actual cause on the last line.
  writeFileSync(
    entry,
    'for (let i = 0; i < 300; i++) process.stderr.write("\\x1b[2m[read] chatter line " + i + "\\x1b[0m\\n");\n' +
      'process.stderr.write("under: aborting after 240s (--timeout)\\n");\n' +
      "process.exit(1);\n",
  );
  const err = await createWorkflowRunner({ entry })
    .run({ prompt: "x", cwd: dir, branch: "b" })
    .then(() => null, (e) => e);
  assert(err, "expected a rejection");
  assert(/aborting after 240s/.test(err.message), `the cause is missing: ${err.message}`);
  assert(!/\x1b\[/.test(err.message), "escape codes must not reach the error message");
  assert(err.message.length < 500, `the message is a stderr dump (${err.message.length} chars)`);
  assert(!/chatter line 1\b/.test(err.message), "the message should not carry the whole tail");
});

await test("a large answer written just before exit is not truncated", async () => {
  const dir = tmp("under-wf-big-");
  const entry = join(dir, "agent.mjs");
  // Write a lot and exit immediately: 'exit' fires long before these pipes drain.
  writeFileSync(entry, 'process.stdout.write("x".repeat(400000));\n');
  const out = await createWorkflowRunner({ entry }).run({ prompt: "x", cwd: dir, branch: "b" });
  assert(out.text.length === 400000, `answer truncated to ${out.text.length} chars`);
});

await test("--resume with an unknown run id refuses instead of silently re-running", async () => {
  const runner = stubRunner(() => "should never spawn");
  const err = await run(
    `export const meta = { name: 'r', description: 'd' }
     return await agent('ask')`,
    { runner, stateDir: tmp("under-wf-state-"), resumeFromRunId: "wfDOESNOTEXIST" },
  ).then(
    () => null,
    (e) => e,
  );
  assert(err && /cannot resume 'wfDOESNOTEXIST'/.test(err.message), `expected a refusal, got ${err && err.message}`);
  assert(runner.calls.length === 0, "a refused resume must not have started re-paying for the run");
});

await test("an unserializable script return degrades the value, not the report", async () => {
  const repoDir = makeRepo();
  const script = join(repoDir, "wf.mjs");
  // Zero agent calls, so the real CLI path runs with no model anywhere.
  writeFileSync(
    script,
    "export const meta = { name: 'circ', description: 'd' }\nconst a = { name: 'x' }\na.self = a\nreturn a\n",
  );
  const entry = new URL("index.js", distUrl).pathname;
  const res = await new Promise((resolve) => {
    const p = spawn(process.execPath, [entry, "workflow", script, "--json"], {
      cwd: repoDir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let errOut = "";
    p.stdout.on("data", (c) => (out += c));
    p.stderr.on("data", (c) => (errOut += c));
    p.on("exit", (code) => resolve({ code, out, errOut }));
  });
  // The run succeeded; a return value stringify must not turn that into exit 1
  // with an empty stdout and no runId to resume from.
  assert(res.code === 0, `exited ${res.code}: ${res.errOut.slice(-300)}`);
  const report = JSON.parse(res.out);
  assert(/unserializable/.test(String(report.value)), `value not degraded: ${String(report.value).slice(0, 80)}`);
  assert(typeof report.runId === "string" && report.runId.length > 0, "the runId must survive");
});

// ---- the shipped workflows must actually run, not merely parse ----
// extractMeta only reads the header, so a built-in can list and dry-run
// perfectly while its body throws on the first hook call.
const builtinSource = (name) =>
  readFileSync(new URL(`workflows/${name}.mjs`, distUrl), "utf8");

await test("the built-in review workflow runs end to end", async () => {
  const runner = stubRunner((task) => {
    if (task.prompt.includes("git diff")) return "src/a.ts changed: the guard was inverted";
    if (task.prompt.includes("REFUTE")) return '{"refuted": false, "reason": "the claim holds"}';
    return '{"findings":[{"file":"src/a.ts","line":10,"claim":"inverted guard","why_it_breaks":"skips the check"}]}';
  });
  const report = await run(builtinSource("review"), { runner, concurrency: 3 });
  assert(!report.error, `review threw: ${report.error}`);
  assert(report.value.findings.length === 3, `expected one surviving finding per lens, got ${report.value.findings.length}`);
  assert(report.value.findings[0].verdict.refuted === false, "a surviving finding must carry its verdict");
  assert(report.agents.every((a) => a.status === "ok"), "no agent should have failed");
});

await test("a failed survey is not reported as a clean review", async () => {
  const runner = stubRunner(() => "");
  const report = await run(builtinSource("review"), { runner });
  assert(!report.error, `review threw: ${report.error}`);
  assert(report.value.findings.length === 0, "a failed survey can produce no findings");
  assert(
    /not a clean review/.test(report.value.note ?? ""),
    `a dead survey must not read as "no problems found": ${report.value.note}`,
  );
});

await test("the built-in review workflow stops early on an empty diff", async () => {
  const runner = stubRunner(() => "NO_CHANGES_TO_REVIEW");
  const report = await run(builtinSource("review"), { runner });
  assert(!report.error, `review threw: ${report.error}`);
  assert(report.value.findings.length === 0, "an empty diff should produce no findings");
  assert(runner.calls.length === 1, `only the survey should run, ran ${runner.calls.length}`);
});

await test("a survey that merely mentions the sentinel does not abort the review", async () => {
  const runner = stubRunner((task) => {
    if (task.prompt.includes("git diff")) {
      // The phrase appears inside a real summary — an unanchored substring test
      // would silently skip the entire review here.
      return 'src/a.ts changed. The old code replied NO_CHANGES_TO_REVIEW when the diff was empty.';
    }
    if (task.prompt.includes("REFUTE")) return '{"refuted": false, "reason": "holds"}';
    return '{"findings":[{"file":"src/a.ts","claim":"c","why_it_breaks":"w"}]}';
  });
  const report = await run(builtinSource("review"), { runner, concurrency: 3 });
  assert(!report.error, `review threw: ${report.error}`);
  assert(report.value.findings.length > 0, "the review was skipped by a sentinel mentioned in prose");
});

await test("a review where every reviewer died is not reported as clean", async () => {
  const runner = stubRunner((task) => (task.prompt.includes("git diff") ? "src/a.ts changed" : ""));
  const report = await run(builtinSource("review"), { runner, concurrency: 3 });
  assert(!report.error, `review threw: ${report.error}`);
  assert(report.value.findings.length === 0, "dead reviewers can produce no findings");
  assert(
    /not a clean review/.test(report.value.note ?? ""),
    `three dead reviewers must not read as "no problems found": ${report.value.note}`,
  );
});

await test("the built-in review workflow grants a shell only to the survey", async () => {
  const runner = stubRunner((task) => {
    if (task.prompt.includes("git diff")) return "something changed";
    if (task.prompt.includes("REFUTE")) return '{"refuted": true, "reason": "no"}';
    return '{"findings":[{"file":"a.ts","claim":"c","why_it_breaks":"w"}]}';
  });
  await run(builtinSource("review"), { runner, concurrency: 2 });
  const toolsOf = (c) => c.args[c.args.indexOf("--tools") + 1].split(",");
  assert(toolsOf(runner.calls[0]).includes("bash"), "the survey needs a shell to ask git what changed");
  for (const call of runner.calls.slice(1)) {
    assert(!toolsOf(call).includes("bash"), `a reviewer was handed a shell: ${call.prompt.slice(0, 40)}`);
    assert(!toolsOf(call).includes("write"), "a reviewer must not be able to write");
  }
});

await test("the built-in understand workflow runs end to end", async () => {
  const runner = stubRunner((task) => {
    if (task.prompt.includes("Survey this repository")) {
      return '{"areas":[{"name":"core","paths":["src/"],"why":"the engine"},{"name":"cli","paths":["bin/"],"why":"entry"}]}';
    }
    if (task.prompt.includes("Merge their reports")) return "# The map\ncore drives cli.";
    return "this area does X";
  });
  const report = await run(builtinSource("understand"), {
    runner,
    args: { question: "how does routing work?", maxAreas: 2 },
  });
  assert(!report.error, `understand threw: ${report.error}`);
  assert(report.value.areas.length === 2, `expected 2 areas read, got ${report.value.areas.length}`);
  assert(/The map/.test(report.value.map ?? ""), `expected a synthesised map, got ${report.value.map}`);
  assert(runner.calls.some((c) => c.prompt.includes("how does routing work?")), "the question should reach the readers");
});

await test("the built-in understand workflow survives a failed survey", async () => {
  const runner = stubRunner(() => "not json, so the schema never matches");
  const report = await run(builtinSource("understand"), { runner });
  assert(!report.error, `understand threw instead of degrading: ${report.error}`);
  assert(report.value.map === null, "with no areas there is nothing to map");
});

// ---- the documented example must be a working example ----
await test("the workflow example in README.md actually runs", async () => {
  const readmePath = new URL("../../../README.md", import.meta.url);
  let readme;
  try {
    readme = readFileSync(readmePath, "utf8");
  } catch {
    return; // a packed tarball has no README at that path; nothing to check
  }
  const match = readme.match(/```js\n(export const meta = \{\n  name: 'review',[\s\S]*?)```/);
  assert(match, "the README's workflow example is gone or its fence changed — update this test or the docs");

  const runner = stubRunner((task) =>
    task.prompt.includes("refute")
      ? `{"refuted": ${task.prompt.includes("bug two")}}`
      : '{"bugs":["bug one","bug two"]}',
  );
  const report = await run(match[1], { runner, concurrency: 2 });
  assert(!report.error, `the documented example throws: ${report.error}`);
  assert(report.agents.length === 3, `expected 1 finder + 2 verifiers, got ${report.agents.length}`);
  assert(
    JSON.stringify(report.value) === '["bug one"]',
    `the example does not do what the README says it does: ${JSON.stringify(report.value)}`,
  );
});

for (const dir of temps) rmSync(dir, { recursive: true, force: true });
const failed = results.filter(([ok]) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
