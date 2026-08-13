use std::fs::{read_to_string, write};
use std::path::Path;
use crate::tools::builtin::ToolResult;

pub fn execute_line_anchored_edit(path_str: &str, line_num: usize, search: &str, replace: &str, cwd: &Path) -> ToolResult {
    let call_id = "line_anchored_edit".to_string();
    let p = cwd.join(path_str);
    let content = match read_to_string(&p) {
        Ok(c) => c,
        Err(e) => return ToolResult { call_id, output: format!("Failed to read {path_str}: {e}"), is_error: true },
    };

    let lines: Vec<&str> = content.lines().collect();
    if line_num == 0 || line_num > lines.len() {
        return ToolResult {
            call_id,
            output: format!("Line number {line_num} out of bounds (file has {} lines)", lines.len()),
            is_error: true,
        };
    }

    // Inspect window around line_num (1-indexed)
    let start_idx = (line_num.saturating_sub(5)).max(1) - 1;
    let end_idx = (line_num + 5).min(lines.len());
    let window_content = lines[start_idx..end_idx].join("\n");

    if !window_content.contains(search) {
        return ToolResult {
            call_id,
            output: format!("Search block not found near line {line_num} in {path_str}"),
            is_error: true,
        };
    }

    let updated = content.replace(search, replace);
    match write(&p, updated) {
        Ok(_) => ToolResult { call_id, output: format!("Line-anchored edit applied to {path_str} at line {line_num}"), is_error: false },
        Err(e) => ToolResult { call_id, output: format!("Failed to write to {path_str}: {e}"), is_error: true },
    }
}
