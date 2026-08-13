use reqwest::Client;
use std::path::PathBuf;
use std::time::Duration;
use underclass::agent::r#loop::{run_agent_loop, AgentSession};
use underclass::config::{pick_model_spec, write_models_json, ModelsJson, UnderOptions};
use underclass::engines::discover_all_local_engines;

#[tokio::test]
async fn test_live_ollama_actual_prompt_response() {
    let client = Client::builder().timeout(Duration::from_secs(60)).build().unwrap();

    // 1. Discover local engines (including Ollama)
    let discovered = discover_all_local_engines(&client).await;
    let ollama_engine = discovered.iter().find(|e| e.id == "ollama");

    if let Some(ollama) = ollama_engine {
        // Prefer smaller models like 'ornith' or 'qwen' for ultra-fast execution if available
        let chosen_model = ollama
            .available_models
            .iter()
            .find(|m| m.id.contains("ornith") || m.id.contains("qwen"))
            .or_else(|| ollama.available_models.first());

        if let Some(model) = chosen_model {
            println!("Testing live response from Ollama model: {}", model.id);

            let opts = UnderOptions {
                model: Some(model.id.clone()),
                provider: Some("ollama".to_string()),
                base_url: Some("http://localhost:11434/v1".to_string()),
                api_key: Some("ollama".to_string()),
            };

            let (models_path, live_providers, _) = write_models_json(&client, &opts).await;
            let models_content = std::fs::read_to_string(&models_path).expect("Failed to read models.json");
            let models_json: ModelsJson = serde_json::from_str(&models_content).expect("Failed to parse models.json");

            let (selected_provider, selected_model) = pick_model_spec(&opts, &live_providers, &models_json)
                .expect("Failed to pick model spec for Ollama");

            let session = AgentSession {
                provider: selected_provider,
                model_id: selected_model,
                base_url: "http://localhost:11434/v1".to_string(),
                api_key: "ollama".to_string(),
                context_window: 32768,
                max_tokens: 512,
            };

            let cwd = PathBuf::from(".");
            let response_text = run_agent_loop(&session, &client, "Respond in one sentence with 'Underclass Rust agent verified'.", &cwd, 1)
                .await
                .expect("Failed to receive LLM response from local Ollama model");

            println!("\n=== ACTUAL LLM RESPONSE FROM INSTALLED OLLAMA MODEL ({}) ===", model.id);
            println!("{response_text}");
            println!("============================================================");

            assert!(!response_text.trim().is_empty(), "LLM response must not be empty!");
        } else {
            println!("Ollama engine found but no models loaded.");
        }
    } else {
        println!("No local Ollama engine active for live test.");
    }
}
