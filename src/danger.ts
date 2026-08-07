#!/usr/bin/env node
/**
 * `danger` — run a command; when it breaks, get help.
 *
 * This is the shell-adjacent half of underclass. It does not replace your shell
 * and does not sit in front of every command: you invoke it, it runs what you
 * asked, and if the command fails it hands the failure to `under` with the
 * context a human would have wanted (the command, the exit code, the output, the
 * repo state).
 *
 * Deliberately NOT what `docs/danger-terminal/DESIGN.md` calls v0a. That design
 * builds a checkpoint/undo substrate first and adds intelligence later, which is
 * the right order for a tool that edits without asking. This one asks. The
 * safety property here is consent, not rollback — which is why `--yolo` prints
 * what it is about to allow, and why we do not pretend an undo exists.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";

const VERSION = "0.1.0-alpha.1";

const HELP = `danger ${VERSION} — your shell, with help when you need it

Run a command:
  danger <command> [args...]        run it; on failure, offer to diagnose
  danger --yolo <command> [args...] on failure, let the agent fix it and re-run
  danger --explain <command> ...    explain the failure, never edit anything

Without running anything:
  danger why                        explain the last command that failed
  danger why <status> <command>     explain a specific failure
  danger edit <file> "<change>"     one small edit to one file, diff first

Live in it:
  danger shell                      a subshell with the integration loaded.
                                    Changes nothing on disk. Start here.
  danger init                       install into ~/.zshrc (one line, reversible)
  danger init --login-shell         also set up the \`chsh\` path
  danger uninstall-shell            remove it

Options:
  --yolo             allow the agent to EDIT FILES to fix the failure.
                     There is no undo. Commit or stash first.
  --explain          diagnose only; the agent gets read-only tools
  --retries <n>      with --yolo, attempt at most n fix-and-retry cycles (default 1)
  --yes              with \`edit\`, skip the confirmation prompt
  -h, --help         show this help
  -V, --version      show version

Examples:
  danger npm test
  danger --explain cargo build
  danger edit src/app.ts "add a null check before the parse call"

The shell integration is zsh — the same binary and your own config, plus:
  Tab on a description          writes the command  (also Ctrl-X Ctrl-A)
  a command that is not found   says how to install it
  a command that failed         gets a one-line hint

Everything danger knows about your models comes from \`under\`, so configure once:
  under setup        pick and verify an endpoint
  under doctor       check it still works
`;

/**
 * What the shell wrapper function told us about the last failure.
 *
 * Passed as environment rather than written to a file: a state file would need a
 * write on every failed command, and would then be wrong in every other terminal
 * tab. Environment means "the shell you asked in", which is what the user means.
 */
function lastFailureFromEnv(): { cmd: string; status: number; cwd: string } | null {
  const cmd = process.env.DANGER_LAST_CMD;
  const status = Number(process.env.DANGER_LAST_STATUS);
  if (!cmd || !Number.isInteger(status) || status === 0) return null;
  return { cmd, status, cwd: process.env.DANGER_LAST_CWD || process.cwd() };
}

function reportInit(r: { rc: string; action: string; plugin: string; loginStub?: string }): number {
  const said =
    r.action === "added"
      ? `danger: added the integration to ${r.rc}`
      : r.action === "updated"
        ? `danger: updated the integration in ${r.rc}`
        : `danger: already installed in ${r.rc}`;
  console.error(said);
  console.error(`\x1b[2m  plugin: ${r.plugin}\x1b[0m`);
  console.error("");
  console.error("  Open a new shell, or:  source " + r.rc);
  console.error("");
  console.error("  Then: type a description of what you want and press Tab.");
  console.error("\x1b[2m  Undo any time:  danger uninstall-shell\x1b[0m");
  if (r.loginStub) {
    console.error("");
    console.error("  To make it your login shell — this stays zsh, it only sets ZDOTDIR:");
    console.error(`    sudo sh -c 'echo ${r.loginStub} >> /etc/shells'`);
    console.error(`    chsh -s ${r.loginStub}`);
    console.error(`\x1b[2m  Undo:  chsh -s ${process.env.SHELL ?? "/bin/zsh"}\x1b[0m`);
  }
  return 0;
}

/** Resolve the sibling `under` entrypoint, whether installed or run from source. */
function underEntry(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const c of [join(here, "index.js"), join(here, "..", "dist", "index.js")]) {
    if (existsSync(c)) return c;
  }
  return null;
}

function gitDirty(cwd: string): string | null {
  const r = spawnSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  if (r.status !== 0) return null;
  const out = (r.stdout ?? "").trim();
  return out ? out.split("\n").slice(0, 20).join("\n") : "";
}

interface Outcome {
  code: number | null;
  output: string;
}

/** Run the user's command, streaming it through, while capturing a tail for context. */
function runCommand(cmd: string, args: string[], cwd: string): Promise<Outcome> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ["inherit", "pipe", "pipe"], env: process.env });
    let tail = "";
    const cap = (chunk: Buffer, to: NodeJS.WriteStream) => {
      to.write(chunk);
      // Keep the last ~8KB: failures explain themselves at the end, not the start.
      tail = (tail + chunk.toString()).slice(-8000);
    };
    child.stdout?.on("data", (c) => cap(c, process.stdout));
    child.stderr?.on("data", (c) => cap(c, process.stderr));
    child.on("error", (err) => resolve({ code: 127, output: `${tail}\n${err.message}` }));
    child.on("exit", (code) => resolve({ code, output: tail }));
  });
}

function buildPrompt(cmd: string, args: string[], o: Outcome, dirty: string | null, mayEdit: boolean): string {
  const cmdline = [cmd, ...args].join(" ");
  const lines = [
    `A command failed in this repository. ${mayEdit ? "Fix it." : "Explain why, and what to change. Do not edit anything."}`,
    "",
    `Command: ${cmdline}`,
    `Exit code: ${o.code}`,
    "",
    "Output (tail):",
    "```",
    o.output.trim().slice(-4000) || "(no output)",
    "```",
  ];
  if (dirty) {
    lines.push("", "Uncommitted changes are present — be careful not to discard them:", "```", dirty, "```");
  }
  if (mayEdit) {
    lines.push(
      "",
      "Make the smallest change that fixes the actual cause. Do not rewrite unrelated code,",
      "do not disable or delete the failing test, and do not change the command's contract to",
      "make it pass. When done, say in one line what you changed and why.",
    );
  }
  return lines.join("\n");
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") {
    console.log(HELP);
    return argv.length === 0 ? 1 : 0;
  }
  if (argv[0] === "-V" || argv[0] === "--version") {
    console.log(`danger ${VERSION}`);
    return 0;
  }

  // Subcommands are checked before flag parsing: they are the paths that do not
  // run a command, and folding them into the "run this" flow is how you end up
  // executing a binary called `why`.
  const sub = argv[0];
  if (sub === "shell") {
    const { subshell } = await import("./shell/install.js");
    return subshell();
  }
  if (sub === "init") {
    const { init } = await import("./shell/install.js");
    return reportInit(init({ loginShell: argv.includes("--login-shell") }));
  }
  if (sub === "uninstall-shell") {
    const { uninstall } = await import("./shell/install.js");
    const r = uninstall();
    console.error(
      r.removed
        ? `danger: removed the integration from ${r.rc}. Open a new shell.`
        : `danger: nothing to remove in ${r.rc}.`,
    );
    return 0;
  }
  if (sub === "why") {
    const { why } = await import("./shell/assist.js");
    // `danger why` with no arguments reads what the shell hook recorded. Without
    // the integration installed there is nothing to read, and saying so beats
    // diagnosing a failure that never happened.
    const st = Number(argv[1]);
    if (Number.isInteger(st) && argv[2]) {
      return await why(argv.slice(2).join(" "), st, process.cwd());
    }
    const last = lastFailureFromEnv();
    if (!last) {
      console.error(
        "danger: no recorded failure. `danger why <exit-status> <command>` works without the\n" +
          "  shell integration; `danger init` makes the no-argument form work.",
      );
      return 1;
    }
    return await why(last.cmd, last.status, last.cwd);
  }
  if (sub === "edit") {
    const { edit } = await import("./shell/assist.js");
    const rest2 = argv.slice(1).filter((a) => a !== "--yes");
    const [file, ...instr] = rest2;
    if (!file || instr.length === 0) {
      console.error('danger: usage: danger edit <file> "<what to change>"');
      return 1;
    }
    return await edit(file, instr.join(" "), process.cwd(), { yes: argv.includes("--yes") });
  }
  if (sub === "_suggest") {
    // Internal: called by the ZLE widget. stdout is the command line, nothing
    // else, because the widget puts stdout straight into the user's buffer.
    const { suggest } = await import("./shell/assist.js");
    const dashdash = argv.indexOf("--");
    const prose = dashdash === -1 ? "" : argv.slice(dashdash + 1).join(" ");
    const tIdx = argv.indexOf("--timeout");
    const cIdx = argv.indexOf("--cwd");
    const timeout = tIdx === -1 ? 25 : Number(argv[tIdx + 1]) || 25;
    const cwd = cIdx === -1 ? process.cwd() : argv[cIdx + 1] ?? process.cwd();
    if (!prose.trim()) return 1;
    const out = await suggest(prose, cwd, timeout * 1000);
    if (!out) return 1;
    process.stdout.write(`${out}\n`);
    return 0;
  }

  let yolo = false;
  let explain = false;
  let retries = 1;
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--yolo") yolo = true;
    else if (a === "--explain") explain = true;
    else if (a === "--retries") retries = Math.max(1, Number(argv[++i]) || 1);
    else break;
  }
  const rest = argv.slice(i);
  if (rest.length === 0) {
    console.error("danger: no command given. Try `danger npm test` or `danger --help`.");
    return 1;
  }
  if (yolo && explain) {
    console.error("danger: --yolo and --explain contradict each other. Pick one.");
    return 1;
  }

  const cwd = process.cwd();
  const entry = underEntry();
  const [cmd, ...args] = rest as [string, ...string[]];

  let attempt = 0;
  let outcome = await runCommand(cmd, args, cwd);
  if (outcome.code === 0) return 0;

  while (true) {
    console.error(`\n\x1b[31mdanger: \`${[cmd, ...args].join(" ")}\` exited ${outcome.code}\x1b[0m`);
    if (!entry) {
      console.error("danger: cannot find the `under` agent next to this binary — reinstall the package.");
      return outcome.code ?? 1;
    }

    // Consent is the safety property here, so ask unless told not to. There is
    // no checkpoint substrate yet: an edit that goes wrong has no undo, and
    // saying so is more useful than implying protection we have not built.
    const mayEdit = yolo;
    if (!yolo && !explain) {
      if (!process.stdin.isTTY) {
        console.error("danger: not a terminal, so not prompting. Re-run with --explain or --yolo.");
        return outcome.code ?? 1;
      }
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const ans = (await rl.question("danger: ask the agent about this? [E]xplain / [f]ix / [n]o: ")).trim().toLowerCase();
      rl.close();
      if (ans.startsWith("n")) return outcome.code ?? 1;
      if (ans.startsWith("f")) {
        const dirty = gitDirty(cwd);
        if (dirty) {
          console.error(
            "\x1b[33mdanger: you have uncommitted changes and there is no undo yet. Commit or stash first.\x1b[0m",
          );
          return outcome.code ?? 1;
        }
        return await invokeUnder(entry, buildPrompt(cmd, args, outcome, dirty, true), cwd, true, cmd, args, retries, attempt);
      }
      return await invokeUnder(entry, buildPrompt(cmd, args, outcome, null, false), cwd, false, cmd, args, 1, attempt);
    }

    if (mayEdit) {
      console.error("\x1b[33mdanger: --yolo — the agent may edit files. There is no undo.\x1b[0m");
    }
    return await invokeUnder(
      entry,
      buildPrompt(cmd, args, outcome, gitDirty(cwd), mayEdit),
      cwd,
      mayEdit,
      cmd,
      args,
      retries,
      attempt,
    );
  }
}

/** Hand the failure to `under`, then optionally re-run the command to check. */
async function invokeUnder(
  entry: string,
  prompt: string,
  cwd: string,
  mayEdit: boolean,
  cmd: string,
  args: string[],
  retries: number,
  attempt: number,
): Promise<number> {
  const readOnly = ["--tools", "read,grep,find,ls,repo_search"];
  const underArgs = [entry, ...(mayEdit ? [] : readOnly), prompt];
  await new Promise<void>((resolve) => {
    const child = spawn(process.execPath, underArgs, { cwd, stdio: "inherit", env: process.env });
    child.on("exit", () => resolve());
    child.on("error", () => resolve());
  });

  if (!mayEdit) return 1; // explained, not fixed — the original failure stands

  console.error(`\n\x1b[2mdanger: re-running \`${[cmd, ...args].join(" ")}\`…\x1b[0m`);
  const again = await runCommand(cmd, args, cwd);
  if (again.code === 0) {
    console.error(`\x1b[32mdanger: fixed — the command now passes.\x1b[0m`);
    return 0;
  }
  if (attempt + 1 < retries) {
    console.error(`\x1b[33mdanger: still failing; attempt ${attempt + 2} of ${retries}.\x1b[0m`);
    return await invokeUnder(entry, prompt, cwd, mayEdit, cmd, args, retries, attempt + 1);
  }
  console.error(`\x1b[31mdanger: still failing after ${retries} attempt(s). Review the diff before trusting it.\x1b[0m`);
  return again.code ?? 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error(`danger: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  },
);
