import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { underDir } from "./config.js";
import type { Tier } from "./model-map.js";

/**
 * Append-only record of what actually happened on each run.
 *
 * This is the raw material the model map is learned from: the map started as a
 * hand-written set of verdicts, which goes stale the moment the fleet changes.
 * Recording outcomes lets `under learn` derive those verdicts from evidence
 * instead — which model timed out, which never called a tool, whether a routing
 * tier was too small for the task.
 *
 * Local-only and prompt-truncated: this file never leaves the machine, and a
 * full prompt log would be both a privacy problem and useless noise.
 */
export interface RunRecord {
  ts: string;
  provider: string;
  model: string;
  tier?: Tier;
  /** First line of the task, truncated — enough to spot a pattern, not a transcript. */
  promptHead: string;
  promptLength: number;
  tokensIn: number;
  tokensOut: number;
  durationMs: number;
  toolCalls: number;
  /** Distinct tool names used, for spotting models that never call tools at all. */
  tools: string[];
  outcome: "ok" | "error" | "aborted";
  errorMessage?: string;
  /**
   * Opaque tag from `UNDER_RUN_TAG`, for attributing records to one experiment.
   *
   * Every `under` process appends to one shared file, so "records added between
   * t0 and t1" is NOT a reliable way to cost a run — any other agent on the
   * machine lands in the same window. That is not hypothetical: it silently
   * tripled a measured arm in bench/fanout-cost.mjs and produced a headline
   * conclusion that was wrong until the timestamps were read.
   */
  tag?: string;
  /**
   * The pi session file this run wrote, under ~/.underclass/sessions.
   *
   * The join key between the outcome log and the trace corpus. Full traces —
   * every message and tool call — are the raw material for training a model on
   * this agent's behaviour, and without this field you have both halves and no
   * way to ask for "traces from runs that succeeded".
   */
  sessionId?: string;
}

export function telemetryPath(): string {
  return join(underDir(), "runs.jsonl");
}

/** Append one record. Never throws: telemetry must not break a working run. */
export function recordRun(rec: RunRecord): void {
  if (process.env.UNDER_NO_TELEMETRY) return;
  try {
    appendFileSync(telemetryPath(), JSON.stringify(rec) + "\n", { mode: 0o600 });
  } catch {
    /* telemetry is best-effort */
  }
}

export function readRuns(limit = 5000): RunRecord[] {
  const path = telemetryPath();
  if (!existsSync(path)) return [];
  try {
    const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
    return lines
      .slice(-limit)
      .map((l) => {
        try {
          return JSON.parse(l) as RunRecord;
        } catch {
          return null;
        }
      })
      .filter((r): r is RunRecord => r !== null);
  } catch {
    return [];
  }
}

/** Collects per-run tool usage and timing from session events. */
export class RunCollector {
  private startedAt = Date.now();
  private counts = new Map<string, number>();

  onEvent(event: { type?: string; toolName?: string }): void {
    if (event?.type === "tool_execution_start" && event.toolName) {
      this.counts.set(event.toolName, (this.counts.get(event.toolName) ?? 0) + 1);
    }
  }

  get durationMs(): number {
    return Date.now() - this.startedAt;
  }
  get toolCalls(): number {
    let n = 0;
    for (const c of this.counts.values()) n += c;
    return n;
  }
  get tools(): string[] {
    return [...this.counts.keys()].sort();
  }
}
