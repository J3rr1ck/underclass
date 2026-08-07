/**
 * Static shell heuristics — the free half of `danger`.
 *
 * Most shell failures are the same twenty failures. A missing binary, a missing
 * execute bit, a port already bound, a stale lockfile. None of that needs a
 * model, and paying 1-9 seconds of inference to be told "install ripgrep" is
 * worse than not asking. So the rules run first, offline, and the model is only
 * consulted for what they miss.
 *
 * This file is the single source of truth for those rules. `emitZshRules()`
 * compiles them into a sourceable zsh file at `danger init` time, so the plugin
 * can answer `command_not_found_handler` without forking anything — shell
 * startup and every command afterwards stay fork-free, which is the constraint
 * that killed the "just shell out to node" design in DESIGN.md §8.
 */

/** A binary the user just tried to run, and how to actually get it. */
export interface InstallHint {
  /** How to install it on macOS (Homebrew), when that is the right answer. */
  brew?: string;
  /** Debian/Ubuntu package name. */
  apt?: string;
  /** Anything that is not a package: a runtime, an SDK, a different name. */
  note?: string;
}

/**
 * Missing-command → how to get it.
 *
 * Kept to commands a developer plausibly types and plausibly lacks. A map of
 * every binary in Homebrew would be worse: the value here is that a hit is
 * *specific*, and specificity dies as the table grows toward "some package
 * somewhere provides this".
 */
export const INSTALL_HINTS: Record<string, InstallHint> = {
  rg: { brew: "brew install ripgrep", apt: "apt install ripgrep", note: "under's repo_search needs this" },
  fd: { brew: "brew install fd", apt: "apt install fd-find" },
  jq: { brew: "brew install jq", apt: "apt install jq" },
  gh: { brew: "brew install gh", apt: "see https://cli.github.com", note: "`under fan-out --pr` needs this" },
  bat: { brew: "brew install bat", apt: "apt install bat" },
  tree: { brew: "brew install tree", apt: "apt install tree" },
  wget: { brew: "brew install wget", apt: "apt install wget", note: "curl is already installed and does the same job" },
  htop: { brew: "brew install htop", apt: "apt install htop" },
  docker: { brew: "brew install --cask orbstack", note: "OrbStack is lighter than Docker Desktop on Apple Silicon" },
  podman: { brew: "brew install podman" },
  python: { note: "macOS ships `python3`, not `python`. Try `python3`, or `brew install python`" },
  pip: { note: "try `pip3`, or `python3 -m pip`" },
  node: { brew: "brew install node", note: "under needs Node >= 22.19" },
  pnpm: { brew: "brew install pnpm", note: "or `corepack enable pnpm`" },
  yarn: { note: "`corepack enable yarn` — no install needed on modern Node" },
  cargo: { brew: "brew install rustup && rustup-init", note: "cargo comes with the Rust toolchain" },
  rustc: { brew: "brew install rustup && rustup-init" },
  go: { brew: "brew install go" },
  java: { brew: "brew install openjdk", note: "Android builds want a JDK on PATH and JAVA_HOME set" },
  adb: { brew: "brew install --cask android-platform-tools", note: "or use the one in $ANDROID_HOME/platform-tools" },
  gradle: { note: "use the wrapper: `./gradlew`. A repo without one is missing a committed file" },
  sdkmanager: { note: "lives in $ANDROID_HOME/cmdline-tools/latest/bin — not on PATH by default" },
  xcodebuild: { note: "run `xcode-select --install`, or point xcode-select at a full Xcode" },
  swift: { note: "ships with Xcode; `xcode-select --install` gets the command-line tools" },
  code: { note: "VS Code's CLI is installed from the app: Command Palette → 'Shell Command: Install code'" },
  under: { note: "npm i -g underclass — or you are in a shell that predates the install" },
  ollama: { brew: "brew install ollama", note: "docs/ENDPOINTS.md compares local runtimes" },
  lms: { note: "LM Studio's CLI: install it from the app's Developer tab" },
  uv: { brew: "brew install uv" },
  ruff: { brew: "brew install ruff", note: "or `uvx ruff`" },
};

/**
 * A failure we can name from the exit status and the command line alone.
 *
 * The constraint that shapes this table: zsh hooks see the command and the exit
 * code, and *not one byte of output* (DESIGN.md §5.1 — verified, and a claim to
 * the contrary elsewhere in that doc cites a section that does not say it).
 * Every rule here must therefore work without stderr. Rules that need the error
 * text belong to `danger why`, which re-runs or asks.
 */
export interface StatusRule {
  /** Exit status this applies to, or a predicate over it. */
  status: number | ((s: number) => boolean);
  /** Restrict to a command basename, when the meaning is command-specific. */
  command?: string;
  /** One line, imperative, no hedging. */
  hint: string;
}

export const STATUS_RULES: StatusRule[] = [
  // 127 is the single most common shell failure and had no rule at all, so
  // `danger why` fell straight through to the model — and said nothing useful
  // when the endpoint was down. The install table usually knows the answer.
  { status: 127, hint: "command not found — check the spelling, or it is not installed / not on PATH" },
  { status: 2, hint: "usage error — the command rejected its arguments; try its --help" },
  { status: 126, hint: "not executable — try `chmod +x` on it, or the file is a directory" },
  { status: 137, hint: "killed (SIGKILL) — usually the OOM killer, or a container memory limit" },
  { status: 139, hint: "segfault — the program crashed, this is not your shell" },
  { status: 143, hint: "terminated (SIGTERM) — something asked it to stop" },
  { status: 1, command: "git", hint: "`git status` first; on a merge/rebase, `git status` names the next step" },
  { status: 128, command: "git", hint: "git usage error — the ref, path or option does not exist" },
  { status: 1, command: "npm", hint: "if it is a dependency resolution error, `rm -rf node_modules package-lock.json && npm i`" },
  { status: 1, command: "gradlew", hint: "re-run with `--stacktrace`; if it is a daemon issue, `./gradlew --stop`" },
  { status: 1, command: "docker", hint: "is the daemon running? `docker info` answers that in one line" },
  { status: 1, command: "ssh", hint: "`ssh -v` prints which key it offered and why the server refused" },
];

/**
 * Commands whose non-zero exit is a *result*, not a failure.
 *
 * grep exiting 1 means "no match", which is an answer. Hinting at it trains the
 * user to ignore hints, and a hint people ignore is worse than no hint.
 */
export const BENIGN_NONZERO = [
  "grep", "egrep", "fgrep", "rg", "ag", "ack", "pgrep", "diff", "cmp", "test", "[", "[[",
  "which", "type", "whence", "find", "fd", "git-diff", "jq", "false",
];

/**
 * Commands safe to re-run to capture their output for `danger why`.
 *
 * Membership means "running this a second time changes nothing that matters".
 * Everything absent gets diagnosed from the command line alone; we do not guess
 * about side effects, because guessing wrong re-runs a deploy.
 */
export const SAFE_TO_RERUN = [
  "npm test", "npm run test", "npm run build", "npm run typecheck", "npm run lint", "npm ci",
  "yarn test", "pnpm test", "pnpm build", "cargo build", "cargo test", "cargo check", "cargo clippy",
  "go build", "go test", "go vet", "make", "make test", "make build", "tsc", "npx tsc",
  "pytest", "python -m pytest", "ruff check", "mypy", "eslint", "npx eslint",
  "./gradlew build", "./gradlew test", "./gradlew assembleDebug", "swift build", "swift test",
];

/**
 * Function words that essentially never appear in a real command line.
 *
 * The naive test for "is the user typing prose" — does the first word name a
 * command? — fails on the most natural requests there are, because `find`,
 * `make`, `test`, `sort`, `kill`, `open`, `head`, `which`, `time` and `install`
 * are all commands AND all common English sentence openers. "find all files
 * larger than 100mb" is prose that begins with a binary.
 *
 * What actually separates the two is grammar: shell is terse and drops function
 * words, English cannot. A command line has no articles, no auxiliaries and no
 * pronouns, so two of these in one buffer is close to conclusive.
 *
 * Deliberately EXCLUDED, despite being function words:
 *  - zsh reserved words (for, in, do, done, if, then, while, case, select,
 *    function, time) — they open real shell constructs;
 *  - short prepositions that appear as subcommands or argument values (to, of,
 *    on, at, by, or, no) — `kubectl get pods -n default`, `git switch -c`;
 *  - anything under three characters, which is where the collisions live.
 *
 * A miss here is cheap: Tab falls through to zsh's own completion, which is what
 * would have happened anyway, and the explicit suggest key still works. A false
 * positive is expensive: it steals Tab from a command the user was completing.
 * So the list errs toward missing.
 */
export const PROSE_WORDS = [
  // Short function words. Individually risky, collectively decisive — and safe
  // here because the caller has already rejected anything carrying a flag or a
  // shell operator, so what remains is a flagless 3+ word line. "add a null
  // check to src/foo.ts" needs "a" and "to" to reach the threshold at all.
  // Deliberately absent: up, out, off, down, in, for, do (real subcommands and
  // zsh reserved words — `docker compose up` must not read as English).
  "a", "an", "is", "my", "me", "to", "of", "on", "it", "be", "am", "as", "by",
  "we", "us", "you", "with", "from", "no", "not", "so", "or", "in",
  // determiners
  "the", "this", "that", "these", "those", "all", "every", "each", "any", "some",
  "both", "another", "such", "our", "your", "their", "its",
  // prepositions and comparatives that do not collide with CLI vocabulary
  "about", "above", "across", "after", "against", "along", "among", "around",
  "before", "behind", "below", "beneath", "beside", "between", "beyond", "during",
  "except", "inside", "instead", "into", "near", "onto", "outside", "over",
  "since", "through", "throughout", "toward", "towards", "under", "underneath",
  "until", "upon", "within", "without", "than", "versus",
  // question words
  "what", "why", "when", "where", "who", "whom", "whose", "how", "which",
  // pronouns
  "them", "they", "she", "her", "his", "him", "mine", "ours", "yours",
  // auxiliaries and modals
  "are", "was", "were", "been", "being", "does", "did", "doing", "has", "have",
  "had", "can", "could", "should", "would", "will", "shall", "may", "might",
  "must", "cannot", "isn't", "doesn't", "didn't",
  // discourse
  "and", "but", "also", "just", "only", "really", "very", "still", "again",
  "because", "however", "therefore", "please", "maybe", "probably", "actually",
  "instead", "rather", "somewhere", "anything", "everything", "something",
];

/** Shell-quote a string for a single-quoted zsh literal. */
function zq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Commands common enough that starting a line with one is weak evidence of shell.
 *
 * Only used to WITHHOLD a point, never to force a verdict, so an incomplete list
 * degrades gracefully. The zsh side uses `whence -w` instead, which is exact;
 * this exists so the TypeScript mirror can be tested to the same answers.
 */
const COMMON_COMMANDS = new Set([
  "ls", "cd", "cp", "mv", "rm", "cat", "echo", "git", "npm", "npx", "node", "yarn", "pnpm",
  "docker", "kubectl", "brew", "apt", "make", "cargo", "go", "python", "python3", "pip", "pip3",
  "ssh", "scp", "curl", "wget", "tar", "zip", "unzip", "grep", "rg", "fd", "find", "sed", "awk",
  "sort", "uniq", "head", "tail", "wc", "diff", "chmod", "chown", "kill", "ps", "top", "open",
  "which", "test", "time", "touch", "mkdir", "rmdir", "ln", "df", "du", "man", "less", "more",
  "vim", "nvim", "nano", "code", "adb", "gradle", "swift", "xcodebuild", "java", "ruby", "perl",
  "tmux", "jq", "gh", "sudo", "env", "export", "source", "bash", "zsh", "sh", "install", "uv",
]);

/**
 * Is the user writing English rather than shell?
 *
 * Mirrored in the plugin as `danger_is_prose` so the shell can decide without a
 * fork. This copy exists to be tested — the zsh one is where it runs, and the
 * two are kept answer-for-answer identical by shell-rules.test.mjs.
 *
 * Scoring, after flags and operators have already ruled a line out as shell:
 * each function word scores 1, and a first word that names no known command
 * scores 1 more. Two points is prose. The bonus is what catches short requests
 * like "refactor the parser module", which carries only one function word but
 * cannot possibly be a command.
 */
export function isProse(buffer: string, isRunnable?: (word: string) => boolean): boolean {
  const buf = buffer.trim().replace(/^#\s*/, "");
  if (!buf) return false;
  const words = buf.split(/\s+/);
  if (words.length < 3) return false;

  // A flag is the single strongest shell signal there is; English does not use
  // them, and every prose false-positive I could construct had one.
  if (words.some((w) => /^-{1,2}[A-Za-z?]/.test(w))) return false;
  // Operators, expansions, globs and quoting: syntax, not sentences. Paths are
  // NOT in this list — "add a null check to src/foo.ts" is prose about a path.
  if (/[|&;<>$`*?{}[\]()"']/.test(buf)) return false;
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!)) return false;

  const set = new Set(PROSE_WORDS);
  const norm = (w: string) => w.toLowerCase().replace(/[.,!?:;]+$/, "");
  let score = words.filter((w) => set.has(norm(w))).length;
  const runnable = isRunnable ?? ((w: string) => COMMON_COMMANDS.has(w));
  if (!runnable(norm(words[0]!))) score += 1;
  return score >= 2;
}

/**
 * Compile the tables into a zsh file the plugin sources at startup.
 *
 * Generated rather than hand-maintained so the rules have one home, and read as
 * plain assoc arrays rather than parsed so a new shell costs no subprocess. The
 * plugin degrades to silence if this file is absent.
 */
export function emitZshRules(): string {
  const lines: string[] = [
    "# Generated by `danger init` — do not edit; edit packages/under/src/shell/rules.ts.",
    "# Sourced once per shell. Pure data, no forks.",
    "",
    "typeset -gA DANGER_INSTALL_HINT",
    "DANGER_INSTALL_HINT=(",
  ];
  for (const [cmd, h] of Object.entries(INSTALL_HINTS)) {
    // One rendered line per command: the plugin prints it verbatim, so the
    // platform choice is made here rather than branched on in the shell.
    const parts: string[] = [];
    if (h.brew) parts.push(process.platform === "darwin" ? h.brew : (h.apt ?? h.brew));
    else if (h.apt) parts.push(h.apt);
    if (h.note) parts.push(`(${h.note})`);
    lines.push(`  ${zq(cmd)} ${zq(parts.join("  "))}`);
  }
  lines.push(")", "");

  lines.push("typeset -ga DANGER_BENIGN_NONZERO");
  lines.push(`DANGER_BENIGN_NONZERO=(${BENIGN_NONZERO.map(zq).join(" ")})`);
  lines.push("");

  // An assoc array rather than an array: membership is tested once per word on
  // every Tab press, and ${+assoc[w]} is a hash lookup where (Ie) is a scan.
  lines.push("typeset -gA DANGER_PROSE_WORD");
  lines.push(`DANGER_PROSE_WORD=(${PROSE_WORDS.map((w) => `${zq(w)} 1`).join(" ")})`);
  lines.push("");

  // Status rules become a function rather than a table: they are keyed on two
  // fields and the shell has no tuple type worth the trouble.
  lines.push("danger_status_hint() {  # $1 = exit status, $2 = command basename");
  lines.push("  local st=$1 cmd=$2");
  for (const r of STATUS_RULES) {
    if (typeof r.status !== "number") continue;
    const cond = r.command
      ? `[[ $st == ${r.status} && $cmd == ${zq(r.command)} ]]`
      : `[[ $st == ${r.status} ]]`;
    lines.push(`  ${cond} && { print -r -- ${zq(r.hint)}; return 0 }`);
  }
  lines.push("  (( st > 128 && st < 160 )) && { print -r -- \"killed by signal $(( st - 128 ))\"; return 0 }");
  lines.push("  return 1");
  lines.push("}");
  lines.push("");
  return lines.join("\n");
}

/** The same status lookup, for `danger why` and for tests. */
export function statusHint(status: number, command: string): string | null {
  const base = command.split("/").pop() ?? command;
  for (const r of STATUS_RULES) {
    const statusOk = typeof r.status === "number" ? r.status === status : r.status(status);
    if (!statusOk) continue;
    if (r.command && r.command !== base) continue;
    return r.hint;
  }
  if (status > 128 && status < 160) return `killed by signal ${status - 128}`;
  return null;
}

/** Install advice for a command that was not found. */
export function installHint(cmd: string): string | null {
  const h = INSTALL_HINTS[cmd];
  if (!h) return null;
  const parts: string[] = [];
  if (process.platform === "darwin" && h.brew) parts.push(h.brew);
  else if (h.apt) parts.push(h.apt);
  else if (h.brew) parts.push(h.brew);
  if (h.note) parts.push(`(${h.note})`);
  return parts.join("  ") || null;
}

/**
 * Is re-running this command to capture its output safe?
 *
 * A prefix match ALONE is not enough, and the test for this function originally
 * asserted only the harmless direction — that `rm -rf / && npm test` is refused
 * — thereby certifying the very property that caused the bug. The dangerous
 * direction is the other one: `npm test && rm -rf ./dist` and
 * `make && sudo make install` both begin with a whitelisted prefix, and
 * `danger why` would have re-executed them.
 *
 * So: reject anything containing a shell operator that could chain, redirect or
 * substitute, then require a whitelist prefix. The whitelist says "this command
 * is safe to run twice"; it cannot vouch for whatever a user appended to it.
 */
export function safeToRerun(cmdline: string): boolean {
  // Test the RAW string. Normalising first ran `replace(/\s+/g, " ")`, and JS
  // `\s` includes `\n` — so the `\n` in this very blacklist was unreachable and
  // `npm test\nrm -rf ./dist` was approved. `assist.ts` then executes the
  // ORIGINAL string, not the normalised one, so the newline was still there when
  // it ran.
  //
  // That is reachable without anyone typing a newline: zsh's `preexec` hands the
  // hook a top-level `;` list already rewritten into newlines, so
  // `npm test; ./deploy.sh` arrives here as `npm test\n./deploy.sh`. Verified on
  // a real pty.
  if (/[;&|<>`$(){}\n\r]/.test(cmdline)) return false;
  // Only after the raw string is known clean, fold runs of spaces and tabs so
  // `npm   test` still matches the whitelist. Deliberately NOT `\s`, which would
  // reintroduce exactly the collapse this function was broken by.
  const norm = cmdline.trim().replace(/[ \t]+/g, " ");
  return SAFE_TO_RERUN.some((s) => norm === s || norm.startsWith(`${s} `));
}
