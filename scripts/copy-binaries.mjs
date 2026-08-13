import { copyFileSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";

const targetUnder = join("target", "release", "under");
const targetDanger = join("target", "release", "danger");

if (existsSync(targetUnder)) {
  copyFileSync(targetUnder, join("dist", "under"));
  chmodSync(join("dist", "under"), 0o755);
}
if (existsSync(targetDanger)) {
  copyFileSync(targetDanger, join("dist", "danger"));
  chmodSync(join("dist", "danger"), 0o755);
}
if (existsSync(join("dist", "under.js"))) {
  chmodSync(join("dist", "under.js"), 0o755);
}
if (existsSync(join("dist", "danger.js"))) {
  chmodSync(join("dist", "danger.js"), 0o755);
}

console.log("Copied release binaries and updated permissions for NVM Node v26.2.0");
