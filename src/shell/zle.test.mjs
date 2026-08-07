/**
 * Exercise the ZLE widget bodies, which nothing else does.
 *
 * This exists because of a coverage gap that produced four defects at once.
 * `shell-rules.test.mjs` only ever calls `danger_is_prose`; the widget bodies —
 * `danger_ask`, `danger_smart_tab` — were untested by anything, and the headline
 * feature was broken on the first keypress.
 *
 * The one that mattered: `local cmdline=${${(f)out}[1]}` reads like "first line"
 * and is not. When the inner expansion yields exactly one element zsh subscripts
 * the SCALAR, so `[1]` is its first CHARACTER — a suggestion of
 * "find . -size +100M" put a bare `f` in the buffer, and the widget then printed
 * "Enter to run". `SUGGEST_SYSTEM` demands a one-line reply, so the better the
 * model behaved, the more reliably it broke.
 *
 * HOW THIS RUNS THE REAL CODE WITHOUT A TERMINAL. Driving live ZLE needs a pty
 * (`zpty`), which is slow and flaky to script. But the bugs live in the widget
 * *bodies* — parameter expansion, control flow, what lands in `$BUFFER` — not in
 * ZLE itself. So we stub the three ZLE builtins the widgets touch (`zle`,
 * `bindkey`, and the `widgets` map) and invoke the widget as a plain function.
 * `$BUFFER` is an ordinary parameter, so every assertion below is against the
 * genuine shipped code path, not a transcription of it.
 *
 * The network is stubbed too: a `danger` shim on PATH returns canned output, so
 * this is offline, deterministic and fast.
 *
 * Run: node packages/under/src/shell/zle.test.mjs      (no build required)
 */
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// The SOURCE plugin: it is what the build copies verbatim, so this needs no
// build step and cannot silently pass against a stale dist.
const PLUGIN = join(here, "plugin.zsh");
assert.ok(existsSync(PLUGIN), `missing ${PLUGIN}`);

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try {
    fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    fail++;
    console.error(`  FAIL ${name}\n       ${String(e.message).split("\n").slice(0, 4).join("\n       ")}`);
  }
};

const sandbox = mkdtempSync(join(tmpdir(), "danger-zle-"));
const binDir = join(sandbox, "bin");
mkdirSync(binDir, { recursive: true });

/**
 * Stage the generated rule table the plugin sources at startup.
 *
 * Without it `danger_is_prose` returns early on `${+DANGER_PROSE_WORD}` and every
 * routing test silently passes for the wrong reason — the widget never runs. That
 * is the same shape as the bug this file exists for, so it is worth stating: a
 * test whose fixture is missing does not fail, it stops testing.
 *
 * Imported from the TypeScript source directly (Node strips types), so this
 * needs no build and cannot pass against a stale dist.
 */
mkdirSync(join(sandbox, "shell"), { recursive: true });
const { emitZshRules } = await import(join(here, "rules.ts"));
writeFileSync(join(sandbox, "shell", "danger-rules.zsh"), emitZshRules());

/** A fake `danger` on PATH, so the widget's subprocess returns what we choose. */
function stubDanger(stdout, { exitCode = 0 } = {}) {
  const p = join(binDir, "danger");
  writeFileSync(p, `#!/bin/sh\nprintf '%s' ${shq(stdout)}\nexit ${exitCode}\n`, { mode: 0o755 });
  chmodSync(p, 0o755);
}
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/**
 * Run a widget body with ZLE stubbed out, and report the resulting $BUFFER.
 *
 * `emulate -L zsh` inside the plugin's own functions keeps their option scope,
 * so behaviour here matches an interactive shell for everything the widgets do.
 */
function runWidget(widget, buffer) {
  const script = `
    # --- stub the ZLE surface the widgets touch -------------------------------
    zle()     { : }          # zle -M / zle -R / zle <widget> all become no-ops
    bindkey() { : }
    # --- load the real plugin -------------------------------------------------
    DANGER_HOME=${shq(sandbox)}
    source ${shq(PLUGIN)}
    # --- drive it -------------------------------------------------------------
    BUFFER=${shq(buffer)}
    LBUFFER=$BUFFER
    CURSOR=\${#BUFFER}
    ${widget}
    print -r -- "BUFFER=[$BUFFER]"
  `;
  return execFileSync("zsh", ["-f", "-c", script], {
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
  })
    .split("\n")
    .filter((l) => l.startsWith("BUFFER=["))
    .pop()
    ?.replace(/^BUFFER=\[/, "")
    .replace(/\]$/, "");
}

// ---------------------------------------------------------------------------

t("the plugin loads and defines the widget functions", () => {
  const out = execFileSync(
    "zsh",
    [
      "-f",
      "-c",
      `zle(){ : }; bindkey(){ : }; DANGER_HOME=${shq(sandbox)}; source ${shq(PLUGIN)};
       print -r -- "ask=\${+functions[danger_ask]} tab=\${+functions[danger_smart_tab]} prose=\${+functions[danger_is_prose]}"`,
    ],
    { encoding: "utf8" },
  ).trim();
  assert.match(out, /ask=1/, out);
  assert.match(out, /tab=1/, out);
  assert.match(out, /prose=1/, out);
});

/**
 * THE REGRESSION TEST. Restore `${${(f)out}[1]}` and this fails with "[f]".
 */
t("a ONE-LINE suggestion reaches $BUFFER whole, not as its first character", () => {
  stubDanger("find . -size +100M");
  const got = runWidget("danger_ask", "find files over 100 megabytes");
  assert.equal(got, "find . -size +100M", `single-line suggestion mangled — got [${got}]`);
});

t("a MULTI-line reply is truncated to its first line", () => {
  stubDanger("git status\nand here is some prose the model added anyway");
  const got = runWidget("danger_ask", "show me the repo state");
  assert.equal(got, "git status", `got [${got}]`);
});

t("flags, quotes and paths survive intact", () => {
  const cmd = "git log --oneline --since='2 weeks ago' -- src/";
  stubDanger(cmd);
  const got = runWidget("danger_ask", "what changed in src over the last two weeks");
  assert.equal(got, cmd, `got [${got}]`);
});

t("a single-CHARACTER suggestion is not mistaken for the bug", () => {
  // Degenerate but legal: the fix must not special-case length.
  stubDanger("w");
  const got = runWidget("danger_ask", "who else is logged in right now");
  assert.equal(got, "w", `got [${got}]`);
});

t("an empty reply leaves the buffer untouched", () => {
  stubDanger("");
  const original = "something the model cannot answer";
  const got = runWidget("danger_ask", original);
  assert.equal(got, original, `buffer clobbered on an empty reply — got [${got}]`);
});

t("a non-zero exit from the helper leaves the buffer untouched", () => {
  stubDanger("this should be ignored", { exitCode: 1 });
  const original = "ask something while the endpoint is down";
  const got = runWidget("danger_ask", original);
  assert.equal(got, original, `buffer clobbered when the helper failed — got [${got}]`);
});

t("smart Tab never sends a real command line to the model", () => {
  // If danger_smart_tab wrongly routes this to danger_ask, the stub's text
  // lands in the buffer and the assertion fails loudly.
  stubDanger("SENTINEL-SHOULD-NOT-APPEAR");
  for (const cmdline of ["git commit -m wip", "npm run build", "docker compose up", "ls -la"]) {
    const got = runWidget("danger_smart_tab", cmdline);
    assert.equal(got, cmdline, `smart tab sent a command line to the model: [${cmdline}] -> [${got}]`);
  }
});

t("smart Tab DOES route prose to the model", () => {
  stubDanger("find . -size +100M");
  const got = runWidget("danger_smart_tab", "find all files larger than 100 megabytes");
  assert.equal(got, "find . -size +100M", `prose was not routed to the model — got [${got}]`);
});

t("the destructive-suggestion check fires on what it should", () => {
  const script = `
    zle(){ : }; bindkey(){ : }
    DANGER_HOME=${shq(sandbox)}; source ${shq(PLUGIN)}
    for c in 'rm -rf build' 'git reset --hard HEAD~1' 'git push --force origin main' 'ls -la' 'npm test'; do
      if danger_looks_destructive "$c"; then print -r -- "FLAG $c"; else print -r -- "ok   $c"; fi
    done`;
  const out = execFileSync("zsh", ["-f", "-c", script], { encoding: "utf8" }).trim().split("\n");
  assert.equal(out.filter((l) => l.startsWith("FLAG")).length, 3, `wrong flag count:\n${out.join("\n")}`);
  assert.ok(out.includes("ok   ls -la"), `false positive on ls:\n${out.join("\n")}`);
  assert.ok(out.includes("ok   npm test"), `false positive on npm test:\n${out.join("\n")}`);
});

rmSync(sandbox, { recursive: true, force: true });
console.log(`\nZLE widgets: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
