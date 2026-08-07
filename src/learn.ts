import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { underDir } from "./config.js";
import { readRuns, type RunRecord } from "./telemetry.js";
import type { ModelMap, ModelMapEntry } from "./model-map.js";

/**
 * Derive model-map verdicts from recorded runs.
 *
 * The map is `under`'s cached knowledge about its environment — which models
 * work, which need blunt prompting, which tier a task belongs in. Hand-written,
 * it rots. This turns accumulated run history into proposed edits, so the map
 * converges on how the fleet actually behaves for this user's kind of work.
 *
 * Proposals are conservative and always shown before they are applied: a wrong
 * verdict silently misroutes every future run, so the bar for asserting one is
 * repeated evidence, not a single bad night.
 */
export interface Proposal {
  key: string;
  change: Partial<ModelMapEntry>;
  reason: string;
  /** How many runs back this proposal. */
  support: number;
}

const MIN_SUPPORT = 3;

function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = out.get(k);
    if (list) list.push(item);
    else out.set(k, [item]);
  }
  return out;
}

export function analyze(runs: RunRecord[]): Proposal[] {
  const proposals: Proposal[] = [];
  const byModel = groupBy(runs, (r) => `${r.provider}/${r.model}`);

  for (const [key, rs] of byModel) {
    if (rs.length < MIN_SUPPORT) continue;

    const failures = rs.filter((r) => r.outcome !== "ok");
    const failureRate = failures.length / rs.length;

    // A model that mostly fails is worth flagging, but only once there is
    // enough history that it isn't just a server that was down for an hour.
    if (failureRate > 0.5) {
      proposals.push({
        key,
        change: { avoid: true },
        reason: `${failures.length}/${rs.length} runs failed or aborted`,
        support: rs.length,
      });
    }

    // Never calling a tool across several successful runs is the signature of a
    // model that answers in prose instead of acting — the exact failure the
    // imperative prompt boost exists to correct.
    const succeeded = rs.filter((r) => r.outcome === "ok");
    if (succeeded.length >= MIN_SUPPORT && succeeded.every((r) => r.toolCalls === 0)) {
      proposals.push({
        key,
        change: { traits: ["needs-imperative-prompts"] },
        reason: `${succeeded.length} successful runs, none of which called a tool`,
        support: succeeded.length,
      });
    }

    // Context ceilings show up as a cluster of failures whose inputs are all
    // larger than anything that ever succeeded.
    const okMax = Math.max(0, ...succeeded.map((r) => r.tokensIn));
    const failMin = failures.length ? Math.min(...failures.map((r) => r.tokensIn).filter((n) => n > 0)) : 0;
    if (failures.length >= MIN_SUPPORT && okMax > 0 && failMin > okMax) {
      proposals.push({
        key,
        change: { servedContext: okMax },
        reason: `all failures used ≥${failMin} input tokens; largest success was ${okMax}`,
        support: failures.length,
      });
    }
  }

  return proposals;
}

/** Routing calibration: tiers whose runs systematically fail are mis-sized. */
export function analyzeRouting(runs: RunRecord[]): string[] {
  const notes: string[] = [];
  const byTier = groupBy(
    runs.filter((r) => r.tier),
    (r) => r.tier!,
  );
  for (const [tier, rs] of byTier) {
    if (rs.length < MIN_SUPPORT) continue;
    const failed = rs.filter((r) => r.outcome !== "ok").length;
    if (failed / rs.length > 0.5) {
      notes.push(
        `tier '${tier}': ${failed}/${rs.length} runs failed — the model mapped to it is likely too small ` +
          `for the work being routed there, or needs a reduced toolset.`,
      );
    }
  }
  return notes;
}

function mapPath(): string {
  return join(underDir(), "model-map.json");
}

export function applyProposals(proposals: Proposal[]): number {
  const path = mapPath();
  const map: ModelMap = existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf8")) as ModelMap)
    : { models: {} };
  map.models ??= {};

  let applied = 0;
  for (const p of proposals) {
    const existing: ModelMapEntry = map.models[p.key] ?? {};
    const merged: ModelMapEntry = { ...existing, ...p.change };
    if (p.change.traits) {
      merged.traits = [...new Set([...(existing.traits ?? []), ...p.change.traits])];
    }
    const stamp = `learned ${new Date().toISOString().slice(0, 10)}: ${p.reason}`;
    merged.notes = existing.notes ? `${existing.notes}; ${stamp}` : stamp;
    map.models[p.key] = merged;
    applied++;
  }
  writeFileSync(path, JSON.stringify(map, null, 2) + "\n", { mode: 0o600 });
  return applied;
}

export function runLearn(apply: boolean): number {
  const runs = readRuns();
  if (runs.length === 0) {
    console.log("No recorded runs yet — use under normally and the map will have evidence to learn from.");
    return 0;
  }
  const proposals = analyze(runs);
  const routing = analyzeRouting(runs);

  console.log(`Analyzed ${runs.length} run(s).\n`);
  if (proposals.length === 0) {
    console.log("No model-map changes proposed.");
  } else {
    for (const p of proposals) {
      console.log(`  ${p.key}`);
      console.log(`    ${JSON.stringify(p.change)}`);
      console.log(`    why: ${p.reason} (${p.support} runs)`);
    }
  }
  if (routing.length) {
    console.log("\nRouting notes:");
    for (const n of routing) console.log(`  - ${n}`);
  }

  if (!apply) {
    if (proposals.length) console.log(`\nRe-run with --apply to write these to ${mapPath()}`);
    return 0;
  }
  const n = applyProposals(proposals);
  console.log(`\nApplied ${n} change(s) to ${mapPath()}`);
  return 0;
}
