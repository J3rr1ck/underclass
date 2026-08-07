import type { WorkflowHooks, WorkflowMeta } from "./types.js";

/**
 * A workflow script is plain JavaScript with a declared header:
 *
 *   export const meta = { name, description, phases }
 *   phase('Review')
 *   const findings = await agent('…', { schema: FINDINGS })
 *   return { findings }
 *
 * The body is executed as an async function with the hooks passed in as
 * parameters, which is what makes top-level `await` and a top-level `return`
 * work. Static `import` cannot appear in a function body — a script that needs
 * a module uses `await import(...)`.
 */

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: string[]
) => (...args: unknown[]) => Promise<unknown>;

const META_DECL = /export\s+(?:const|let|var)\s+meta\s*=\s*/;

/** Span of the balanced `{...}` starting at `from`, or null if unterminated. */
function objectLiteralAt(source: string, from: number): string | null {
  const start = source.indexOf("{", from);
  if (start === -1) return null;
  let depth = 0;
  let inString: string | null = null;
  let escaped = false;
  for (let i = start; i < source.length; i++) {
    const c = source[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === inString) inString = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") inString = c;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return source.slice(start, i + 1);
  }
  return null;
}

/**
 * Parse a JS object literal WITHOUT evaluating it.
 *
 * The previous implementation was `new Function(`return (${literal})`)()`, which
 * is not a literal parser — it is an evaluator with the full ambient globals of
 * an ESM Node process. A property value is an expression, so a repository could
 * ship `.underclass/workflows/x.mjs` whose `meta.description` was
 * `process.getBuiltinModule('fs').writeFileSync(...) || 'Reviews the diff'`, and
 * merely LISTING the workflows executed it while printing an innocuous name.
 *
 * Verified as a working exploit before this was written: cloning a repo and
 * running `under workflow --list` — which spawns no agents and is documented as
 * safe — wrote an attacker-chosen file and reported nothing unusual.
 *
 * So this accepts only JSON-shaped values: string, number, boolean, null, array,
 * object. No identifiers, no calls, no template literals, no operators, no
 * spread. Anything else is a parse error naming the offending construct. It also
 * accepts what JSON does not and JS does — single quotes, unquoted keys and
 * trailing commas — because `meta` is hand-written JavaScript and rejecting
 * those would be a usability regression for no security gain.
 */
function parseLiteral(src: string): unknown {
  let i = 0;
  const err = (msg: string): never => {
    throw new Error(`${msg} at offset ${i}`);
  };
  const ws = () => {
    for (;;) {
      while (i < src.length && /\s/.test(src[i]!)) i++;
      // Comments are legal in hand-written JS and carry no execution risk.
      if (src[i] === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
      if (src[i] === "/" && src[i + 1] === "*") { i += 2; while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++; i += 2; continue; }
      return;
    }
  };
  const str = (q: string): string => {
    i++;
    let out = "";
    while (i < src.length && src[i] !== q) {
      if (src[i] === "\\") {
        i++;
        const e = src[i]!;
        out += e === "n" ? "\n" : e === "t" ? "\t" : e === "r" ? "\r"
          : e === "u" ? String.fromCharCode(parseInt(src.slice(i + 1, i + 5), 16)) : e;
        if (e === "u") i += 4;
        i++;
      } else out += src[i++];
    }
    if (src[i] !== q) err("unterminated string");
    i++;
    return out;
  };
  const value = (): unknown => {
    ws();
    const c = src[i];
    if (c === '"' || c === "'") return str(c);
    if (c === "`") err("template literals are not allowed in `meta` — use a plain string");
    if (c === "{") {
      i++;
      const obj: Record<string, unknown> = {};
      ws();
      if (src[i] === "}") { i++; return obj; }
      for (;;) {
        ws();
        if (src[i] === "." ) err("spread is not allowed in `meta`");
        let key: string;
        if (src[i] === '"' || src[i] === "'") key = str(src[i]!);
        else {
          const m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(src.slice(i));
          if (!m) err("expected a property name");
          key = m![0];
          i += key.length;
        }
        ws();
        if (src[i] !== ":") err(`expected ":" after property "${key}"`);
        i++;
        obj[key] = value();
        ws();
        if (src[i] === ",") { i++; ws(); if (src[i] === "}") { i++; return obj; } continue; }
        if (src[i] === "}") { i++; return obj; }
        err("expected \",\" or \"}\"");
      }
    }
    if (c === "[") {
      i++;
      const arr: unknown[] = [];
      ws();
      if (src[i] === "]") { i++; return arr; }
      for (;;) {
        arr.push(value());
        ws();
        if (src[i] === ",") { i++; ws(); if (src[i] === "]") { i++; return arr; } continue; }
        if (src[i] === "]") { i++; return arr; }
        err("expected \",\" or \"]\"");
      }
    }
    const word = /^(true|false|null)\b/.exec(src.slice(i));
    if (word) { i += word[0].length; return word[0] === "true" ? true : word[0] === "false" ? false : null; }
    const num = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(src.slice(i));
    if (num) { i += num[0].length; return Number(num[0]); }
    return err(
      "`meta` must contain only literal values — strings, numbers, booleans, null, arrays and " +
        "objects. Identifiers, function calls and expressions are rejected because listing a " +
        "workflow must never execute anything",
    );
  };
  const out = value();
  ws();
  if (i < src.length) err("trailing content after the `meta` literal");
  return out;
}

/**
 * Read the header without running the script.
 *
 * `meta` is required to be a literal precisely so this is possible: `--dry-run`
 * has to be able to say what a workflow intends to do without spawning a single
 * agent, and a computed header would mean executing the body to find out.
 *
 * The parse is non-evaluating — see `parseLiteral`. A workflow from a cloned
 * repository is untrusted input, and this function runs against it.
 */
export function extractMeta(source: string): WorkflowMeta {
  const decl = META_DECL.exec(source);
  if (!decl) {
    throw new Error("workflow script must begin with `export const meta = { name, description }`");
  }
  const literal = objectLiteralAt(source, decl.index + decl[0].length);
  if (!literal) throw new Error("`export const meta` is not a closed object literal");
  let meta: WorkflowMeta;
  try {
    meta = parseLiteral(literal) as WorkflowMeta;
  } catch (err) {
    throw new Error(
      `\`meta\` must be a plain literal — no variables, calls or template interpolation ` +
        `(${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (!meta || typeof meta.name !== "string" || typeof meta.description !== "string") {
    throw new Error("`meta` needs a string `name` and a string `description`");
  }
  return meta;
}

/** Strip the hashbang and demote the `export` so the body can run in a function. */
export function toFunctionBody(source: string): string {
  return source.replace(/^#![^\n]*\n/, "").replace(META_DECL, "const meta = ");
}

/** Execute a script body against a set of hooks and return whatever it returns. */
export async function executeScript(source: string, hooks: WorkflowHooks): Promise<unknown> {
  const body = toFunctionBody(source);
  let fn: (...args: unknown[]) => Promise<unknown>;
  try {
    fn = new AsyncFunction("agent", "parallel", "pipeline", "phase", "log", "args", "budget", body);
  } catch (err) {
    throw new Error(`workflow script failed to parse: ${err instanceof Error ? err.message : String(err)}`);
  }
  return fn(hooks.agent, hooks.parallel, hooks.pipeline, hooks.phase, hooks.log, hooks.args, hooks.budget);
}
