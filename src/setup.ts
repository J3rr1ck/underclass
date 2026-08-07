import { createInterface } from "node:readline/promises";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { underDir, loadPresets, checkEndpoint, type ProviderPreset } from "./config.js";

/**
 * Guided first-run setup.
 *
 * The failure mode this exists to prevent: someone installs under, runs it, and
 * gets a wall of nothing because their server serves 4K of context, or their
 * model can't call tools, or they have no endpoint at all. Each of those is
 * detectable in seconds, and each has a specific fix. `doctor` reports them;
 * this walks you to a working configuration and then proves it with a real task.
 */

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
};

interface Candidate {
  name: string;
  baseUrl: string;
  apiKey?: string;
  model?: string;
  why: string;
}

function have(cmd: string): boolean {
  try {
    execFileSync("which", [cmd], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function listModels(baseUrl: string, apiKey?: string): Promise<string[]> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(6000),
    });
    const json = (await res.json()) as { data?: Array<{ id: string }> };
    return (json.data ?? []).map((m) => m.id).filter((id) => !/embed/i.test(id));
  } catch {
    return [];
  }
}

/** Does this model actually emit a tool call? The capability that decides everything. */
async function toolProbe(baseUrl: string, model: string, apiKey?: string): Promise<boolean | string> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      signal: AbortSignal.timeout(90_000),
      body: JSON.stringify({
        model,
        max_tokens: 64,
        tool_choice: "required",
        messages: [{ role: "user", content: "List the files here." }],
        tools: [
          {
            type: "function",
            function: { name: "list_files", description: "List files", parameters: { type: "object", properties: {} } },
          },
        ],
      }),
    });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 160);
      if (/no instance found|model group/i.test(body)) return "not currently running on that endpoint";
      if (/context|exceeds/i.test(body)) return "context window too small for an agent prompt";
      if (/insufficient system resources|failed to load/i.test(body)) return "the server could not load it (memory)";
      if (res.status === 401 || res.status === 403) return "rejected the credentials";
      return `HTTP ${res.status}`;
    }
    const json = (await res.json()) as any;
    const calls = json?.choices?.[0]?.message?.tool_calls;
    return Array.isArray(calls) && calls.length > 0 ? true : "answered in prose instead of calling the tool";
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

export async function runSetup(cwd: string): Promise<number> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  // Take the default on EOF rather than throwing: setup is run from install
  // scripts and CI where stdin is closed, and crashing there is worse than
  // proceeding with the answer we would have suggested anyway.
  const ask = async (q: string, dflt: string) => {
    try {
      const a = (await rl.question(`${q} ${C.dim(`[${dflt}]`)} `)).trim();
      return a || dflt;
    } catch {
      console.log(`${q} ${C.dim(`[${dflt}]`)} ${C.dim("(no input — using default)")}`);
      return dflt;
    }
  };

  try {
    console.log(`\n${C.bold("under setup")}\n`);

    // ---- 1. Prerequisites -------------------------------------------------
    const nodeMajor = Number(process.versions.node.split(".")[0]);
    const nodeMinor = Number(process.versions.node.split(".")[1]);
    const nodeOk = nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 19);
    console.log(`${nodeOk ? C.green("✓") : C.red("✗")} node v${process.versions.node}${nodeOk ? "" : " — needs >= 22.19"}`);
    if (!nodeOk) {
      console.log(`  ${C.dim("Install Node 22.19+ and re-run. Everything else depends on it.")}`);
      return 1;
    }
    console.log(`${have("git") ? C.green("✓") : C.red("✗")} git${have("git") ? "" : `  ${C.dim("— required")}`}`);
    console.log(
      `${have("rg") ? C.green("✓") : C.yellow("!")} ripgrep${have("rg") ? "" : `  ${C.dim("— optional; without it repo_search finds nothing. brew install ripgrep")}`}`,
    );

    // ---- 2. Find somewhere to run a model ---------------------------------
    console.log(`\n${C.bold("Looking for a model endpoint…")}`);
    const presets = loadPresets();
    const candidates: Candidate[] = [];

    for (const [name, p] of Object.entries(presets) as Array<[string, ProviderPreset]>) {
      const isLocal = /^https?:\/\/(localhost|127\.)/.test(p.baseUrl);
      if (!isLocal) continue;
      const models = await listModels(p.baseUrl);
      if (models.length) {
        candidates.push({ name, baseUrl: p.baseUrl, model: models[0]!, why: `${models.length} model(s) served locally` });
      }
    }
    if (candidates.length) {
      for (const c of candidates) console.log(`  ${C.green("✓")} ${c.name} — ${c.why}`);
    } else {
      console.log(`  ${C.dim("no local server responding")}`);
    }

    // Hosted presets whose key is already present.
    const hosted = (Object.entries(presets) as Array<[string, ProviderPreset]>)
      .filter(([, p]) => !/^https?:\/\/(localhost|127\.)/.test(p.baseUrl) && p.authEnv && process.env[p.authEnv])
      .map(([name, p]) => ({ name, baseUrl: p.baseUrl, apiKey: process.env[p.authEnv!]!, model: p.defaultModel, why: `${p.authEnv} is set` }));
    for (const h of hosted) {
      console.log(`  ${C.green("✓")} ${h.name} — ${h.why}`);
      candidates.push(h);
    }

    if (candidates.length === 0) {
      console.log(`\n${C.yellow("No endpoint found.")} Two ways forward:\n`);
      console.log(`  ${C.bold("Run a model locally")} — needs roughly 32GB to be pleasant:`);
      console.log(`    ${C.dim("LM Studio: install, load a coding model, start the server (port 1234)")}`);
      console.log(`    ${C.dim("Ollama:    ollama serve && ollama pull qwen3-coder:30b")}`);
      console.log(`    ${C.dim("           IMPORTANT: OLLAMA_CONTEXT_LENGTH=65536 — the 4K default cannot hold an agent turn")}`);
      console.log(`\n  ${C.bold("Use a hosted endpoint")} — set one key and re-run:`);
      for (const n of ["openrouter", "groq", "novita"]) {
        const p = presets[n];
        if (p) console.log(`    ${C.dim(`export ${p.authEnv}=…   # ${n}, ${p.baseUrl}`)}`);
      }
      console.log(`\n  ${C.dim("Full comparison, including privacy: docs/ENDPOINTS.md")}\n`);
      return 1;
    }

    // ---- 3. Choose --------------------------------------------------------
    let chosen = candidates[0]!;
    if (candidates.length > 1) {
      console.log("");
      candidates.forEach((c, i) => console.log(`  ${i + 1}) ${c.name}  ${C.dim(c.baseUrl)}`));
      const pick = Number(await ask("\nWhich endpoint?", "1"));
      chosen = candidates[Number.isFinite(pick) && pick >= 1 && pick <= candidates.length ? pick - 1 : 0]!;
    }

    const err = await checkEndpoint(chosen.baseUrl);
    if (err) {
      console.log(`\n${C.red("✗")} ${err}`);
      return 1;
    }

    // ---- 4. Prove it can actually drive an agent --------------------------
    const models = await listModels(chosen.baseUrl, chosen.apiKey);
    const preferred = models.find((m) => /coder|code|devstral|qwen3|glm|kimi/i.test(m)) ?? chosen.model ?? models[0];
    if (!preferred) {
      console.log(`\n${C.red("✗")} that endpoint lists no usable model`);
      return 1;
    }
    const model = await ask(`\nModel?`, preferred);

    process.stdout.write(`\nChecking that ${C.bold(model)} can call tools… `);
    const probe = await toolProbe(chosen.baseUrl, model, chosen.apiKey);
    if (probe === true) {
      console.log(C.green("yes"));
    } else {
      console.log(C.yellow(`no — ${probe}`));
      console.log(
        `\n  ${C.dim("under drives an agent loop, so a model that won't call tools will talk and never act.")}`,
      );
      console.log(`  ${C.dim("Try a coding-tuned model (Qwen3-Coder, Devstral, GLM, Kimi), or a different endpoint.")}`);
      const cont = await ask("\nSave this configuration anyway?", "n");
      if (!/^y/i.test(cont)) return 1;
    }

    // ---- 5. Persist -------------------------------------------------------
    const dir = join(cwd, ".underclass");
    mkdirSync(dir, { recursive: true });
    const mapPath = join(dir, "model-map.json");
    const existing = existsSync(mapPath) ? JSON.parse(readFileSync(mapPath, "utf8")) : { models: {} };
    existing.endpoints = { ...(existing.endpoints ?? {}), [chosen.name]: chosen.baseUrl };
    existing.tiers = { ...(existing.tiers ?? {}), normal: { endpoint: chosen.name, model } };
    writeFileSync(mapPath, JSON.stringify(existing, null, 2) + "\n");
    console.log(`\n${C.green("✓")} wrote ${mapPath}`);
    if (chosen.apiKey && !/^https?:\/\/(localhost|127\.)/.test(chosen.baseUrl)) {
      const p = presets[chosen.name];
      if (p?.authEnv) console.log(`  ${C.dim(`keep ${p.authEnv} in your shell profile so it persists`)}`);
    }

    console.log(`\n${C.bold("You're set.")} Try it:\n`);
    console.log(`  under "explain what this project does"`);
    console.log(`  under "fix the failing test in <file>"`);
    console.log(`  under doctor            ${C.dim("# re-check this setup any time")}`);
    console.log(`  under --list-providers  ${C.dim("# other endpoints you could use")}\n`);
    return 0;
  } finally {
    rl.close();
  }
}
