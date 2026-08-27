use serde::{Deserialize, Serialize};
use std::fs::{read_to_string, write, read_dir};
use std::path::Path;
use std::process::Command;
use crate::tools::sandbox::safe_join;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    pub name: String,
    pub arguments: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolResult {
    pub call_id: String,
    pub output: String,
    pub is_error: bool,
}

pub fn execute_builtin_tool(name: &str, args: &serde_json::Value, cwd: &Path) -> ToolResult {
    let call_id = name.to_string();
    match name {
        "read" => {
            let path_str = args.get("path").and_then(|p| p.as_str()).unwrap_or("");
            // Live-found: a raw cwd.join(path_str) is a no-op sandbox for an
            // absolute path -- Path::join discards the base entirely when the
            // joined-in path is absolute. read("/etc/passwd") or
            // read("~/.ssh/id_rsa") returned the real file, straight back to
            // the model and from there to whatever remote endpoint is
            // configured. safe_join refuses anything outside cwd.
            let p = match safe_join(cwd, path_str) {
                Ok(p) => p,
                Err(e) => return ToolResult { call_id, output: e, is_error: true },
            };
            match read_to_string(&p) {
                Ok(content) => {
                    let lines: Vec<&str> = content.lines().collect();
                    let truncated = if lines.len() > 800 {
                        format!("{}\n... (truncated {} lines)", lines[..800].join("\n"), lines.len() - 800)
                    } else {
                        content
                    };
                    ToolResult { call_id, output: truncated, is_error: false }
                }
                Err(e) => ToolResult { call_id, output: format!("Failed to read {path_str}: {e}"), is_error: true },
            }
        }
        "write" => {
            let path_str = args.get("path").and_then(|p| p.as_str()).unwrap_or("");
            let content = args.get("content").and_then(|c| c.as_str()).unwrap_or("");
            // Same sandbox gap as read, mutating instead of reading: an
            // absolute or ../-escaping path_str could otherwise write
            // anywhere the process has permissions.
            let p = match safe_join(cwd, path_str) {
                Ok(p) => p,
                Err(e) => return ToolResult { call_id, output: e, is_error: true },
            };
            if let Some(parent) = p.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            match write(&p, content) {
                Ok(_) => ToolResult { call_id, output: format!("Wrote {} bytes to {path_str}", content.len()), is_error: false },
                Err(e) => ToolResult { call_id, output: format!("Failed to write {path_str}: {e}"), is_error: true },
            }
        }
        "edit" => {
            let path_str = args.get("path").and_then(|p| p.as_str()).unwrap_or("");
            let search = args.get("search").and_then(|s| s.as_str()).unwrap_or("");
            let replace = args.get("replace").and_then(|r| r.as_str()).unwrap_or("");
            // Same sandbox gap as read/write.
            let p = match safe_join(cwd, path_str) {
                Ok(p) => p,
                Err(e) => return ToolResult { call_id, output: e, is_error: true },
            };
            match read_to_string(&p) {
                Ok(content) => {
                    if !content.contains(search) {
                        return ToolResult { call_id, output: format!("Search block not found in {path_str}"), is_error: true };
                    }
                    let new_content = content.replace(search, replace);
                    match write(&p, new_content) {
                        Ok(_) => ToolResult { call_id, output: format!("Successfully edited {path_str}"), is_error: false },
                        Err(e) => ToolResult { call_id, output: format!("Failed to write edits to {path_str}: {e}"), is_error: true },
                    }
                }
                Err(e) => ToolResult { call_id, output: format!("Failed to read {path_str}: {e}"), is_error: true },
            }
        }
        "bash" => {
            let cmd = args.get("command").and_then(|c| c.as_str()).unwrap_or("");
            let out = Command::new("bash")
                .arg("-c")
                .arg(cmd)
                .current_dir(cwd)
                .output();
            match out {
                Ok(o) => {
                    let stdout = String::from_utf8_lossy(&o.stdout);
                    let stderr = String::from_utf8_lossy(&o.stderr);
                    let combined = format!("{}{}", stdout, stderr);
                    let trimmed = if combined.len() > 8000 {
                        format!("... (truncated)\n{}", &combined[combined.len() - 8000..])
                    } else {
                        combined
                    };
                    ToolResult {
                        call_id,
                        output: format!("Exit Code: {}\nOutput:\n{}", o.status.code().unwrap_or(-1), trimmed),
                        is_error: !o.status.success(),
                    }
                }
                Err(e) => ToolResult { call_id, output: format!("Failed to execute bash command: {e}"), is_error: true },
            }
        }
        "grep" => {
            let query = args.get("query").and_then(|q| q.as_str()).unwrap_or("");
            // query is model-controlled and was passed as a bare arg: a query
            // starting with "-" (e.g. "--pre=sh -c '...'") gets parsed as a
            // ripgrep FLAG, not a pattern. ripgrep's real --pre option runs
            // an arbitrary shell command per searched file -- turning an
            // "ungated, read-only" tool into command execution with no
            // confirmation at all. -e marks everything after it as the
            // pattern, never a flag.
            let out = Command::new("rg")
                .arg("-n")
                .arg("--max-count=100")
                .arg("-e")
                .arg(query)
                .current_dir(cwd)
                .output();
            match out {
                Ok(o) => ToolResult { call_id, output: String::from_utf8_lossy(&o.stdout).to_string(), is_error: false },
                Err(e) => ToolResult { call_id, output: format!("ripgrep error: {e}"), is_error: true },
            }
        }
        "find" => {
            let pattern = args.get("pattern").and_then(|p| p.as_str()).unwrap_or("*");
            let out = Command::new("find")
                .arg(".")
                .arg("-name")
                .arg(pattern)
                .arg("-not")
                .arg("-path")
                .arg("*/.*")
                .current_dir(cwd)
                .output();
            match out {
                Ok(o) => ToolResult { call_id, output: String::from_utf8_lossy(&o.stdout).to_string(), is_error: false },
                Err(e) => ToolResult { call_id, output: format!("Find error: {e}"), is_error: true },
            }
        }
        "ls" => {
            let dir_str = args.get("path").and_then(|p| p.as_str()).unwrap_or(".");
            // Same sandbox gap as read/write/edit -- lower severity (lists
            // names, not contents) but still a real escape.
            let p = match safe_join(cwd, dir_str) {
                Ok(p) => p,
                Err(e) => return ToolResult { call_id, output: e, is_error: true },
            };
            match read_dir(&p) {
                Ok(entries) => {
                    let mut list = Vec::new();
                    for entry in entries.flatten() {
                        let name = entry.file_name().to_string_lossy().to_string();
                        let is_dir = entry.file_type().map_or(false, |ft| ft.is_dir());
                        list.push(format!("{}{}", name, if is_dir { "/" } else { "" }));
                    }
                    ToolResult { call_id, output: list.join("\n"), is_error: false }
                }
                Err(e) => ToolResult { call_id, output: format!("Failed to list directory {dir_str}: {e}"), is_error: true },
            }
        }
        _ => ToolResult { call_id, output: format!("Unknown tool: {name}"), is_error: true },
    }
}

#[cfg(test)]
mod security_regression_tests {
    use super::*;
    use serde_json::json;

    /// Live-found: `read` used a raw `cwd.join(path_str)` instead of
    /// `safe_join`, and Rust's own `Path::join` discards the base entirely
    /// when the joined-in path is absolute -- so `read("/etc/passwd")`
    /// returned the real file, not an error, and that content goes straight
    /// back to the model and from there to whatever remote endpoint is
    /// configured. Every file tool in this module now goes through
    /// `safe_join`; this pins that `read` does, and stays that way.
    #[test]
    fn read_refuses_an_absolute_path_outside_cwd() {
        let dir = tempfile::tempdir().unwrap();
        let result = execute_builtin_tool("read", &json!({ "path": "/etc/passwd" }), dir.path());
        assert!(result.is_error, "read(\"/etc/passwd\") should refuse, not return the file");
        assert!(
            !result.output.contains("root:"),
            "output should not contain /etc/passwd's real content: {}",
            result.output
        );
    }

    #[test]
    fn read_refuses_a_dotdot_traversal_outside_cwd() {
        let dir = tempfile::tempdir().unwrap();
        let result = execute_builtin_tool("read", &json!({ "path": "../../../../etc/passwd" }), dir.path());
        assert!(result.is_error, "a ../ escape should refuse the same way an absolute path does");
    }

    #[test]
    fn write_refuses_an_absolute_path_outside_cwd() {
        let dir = tempfile::tempdir().unwrap();
        let result = execute_builtin_tool(
            "write",
            &json!({ "path": "/tmp/danger-rs-write-sandbox-escape-proof", "content": "x" }),
            dir.path(),
        );
        assert!(result.is_error, "write(\"/tmp/...\") should refuse, not write outside cwd");
        assert!(!std::path::Path::new("/tmp/danger-rs-write-sandbox-escape-proof").exists());
    }

    /// Live-found: `query` was passed to `rg` as a bare argument with no
    /// `-e`/`--`, so a query starting with "-" was parsed as a ripgrep FLAG
    /// rather than a search pattern. ripgrep's real `--pre <CMD>` option
    /// runs an arbitrary shell command per searched file -- turning an
    /// "ungated, read-only" tool into command execution. This proves the
    /// injected command does NOT run: if the fix regresses, this test
    /// creates a real marker file, which is a much louder failure than an
    /// assertion alone.
    #[test]
    fn grep_does_not_let_a_query_inject_a_ripgrep_flag() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("pwned_if_this_exists");
        std::fs::write(dir.path().join("haystack.txt"), "needle\n").unwrap();
        let query = format!("--pre=sh -c \"touch {}\"", marker.display());
        let _ = execute_builtin_tool("grep", &json!({ "query": query }), dir.path());
        assert!(
            !marker.exists(),
            "the injected shell command ran -- --pre was interpreted as a ripgrep flag, not part of the pattern"
        );
    }
}
