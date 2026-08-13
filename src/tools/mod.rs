pub mod builtin;
pub mod repo_search;
pub mod hash_edit;
pub mod line_anchored_edit;
pub mod batch_edit;

use std::path::Path;
use serde_json::Value;
use crate::tools::builtin::{execute_builtin_tool, ToolResult};
use crate::tools::repo_search::execute_repo_search;
use crate::tools::hash_edit::execute_hash_edit;
use crate::tools::line_anchored_edit::execute_line_anchored_edit;
use crate::tools::batch_edit::{execute_batch_edit, EditChunk};

pub fn dispatch_tool(name: &str, args: &Value, cwd: &Path) -> ToolResult {
    match name {
        "repo_search" => {
            let query = args.get("query").and_then(|q| q.as_str()).unwrap_or("");
            execute_repo_search(query, cwd)
        }
        "hash_edit" => {
            let path = args.get("path").and_then(|p| p.as_str()).unwrap_or("");
            let hash = args.get("hash").and_then(|h| h.as_str());
            let search = args.get("search").and_then(|s| s.as_str()).unwrap_or("");
            let replace = args.get("replace").and_then(|r| r.as_str()).unwrap_or("");
            execute_hash_edit(path, hash, search, replace, cwd)
        }
        "line_anchored_edit" => {
            let path = args.get("path").and_then(|p| p.as_str()).unwrap_or("");
            let line = args.get("line").and_then(|l| l.as_u64()).unwrap_or(1) as usize;
            let search = args.get("search").and_then(|s| s.as_str()).unwrap_or("");
            let replace = args.get("replace").and_then(|r| r.as_str()).unwrap_or("");
            execute_line_anchored_edit(path, line, search, replace, cwd)
        }
        "batch_edit" => {
            if let Ok(edits) = serde_json::from_value::<Vec<EditChunk>>(args.get("edits").cloned().unwrap_or(Value::Array(vec![]))) {
                execute_batch_edit(&edits, cwd)
            } else {
                ToolResult { call_id: "batch_edit".to_string(), output: "Invalid batch_edit arguments".to_string(), is_error: true }
            }
        }
        other => execute_builtin_tool(other, args, cwd),
    }
}
