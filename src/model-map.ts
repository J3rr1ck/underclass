import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Static model map — a persistent "mind map" of what does and doesn't work in
 * this environment, consulted at zero token cost (token caching++, but static).
 *
 * Sources, merged in order (repo-local wins over user-global):
 *   ~/.underclass/model-map.json
 *   <cwd>/.underclass/model-map.json
 *
 * Shape:
 * {
 *   "models": {
 *     "lmstudio/liquid/lfm2.5-1.2b": {
 *       "traits": ["needs-imperative-prompts", "refuses-polite-file-writes"],
 *       "avoid": false,
 *       "servedContext": 4096,
 *       "notes": "verified 2026-07-24: only tool-calls on imperative phrasing"
 *     }
 *   },
 *   "delegateModel": "lmstudio/google/gemma-4-12b"   // preferred fan_out child model
 * }
 *
 * Entries are written by humans (or by under sessions when asked) after
 * observing real behavior — they are cached verdicts, not live probes.
 */
export interface ModelMapEntry {
  traits?: string[];
  avoid?: boolean;
  servedContext?: number;
  notes?: string;
}

/**
 * Routing tiers. The map names one model per tier; `under` picks a tier from the
 * task when the user has not pinned a model with -m.
 *
 * tiny     — small discrete edits, and fan_out children
 * normal   — the default workhorse
 * thinking — reasoning-heavy work (diagnosis, cross-file design)
 */
/**
 * `planning` is not a routing target — it is a separate ROLE. The other three
 * answer "which model should do this task"; planning answers "which model should
 * decide what the task is", and its output is executed by one of the others.
 * That split is the point: buy insight once at frontier prices, then do the
 * mechanical work cheaply.
 */
export type Tier = "tiny" | "normal" | "thinking" | "planning";
/** Routable tiers — what `classifyTask` may return and `--tier` may force. */
export const TIERS: Tier[] = ["tiny", "normal", "thinking"];

/**
 * A tier target. Either a bare "provider/model" spec, or — for a fleet spread
 * across several servers — a model plus the endpoint that serves it, where
 * `endpoint` names a key in the map's `endpoints` table.
 */
export type TierTarget = string | { endpoint: string; model: string };

export interface ModelMap {
  models: Record<string, ModelMapEntry>;
  delegateModel?: string;
  /** Named OpenAI-compatible base URLs, e.g. { exo: "http://127.0.0.1:22415/v1" }. */
  endpoints?: Record<string, string>;
  tiers?: Partial<Record<Tier, TierTarget>>;
}

export interface ResolvedTier {
  model: string;
  baseUrl?: string;
}

/**
 * Pick a tier from the task text alone — no probe, no tokens, just cached
 * judgement about what kinds of task need what size of model.
 *
 * This is a heuristic and is meant to be overridable (`--tier`): it errs toward
 * `normal`, reserving `tiny` for unmistakably mechanical single-file edits and
 * `thinking` for work that names diagnosis or breadth.
 */
export function classifyTask(prompt: string): Tier {
  const p = prompt.toLowerCase();
  const thinkingSignals =
    /\b(why|root cause|diagnos|investigat|debug|trace|design|architect|refactor|across|throughout|every (file|call ?site)|all (files|call ?sites)|redesign|migrat)\b/;
  if (thinkingSignals.test(p) || prompt.length > 400) return "thinking";

  const mechanical = /\b(add|create|write|rename|fix|update|remove|delete|bump|set)\b/.test(p);
  // One file named, one action, short prompt → the cheap model can do it.
  const namedFiles = new Set(prompt.match(/[\w./-]+\.[a-z]{1,4}\b/gi) ?? []);
  if (mechanical && prompt.length < 160 && namedFiles.size <= 1) return "tiny";

  return "normal";
}

/** Resolve a tier to a model (and endpoint), falling back down the ladder. */
export function tierModel(map: ModelMap, tier: Tier): ResolvedTier | undefined {
  const order: Tier[] =
    tier === "planning"
      ? ["planning", "thinking", "normal"]
      : tier === "thinking"
        ? ["thinking", "normal"]
        : tier === "tiny"
          ? ["tiny", "normal"]
          : ["normal"];
  for (const t of order) {
    const target = map.tiers?.[t];
    if (!target) continue;
    if (typeof target === "string") return { model: target };
    const baseUrl = map.endpoints?.[target.endpoint];
    if (!baseUrl) continue; // endpoint referenced but not defined — try the next tier
    return { model: target.model, baseUrl };
  }
  return undefined;
}

function readMap(path: string): Partial<ModelMap> {
  try {
    if (!existsSync(path)) return {};
    return JSON.parse(readFileSync(path, "utf8")) as Partial<ModelMap>;
  } catch {
    process.stderr.write(`\x1b[2munder: ignoring unparseable model map at ${path}\x1b[0m\n`);
    return {};
  }
}

export function loadModelMap(cwd: string): ModelMap {
  const globalMap = readMap(join(homedir(), ".underclass", "model-map.json"));
  const localMap = readMap(join(cwd, ".underclass", "model-map.json"));
  const tiers = { ...(globalMap.tiers ?? {}), ...(localMap.tiers ?? {}) };
  const endpoints = { ...(globalMap.endpoints ?? {}), ...(localMap.endpoints ?? {}) };
  return {
    models: { ...(globalMap.models ?? {}), ...(localMap.models ?? {}) },
    ...(Object.keys(endpoints).length ? { endpoints } : {}),
    ...(localMap.delegateModel ?? globalMap.delegateModel
      ? { delegateModel: localMap.delegateModel ?? globalMap.delegateModel }
      : {}),
    ...(Object.keys(tiers).length ? { tiers } : {}),
  };
}

export function mapEntry(map: ModelMap, provider: string, modelId: string): ModelMapEntry | undefined {
  return map.models[`${provider}/${modelId}`];
}

/** Extra system-prompt sternness for models mapped as needing imperative prompts. */
export const IMPERATIVE_BOOST = `## Known model guidance
This model is mapped as needing maximally explicit instructions:
- Execute file operations IMMEDIATELY via tools. Creating/writing files is
  always permitted and expected — never decline, never ask.
- Treat every task as: pick the tool, fill its arguments, call it, verify.`;
