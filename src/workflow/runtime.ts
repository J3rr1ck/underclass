import { AsyncLocalStorage } from "node:async_hooks";
import { runOneAgent, type AgentContext } from "./agent.js";
import type { AgentOptions, AgentRecord, Budget, WorkflowHooks } from "./types.js";

/**
 * Runaway backstop, not a design limit. A workflow that has spawned this many
 * agents has a loop with no exit condition, and the useful failure is a clear
 * error rather than an afternoon of quietly burning the endpoint.
 */
const MAX_AGENTS = 1000;

/**
 * How deep in a pipeline the currently-running code sits: 0 outside any
 * pipeline, stage index + 1 inside one. Threaded through the async context
 * rather than through arguments, because the calls that need it are the user's
 * own `agent()` calls, made from inside callbacks whose signatures this module
 * does not control.
 */
const stageDepth = new AsyncLocalStorage<number>();

// "auto" width tuning. Starting narrow costs one wave of fast completions to
// recover from; starting wide costs a pileup of slowed agents before the
// median even notices. The cap matches what a local endpoint can plausibly
// feed, which is the machine "auto" exists for.
const AUTO_START_WIDTH = 2;
const AUTO_MAX_WIDTH = 8;
/** Completions the width signal is read from — one straggler must not halve the pool. */
const SIGNAL_WINDOW = 3;
/**
 * Completions the baseline minimum is drawn from. Long enough that a real
 * change of pace has to persist to move it, short enough that one freak-fast
 * completion ages out instead of condemning the rest of the run as congestion.
 */
const BASELINE_WINDOW = 10;
/** A median above this multiple of the baseline reads as congestion. */
const SLOW_FACTOR = 2.5;
/** A median below this multiple of the baseline reads as headroom. */
const FAST_FACTOR = 1.5;

/** One queued acquire(). `seq` keeps FIFO order within a priority level. */
interface Waiter {
  priority: number;
  seq: number;
  resolve: () => void;
}

export interface RuntimeOptions {
  ctx: AgentContext;
  /**
   * Max agents in flight at once. `"auto"` lets the run find its own width:
   * start at 2, widen toward 8 while completions stay near the fastest one
   * seen, halve when they blow past it. The endpoint's real throughput is not
   * knowable up front, and a fixed guess is wrong on every other machine.
   */
  concurrency: number | "auto";
  budgetTokens?: number;
  /** Replays a matching completed agent instead of running it, for resume. */
  replay?: (prompt: string, opts: AgentOptions) => { value: unknown; record: AgentRecord } | null;
  onRecord?: (record: AgentRecord, value: unknown, prompt: string, opts: AgentOptions) => void;
}

/**
 * The execution engine behind a workflow script's globals.
 *
 * Concurrency is capped across the whole run rather than per call site, so a
 * script can hand `pipeline()` two hundred items without deciding in advance how
 * many endpoints its machine can feed. `pipeline()` is deliberately barrier-free:
 * every item walks its own chain of stages, so a slow item in stage one never
 * holds back an item that is ready for stage three.
 *
 * When slots are scarce they go to the deepest pipeline stage first: finishing
 * an item already in flight shortens the run in a way that starting a fresh
 * one never does.
 */
export class WorkflowRuntime {
  readonly records: AgentRecord[] = [];
  private nextId = 1;
  private inFlight = 0;
  private waiting: Waiter[] = [];
  private waitSeq = 0;
  private currentPhase = "";
  private spawned = 0;
  private inFlightAgents = new Set<Promise<unknown>>();

  private readonly adaptive: boolean;
  private currentWidth: number;
  /**
   * Recent completion times the baseline is drawn from. A window, not a
   * lifetime minimum: with a lifetime min, one anomalously fast completion —
   * an endpoint answering from cache, a trivial canned reply — made every
   * honest completion after it read as congestion, and the width collapsed to
   * 1 for the rest of the run with no way back. In a window the anomaly ages
   * out and the width recovers.
   */
  private baselineWindow: number[] = [];
  private recentMs: number[] = [];
  private completionsSinceAdjust = 0;

  constructor(private opts: RuntimeOptions) {
    this.adaptive = opts.concurrency === "auto";
    this.currentWidth = opts.concurrency === "auto" ? AUTO_START_WIDTH : opts.concurrency;
  }

  /** Agents allowed in flight right now. Fixed for numeric concurrency; live under "auto". */
  get width(): number {
    return this.currentWidth;
  }

  /** Wait for agents the script left running, so none outlives the report. */
  async drain(): Promise<void> {
    while (this.inFlightAgents.size) {
      await Promise.allSettled([...this.inFlightAgents]);
    }
  }

  private acquire(priority: number): Promise<void> {
    if (this.inFlight < this.currentWidth) {
      this.inFlight++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.waiting.push({ priority, seq: this.waitSeq++, resolve }));
  }

  /**
   * The waiter the next free slot belongs to: deepest pipeline stage first,
   * submission order within a stage. Verifiers are short and readers are long,
   * so draining work-in-progress cuts average completion time across the run.
   * Starving depth 0 while deeper work waits is intended, and cannot deadlock:
   * deep work only exists because shallower work already completed, so the
   * queue always empties from the deepest level down.
   */
  private takeNextWaiter(): Waiter | undefined {
    if (this.waiting.length === 0) return undefined;
    let best = 0;
    for (let i = 1; i < this.waiting.length; i++) {
      const candidate = this.waiting[i];
      const chosen = this.waiting[best];
      if (
        candidate.priority > chosen.priority ||
        (candidate.priority === chosen.priority && candidate.seq < chosen.seq)
      ) {
        best = i;
      }
    }
    return this.waiting.splice(best, 1)[0];
  }

  /**
   * Hand the slot straight to the next waiter, so the cap is never undershot —
   * unless "auto" has narrowed the width since this agent started, in which
   * case the slot retires instead. Decreases work by attrition: an agent
   * already running is never killed for the sake of a number, it just is not
   * replaced when it finishes.
   */
  private release(): void {
    if (this.inFlight <= this.currentWidth) {
      const next = this.takeNextWaiter();
      if (next) {
        next.resolve();
        return;
      }
    }
    this.inFlight--;
  }

  /** An increase is inert until occupied: admit waiters up to the new width. */
  private wakeWaiters(): void {
    while (this.inFlight < this.currentWidth) {
      const next = this.takeNextWaiter();
      if (!next) return;
      this.inFlight++;
      next.resolve();
    }
  }

  /**
   * Width tuning under "auto", fed one real completion at a time — the replay
   * path never reaches this, because a journal's recorded times describe some
   * previous run's endpoint. The baseline is the fastest RECENT agent (see
   * baselineWindow); the signal is the median of the last few, so one straggler
   * cannot halve the pool on its own. Adjustments wait out a full wave of
   * completions at the current width, because the first completions after a
   * change still carry times from the width being replaced.
   */
  private noteCompletion(ms: number): void {
    if (!this.adaptive) return;
    this.baselineWindow.push(ms);
    if (this.baselineWindow.length > BASELINE_WINDOW) this.baselineWindow.shift();
    const baselineMs = Math.min(...this.baselineWindow);
    this.recentMs.push(ms);
    if (this.recentMs.length > SIGNAL_WINDOW) this.recentMs.shift();
    this.completionsSinceAdjust++;
    if (this.completionsSinceAdjust < this.currentWidth) return;
    const sorted = [...this.recentMs].sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];
    if (median > baselineMs * SLOW_FACTOR) {
      // Halve rather than decrement: by the time congestion shows up in a
      // median the pool is well past the useful width, and stepping down one
      // slot per wave would keep it saturated for several more.
      this.currentWidth = Math.max(1, Math.floor(this.currentWidth / 2));
      this.completionsSinceAdjust = 0;
    } else if (median < baselineMs * FAST_FACTOR) {
      this.currentWidth = Math.min(AUTO_MAX_WIDTH, this.currentWidth + 1);
      this.completionsSinceAdjust = 0;
      this.wakeWaiters();
    }
    // Between the thresholds there is no signal either way. The counter keeps
    // running, so the next clear reading acts at once instead of waiting out
    // another whole wave.
  }

  get budget(): Budget {
    const total = this.opts.budgetTokens ?? null;
    const spent = () => this.records.reduce((n, r) => n + r.tokensOut, 0);
    return {
      total,
      spent,
      remaining: () => (total === null ? Number.POSITIVE_INFINITY : Math.max(0, total - spent())),
    };
  }

  /**
   * Why the run was cut short, if it was.
   *
   * `parallel()` and `pipeline()` swallow exceptions by design — one dead agent
   * must not discard its siblings' work — which also swallows the budget and
   * backstop throws. Recording the reason here means a run truncated by its own
   * ceiling is still reported as truncated instead of exiting 0 with a partial
   * answer that looks complete.
   */
  fatal: string | null = null;

  hooks(args: unknown, log: (msg: string) => void): WorkflowHooks {
    /** The ceiling, re-read at the last moment before an agent is spawned. */
    const checkLimits = (): void => {
      if (this.spawned >= MAX_AGENTS) {
        const why = `workflow exceeded ${MAX_AGENTS} agents — check the script for a loop that never ends`;
        this.fatal ??= why;
        throw new Error(why);
      }
      const budget = this.budget;
      if (budget.total !== null && budget.remaining() <= 0) {
        const why = `workflow exhausted its ${budget.total} output-token budget (spent ${budget.spent()})`;
        this.fatal ??= why;
        throw new Error(why);
      }
    };

    const agent = async (prompt: string, opts: AgentOptions = {}): Promise<any> => {
      const withPhase: AgentOptions = { ...opts, phase: opts.phase ?? this.currentPhase };

      const cached = this.opts.replay?.(prompt, withPhase);
      if (cached) {
        this.records.push(cached.record);
        // Carried into the new run's journal too, or resuming a resumed run
        // would find only the agents that re-ran and repeat everything else.
        this.opts.onRecord?.(cached.record, cached.value, prompt, withPhase);
        return cached.value;
      }

      // Checked here and again after acquire(). Here alone is useless under
      // concurrency: parallel() invokes every thunk in one microtask drain, so
      // a whole batch clears the gate before any of it has spent a token, and a
      // 500-token ceiling admits twenty agents. The slot is the serialisation
      // point, so the ceiling has to be read on the far side of it.
      checkLimits();
      // The priority is the caller's pipeline depth, read from the async
      // context: an agent called from stage three outranks one from stage one,
      // wherever in the user's code the call happens to sit.
      await this.acquire(stageDepth.getStore() ?? 0);
      try {
        checkLimits();
        this.spawned++;
        const { value, record } = await runOneAgent(this.opts.ctx, this.nextId++, prompt, withPhase);
        // Only successful agents feed the width tuner. A failure's duration
        // measures the failure path, not the endpoint's pace — and the fast
        // ones (a refused worktree dies in single-digit ms) would poison the
        // baseline so thoroughly that every real completion afterwards reads
        // as congestion and the width collapses to 1 for the rest of the run.
        if (record.status === "ok") this.noteCompletion(record.ms);
        this.records.push(record);
        this.opts.onRecord?.(record, value, prompt, withPhase);
        if (record.status === "failed") {
          log(`  ✗ ${record.label}: ${record.error}`);
          return null;
        }
        return value;
      } finally {
        this.release();
      }
    };

    /**
     * Every agent still running. The script's promise settling does not mean its
     * agents have: a `void agent(...)` or an abandoned branch of a `Promise.race`
     * leaves one in flight, and returning then would strand its worktree with
     * nothing left to tear it down.
     */
    const track = <T>(p: Promise<T>): Promise<T> => {
      this.inFlightAgents.add(p as Promise<unknown>);
      return p.finally(() => this.inFlightAgents.delete(p as Promise<unknown>)) as Promise<T>;
    };
    const trackedAgent = (prompt: string, opts?: AgentOptions) => track(agent(prompt, opts));

    const parallel = async <T>(thunks: Array<() => Promise<T>>): Promise<Array<T | null>> =>
      // Never rejects: one dead agent must not discard every sibling's work.
      // Callers filter(Boolean) — which the failure path makes visible, unlike
      // an exception that takes the whole barrier down with it.
      Promise.all(thunks.map((t) => Promise.resolve().then(t).catch(() => null)));

    const pipeline = async (
      items: any[],
      ...stages: Array<(prev: any, item: any, index: number) => any>
    ): Promise<any[]> =>
      Promise.all(
        items.map(async (item, index) => {
          let value: any = item;
          for (let depth = 0; depth < stages.length; depth++) {
            const stage = stages[depth];
            try {
              // Each stage runs under its depth so the agent() calls inside
              // the user's callback inherit it through the async context and
              // queue ahead of shallower work: finishing items beats starting
              // them.
              value = await stageDepth.run(depth + 1, () => stage(value, item, index));
            } catch {
              // Drop this item and skip its remaining stages; the rest carry on.
              return null;
            }
          }
          return value;
        }),
      );

    return {
      agent: trackedAgent,
      parallel,
      pipeline,
      phase: (title: string) => {
        this.currentPhase = title;
        log(`── ${title}`);
      },
      log,
      args,
      budget: this.budget,
    };
  }
}
