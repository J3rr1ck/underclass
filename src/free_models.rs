use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{read_to_string, write};
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use reqwest::Client;
use crate::config::under_dir;

pub const OPENROUTER_BASE: &str = "https://openrouter.ai/api/v1";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FreeModel {
    pub id: String,
    pub name: Option<String>,
    pub context_length: usize,
    pub tools: bool,
    pub reasoning: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelHealth {
    pub until: u64,
    pub reason: String,
    pub kind: String, // "rate-limited" | "dead"
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct FreeModelsCache {
    pub fetched_at: u64,
    pub models: Vec<FreeModel>,
    pub health: HashMap<String, ModelHealth>,
}

fn cache_path() -> PathBuf {
    under_dir().join("free-models.json")
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()
}

pub fn read_free_cache() -> FreeModelsCache {
    if let Ok(content) = read_to_string(cache_path()) {
        if let Ok(cache) = serde_json::from_str::<FreeModelsCache>(&content) {
            return cache;
        }
    }
    FreeModelsCache::default()
}

pub fn write_free_cache(cache: &FreeModelsCache) {
    if let Ok(serialized) = serde_json::to_string_pretty(cache) {
        let _ = write(cache_path(), serialized);
    }
}

pub async fn fetch_free_models(client: &Client) -> Result<Vec<FreeModel>, String> {
    let url = format!("{OPENROUTER_BASE}/models?supported_parameters=tools");
    let resp = client.get(&url)
        .header("user-agent", "underclass/0.1.0-alpha.1")
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("Failed to reach OpenRouter: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("OpenRouter /models returned HTTP {}", resp.status()));
    }

    let json: serde_json::Value = resp.json().await.map_err(|e| format!("Invalid JSON from OpenRouter: {e}"))?;
    let mut free = Vec::new();

    if let Some(data) = json.get("data").and_then(|d| d.as_array()) {
        for m in data {
            let id = match m.get("id").and_then(|i| i.as_str()) {
                Some(i) => i,
                None => continue,
            };
            let pricing = m.get("pricing");
            let prompt_price = pricing.and_then(|p| p.get("prompt")).and_then(|v| v.as_str()).unwrap_or("1");
            let completion_price = pricing.and_then(|p| p.get("completion")).and_then(|v| v.as_str()).unwrap_or("1");

            let is_free = prompt_price == "0" && completion_price == "0";
            if is_free {
                let name = m.get("name").and_then(|n| n.as_str()).map(|s| s.to_string());
                let ctx = m.get("context_length").and_then(|c| c.as_u64()).unwrap_or(8192) as usize;
                let reasoning = m.get("architecture").and_then(|a| a.get("instruct_type")).map_or(false, |it| it == "reasoning");

                free.push(FreeModel {
                    id: id.to_string(),
                    name,
                    context_length: ctx,
                    tools: true,
                    reasoning,
                });
            }
        }
    }

    let mut cache = read_free_cache();
    cache.fetched_at = now_secs();
    cache.models = free.clone();
    write_free_cache(&cache);

    Ok(free)
}
