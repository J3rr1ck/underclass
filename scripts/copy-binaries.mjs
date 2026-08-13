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
chmodSync(join("dist", "under.js"), 0o755);
chmodSync(join("dist", "danger.js"), 0o755);

console.log("Copied binaries and updated executable permissions in dist/");
