use serde::{Deserialize, Serialize};
use std::fs::OpenOptions;
use std::io::Write;
use crate::config::under_dir;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunRecord {
    pub ts: String,
    pub provider: String,
    pub model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tier: Option<String>,
    #[serde(rename = "promptHead")]
    pub prompt_head: String,
    #[serde(rename = "promptLength")]
    pub prompt_length: usize,
    #[serde(rename = "tokensIn")]
    pub tokens_in: usize,
    #[serde(rename = "tokensOut")]
    pub tokens_out: usize,
    #[serde(rename = "durationMs")]
    pub duration_ms: u64,
    #[serde(rename = "toolCalls")]
    pub tool_calls: usize,
    pub tools: Vec<String>,
    pub outcome: String,
    #[serde(rename = "errorMessage", skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tag: Option<String>,
    #[serde(rename = "sessionId", skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

pub fn record_run(record: &RunRecord) {
    let path = under_dir().join("runs.jsonl");
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        if let Ok(line) = serde_json::to_string(record) {
            let _ = writeln!(file, "{line}");
        }
    }
}
