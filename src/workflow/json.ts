import type { TSchema } from "typebox";
import { Value } from "typebox/value";

/**
 * Getting structured data back out of a small local model.
 *
 * There is no `response_format` or forced tool call to lean on here — the SDK
 * exposes neither, and the endpoints under targets vary in what they honour
 * anyway. So the contract is prompt-side and the parsing has to absorb what
 * models actually do: fence the object, narrate before it, apologise after it,
 * or answer with a number where a string was asked for.
 *
 * The order matters. Extraction is deliberately generous and validation is
 * strict, because a wrong-but-parseable answer that silently satisfies a schema
 * is worse than a retry.
 */

/** The instruction block appended to a prompt when the caller wants JSON back. */
export function answerContract(schema: TSchema): string {
  return [
    "## Required answer format",
    "",
    "Do the work first. Then end your reply with ONE JSON object and nothing after it.",
    "No commentary following it, no explanation of the JSON, no second object.",
    "",
    "It must satisfy this JSON Schema:",
    "",
    "```json",
    JSON.stringify(schema, null, 2),
    "```",
    "",
    "Properties the schema does not mention are discarded, so do not invent extras.",
    "If the task cannot be completed, still answer in this shape and say why in the",
    "field that fits best — a missing answer is a failed agent, not a soft no.",
  ].join("\n");
}

/**
 * Every balanced `{...}` / `[...]` span in `text`, in source order.
 *
 * Scans rather than regexes because braces inside strings are common in this
 * domain (file contents, code snippets, error messages) and a regex walks
 * straight into them.
 */
function balancedSpans(text: string, depthBudget = 2): string[] {
  const spans: string[] = [];
  for (let i = 0; i < text.length; i++) {
    const open = text[i];
    if (open !== "{" && open !== "[") continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let closed = -1;
    for (let j = i; j < text.length; j++) {
      const c = text[j]!;
      if (inString) {
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') inString = true;
      else if (c === "{" || c === "[") depth++;
      else if (c === "}" || c === "]") {
        if (--depth === 0) {
          closed = j;
          break;
        }
      }
    }
    if (closed === -1) {
      // Unbalanced from here to the end. Every later opener inside this one is
      // unbalanced too, so restarting one character along would rescan the tail
      // once per opener — quadratic over an answer that can reach 8MB.
      break;
    }
    spans.push(text.slice(i, closed + 1));
    // Descend one level, so an answer wrapped in an outer envelope is still a
    // candidate, then resume after the span rather than inside it.
    if (depthBudget > 0) spans.push(...balancedSpans(text.slice(i + 1, closed), depthBudget - 1));
    i = closed;
  }
  return spans;
}

/**
 * Candidate JSON values found in `text`, best first.
 *
 * "Best" is last-in-the-output first: models reason toward an answer, so when
 * several objects parse, the final one is the answer and the earlier ones are
 * usually examples it talked through on the way.
 */
export function jsonCandidates(text: string): unknown[] {
  const seen = new Set<string>();
  const parse = (raw: string): { value: unknown } | null => {
    const trimmed = raw.trim();
    if (!trimmed || seen.has(trimmed)) return null;
    seen.add(trimmed);
    try {
      return { value: JSON.parse(trimmed) };
    } catch {
      return null; /* not JSON; the scanner is allowed to guess wrong */
    }
  };
  // A reply that is nothing but the object is unambiguous, so it wins outright.
  const whole = parse(text);
  // Otherwise prefer later spans: models reason toward an answer, so the last
  // object is the answer and an earlier one is the example they talked through.
  const spans: unknown[] = [];
  for (const span of balancedSpans(text)) {
    const parsed = parse(span);
    if (parsed) spans.push(parsed.value);
  }
  return whole ? [whole.value, ...spans.reverse()] : spans.reverse();
}

/**
 * Coerce a model's answer toward `schema` and drop what the schema never asked
 * for, walking the schema as plain JSON Schema.
 *
 * typebox ships `Value.Convert` and `Value.Clean` for this, and they are used
 * nowhere here on purpose: both key off typebox's own internal markers and
 * silently do *nothing* to a hand-written JSON Schema object. Scripts declare
 * their schemas as plain object literals — that is what lets them avoid an
 * import entirely — so relying on those would have degraded coercion to a no-op
 * for every workflow that ships with this tool, without a word of warning.
 */
export function coerceToSchema(schema: any, value: unknown): unknown {
  if (!schema || typeof schema !== "object") return value;
  const type = schema.type;

  if (type === "number" || type === "integer") {
    if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
      const n = Number(value);
      return type === "integer" && !Number.isInteger(n) ? value : n;
    }
    return value;
  }
  if (type === "boolean") {
    if (value === "true") return true;
    if (value === "false") return false;
    return value;
  }
  if (type === "string") {
    // A model asked for a string that answers with a bare number understood the
    // question; the quotes are a typing slip, not a wrong answer.
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    return value;
  }
  if (type === "array" && Array.isArray(value)) {
    return schema.items ? value.map((v) => coerceToSchema(schema.items, v)) : value;
  }
  if (type === "object" || schema.properties) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    // An object schema that enumerates nothing constrains nothing. Stripping to
    // the declared keys here would empty the answer completely — and `{}`
    // satisfies such a schema, so a total loss of data would be returned as a
    // clean success. A free-form object is passed through untouched.
    if (!schema.properties) return value;
    const props = schema.properties;
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      // Undeclared keys are dropped, which is what the answer contract promises.
      if (key in props) out[key] = coerceToSchema(props[key], child);
    }
    return out;
  }
  // Known gap: `anyOf`/`oneOf`/`allOf`/`$ref` and union types like
  // `type: ["number","null"]` fall through uncoerced and unstripped, because
  // there is no single branch to coerce toward and guessing one would be how a
  // wrong answer gets massaged into passing. Value.Check still validates them
  // strictly, so such a schema costs a retry rather than admitting bad data.
  return value;
}

export interface ValidationOutcome {
  ok: boolean;
  value?: unknown;
  /** Human-readable schema violations, for the retry prompt. */
  errors: string[];
}

/**
 * First candidate that satisfies `schema`, coerced and stripped of extras.
 *
 * Convert before Check because a model that answers `"3"` for a number, or
 * `"true"` for a boolean, understood the task and merely typed it as prose;
 * failing that costs a whole retry to fix a character. Clean drops properties
 * the schema does not declare, which is the other thing they reliably do.
 */
export function validateAgainst(schema: TSchema, text: string): ValidationOutcome {
  const candidates = jsonCandidates(text);
  if (candidates.length === 0) {
    return { ok: false, errors: ["the reply contained no JSON object at all"] };
  }
  let firstErrors: string[] = [];
  for (const candidate of candidates) {
    const coerced = coerceToSchema(schema, candidate);
    if (Value.Check(schema, coerced)) return { ok: true, value: coerced, errors: [] };
    if (firstErrors.length === 0) {
      firstErrors = [...Value.Errors(schema, coerced)]
        .slice(0, 8)
        .map((e) => `${e.instancePath || "(root)"}: ${e.message}`);
    }
  }
  return { ok: false, errors: firstErrors.length ? firstErrors : ["the JSON did not match the schema"] };
}

/** Prompt appended on a retry, naming exactly what was wrong the first time. */
export function retryContract(schema: TSchema, errors: string[]): string {
  return [
    "Your previous answer did not satisfy the required format:",
    ...errors.map((e) => `  - ${e}`),
    "",
    "Answer again. Reply with ONE JSON object and nothing else — no prose, no fence.",
    "",
    "```json",
    JSON.stringify(schema, null, 2),
    "```",
  ].join("\n");
}
