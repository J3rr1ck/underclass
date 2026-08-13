use serde::{Deserialize, Serialize};
use std::fs::OpenOptions;
use std::io::Write;
use crate::config::under_dir;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunRecord {
    pub timestamp: String,
    pub provider: String,
    pub model: String,
    pub prompt: String,
    pub tokens_in: usize,
    pub tokens_out: usize,
    pub duration_ms: u64,
    pub tool_calls: usize,
    pub success: bool,
    pub finish_reason: String,
}

pub fn record_run(record: &RunRecord) {
    let path = under_dir().join("runs.jsonl");
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        if let Ok(line) = serde_json::to_string(record) {
            let _ = writeln!(file, "{line}");
        }
    }
}
