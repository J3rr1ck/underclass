use sha2::{Digest, Sha256};
use std::fs::{read_to_string, write};
use std::path::Path;
use crate::tools::builtin::ToolResult;

pub fn execute_hash_edit(path_str: &str, expected_hash: Option<&str>, search: &str, replace: &str, cwd: &Path) -> ToolResult {
    let call_id = "hash_edit".to_string();
    let p = cwd.join(path_str);
    let content = match read_to_string(&p) {
        Ok(c) => c,
        Err(e) => return ToolResult { call_id, output: format!("Failed to read {path_str}: {e}"), is_error: true },
    };

    if let Some(hash) = expected_hash {
        let mut hasher = Sha256::new();
        hasher.update(content.as_bytes());
        let computed = hex::encode(hasher.finalize());
        if !computed.starts_with(hash) {
            return ToolResult {
                call_id,
                output: format!("Hash mismatch for {path_str}: expected prefix {hash}, got {computed}"),
                is_error: true,
            };
        }
    }

    if !content.contains(search) {
        return ToolResult {
            call_id,
            output: format!("Search block not found in {path_str}"),
            is_error: true,
        };
    }

    let updated = content.replace(search, replace);
    match write(&p, updated) {
        Ok(_) => ToolResult { call_id, output: format!("Hash-verified edit applied to {path_str}"), is_error: false },
        Err(e) => ToolResult { call_id, output: format!("Failed to write to {path_str}: {e}"), is_error: true },
    }
}
