use serde::{Deserialize, Serialize};
use std::fs::{read_to_string, write};
use std::path::Path;
use crate::tools::builtin::ToolResult;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EditChunk {
    pub path: String,
    pub search: String,
    pub replace: String,
}

pub fn execute_batch_edit(edits: &[EditChunk], cwd: &Path) -> ToolResult {
    let call_id = "batch_edit".to_string();
    let mut modified_files = 0;

    for edit in edits {
        let p = cwd.join(&edit.path);
        let content = match read_to_string(&p) {
            Ok(c) => c,
            Err(e) => return ToolResult { call_id, output: format!("Failed to read {}: {e}", edit.path), is_error: true },
        };

        if !content.contains(&edit.search) {
            return ToolResult {
                call_id,
                output: format!("Search block not found in {}", edit.path),
                is_error: true,
            };
        }

        let updated = content.replace(&edit.search, &edit.replace);
        if let Err(e) = write(&p, updated) {
            return ToolResult { call_id, output: format!("Failed to write to {}: {e}", edit.path), is_error: true };
        }
        modified_files += 1;
    }

    ToolResult {
        call_id,
        output: format!("Successfully applied batch edits across {modified_files} file(s)"),
        is_error: false,
    }
}
