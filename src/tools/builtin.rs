use serde::{Deserialize, Serialize};
use std::fs::{read_to_string, write, read_dir};
use std::path::Path;
use std::process::Command;

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
            let p = cwd.join(path_str);
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
            let p = cwd.join(path_str);
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
            let p = cwd.join(path_str);
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
            let out = Command::new("rg")
                .arg("-n")
                .arg("--max-count=100")
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
            let p = cwd.join(dir_str);
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
