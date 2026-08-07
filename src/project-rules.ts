import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Static project-readiness rules.
 *
 * The snag this exists for: an Android project with no Gradle wrapper cannot be
 * built reproducibly, and nothing told anyone until a build was attempted and
 * failed. That class of problem is cheap to detect and has a known remedy — so
 * detecting it should cost zero tokens, not a round trip through a model.
 *
 * Same philosophy as the model map: encode hard-won environmental knowledge
 * statically, consult it for free, and only fall back to a model when the
 * static rules do not recognize the situation. Rules must be conservative —
 * a false alarm trains people to ignore the output, which is worse than silence.
 */
export type Severity = "blocker" | "risk" | "note";

export interface Finding {
  id: string;
  severity: Severity;
  what: string;
  why: string;
  /** Copy-pasteable remedy. */
  fix: string;
  /** True when `--fix` can apply it safely without judgement. */
  autofixable: boolean;
}

interface Ctx {
  root: string;
  has: (p: string) => boolean;
  read: (p: string) => string | null;
  json: (p: string) => any | null;
  /** Directories that look like project roots (monorepo members included). */
  dirs: string[];
}

function makeCtx(root: string): Ctx {
  const has = (p: string) => existsSync(join(root, p));
  const read = (p: string) => {
    try {
      return readFileSync(join(root, p), "utf8");
    } catch {
      return null;
    }
  };
  return {
    root,
    has,
    read,
    json: (p: string) => {
      const t = read(p);
      if (!t) return null;
      try {
        return JSON.parse(t);
      } catch {
        return null;
      }
    },
    dirs: (() => {
      try {
        return readdirSync(root, { withFileTypes: true })
          .filter((d) => d.isDirectory() && !d.name.startsWith(".") && d.name !== "node_modules")
          .map((d) => d.name);
      } catch {
        return [];
      }
    })(),
  };
}

type Rule = (c: Ctx) => Finding | null;

/** Find the nearest directory containing a gradle build, searching one level down. */
function gradleRoots(c: Ctx): string[] {
  const out: string[] = [];
  const isGradle = (d: string) =>
    existsSync(join(c.root, d, "build.gradle")) || existsSync(join(c.root, d, "build.gradle.kts"));
  if (c.has("build.gradle") || c.has("build.gradle.kts")) out.push(".");
  for (const d of c.dirs) {
    if (isGradle(d)) out.push(d);
    // One more level: repos often nest the app under a subdirectory.
    try {
      for (const e of readdirSync(join(c.root, d), { withFileTypes: true })) {
        if (e.isDirectory() && isGradle(join(d, e.name))) out.push(join(d, e.name));
      }
    } catch {
      /* unreadable */
    }
  }
  return out;
}

const RULES: Rule[] = [
  // ---- reproducibility of the build itself -------------------------------
  (c) => {
    for (const g of gradleRoots(c)) {
      const hasWrapper =
        existsSync(join(c.root, g, "gradlew")) &&
        existsSync(join(c.root, g, "gradle", "wrapper", "gradle-wrapper.properties"));
      if (!hasWrapper) {
        return {
          id: "gradle-wrapper-missing",
          severity: "blocker",
          what: `${g === "." ? "this" : g} is a Gradle project with no wrapper (gradlew + gradle/wrapper/)`,
          why:
            "Without a committed wrapper the build depends on whatever Gradle the machine happens to have, " +
            "so it is not reproducible — and on a machine with no Gradle at all it cannot run.",
          fix: `cd ${g} && gradle wrapper   # then commit gradlew, gradlew.bat and gradle/wrapper/`,
          autofixable: false, // needs a Gradle to generate it; version choice is a judgement call
        };
      }
    }
    return null;
  },

  (c) => {
    const pkg = c.json("package.json");
    if (!pkg) return null;
    const lock = ["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb"].some(c.has);
    if (lock) return null;
    return {
      id: "node-lockfile-missing",
      severity: "risk",
      what: "package.json with no lockfile",
      why: "Dependency versions float, so a build here and a build in CI can resolve differently.",
      fix: "npm install   # then commit package-lock.json",
      autofixable: false,
    };
  },

  (c) => {
    const pkg = c.json("package.json");
    if (!pkg || pkg.engines?.node) return null;
    return {
      id: "node-engines-missing",
      severity: "note",
      what: "package.json declares no engines.node",
      why: "Nothing stops an incompatible Node from being used; the failure surfaces as a confusing runtime error.",
      fix: `Add to package.json:  "engines": { "node": ">=${process.versions.node.split(".")[0]}" }`,
      autofixable: false,
    };
  },

  (c) => {
    const py = c.has("pyproject.toml") || c.has("setup.py") || c.has("requirements.txt");
    if (!py) return null;
    const pinned =
      c.has("uv.lock") ||
      c.has("poetry.lock") ||
      c.has("Pipfile.lock") ||
      c.has("requirements.lock") ||
      /==\s*\d/.test(c.read("requirements.txt") ?? "");
    if (pinned) return null;
    return {
      id: "python-unpinned",
      severity: "risk",
      what: "a Python project with no pinned dependency set",
      why: "Unpinned versions make results non-reproducible, and for a benchmark fixture that silently invalidates it.",
      fix: "uv lock   # or: pip freeze > requirements.lock",
      autofixable: false,
    };
  },

  // ---- claims that contradict the tree ----------------------------------
  (c) => {
    const pkg = c.json("package.json");
    const declared = pkg?.license;
    if (!declared) return null;
    const hasFile = ["LICENSE", "LICENSE.md", "LICENSE.txt", "COPYING"].some(c.has);
    if (hasFile) return null;
    return {
      id: "license-declared-but-absent",
      severity: "risk",
      what: `package.json declares "${declared}" but no LICENSE file exists`,
      why: "A licence field without licence text is not a grant; users cannot rely on it and redistributors cannot comply.",
      fix: `Add the ${declared} text as LICENSE`,
      autofixable: false,
    };
  },

  (c) => {
    const gi = c.read(".gitignore") ?? "";
    const gradle = gradleRoots(c).length > 0;
    const missing: string[] = [];
    if (gradle && !/(^|\n)\s*build\/?\s*(\n|$)/.test(gi)) missing.push("build/");
    if (gradle && !/\.gradle/.test(gi)) missing.push(".gradle/");
    if (c.has("package.json") && !/node_modules/.test(gi)) missing.push("node_modules/");
    if (!missing.length) return null;
    return {
      id: "gitignore-build-outputs",
      severity: "note",
      what: `.gitignore does not cover ${missing.join(", ")}`,
      why: "Build output committed by accident bloats the repo and produces confusing diffs.",
      fix: `printf '%s\\n' ${missing.map((m) => `'${m}'`).join(" ")} >> .gitignore`,
      autofixable: true,
    };
  },

  // ---- can anyone verify a change? --------------------------------------
  (c) => {
    const pkg = c.json("package.json");
    if (!pkg) return null;
    const t = pkg.scripts?.test;
    if (t && !/no test specified/i.test(t)) return null;
    return {
      id: "no-test-command",
      severity: "risk",
      what: "no usable `npm test` script",
      why:
        "An agent cannot verify its own work without a way to run tests, which is the single largest determinant " +
        "of whether it produces a correct change or a plausible-looking one.",
      fix: 'Add a real "test" script to package.json',
      autofixable: false,
    };
  },

  (c) => {
    // Android specifics worth catching before a build is attempted.
    const g = gradleRoots(c);
    if (!g.length) return null;
    const isAndroid = g.some((d) => /com\.android\.(application|library)/.test(c.read(join(d, "build.gradle.kts")) ?? c.read(join(d, "build.gradle")) ?? "") ||
      existsSync(join(c.root, d, "app", "src", "main", "AndroidManifest.xml")));
    if (!isAndroid) return null;
    const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
    if (sdk && existsSync(sdk)) return null;
    const guess = join(process.env.HOME ?? "", "Library", "Android", "sdk");
    const present = existsSync(guess);
    return {
      id: "android-sdk-unset",
      severity: present ? "note" : "blocker",
      what: `an Android project, but ANDROID_HOME is not set${present ? " (an SDK is present at the default path)" : " and no SDK was found"}`,
      why: "Gradle resolves the SDK from ANDROID_HOME or local.properties; without either the build fails late and unhelpfully.",
      fix: present ? `export ANDROID_HOME="${guess}"` : "Install the Android SDK (Android Studio, or sdkmanager)",
      autofixable: false,
    };
  },
];

export function inspectProject(root: string): Finding[] {
  const c = makeCtx(root);
  const out: Finding[] = [];
  for (const rule of RULES) {
    try {
      const f = rule(c);
      if (f) out.push(f);
    } catch {
      // A rule that throws must never break the report.
    }
  }
  const order: Record<Severity, number> = { blocker: 0, risk: 1, note: 2 };
  return out.sort((a, b) => order[a.severity] - order[b.severity]);
}
