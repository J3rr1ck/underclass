use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::read_to_string;
use std::path::PathBuf;
use regex::Regex;
use crate::config::under_dir;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ModelMapEntry {
    pub traits: Option<Vec<String>>,
    pub avoid: Option<bool>,
    #[serde(rename = "servedContext")]
    pub served_context: Option<usize>,
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Tier {
    Tiny,
    Normal,
    Thinking,
    Planning,
}

impl Tier {
    pub fn as_str(&self) -> &'static str {
        match self {
            Tier::Tiny => "tiny",
            Tier::Normal => "normal",
            Tier::Thinking => "thinking",
            Tier::Planning => "planning",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum TierTarget {
    ModelSpec(String),
    EndpointSpec { endpoint: String, model: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ModelMap {
    #[serde(default)]
    pub models: HashMap<String, ModelMapEntry>,
    pub delegate_model: Option<String>,
    pub endpoints: Option<HashMap<String, String>>,
    pub tiers: Option<HashMap<String, TierTarget>>,
}

#[derive(Debug, Clone)]
pub struct ResolvedTier {
    pub model: String,
    pub base_url: Option<String>,
}

pub fn classify_task(prompt: &str) -> Tier {
    let p = prompt.to_lowercase();
    let thinking_re = Regex::new(r"\b(why|root cause|diagnos|investigat|debug|trace|design|architect|refactor|across|throughout|every (file|call ?site)|all (files|call ?sites)|redesign|migrat)\b").unwrap();
    
    if thinking_re.is_match(&p) || prompt.len() > 400 {
        return Tier::Thinking;
    }

    let mechanical_re = Regex::new(r"\b(add|create|write|rename|fix|update|remove|delete|bump|set)\b").unwrap();
    let file_re = Regex::new(r"[\w./-]+\.[a-z]{1,4}\b").unwrap();
    let file_count = file_re.find_iter(prompt).count();

    if mechanical_re.is_match(&p) && prompt.len() < 160 && file_count <= 1 {
        return Tier::Tiny;
    }

    Tier::Normal
}

pub fn load_model_map() -> ModelMap {
    let mut merged = ModelMap::default();

    // 1. Global map: ~/.underclass/model-map.json
    let global_path = under_dir().join("model-map.json");
    if let Ok(content) = read_to_string(&global_path) {
        if let Ok(parsed) = serde_json::from_str::<ModelMap>(&content) {
            merged = parsed;
        }
    }

    // 2. Project local map: .underclass/model-map.json
    let local_path = PathBuf::from(".underclass").join("model-map.json");
    if let Ok(content) = read_to_string(&local_path) {
        if let Ok(local) = serde_json::from_str::<ModelMap>(&content) {
            for (k, v) in local.models {
                merged.models.insert(k, v);
            }
            if local.delegate_model.is_some() {
                merged.delegate_model = local.delegate_model;
            }
            if let Some(endpoints) = local.endpoints {
                let mut base = merged.endpoints.unwrap_or_default();
                for (k, v) in endpoints {
                    base.insert(k, v);
                }
                merged.endpoints = Some(base);
            }
            if let Some(tiers) = local.tiers {
                let mut base = merged.tiers.unwrap_or_default();
                for (k, v) in tiers {
                    base.insert(k, v);
                }
                merged.tiers = Some(base);
            }
        }
    }

    merged
}

pub fn tier_model(map: &ModelMap, tier: Tier) -> Option<ResolvedTier> {
    let order = match tier {
        Tier::Planning => vec!["planning", "thinking", "normal", "tiny"],
        Tier::Thinking => vec!["thinking", "normal", "tiny"],
        Tier::Normal => vec!["normal", "thinking", "tiny"],
        Tier::Tiny => vec!["tiny", "normal", "thinking"],
    };

    let tiers = map.tiers.as_ref()?;
    for t_name in order {
        if let Some(target) = tiers.get(t_name) {
            match target {
                TierTarget::ModelSpec(model) => {
                    return Some(ResolvedTier {
                        model: model.clone(),
                        base_url: None,
                    });
                }
                TierTarget::EndpointSpec { endpoint, model } => {
                    let base_url = map.endpoints.as_ref().and_then(|e| e.get(endpoint)).cloned();
                    return Some(ResolvedTier {
                        model: model.clone(),
                        base_url,
                    });
                }
            }
        }
    }

    None
}
