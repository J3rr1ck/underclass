use std::fs::read_to_string;
use std::path::Path;

#[derive(Debug, Clone, Default)]
pub struct ProjectInfo {
    pub rules: Vec<String>,
    pub summary: String,
}

pub fn inspect_project(cwd: &Path) -> ProjectInfo {
    let mut rules = Vec::new();

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

    let summary = if rules.is_empty() {
        "No standing project rules found.".to_string()
    } else {
        format!("Loaded {} project rule file(s).", rules.len())
    };

    ProjectInfo { rules, summary }
}
