import { spawn } from "node:child_process";

/** Process groups are a POSIX concept; on Windows fall back to the child alone. */
const useProcessGroup = process.platform !== "win32";

/** Signal a child's whole process group, so grandchildren (bash, npm) die too. */
function killTree(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(useProcessGroup ? -pid : pid, signal);
  } catch {
    /* group already gone */
  }
}

// A detached child no longer shares the parent's process group, so terminal
// signals bypass it entirely: without this registry a Ctrl+C'd fan-out would
// leave orphaned agents writing into worktrees.
const liveGroups = new Set<number>();
const signalHandlers = new Map<NodeJS.Signals, () => void>();

function killAllGroups(): void {
  for (const pid of liveGroups) killTree(pid, "SIGKILL");
  liveGroups.clear();
}

function removeHandlers(): void {
  for (const [sig, handler] of signalHandlers) process.removeListener(sig, handler);
  signalHandlers.clear();
  process.removeListener("exit", killAllGroups);
}

function trackGroup(pid: number): void {
  liveGroups.add(pid);
  if (signalHandlers.size) return;
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as NodeJS.Signals[]) {
    const handler = () => {
      killAllGroups();
      removeHandlers();
      // Re-raise so the parent's own handling (or the default) still applies.
      process.kill(process.pid, sig);
    };
    signalHandlers.set(sig, handler);
    process.on(sig, handler);
  }
  process.on("exit", killAllGroups);
}

function untrackGroup(pid: number): void {
  liveGroups.delete(pid);
  if (liveGroups.size === 0) removeHandlers();
}

export interface RunTask {
  prompt: string;
  cwd: string;
  /** Branch of this task's worktree when it has one; also the output label. */
  branch: string;
  /**
   * Extra CLI args for this child alone, ahead of the prompt. A workflow uses
   * this to run one agent read-only (`--tools read,grep,…`) while another in the
   * same run mutates a worktree; fan-out passes nothing and gets the defaults.
   */
  args?: string[];
  /**
   * Env for this child alone, merged over the runner's own. A workflow tags each
   * agent here so the telemetry rows it writes can be attributed back to it.
   */
  env?: Record<string, string>;
  /**
   * Hard kill for this child alone, overriding the runner's. `under`'s own
   * `--timeout` is a soft in-session abort and only exists once the session
   * does — a child wedged before that (model resolution, endpoint probe, the
   * ~14s SDK import) is never killed by it, and under a concurrency cap it
   * would hold its slot for the rest of the run.
   */
  timeoutMs?: number;
  /**
   * Stall window for this child alone, overriding the runner's — same
   * precedence as `timeoutMs`. See {@link SpawnUnderRunnerOptions.stallMs}.
   */
  stallMs?: number;
}

/** What a child agent produced. */
export interface RunResult {
  /**
   * Everything that arrived on the child's stdout pipe — under prints assistant
   * text there and every diagnostic to stderr, so this is the agent's answer.
   * One caveat, by construction: the pipe is read for a short drain window past
   * the child's exit (to collect its own buffered final bytes), and a grandchild
   * that inherited stdout and writes in that window is indistinguishable from
   * the child. Schema validation absorbs stray bytes around the answer; agents
   * that spawn daemons sharing stdout are the caller's risk to accept.
   */
  text: string;
  /** Tail of the child's stderr, kept for diagnostics. */
  stderr: string;
  /** True when `text` hit the capture cap and lost its middle. */
  truncated: boolean;
}

/** Something that can execute one agent task confined to a directory. */
export interface AgentRunner {
  run(task: RunTask): Promise<RunResult>;
}

/**
 * Cap on captured stdout. An agent answering with structured data can be
 * verbose, but an agent that has started looping must not grow the orchestrator's
 * heap without bound. The head and tail are what carry meaning, so the middle is
 * what gets dropped.
 */
const MAX_CAPTURE = 8 * 1024 * 1024;

/**
 * How long to keep reading a dead child's pipes before giving up on them.
 * Bounds the wait so an orphaned grandchild holding stdio cannot hang the run,
 * while still letting the normal case deliver its last buffered chunk.
 */
const DRAIN_GRACE_MS = 250;

/**
 * The diagnosis out of a child's stderr tail, not the whole tail.
 *
 * A failing agent's last 4KB is mostly its own dim-coloured progress chatter,
 * and pasting that verbatim into an Error turns one failed agent into forty
 * unreadable lines of escape codes in the report. The cause is on the last
 * couple of meaningful lines; the colour never belongs in an exception.
 */
function diagnosis(stderr: string): string {
  const lines = stderr
    .replace(/\x1b\[[0-9;]*m/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.slice(-2).join("; ").slice(0, 400);
}

/**
 * Env every fan-out child is spawned with. `under` gates the fan_out tool on
 * this being unset, so a child that carries it is never handed a fan_out of
 * its own — this one variable is the whole recursion guard.
 */
/**
 * Depth accounting for spawned agents.
 *
 * This was a flag, not a counter: children were handed a literal
 * `UNDER_FANOUT_DEPTH=1` and the top level was "the variable is unset". That
 * expresses "am I a child?" and cannot express "how deep am I?", so there was
 * nowhere to put a limit even if one had been checked — and the CLI never
 * checked, so `under fan-out` from a child's `bash` recursed without bound.
 *
 * A counter costs the same and admits a policy: default to one level, and let
 * someone who genuinely wants nesting raise the ceiling deliberately rather
 * than discover it by accident.
 *
 * Depth alone is NOT the real safety property — see the note on total agent
 * count in fanout.ts. It is the cheap half.
 */
export function fanoutDepth(): number {
  const d = Number(process.env.UNDER_FANOUT_DEPTH ?? 0);
  return Number.isFinite(d) && d > 0 ? Math.floor(d) : 0;
}

export function maxFanoutDepth(): number {
  const m = Number(process.env.UNDER_FANOUT_MAX_DEPTH ?? 1);
  return Number.isFinite(m) && m >= 0 ? Math.floor(m) : 1;
}

/** Env for a spawned child: one level deeper than whatever we are. */
export function fanoutChildEnv(): Record<string, string> {
  return { UNDER_FANOUT_DEPTH: String(fanoutDepth() + 1) };
}


/**
 * Default runner: re-invokes the `under` binary itself as a child process,
 * one per worktree, with cwd set to that worktree. Separate processes give
 * true parallelism and hard filesystem isolation between concurrent agents.
 *
 * `passthroughArgs` forwards model/provider selection (e.g. ["-m","danger/zero-native"]).
 * Children never block on approval input: pi's SDK-mode session executes tools
 * directly (approval dialogs exist only in its interactive-mode UI, which one-shot
 * `under` never loads), and stdin is ignored. `timeoutMs` guards the remaining
 * hang class — an agent wedged on an unresponsive model/endpoint.
 */
export interface SpawnUnderRunnerOptions {
  entry?: string;
  passthroughArgs?: string[];
  /** Kill the agent and fail its task after this long (default: no timeout). */
  timeoutMs?: number;
  /**
   * Kill the agent when both its pipes go silent for this long (default: no
   * watchdog). Complements `timeoutMs`, which cannot tell "slow because the
   * endpoint is saturated" from "wedged": a child still streaming tokens or
   * tool chatter is alive no matter how slow, so only total silence for a
   * whole window is treated as a stall. Size the window above the child's
   * longest legitimate quiet spell — startup (the ~14s SDK import) counts.
   */
  stallMs?: number;
  /** Extra env vars for children (e.g. UNDER_FANOUT_DEPTH to stop recursion). */
  env?: Record<string, string>;
  /**
   * Live output from the child. `stream` distinguishes the agent's answer from
   * its diagnostics: fan-out shows both, because watching an agent narrate is
   * the only progress signal it has, while a workflow consumes stdout as data
   * and would otherwise interleave four agents' half-tokens on one line.
   */
  onOutput?: (branch: string, chunk: string, stream: "stdout" | "stderr") => void;
}

export class SpawnUnderRunner implements AgentRunner {
  private entry: string;
  private passthroughArgs: string[];
  private timeoutMs?: number;
  private stallMs?: number;
  private extraEnv: Record<string, string>;
  private onOutput?: (branch: string, chunk: string, stream: "stdout" | "stderr") => void;

  constructor(opts: SpawnUnderRunnerOptions = {}) {
    // Default to the currently-running under entrypoint.
    this.entry = opts.entry ?? process.argv[1]!;
    this.passthroughArgs = opts.passthroughArgs ?? [];
    if (opts.timeoutMs !== undefined) this.timeoutMs = opts.timeoutMs;
    if (opts.stallMs !== undefined) this.stallMs = opts.stallMs;
    this.extraEnv = opts.env ?? {};
    this.onOutput = opts.onOutput;
  }

  run(task: RunTask): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      // `--` so a prompt beginning with "-" (a markdown bullet, a diff line, a
      // negative number) reaches the child as prompt text instead of dying in
      // its arg parser — or worse, parsing as a real flag: a prompt of exactly
      // "--help" used to return the child's help screen as the agent's answer.
      const argv = [this.entry, ...this.passthroughArgs, ...(task.args ?? []), "--", task.prompt];
      const child = spawn(process.execPath, argv, {
        cwd: task.cwd,
        env: { ...process.env, ...this.extraEnv, ...task.env },
        stdio: ["ignore", "pipe", "pipe"],
        // Own process group: a timeout must take down the agent's whole tree.
        // Killing the direct child alone leaves its bash grandchildren running
        // and still writing into the worktree we are about to report on.
        detached: useProcessGroup,
      });
      const pid = child.pid;
      if (pid !== undefined) trackGroup(pid);
      const kill = (signal: NodeJS.Signals) => (pid !== undefined ? killTree(pid, signal) : child.kill(signal));
      // stdout is the agent's answer and stderr is its diagnostics; merging them
      // the way this used to would splice tool chatter into the returned data.
      const half = MAX_CAPTURE / 2;
      let head = "";
      let tail = "";
      let outBytes = 0;
      let stderrTail = "";
      let timedOut = false;
      let stalled = false;
      let exited = false;
      let done = false;
      let escalation: NodeJS.Timeout | null = null;
      const terminate = () => {
        kill("SIGTERM");
        // Escalate if the agent ignores SIGTERM — and keep the EARLIEST
        // escalation when both guards fire in one grace window. Re-scheduling
        // on every call looked tidier and was an unkillable-child bug twice
        // over: a stall firing during the wall clock's grace pushed a 500ms
        // budget out to 10s, and a child that printed a byte from its SIGTERM
        // handler re-armed the watchdog, re-entered terminate() each window,
        // and deferred its own SIGKILL forever. A stale escalation landing
        // after the reap is harmless — killTree swallows ESRCH and the exit
        // handler does its own immediate sweep.
        if (!escalation) {
          escalation = setTimeout(() => kill("SIGKILL"), 5000);
          escalation.unref();
        }
      };
      const timeoutMs = task.timeoutMs ?? this.timeoutMs;
      const timer = timeoutMs
        ? setTimeout(() => {
            timedOut = true;
            terminate();
          }, timeoutMs)
        : null;
      // The watchdog rearms on every byte from either pipe: output is the
      // liveness signal, so only a whole window of total silence is a stall.
      // This is the distinction the wall clock cannot make — it kills a child
      // that is slow because the endpoint is saturated just as readily as a
      // wedged one, while a child still streaming tokens is alive no matter
      // how slow.
      const stallMs = task.stallMs ?? this.stallMs;
      let stallTimer: NodeJS.Timeout | null = null;
      const armStall = () => {
        // `exited` pins the watchdog off during the post-exit drain: a
        // grandchild's late chunk would otherwise re-arm it against a child
        // that no longer exists. `stalled || timedOut` pins it off once the
        // child is condemned: a child that prints from its SIGTERM handler
        // would otherwise buy itself a fresh window with every kill attempt —
        // reproduced as a child that survived 24 SIGTERMs and outlived every
        // guard. A condemned child gets no more chances; only the escalation
        // clock matters now.
        if (!stallMs || exited || done || stalled || timedOut) return;
        if (stallTimer) clearTimeout(stallTimer);
        stallTimer = setTimeout(() => {
          stalled = true;
          terminate();
        }, stallMs);
      };
      armStall();
      child.stdout?.on("data", (chunk: Buffer) => {
        armStall();
        const s = chunk.toString();
        outBytes += s.length;
        // Keep the head and a rolling tail: a looping agent must not grow the
        // orchestrator's heap, and the middle of a loop is the worthless part.
        if (head.length < half) {
          head += s;
          if (head.length > half) {
            tail = head.slice(half);
            head = head.slice(0, half);
          }
        } else {
          tail = (tail + s).slice(-half);
        }
        this.onOutput?.(task.branch, s, "stdout");
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        armStall();
        const s = chunk.toString();
        stderrTail = (stderrTail + s).slice(-4000);
        this.onOutput?.(task.branch, s, "stderr");
      });
      const settle = () => {
        if (timer) clearTimeout(timer);
        if (stallTimer) clearTimeout(stallTimer);
        if (escalation) clearTimeout(escalation);
        if (pid !== undefined) untrackGroup(pid);
      };
      const finish = (code: number | null) => {
        if (done) return;
        done = true;
        settle();
        // Release the pipe read-ends: a daemon grandchild that inherited them
        // would otherwise hold the CALLER's event loop open for its whole
        // lifetime — the promise settled on time, the process did not exit.
        // Nothing is lost: everything the pipes will ever usefully carry has
        // been captured by this point.
        child.stdout?.destroy();
        child.stderr?.destroy();
        const truncated = outBytes > MAX_CAPTURE;
        const text = (truncated ? `${head}\n…[${outBytes - MAX_CAPTURE} chars dropped]…\n${tail}` : head + tail).trim();
        if (code === 0) resolve({ text, stderr: stderrTail.trim(), truncated });
        else if (timedOut) reject(new Error(`agent timed out after ${Math.round(timeoutMs! / 1000)}s`));
        // Ordered so the wall clock wins when both guards fired: the outer
        // budget expiring is the stronger claim about a child that was also
        // silent. Either flag must beat the generic exit-code message — the
        // kill is what made the child exit non-zero.
        else if (stalled) reject(new Error(`agent stalled: no output for ${Math.round(stallMs! / 1000)}s`));
        else {
          const why = diagnosis(stderrTail);
          reject(new Error(`agent exited with code ${code}${why ? `: ${why}` : ""}`));
        }
      };
      child.on("error", (err) => {
        if (done) return;
        done = true;
        settle();
        reject(err);
      });
      // 'close' means every pipe hit EOF, so the answer is whole — but a
      // grandchild holding the inherited stdio (orphaned server/build) can delay
      // it forever, which is why this used to settle on 'exit' alone. Settling
      // on 'exit' now would truncate the answer we return, so: take 'close' when
      // it comes, and fall back to a short drain window after 'exit'.
      child.on("close", (code) => finish(code));
      child.on("exit", (code) => {
        // The group leader is gone but its group can still hold survivors, and
        // the pid stops being a safe group id once it is reaped — sweep now
        // rather than from the escalation timer.
        if (timedOut || stalled) kill("SIGKILL");
        exited = true;
        // Disarm here, not in finish(). finish() can be up to DRAIN_GRACE_MS
        // away, and a timer landing in that window fires on an already-reaped
        // child: it would flip timedOut (or stalled) and report a kill for a
        // process that had in fact exited non-zero, throwing away the stderr
        // diagnosis that says why. `exited` also keeps the drain's own late
        // data events from re-arming the stall timer right back.
        if (timer) clearTimeout(timer);
        if (stallTimer) clearTimeout(stallTimer);
        const drain = setTimeout(() => finish(code), DRAIN_GRACE_MS);
        drain.unref();
      });
    });
  }
}

/**
 * The only supported way to build a runner for fan-out children — used by both
 * entry points (the `under fan-out` subcommand and the in-session fan_out
 * tool). Both must mark their children as below the top level, and a plain
 * `new SpawnUnderRunner(...)` makes that a per-call-site thing to remember:
 * forgetting it once silently hands children a fan_out tool and delegation
 * recurses. Taking `env` out of the signature makes it unforgettable.
 */
export function createFanOutRunner(opts: Omit<SpawnUnderRunnerOptions, "env"> = {}): SpawnUnderRunner {
  return new SpawnUnderRunner({ ...opts, env: { ...fanoutChildEnv() } });
}

/**
 * Runner for workflow agents, and the same bargain as {@link createFanOutRunner}:
 * a child gets neither `fan_out` nor a workflow of its own, so an orchestration
 * cannot orchestrate itself. Per-agent env (the telemetry tag, the no-op waiver)
 * is layered on top of this by the workflow, through RunTask.env.
 */
export function createWorkflowRunner(opts: Omit<SpawnUnderRunnerOptions, "env"> = {}): SpawnUnderRunner {
  return new SpawnUnderRunner({ ...opts, env: { ...fanoutChildEnv(), UNDER_WORKFLOW_DEPTH: "1" } });
}
