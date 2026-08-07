import type { TSchema } from "typebox";
import type { AgentRunner } from "../runner.js";
import type { PoolEntry } from "./pool.js";

/**
 * Declared at the top of every workflow script. Read before the body runs, so
 * `--dry-run` can print what a script intends to do without spawning anything.
 */
export interface WorkflowMeta {
  name: string;
  description: string;
  /** Shown when listing saved workflows. */
  whenToUse?: string;
  phases?: Array<{ title: string; detail?: string }>;
}

/** Per-call knobs for {@link WorkflowHooks.agent}. */
export interface AgentOptions {
  /** Display name for this agent; defaults to a truncation of the prompt. */
  label?: string;
  /**
   * Progress group. Set this explicitly inside parallel()/pipeline() stages —
   * the ambient phase() is global state and a concurrent stage would otherwise
   * file its agents under whichever phase happened to be current.
   */
  phase?: string;
  /**
   * When set, the agent is required to answer with one JSON object satisfying
   * this schema, and `agent()` returns the parsed object instead of text.
   */
  schema?: TSchema;
  /** Model override for this agent (`provider/model`), else the run's default. */
  model?: string;
  /** Tool allowlist for this agent. Defaults to read-only unless it mutates. */
  tools?: string[];
  /**
   * `"worktree"` gives the agent its own git worktree and branch, so agents that
   * write files can run concurrently without fighting over the tree. Costs a
   * checkout each; omit it for the read-and-report agents that are the majority.
   */
  isolation?: "worktree";
  /** Hard timeout for this agent, overriding the run default. */
  timeoutSec?: number;
}

/** One agent call as it actually happened — the unit the journal records. */
export interface AgentRecord {
  id: number;
  label: string;
  phase: string;
  status: "ok" | "failed" | "skipped";
  ms: number;
  tokensIn: number;
  tokensOut: number;
  /** Branch, when the agent ran under worktree isolation. */
  branch?: string;
  /** Pool entry this agent was placed on, when a pool was in play. */
  endpoint?: string;
  /** Commit the agent's isolated work landed on, when it changed anything. */
  committed?: string;
  /**
   * Worktree deliberately left on disk because the work could not be committed.
   * Named in the report so the user has a path to recover from — the failure
   * mode this replaces destroyed the worktree and reported success.
   */
  worktree?: string;
  error?: string;
}

/** Token accounting for the run, shared by every agent it spawns. */
export interface Budget {
  /** Ceiling in output tokens, or null when the run is unbounded. */
  total: number | null;
  spent(): number;
  remaining(): number;
}

/** The globals a workflow script body is executed with. */
export interface WorkflowHooks {
  agent(prompt: string, opts?: AgentOptions): Promise<any>;
  parallel<T>(thunks: Array<() => Promise<T>>): Promise<Array<T | null>>;
  pipeline(items: any[], ...stages: Array<(prev: any, item: any, index: number) => any>): Promise<any[]>;
  phase(title: string): void;
  log(message: string): void;
  args: any;
  budget: Budget;
}

export interface RunWorkflowOptions {
  /** Path to the script, or its source directly (for tests and built-ins). */
  scriptPath?: string;
  source?: string;
  /** Value exposed to the script as `args`. */
  args?: unknown;
  /** Any directory inside the target repo. */
  repoDir: string;
  /** Spawns one child agent. Injected so the suite can run without a model. */
  runner: AgentRunner;
  /**
   * Max agents in flight at once, or "auto" to let the scheduler find the
   * width the endpoint can actually feed (AIMD over observed agent latency).
   */
  concurrency?: number | "auto";
  /** Output-token ceiling for the whole run. */
  budgetTokens?: number;
  /** Default per-agent timeout. */
  timeoutSec?: number;
  /**
   * Kill an agent that has produced NO output for this long. Unlike timeoutSec
   * this cannot misfire on a slow-but-progressing agent — a child streaming
   * tokens or tool markers is alive however long it takes — so it is the guard
   * that distinguishes "queued behind the GPU" from "wedged".
   */
  stallSec?: number;
  /**
   * Endpoints to spread agents across. On one GPU, N concurrent agents queue
   * and inflate per-agent latency ~N×; a second server is the only true second
   * lane. Agents with an explicit per-call `model:` bypass the pool.
   */
  pool?: PoolEntry[];
  /** Resume from this run's journal, replaying the unchanged prefix. */
  resumeFromRunId?: string;
  /** Parse meta and report the plan without spawning anything. */
  dryRun?: boolean;
  log?: (msg: string) => void;
  /** Where journals live (default: <repo>/.underclass/workflows). */
  stateDir?: string;
  /** Token-usage source, injected by tests so telemetry stays out of the suite. */
  usage?: (tag: string) => { tokensIn: number; tokensOut: number };
  /**
   * Run-level model selection, folded into the resume key. It reaches agents
   * through the runner's passthrough args rather than through any option here,
   * so resume cannot see it otherwise — and would replay another model's work.
   */
  modelSalt?: string;
}

export interface WorkflowReport {
  runId: string;
  meta: WorkflowMeta;
  /** Whatever the script returned. */
  value: unknown;
  agents: AgentRecord[];
  ms: number;
  tokensIn: number;
  tokensOut: number;
  /** Set when the script itself threw; agents already run are still reported. */
  error?: string;
  dryRun?: boolean;
  /** Branches left behind by worktree-isolated agents that committed work. */
  branches: string[];
}

/** Injected into every agent so a child cannot start a workflow of its own. */
export const WORKFLOW_CHILD_ENV: Readonly<Record<string, string>> = {
  UNDER_FANOUT_DEPTH: "1",
  UNDER_WORKFLOW_DEPTH: "1",
};
