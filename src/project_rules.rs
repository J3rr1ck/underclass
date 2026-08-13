use serde::{Deserialize, Serialize};
use std::fs::read_to_string;
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Blocker,
    Risk,
    Note,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Finding {
    pub id: String,
    pub severity: Severity,
    pub what: String,
    pub why: String,
    pub fix: String,
    pub autofixable: bool,
}

#[derive(Debug, Clone, Default)]
pub struct ProjectInfo {
    pub rules: Vec<String>,
    pub findings: Vec<Finding>,
    pub summary: String,
}

pub fn inspect_project(cwd: &Path) -> ProjectInfo {
    let mut rules = Vec::new();
    let mut findings = Vec::new();

    let candidate_files = [
        ".underclass/rules",
        "CLAUDE.md",
        "AGENT.md",
        "AGENTS.md",
        ".cursorrules",
        "CONVENTIONS.md",
        ".github/copilot-instructions.md",
    ];

    for rel in candidate_files {
        let p = cwd.join(rel);
        if p.exists() {
            if let Ok(content) = read_to_string(&p) {
                let trimmed = content.trim();
                if !trimmed.is_empty() {
                    rules.push(format!("--- From {rel} ---\n{trimmed}"));
                }
            }
        }
    }

    // 1. Node lockfile check
    let pkg_path = cwd.join("package.json");
    if pkg_path.exists() {
        let has_lock = ["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb"]
            .iter()
            .any(|l| cwd.join(l).exists());
        if !has_lock {
            findings.push(Finding {
                id: "node-lockfile-missing".to_string(),
                severity: Severity::Risk,
                what: "package.json with no lockfile".to_string(),
                why: "Dependency versions float, so a build here and a build in CI can resolve differently.".to_string(),
                fix: "npm install   # then commit package-lock.json".to_string(),
                autofixable: false,
            });
        }

        // Test command check
        if let Ok(pkg_content) = read_to_string(&pkg_path) {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&pkg_content) {
                let test_cmd = json.get("scripts").and_then(|s| s.get("test")).and_then(|t| t.as_str());
                if test_cmd.map_or(true, |t| t.to_lowercase().contains("no test specified")) {
                    findings.push(Finding {
                        id: "no-test-command".to_string(),
                        severity: Severity::Risk,
                        what: "no usable `npm test` script".to_string(),
                        why: "An agent cannot verify its work without a test command.".to_string(),
                        fix: "Add a real \"test\" script to package.json".to_string(),
                        autofixable: false,
                    });
                }
            }
        }
    }

    // 2. Python dependency check
    let py_project = cwd.join("pyproject.toml").exists() || cwd.join("requirements.txt").exists();
    if py_project {
        let has_py_lock = cwd.join("uv.lock").exists()
            || cwd.join("poetry.lock") .exists()
            || cwd.join("Pipfile.lock").exists()
            || cwd.join("requirements.lock").exists();
        if !has_py_lock {
            findings.push(Finding {
                id: "python-unpinned".to_string(),
                severity: Severity::Risk,
                what: "Python project with unpinned dependencies".to_string(),
                why: "Unpinned versions make results non-reproducible.".to_string(),
                fix: "uv lock   # or: pip freeze > requirements.lock".to_string(),
                autofixable: false,
            });
        }
    }

    // 3. Android SDK check
    let build_gradle = cwd.join("build.gradle").exists() || cwd.join("build.gradle.kts").exists();
    if build_gradle {
        let android_env = std::env::var("ANDROID_HOME").or_else(|_| std::env::var("ANDROID_SDK_ROOT")).is_ok();
        if !android_env {
            findings.push(Finding {
                id: "android-sdk-unset".to_string(),
                severity: Severity::Blocker,
                what: "Android project, but ANDROID_HOME is not set".to_string(),
                why: "Gradle resolves SDK from ANDROID_HOME; without it the build fails.".to_string(),
                fix: "export ANDROID_HOME=/opt/android-sdk".to_string(),
                autofixable: false,
            });
        }
    }

    let summary = format!("Loaded {} rule file(s), detected {} project finding(s).", rules.len(), findings.len());
    ProjectInfo { rules, findings, summary }
}
