use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{create_dir_all, write};
use std::path::PathBuf;
use std::time::Duration;
use reqwest::Client;

use crate::engines::discover_all_local_engines;

pub const UNDER_VERSION: &str = "0.1.0-alpha.1";
pub const DEFAULT_DANGER_BASE: &str = "https://api.danger.plus/v1";
pub const DEFAULT_DANGER_MODEL: &str = "minimax-m2.7-jangtq-crack";
pub const DEFAULT_GUEST_KEY: &str = "danger_token_guest_mode";

pub const PI_CONTEXT_SAFETY_TOKENS: usize = 4096;
pub const MEASURED_MIN_PROMPT_TOKENS: usize = 2482;
pub const MIN_USABLE_GENERATION: usize = 512;
pub const MEASURED_TURN1_PROMPT_TOKENS: usize = 7965;
pub const UNKNOWN_CONTEXT: usize = 8192;

pub const KNOWN_PROVIDERS: &[&str] = &[
    "danger", "lmstudio", "ollama", "vllm", "llamacpp", "jan", "localai", "koboldcpp",
    "llamafile", "tabby", "oobabooga", "exllamav2", "aphrodite", "mistralrs", "fastchat",
    "nim", "openwebui", "tgi", "exo", "custom"
];

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct UnderOptions {
    pub model: Option<String>,
    pub provider: Option<String>,
    pub base_url: Option<String>,
    pub api_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderPreset {
    pub base_url: String,
    pub auth_env: Option<String>,
    pub default_model: Option<String>,
    pub tool_calling: Option<bool>,
    pub notes: Option<String>,
    pub privacy: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelConfigEntry {
    pub id: String,
    pub name: Option<String>,
    pub reasoning: bool,
    pub input: Vec<String>,
    pub context_window: usize,
    pub max_tokens: usize,
    pub cost: CostConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CostConfig {
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_write: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderConfig {
    pub name: String,
    pub base_url: String,
    pub api: String,
    pub api_key: String,
    pub headers: Option<HashMap<String, String>>,
    pub models: Vec<ModelConfigEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelsJson {
    pub providers: HashMap<String, ProviderConfig>,
}

pub fn under_dir() -> PathBuf {
    let dir = dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")).join(".underclass");
    if !dir.exists() {
        let _ = create_dir_all(&dir);
    }
    dir
}

pub fn pi_agent_dir() -> PathBuf {
    let dir = under_dir().join("pi");
    if !dir.exists() {
        let _ = create_dir_all(&dir);
    }
    dir
}

pub fn bare_model_id(model: &str) -> &str {
    if let Some(at) = model.find('/') {
        let prefix = &model[..at];
        if KNOWN_PROVIDERS.contains(&prefix) {
            return &model[at + 1..];
        }
    }
    model
}

pub fn generation_budget(context_window: usize, prompt_tokens: usize, max_tokens: usize) -> usize {
    if context_window == 0 {
        return max_tokens.max(1);
    }
    let available = context_window.saturating_sub(prompt_tokens).saturating_sub(PI_CONTEXT_SAFETY_TOKENS);
    max_tokens.min(available.max(1))
}

pub fn context_too_small(model_id: &str, context_window: usize, max_tokens: usize) -> Option<String> {
    let budget = generation_budget(context_window, MEASURED_MIN_PROMPT_TOKENS, max_tokens);
    if budget >= MIN_USABLE_GENERATION {
        return None;
    }
    Some(format!(
        "'{model_id}' is declared with a {context_window}-token context window, which leaves {budget} token(s) to generate with once the prompt and pi's {PI_CONTEXT_SAFETY_TOKENS}-token reserve are subtracted (measured smallest prompt: {MEASURED_MIN_PROMPT_TOKENS}).\n  A run like that emits one token, stops on 'length', calls no tool, and looks like success.\n  Fix it by raising context length in your model server or setting servedContext in model-map.json."
    ))
}

pub fn context_too_tight(model_id: &str, context_window: usize, max_tokens: usize) -> Option<String> {
    if context_too_small(model_id, context_window, max_tokens).is_some() {
        return None;
    }
    let budget = generation_budget(context_window, MEASURED_TURN1_PROMPT_TOKENS, max_tokens);
    if budget >= MIN_USABLE_GENERATION {
        return None;
    }
    Some(format!(
        "'{model_id}' has a {context_window}-token window. That is enough for the first turn, but by turn 2 (~{MEASURED_TURN1_PROMPT_TOKENS} prompt tokens) it leaves {budget} token(s) to generate with — the run will stop calling tools partway through. Raise served context in your server."
    ))
}

pub async fn check_endpoint(client: &Client, base_url: &str, attempts: usize) -> Option<String> {
    let root = base_url.trim_end_matches('/').trim_end_matches("/v1");
    let target = format!("{root}/v1/models");

    for attempt in 1..=attempts {
        let res = client.get(&target).timeout(Duration::from_millis(4000)).send().await;
        match res {
            Ok(resp) if resp.status().is_success() || resp.status().as_u16() == 401 => return None,
            Ok(resp) => {
                if attempt == attempts {
                    return Some(format!("endpoint {base_url} returned HTTP {}", resp.status()));
                }
            }
            Err(e) => {
                if attempt == attempts {
                    return Some(format!("cannot reach {base_url} ({e})"));
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(500 * attempt as u64)).await;
    }
    None
}

pub async fn write_models_json(client: &Client, opts: &UnderOptions) -> (PathBuf, Vec<String>, HashMap<String, String>) {
    let dir = pi_agent_dir();
    let mut providers: HashMap<String, ProviderConfig> = HashMap::new();
    let mut live_providers = Vec::new();
    let mut provider_base_urls = HashMap::new();

    let danger_base = std::env::var("UNDERCLASS_API_BASE").unwrap_or_else(|_| DEFAULT_DANGER_BASE.to_string());
    let danger_key = opts.api_key.clone()
        .or_else(|| std::env::var("DANGER_API_KEY").ok())
        .or_else(|| std::env::var("UNDERCLASS_API_KEY").ok())
        .unwrap_or_else(|| DEFAULT_GUEST_KEY.to_string());
    let danger_model = std::env::var("UNDERCLASS_MODEL").unwrap_or_else(|_| DEFAULT_DANGER_MODEL.to_string());

    let mut headers = HashMap::new();
    headers.insert("User-Agent".to_string(), format!("underclass/{UNDER_VERSION}"));

    let danger_models = vec![ModelConfigEntry {
        id: danger_model.clone(),
        name: Some(danger_model.clone()),
        reasoning: false,
        input: vec!["text".to_string()],
        context_window: 128000,
        max_tokens: 8192,
        cost: CostConfig::default(),
    }];

    providers.insert("danger".to_string(), ProviderConfig {
        name: "danger.plus".to_string(),
        base_url: danger_base.clone(),
        api: "openai-completions".to_string(),
        api_key: danger_key,
        headers: Some(headers),
        models: danger_models,
    });
    live_providers.push("danger".to_string());
    provider_base_urls.insert("danger".to_string(), danger_base);

    let discovered = discover_all_local_engines(client).await;
    for eng in discovered {
        if !eng.available_models.is_empty() {
            let mut models = Vec::new();
            for m in eng.available_models {
                let ctx = m.context_window.unwrap_or(UNKNOWN_CONTEXT);
                models.push(ModelConfigEntry {
                    id: m.id.clone(),
                    name: Some(m.id),
                    reasoning: false,
                    input: vec!["text".to_string()],
                    context_window: ctx,
                    max_tokens: (ctx / 4).clamp(1024, 8192),
                    cost: CostConfig::default(),
                });
            }
            providers.insert(eng.id.clone(), ProviderConfig {
                name: eng.name.clone(),
                base_url: eng.base_url.clone(),
                api: "openai-completions".to_string(),
                api_key: opts.api_key.clone().unwrap_or_else(|| eng.id.clone()),
                headers: None,
                models,
            });
            live_providers.push(eng.id.clone());
            provider_base_urls.insert(eng.id, eng.base_url);
        }
    }

    if let Some(ref base_url) = opts.base_url {
        let custom_key = opts.api_key.clone().or_else(|| std::env::var("OPENAI_API_KEY").ok()).unwrap_or_else(|| "none".to_string());
        let model_id = opts.model.as_deref().map(bare_model_id).unwrap_or("custom-model");

        let custom_models = vec![ModelConfigEntry {
            id: model_id.to_string(),
            name: Some(model_id.to_string()),
            reasoning: false,
            input: vec!["text".to_string()],
            context_window: 128000,
            max_tokens: 8192,
            cost: CostConfig::default(),
        }];

        providers.insert("custom".to_string(), ProviderConfig {
            name: "Custom endpoint".to_string(),
            base_url: base_url.clone(),
            api: "openai-completions".to_string(),
            api_key: custom_key,
            headers: None,
            models: custom_models,
        });
        live_providers.push("custom".to_string());
        provider_base_urls.insert("custom".to_string(), base_url.clone());
    }

    let models_json = ModelsJson { providers };
    let models_path = dir.join("models.json");
    if let Ok(serialized) = serde_json::to_string_pretty(&models_json) {
        let _ = write(&models_path, serialized);
    }

    (models_path, live_providers, provider_base_urls)
}

pub fn pick_model_spec(
    opts: &UnderOptions,
    live_providers: &[String],
    models_json: &ModelsJson,
) -> Result<(String, String), String> {
    if let Some(ref model) = opts.model {
        if let Some(at) = model.find('/') {
            let prefix = &model[..at];
            if KNOWN_PROVIDERS.contains(&prefix) {
                return Ok((prefix.to_string(), model[at + 1..].to_string()));
            }
        }
    }

    let preferred = if let Some(ref p) = opts.provider {
        vec![p.as_str()]
    } else if opts.base_url.is_some() {
        vec!["custom"]
    } else {
        vec!["danger", "lmstudio", "ollama", "vllm", "llamacpp", "jan", "localai", "koboldcpp", "llamafile"]
    };

    for provider in preferred {
        if live_providers.contains(&provider.to_string()) {
            if let Some(p_config) = models_json.providers.get(provider) {
                if !p_config.models.is_empty() {
                    if let Some(ref m_req) = opts.model {
                        let bare = bare_model_id(m_req);
                        if let Some(m_match) = p_config.models.iter().find(|m| m.id == bare || m.id == *m_req) {
                            return Ok((provider.to_string(), m_match.id.clone()));
                        }
                    } else {
                        return Ok((provider.to_string(), p_config.models[0].id.clone()));
                    }
                }
            }
        }
    }

    Err(opts.model.as_ref().map_or_else(
        || format!("No usable provider found in live providers: {}", live_providers.join(", ")),
        |m| format!("Model \"{m}\" not found in live providers: {}", live_providers.join(", "))
    ))
}
