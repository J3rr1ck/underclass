use serde::{Deserialize, Serialize};
use std::fs::OpenOptions;
use std::io::Write;
use crate::config::under_dir;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JournalEntry {
    pub timestamp: String,
    pub workflow_name: String,
    pub step_name: String,
    pub status: String,
    pub detail: String,
}

pub fn log_journal_entry(entry: &JournalEntry) {
    let path = under_dir().join("journal.jsonl");
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        if let Ok(line) = serde_json::to_string(entry) {
            let _ = writeln!(file, "{line}");
        }
    }
}
