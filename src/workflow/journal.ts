import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentOptions, AgentRecord } from "./types.js";

/**
 * Append-only record of what each agent was asked and what it answered, so a
 * run that was killed, interrupted or edited can pick up where it left off.
 *
 * Matching is on a hash of the call, never on the agent's position in the run.
 * Position looks like the obvious key and is wrong here for two reasons. Ids are
 * handed out when an agent *starts*, so under `pipeline()` — where item 3 can
 * reach stage 2 before item 1 leaves stage 1 — they fall in completion order and
 * differ between two runs of the same script; keying on them made every resume
 * of a multi-stage pipeline miss at the first agent and re-run everything.
 * And a positional key will happily replay a cached answer to a question the
 * script no longer asks. Hashing the call fixes both: a stage that changed
 * simply misses and runs again, and one that did not is replayed wherever it
 * turns up in the order.
 */
export interface JournalEntry {
  id: number;
  hash: string;
  value: unknown;
  record: AgentRecord;
}

export function hashCall(prompt: string, opts: AgentOptions, runSalt = ""): string {
  // Only what changes the question the agent is actually asked. `runSalt`
  // carries the run-level model selection, which lives in the runner's
  // passthrough args rather than in any per-call option — without it, resuming
  // with `-m other/model` would replay the previous model's answers and present
  // them as this run's.
  const salient = {
    prompt,
    schema: opts.schema ?? null,
    model: opts.model ?? null,
    tools: opts.tools ?? null,
    isolation: opts.isolation ?? null,
    runSalt,
  };
  return createHash("sha1").update(JSON.stringify(salient)).digest("hex").slice(0, 16);
}

export class Journal {
  /** Cached answers keyed by call hash; a list, so a repeated call replays once each. */
  private cached = new Map<string, JournalEntry[]>();
  private path: string;

  constructor(stateDir: string, runId: string, private runSalt = "", resumeFrom?: string) {
    this.path = join(stateDir, `${runId}.jsonl`);
    mkdirSync(dirname(this.path), { recursive: true });
    if (resumeFrom) this.load(join(stateDir, `${resumeFrom}.jsonl`));
  }

  private load(path: string): void {
    if (!existsSync(path)) return;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as JournalEntry;
        const bucket = this.cached.get(entry.hash);
        if (bucket) bucket.push(entry);
        else this.cached.set(entry.hash, [entry]);
      } catch {
        /* a truncated final line is normal after a kill */
      }
    }
  }

  /** Cached answer for this exact call, consumed so a repeat runs for real. */
  replay(prompt: string, opts: AgentOptions): { value: unknown; record: AgentRecord } | null {
    const bucket = this.cached.get(hashCall(prompt, opts, this.runSalt));
    const entry = bucket?.shift();
    if (!entry) return null;
    return { value: entry.value, record: entry.record };
  }

  /**
   * Record an answer worth replaying.
   *
   * Only successful agents land here. Journalling a failure would make `--resume`
   * replay it — turning the one thing resume exists for, recovering a run that
   * died on a timeout or a flat endpoint, into a run that reproduces the outage
   * instantly and for free.
   */
  append(id: number, prompt: string, opts: AgentOptions, value: unknown, record: AgentRecord): void {
    if (record.status !== "ok") return;
    const entry: JournalEntry = { id, hash: hashCall(prompt, opts, this.runSalt), value, record };
    try {
      appendFileSync(this.path, JSON.stringify(entry) + "\n", { mode: 0o600 });
    } catch {
      /* a journal that cannot be written must not fail the run it describes */
    }
  }
}
