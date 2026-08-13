use reqwest::Client;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::thread;
use std::time::Duration;
use underclass::agent::llm::{send_chat_completion, ChatCompletionRequest, ChatMessage};
use underclass::agent::r#loop::{run_agent_loop, AgentSession};
use underclass::config::{pick_model_spec, write_models_json, ModelsJson, UnderOptions};
use underclass::engines::discover_all_local_engines;

/// Helper function to start a lightweight mock OpenAI-compatible server on a random port
fn spawn_mock_openai_server() -> (String, thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("Failed to bind tcp listener");
    let addr = listener.local_addr().unwrap();
    let base_url = format!("http://127.0.0.1:{}/v1", addr.port());

    let handle = thread::spawn(move || {
        // Accept up to 5 requests for testing
        for _ in 0..5 {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buffer = [0; 4096];
                let _ = stream.read(&mut buffer);
                let req_str = String::from_utf8_lossy(&buffer);

                if req_str.contains("GET /v1/models") {
                    let body = r#"{
                        "object": "list",
                        "data": [
                            {
                                "id": "test-mock-model",
                                "object": "model",
                                "created": 1700000000,
                                "owned_by": "mock",
                                "context_length": 32768
                            }
                        ]
                    }"#;
                    let response = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                        body.len(),
                        body
                    );
                    let _ = stream.write_all(response.as_bytes());
                } else if req_str.contains("POST /v1/chat/completions") {
                    let body = r#"{
                        "id": "chatcmpl-mock123",
                        "object": "chat.completion",
                        "created": 1700000000,
                        "model": "test-mock-model",
                        "choices": [
                            {
                                "index": 0,
                                "message": {
                                    "role": "assistant",
                                    "content": "Mock engine response: Underclass prompt execution verified!"
                                },
                                "finish_reason": "stop"
                            }
                        ],
                        "usage": {
                            "prompt_tokens": 15,
                            "completion_tokens": 10,
                            "total_tokens": 25
                        }
                    }"#;
                    let response = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                        body.len(),
                        body
                    );
                    let _ = stream.write_all(response.as_bytes());
                } else {
                    let body = "{}";
                    let response = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                        body.len(),
                        body
                    );
                    let _ = stream.write_all(response.as_bytes());
                }
            }
        }
    });

    (base_url, handle)
}

#[tokio::test]
async fn test_mock_inference_engine_discovery_and_prompt_execution() {
    let (mock_base_url, _server_thread) = spawn_mock_openai_server();
    let client = Client::builder().timeout(Duration::from_secs(5)).build().unwrap();

    // 1. Verify custom mock engine selection options
    let opts = UnderOptions {
        model: Some("custom/test-mock-model".to_string()),
        provider: Some("custom".to_string()),
        base_url: Some(mock_base_url.clone()),
        api_key: Some("test-key".to_string()),
    };

    let (models_path, live_providers, _) = write_models_json(&client, &opts).await;
    assert!(live_providers.contains(&"custom".to_string()));

    let models_content = std::fs::read_to_string(&models_path).expect("models.json path missing");
    let models_json: ModelsJson = serde_json::from_str(&models_content).expect("Failed to parse models.json");

    let (selected_provider, selected_model) = pick_model_spec(&opts, &live_providers, &models_json)
        .expect("Failed to pick model spec");

    assert_eq!(selected_provider, "custom");
    assert_eq!(selected_model, "test-mock-model");

    // 2. Build session and run test prompt
    let session = AgentSession {
        provider: selected_provider,
        model_id: selected_model,
        base_url: mock_base_url,
        api_key: "test-key".to_string(),
        context_window: 32768,
        max_tokens: 4096,
    };

    let cwd = PathBuf::from(".");
    let result = run_agent_loop(&session, &client, "Hello underclass agent! Verify execution.", &cwd, 2)
        .await
        .expect("Agent loop failed on mock server");

    assert!(result.contains("Mock engine response"));
}

#[tokio::test]
async fn test_live_installed_inference_engine_probing() {
    let client = Client::builder().timeout(Duration::from_secs(3)).build().unwrap();
    let discovered = discover_all_local_engines(&client).await;

    // Report all discovered installed inference engines
    println!("Discovered {} local engine(s):", discovered.len());
    for eng in &discovered {
        println!(" - Engine: {} ({}) - Models: {:?}", eng.id, eng.name, eng.available_models.iter().map(|m| &m.id).collect::<Vec<_>>());
    }

    let opts = UnderOptions::default();
    let (_, live_providers, _) = write_models_json(&client, &opts).await;

    // Ensure write_models_json identifies live providers correctly
    assert!(!live_providers.is_empty());
}
