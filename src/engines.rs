use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::Duration;
use reqwest::Client;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EngineSpec {
    pub id: &'static str,
    pub name: &'static str,
    pub default_base_url: &'static str,
    pub default_port: u16,
    pub native_context_path: Option<&'static str>,
    pub health_path: Option<&'static str>,
}

pub const LOCAL_ENGINES: &[EngineSpec] = &[
    EngineSpec {
        id: "lmstudio",
        name: "LM Studio",
        default_base_url: "http://localhost:1234/v1",
        default_port: 1234,
        native_context_path: Some("/api/v0/models"),
        health_path: Some("/v1/models"),
    },
    EngineSpec {
        id: "ollama",
        name: "Ollama",
        default_base_url: "http://localhost:11434/v1",
        default_port: 11434,
        native_context_path: Some("/api/ps"),
        health_path: Some("/api/version"),
    },
    EngineSpec {
        id: "vllm",
        name: "vLLM",
        default_base_url: "http://localhost:8000/v1",
        default_port: 8000,
        native_context_path: None,
        health_path: Some("/version"),
    },
    EngineSpec {
        id: "llamacpp",
        name: "llama.cpp / llama-server",
        default_base_url: "http://localhost:8080/v1",
        default_port: 8080,
        native_context_path: Some("/props"),
        health_path: Some("/health"),
    },
    EngineSpec {
        id: "jan",
        name: "Jan",
        default_base_url: "http://localhost:1337/v1",
        default_port: 1337,
        native_context_path: None,
        health_path: Some("/v1/models"),
    },
    EngineSpec {
        id: "localai",
        name: "LocalAI",
        default_base_url: "http://localhost:8080/v1",
        default_port: 8080,
        native_context_path: None,
        health_path: Some("/readyz"),
    },
    EngineSpec {
        id: "koboldcpp",
        name: "KoboldCPP",
        default_base_url: "http://localhost:5001/v1",
        default_port: 5001,
        native_context_path: Some("/api/extra/version"),
        health_path: Some("/api/v1/model"),
    },
    EngineSpec {
        id: "llamafile",
        name: "llamafile",
        default_base_url: "http://localhost:8080/v1",
        default_port: 8080,
        native_context_path: None,
        health_path: Some("/v1/models"),
    },
    EngineSpec {
        id: "tabby",
        name: "Tabby",
        default_base_url: "http://localhost:8080/v1",
        default_port: 8080,
        native_context_path: None,
        health_path: Some("/v1/health"),
    },
    EngineSpec {
        id: "oobabooga",
        name: "Text Generation WebUI / oobabooga",
        default_base_url: "http://localhost:5000/v1",
        default_port: 5000,
        native_context_path: None,
        health_path: Some("/v1/models"),
    },
    EngineSpec {
        id: "exllamav2",
        name: "ExLlamaV2 / TabbyAPI",
        default_base_url: "http://localhost:5000/v1",
        default_port: 5000,
        native_context_path: None,
        health_path: Some("/v1/models"),
    },
    EngineSpec {
        id: "aphrodite",
        name: "Aphrodite Engine",
        default_base_url: "http://localhost:2242/v1",
        default_port: 2242,
        native_context_path: None,
        health_path: Some("/v1/models"),
    },
    EngineSpec {
        id: "mistralrs",
        name: "mistral.rs",
        default_base_url: "http://localhost:1234/v1",
        default_port: 1234,
        native_context_path: None,
        health_path: Some("/v1/models"),
    },
    EngineSpec {
        id: "fastchat",
        name: "FastChat",
        default_base_url: "http://localhost:8000/v1",
        default_port: 8000,
        native_context_path: None,
        health_path: Some("/v1/models"),
    },
    EngineSpec {
        id: "nim",
        name: "NVIDIA NIM",
        default_base_url: "http://localhost:8000/v1",
        default_port: 8000,
        native_context_path: None,
        health_path: Some("/v1/models"),
    },
    EngineSpec {
        id: "openwebui",
        name: "Open-WebUI",
        default_base_url: "http://localhost:3000/v1",
        default_port: 3000,
        native_context_path: None,
        health_path: Some("/api/models"),
    },
    EngineSpec {
        id: "tgi",
        name: "Text Generation Inference (TGI)",
        default_base_url: "http://localhost:8080/v1",
        default_port: 8080,
        native_context_path: None,
        health_path: Some("/health"),
    },
    EngineSpec {
        id: "exo",
        name: "Exo Cluster",
        default_base_url: "http://localhost:22415/v1",
        default_port: 22415,
        native_context_path: None,
        health_path: Some("/v1/models"),
    },
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscoveredEngine {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub available_models: Vec<DiscoveredModelSpec>,
    pub context_windows: HashMap<String, usize>,
    pub is_responsive: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscoveredModelSpec {
    pub id: String,
    pub context_window: Option<usize>,
}

pub async fn discover_all_local_engines(client: &Client) -> Vec<DiscoveredEngine> {
    let mut discovered = Vec::new();
    let mut seen_ports = std::collections::HashSet::new();

    for engine in LOCAL_ENGINES {
        if seen_ports.contains(&engine.default_port) && engine.id != "lmstudio" && engine.id != "ollama" {
            // Check if already probed on this port, unless it's a primary engine
        }
        seen_ports.insert(engine.default_port);

        let env_override = match engine.id {
            "lmstudio" => std::env::var("UNDERCLASS_LMSTUDIO_BASE").ok(),
            "ollama" => std::env::var("UNDERCLASS_OLLAMA_BASE").ok(),
            _ => None,
        };

        let base_url = env_override.unwrap_or_else(|| engine.default_base_url.to_string());
        if let Some(engine_info) = probe_engine(client, engine, &base_url).await {
            discovered.push(engine_info);
        }
    }

    discovered
}

pub async fn probe_engine(client: &Client, engine: &EngineSpec, base_url: &str) -> Option<DiscoveredEngine> {
    let root_url = base_url.trim_end_matches('/').trim_end_matches("/v1");
    let models_endpoint = format!("{}/v1/models", root_url);

    let res = client
        .get(&models_endpoint)
        .timeout(Duration::from_millis(2000))
        .send()
        .await;

    let mut is_responsive = false;
    let mut models = Vec::new();
    let mut context_map = HashMap::new();

    if let Ok(response) = res {
        if response.status().is_success() || response.status().as_u16() == 401 {
            is_responsive = true;
            if let Ok(json) = response.json::<serde_json::Value>().await {
                if let Some(data) = json.get("data").and_then(|d| d.as_array()) {
                    for m in data {
                        if let Some(id) = m.get("id").and_then(|i| i.as_str()) {
                            if !id.to_lowercase().contains("embed") {
                                let ctx = m.get("top_provider")
                                    .and_then(|tp| tp.get("context_length"))
                                    .or_else(|| m.get("context_length"))
                                    .and_then(|c| c.as_u64())
                                    .map(|c| c as usize);

                                if let Some(c) = ctx {
                                    context_map.insert(id.to_string(), c);
                                }

                                models.push(DiscoveredModelSpec {
                                    id: id.to_string(),
                                    context_window: ctx,
                                });
                            }
                        }
                    }
                }
            }
        }
    }

    // Try native context routes for specific engines
    if is_responsive {
        if engine.id == "lmstudio" {
            let lm_native = format!("{}/api/v0/models", root_url);
            if let Ok(resp) = client.get(&lm_native).timeout(Duration::from_millis(2000)).send().await {
                if let Ok(json) = resp.json::<serde_json::Value>().await {
                    if let Some(data) = json.get("data").and_then(|d| d.as_array()) {
                        for m in data {
                            if let (Some(id), Some(ctx)) = (m.get("id").and_then(|i| i.as_str()), m.get("loaded_context_length").and_then(|c| c.as_u64())) {
                                context_map.insert(id.to_string(), ctx as usize);
                            }
                        }
                    }
                }
            }
        } else if engine.id == "ollama" {
            let ollama_native = format!("{}/api/ps", root_url);
            if let Ok(resp) = client.get(&ollama_native).timeout(Duration::from_millis(2000)).send().await {
                if let Ok(json) = resp.json::<serde_json::Value>().await {
                    if let Some(models_arr) = json.get("models").and_then(|m| m.as_array()) {
                        for m in models_arr {
                            if let Some(ctx) = m.get("context_length").and_then(|c| c.as_u64()) {
                                if let Some(name) = m.get("name").and_then(|n| n.as_str()) {
                                    context_map.insert(name.to_string(), ctx as usize);
                                }
                                if let Some(model_id) = m.get("model").and_then(|n| n.as_str()) {
                                    context_map.insert(model_id.to_string(), ctx as usize);
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    if is_responsive {
        Some(DiscoveredEngine {
            id: engine.id.to_string(),
            name: engine.name.to_string(),
            base_url: base_url.to_string(),
            available_models: models,
            context_windows: context_map,
            is_responsive,
        })
    } else {
        None
    }
}
