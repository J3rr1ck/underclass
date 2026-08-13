import { copyFileSync, existsSync, chmodSync, mkdirSync } from "node:fs";
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

// Native Android ARM64
const arm64Under = join("target", "aarch64-linux-android", "release", "under");
const arm64Danger = join("target", "aarch64-linux-android", "release", "danger");
if (existsSync(arm64Under) && existsSync(arm64Danger)) {
  mkdirSync(join("dist", "android", "arm64"), { recursive: true });
  copyFileSync(arm64Under, join("dist", "android", "arm64", "under"));
  copyFileSync(arm64Danger, join("dist", "android", "arm64", "danger"));
  chmodSync(join("dist", "android", "arm64", "under"), 0o755);
  chmodSync(join("dist", "android", "arm64", "danger"), 0o755);
}

// Native Android x86_64
const x86Under = join("target", "x86_64-linux-android", "release", "under");
const x86Danger = join("target", "x86_64-linux-android", "release", "danger");
if (existsSync(x86Under) && existsSync(x86Danger)) {
  mkdirSync(join("dist", "android", "x86_64"), { recursive: true });
  copyFileSync(x86Under, join("dist", "android", "x86_64", "under"));
  copyFileSync(x86Danger, join("dist", "android", "x86_64", "danger"));
  chmodSync(join("dist", "android", "x86_64", "under"), 0o755);
  chmodSync(join("dist", "android", "x86_64", "danger"), 0o755);
}

if (existsSync(join("dist", "under.js"))) {
  chmodSync(join("dist", "under.js"), 0o755);
}
if (existsSync(join("dist", "danger.js"))) {
  chmodSync(join("dist", "danger.js"), 0o755);
}

console.log("Copied release binaries (including native Android ARM64/x86_64) and updated permissions");
