import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractMeta } from "./script.js";
import type { WorkflowMeta } from "./types.js";

/**
 * Where a workflow can come from, in the order a name is searched.
 *
 * A path always wins, so a script in hand is never shadowed by a name that
 * happens to match. Then the project's own `.underclass/workflows`, so a repo
 * can override a built-in with its own version of the same idea. Built-ins
 * last, as the fallback that always exists.
 */
export interface ResolvedWorkflow {
  path: string;
  source: string;
  origin: "path" | "project" | "builtin";
}

function builtinDir(): string {
  // Resolved from this module's own location so it works from dist, from a
  // global install, and from an npx tarball alike.
  return join(dirname(fileURLToPath(import.meta.url)), "..", "workflows");
}

function projectDir(repoDir: string): string {
  return join(repoDir, ".underclass", "workflows");
}

function candidates(nameOrPath: string, repoDir: string): Array<{ path: string; origin: ResolvedWorkflow["origin"] }> {
  const looksLikePath = nameOrPath.includes("/") || nameOrPath.endsWith(".mjs") || nameOrPath.endsWith(".js");
  const out: Array<{ path: string; origin: ResolvedWorkflow["origin"] }> = [];
  if (looksLikePath) {
    out.push({ path: isAbsolute(nameOrPath) ? nameOrPath : resolve(repoDir, nameOrPath), origin: "path" });
  }
  // Origin-major, not extension-major. The other order puts the built-in
  // `<name>.mjs` ahead of a project's `<name>.js`, so a repo's own override
  // would be listed by --list as the one that runs and then not be the one that
  // runs — the two disagreeing is worse than either precedence.
  for (const [dir, origin] of [
    [projectDir(repoDir), "project"],
    [builtinDir(), "builtin"],
  ] as const) {
    for (const ext of [".mjs", ".js"]) out.push({ path: join(dir, `${nameOrPath}${ext}`), origin });
  }
  return out;
}

export function resolveWorkflow(nameOrPath: string, repoDir: string): ResolvedWorkflow {
  for (const c of candidates(nameOrPath, repoDir)) {
    if (!existsSync(c.path)) continue;
    return { path: c.path, source: readFileSync(c.path, "utf8"), origin: c.origin };
  }
  const known = listWorkflows(repoDir).map((w) => w.name);
  throw new Error(
    `no workflow '${nameOrPath}' — pass a path to a .mjs file, or one of: ${known.join(", ") || "(none installed)"}`,
  );
}

export interface WorkflowListing {
  name: string;
  origin: ResolvedWorkflow["origin"];
  path: string;
  meta?: WorkflowMeta;
  error?: string;
}

/** Every workflow reachable by name, project ones shadowing built-ins. */
export function listWorkflows(repoDir: string): WorkflowListing[] {
  const byName = new Map<string, WorkflowListing>();
  // Built-ins first so a project file of the same name overwrites the entry.
  for (const [dir, origin] of [
    [builtinDir(), "builtin"],
    [projectDir(repoDir), "project"],
  ] as const) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue; // a project with no workflows directory is the normal case
    }
    for (const file of entries.sort()) {
      if (!file.endsWith(".mjs") && !file.endsWith(".js")) continue;
      const path = join(dir, file);
      const name = file.replace(/\.(mjs|js)$/, "");
      try {
        byName.set(name, { name, origin, path, meta: extractMeta(readFileSync(path, "utf8")) });
      } catch (err) {
        // A broken workflow should still be listed — silently omitting it is
        // how you spend ten minutes wondering why your script is not found.
        byName.set(name, { name, origin, path, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
