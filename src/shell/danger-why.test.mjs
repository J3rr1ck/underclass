/**
 * `danger why` explains the last failure — under a real pty.
 *
 * WHY A PTY. `zsh -i < file` never reaches a prompt, so `precmd` never fires.
 * Every hook this file tests lives in `precmd`, so a non-pty test observes
 * nothing and passes vacuously. That is exactly how the bug below shipped: it
 * has presumably never worked in an installed shell, and no test saw it,
 * because the only test harness available could not reach the code. `zpty` is a
 * zsh module, so this needs no expect, no python, no dependency.
 *
 * THE TWO BUGS, which had to be fixed together:
 *
 *   D1  `preexec` fires for `danger why` itself, overwriting DANGER_LAST_CMD
 *       before the wrapper function reads it. The binary was handed
 *       `DANGER_LAST_CMD=[danger why]` with the *correct* status, which is the
 *       worst combination available: every downstream guard passes, so the
 *       model receives a plausible prompt and returns a fluent, confident,
 *       wrong diagnosis. Exit 0.
 *
 *   D2  `safeToRerun` normalised whitespace *before* testing its own blacklist,
 *       and JS `\s` includes `\n` — so the `\n` in that blacklist was
 *       unreachable. `assist.ts` then executes the raw string. zsh hands
 *       `preexec` a top-level `;` list already rewritten into newlines, so
 *       `npm test; ./deploy.sh` passed the whitelist and re-ran the deploy.
 *
 * D1 masked D2 (you could never latch a `;` list, because `why` only ever saw
 * "danger why"). Fixing D1 alone arms it. The last test here is the coupling:
 * it asserts the newline genuinely reaches the guard, and that the guard says no.
 *
 * Run: node packages/under/src/shell/danger-why.test.mjs   (needs a build)
 */
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const plugin = join(here, "plugin.zsh");
const driver = join(here, "pty-drive.zsh");
const dist = join(here, "..", "..", "dist", "shell");
if (!existsSync(join(dist, "rules.js"))) {
  console.error("build first: npm run build");
  process.exit(2);
}
const { safeToRerun } = await import(join(dist, "rules.js"));

// A fake `danger` that reports the environment it was handed, and a fake `npm`
// that fails. Both on PATH ahead of anything real: this test must never invoke
// the actual binary, reach an endpoint, or cost a token.
const T = mkdtempSync(join(tmpdir(), "danger-why-"));
mkdirSync(join(T, "bin"), { recursive: true });
const bin = (name, body) => {
  const p = join(T, "bin", name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
};
// Exits 1 on purpose: an unreachable endpoint is the common offline case, and
// a *failing* `danger why` is precisely what re-armed this bug in its second
// form. A fake that exits 0 tests the easy half only.
bin("danger", `printf 'WHY cmd=[%s] status=[%s]\\n' "$DANGER_LAST_CMD" "$DANGER_LAST_STATUS"\nexit 1`);
bin("npm", `echo "npm: fake failure" >&2; exit 1`);
bin("deploy.sh", `echo "DEPLOYED — this must never run"; exit 3`);
writeFileSync(
  join(T, "zshrc"),
  `export PATH=${join(T, "bin")}:$PATH\nexport DANGER_HOME=${join(T, "home")}\nsource ${plugin}\n`,
);

/** Run an interactive zsh through a pty and return what `danger why` was handed. */
function drive(...cmds) {
  let out;
  try {
    out = execFileSync("zsh", [driver, join(T, "zshrc"), ...cmds], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    });
  } catch (e) {
    if (e.status === 77) {
      console.log("danger why: SKIPPED — zsh/zpty unavailable");
      process.exit(0);
    }
    out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
  // A pty echoes input and wraps lines; pull the structured records back out.
  const clean = out.replace(/\r/g, "");
  return {
    handed: [...clean.matchAll(/WHY cmd=\[([\s\S]*?)\] status=\[(\d*)\]/g)].map((m) => ({
      cmd: m[1],
      status: Number(m[2]),
    })),
    nothingFailed: /nothing has failed in this shell yet/.test(clean),
    deployed: /DEPLOYED/.test(clean),
  };
}

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

t("D1: `danger why` explains the failed command, not itself", () => {
  const r = drive("npm test", "danger why");
  assert.equal(r.handed.length, 1, "danger why should have been invoked once");
  assert.equal(r.handed[0].cmd, "npm test");
  assert.equal(r.handed[0].status, 1);
});

t("the latch survives an intervening successful command", () => {
  const r = drive("npm test", "true", "danger why");
  assert.equal(r.handed[0]?.cmd, "npm test", "a later success must not clear the last failure");
});

t("D1 gap: a FAILING `danger why` does not become the latched failure", () => {
  const r = drive("npm test", "danger why", "danger why");
  assert.equal(r.handed.length, 2);
  assert.equal(r.handed[1].cmd, "npm test", "danger's own non-zero exit must not overwrite the latch");
});

t("nothing failed yet is reported, not fabricated", () => {
  const r = drive("true", "danger why");
  assert.equal(r.handed.length, 0, "the binary must not be invoked with no failure to explain");
  assert.ok(r.nothingFailed);
});

t("DANGER_HINTS=0 silences hints but does not disable `danger why`", () => {
  const r = drive("DANGER_HINTS=0", "npm test", "danger why");
  assert.equal(r.handed[0]?.cmd, "npm test", "opting out of hints is not opting out of asking");
});

t("an explicitly requested benign non-zero is still explained", () => {
  const r = drive("grep zzz /etc/hosts", "danger why");
  assert.equal(r.handed[0]?.cmd, "grep zzz /etc/hosts", "declining to volunteer a hint != refusing to answer");
});

t("Ctrl-C does not bury the real failure", () => {
  const r = drive("npm test", 'sh -c "kill -INT $$"', "danger why");
  assert.equal(r.handed[0]?.cmd, "npm test");
});

t("D2 coupling: a `;` list reaches the guard as a newline, and is refused", () => {
  const r = drive("npm test; ./deploy.sh", "danger why");
  const handed = r.handed[0]?.cmd;
  // zsh rewrites a top-level `;` list into newlines before preexec sees it, so
  // this is how the string arrives — no user ever typed a newline.
  assert.equal(handed, "npm test\n./deploy.sh", "expected the ';' to arrive as a newline");
  assert.equal(safeToRerun(handed), false, "a whitelisted prefix must not license the rest of the chain");
  assert.equal(r.deployed, false);
});

t("D2: the whitelist still works, with runs of spaces", () => {
  assert.equal(safeToRerun("npm test"), true);
  assert.equal(safeToRerun("npm   test"), true, "collapsing spaces is fine; collapsing newlines was the bug");
  assert.equal(safeToRerun("npm test\rrm -rf /"), false, "\\r is a line terminator too");
});

console.log(`danger why: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
