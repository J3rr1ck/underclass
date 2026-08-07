import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

// api.danger.plus is the inference gateway. (danger.plus/api/v1 is the site's
// placeholder: it answers, ignores tool_choice, and serves no real model — so
// pointing here matters, and `under doctor` will tell you which one you hit.)
export const UNDER_VERSION = "0.1.0-alpha.1";
export const DEFAULT_DANGER_BASE = "https://api.danger.plus/v1";
// The gateway is a LiteLLM proxy over exo: /models lists the whole catalog, but
// only models with a *running instance* answer — a listed id can 404 with "No
// instance found". This default is one verified live; `under doctor` sweeps
// several to tell you what is actually serving right now.
export const DEFAULT_DANGER_MODEL = "minimax-m2.7-jangtq-crack";
export const DEFAULT_GUEST_KEY = "danger_token_guest_mode";
export const LMSTUDIO_BASE = process.env.UNDERCLASS_LMSTUDIO_BASE ?? "http://localhost:1234/v1";
export const OLLAMA_BASE = process.env.UNDERCLASS_OLLAMA_BASE ?? "http://localhost:11434/v1";

export interface UnderOptions {
  model?: string; // "provider/model" or bare model id
  provider?: string; // danger | lmstudio | ollama | custom
  baseUrl?: string;
  apiKey?: string;
}

export interface ProviderPreset {
  baseUrl: string;
  authEnv?: string;
  defaultModel?: string;
  toolCalling?: boolean;
  notes?: string;
  privacy?: string;
}

let presetCache: Record<string, ProviderPreset> | null = null;

/**
 * Shipped connection presets for known OpenAI-compatible endpoints, so getting
 * started is `--provider groq` rather than copy-pasting a base URL and guessing
 * which env var holds the key. Provider catalogs move faster than a checked-in
 * file, so `under doctor` re-verifies rather than trusting these.
 */
export function loadPresets(): Record<string, ProviderPreset> {
  if (presetCache) return presetCache;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // dist/ and src/ both resolve: the JSON is copied next to the build output.
    for (const candidate of [join(here, "data", "providers.json"), join(here, "..", "src", "data", "providers.json")]) {
      if (existsSync(candidate)) {
        presetCache = JSON.parse(readFileSync(candidate, "utf8")) as Record<string, ProviderPreset>;
        return presetCache;
      }
    }
  } catch {
    /* presets are a convenience, never a hard dependency */
  }
  presetCache = {};
  return presetCache;
}

export function underDir(): string {
  const dir = join(homedir(), ".underclass");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/** Isolated pi agentDir so under never touches a user's ~/.pi setup. */
export function piAgentDir(): string {
  const dir = join(underDir(), "pi");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

interface ProviderConfig {
  name?: string;
  baseUrl: string;
  api: string;
  apiKey?: string;
  headers?: Record<string, string>;
  compat?: Record<string, boolean>;
  models: Array<{
    id: string;
    name?: string;
    reasoning?: boolean;
    input?: string[];
    contextWindow?: number;
    maxTokens?: number;
    cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  }>;
}

export const KNOWN_PROVIDERS = ["danger", "lmstudio", "ollama", "custom"];

/**
 * Strip a leading provider prefix, if and only if it is one. Model ids are
 * routinely namespaced (mlx-community/Qwen3-…, google/gemma-4-12b), so a blind
 * split on "/" mangles them into ids the server has never heard of.
 */
export function bareModelId(model: string): string {
  const at = model.indexOf("/");
  if (at === -1) return model;
  return KNOWN_PROVIDERS.includes(model.slice(0, at)) ? model.slice(at + 1) : model;
}

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const LOCAL_COMPAT = { supportsDeveloperRole: false, supportsReasoningEffort: false };

async function discoverModels(baseUrl: string, timeoutMs = 2000, apiKey?: string): Promise<DiscoveredModel[]> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, {
      signal: AbortSignal.timeout(timeoutMs),
      ...(apiKey ? { headers: { authorization: `Bearer ${apiKey}` } } : {}),
    });
    if (!res.ok) return [];
    // `context_length` is not in the OpenAI spec, but OpenRouter and several
    // other gateways report it here — and it is the only context signal they
    // give, since `discoverContextWindows()` probes LM Studio's own
    // /api/v0/models route which they do not have.
    //
    // Without this, any such endpoint fell through to UNKNOWN_CONTEXT = 8192,
    // pi budgeted generation out of that, and a fat agent prompt left
    // max_completion_tokens: 1 — one token out, no tool calls, nothing done.
    // Caught live against OpenRouter on a model that actually serves 262,144.
    const json = (await res.json()) as {
      data?: Array<{ id: string; context_length?: number; top_provider?: { context_length?: number } }>;
    };
    return (json.data ?? [])
      .filter((m) => !/embed|embedding/i.test(m.id))
      .map((m) => {
        // `top_provider.context_length` FIRST. `context_length` is the model's
        // theoretical maximum across every provider serving it;
        // `top_provider.context_length` is what the endpoint you will actually
        // hit serves. They differ, and the same API returns different values
        // depending on the query: for `poolside/laguna-s-2.1:free`,
        // /models?supported_parameters=tools reports context_length 1,048,576
        // with top_provider 262,144, while plain /models reports 262,144 for
        // both. Verified 2026-08-06.
        //
        // Declaring the larger number is UNDER-36 with the sign flipped: pi
        // budgets generation AND compaction from the declared window, so an
        // over-declaration means it declines to compact and the provider
        // rejects the request. A measurement outranks an advertisement.
        const ctx = m.top_provider?.context_length ?? m.context_length;
        return typeof ctx === "number" && ctx > 0 ? { id: m.id, contextWindow: ctx } : { id: m.id };
      });
  } catch {
    return [];
  }
}

/**
 * A discovered model, with its SERVED context window when the server reports it.
 *
 * This matters more than it looks. Declaring a context window we did not measure
 * is how an agent overflows silently: pi's compaction decides when to compact
 * from this number, so telling it 32K about an endpoint serving 8K guarantees the
 * overflow it exists to prevent. Measured on this machine — LM Studio served
 * `gemma-4-12b-it` at 8192 while we claimed 32768.
 *
 * Order of trust: what the server reports → what the model map recorded from
 * observed behaviour → a deliberately small floor.
 */
export interface DiscoveredModel {
  id: string;
  contextWindow?: number;
}

/** Conservative when nothing is known: too small merely compacts early; too large corrupts the run. */
const UNKNOWN_CONTEXT = 8192;

function localModelEntries(models: Array<string | DiscoveredModel>, mapped?: Record<string, number>): ProviderConfig["models"] {
  return models.map((m) => {
    const model: DiscoveredModel = typeof m === "string" ? { id: m } : m;
    const ctx = model.contextWindow ?? mapped?.[model.id] ?? UNKNOWN_CONTEXT;
    return {
      id: model.id,
      input: ["text"],
      reasoning: false,
      contextWindow: ctx,
      // An agent turn must be able to finish a tool call; cap generation well
      // below the window so a long prompt cannot leave no room to answer.
      maxTokens: Math.max(1024, Math.min(8192, Math.floor(ctx / 4))),
      cost: ZERO_COST,
    };
  });
}

/**
 * Ask a server what context it is actually serving.
 *
 * LM Studio exposes `loaded_context_length` on its native /api/v0/models route
 * (the OpenAI-compatible /v1/models does not carry it). Anything else returns
 * nothing and callers fall back.
 */
async function discoverContextWindows(baseUrl: string, timeoutMs = 3000): Promise<Record<string, number>> {
  const root = baseUrl.replace(/\/v1\/?$/, "").replace(/\/$/, "");
  try {
    const res = await fetch(`${root}/api/v0/models`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return {};
    const json = (await res.json()) as { data?: Array<{ id: string; loaded_context_length?: number; max_context_length?: number }> };
    const out: Record<string, number> = {};
    for (const m of json.data ?? []) {
      // loaded_context_length is what is SERVED right now; max_context_length is
      // what the weights allow and is not a promise about this session.
      const ctx = m.loaded_context_length;
      if (typeof ctx === "number" && ctx > 0) out[m.id] = ctx;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Ask Ollama what context its loaded models are actually serving.
 *
 * Ollama's OpenAI-compatible `/v1/models` carries no context field at all, and
 * this was never called for it — so every Ollama model was declared
 * `UNKNOWN_CONTEXT`. Its native `/api/ps` reports `context_length` per loaded
 * model (documented at `docs/LOCAL-MODEL-PAIN.md`), which is the served number,
 * not the weights' maximum.
 *
 * Only loaded models appear, which is the right scope: an unloaded model has no
 * served context to report, and guessing one is how UNDER-36 happened.
 */
async function discoverOllamaContext(baseUrl: string, timeoutMs = 3000): Promise<Record<string, number>> {
  const root = baseUrl.replace(/\/v1\/?$/, "").replace(/\/$/, "");
  try {
    const res = await fetch(`${root}/api/ps`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return {};
    const json = (await res.json()) as { models?: Array<{ name?: string; model?: string; context_length?: number }> };
    const out: Record<string, number> = {};
    for (const m of json.models ?? []) {
      const ctx = m.context_length;
      if (typeof ctx !== "number" || ctx <= 0) continue;
      // Ollama names a model both ways depending on the route; record both so
      // whichever id /v1/models handed us finds its window.
      for (const id of [m.name, m.model]) if (id) out[id] = ctx;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * pi's own clamp, reproduced so we can ask the question *before* the first call.
 *
 * `clampMaxTokensToContext` in `pi-ai/dist/api/simple-options.js`:
 *   available = contextWindow - promptTokens - 4096
 *   maxTokens = min(maxTokens, max(1, available))
 * Verified against node_modules rather than inferred — this repo has shipped two
 * guards written against an assumed SDK shape, and both were wrong from the
 * first commit.
 */
export const PI_CONTEXT_SAFETY_TOKENS = 4096;

export function generationBudget(contextWindow: number, promptTokens: number, maxTokens: number): number {
  if (contextWindow <= 0) return Math.max(1, maxTokens);
  return Math.min(maxTokens, Math.max(1, contextWindow - promptTokens - PI_CONTEXT_SAFETY_TOKENS));
}

/**
 * Smallest first-turn prompt this repo has ever actually recorded.
 *
 * From `~/.underclass/runs.jsonl`: min `tokensIn` 2482, p10 4266, and the fitted
 * intercept `tokensIn ≈ 3187 + 4778 × toolCalls` sits between them. Using the
 * *minimum* keeps the check below conservative — it refuses only configurations
 * that cannot work even for the smallest prompt this agent has ever sent.
 */
export const MEASURED_MIN_PROMPT_TOKENS = 2482;

/** Below this, a "reply" cannot contain a tool call, so the run is a no-op. */
export const MIN_USABLE_GENERATION = 512;

/**
 * Why a declared context window is unusable, or null when it is fine.
 *
 * `max_completion_tokens: 1` is the UNDER-36 signature verbatim: the model emits
 * one token, stops with `finish_reason: "length"`, calls no tool — and the run
 * was recorded as a success. It is knowable before the first request and costs
 * nothing to check, which is the whole argument for checking it.
 *
 * A starved budget on this model family does not even yield a short answer: both
 * local models reported 197 of 200 completion tokens as `reasoning_tokens` on a
 * plain listing task. A budget under a few hundred tokens looks exactly like a
 * model that cannot use tools.
 */
export function contextTooSmall(
  modelId: string,
  contextWindow: number,
  maxTokens: number,
): string | null {
  const budget = generationBudget(contextWindow, MEASURED_MIN_PROMPT_TOKENS, maxTokens);
  if (budget >= MIN_USABLE_GENERATION) return null;
  return (
    `'${modelId}' is declared with a ${contextWindow}-token context window, which leaves ` +
    `${budget} token(s) to generate with once the prompt and pi's ${PI_CONTEXT_SAFETY_TOKENS}-token ` +
    `reserve are subtracted (measured smallest prompt: ${MEASURED_MIN_PROMPT_TOKENS}).\n` +
    `  A run like that emits one token, stops on 'length', calls no tool, and looks like success.\n` +
    `  Fix it one of these ways:\n` +
    `    - load the model with a larger context in your server (LM Studio: raise the loaded\n` +
    `      context length; Ollama: OLLAMA_CONTEXT_LENGTH or a Modelfile num_ctx)\n` +
    `    - record the real window in .underclass/model-map.json:\n` +
    `        { "models": { "${modelId}": { "servedContext": 32768 } } }`
  );
}

/**
 * A window that survives turn 0 but cannot sustain an agent run.
 *
 * `tokensIn ≈ 3187 + 4778 × toolCalls` over this repo's telemetry (R² 0.9974),
 * so turn 1 costs ~7965 prompt tokens. A 8192-token window yields 909
 * generation tokens on turn 0 and exactly **1** from turn 1 onward — it starts
 * working and then silently stops, which is harder to diagnose than never
 * starting. `UNKNOWN_CONTEXT` is 8192, so this is the shipped default whenever
 * nothing reports a window.
 *
 * A warning rather than a refusal: a user who knows their model may genuinely
 * want a single-turn run, and refusing that would be this repo's other recurring
 * mistake — a guard that is wrong in the safe direction is still wrong.
 */
export const MEASURED_TURN1_PROMPT_TOKENS = 7965;

export function contextTooTight(modelId: string, contextWindow: number, maxTokens: number): string | null {
  if (contextTooSmall(modelId, contextWindow, maxTokens)) return null; // already a hard error
  const budget = generationBudget(contextWindow, MEASURED_TURN1_PROMPT_TOKENS, maxTokens);
  if (budget >= MIN_USABLE_GENERATION) return null;
  return (
    `'${modelId}' has a ${contextWindow}-token window. That is enough for the first turn, but by ` +
    `turn 2 (~${MEASURED_TURN1_PROMPT_TOKENS} prompt tokens, measured) it leaves ${budget} token(s) ` +
    `to generate with — the run will stop calling tools partway through and still report success. ` +
    `Raise the served context, or set servedContext in .underclass/model-map.json.`
  );
}

/**
 * Generate ~/.underclass/pi/models.json from env + discovered local servers.
 * Returns provider ids that actually have models.
 */
export async function writeModelsJson(opts: UnderOptions): Promise<{
  modelsPath: string;
  authPath: string;
  liveProviders: string[];
  providerBaseUrls: Record<string, string>;
}> {
  const dir = piAgentDir();
  const providers: Record<string, ProviderConfig> = {};
  const liveProviders: string[] = [];

  // servedContext recorded in the model map. `learn.ts` has been proposing this
  // from observed overflows all along and nothing read it — so a ceiling the
  // tool had already inferred was being discarded every run.
  const mappedContexts: Record<string, number> = (() => {
    const out: Record<string, number> = {};
    try {
      for (const file of [join(underDir(), "model-map.json"), join(process.cwd(), ".underclass", "model-map.json")]) {
        if (!existsSync(file)) continue;
        const map = JSON.parse(readFileSync(file, "utf8")) as { models?: Record<string, { servedContext?: number }> };
        for (const [key, entry] of Object.entries(map.models ?? {})) {
          if (entry?.servedContext) out[bareModelId(key)] = entry.servedContext;
        }
      }
    } catch {
      /* a broken map must not break provider config */
    }
    return out;
  })();

  const dangerBase = process.env.UNDERCLASS_API_BASE ?? DEFAULT_DANGER_BASE;
  const dangerKey =
    opts.apiKey ??
    process.env.DANGER_API_KEY ??
    process.env.UNDERCLASS_API_KEY ??
    DEFAULT_GUEST_KEY;
  const dangerModel = process.env.UNDERCLASS_MODEL ?? DEFAULT_DANGER_MODEL;
  const zeroEndpoint = process.env.UNDERCLASS_ZERO_ENDPOINT ?? process.env.ZERO_ENDPOINT;

  // Ask the endpoint what it serves rather than assuming one hardcoded id — the
  // gateway fronts many backends and those were previously invisible.
  //
  // But only when it could actually be used: probing it while the user asked for
  // a local provider is unconditional egress they did not request. It reveals no
  // code, yet a private-by-default tool should not contact a remote host on a
  // `--lmstudio` run at all.
  const mayUseDanger =
    !opts.baseUrl && (!opts.provider || opts.provider === "danger") && !/^(lmstudio|ollama|custom)\//.test(opts.model ?? "");
  const [lmCtx, lmModels, ollamaModels, ollamaCtx, dangerDiscovered] = await Promise.all([
    discoverContextWindows(LMSTUDIO_BASE),
    discoverModels(LMSTUDIO_BASE),
    discoverModels(OLLAMA_BASE),
    // Ollama's /v1/models carries no context field, so without this every Ollama
    // model was declared UNKNOWN_CONTEXT — 8192 — and pi's clamp then collapsed
    // generation to 1 token on turn 1. This is the same defect as UNDER-36, on a
    // different provider.
    discoverOllamaContext(OLLAMA_BASE),
    mayUseDanger ? discoverModels(dangerBase, 4000, dangerKey) : Promise.resolve([]),
  ]);
  // The configured/default model stays first so it remains the default pick,
  // and still works when discovery is unavailable.
  const dangerIds: DiscoveredModel[] = [
    { id: dangerModel },
    ...dangerDiscovered.filter((m) => m.id !== dangerModel),
  ];

  providers.danger = {
    name: "danger.plus",
    baseUrl: dangerBase,
    api: "openai-completions",
    apiKey: dangerKey,
    compat: LOCAL_COMPAT,
    headers: {
      // The SDK's own "OpenAI/JS x.y.z" user agent is rejected by some WAFs
      // (api.danger.plus returns 403 on that UA alone — every other value gets
      // 200), which presents as an auth failure and is very hard to diagnose.
      "User-Agent": `underclass/${UNDER_VERSION}`,
      ...(zeroEndpoint ? { "x-zero-endpoint": zeroEndpoint } : {}),
    },
    models: dangerIds.map((m) => ({
      id: m.id,
      input: ["text"],
      reasoning: false,
      // Prefer what the gateway reported over the 128K assumption.
      contextWindow: m.contextWindow ?? mappedContexts[m.id] ?? 128000,
      maxTokens: 8192,
      cost: ZERO_COST,
    })),
  };
  liveProviders.push("danger");

  // Local endpoints usually need no key, but an authenticated proxy might:
  // honor --api-key here instead of only routing it to danger.plus.
  if (lmModels.length > 0) {
    providers.lmstudio = {
      name: "LM Studio",
      baseUrl: LMSTUDIO_BASE,
      api: "openai-completions",
      apiKey: opts.apiKey ?? "lmstudio",
      compat: LOCAL_COMPAT,
      models: localModelEntries(lmModels, { ...lmCtx, ...mappedContexts }),
    };
    liveProviders.push("lmstudio");
  }

  if (ollamaModels.length > 0) {
    providers.ollama = {
      name: "Ollama",
      baseUrl: OLLAMA_BASE,
      api: "openai-completions",
      apiKey: opts.apiKey ?? "ollama",
      compat: LOCAL_COMPAT,
      // Same order of trust as lmstudio: what the server reports, then the map
      // as an authoritative override (that is what `servedContext` is for).
      models: localModelEntries(ollamaModels, { ...ollamaCtx, ...mappedContexts }),
    };
    liveProviders.push("ollama");
  }

  if (opts.baseUrl) {
    // A custom endpoint gets the same context discovery as the named local
    // providers. Without this it fell through to UNKNOWN_CONTEXT (8192), and
    // because pi budgets generation out of the declared window, a fat agent
    // prompt left `max_completion_tokens: 1` — the model emitted one token,
    // stopped with finish_reason "length", called no tools, and the run was
    // recorded as a success that changed nothing. Every `--base-url` run was
    // silently a no-op. See the guard in index.ts that now makes that loud.
    // Two sources, because they cover different servers. LM Studio reports the
    // SERVED window on its native /api/v0/models; OpenRouter and similar
    // gateways report `context_length` on the standard /v1/models. Ask both.
    //
    // And ask ALWAYS — not only when no model was named. The `-m` path used to
    // skip discovery entirely and hand `localModelEntries` a bare string, so any
    // explicitly-chosen model on a custom endpoint got UNKNOWN_CONTEXT = 8192.
    // Verified live: `-m custom/poolside/laguna-s-2.1:free` declared 8192 for a
    // model serving 262,144, which collapsed max_completion_tokens to 1.
    const [customCtx, discovered] = await Promise.all([
      discoverContextWindows(opts.baseUrl),
      discoverModels(opts.baseUrl, 8000, opts.apiKey ?? process.env.OPENAI_API_KEY),
    ]);
    const fromCatalogue: Record<string, number> = {};
    for (const m of discovered) if (m.contextWindow) fromCatalogue[m.id] = m.contextWindow;
    // Precedence: an explicit model-map servedContext beats a server's own
    // claim, which beats a catalogue listing. The map is where a human records
    // what they measured, and a measurement outranks an advertisement.
    const contexts = { ...fromCatalogue, ...customCtx, ...mappedContexts };
    providers.custom = {
      name: "Custom endpoint",
      baseUrl: opts.baseUrl,
      api: "openai-completions",
      apiKey: opts.apiKey ?? process.env.OPENAI_API_KEY ?? "none",
      compat: LOCAL_COMPAT,
      models: localModelEntries(opts.model ? [bareModelId(opts.model)] : [], contexts),
    };
    if (providers.custom.models.length === 0) {
      providers.custom.models = localModelEntries(discovered, contexts);
    }
    liveProviders.push("custom");
  }

  const modelsPath = join(dir, "models.json");
  writeFileSync(modelsPath, JSON.stringify({ providers }, null, 2) + "\n", { mode: 0o600 });
  const providerBaseUrls = Object.fromEntries(Object.entries(providers).map(([k, v]) => [k, v.baseUrl]));
  return { modelsPath, authPath: join(dir, "auth.json"), liveProviders, providerBaseUrls };
}

/**
 * Probe an endpoint before handing it to the agent loop, so an unreachable
 * server produces one actionable line instead of an opaque "Connection error."
 * after the first model call.
 *
 * Diagnoses the macOS case specifically: connections from node to a LAN address
 * fail with EHOSTUNREACH when the binary has not been granted Local Network
 * access, even though curl and ping from the same shell succeed.
 */
export async function checkEndpoint(baseUrl: string, attempts = 3): Promise<string | null> {
  // Retry with backoff before declaring an endpoint dead. Local servers are
  // routinely unavailable for a few seconds — swapping models, warming a cache,
  // or saturated by another run — and failing the whole task for a transient
  // blip is worse than waiting. Only the last failure is reported.
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const err = await probeOnce(baseUrl);
    if (!err) return null;
    if (attempt === attempts) return err;
    // 1s, 2s — short enough not to mask a genuinely dead endpoint.
    await new Promise((r) => setTimeout(r, 1000 * attempt));
  }
  return null;
}

async function probeOnce(baseUrl: string): Promise<string | null> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, { signal: AbortSignal.timeout(5000) });
    return res.ok || res.status === 401 ? null : `endpoint ${baseUrl} returned HTTP ${res.status}`;
  } catch (err) {
    const cause = (err as { cause?: { code?: string; message?: string } })?.cause;
    // Not every failure carries a code — a URL the fetch spec refuses outright
    // ("bad port") arrives with only a message, and dropping it left the user
    // with "cannot reach <url>" and nothing to act on.
    const code = cause?.code ?? cause?.message ?? "";
    let hint = "";
    if (code === "EHOSTUNREACH" || code === "ENETUNREACH") {
      const host = (() => {
        try {
          return new URL(baseUrl).hostname;
        } catch {
          return baseUrl;
        }
      })();
      const loopback = /^(localhost|127\.|\[?::1)/.test(host);
      hint = loopback
        ? ""
        : `\n  ${host} is on the local network. If curl reaches it but under cannot, macOS is blocking\n` +
          `  this binary: System Settings → Privacy & Security → Local Network → enable your terminal\n` +
          `  (or the Node binary). Loopback endpoints are exempt from that policy.`;
    } else if (code === "ECONNREFUSED") {
      hint = `\n  Nothing is listening there — start the server, or pass a different --base-url.`;
    }
    return `cannot reach ${baseUrl}${code ? ` (${code})` : ""}${hint}`;
  }
}

/**
 * Resolve "provider/model", bare model id, or provider preference to a
 * provider/model pair present in the generated models.json.
 */
export function pickModelSpec(
  opts: UnderOptions,
  liveProviders: string[],
  modelsByProvider: (p: string) => readonly { id: string }[],
): { provider: string; modelId: string } | { error: string } {
  // Only split on "/" when the prefix is actually a provider — model ids are
  // routinely namespaced (google/gemma-4-12b, mlx-community/qwen3-4b) and
  // splitting those blindly resolves to a provider that doesn't exist.
  if (opts.model?.includes("/")) {
    const [prefix, ...rest] = opts.model.split("/");
    if (KNOWN_PROVIDERS.includes(prefix!)) {
      return { provider: prefix!, modelId: rest.join("/") };
    }
  }

  // The hosted gateway is the zero-config default: it serves a large, curated,
  // tool-calling fleet, whereas "a local server is listening" says nothing about
  // whether the loaded model can do agentic work — a 1.2B answering on :1234
  // would otherwise hijack the run and fail the task.
  //
  // Local is never *implicit*, only explicit: --lmstudio/--ollama/--base-url,
  // --provider, -m, or a model-map tier all bypass this. Choosing the gateway
  // prints an egress notice, since it does mean code leaves the machine.
  const preferred = opts.provider
    ? [opts.provider]
    : opts.baseUrl
      ? ["custom"]
      : ["danger", "lmstudio", "ollama"];

  for (const provider of preferred) {
    if (!liveProviders.includes(provider)) continue;
    const models = modelsByProvider(provider);
    if (models.length === 0) continue;
    if (opts.model) {
      const match = models.find((m) => m.id === opts.model);
      if (match) return { provider, modelId: match.id };
      continue;
    }
    return { provider, modelId: models[0]!.id };
  }

  return {
    error: opts.model
      ? `Model "${opts.model}" not found in providers: ${liveProviders.join(", ")}`
      : `No usable provider found (checked: ${preferred.join(", ")})`,
  };
}
