use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{read_to_string, write};
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use reqwest::Client;
use crate::config::under_dir;

pub const OPENROUTER_BASE: &str = "https://openrouter.ai/api/v1";
pub const CATALOGUE_TTL_SECS: u64 = 6 * 3600;
pub const RATE_LIMIT_COOLDOWN_SECS: u64 = 5 * 60;
pub const DEAD_COOLDOWN_SECS: u64 = 60 * 60;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FreeModel {
    pub id: String,
    pub name: Option<String>,
    #[serde(rename = "contextLength")]
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
    #[serde(rename = "fetchedAt")]
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
    let cache = read_free_cache();
    if now_secs().saturating_sub(cache.fetched_at) < CATALOGUE_TTL_SECS && !cache.models.is_empty() {
        return Ok(cache.models);
    }

    let url = format!("{OPENROUTER_BASE}/models?supported_parameters=tools");
    let resp = client.get(&url)
        .header("user-agent", "underclass/0.1.0-alpha.1")
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("Failed to reach OpenRouter: {e}"))?;

    if !resp.status().is_success() {
        if !cache.models.is_empty() {
            return Ok(cache.models);
        }
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
            let prompt_str = pricing.and_then(|p| p.get("prompt")).and_then(|v| v.as_str()).unwrap_or("1");
            let completion_str = pricing.and_then(|p| p.get("completion")).and_then(|v| v.as_str()).unwrap_or("1");

            let prompt_price: f64 = prompt_str.parse().unwrap_or(1.0);
            let completion_price: f64 = completion_str.parse().unwrap_or(1.0);

            if prompt_price == 0.0 && completion_price == 0.0 {
                let name = m.get("name").and_then(|n| n.as_str()).map(|s| s.to_string());
                let top_ctx = m.get("top_provider").and_then(|tp| tp.get("context_length")).and_then(|c| c.as_u64());
                let main_ctx = m.get("context_length").and_then(|c| c.as_u64());
                let ctx = top_ctx.or(main_ctx).unwrap_or(8192) as usize;

                let params = m.get("supported_parameters").and_then(|p| p.as_array());
                let has_tools = params.map_or(false, |arr| arr.iter().any(|v| v.as_str() == Some("tools")));
                let has_reasoning = params.map_or(false, |arr| arr.iter().any(|v| v.as_str() == Some("reasoning")));

                if has_tools {
                    free.push(FreeModel {
                        id: id.to_string(),
                        name,
                        context_length: ctx,
                        tools: true,
                        reasoning: has_reasoning,
                    });
                }
            }
        }
    }

    free.sort_by(|a, b| b.context_length.cmp(&a.context_length));

    let updated_cache = FreeModelsCache {
        fetched_at: now_secs(),
        models: free.clone(),
        health: cache.health,
    };
    write_free_cache(&updated_cache);

    Ok(free)
}

pub fn record_model_result(id: &str, status: u16) {
    let mut cache = read_free_cache();
    if (200..300).contains(&status) {
        cache.health.remove(id);
        write_free_cache(&cache);
        return;
    }

    let rate_limited = status == 429;
    let cooldown = if rate_limited { RATE_LIMIT_COOLDOWN_SECS } else { DEAD_COOLDOWN_SECS };
    let reason = if rate_limited {
        "rate-limited (free-tier quota)".to_string()
    } else {
        format!("unavailable ({status})")
    };
    let kind = if rate_limited { "rate-limited".to_string() } else { "dead".to_string() };

    cache.health.insert(id.to_string(), ModelHealth {
        until: now_secs() + cooldown,
        reason,
        kind,
    });

    write_free_cache(&cache);
}

pub fn pick_free_model(models: &[FreeModel], prefer: &[String]) -> Option<FreeModel> {
    let cache = read_free_cache();
    let now = now_secs();
    let usable: Vec<FreeModel> = models.iter()
        .filter(|m| m.tools && !cache.health.get(&m.id).map_or(false, |h| now < h.until))
        .cloned()
        .collect();

    if usable.is_empty() {
        return None;
    }

    for pref_id in prefer {
        if let Some(hit) = usable.iter().find(|m| &m.id == pref_id) {
            return Some(hit.clone());
        }
    }

    usable.first().cloned()
}
