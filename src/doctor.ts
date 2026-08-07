import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { checkEndpoint, DEFAULT_DANGER_BASE, DEFAULT_GUEST_KEY, LMSTUDIO_BASE, OLLAMA_BASE } from "./config.js";
import { loadModelMap, TIERS, tierModel } from "./model-map.js";
import { inspectProject } from "./project-rules.js";

/**
 * Preflight health check.
 *
 * An agent that discovers mid-run that ripgrep is missing, or that its endpoint
 * serves 8K of context when the first request needs 27K, has already spent the
 * user's tokens to learn something a 200ms probe knew up front. Every check
 * here is cheap, and every failure carries the command that fixes it.
 *
 * Static checks go stale as tooling moves, so unknown states are reported as
 * unknown rather than guessed — the honest answer is what makes this worth
 * running before a session.
 */
export type Status = "ok" | "warn" | "fail" | "skip";

export interface Check {
  name: string;
  status: Status;
  detail: string;
  /** Copy-pasteable remedy, when there is one. */
  fix?: string;
}

const ICON: Record<Status, string> = { ok: "✓", warn: "!", fail: "✗", skip: "·" };
const COLOR: Record<Status, string> = { ok: "\x1b[32m", warn: "\x1b[33m", fail: "\x1b[31m", skip: "\x1b[2m" };

function cmdVersion(cmd: string, args: string[] = ["--version"]): string | null {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 })
      .split("\n")[0]!
      .trim();
  } catch {
    return null;
  }
}

/** Tools under's own toolset shells out to. Missing ones silently degrade it. */
function toolChecks(): Check[] {
  const out: Check[] = [];

  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const nodeMinor = Number(process.versions.node.split(".")[1]);
  const nodeOk = nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 19);
  out.push({
    name: "node",
    status: nodeOk ? "ok" : "fail",
    detail: `v${process.versions.node}${nodeOk ? "" : " — the pi SDK requires >=22.19"}`,
    ...(nodeOk ? {} : { fix: "Install Node 22.19+ (e.g. `nvm install 22`)" }),
  });

  const git = cmdVersion("git");
  out.push({
    name: "git",
    status: git ? "ok" : "fail",
    detail: git ?? "not found — fan-out and repo context need it",
    ...(git ? {} : { fix: "Install git (xcode-select --install on macOS)" }),
  });

  const rg = cmdVersion("rg");
  out.push({
    name: "ripgrep",
    status: rg ? "ok" : "warn",
    detail: rg ?? "not found — repo_search returns nothing without it",
    ...(rg ? {} : { fix: "brew install ripgrep   # or: cargo install ripgrep" }),
  });

  const gh = cmdVersion("gh");
  out.push({
    name: "gh (optional)",
    status: gh ? "ok" : "skip",
    detail: gh ?? "not found — only needed for `under fan-out --pr`",
    ...(gh ? {} : { fix: "brew install gh && gh auth login" }),
  });

  return out;
}

/**
 * Container runtime — only relevant to the optional benchmark path.
 *
 * Deliberately NOT part of the default report: under's core loop never touches
 * a container, and listing a missing VM runtime next to real problems would
 * tell most users they are broken when they are not. Shown with `--benchmark`,
 * or when a runtime is present and worth reporting on.
 */
function containerChecks(requested: boolean): Check[] {
  const docker = cmdVersion("docker");
  if (!docker && !requested) return [];
  if (!docker) {
    return [
      {
        name: "container runtime",
        status: "skip",
        detail: "not installed — only the SWE-bench path needs one; the agent itself never does",
        fix: "Apple Silicon: `brew install orbstack` (light) — see docs/DEPENDENCIES.md before installing on an 8GB machine",
      },
    ];
  }
  // Installed: is it actually usable, and does it have room to work?
  try {
    const info = execFileSync("docker", ["info", "--format", "{{.MemTotal}}|{{.Architecture}}|{{.ServerVersion}}"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    }).trim();
    const [memRaw, arch, ver] = info.split("|");
    const gib = Number(memRaw) / 1024 ** 3;
    // Benchmark images build C extensions; under ~6 GiB that gets OOM-killed.
    const thin = gib > 0 && gib < 6;

    // "Raise the VM's memory" is actively harmful when the VM already holds
    // most of the host — that advice would cause the OOM it warns about. Which
    // remedy is right depends on whether the HOST has headroom to give.
    let hostGib = 0;
    try {
      hostGib =
        Number(execFileSync("sysctl", ["-n", "hw.memsize"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()) /
        1024 ** 3;
    } catch {
      /* non-macOS or unavailable */
    }
    const vmShare = hostGib > 0 ? gib / hostGib : 0;
    const hostIsTheLimit = vmShare > 0.6 || (hostGib > 0 && hostGib <= 8);

    return [
      {
        name: "container runtime",
        status: thin ? "warn" : "ok",
        detail:
          `${ver ?? "docker"} (${arch ?? "?"}), ${gib ? gib.toFixed(1) + " GiB" : "unknown memory"}` +
          (hostGib ? ` of ${hostGib.toFixed(0)} GiB host` : "") +
          (thin ? " — benchmark image builds may be OOM-killed below ~6 GiB" : ""),
        ...(thin
          ? {
              fix: hostIsTheLimit
                ? "The host is the limit, not the VM — raising it will not help. Benchmark pure-Python instances only (django, sympy, pytest, sphinx), or grade on a bigger machine."
                : "Raise the VM's memory allocation (host has headroom), or benchmark only pure-Python instances",
            }
          : {}),
      },
    ];
  } catch {
    return [
      {
        name: "container runtime",
        status: requested ? "fail" : "skip",
        detail: "docker installed but the daemon is not responding",
        fix: "Start it (OrbStack app, or `colima start`). On macOS the CLI alone has no daemon.",
      },
    ];
  }
}

function repoChecks(cwd: string): Check[] {
  const out: Check[] = [];
  let root: string | null = null;
  try {
    root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    root = null;
  }

  if (!root) {
    out.push({
      name: "git repo",
      status: "warn",
      detail: "not inside a git repository — fan-out is unavailable and edits are unprotected",
      fix: "git init   # or cd into your project",
    });
    return out;
  }
  out.push({ name: "git repo", status: "ok", detail: root });

  try {
    const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim();
    out.push({
      name: "working tree",
      status: dirty ? "warn" : "ok",
      detail: dirty ? `${dirty.split("\n").length} uncommitted change(s) — fan-out refuses to run` : "clean",
      ...(dirty ? { fix: "git commit -am wip   # or: git stash" } : {}),
    });
  } catch {
    /* non-fatal */
  }
  return out;
}

/** Probe an endpoint: reachable, what it serves, and whether it does tool calls. */
async function probeEndpoint(
  label: string,
  baseUrl: string,
  apiKey?: string,
  /** A default we merely tried is absent, not broken; one the user named is broken. */
  required = true,
  /** Fire a real generation to test tool calling. Seconds to minutes — opt-in. */
  deep = false,
): Promise<Check[]> {
  const out: Check[] = [];
  const err = await checkEndpoint(baseUrl);
  if (err) {
    out.push({
      name: label,
      status: required ? "fail" : "skip",
      detail: err.split("\n")[0]!,
      fix: /EHOSTUNREACH|ENETUNREACH/.test(err)
        ? "macOS: System Settings → Privacy & Security → Local Network → enable your terminal"
        : "Start the server, or pass a different --base-url",
    });
    return out;
  }

  let models: string[] = [];
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(5000),
    });
    const json = (await res.json()) as { data?: Array<{ id: string }> };
    models = (json.data ?? []).map((m) => m.id).filter((id) => !/embed/i.test(id));
  } catch {
    /* reachable but unlistable */
  }
  out.push({
    name: label,
    status: models.length ? "ok" : "warn",
    detail: models.length ? `${models.length} model(s), e.g. ${models.slice(0, 3).join(", ")}` : "reachable, but lists no models",
    ...(models.length ? {} : { fix: "Load a model in the server UI, or check the API key" }),
  });

  // Tool calling is the capability that actually decides whether under works:
  // a model that ignores tools produces an agent that talks and never acts.
  // But confirming it costs a real generation — seconds to minutes on a small
  // model — so it is the deep phase. The default run stays fast enough to be
  // habitual, which matters more than completeness for a check people re-run.
  if (!deep) {
    if (models.length) {
      out.push({
        name: `${label} · tool calling`,
        status: "skip",
        detail: "not tested — `under doctor --deep` fires a real tool call to confirm",
      });
    }
    return out;
  }

  // Try a few models: the first listed is often one the server cannot load.
  // Keep probing until a model actually emits a tool call. Stopping at the
  // first model that merely *answers* reports "degraded" for an endpoint that
  // has a perfectly good tool-calling model one entry down the list.
  let probed = false;
  const answeredWithoutTools: string[] = [];
  const candidates = models.slice(0, 4);
  for (const model of candidates) {
    if (probed) break;
    const isLast = model === candidates.at(-1);
    try {
      const res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
        signal: AbortSignal.timeout(60_000),
        body: JSON.stringify({
          model,
          max_tokens: 64,
          messages: [{ role: "user", content: "List the files in the current directory. Use the tool." }],
          // Removes the model's discretion: an endpoint that returns prose here
          // is not honouring tool_choice at all, which distinguishes "the model
          // chose not to" from "this is not a real inference backend".
          tool_choice: "required",
          tools: [
            {
              type: "function",
              function: {
                name: "list_files",
                description: "List files in a directory",
                parameters: { type: "object", properties: { path: { type: "string" } }, required: [] },
              },
            },
          ],
        }),
      });
      if (!res.ok) {
        const body = (await res.text()).slice(0, 300);
        // Map the error signature to the remedy that actually applies —
        // "HTTP 400" alone tells a new user nothing.
        let fix = "Check the model id and the server logs";
        let detail = `${model}: HTTP ${res.status}`;
        if (/no instance found|model group/i.test(body)) {
          // A gateway that lists a catalog it is not currently serving.
          detail = `${model}: listed but not running (no instance)`;
          fix = "Pick a model this endpoint is actually serving — a gateway can list far more than it runs";
        } else if (/insufficient system resources|out of memory|failed to load/i.test(body)) {
          detail = `${model}: the server could not load it (not enough memory)`;
          fix = "Use a smaller model or quantization, close other apps, or point at a remote endpoint";
        } else if (/context|exceeds/i.test(body)) {
          detail = `${model}: context window too small for an agent prompt`;
          fix = "Raise the served context to >=32K in the model's load settings";
        } else if (res.status === 401 || res.status === 403) {
          detail = `${model}: rejected the credentials`;
          fix = "Set the endpoint's API key (--api-key, or its env var)";
        } else if (res.status === 429) {
          detail = `${model}: rate limited`;
          fix = "Wait, raise your plan limits, or use a local endpoint";
        }
        // Keep trying other models before declaring the endpoint unusable.
        if (isLast) {
          out.push({ name: `${label} · tool calling`, status: "fail", detail, fix });
          probed = true;
        }
        continue;
      } else {
        const json = (await res.json()) as any;
        const msg = json?.choices?.[0]?.message;
        const called = Array.isArray(msg?.tool_calls) && msg.tool_calls.length > 0;
        if (called) {
          out.push({
            name: `${label} · tool calling`,
            status: "ok",
            detail:
              `${model} emitted a tool call` +
              (answeredWithoutTools.length ? ` (${answeredWithoutTools.join(", ")} did not — avoid for agent work)` : ""),
          });
          probed = true;
        } else {
          answeredWithoutTools.push(model);
          if (isLast) {
            // Every listed model ignoring tool_choice:"required" means the
            // endpoint isn't really serving these models — a gateway falling
            // back to a placeholder looks exactly like this.
            const allIgnored = answeredWithoutTools.length === candidates.length && candidates.length > 1;
            out.push({
              name: `${label} · tool calling`,
              status: "warn",
              detail: allIgnored
                ? `every listed model (${answeredWithoutTools.length}) ignored tool_choice:required — this endpoint is answering, but not as a real inference backend`
                : `none of ${answeredWithoutTools.join(", ")} called the tool — agent loops will stall`,
              fix: allIgnored
                ? "Check whether the gateway is falling back to a placeholder (e.g. an upstream tunnel is down)"
                : "Pick a tool-calling model (Qwen3-Coder, Devstral, GLM, Kimi, Gemma 3+), or check the model's docs",
            });
            probed = true;
          }
        }
      }
    } catch (e) {
      if (isLast) {
        out.push({
          name: `${label} · tool calling`,
          status: "warn",
          detail: `probe failed: ${e instanceof Error ? e.message : String(e)}`,
        });
        probed = true;
      }
    }
  }
  return out;
}

function mapChecks(cwd: string): Check[] {
  const out: Check[] = [];
  const map = loadModelMap(cwd);
  const hasMap = Object.keys(map.models).length > 0 || map.tiers;
  if (!hasMap) {
    out.push({
      name: "model map",
      status: "skip",
      detail: "none — routing disabled, under uses provider preference",
      fix: "See bench/examples/model-map.example.json to enable tier routing",
    });
    return out;
  }
  const tiers = TIERS.filter((t) => tierModel(map, t));
  out.push({
    name: "model map",
    status: tiers.length ? "ok" : "warn",
    detail: tiers.length ? `tiers: ${tiers.join(", ")}` : "loaded, but no tier resolves to a model",
    ...(tiers.length ? {} : { fix: "Check that each tier's `endpoint` names a key in `endpoints`" }),
  });
  return out;
}

/** Static project-readiness rules — zero tokens, known remedies. */
function projectChecks(cwd: string): Check[] {
  const SEV: Record<string, Status> = { blocker: "fail", risk: "warn", note: "skip" };
  return inspectProject(cwd).map((f) => ({
    name: f.id,
    status: SEV[f.severity] ?? "warn",
    detail: `${f.what} — ${f.why}`,
    fix: f.fix,
  }));
}

export async function runDoctor(
  cwd: string,
  opts: { baseUrl?: string; apiKey?: string; benchmark?: boolean; offline?: boolean; deep?: boolean } = {},
): Promise<number> {
  const checks: Check[] = [
    ...toolChecks(),
    ...repoChecks(cwd),
    ...projectChecks(cwd),
    ...mapChecks(cwd),
    ...containerChecks(opts.benchmark === true),
  ];

  // Endpoints: whatever the user named, else whatever is conventionally there.
  const targets: Array<{ label: string; url: string; key?: string; required: boolean }> = [];
  if (opts.baseUrl) {
    targets.push({ label: opts.baseUrl, url: opts.baseUrl, required: true, ...(opts.apiKey ? { key: opts.apiKey } : {}) });
  } else {
    // Probing the conventional local servers is a survey, not a requirement:
    // not running Ollama is normal, and calling it "blocking" sends a user
    // with a working LM Studio off to fix something that isn't broken.
    targets.push({ label: `LM Studio (${LMSTUDIO_BASE})`, url: LMSTUDIO_BASE, required: false });
    targets.push({ label: `Ollama (${OLLAMA_BASE})`, url: OLLAMA_BASE, required: false });
    // The zero-config default MUST be probed, because it is what a bare
    // `under "task"` will actually use. Omitting it made doctor tell every
    // new user with no local server "under cannot run without one" while the
    // default endpoint was up and the agent would have worked — the worst
    // possible first-run message, since it sends someone off to install a
    // model server they did not need.
    const dangerBase = process.env.UNDERCLASS_API_BASE ?? DEFAULT_DANGER_BASE;
    targets.push({
      label: `danger.plus (${dangerBase})`,
      url: dangerBase,
      key: process.env.DANGER_API_KEY ?? DEFAULT_GUEST_KEY,
      required: false,
    });
  }
  if (opts.offline) {
    checks.push({
      name: "endpoints",
      status: "skip",
      detail: "not probed (--offline) — drop the flag to check reachability",
    });
  }
  const before = checks.length;
  if (!opts.offline) {
    for (const t of targets) {
      checks.push(...(await probeEndpoint(t.label, t.url, t.key, t.required, opts.deep === true)));
    }
  }

  const anyEndpoint = opts.offline || checks.slice(before).some((c) => c.status === "ok" && !/ · /.test(c.name));
  if (!anyEndpoint) {
    checks.push({
      name: "inference",
      status: "fail",
      detail: "no reachable endpoint — under cannot run without one",
      fix: "Start LM Studio or Ollama, or see docs/ENDPOINTS.md for hosted options (the default endpoint is also unreachable, so this is not just a missing local server)",
    });
  }

  const width = Math.max(...checks.map((c) => c.name.length));
  console.log("under doctor\n");
  for (const c of checks) {
    console.log(`  ${COLOR[c.status]}${ICON[c.status]}\x1b[0m ${c.name.padEnd(width)}  ${c.detail}`);
    if (c.fix && c.status !== "ok" && c.status !== "skip") console.log(`      ${"".padEnd(width)}\x1b[2m→ ${c.fix}\x1b[0m`);
  }

  const fails = checks.filter((c) => c.status === "fail").length;
  const warns = checks.filter((c) => c.status === "warn").length;
  console.log(
    `\n${fails ? `\x1b[31m${fails} blocking\x1b[0m` : "\x1b[32mno blocking issues\x1b[0m"}` +
      `${warns ? `, ${warns} degraded` : ""}.`,
  );
  if (fails) console.log("Fix the ✗ items above before starting a run — each one costs tokens to discover mid-session.");
  return fails ? 1 : 0;
}
