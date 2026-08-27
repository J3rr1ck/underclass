use std::collections::HashSet;
use std::path::Path;
use std::process::Command;
use crate::tools::builtin::ToolResult;

pub fn execute_repo_search(query: &str, cwd: &Path) -> ToolResult {
    let call_id = "repo_search".to_string();
    let query_escaped = regex::escape(query);

    let patterns = vec![
        format!(r"^\s*(export\s+)?(default\s+)?(async\s+)?(function|def|class|interface|struct|enum|type)\s+{}\b", query_escaped),
        format!(r"^\s*(export\s+)?(const|let|var)\s+{}\s*[:=]", query_escaped),
        format!(r"^\s*{}\s*[:=]\s*(async\s+)?(function|class|\(|=>|\{{)", query_escaped),
        format!(r"\b{}\b", query_escaped),
    ];

    let mut combined_output = String::new();
    let mut seen_lines = HashSet::new();

    for pattern in patterns {
        let out = Command::new("rg")
            .args(["-n", "-e", &pattern, "."])
            .current_dir(cwd)
            .output();

        if let Ok(o) = out {
            let text = String::from_utf8_lossy(&o.stdout);
            for line in text.lines() {
                if !line.trim().is_empty() && seen_lines.insert(line.to_string()) {
                    combined_output.push_str(line);
                    combined_output.push('\n');
                    if seen_lines.len() >= 100 {
                        break;
                    }
                }
            }
        }
        if seen_lines.len() >= 100 {
            break;
        }
    }

    if combined_output.is_empty() {
        // Fallback to literal ripgrep match. Same fix as builtin.rs's grep
        // tool: -e before query, so a query starting with "-" is never
        // parsed as a ripgrep flag (rg's real --pre option runs a shell
        // command per file). The primary patterns above already use -e;
        // only this fallback path was missing it.
        let out = Command::new("rg")
            .args(["-n", "-C", "2", "--max-count=50", "-e", query, "."])
            .current_dir(cwd)
            .output();

        match out {
            Ok(o) => {
                let text = String::from_utf8_lossy(&o.stdout).to_string();
                if text.trim().is_empty() {
                    return ToolResult {
                        call_id,
                        output: format!("No definitions or references found for symbol '{query}'"),
                        is_error: false,
                    };
                }
                return ToolResult {
                    call_id,
                    output: text,
                    is_error: false,
                };
            }
            Err(e) => return ToolResult {
                call_id,
                output: format!("repo_search ripgrep error: {e}"),
                is_error: true,
            },
        }
    }

    ToolResult {
        call_id,
        output: combined_output,
        is_error: false,
    }
}
