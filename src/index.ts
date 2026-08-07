#!/usr/bin/env node

/**
 * This is the CLI entry point for the under coding agent.
 * It handles argument parsing, model selection, and manages the 
 * interaction loop between the user and the AI agent.
 */
import { setDefaultResultOrder } from "node:dns";
import { createInterface } from "node:readline/promises";
// Type-only: erased at compile time, so it costs nothing to import here.
// The class is aliased because the runtime value of the same name is
// destructured from the lazy import below and would otherwise shadow it.
import type {
  ToolDefinition,
  DefaultResourceLoader as ResourceLoaderInstance,
} from "@earendil-works/pi-coding-agent";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { bareModelId, checkEndpoint, contextTooSmall, contextTooTight, loadPresets, pickModelSpec, piAgentDir, underDir, writeModelsJson, type UnderOptions } from "./config.js";
// The tool modules and the agent SDK are loaded lazily inside the agent path.
// Importing them costs ~14s (the SDK pulls in the whole model runtime), which
// `doctor`, `setup`, `--help` and `--list-providers` were all paying for
// nothing. Measured: SDK import 14,057 ms vs 42 ms for doctor's own modules.
async function loadAgentRuntime() {
  const [sdk, repoSearch, hashEdit, batchEdit, lineAnchored, fanOutTool, agentLoop] = await Promise.all([
    import("@earendil-works/pi-coding-agent"),
    import("./tools/repo-search.js"),
    import("./hash-edit.js"),
    import("./tools/batch-edit.js"),
    import("./tools/line-anchored-edit.js"),
    import("./tools/fan-out-tool.js"),
    import("./agent-loop.js"),
  ]);
  return {
    createAgentSession: sdk.createAgentSession,
    DefaultResourceLoader: sdk.DefaultResourceLoader,
    ModelRuntime: sdk.ModelRuntime,
    SessionManager: sdk.SessionManager,
    repoSearchTool: repoSearch.repoSearchTool,
    hashEditTool: hashEdit.hashEditTool,
    batchEditTool: batchEdit.batchEditTool,
    lineAnchoredEditTool: lineAnchored.lineAnchoredEditTool,
    createFanOutTool: fanOutTool.createFanOutTool,
    AutoCompactingSession: agentLoop.AutoCompactingSession,
  };
}
import { loadModelMap, mapEntry, classifyTask, tierModel, TIERS, IMPERATIVE_BOOST, type Tier } from "./model-map.js";
import { RunCollector, recordRun } from "./telemetry.js";
import { runLearn } from "./learn.js";
import { runDoctor } from "./doctor.js";
import { runSetup } from "./setup.js";
import { loadPreferences, rememberPreference } from "./preferences.js";
import { makePlan, planToPrompt } from "./planner.js";
import { fanOut, parseTaskSpec, type FanOutTask, type FanOutReport } from "./fanout.js";
import { createFanOutRunner, createWorkflowRunner, fanoutDepth, maxFanoutDepth } from "./runner.js";
import {
  listWorkflows,
  parsePoolSpec,
  resolveWorkflow,
  runWorkflow,
  type PoolEntry,
  type WorkflowReport,
} from "./workflow/index.js";

const VERSION = "0.1.0-alpha.1";

// Node 17+ returns DNS results verbatim, so an mDNS host like `gpu-box.local`
// can resolve to a link-local IPv6 address (fe80::…) first; fetch then fails
// instantly with an opaque "Connection error" even though the server is up and
// curl reaches it. Local model endpoints are exactly this case.
if (process.env.UNDER_DNS_ORDER !== "verbatim") setDefaultResultOrder("ipv4first");

const HELP = `under ${VERSION} — token-efficient coding agent (underclass.sh)

Usage:
  under [options] [prompt...]        one-shot task, or REPL when no prompt

Options:
  -m, --model <spec>     model as provider/model or bare id (e.g. lmstudio/qwen3)
      --provider <name>  a shipped preset (groq, openrouter, venice, tinfoil, …)
                         or a built-in: danger | lmstudio | ollama | custom
      --list-providers   list every preset and whether its key is set
      --lmstudio         shortcut for --provider lmstudio
      --ollama           shortcut for --provider ollama
      --base-url <url>   custom OpenAI-compatible endpoint (implies --provider custom)
      --api-key <key>    API key for the chosen endpoint
      --plan             plan with the model map's planning tier, then execute
                         the steps on the cheaper execution model. Buys insight
                         once; does the mechanical work locally. --no-plan opts out.
      --timeout <sec>    abort a one-shot run after this long (default: none)
      --tier <t>         route to a model-map tier: tiny | normal | thinking
                         (default: chosen from the task; ignored when -m is given)
      --tools <list>     comma-separated tools: read,bash,edit,write,grep,find,ls,
                         repo_search,hash_edit,batch_edit,line_anchored_edit,fan_out
      --free             use a zero-cost OpenRouter model, chosen at run time
                         from what is currently free AND tool-capable
      --list-free        show the free tool-capable models and their health
      --list-models      list resolvable models and exit
  -h, --help             show this help
  -V, --version          show version

Subcommands:
  setup                  guided first-run: find an endpoint, verify it, save it
  doctor                 phased readiness check, fast by default:
                           (default)   tools, project setup, endpoint reachability
                           --offline   filesystem only, no network
                           --deep      also fire a real tool call at the model
                           --benchmark also check the container runtime
  fan-out                spawn parallel agents in isolated git worktrees (see: under fan-out --help)
  workflow <script.mjs>  orchestrate agents from a script: phases, fan-in,
                         structured results, verification (see: under workflow --help)
  stats [--verbose]      what your models actually do, from recorded runs only
                         (--model <substr>, --since 7d|YYYY-MM-DD). No requests.
  learn [--apply]        derive model-map verdicts from recorded runs
  remember [--project] <text>
                         save a standing preference injected into future runs

Env:
  DANGER_API_KEY, UNDERCLASS_API_BASE, UNDERCLASS_MODEL, UNDERCLASS_ZERO_ENDPOINT
  UNDERCLASS_LMSTUDIO_BASE (default http://localhost:1234/v1)
  UNDERCLASS_OLLAMA_BASE   (default http://localhost:11434/v1)
`;

const FANOUT_HELP = `under fan-out — parallel agents across isolated git worktrees

Each task runs in its own \`git worktree\` on its own branch, concurrently.
With the full loop (default), each branch is committed and then merged into the
target one at a time; a conflicting branch is left intact for you to resolve.
With --pr, each committed branch is pushed to origin and a GitHub PR is opened
against the target branch instead of merging locally.

Usage:
  under fan-out [options]

Tasks (at least one required):
  --task "<branch>:<prompt>"   define a task; repeatable
  --tasks <file.json>          load tasks from JSON: [{ "branch", "prompt", "message"? }]

Options:
  --base <branch>        branch every worktree forks from (default: current)
  --target <branch>      merge target for the full loop (default: base)
  --no-merge             stop after per-branch commit; skip merging
  --pr                   push each branch and open a PR via \`gh\` (implies --no-merge)
  --concurrency <n>      max agents running at once (default: task count)
  --task-timeout <sec>   kill an agent and fail its task after this long (default: none)
  --keep-worktrees       don't delete worktrees/branches after merge
  --dry-run              print the plan and exit; touch nothing
  -h, --help             show this help

Model flags (forwarded to each agent): -m/--model, --provider,
  --lmstudio, --ollama, --base-url, --api-key

Example:
  under fan-out \\
    --task "feat/logging:add verbose logging to the CLI" \\
    --task "feat/readme:document each tool with an example" \\
    --concurrency 2
`;

const WORKFLOW_HELP = `under workflow — orchestrate agents from a script

Where fan-out runs one flat round of independent tasks, a workflow is a program:
phases, fan-out and fan-in, agents that return data you can branch on, and a
verification pass over what earlier agents claimed. Agents read the repo by
default; one that must write asks for its own worktree.

Usage:
  under workflow <name|script.mjs> [options]
  under workflow --list

A name resolves to <cwd>/.underclass/workflows/<name>.mjs if it exists, else to
a built-in. Built-in: review, understand.

A script declares a header, then uses the injected globals:

  export const meta = {
    name: 'review',
    description: 'Review the diff, then verify each finding',
    phases: [{ title: 'Review' }, { title: 'Verify' }],
  }
  phase('Review')
  const found = await agent('Find bugs in src/parse.ts', { schema: FINDINGS })
  if (!found) return { error: 'the reviewer failed' }   // a failed agent is null
  const checked = await parallel(found.bugs.map((b) => () =>
    agent(\`Try to refute: \${b.claim}\`, { schema: VERDICT, phase: 'Verify' })))
  return checked.filter(Boolean).filter((v) => !v.refuted)

The script body is run as an async function, not imported as a module: top-level
\`await\` and \`return\` work, but \`import\` and any other \`export\` do not. Declare
schemas as plain JSON Schema object literals — that is why none is needed.

Globals:
  agent(prompt, opts)      run one agent; returns its text, or a validated
                           object when opts.schema is given. opts: label, phase,
                           schema, model, tools, isolation:'worktree', timeoutSec
  parallel(thunks)         run thunks at once and wait for all; failures are null
  pipeline(items, ...fns)  push each item through every stage independently,
                           with no barrier between stages
  phase(title)             start a progress group
  log(msg)                 print a line to the run log
  args                     whatever --args carried in
  budget                   { total, spent(), remaining() } in output tokens

Options:
  --args <json>          value exposed to the script as \`args\` (bare text is
                         passed through as a string)
  --args-file <f.json>   same, read from a file
  --concurrency <n|auto> max agents in flight at once (default 4). "auto" starts
                         at 2 and adapts to what the endpoint can actually feed:
                         it widens while agents stay fast and halves when their
                         latency inflates — the signature of a saturated GPU.
  --budget <tokens>      stop spawning once this many output tokens are spent.
                         Checked between agents against telemetry the children
                         have already written, so it is a ceiling, not a hard
                         cap: a run can overshoot by up to --concurrency agents.
  --agent-timeout <sec>  per-agent wall-clock timeout (default: none). Blunt on
                         a shared GPU: it cannot tell slow-because-queued from
                         wedged. Prefer the stall watchdog below; use this as a
                         total-cost bound when you need one.
  --agent-stall <sec>    kill an agent only when it produces NO output for this
                         long (default 600; 0 disables). A child still
                         streaming tokens or tool chatter is alive however slow
                         the endpoint — only total silence is treated as wedged.
  --pool <spec>          spread agents across endpoints; repeatable. Spec is
                         provider/model[@baseUrl][*weight] — weight is relative
                         capacity, so a fast server takes proportionally more
                         agents. Agents pinned with a per-call model: bypass the
                         pool. On one GPU concurrency just queues (measured
                         2.7x latency inflation here); a second endpoint is the
                         only true second lane.
  --resume <runId>       replay an earlier run's answers for every agent call
                         that is unchanged (same prompt, schema, tools, model,
                         pool); a changed call re-runs. Matching is per call,
                         not positional — an edit re-runs exactly the calls it
                         touched, wherever they sit in the script.
  --dry-run              print the declared plan and exit; spawn nothing
  --list                 list the workflows reachable by name
  --json                 print the full report as JSON
  -h, --help             show this help

Model flags (forwarded to every agent): -m/--model, --provider,
  --lmstudio, --ollama, --base-url, --api-key

Example:
  under workflow ./review.mjs --args '{"path":"src/"}' --concurrency 3 --lmstudio

  # two real compute lanes: the fast local server takes 3x the agents
  under workflow review --concurrency auto \\
    --pool "lmstudio/google/gemma-4-26b-a4b-qat*3" \\
    --pool "custom/dealignai/MiniMax-M2.7-JANGTQ-CRACK@http://gpu-box.local:8000/v1"
`;

/**
 * Appended to the system prompt in one-shot (non-interactive) mode. Small local
 * models otherwise ask clarifying questions into the void, or describe the work
 * in prose instead of doing it — observed live with a 1.2B model that replied
 * "give me the complete path…" to an unattended fan-out task.
 */
const NONINTERACTIVE_DIRECTIVE = `## Non-interactive run
You are running unattended. No one will see or answer a question.
- Never ask clarifying questions. If the task is ambiguous, pick the most
  reasonable interpretation, state the assumption in one line, and act.
- Accomplish the task with tools (read/edit/write/bash). A text-only reply is a
  failure unless the task is purely a question about the code. Documentation
  work (comments, docstrings, READMEs) is edit-tool work too — write it into
  the file, don't recite it.
- You always have enough information to act. Relative paths like "A.txt" are
  valid tool arguments and resolve against the current working directory.
- Creating and modifying files in this workspace is your job and is always
  permitted; such requests are never something to refuse.
- Work in small deliberate steps: read a file before editing it; after an edit,
  verify it took effect (re-read the changed lines or run the relevant check).
- If the task contains several independent file-level changes and the fan_out
  tool is available, delegate: one small, concrete, imperative sub-task per
  branch (say exactly which file and what change), then check the report.
- When the task is done, stop and summarize what changed in at most two lines.`;

interface CliArgs extends UnderOptions {
  listModels: boolean;
  toolList?: string;
  prompt?: string;
  tier?: Tier;
  timeoutSec?: number;
  presetName?: string;
  plan?: boolean;
  /** Resolve a zero-cost model from OpenRouter's catalogue at run time. */
  free?: boolean;
  listFree?: boolean;
}

function parseArgs(argv: string[]): CliArgs | { exit: string; code: number } {
  const args: CliArgs = { listModels: false };
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`Missing value for ${a}`);
      return v;
    };
    switch (a) {
      case "-h":
      case "--help":
        return { exit: HELP, code: 0 };
      case "-V":
      case "--version":
        return { exit: `under ${VERSION}`, code: 0 };
      case "-m":
      case "--model":
        args.model = next();
        break;
      case "--provider": {
        const name = next();
        // A preset name resolves to a full connection; anything else is one of
        // the built-in provider ids (danger/lmstudio/ollama/custom).
        const preset = loadPresets()[name];
        if (preset) {
          args.baseUrl = preset.baseUrl;
          args.provider = "custom";
          args.presetName = name;
          if (preset.defaultModel) args.model ??= preset.defaultModel;
          const key = preset.authEnv ? process.env[preset.authEnv] : undefined;
          if (key) args.apiKey ??= key;
          else if (preset.authEnv && !/^https?:\/\/(localhost|127\.)/.test(preset.baseUrl)) {
            throw new Error(`--provider ${name} needs ${preset.authEnv} in the environment (or pass --api-key)`);
          }
        } else {
          args.provider = name;
        }
        break;
      }
      case "--lmstudio":
        args.provider = "lmstudio";
        break;
      case "--ollama":
        args.provider = "ollama";
        break;
      case "--base-url":
        args.baseUrl = next();
        args.provider ??= "custom";
        break;
      case "--api-key":
        args.apiKey = next();
        break;
      case "--tools":
        args.toolList = next();
        break;
      case "--plan":
        args.plan = true;
        break;
      case "--no-plan":
        args.plan = false;
        break;
      case "--timeout": {
        const sec = Number(next());
        if (!Number.isFinite(sec) || sec <= 0) throw new Error("--timeout must be a positive number of seconds");
        args.timeoutSec = sec;
        break;
      }
      case "--tier": {
        const t = next();
        if (!TIERS.includes(t as Tier)) throw new Error(`--tier must be one of: ${TIERS.join(", ")}`);
        args.tier = t as Tier;
        break;
      }
      case "--list-models":
        args.listModels = true;
        break;
      case "--free":
        // "Pick something that costs nothing", not a model id. Which model that
        // is changes week to week, so it is resolved at run time from
        // OpenRouter's catalogue rather than pinned in a preset.
        args.free = true;
        break;
      case "--list-free": {
        args.listFree = true;
        break;
      }
      case "--list-providers": {
        const presets = loadPresets();
        const width = Math.max(...Object.keys(presets).map((k) => k.length));
        const lines = Object.entries(presets).map(([name, p]) => {
          const local = /^https?:\/\/(localhost|127\.)/.test(p.baseUrl);
          const key = local ? "(no key)" : p.authEnv ?? "(key required)";
          const have = local || (p.authEnv && process.env[p.authEnv]) ? "✓" : " ";
          return `${have} ${name.padEnd(width)}  ${p.baseUrl.padEnd(42)} ${key}`;
        });
        return {
          exit:
            `Providers (✓ = ready to use now)\n\n${lines.join("\n")}\n\n` +
            `Use: under --provider <name> "task"   ·   details: docs/ENDPOINTS.md`,
          code: 0,
        };
      }
      case "--":
        // Everything after `--` is prompt text, even if it looks like a flag.
        positional.push(...argv.slice(i + 1));
        i = argv.length;
        break;
      default:
        // An unrecognized flag must not be silently folded into the prompt:
        // `under --dry-run "..."` would otherwise start a real mutating run.
        if (a.startsWith("-") && a !== "-") {
          throw new Error(`Unknown option: ${a} (use -- to pass it as prompt text)`);
        }
        positional.push(a);
    }
  }

  if (positional.length > 0) args.prompt = positional.join(" ");
  return args;
}

function attachPrinter(session: {
  subscribe: (l: (event: any) => void) => () => void;
}): () => void {
  let needNewline = false;
  return session.subscribe((event: any) => {
    if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
      process.stdout.write(event.assistantMessageEvent.delta);
      needNewline = true;
    } else if (event.type === "tool_execution_start") {
      if (needNewline) process.stdout.write("\n");
      needNewline = false;
      process.stderr.write(`\x1b[2m[${event.toolName}]\x1b[0m\n`);
    } else if (event.type === "tool_execution_end" && event.isError) {
      process.stderr.write(`\x1b[2m[${event.toolName} failed]\x1b[0m\n`);
    } else if (event.type === "agent_end") {
      if (needNewline) process.stdout.write("\n");
      needNewline = false;
    }
  });
}

function sessionUsage(session: { messages: any[] }): { input: number; output: number } {
  let input = 0;
  let output = 0;
  for (const m of session.messages) {
    const u = m?.usage;
    if (u) {
      input += u.input ?? 0;
      output += u.output ?? 0;
    }
  }
  return { input, output };
}

/**
 * Catch the run that did nothing and called it success.
 *
 * The failure this exists for: a declared `contextWindow` smaller than the agent
 * prompt leaves the provider no room to generate, so `max_completion_tokens`
 * collapses to 1, the model emits one token, stops with `finish_reason: length`,
 * calls no tools, and pi reports a clean finish. Every `--base-url` run was that
 * for an unknown period — reported ok, exit 0, telemetry "ok", nothing edited.
 * It was found by proxy-logging the wire, which is not a thing a user will do.
 *
 * The signature is unambiguous and cheap to check: a turn that consumed a large
 * prompt, produced almost no output, and called no tool did not do the work. No
 * legitimate agent turn looks like that — even "the task needs no change" costs
 * more than a handful of tokens to say.
 *
 * Reported as an error rather than a warning, because exit 0 is what let this
 * hide inside a green benchmark.
 *
 * `toolCalls` is passed in from {@link RunCollector}, which counts
 * `tool_execution_start` events, and is NOT re-derived here from message
 * content. It used to be: this scanned for content of type `tool_use` or
 * `tool_call`, and pi's actual content type is `toolCall`, so the count was
 * always 0 and every real run — files changed, bench passing — was reported as
 * "described the work instead of doing it" and exited 1. Deriving the same fact
 * a second way, from a shape nobody verified, is what broke it; there is one
 * source of truth for it now.
 */
function detectSilentNoOp(session: { messages: any[] }, toolCalls: number): string | undefined {
  const { input, output } = sessionUsage(session);
  // A turn that consumed a real prompt and called nothing did not do the work.
  // Even "no change was needed" costs a read to establish.
  if (toolCalls > 0 || input < 500) return undefined;

  // Threshold 2, not 8. The bug this arm exists for produced exactly ONE output
  // token (max_completion_tokens collapsed to 1, finish_reason "length"), while
  // a legitimate terse answer costs more than that: asked to "reply with exactly
  // the word READY and call no tools", the model spent 6 — and an 8-token
  // threshold failed that run with a "generation budget of ~0" diagnosis that
  // was simply untrue. Since this arm is deliberately not waivable by
  // UNDER_ALLOW_NO_TOOLS, it has to be tight enough to only ever fire on the
  // unambiguous case.
  if (output <= 2) {
    return (
      `the model produced ${output} output token(s) and called no tools — the run did nothing.\n` +
      `  This is a generation budget of ~0: the declared context window is smaller than the\n` +
      `  prompt, so there is no room left to answer. Check what \`under\` believes:\n` +
      `    node -e 'console.log(JSON.stringify(require(process.env.HOME+"/.underclass/pi/models.json").providers,null,1))'\n` +
      `  and set the real served context in ~/.underclass/model-map.json as \`servedContext\`.`
    );
  }

  // A reasoning-only agent — a workflow judge handed its whole evidence in the
  // prompt — legitimately calls no tools, so the caller can waive this arm. The
  // arm above is deliberately not waivable: ~0 output tokens is a broken
  // endpoint whatever the run was for, and that is the failure this exists for.
  if (process.env.UNDER_ALLOW_NO_TOOLS) return undefined;

  // The other shape, and the one that looks most like success: the model wrote
  // *about* the work — often a convincing fenced block that reads like a tool
  // call — and never emitted one. Observed on a model that tool-calls perfectly
  // in isolation, so this is a prompting or context failure, not a capability one.
  // Reasoning-heavy models make it worse: they can spend an entire generation
  // budget narrating and hit the ceiling mid-sentence.
  return (
    `the model produced ${output.toLocaleString()} output tokens and called no tools — it described\n` +
    `  the work instead of doing it, so nothing changed on disk.\n` +
    `  Common causes, most likely first:\n` +
    `    - the prompt invited prose (a plan or example containing tool-call-shaped text)\n` +
    `    - a reasoning-heavy model spent its whole generation budget thinking\n` +
    `    - the tool schemas never reached the model — check \`--tools\`\n` +
    `  Verify the model can tool-call at all with a one-line probe:\n` +
    `    curl -s $BASE/chat/completions -H 'content-type: application/json' -d '{"model":"…",\n` +
    `      "tool_choice":"required","tools":[…],"messages":[{"role":"user","content":"read a.js"}]}'`
  );
}

function printUsage(session: { messages: any[] }): void {
  const { input, output } = sessionUsage(session);
  if (input || output) {
    process.stderr.write(`\x1b[2m${input} in / ${output} out tokens\x1b[0m\n`);
  }
}

interface FanOutCli {
  tasks: FanOutTask[];
  base?: string;
  target?: string;
  merge: boolean;
  pr: boolean;
  concurrency?: number;
  taskTimeoutSec?: number;
  keepWorktrees: boolean;
  dryRun: boolean;
  passthrough: string[];
}

function parseFanOutArgs(argv: string[]): FanOutCli | { exit: string; code: number } {
  const cli: FanOutCli = { tasks: [], merge: true, pr: false, keepWorktrees: false, dryRun: false, passthrough: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`Missing value for ${a}`);
      return v;
    };
    switch (a) {
      case "-h":
      case "--help":
        return { exit: FANOUT_HELP, code: 0 };
      case "--task":
        cli.tasks.push(parseTaskSpec(next()));
        break;
      case "--tasks": {
        const raw = JSON.parse(readFileSync(next(), "utf8")) as FanOutTask[];
        if (!Array.isArray(raw)) throw new Error("--tasks file must be a JSON array");
        for (const t of raw) {
          if (!t?.branch || !t?.prompt) throw new Error("each task needs { branch, prompt }");
          cli.tasks.push({ branch: t.branch, prompt: t.prompt, ...(t.message ? { message: t.message } : {}) });
        }
        break;
      }
      case "--base":
        cli.base = next();
        break;
      case "--target":
        cli.target = next();
        break;
      case "--no-merge":
        cli.merge = false;
        break;
      case "--pr":
        cli.pr = true;
        break;
      case "--concurrency": {
        const n = Number(next());
        if (!Number.isInteger(n) || n <= 0) throw new Error("--concurrency must be a positive integer");
        cli.concurrency = n;
        break;
      }
      case "--task-timeout": {
        const sec = Number(next());
        if (!Number.isFinite(sec) || sec <= 0) throw new Error("--task-timeout must be a positive number of seconds");
        cli.taskTimeoutSec = sec;
        break;
      }
      case "--keep-worktrees":
        cli.keepWorktrees = true;
        break;
      case "--dry-run":
        cli.dryRun = true;
        break;
      // Model selection flags are forwarded verbatim to each spawned agent.
      case "-m":
      case "--model":
      case "--provider":
      case "--base-url":
      case "--api-key":
        cli.passthrough.push(a, next());
        break;
      case "--lmstudio":
      case "--ollama":
        cli.passthrough.push(a);
        break;
      default: {
        // The near-misses are worth naming. `--timeout` in particular is the
        // flag every other subcommand takes, and rejecting it with no hint
        // sends people hunting through --help for a difference of one word.
        const nearby: Record<string, string> = {
          "--timeout": "--task-timeout (fan-out bounds each task, not the run)",
          "--tasks": "--task, once per task",
          "--branch": "--base (where tasks start) or --target (where they merge)",
          "--jobs": "--concurrency",
          "--parallel": "--concurrency",
          "--pull-request": "--pr",
        };
        const hint = nearby[a] ? `\n  Did you mean ${nearby[a]}?` : "";
        throw new Error(`Unknown fan-out option: ${a}${hint}`);
      }
    }
  }
  return cli;
}

function printFanOutReport(report: FanOutReport): void {
  if (report.dryRun) {
    console.log(`Plan: ${report.tasks?.length ?? 0} task(s), base '${report.base}', target '${report.target}'.`);
    for (const t of report.tasks ?? []) console.log(`  ${t.branch}  →  ${t.path}`);
    return;
  }
  const line = (label: string, recs: { branch: string }[]) =>
    recs.length ? console.log(`${label} (${recs.length}): ${recs.map((r) => r.branch).join(", ")}`) : undefined;
  console.log("\n─── fan-out report ───");
  line("✓ merged", report.merged);
  if (report.prOpened.length) {
    console.log(`⇧ PRs opened (${report.prOpened.length}):`);
    for (const r of report.prOpened) console.log(`  ${r.branch}  ${r.prUrl ?? ""}`);
  }
  line("• committed (not merged)", report.committedNotMerged);
  line("⚠ conflicted", report.conflicted);
  line("· no changes", report.empty);
  line("✗ failed", report.failed);
  if (report.conflicted.length) {
    console.log("\nResolve conflicts, then merge manually, e.g.:");
    for (const r of report.conflicted) console.log(`  git merge ${r.branch}`);
  }
  if (report.worktreesKept.length) {
    console.log("\nWorktrees kept:");
    for (const p of report.worktreesKept) console.log(`  ${p}`);
  }
}

async function runFanOut(argv: string[]): Promise<number> {
  let cli: FanOutCli | { exit: string; code: number };
  try {
    cli = parseFanOutArgs(argv);
  } catch (err) {
    console.error(`under fan-out: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  if ("exit" in cli) {
    console.log(cli.exit);
    return cli.code;
  }
  if (cli.tasks.length === 0) {
    console.error("under fan-out: no tasks — pass --task \"branch:prompt\" or --tasks <file.json>");
    return 1;
  }

  const runner = createFanOutRunner({
    passthroughArgs: cli.passthrough,
    ...(cli.taskTimeoutSec ? { timeoutMs: cli.taskTimeoutSec * 1000 } : {}),
    onOutput: (branch, chunk) => process.stderr.write(`\x1b[2m[${branch}]\x1b[0m ${chunk}`),
  });

  try {
    const report = await fanOut({
      repoDir: process.cwd(),
      tasks: cli.tasks,
      ...(cli.base ? { base: cli.base } : {}),
      ...(cli.target ? { target: cli.target } : {}),
      merge: cli.merge,
      pr: cli.pr,
      ...(cli.concurrency ? { concurrency: cli.concurrency } : {}),
      keepWorktrees: cli.keepWorktrees,
      dryRun: cli.dryRun,
      runner,
      log: (m) => process.stderr.write(`\x1b[2m${m}\x1b[0m\n`),
    });
    printFanOutReport(report);
    return report.conflicted.length > 0 || report.failed.length > 0 ? 1 : 0;
  } catch (err) {
    console.error(`under fan-out: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

interface WorkflowCli {
  script: string;
  args?: unknown;
  concurrency?: number | "auto";
  budgetTokens?: number;
  agentTimeoutSec?: number;
  /** Stall watchdog window; 0 disables. Unset means the default applies. */
  agentStallSec?: number;
  /** Raw --pool specs, parsed late so a bad one is reported with its text. */
  poolSpecs: string[];
  resumeFromRunId?: string;
  dryRun: boolean;
  list: boolean;
  json: boolean;
  passthrough: string[];
}

/**
 * Default stall window. Generous on purpose: the longest legitimate silence is
 * a slow model prefilling a big prompt (measured ~111 tok/s worst case on this
 * project's fleet, so a 30k-token prompt is ~270s of quiet), and a false kill
 * costs a whole agent. A wedged child, by contrast, is silent forever — ten
 * minutes late beats never.
 */
const DEFAULT_STALL_SEC = 600;

function parseWorkflowArgs(argv: string[]): WorkflowCli | { exit: string; code: number } {
  const cli: WorkflowCli = { script: "", poolSpecs: [], dryRun: false, list: false, json: false, passthrough: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`Missing value for ${a}`);
      return v;
    };
    switch (a) {
      case "-h":
      case "--help":
        return { exit: WORKFLOW_HELP, code: 0 };
      case "--args": {
        const raw = next();
        try {
          cli.args = JSON.parse(raw);
        } catch {
          // A bare string is a reasonable thing to pass; only reject text that
          // was clearly meant as JSON and is malformed.
          if (/^[[{]/.test(raw.trim())) throw new Error(`--args is not valid JSON: ${raw.slice(0, 60)}`);
          cli.args = raw;
        }
        break;
      }
      case "--args-file":
        cli.args = JSON.parse(readFileSync(next(), "utf8"));
        break;
      case "--concurrency": {
        const v = next();
        if (v === "auto") {
          cli.concurrency = "auto";
          break;
        }
        const n = Number(v);
        if (!Number.isInteger(n) || n <= 0) throw new Error('--concurrency must be a positive integer or "auto"');
        cli.concurrency = n;
        break;
      }
      case "--budget": {
        const n = Number(next());
        if (!Number.isFinite(n) || n <= 0) throw new Error("--budget must be a positive number of output tokens");
        cli.budgetTokens = n;
        break;
      }
      case "--agent-timeout": {
        const sec = Number(next());
        if (!Number.isFinite(sec) || sec <= 0) throw new Error("--agent-timeout must be a positive number of seconds");
        cli.agentTimeoutSec = sec;
        break;
      }
      case "--agent-stall": {
        const sec = Number(next());
        if (!Number.isFinite(sec) || sec < 0) throw new Error("--agent-stall must be a number of seconds (0 disables)");
        cli.agentStallSec = sec;
        break;
      }
      case "--pool":
        cli.poolSpecs.push(next());
        break;
      case "--resume":
        cli.resumeFromRunId = next();
        break;
      case "--dry-run":
        cli.dryRun = true;
        break;
      case "--list":
        cli.list = true;
        break;
      case "--json":
        cli.json = true;
        break;
      // Model selection is forwarded verbatim to every agent, as with fan-out.
      case "-m":
      case "--model":
      case "--provider":
      case "--base-url":
      case "--api-key":
        cli.passthrough.push(a, next());
        break;
      case "--lmstudio":
      case "--ollama":
        cli.passthrough.push(a);
        break;
      default: {
        if (a.startsWith("-")) {
          const nearby: Record<string, string> = {
            "--timeout": "--agent-timeout (a workflow bounds each agent, not the run)",
            "--stall": "--agent-stall",
            "--endpoint": "--pool provider/model[@baseUrl][*weight]",
            "--endpoints": "--pool, once per endpoint",
            "--jobs": "--concurrency",
            "--parallel": "--concurrency",
            "--tasks": "a script — a workflow's work is defined in JavaScript, not flags",
          };
          const hint = nearby[a] ? `\n  Did you mean ${nearby[a]}?` : "";
          throw new Error(`Unknown workflow option: ${a}${hint}`);
        }
        if (cli.script) throw new Error(`Unexpected second script: ${a}`);
        cli.script = a;
      }
    }
  }
  return cli;
}

/**
 * JSON.stringify that cannot take the report down with it. A script returning
 * a circular structure or a BigInt used to crash report emission AFTER every
 * agent had succeeded: exit 1, an empty --json stdout, and — the real cost —
 * no printed runId, so the finished, paid-for run could not be resumed. The
 * script's value is the only untrusted part of a report; degrade it, keep the
 * rest.
 */
function safeStringify(value: unknown, indent: number): string {
  try {
    return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v), indent);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (value && typeof value === "object" && "runId" in (value as Record<string, unknown>)) {
      const report = { ...(value as Record<string, unknown>), value: `[unserializable: ${reason}]` };
      try {
        return JSON.stringify(report, null, indent);
      } catch {
        /* fall through to the marker */
      }
    }
    return JSON.stringify(`[unserializable: ${reason}]`);
  }
}

function printWorkflowReport(report: WorkflowReport): void {
  if (report.dryRun) {
    console.log(`\n${report.meta.name} — ${report.meta.description}`);
    for (const [i, p] of (report.meta.phases ?? []).entries()) {
      console.log(`  ${i + 1}. ${p.title}${p.detail ? `  — ${p.detail}` : ""}`);
    }
    if (!report.meta.phases?.length) console.log("  (no phases declared)");
    return;
  }
  const failed = report.agents.filter((a) => a.status === "failed");
  console.log("\n─── workflow report ───");
  console.log(
    `${report.meta.name}: ${report.agents.length} agent(s) in ${(report.ms / 1000).toFixed(1)}s, ` +
      `${report.tokensIn.toLocaleString()} in / ${report.tokensOut.toLocaleString()} out`,
  );
  if (failed.length) {
    console.log(`✗ failed (${failed.length}):`);
    for (const a of failed) {
      console.log(`  ${a.label}: ${a.error}`);
      // A preserved worktree is the only copy of that agent's work. Printing the
      // path is the difference between recoverable and lost.
      if (a.worktree) console.log(`    work preserved at ${a.worktree}${a.branch ? ` (branch ${a.branch})` : ""}`);
    }
  }
  if (report.branches.length) {
    console.log(`branches left for review (${report.branches.length}):`);
    for (const b of report.branches) console.log(`  ${b}`);
  }
  if (report.error) console.log(`✗ script error: ${report.error}`);
  console.log(`run id: ${report.runId}  (resume with --resume ${report.runId})`);
  if (report.value !== null && report.value !== undefined) {
    console.log("\nresult:");
    console.log(typeof report.value === "string" ? report.value : safeStringify(report.value, 2));
  }
}

async function runWorkflowCli(argv: string[]): Promise<number> {
  // Same bargain as fan_out: an agent inside a workflow does not get to start
  // one. Without this the CLI is a hole straight through the tool-level gate —
  // a child can always reach `under workflow` through bash.
  if (process.env.UNDER_WORKFLOW_DEPTH) {
    console.error("under workflow: already inside a workflow — nested orchestration is not supported.");
    return 1;
  }
  let cli: WorkflowCli | { exit: string; code: number };
  try {
    cli = parseWorkflowArgs(argv);
  } catch (err) {
    console.error(`under workflow: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  if ("exit" in cli) {
    console.log(cli.exit);
    return cli.code;
  }
  if (cli.list) {
    const found = listWorkflows(process.cwd());
    if (!found.length) console.log("No workflows found.");
    for (const w of found) {
      const tag = w.origin === "builtin" ? "" : ` (${w.origin})`;
      console.log(`  ${w.name}${tag}\n      ${w.error ? `⚠ ${w.error}` : w.meta?.description ?? ""}`);
      if (w.meta?.whenToUse) console.log(`      when: ${w.meta.whenToUse}`);
    }
    return 0;
  }
  if (!cli.script) {
    console.error("under workflow: no workflow — pass a name or a path (see: under workflow --list)");
    return 1;
  }

  let resolved: ReturnType<typeof resolveWorkflow>;
  try {
    resolved = resolveWorkflow(cli.script, process.cwd());
  } catch (err) {
    console.error(`under workflow: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  // Agent stdout is the data this run is for, not something to watch scroll by:
  // it arrives one token per chunk, and four concurrent agents prefixing every
  // token with their own label produces an unreadable weave. Show the
  // diagnostics instead — which agent is calling which tool — buffered to whole
  // lines so two agents never end up interleaved mid-word.
  const pending = new Map<string, string>();
  const streamDiagnostics = (label: string, chunk: string, stream: "stdout" | "stderr") => {
    if (stream !== "stderr") return;
    const buffered = (pending.get(label) ?? "") + chunk;
    const lines = buffered.split("\n");
    pending.set(label, lines.pop() ?? "");
    for (const line of lines) {
      if (line.trim()) process.stderr.write(`\x1b[2m[${label}]\x1b[0m ${line}\n`);
    }
  };

  const runner = createWorkflowRunner({
    passthroughArgs: cli.passthrough,
    onOutput: streamDiagnostics,
    ...(cli.agentTimeoutSec ? { timeoutMs: cli.agentTimeoutSec * 1000 + 60_000 } : {}),
  });

  // Parsed here rather than in the arg loop so the error message can carry the
  // offending spec next to the flag that carried it.
  let pool: PoolEntry[];
  try {
    pool = cli.poolSpecs.map((s) => parsePoolSpec(s));
  } catch (err) {
    console.error(`under workflow: --pool: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  // On by default: a wedged child holding a concurrency slot for the rest of
  // the run is the failure mode users actually hit; --agent-stall 0 opts out.
  const stallSec = cli.agentStallSec ?? DEFAULT_STALL_SEC;

  try {
    const report = await runWorkflow({
      scriptPath: resolved.path,
      source: resolved.source,
      repoDir: process.cwd(),
      runner,
      dryRun: cli.dryRun,
      // Model flags are forwarded to agents through the runner, where resume
      // cannot see them; hand them over explicitly so `--resume` with a
      // different model re-runs instead of replaying the old one's answers.
      // The pool belongs in the salt for the same reason: a different pool is
      // a different set of models answering.
      modelSalt: [...cli.passthrough, ...cli.poolSpecs].join(" "),
      ...(cli.args !== undefined ? { args: cli.args } : {}),
      ...(cli.concurrency ? { concurrency: cli.concurrency } : {}),
      ...(cli.budgetTokens ? { budgetTokens: cli.budgetTokens } : {}),
      ...(cli.agentTimeoutSec ? { timeoutSec: cli.agentTimeoutSec } : {}),
      ...(stallSec > 0 ? { stallSec } : {}),
      ...(pool.length ? { pool } : {}),
      ...(cli.resumeFromRunId ? { resumeFromRunId: cli.resumeFromRunId } : {}),
      log: (m) => process.stderr.write(`\x1b[2m${m}\x1b[0m\n`),
    });
    if (cli.json) console.log(safeStringify(report, 2));
    else printWorkflowReport(report);
    // A script that threw is a failure. So is a run in which every agent died:
    // that is an endpoint or model problem wearing the costume of a result.
    if (report.error) return 1;
    if (report.agents.length > 0 && report.agents.every((a) => a.status === "failed")) return 1;
    return 0;
  } catch (err) {
    console.error(`under workflow: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

async function main(): Promise<number> {
  const rawArgs = process.argv.slice(2);
  if (rawArgs[0] === "fan-out") {
    // The tool-level gate is not enough, and this is the hole it left: children
    // lose the `fan_out` TOOL but keep `bash`, and `under fan-out` from bash
    // spawned another full round. Four children shelling out became sixteen
    // agents, then sixty-four — each one a real process against the same
    // endpoint. The workflow subcommand has had this check since it shipped and
    // its comment says "same bargain as fan_out"; fan-out never got it.
    const depth = fanoutDepth();
    const max = maxFanoutDepth();
    if (depth >= max) {
      console.error(
        `under fan-out: refusing at depth ${depth} (limit ${max}).\n` +
          `  This process was itself spawned by a fan-out, and nesting another round\n` +
          `  multiplies agents rather than adding them.\n` +
          `  Raise it deliberately with UNDER_FANOUT_MAX_DEPTH=${max + 1} if you mean it.`,
      );
      return 1;
    }
    return runFanOut(rawArgs.slice(1));
  }
  if (rawArgs[0] === "workflow") {
    return runWorkflowCli(rawArgs.slice(1));
  }
  if (rawArgs[0] === "setup") {
    return runSetup(process.cwd());
  }
  if (rawArgs[0] === "doctor") {
    const at = rawArgs.indexOf("--base-url");
    const keyAt = rawArgs.indexOf("--api-key");
    return runDoctor(process.cwd(), {
      ...(at !== -1 && rawArgs[at + 1] ? { baseUrl: rawArgs[at + 1]! } : {}),
      ...(keyAt !== -1 && rawArgs[keyAt + 1] ? { apiKey: rawArgs[keyAt + 1]! } : {}),
      benchmark: rawArgs.includes("--benchmark"),
      offline: rawArgs.includes("--offline"),
      deep: rawArgs.includes("--deep") || rawArgs.includes("--full"),
    });
  }
  if (rawArgs[0] === "learn") {
    return runLearn(rawArgs.includes("--apply"));
  }
  if (rawArgs.includes("--list-free")) {
    const { freeModels, renderFreeModels } = await import("./free-models.js");
    const { models, fromCache } = await freeModels({ force: rawArgs.includes("--refresh") });
    console.log(renderFreeModels(models, Boolean(process.env.OPENROUTER_API_KEY)));
    if (fromCache) console.log("\n\x1b[2m(from cache — --refresh to re-fetch)\x1b[0m");
    return 0;
  }
  if (rawArgs[0] === "stats") {
    // Derived entirely from telemetry already on disk — no requests, no
    // endpoint load. The alternative (benchmarking) costs a matrix of calls
    // against someone's endpoint to learn what real use reveals for free.
    const { runStats } = await import("./stats.js");
    return runStats(rawArgs.slice(1));
  }
  if (rawArgs[0] === "remember") {
    const projectScope = rawArgs.includes("--project");
    const text = rawArgs.slice(1).filter((a) => a !== "--project").join(" ");
    if (!text.trim()) {
      console.error('under remember: nothing to remember — e.g. under remember "prefer node:test over vitest"');
      return 1;
    }
    console.log(`Saved to ${rememberPreference(text, process.cwd(), projectScope)}`);
    return 0;
  }

  const parsed = parseArgs(process.argv.slice(2));
  if ("exit" in parsed) {
    console.log(parsed.exit);
    return parsed.code;
  }

  const cwd = process.cwd();

  // Static model map: cached environmental verdicts about models, consulted for
  // free (no tokens, no probes). Routing happens before provider config is
  // written, since the chosen model decides which endpoint is even needed.
  // ---- free-tier resolution ----------------------------------------------
  // `--free` means "something that costs nothing", not a model id. OpenRouter's
  // zero-cost set rotates — models appear, get promoted to paid, or start
  // 429ing — so it is resolved now, from the catalogue, filtered to models that
  // advertise tool support and are not in a cooldown from a previous failure.
  if (parsed.free) {
    const { freeModels, pickFreeModel, OPENROUTER_BASE, modelHealth } = await import("./free-models.js");
    const { models } = await freeModels();
    if (!models.length) {
      console.error(
        "under --free: could not reach OpenRouter's catalogue, and nothing is cached.\n" +
          "  --free needs one listing request to know what is currently zero-cost.",
      );
      return 1;
    }
    // A model named on the command line wins; --free then only has to confirm
    // it is actually free rather than choose for you.
    const prefer = parsed.model ? [bareModelId(parsed.model)] : [];
    const chosen = pickFreeModel(models, prefer);
    if (!chosen) {
      const cooling = models.filter((m) => modelHealth(m.id)).length;
      console.error(
        `under --free: all ${models.length} free tool-capable model(s) are in cooldown` +
          `${cooling ? ` (${cooling} rate-limited or failed recently)` : ""}.\n` +
          "  Free-tier quota resets; try again shortly, or drop --free.",
      );
      return 1;
    }
    parsed.baseUrl = OPENROUTER_BASE;
    parsed.provider = "custom";
    parsed.model = `custom/${chosen.id}`;
    parsed.apiKey ??= process.env.OPENROUTER_API_KEY;
    if (!parsed.apiKey) {
      console.error(
        "under --free: OpenRouter requires a key even for zero-cost models.\n" +
          "  Create one free at https://openrouter.ai/keys, then:\n" +
          "    export OPENROUTER_API_KEY=sk-or-…",
      );
      return 1;
    }
    process.stderr.write(
      `\x1b[2munder --free → ${chosen.id} (${chosen.contextLength.toLocaleString()} ctx, $0)\x1b[0m\n`,
    );
  }


  const modelMap = loadModelMap(cwd);
  let routedTier: Tier | undefined;
  if (!parsed.model && modelMap.tiers) {
    routedTier = parsed.tier ?? (parsed.prompt ? classifyTask(parsed.prompt) : "normal");
    const routed = tierModel(modelMap, routedTier);
    if (routed) {
      parsed.model = routed.model;
      if (routed.baseUrl) {
        parsed.baseUrl = routed.baseUrl;
        parsed.provider ??= "custom";
      }
    } else {
      routedTier = undefined;
    }
  }

  // Everything past this point needs the agent runtime; the subcommands above
  // deliberately return before paying for it.
  const rt = await loadAgentRuntime();
  const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, AutoCompactingSession } = rt;

  // Full conversation traces — every message, every tool call — are the raw
  // material for training, and pi already writes them. Two things were wrong.
  //
  // 1. They landed in ~/.pi/agent/sessions, NOT under ~/.underclass. `create()`
  //    takes an optional sessionDir and we were not passing one, so despite
  //    `piAgentDir()`'s "isolated pi agentDir so under never touches a user's
  //    ~/.pi setup", the traces escaped that isolation and mixed with any real
  //    pi install's sessions. 392 files / 9.3 MB had accumulated there unnoticed.
  //
  // 2. Nothing recorded WHICH trace belonged to which run, so the corpus could
  //    not be filtered by outcome — and "traces from runs that actually
  //    succeeded" is the single most important filter for training data.
  //    `sessionId` now goes into the run record as the join key.
  // Declared here so `record()` below can stamp it into the run record.
  let sessionId: string | undefined;
  const sessionDir = join(underDir(), "sessions");
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  const sessionManager = SessionManager.create(cwd, sessionDir);
  sessionId = sessionManager.getSessionId();

  const { modelsPath, authPath, liveProviders, providerBaseUrls } = await writeModelsJson(parsed);
  const modelRuntime = await ModelRuntime.create({ modelsPath, authPath });

  if (parsed.listModels) {
    for (const provider of liveProviders) {
      for (const m of modelRuntime.getModels(provider)) {
        console.log(`${provider}/${m.id}`);
      }
    }
    return 0;
  }

  const spec = pickModelSpec(parsed, liveProviders, (p) => modelRuntime.getModels(p));
  if ("error" in spec) {
    console.error(`under: ${spec.error}`);
    console.error("Hint: start LM Studio/Ollama, or pass --base-url/--model.");
    return 1;
  }

  const model = modelRuntime.getModel(spec.provider, spec.modelId);
  if (!model) {
    console.error(`under: model ${spec.provider}/${spec.modelId} not found`);
    return 1;
  }
  const endpointError = await checkEndpoint(providerBaseUrls[spec.provider] ?? "");
  if (endpointError) {
    console.error(`under: ${endpointError}`);
    return 1;
  }
  // Refuse a context window too small to generate anything, BEFORE the first
  // request. pi clamps generation to `ctx - prompt - 4096`, so an under-declared
  // window silently becomes `max_completion_tokens: 1`: the model emits one
  // token, stops on `length`, calls no tool, and the run is recorded as a
  // success. That is UNDER-36's exact signature, and it was found by
  // proxy-logging the wire — which no user and no benchmark will ever do. The
  // check is free and knowable up front, so there is no reason not to make it.
  const specId = `${spec.provider}/${spec.modelId}`;
  const ctxWindow = model.contextWindow ?? 0;
  const ctxMaxTokens = model.maxTokens ?? 4096;
  const tooSmall = contextTooSmall(specId, ctxWindow, ctxMaxTokens);
  if (tooSmall) {
    console.error(`under: ${tooSmall}`);
    return 1;
  }
  const tooTight = contextTooTight(specId, ctxWindow, ctxMaxTokens);
  if (tooTight) console.error(`\x1b[33munder: ${tooTight}\x1b[0m`);

  process.stderr.write(
    `\x1b[2munder → ${spec.provider}/${spec.modelId}${routedTier ? ` (tier: ${routedTier})` : ""}\x1b[0m\n`,
  );
  // Warn for ANY non-loopback endpoint, not just the bundled one: --provider groq
  // and --base-url resolve to "custom" and were sending code off the machine
  // silently, which made the documented "warns before sending your code anywhere
  // remote" claim false. The notice states the fact rather than implying a third
  // party, since the host may be a gateway to your own hardware.
  const endpointUrl = providerBaseUrls[spec.provider] ?? "";
  const isLoopback = /^https?:\/\/(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?)(:|\/|$)/.test(endpointUrl);
  if (endpointUrl && !isLoopback && !process.env.UNDER_NO_EGRESS_NOTICE) {
    let host = endpointUrl;
    try {
      host = new URL(endpointUrl).host;
    } catch {
      /* keep the raw string */
    }
    process.stderr.write(
      `\x1b[33munder: ${host} is remote — code leaves this machine. ` +
        `Silence with UNDER_NO_EGRESS_NOTICE=1 if you own it.\x1b[0m\n`,
    );
  }

  // Warn on avoid-listed picks; harden the prompt for models mapped as needing
  // imperative instructions.
  const entry = mapEntry(modelMap, spec.provider, spec.modelId);
  if (entry?.avoid) {
    process.stderr.write(
      `\x1b[33munder: model map flags ${spec.provider}/${spec.modelId} as avoid${entry.notes ? ` (${entry.notes})` : ""}\x1b[0m\n`,
    );
  }

  // Build tool list: custom tools (repo_search, fan_out) + pi's standard tools.
  // fan_out is depth-gated: children spawned by a fan-out never get it, so
  // delegation cannot recurse.
  const atTopLevel = fanoutDepth() < maxFanoutDepth();
  const customTools: ToolDefinition[] = [rt.repoSearchTool, rt.hashEditTool, rt.batchEditTool, rt.lineAnchoredEditTool];
  if (atTopLevel) {
    // Children route to the map's delegateModel when set (e.g. a cheaper model
    // known to handle small discrete tasks), else inherit the parent's model.
    const childModel = modelMap.delegateModel ?? `${spec.provider}/${spec.modelId}`;
    customTools.push(rt.createFanOutTool({ modelArgs: ["-m", childModel] }));
  }
  const toolNames = parsed.toolList
    ? parsed.toolList.split(",").map((t) => t.trim())
    : [
        "read", "bash", "edit", "write", "grep", "find", "ls",
        "repo_search", "hash_edit", "batch_edit", "line_anchored_edit",
        ...(atTopLevel ? ["fan_out"] : []),
      ];

  // Standing user preferences apply to every run; the non-interactive directive
  // only to one-shot runs (the REPL has a human who can answer).
  const preferences = loadPreferences(cwd);
  const appendSystemPrompt: string[] = [];
  if (parsed.prompt) {
    appendSystemPrompt.push(NONINTERACTIVE_DIRECTIVE);
    if (entry?.traits?.includes("needs-imperative-prompts")) appendSystemPrompt.push(IMPERATIVE_BOOST);
  }
  if (preferences) appendSystemPrompt.push(preferences);

  let resourceLoader: ResourceLoaderInstance | undefined;
  if (appendSystemPrompt.length) {
    resourceLoader = new DefaultResourceLoader({ cwd, agentDir: piAgentDir(), appendSystemPrompt });
    await resourceLoader.reload();
  }

  const { session: baseSession } = await createAgentSession({
    cwd,
    agentDir: piAgentDir(),
    model,
    modelRuntime,
    sessionManager: sessionManager,
    tools: toolNames,
    customTools,
    ...(resourceLoader ? { resourceLoader } : {}),
  });

  const session = new AutoCompactingSession(baseSession);
  const unsubscribe = attachPrinter(baseSession);

  const collector = new RunCollector();
  const unsubscribeCollector = baseSession.subscribe((e: any) => collector.onEvent(e));

  process.on("SIGINT", () => {
    void session.abort();
  });

  /** One telemetry row per completed task — the evidence `under learn` reads. */
  const record = (prompt: string, outcome: "ok" | "error" | "aborted", errorMessage?: string) => {
    const usage = sessionUsage(session);
    recordRun({
      ts: new Date().toISOString(),
      provider: spec.provider,
      model: spec.modelId,
      ...(routedTier ? { tier: routedTier } : {}),
      promptHead: prompt.split("\n")[0]!.slice(0, 120),
      promptLength: prompt.length,
      tokensIn: usage.input,
      tokensOut: usage.output,
      durationMs: collector.durationMs,
      toolCalls: collector.toolCalls,
      tools: collector.tools,
      outcome,
      ...(errorMessage ? { errorMessage: errorMessage.slice(0, 200) } : {}),
      // Set by benchmark harnesses so they can attribute records to one run.
      // Children inherit it through the environment, so a fan-out's whole tree
      // carries the parent's tag.
      ...(process.env.UNDER_RUN_TAG ? { tag: process.env.UNDER_RUN_TAG } : {}),
      // The join key. Without it the trace corpus and the outcome log are two
      // piles of data with nothing connecting them.
      ...(sessionId ? { sessionId } : {}),
    });
  };

  // ---- planning tier -----------------------------------------------------
  // Spend the capable model once on deciding WHAT to do, then execute with the
  // cheap one. Opt-in per run, or automatic when the map defines a planning
  // tier and the task is one routing would have sent to `thinking` anyway.
  let planSummary: { model: string; steps: number; tokensIn: number; tokensOut: number } | null = null;
  let effectivePrompt = parsed.prompt;
  const planningTarget = tierModel(modelMap, "planning");
  const wantPlan =
    parsed.prompt !== undefined &&
    planningTarget !== undefined &&
    (parsed.plan === true || (parsed.plan !== false && routedTier === "thinking"));

  // An EXPLICIT --plan that cannot resolve a planning tier must say so. Without
  // this the flag is silently inert: `wantPlan` is false, so the "planning
  // failed" warning below — which lives inside the skipped block — never fires,
  // and the run is indistinguishable from one that never asked to plan. A
  // benchmark arm ran this way and was reported as a measurement of planning
  // for several hours; it was measuring nothing.
  if (parsed.plan === true && planningTarget === undefined) {
    console.error(
      `under: --plan needs a planning tier, and the model map does not define one.\n` +
        `  Add to ~/.underclass/model-map.json (or <repo>/.underclass/model-map.json):\n` +
        `    "endpoints": { "planner": "https://your-endpoint/v1" },\n` +
        `    "tiers": { "planning": { "endpoint": "planner", "model": "<model id>" } }\n` +
        `  A bare "tiers": { "planning": "provider/model" } also works.\n` +
        `  Template: bench/examples/model-map.example.json`,
    );
    return 1;
  }

  if (wantPlan && planningTarget && parsed.prompt) {
    const planEndpoint = {
      baseUrl: planningTarget.baseUrl ?? providerBaseUrls[spec.provider] ?? "",
      model: planningTarget.model,
      ...(parsed.apiKey ? { apiKey: parsed.apiKey } : {}),
    };
    process.stderr.write(`\x1b[2mplanning with ${planEndpoint.model}…\x1b[0m\n`);
    const plan = await makePlan(parsed.prompt, cwd, planEndpoint);
    if (plan) {
      effectivePrompt = planToPrompt(parsed.prompt, plan);
      planSummary = { model: plan.model, steps: plan.steps.length, tokensIn: plan.tokensIn, tokensOut: plan.tokensOut };
      process.stderr.write(
        `\x1b[2mplan: ${plan.steps.length} step(s), ${plan.tokensIn} in / ${plan.tokensOut} out\x1b[0m\n`,
      );
      for (const [i, s] of plan.steps.entries()) {
        process.stderr.write(`\x1b[2m  ${i + 1}. ${s.file ? s.file + ": " : ""}${s.action.slice(0, 90)}\x1b[0m\n`);
      }
    } else {
      // A failed plan must never block the work — fall through and run directly.
      process.stderr.write(`\x1b[33munder: planning failed; running the task directly\x1b[0m\n`);
    }
  }

  try {
    if (effectivePrompt) {
      // A stuck turn otherwise runs until the user gives up: observed live,
      // an agent burning 300s and writing nothing on a one-line task.
      let timedOut = false;
      const guard = parsed.timeoutSec
        ? setTimeout(() => {
            timedOut = true;
            process.stderr.write(`\x1b[33munder: aborting after ${parsed.timeoutSec}s (--timeout)\x1b[0m\n`);
            void session.abort();
          }, parsed.timeoutSec * 1000)
        : null;
      await session.prompt(effectivePrompt);
      if (guard) clearTimeout(guard);
      printUsage(session);
      const errorMessage = timedOut
        ? `timed out after ${parsed.timeoutSec}s`
        : (session.agent.state.errorMessage ?? detectSilentNoOp(session, collector.toolCalls));
      record(parsed.prompt ?? effectivePrompt, errorMessage ? (timedOut ? "aborted" : "error") : "ok", errorMessage);
      if (errorMessage) {
        console.error(`under: ${errorMessage}`);
        return 1;
      }
      return 0;
    }

    const scripted = !process.stdin.isTTY;
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    // readline holds the TTY in raw mode, so a process-level SIGINT handler
    // never fires here — Ctrl+C must be caught on the interface itself or a
    // running turn cannot be aborted.
    rl.on("SIGINT", () => {
      if (session.agent.state.isStreaming) {
        process.stderr.write("\x1b[2m^C — aborting turn\x1b[0m\n");
        void session.abort();
      } else {
        rl.close();
      }
    });
    if (!scripted) process.stderr.write("\x1b[2mREPL — Ctrl+D to exit\x1b[0m\n");
    let anyTurnFailed = false;
    while (true) {
      let line: string;
      try {
        line = await rl.question(scripted ? "" : "under> ");
      } catch {
        break; // closed
      }
      if (line.trim().length === 0) continue;
      await session.prompt(line);
      printUsage(session);
      const replError = session.agent.state.errorMessage;
      record(line, replError ? "error" : "ok", replError);
      if (replError) {
        console.error(`under: ${replError}`);
        anyTurnFailed = true;
      }
    }
    rl.close();
    // Piped/scripted use routes here too; exiting 0 after failed turns would
    // report success to the calling script.
    return anyTurnFailed ? 1 : 0;
  } finally {
    unsubscribeCollector();
    unsubscribe();
    session.dispose();
  }
}

/**
 * Set the exit code and let node exit once stdout has drained — process.exit()
 * truncates still-buffered piped output. The unref'd timer is a backstop for a
 * stray open handle keeping the loop alive.
 */
function finish(code: number): void {
  process.exitCode = code;
  const backstop = setTimeout(() => process.exit(code), 3000);
  backstop.unref();
}

main().then(finish, (err) => {
  console.error(`under: ${err instanceof Error ? err.message : String(err)}`);
  finish(1);
});
