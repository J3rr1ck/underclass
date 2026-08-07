/**
 * The model-backed half of the shell integration.
 *
 * Everything here is a SINGLE completion call — no agent loop, no tool calls,
 * no session. That is the whole point. `under` costs about 61K tokens and 100
 * seconds on a real task because it reads files, reasons, edits and verifies.
 * Turning "find files over 100mb" into a `find` invocation does not need any of
 * that, and paying for it is why people stop reaching for the tool.
 *
 * Three entry points, in increasing order of what they are allowed to touch:
 *
 *   suggest()  writes a command line. Touches nothing — the user presses Enter.
 *   why()      explains a failure. Read-only; may re-run a whitelisted command.
 *   edit()     rewrites one file, after showing a diff and asking.
 *
 * Anything larger is `under`'s job, and suggest() is told to say so: asked to
 * "refactor the auth module", it should answer `under "refactor the auth
 * module"` rather than attempt it. The routing decision is thereby made by the
 * cheap model, shown to the user as a command, and executed only on Enter.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { loadModelMap, tierModel, type Tier } from "../model-map.js";
import { underDir } from "../config.js";
import { UNDER_VERSION, DEFAULT_DANGER_BASE, DEFAULT_DANGER_MODEL, DEFAULT_GUEST_KEY, LMSTUDIO_BASE } from "../config.js";
import { installHint, safeToRerun, statusHint } from "./rules.js";

export interface Endpoint {
  baseUrl: string;
  model: string;
  apiKey?: string;
}

/**
 * Where to send a one-shot request.
 *
 * Deliberately does NOT reuse the agent's provider negotiation, which probes
 * `/models` on up to three endpoints with retries. That costs seconds, and
 * these calls exist because the user pressed a key and is waiting. The model
 * map is a cached judgement read from disk, so consulting it is free.
 */
export function shellEndpoint(cwd: string, tier: Tier = "tiny"): Endpoint {
  const map = loadModelMap(cwd);
  const t = tierModel(map, tier);
  if (t?.baseUrl) return { baseUrl: t.baseUrl, model: t.model };
  if (t) {
    // A tier naming a model but no endpoint means "wherever the agent goes",
    // and the only base URL we can know without probing is the local default.
    return { baseUrl: process.env.UNDERCLASS_LMSTUDIO_BASE ?? LMSTUDIO_BASE, model: t.model };
  }
  return {
    baseUrl: process.env.UNDERCLASS_DANGER_BASE ?? DEFAULT_DANGER_BASE,
    model: process.env.UNDERCLASS_DANGER_MODEL ?? DEFAULT_DANGER_MODEL,
    apiKey: process.env.UNDERCLASS_API_KEY ?? DEFAULT_GUEST_KEY,
  };
}


/**
 * Remember that an endpoint is unreachable, briefly, and stop dialling it.
 *
 * Without this every Tab press pays the full timeout to rediscover that the LAN
 * box is asleep — 8 s of frozen terminal for a guaranteed failure, on a key
 * people press by reflex. `why` pays 60 s.
 *
 * The TTL is deliberately short. This is a latency optimisation, not a circuit
 * breaker: a machine that wakes up should start working again within a minute
 * without anyone clearing state. And only NETWORK failures mark an endpoint
 * down — an HTTP 4xx/5xx means the server answered, so the endpoint is fine and
 * the request was not.
 */
const DOWN_TTL_MS = 45_000;

function downStatePath(): string {
  return join(underDir(), "endpoint-state.json");
}

type DownState = Record<string, { until: number; reason: string }>;

function readDownState(): DownState {
  try {
    return JSON.parse(readFileSync(downStatePath(), "utf8")) as DownState;
  } catch {
    return {};
  }
}

/** Why this endpoint is skipped, or null if it should be tried. */
export function endpointDownReason(baseUrl: string): string | null {
  if (process.env.UNDER_NO_ENDPOINT_CACHE) return null;
  const e = readDownState()[baseUrl];
  if (!e || Date.now() > e.until) return null;
  return e.reason;
}

export function markEndpointDown(baseUrl: string, reason: string): void {
  try {
    const st = readDownState();
    st[baseUrl] = { until: Date.now() + DOWN_TTL_MS, reason };
    // Drop expired entries so the file cannot grow without bound.
    for (const [k, v] of Object.entries(st)) if (Date.now() > v.until + DOWN_TTL_MS) delete st[k];
    writeFileSync(downStatePath(), JSON.stringify(st), { mode: 0o600 });
  } catch {
    /* best effort — never let bookkeeping break a run */
  }
}

export function markEndpointUp(baseUrl: string): void {
  try {
    const st = readDownState();
    if (!st[baseUrl]) return;
    delete st[baseUrl];
    writeFileSync(downStatePath(), JSON.stringify(st), { mode: 0o600 });
  } catch {
    /* best effort */
  }
}

/**
 * Is this a "the network said no" failure, as opposed to a slow or angry server?
 *
 * Only these justify skipping the endpoint next time. A timeout deliberately
 * does NOT: a model can legitimately take longer than the caller allowed, and
 * treating that as "down" would disable the feature on a busy but working host.
 */
function isNetworkDown(err: unknown): string | null {
  const code = (err as { cause?: { code?: string }; code?: string })?.cause?.code ?? (err as { code?: string })?.code;
  switch (code) {
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return "host does not resolve";
    case "EHOSTUNREACH":
    case "ENETUNREACH":
    case "ENETDOWN":
      return "no route to host";
    case "ECONNREFUSED":
      return "nothing listening on that port";
    case "ECONNRESET":
      return "connection reset";
    default:
      return null;
  }
}

/** One completion call. Returns null on any failure — a suggestion is optional. */
export async function complete(
  ep: Endpoint,
  system: string,
  user: string,
  opts: { maxTokens?: number; timeoutMs?: number } = {},
): Promise<string | null> {
  // Known unreachable: fail in microseconds rather than burning the timeout.
  if (endpointDownReason(ep.baseUrl)) return null;
  try {
    const res = await fetch(`${ep.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      signal: AbortSignal.timeout(opts.timeoutMs ?? 25_000),
      headers: {
        "content-type": "application/json",
        // Cloudflare's WAF in front of api.danger.plus 403s the OpenAI SDK's own
        // user agent. Ours gets through; see docs/ENDPOINTS.md.
        "user-agent": `underclass/${UNDER_VERSION}`,
        ...(ep.apiKey ? { authorization: `Bearer ${ep.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: ep.model,
        max_tokens: opts.maxTokens ?? 300,
        temperature: 0,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    // Any HTTP answer proves the endpoint is alive, even an error one.
    markEndpointUp(ep.baseUrl);
    if (!res.ok) return null;
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = json?.choices?.[0]?.message?.content;
    return typeof text === "string" && text.trim() ? text : null;
  } catch (err) {
    const down = isNetworkDown(err);
    if (down) markEndpointDown(ep.baseUrl, down);
    return null;
  }
}


/**
 * Why can't we reach the model, and what fixes it — in one line each.
 *
 * "no model reachable" is a true statement and a useless one. The three causes
 * look identical from the caller and have completely different fixes, so this
 * separates them by probing DNS before the socket:
 *
 *   does not resolve   the host is off, asleep, or you are on another network
 *   resolves, refused  the server is not running on that port
 *   resolves, blocked  macOS Local Network privacy (curl works, node does not)
 *
 * The third is the one nobody guesses. macOS gates LAN access per-binary, so a
 * terminal that has never been granted it gets EHOSTUNREACH from node while curl
 * from the same shell succeeds — which reads as "the server is down" and is not.
 */
export async function diagnoseEndpoint(ep: Endpoint): Promise<string> {
  const host = (() => {
    try {
      return new URL(ep.baseUrl).hostname;
    } catch {
      return "";
    }
  })();
  const isLocal = /^(localhost|127\.|::1|0\.0\.0\.0)/.test(host);
  const lines: string[] = [`danger: cannot reach ${ep.baseUrl}`];

  // Resolution first: a host that does not resolve is not a firewall problem.
  let resolves = false;
  try {
    const { lookup } = await import("node:dns/promises");
    await lookup(host);
    resolves = true;
  } catch {
    resolves = false;
  }

  if (!resolves && !isLocal) {
    lines.push(
      `  \`${host}\` does not resolve — the machine is off, asleep, or you are on a different network.`,
      `  Quick fixes, cheapest first:`,
      `    ping ${host}                        # confirm it is really away`,
      `    caffeinate -s                       # …on that machine, so it stops sleeping`,
      `    export UNDERCLASS_LMSTUDIO_BASE=http://<its-ip>:1234/v1   # if mDNS is the problem, not the host`,
    );
  } else if (isLocal) {
    lines.push(
      `  Nothing is listening on ${host}. Start LM Studio (Developer → Start Server) or \`ollama serve\`.`,
    );
  } else {
    lines.push(
      `  \`${host}\` resolves but is not answering.`,
      `  If \`curl ${ep.baseUrl}/models\` works and this does not, it is macOS Local Network privacy:`,
      `    System Settings → Privacy & Security → Local Network → enable your terminal`,
    );
  }

  lines.push(
    ``,
    `  Or use a hosted endpoint instead of the LAN one — no local server needed:`,
    `    export UNDERCLASS_API_BASE=${DEFAULT_DANGER_BASE}`,
    `    under --list-providers              # groq, openrouter, venice, … if you have a key`,
    `  \`under doctor\` checks all of them and names what is wrong with each.`,
  );
  return lines.join("\n");
}

/** Cheap, fork-few facts about where the user is. Bounded so the prompt stays small. */
function shellContext(cwd: string): string {
  const bits: string[] = [`Directory: ${cwd}`, `Platform: ${process.platform}`];
  const run = (cmd: string, args: string[]): string => {
    try {
      return execFileSync(cmd, args, { cwd, encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return "";
    }
  };
  const branch = run("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch) {
    bits.push(`Git branch: ${branch}`);
    const dirty = run("git", ["status", "--porcelain"]);
    bits.push(dirty ? `Uncommitted changes:\n${dirty.split("\n").slice(0, 12).join("\n")}` : "Working tree clean");
  }
  // Naming the project type is what lets the model answer "run the tests"
  // correctly, and it costs one stat per candidate rather than a model call.
  const markers: Array<[string, string]> = [
    ["package.json", "Node/npm"], ["Cargo.toml", "Rust/cargo"], ["go.mod", "Go"],
    ["pyproject.toml", "Python"], ["requirements.txt", "Python"], ["build.gradle.kts", "Android/Gradle"],
    ["build.gradle", "Gradle"], ["Package.swift", "Swift"], ["Makefile", "make"], ["pom.xml", "Maven"],
  ];
  const found = markers.filter(([f]) => existsSync(resolve(cwd, f))).map(([, k]) => k);
  if (found.length) bits.push(`Project: ${[...new Set(found)].join(", ")}`);
  return bits.join("\n");
}

const SUGGEST_SYSTEM = `You turn a description of a task into ONE shell command for zsh on the user's machine.

Reply with the command and NOTHING else. No explanation, no markdown fence, no backticks, no leading
$. One line. If it genuinely needs several commands, join them with && on that one line.

You have three special commands available, and you should prefer them when they fit:
- \`under "<task>"\`  — a coding agent. Use for anything that needs to read code, reason about it, or
  edit more than one file. Do not attempt such work yourself; emit this instead.
- \`danger edit <file> "<instruction>"\` — one small edit to one named file, shown as a diff first.
  Use when the user describes a specific change to a specific file.
- \`danger <command>\` — runs a command and offers help if it fails. Use when the user is clearly
  about to debug something.

Rules:
- Prefer the tool the project actually uses. A Node project runs \`npm test\`, not \`jest\`.
- Never invent flags. If you are unsure a flag exists, leave it out.
- Quote paths that could contain spaces.
- If the request is destructive, still emit the command the user asked for — they review it before it
  runs — but prefer the reversible form (\`trash\` over \`rm\` when available, \`git restore\` over
  \`git checkout --\`).
- If you cannot form a sensible command, emit exactly: under "<the user's request verbatim>"`;

/** Turn prose into a command line. Called from the ZLE widget; stdout is the command. */
export async function suggest(prose: string, cwd: string, timeoutMs: number): Promise<string | null> {
  const ep = shellEndpoint(cwd, "tiny");
  const out = await complete(ep, SUGGEST_SYSTEM, `${shellContext(cwd)}\n\nRequest: ${prose}`, {
    maxTokens: 200,
    timeoutMs,
  });
  if (!out) return null;
  return cleanCommand(out);
}

/**
 * Strip what models add no matter how firmly you ask them not to.
 *
 * Exported because it is the part most likely to be wrong on a model nobody has
 * tried yet, and therefore the part that most needs tests.
 */
export function cleanCommand(raw: string): string | null {
  let s = raw.trim();
  // Fenced blocks, with or without a language tag.
  const fence = s.match(/```(?:[a-z]*\n)?([\s\S]*?)```/);
  if (fence?.[1]) s = fence[1].trim();
  // Reasoning models emit a think block before the answer.
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  // First non-empty, non-comment line.
  const line = s
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("#"));
  if (!line) return null;
  return line
    .replace(/^`+|`+$/g, "")
    .replace(/^\$\s+/, "")
    .trim() || null;
}

const WHY_SYSTEM = `You explain why a shell command failed, for an experienced developer.

Be brief: at most four lines. First line names the cause. Following lines give the fix as a command
they can run. No preamble, no "I hope this helps", no restating the question.

If the output does not actually show the cause, say so in one line rather than guessing. A confident
wrong diagnosis costs more than an honest "the output does not say why".`;

/**
 * Explain the last failure.
 *
 * The hard constraint: zsh hooks see the command and the exit code and no
 * output at all, so unless the command is on the re-run whitelist there is no
 * error text to diagnose. Rather than invent one, we re-run what is safe to
 * re-run, and otherwise reason from the command line while saying that is all
 * we had.
 */
export async function why(
  cmdline: string,
  status: number,
  cwd: string,
  opts: { rerun?: boolean } = {},
): Promise<number> {
  const cmd0 = (cmdline.trim().split(/\s+/)[0] ?? "").split("/").pop() ?? "";
  let rule = statusHint(status, cmd0);
  // A missing command usually has a concrete answer sitting in the install
  // table, and that answer needs no model — which matters most precisely when
  // the endpoint is down, since that is when `why` is otherwise useless.
  if (status === 127) {
    const install = installHint(cmd0);
    if (install) rule = `\`${cmd0}\` is not installed. ${install}`;
  }

  let output = "";
  let rerun = false;
  if (opts.rerun !== false && safeToRerun(cmdline)) {
    process.stderr.write(`\x1b[2mdanger: re-running \`${cmdline}\` to capture its output…\x1b[0m\n`);
    const r = spawnSync(process.env.SHELL ?? "/bin/zsh", ["-c", cmdline], {
      cwd,
      encoding: "utf8",
      timeout: 180_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    output = `${r.stdout ?? ""}\n${r.stderr ?? ""}`.trim().slice(-6000);
    rerun = true;
  }

  if (rule) process.stdout.write(`\x1b[1m${rule}\x1b[0m\n`);

  const ep = shellEndpoint(cwd, output ? "normal" : "tiny");
  const parts = [
    shellContext(cwd),
    "",
    `Command: ${cmdline}`,
    `Exit code: ${status}`,
    output
      ? `\nOutput (from re-running it):\n\`\`\`\n${output}\n\`\`\``
      : `\nNo output was captured — the shell hook that noticed this failure does not see output, and`
        + ` this command was not on the safe-to-re-run list. Diagnose from the command line and the`
        + ` exit code, and say plainly if that is not enough.`,
  ];
  const answer = await complete(ep, WHY_SYSTEM, parts.join("\n"), { maxTokens: 400, timeoutMs: 60_000 });
  if (!answer) {
    if (!rule) {
      process.stderr.write(
        `${await diagnoseEndpoint(ep)}\n`,
      );
      return 1;
    }
    return 0;
  }
  process.stdout.write(`${answer.replace(/<think>[\s\S]*?<\/think>/gi, "").trim()}\n`);
  if (!rerun && !output) {
    process.stderr.write(
      `\x1b[2mdanger: this was diagnosed without the command's output. \`danger ${cmdline}\` re-runs it and captures it.\x1b[0m\n`,
    );
  }
  return 0;
}

const EDIT_SYSTEM = `You make one small edit to one file.

Output the COMPLETE new contents of the file and nothing else. No fence, no commentary, no
explanation before or after. Preserve everything you were not asked to change — indentation style,
trailing newline, comment style, import order.

If the requested change is too large for a whole-file rewrite to be safe, or you cannot tell what is
being asked, output exactly: REFUSE: <one line saying why>`;

/**
 * The light-edit fast path.
 *
 * Whole-file rewrite rather than a patch, because a small model producing a
 * valid unified diff is a coin flip and a malformed patch is worse than no
 * patch. Bounded by size instead: over the limit, this refuses and hands off to
 * `under`, which has the tools to edit a large file surgically.
 *
 * The user sees a real `git diff` and answers a real question before anything
 * is written. That is the only safety property claimed here.
 */
export async function edit(
  file: string,
  instruction: string,
  cwd: string,
  opts: { yes?: boolean; maxBytes?: number } = {},
): Promise<number> {
  const maxBytes = opts.maxBytes ?? 60_000;
  const abs = resolve(cwd, file);

  // Stay inside the directory the user invoked us from. `resolve` handles `..`,
  // and `relative` is the check that actually catches escapes — a startsWith
  // test passes `/home/user-evil` against `/home/user`.
  const rel = relative(cwd, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    process.stderr.write(`danger: ${file} is outside ${cwd}. Run danger from a directory that contains it.\n`);
    return 1;
  }
  if (!existsSync(abs)) {
    process.stderr.write(`danger: ${file} does not exist. \`danger edit\` changes files, it does not create them.\n`);
    return 1;
  }

  const before = readFileSync(abs, "utf8");
  if (Buffer.byteLength(before) > maxBytes) {
    process.stderr.write(
      `danger: ${file} is ${Math.round(Buffer.byteLength(before) / 1024)}KB — too big to rewrite wholesale.\n` +
        `  This is what \`under\` is for:  under "${instruction.replace(/"/g, '\\"')} in ${file}"\n`,
    );
    return 1;
  }
  if (before.includes("\0")) {
    process.stderr.write(`danger: ${file} looks binary.\n`);
    return 1;
  }

  const ep = shellEndpoint(cwd, "tiny");
  process.stderr.write(`\x1b[2mdanger: asking ${ep.model}…\x1b[0m\n`);
  const out = await complete(
    ep,
    EDIT_SYSTEM,
    `File: ${file}\n\nCurrent contents:\n${before}\n\nChange to make: ${instruction}`,
    // Headroom for the whole file back plus slack; a truncated reply would
    // otherwise silently become a file with its tail cut off.
    { maxTokens: Math.ceil(before.length / 3) + 800, timeoutMs: 120_000 },
  );
  if (!out) {
    process.stderr.write("danger: no answer from the model. `under doctor` checks the endpoint.\n");
    return 1;
  }

  let after = out.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  if (after.startsWith("REFUSE:")) {
    process.stderr.write(`danger: ${after.slice(7).trim()}\n`);
    return 1;
  }
  // Models fence file contents about half the time regardless of instruction.
  const fence = after.match(/^```(?:[a-z0-9]*\n)?([\s\S]*?)```$/);
  if (fence?.[1]) after = fence[1];
  // Preserve the original trailing-newline convention: a rewrite that drops it
  // shows up as a spurious hunk in every future diff of the file.
  if (before.endsWith("\n") && !after.endsWith("\n")) after += "\n";

  if (after === before) {
    process.stderr.write("danger: the model returned the file unchanged.\n");
    return 1;
  }
  // A reply far shorter than the original is the truncation failure mode, and
  // it looks exactly like a successful edit right up until you lose the tail.
  if (after.length < before.length * 0.5) {
    process.stderr.write(
      `danger: the reply is ${Math.round((after.length / before.length) * 100)}% of the original size —\n` +
        `  that is usually a truncated response, not an edit. Refusing to write it.\n` +
        `  Try:  under "${instruction.replace(/"/g, '\\"')} in ${file}"\n`,
    );
    return 1;
  }

  showDiff(abs, before, after, cwd);

  if (!opts.yes) {
    if (!process.stdin.isTTY) {
      process.stderr.write("danger: not a terminal, so not writing without confirmation. Re-run with --yes.\n");
      return 1;
    }
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    const ans = (await rl.question("danger: apply this? [y/N] ")).trim().toLowerCase();
    rl.close();
    if (!ans.startsWith("y")) {
      process.stderr.write("danger: not applied.\n");
      return 1;
    }
  }

  writeFileSync(abs, after, "utf8");
  process.stderr.write(`\x1b[32mdanger: wrote ${file}\x1b[0m\n`);
  return 0;
}

/**
 * Show the change as a diff, using git's when we can and a plain one otherwise.
 *
 * The proposed contents do not exist on disk yet — that is the entire point of
 * showing them first — so git needs them written somewhere. A temp file next to
 * nothing important, removed in a finally, is cheaper than teaching the plain
 * differ to colourize and count hunks like git already does.
 */
function showDiff(abs: string, before: string, after: string, cwd: string): void {
  let tmp: string | null = null;
  try {
    tmp = join(mkdtempSync(join(tmpdir(), "danger-")), basename(abs));
    writeFileSync(tmp, after, "utf8");
    const r = spawnSync(
      "git",
      ["--no-pager", "diff", "--no-index", "--color=always", "--", abs, tmp],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    // `--no-index` exits 1 when the files differ, which is the expected case
    // here; only a missing git or a usage error produces no hunks at all.
    if (r.stdout?.includes("@@")) {
      process.stderr.write(`${r.stdout}\n`);
      return;
    }
  } catch {
    /* fall through to the built-in differ */
  } finally {
    if (tmp) rmSync(dirname(tmp), { recursive: true, force: true });
  }
  process.stderr.write(`${plainDiff(before, after)}\n`);
}

/**
 * A minimal line diff for when git will not cooperate.
 *
 * Not an LCS: it finds the common prefix and suffix and reports the middle. For
 * a single small edit — which is the only thing this path produces — that is
 * exactly the right hunk, and it cannot be quadratic on a large file.
 */
export function plainDiff(before: string, after: string): string {
  const a = before.split("\n");
  const b = after.split("\n");
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;

  const out: string[] = [];
  const ctx = 2;
  for (let i = Math.max(0, head - ctx); i < head; i++) out.push(`  ${a[i]}`);
  for (let i = head; i < a.length - tail; i++) out.push(`\x1b[31m- ${a[i]}\x1b[0m`);
  for (let i = head; i < b.length - tail; i++) out.push(`\x1b[32m+ ${b[i]}\x1b[0m`);
  for (let i = a.length - tail; i < Math.min(a.length, a.length - tail + ctx); i++) out.push(`  ${a[i]}`);
  return out.join("\n");
}
