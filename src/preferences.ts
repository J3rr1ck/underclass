import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { underDir } from "./config.js";

/**
 * User intent that should outlive a single run.
 *
 * Telemetry captures what happened; this captures what the user *wants* —
 * conventions, constraints, and preferences they would otherwise have to repeat
 * in every prompt ("never touch generated files", "prefer node:test").
 *
 * Two scopes, both plain markdown so a human can edit or delete them:
 *   ~/.underclass/preferences.md        applies everywhere
 *   <repo>/.underclass/preferences.md   applies to this project (wins on conflict)
 */
export function globalPreferencesPath(): string {
  return join(underDir(), "preferences.md");
}

export function projectPreferencesPath(cwd: string): string {
  return join(cwd, ".underclass", "preferences.md");
}

function read(path: string): string {
  try {
    return existsSync(path) ? readFileSync(path, "utf8").trim() : "";
  } catch {
    return "";
  }
}

/** Load preferences as a system-prompt section, or null when there are none. */
export function loadPreferences(cwd: string): string | null {
  const global = read(globalPreferencesPath());
  const project = read(projectPreferencesPath(cwd));
  if (!global && !project) return null;
  const parts = ["## User preferences\nStanding instructions from this user. Follow them unless the task says otherwise."];
  if (global) parts.push(global);
  if (project) parts.push(project);
  return parts.join("\n\n");
}

/** Append a preference line, creating the file if needed. */
export function rememberPreference(text: string, cwd: string, projectScope: boolean): string {
  const path = projectScope ? projectPreferencesPath(cwd) : globalPreferencesPath();
  mkdirSync(dirname(path), { recursive: true });
  const line = `- ${text.trim().replace(/\n+/g, " ")}\n`;
  appendFileSync(path, existsSync(path) && read(path) ? line : `# under preferences\n\n${line}`);
  return path;
}
