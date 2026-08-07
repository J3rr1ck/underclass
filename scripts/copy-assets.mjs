/**
 * Copy non-TypeScript assets into dist/.
 *
 * `tsc` emits only what it compiles, so anything the package needs at runtime
 * that is not a .ts file has to be copied here. Getting this wrong is a
 * uniquely nasty class of bug: in a source checkout the file is still on disk
 * one directory up, so everything works locally and only the published tarball
 * is broken. Hence the assertion at the end — a missing asset fails the build.
 */
import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

const ASSETS = [
  ["src/data/providers.json", "dist/data/providers.json"],
  ["src/shell/plugin.zsh", "dist/shell/plugin.zsh"],
  // Built-in workflows. These are .mjs on purpose — they are executed as
  // scripts by `under workflow`, never compiled — so tsc does not emit them.
  ["src/workflows/review.mjs", "dist/workflows/review.mjs"],
  ["src/workflows/understand.mjs", "dist/workflows/understand.mjs"],
];

const missing = [];
for (const [from, to] of ASSETS) {
  if (!existsSync(from)) {
    missing.push(from);
    continue;
  }
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
}
if (missing.length) {
  console.error(`copy-assets: missing source asset(s):\n  ${missing.join("\n  ")}`);
  process.exit(1);
}
