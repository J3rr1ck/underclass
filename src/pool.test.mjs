// Endpoint pool suite: pure parsing and load accounting, no processes, no model.
//   node packages/under/src/pool.test.mjs
// Runs against packages/under/dist (build first); UNDER_DIST overrides that.
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const distUrl = process.env.UNDER_DIST
  ? pathToFileURL(join(process.env.UNDER_DIST, "/"))
  : new URL("../dist/", import.meta.url);
let parsePoolSpec, EndpointPool;
try {
  ({ parsePoolSpec, EndpointPool } = await import(new URL("workflow/pool.js", distUrl).href));
} catch (err) {
  console.error(`cannot load the endpoint pool from ${distUrl}: ${err.message}\nBuild first (npm run build).`);
  process.exit(2);
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
/** Assert fn throws and the message carries `needle` — specs must appear in their own errors. */
function assertThrows(fn, needle) {
  try {
    fn();
  } catch (err) {
    assert(String(err.message).includes(needle), `error '${err.message}' does not mention '${needle}'`);
    return;
  }
  throw new Error(`expected a throw mentioning '${needle}', got none`);
}

// ---- parsePoolSpec ----

await test("parsePoolSpec: bare spec", () => {
  const e = parsePoolSpec("lmstudio/gemma-4-12b");
  assert(e.label === "lmstudio/gemma-4-12b", `label: ${e.label}`);
  assert(JSON.stringify(e.args) === '["-m","lmstudio/gemma-4-12b"]', `args: ${JSON.stringify(e.args)}`);
  assert(e.weight === 1, `weight: ${e.weight}`);
});

// A spec with a base URL must resolve as `custom` — a known-provider prefix
// would win the child's model resolution and silently route every completion
// to that provider's own endpoint instead of the named URL. Reproduced live
// before the rewrite: the pool "spread" load while all of it hit one server.
await test("parsePoolSpec: spec@url is rewritten to the custom provider", () => {
  const e = parsePoolSpec("lmstudio/gemma-4-12b@http://gpu-box.local:1234/v1");
  assert(e.label === "gemma-4-12b", `label: ${e.label}`);
  assert(
    JSON.stringify(e.args) === '["-m","custom/gemma-4-12b","--base-url","http://gpu-box.local:1234/v1"]',
    `args: ${JSON.stringify(e.args)}`,
  );
  assert(e.weight === 1, `weight: ${e.weight}`);
});

await test("parsePoolSpec: @url with no provider prefix keeps the whole model id", () => {
  const e = parsePoolSpec("dealignai/MiniMax-M2.7@http://gpu-box.local:8000/v1");
  assert(e.label === "dealignai/MiniMax-M2.7", `label: ${e.label}`);
  assert(
    JSON.stringify(e.args) === '["-m","custom/dealignai/MiniMax-M2.7","--base-url","http://gpu-box.local:8000/v1"]',
    `args: ${JSON.stringify(e.args)}`,
  );
});

await test("parsePoolSpec: a provider prefix alone with @url is rejected", () => {
  let threw = false;
  try {
    parsePoolSpec("lmstudio/@http://x/v1");
  } catch (err) {
    threw = /provider prefix alone/.test(err.message);
  }
  assert(threw, "expected a rejection naming the problem");
});

await test("parsePoolSpec: spec*2", () => {
  const e = parsePoolSpec("vmlx/minimax*2");
  assert(e.label === "vmlx/minimax", `label: ${e.label}`);
  assert(JSON.stringify(e.args) === '["-m","vmlx/minimax"]', `args: ${JSON.stringify(e.args)}`);
  assert(e.weight === 2, `weight: ${e.weight}`);
});

await test("parsePoolSpec: spec@url*3", () => {
  const e = parsePoolSpec("vmlx/minimax@http://gpu-box.local:8000/v1*3");
  assert(e.label === "vmlx/minimax", `label: ${e.label}`);
  assert(
    JSON.stringify(e.args) === '["-m","custom/vmlx/minimax","--base-url","http://gpu-box.local:8000/v1"]',
    `args: ${JSON.stringify(e.args)}`,
  );
  assert(e.weight === 3, `weight: ${e.weight}`);
});

await test("parsePoolSpec: tolerates whitespace around every separator", () => {
  const e = parsePoolSpec("  lmstudio/gemma-4-12b @ http://gpu-box.local:1234/v1 * 3  ");
  assert(e.label === "gemma-4-12b", `label: ${e.label}`);
  assert(
    JSON.stringify(e.args) === '["-m","custom/gemma-4-12b","--base-url","http://gpu-box.local:1234/v1"]',
    `args: ${JSON.stringify(e.args)}`,
  );
  assert(e.weight === 3, `weight: ${e.weight}`);
});

await test("parsePoolSpec: model containing '/' parses with @url*2", () => {
  const e = parsePoolSpec("lmstudio/google/gemma-4-26b@http://gpu-box.local:1234/v1*2");
  assert(e.label === "google/gemma-4-26b", `label: ${e.label}`);
  assert(
    JSON.stringify(e.args) === '["-m","custom/google/gemma-4-26b","--base-url","http://gpu-box.local:1234/v1"]',
    `args: ${JSON.stringify(e.args)}`,
  );
  assert(e.weight === 2, `weight: ${e.weight}`);
});

await test("parsePoolSpec: rejects weight 0", () => {
  assertThrows(() => parsePoolSpec("lmstudio/gemma*0"), "lmstudio/gemma*0");
});

await test("parsePoolSpec: rejects a non-numeric weight", () => {
  assertThrows(() => parsePoolSpec("lmstudio/gemma*x"), "lmstudio/gemma*x");
});

await test("parsePoolSpec: rejects an empty spec", () => {
  assertThrows(() => parsePoolSpec("   "), "empty model spec");
});

await test("parsePoolSpec: rejects a base URL not starting with http", () => {
  assertThrows(() => parsePoolSpec("lmstudio/gemma@ftp://gpu-box.local"), "lmstudio/gemma@ftp://gpu-box.local");
});

// ---- EndpointPool ----

await test("EndpointPool: constructor rejects an empty pool", () => {
  assertThrows(() => new EndpointPool([]), "at least one entry");
});

await test("EndpointPool: least-loaded alternates across equal entries and release returns capacity", () => {
  const A = parsePoolSpec("a/one");
  const B = parsePoolSpec("b/two");
  const pool = new EndpointPool([A, B]);
  const first = pool.pick();
  assert(first.entry.label === "a/one", `first pick: ${first.entry.label}`);
  const second = pool.pick();
  assert(second.entry.label === "b/two", `second pick: ${second.entry.label}`);
  assert(JSON.stringify(pool.counts()) === "[1,1]", `counts: ${JSON.stringify(pool.counts())}`);
  // Freeing A makes it the least loaded again, so the next pick goes there.
  first.release();
  assert(JSON.stringify(pool.counts()) === "[0,1]", `counts after release: ${JSON.stringify(pool.counts())}`);
  const third = pool.pick();
  assert(third.entry.label === "a/one", `pick after release: ${third.entry.label}`);
});

await test("EndpointPool: double release does not drive the count negative", () => {
  const pool = new EndpointPool([parsePoolSpec("a/one"), parsePoolSpec("b/two")]);
  const { release } = pool.pick();
  release();
  release();
  assert(JSON.stringify(pool.counts()) === "[0,0]", `counts: ${JSON.stringify(pool.counts())}`);
});

await test("EndpointPool: a weight-3 entry absorbs 3 of 4 picks", () => {
  const pool = new EndpointPool([parsePoolSpec("fast/model*3"), parsePoolSpec("slow/model*1")]);
  for (let i = 0; i < 4; i++) pool.pick();
  assert(JSON.stringify(pool.counts()) === "[3,1]", `counts: ${JSON.stringify(pool.counts())}`);
});

await test("EndpointPool: equal load ties break to the first-listed entry", () => {
  const pool = new EndpointPool([parsePoolSpec("a/one"), parsePoolSpec("b/two"), parsePoolSpec("c/three")]);
  const { entry } = pool.pick();
  assert(entry.label === "a/one", `tie-break pick: ${entry.label}`);
});

const failed = results.filter(([ok]) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
