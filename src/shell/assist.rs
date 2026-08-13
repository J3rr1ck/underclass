use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{read_to_string, write};
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use reqwest::Client;
use crate::agent::llm::{send_chat_completion, ChatCompletionRequest, ChatMessage};
use crate::config::{under_dir, DEFAULT_DANGER_BASE, DEFAULT_DANGER_MODEL, DEFAULT_GUEST_KEY};
use crate::shell::rules::suggest_install_hint;

pub const DOWN_TTL_SECS: u64 = 45;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EndpointDownEntry {
    pub until: u64,
    pub reason: String,
}

pub fn endpoint_state_path() -> PathBuf {
    under_dir().join("endpoint-state.json")
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()
}

pub fn read_down_state() -> HashMap<String, EndpointDownEntry> {
    if let Ok(content) = read_to_string(endpoint_state_path()) {
        if let Ok(map) = serde_json::from_str::<HashMap<String, EndpointDownEntry>>(&content) {
            return map;
        }
    }
    HashMap::new()
}

pub fn mark_endpoint_down(base_url: &str, reason: &str) {
    let mut state = read_down_state();
    state.insert(base_url.to_string(), EndpointDownEntry {
        until: now_secs() + DOWN_TTL_SECS,
        reason: reason.to_string(),
    });
    if let Ok(serialized) = serde_json::to_string_pretty(&state) {
        let _ = write(endpoint_state_path(), serialized);
    }
}

pub fn endpoint_down_reason(base_url: &str) -> Option<String> {
    if std::env::var("UNDER_NO_ENDPOINT_CACHE").is_ok() {
        return None;
    }
    let state = read_down_state();
    if let Some(entry) = state.get(base_url) {
        if now_secs() < entry.until {
            return Some(entry.reason.clone());
        }
    }
    None
}

pub async fn run_assist(input: &str, hint_mode: bool) {
    if hint_mode {
        if let Some(hint) = suggest_install_hint(input) {
            eprintln!("  Hint: {hint}");
            return;
        }
    }

    let danger_base = std::env::var("UNDERCLASS_API_BASE").unwrap_or_else(|_| DEFAULT_DANGER_BASE.to_string());
    if let Some(down_reason) = endpoint_down_reason(&danger_base) {
        eprintln!("Endpoint offline ({down_reason}), skipping assist.");
        return;
    }

    let client = Client::builder().timeout(Duration::from_secs(3)).build().unwrap_or_default();
    let danger_key = std::env::var("DANGER_API_KEY")
        .or_else(|_| std::env::var("UNDERCLASS_API_KEY"))
        .unwrap_or_else(|_| DEFAULT_GUEST_KEY.to_string());

    let sys = if hint_mode {
        "You are a CLI assistant. Given a command failure or missing command, output a concise 1-line shell hint or command to fix/install it. No markdown formatting."
    } else {
        "You are a CLI assistant. Translate the plain language user prompt into an exact, executable single bash shell command. Output ONLY the raw bash command line with no explanation or markdown code block wrapper."
    };

    let req = ChatCompletionRequest {
        model: DEFAULT_DANGER_MODEL.to_string(),
        messages: vec![
            ChatMessage { role: "system".to_string(), content: Some(sys.to_string()), tool_calls: None, tool_call_id: None },
            ChatMessage { role: "user".to_string(), content: Some(input.to_string()), tool_calls: None, tool_call_id: None },
        ],
        tools: None,
        max_tokens: Some(128),
        temperature: Some(0.1),
    };

    match send_chat_completion(&client, &danger_base, &danger_key, None, &req).await {
        Ok(resp) => {
            if let Some(choice) = resp.choices.first() {
                if let Some(ref text) = choice.message.content {
                    let trimmed = text.trim().trim_start_matches("```bash").trim_start_matches("```").trim_end_matches("```").trim();
                    println!("{trimmed}");
                }
            }
        }
        Err(e) => {
            mark_endpoint_down(&danger_base, &e);
        }
    }
}
