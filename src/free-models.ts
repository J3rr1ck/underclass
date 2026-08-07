/**
 * OpenRouter's free tier, tracked rather than assumed.
 *
 * OpenRouter hosts a rotating set of zero-cost models. As of 2026-08-06 there
 * are 13 that are both free AND tool-capable, which is the pair that matters —
 * an agent that cannot call tools is useless regardless of price. The set
 * changes: models appear, get promoted to paid, or quietly stop answering. So
 * this discovers them rather than hardcoding a list, and remembers which ones
 * actually worked.
 *
 * Three states, deliberately distinguished, because they need different
 * responses and all three look like "it didn't work" from the call site:
 *
 *   LISTED       OpenRouter advertises it as free + tool-capable
 *   RATE-LIMITED HTTP 429 — the model is fine, you are over quota. Back off,
 *                do NOT blacklist; free-tier limits reset.
 *   DEAD         404/400/5xx or a network failure — skip it for a while.
 *
 * The free tier is rate-limited per account, so a busy agent will hit 429 well
 * before it exhausts anything else. That makes rate-limit handling the load-
 * bearing part of this file, not an afterthought.
 *
 * A key is required even for zero-cost models — an unauthenticated request gets
 * 401 ("No cookie auth credentials found"), verified. Keys are free to create.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { underDir } from "./config.js";

export const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

export interface FreeModel {
  id: string;
  contextLength: number;
  /** Does it advertise `tools` in supported_parameters? Non-negotiable for agent use. */
  tools: boolean;
  reasoning: boolean;
  /** Cap the endpoint enforces on generation, when it reports one. */
  maxCompletionTokens?: number;
  name?: string;
}

interface Cache {
  fetchedAt: number;
  models: FreeModel[];
  /** Per-model health, keyed by id. */
  health: Record<string, { until: number; reason: string; kind: "rate-limited" | "dead" }>;
}

// The catalogue moves on the order of days, not minutes; a stale list costs one
// failed request and self-corrects, while refetching on every invocation would
// add a network round trip to a path that is supposed to be free.
const CATALOGUE_TTL_MS = 6 * 60 * 60 * 1000;
// A 429 is transient by construction. Short enough to retry within a session.
const RATE_LIMIT_COOLDOWN_MS = 5 * 60 * 1000;
// A model that errors structurally is probably gone until the catalogue refreshes.
const DEAD_COOLDOWN_MS = 60 * 60 * 1000;

function cachePath(): string {
  return join(underDir(), "free-models.json");
}

function readCache(): Cache {
  try {
    const c = JSON.parse(readFileSync(cachePath(), "utf8")) as Cache;
    return { fetchedAt: c.fetchedAt ?? 0, models: c.models ?? [], health: c.health ?? {} };
  } catch {
    return { fetchedAt: 0, models: [], health: {} };
  }
}

function writeCache(c: Cache): void {
  try {
    writeFileSync(cachePath(), JSON.stringify(c, null, 2), { mode: 0o600 });
  } catch {
    /* best effort */
  }
}

/**
 * Ask OpenRouter what is free and tool-capable right now.
 *
 * Filters on BOTH pricing fields being zero: a model can be free to prompt and
 * charged on completion, and billing the user because we only checked one half
 * would be an unpleasant surprise. `supported_parameters=tools` is applied
 * server-side so the response is already the right shape.
 *
 * Listing needs no key. Using one does.
 */
export async function fetchFreeModels(timeoutMs = 15_000): Promise<FreeModel[]> {
  const res = await fetch(`${OPENROUTER_BASE}/models?supported_parameters=tools`, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "user-agent": "underclass/0.1.0-alpha.1" },
  });
  if (!res.ok) throw new Error(`OpenRouter /models returned HTTP ${res.status}`);
  const json = (await res.json()) as {
    data?: Array<{
      id: string;
      name?: string;
      context_length?: number;
      /** What the endpoint actually serves — differs from context_length. */
      top_provider?: { context_length?: number; max_completion_tokens?: number };
      pricing?: { prompt?: string; completion?: string };
      supported_parameters?: string[];
    }>;
  };
  return (json.data ?? [])
    .filter((m) => Number(m.pricing?.prompt ?? 1) === 0 && Number(m.pricing?.completion ?? 1) === 0)
    .map((m) => ({
      id: m.id,
      ...(m.name ? { name: m.name } : {}),
      // SERVED, not advertised. `context_length` on the filtered query is the
      // model's max across all providers — laguna reports 1,048,576 there while
      // the free endpoint it routes you to serves 262,144. Ranking or declaring
      // on the larger number promises context that does not exist.
      contextLength: m.top_provider?.context_length ?? m.context_length ?? 0,
      ...(m.top_provider?.max_completion_tokens
        ? { maxCompletionTokens: m.top_provider.max_completion_tokens }
        : {}),
      tools: (m.supported_parameters ?? []).includes("tools"),
      reasoning: (m.supported_parameters ?? []).includes("reasoning"),
    }))
    .filter((m) => m.tools)
    .sort((a, b) => b.contextLength - a.contextLength);
}

/** The catalogue, from cache when fresh. `force` refetches regardless. */
export async function freeModels(opts: { force?: boolean } = {}): Promise<{ models: FreeModel[]; fromCache: boolean }> {
  const cache = readCache();
  const fresh = Date.now() - cache.fetchedAt < CATALOGUE_TTL_MS;
  if (!opts.force && fresh && cache.models.length) return { models: cache.models, fromCache: true };
  try {
    const models = await fetchFreeModels();
    writeCache({ ...cache, fetchedAt: Date.now(), models });
    return { models, fromCache: false };
  } catch {
    // A failed refresh must not lose a usable list.
    return { models: cache.models, fromCache: true };
  }
}

/** Why this model is being skipped, or null if it is worth trying. */
export function modelHealth(id: string): { reason: string; kind: string } | null {
  const h = readCache().health[id];
  if (!h || Date.now() > h.until) return null;
  return { reason: h.reason, kind: h.kind };
}

/**
 * Record what happened, so the next pick is better informed.
 *
 * The distinction that earns its keep: 429 is NOT a reason to stop believing in
 * a model. Free-tier quota resets, and blacklisting on quota would gradually
 * disqualify every model that works — the busiest and most useful first.
 */
export function recordModelResult(id: string, status: number | "network"): void {
  const cache = readCache();
  if (status !== "network" && status >= 200 && status < 300) {
    delete cache.health[id];
    writeCache(cache);
    return;
  }
  const rateLimited = status === 429;
  cache.health[id] = {
    until: Date.now() + (rateLimited ? RATE_LIMIT_COOLDOWN_MS : DEAD_COOLDOWN_MS),
    reason: rateLimited ? "rate-limited (free-tier quota)" : `unavailable (${status})`,
    kind: rateLimited ? "rate-limited" : "dead",
  };
  for (const [k, v] of Object.entries(cache.health)) if (Date.now() > v.until + DEAD_COOLDOWN_MS) delete cache.health[k];
  writeCache(cache);
}

/**
 * Pick the best free model that is not currently in the doghouse.
 *
 * Ranked by context length, which is the only capability signal the API
 * actually exposes — it says nothing about active parameters, tool-call
 * reliability, or speed. `prefer` lets a caller pin a known-good id ahead of
 * that, which is what the model map is for once someone has measured one.
 */
export function pickFreeModel(models: FreeModel[], prefer: string[] = []): FreeModel | null {
  const usable = models.filter((m) => m.tools && !modelHealth(m.id));
  if (!usable.length) return null;
  for (const id of prefer) {
    const hit = usable.find((m) => m.id === id);
    if (hit) return hit;
  }
  return usable[0] ?? null;
}

/** Human-readable status, for `under providers --free`. */
export function renderFreeModels(models: FreeModel[], hasKey: boolean): string {
  const lines: string[] = [];
  lines.push(`OpenRouter free + tool-capable models (${models.length})`);
  lines.push("");
  if (!models.length) {
    lines.push("  none listed right now — the free set rotates; try again later.");
    return lines.join("\n");
  }
  const w = Math.max(...models.map((m) => m.id.length));
  for (const m of models) {
    const h = modelHealth(m.id);
    const mark = h ? (h.kind === "rate-limited" ? "\x1b[33m⏳\x1b[0m" : "\x1b[31m✗\x1b[0m") : "\x1b[32m✓\x1b[0m";
    lines.push(
      `  ${mark} ${m.id.padEnd(w)}  ${String(m.contextLength).padStart(8)} ctx` +
        (m.reasoning ? "  reasoning" : "") +
        (h ? `  \x1b[2m— ${h.reason}\x1b[0m` : ""),
    );
  }
  lines.push("");
  if (!hasKey) {
    lines.push("  \x1b[33mNo OPENROUTER_API_KEY set — free models still require a key.\x1b[0m");
    lines.push("    1. create one at https://openrouter.ai/keys  (free, no card)");
    lines.push("    2. export OPENROUTER_API_KEY=sk-or-…");
    lines.push("    3. under --provider openrouter -m <id from above> \"your task\"");
  } else {
    lines.push("  Use one:  under --provider openrouter -m <id> \"your task\"");
  }
  lines.push("");
  lines.push("  \x1b[2mFree tier is rate-limited per account, so expect 429s under an agent's");
  lines.push("  request rate. A 429 is a cooldown here, not a blacklist — quota resets.\x1b[0m");
  return lines.join("\n");
}
