use std::path::Path;
use std::process::Command;
use crate::tools::builtin::ToolResult;

pub fn execute_repo_search(query: &str, cwd: &Path) -> ToolResult {
    let call_id = "repo_search".to_string();
    let out = Command::new("rg")
        .arg("-n")
        .arg("-C")
        .arg("2")
        .arg("--max-count=50")
        .arg(query)
        .current_dir(cwd)
        .output();

    match out {
        Ok(o) => ToolResult {
            call_id,
            output: String::from_utf8_lossy(&o.stdout).to_string(),
            is_error: false,
        },
        Err(e) => ToolResult {
            call_id,
            output: format!("repo_search ripgrep error: {e}"),
            is_error: true,
        },
    }
}
