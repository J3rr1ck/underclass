/**
 * Context-window accounting: the guard that would have caught UNDER-36.
 *
 * pi computes `max_completion_tokens = min(maxTokens, max(1, ctx - prompt -
 * 4096))`. An under-declared window therefore collapses generation to ONE
 * token: the model emits it, stops with `finish_reason: "length"`, calls no
 * tool — and the run is recorded as a success with exit 0. That defect shipped
 * once already and was found only by proxy-logging the wire, which no user and
 * no benchmark will ever do.
 *
 * The first test here is the important one: it drives **pi's own**
 * `clampMaxTokensToContext` out of node_modules and asserts our reimplementation
 * agrees. This repo has now shipped two guards written against an assumed SDK
 * shape (UNDER-3's TokenTracker, UNDER-37's detectSilentNoOp), both wrong from
 * the first commit. A copy of someone else's formula is exactly that hazard, so
 * it is pinned to the original rather than to a comment describing it.
 *
 * Run: node packages/under/src/config.test.mjs   (needs a build)
 */
import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "dist");
if (!existsSync(join(dist, "config.js"))) {
  console.error("build first: npm run build");
  process.exit(2);
}
const {
  generationBudget,
  contextTooSmall,
  contextTooTight,
  PI_CONTEXT_SAFETY_TOKENS,
  MEASURED_MIN_PROMPT_TOKENS,
  MIN_USABLE_GENERATION,
} = await import(join(dist, "config.js"));

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try {
    fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL ${name}\n       ${e.message.split("\n")[0]}`);
  }
};

// Locate pi's real clamp. Skipping is correct if the internal path moves — but
// it must be loud, because a silently skipped equivalence check is worse than
// no check at all.
let piClamp = null;
// pi-ai is a nested dependency of pi-coding-agent, not a top-level one.
const PI_AI = join("@earendil-works", "pi-coding-agent", "node_modules", "@earendil-works", "pi-ai", "dist", "api", "simple-options.js");
for (const p of [
  join(here, "..", "..", "..", "node_modules", PI_AI),
  join(here, "..", "node_modules", PI_AI),
  join(here, "..", "..", "..", "node_modules", "@earendil-works", "pi-ai", "dist", "api", "simple-options.js"),
]) {
  if (existsSync(p)) {
    ({ clampMaxTokensToContext: piClamp } = await import(p));
    break;
  }
}

if (!piClamp) {
  console.log("  WARN pi-ai/dist/api/simple-options.js not found — the equivalence check did NOT run");
} else {
  t("generationBudget matches pi's own clampMaxTokensToContext", () => {
    // pi measures the prompt with estimateContextTokens(context); feed it a
    // context whose token estimate we can compare against, by asking pi itself.
    for (const ctx of [0, 4096, 8192, 16384, 32768, 131072]) {
      for (const maxTokens of [1024, 4096, 8192]) {
        // An empty context isolates the arithmetic from the estimator.
        const theirs = piClamp({ contextWindow: ctx }, [], maxTokens);
        const ours = generationBudget(ctx, 0, maxTokens);
        assert.equal(ours, theirs, `ctx=${ctx} maxTokens=${maxTokens}: ours=${ours} pi=${theirs}`);
      }
    }
  });

  t("pi reserves exactly the constant we assume", () => {
    // If pi's CONTEXT_SAFETY_TOKENS ever changes, every threshold below moves.
    const ctx = 32768;
    const theirs = piClamp({ contextWindow: ctx }, [], 1_000_000);
    assert.equal(theirs, ctx - PI_CONTEXT_SAFETY_TOKENS, "pi's safety reserve is no longer 4096");
  });
}

t("the collapse-to-1 table reproduces", () => {
  // Prompt sizes from this repo's telemetry: tokensIn ~= 3187 + 4778 * toolCalls.
  assert.equal(generationBudget(4096, 3187, 4096), 1, "4096 must collapse on turn 0");
  assert.equal(generationBudget(8192, 3187, 4096), 909);
  assert.equal(generationBudget(8192, 7965, 4096), 1, "8192 must collapse by turn 1");
  assert.equal(generationBudget(16384, 12743, 4096), 1);
  assert.equal(generationBudget(32768, 12743, 4096), 4096);
});

t("a window that cannot survive turn 0 is refused", () => {
  const msg = contextTooSmall("ollama/llama3", 4096, 4096);
  assert.ok(msg, "4096 must be refused");
  assert.match(msg, /4096-token context window/);
  assert.match(msg, /servedContext/, "the message must name the fix");
});

t("a window that survives turn 0 but not turn 2 warns, and does not refuse", () => {
  // This is UNKNOWN_CONTEXT, i.e. the shipped default when nothing reports a
  // window. Refusing it would break single-turn runs that genuinely work.
  assert.equal(contextTooSmall("ollama/x", 8192, 4096), null, "8192 must not be a hard refusal");
  const warn = contextTooTight("ollama/x", 8192, 4096);
  assert.ok(warn, "8192 must warn");
  assert.match(warn, /turn 2/);
});

t("a real window is neither refused nor warned", () => {
  for (const ctx of [32768, 131072, 262144]) {
    assert.equal(contextTooSmall("lmstudio/x", ctx, 4096), null, `${ctx} refused`);
    assert.equal(contextTooTight("lmstudio/x", ctx, 4096), null, `${ctx} warned`);
  }
});

t("the two tiers never both fire", () => {
  for (let ctx = 0; ctx <= 40000; ctx += 512) {
    const e = contextTooSmall("x/y", ctx, 4096);
    const w = contextTooTight("x/y", ctx, 4096);
    assert.ok(!(e && w), `ctx=${ctx} produced both a refusal and a warning`);
  }
});

t("an undeclared window (0) mirrors pi's unclamped path and is not refused", () => {
  // Asserting what is TRUE, not what would be nice. `contextWindow <= 0` makes
  // pi skip the clamp entirely and send maxTokens as-is, so there is no
  // collapse-to-1 to guard against and refusing would be wrong. The exposure
  // that remains is different in kind — an unbounded request to a server that
  // may accept less — and belongs to endpoint validation, not to this check.
  assert.equal(generationBudget(0, 99999, 4096), 4096, "ctx<=0 must mirror pi's unclamped path");
  assert.equal(contextTooSmall("custom/unknown", 0, 4096), null, "an unclamped path must not be refused here");
  assert.equal(contextTooTight("custom/unknown", 0, 4096), null);
});

t("the guard's own constants are self-consistent", () => {
  // If the measured floor ever exceeds what a window must supply, the refusal
  // threshold moves silently. Pin the relationship, not the numbers.
  const minWorkable = MEASURED_MIN_PROMPT_TOKENS + PI_CONTEXT_SAFETY_TOKENS + MIN_USABLE_GENERATION;
  assert.equal(contextTooSmall("x/y", minWorkable, 4096), null, `${minWorkable} should be the first allowed window`);
  assert.ok(contextTooSmall("x/y", minWorkable - 1, 4096), `${minWorkable - 1} should be refused`);
});

console.log(`config: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
