use reqwest::Client;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::thread;
use std::time::Duration;
use underclass::agent::r#loop::{run_agent_loop, AgentSession};
use underclass::config::{pick_model_spec, write_models_json, ModelsJson, UnderOptions};

/// Mock vLLM OpenAI API server that serves Hugging Face models directly
fn spawn_mock_vllm_hf_server() -> (String, thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("Failed to bind tcp listener");
    let addr = listener.local_addr().unwrap();
    let base_url = format!("http://127.0.0.1:{}/v1", addr.port());

    let handle = thread::spawn(move || {
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
                                "id": "meta-llama/Llama-3.1-8B-Instruct",
                                "object": "model",
                                "created": 1700000000,
                                "owned_by": "vllm",
                                "context_length": 131072
                            },
                            {
                                "id": "Qwen/Qwen2.5-Coder-7B-Instruct",
                                "object": "model",
                                "created": 1700000000,
                                "owned_by": "vllm",
                                "context_length": 131072
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
                        "id": "chatcmpl-vllm-hf-123",
                        "object": "chat.completion",
                        "created": 1700000000,
                        "model": "meta-llama/Llama-3.1-8B-Instruct",
                        "choices": [
                            {
                                "index": 0,
                                "message": {
                                    "role": "assistant",
                                    "content": "vLLM with Hugging Face model execution verified!"
                                },
                                "finish_reason": "stop"
                            }
                        ],
                        "usage": {
                            "prompt_tokens": 20,
                            "completion_tokens": 10,
                            "total_tokens": 30
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
async fn test_vllm_huggingface_manual_model_pull_spec() {
    let client = Client::builder().timeout(Duration::from_secs(5)).build().unwrap();

    // 1. Test explicit vLLM prefix with Hugging Face repo ID: vllm/meta-llama/Llama-3.1-8B-Instruct
    let opts1 = UnderOptions {
        model: Some("vllm/meta-llama/Llama-3.1-8B-Instruct".to_string()),
        provider: None,
        base_url: None,
        api_key: None,
    };

    let (models_path1, live_providers1, _) = write_models_json(&client, &opts1).await;
    let models_content1 = std::fs::read_to_string(&models_path1).unwrap();
    let models_json1: ModelsJson = serde_json::from_str(&models_content1).unwrap();

    let (provider1, model1) = pick_model_spec(&opts1, &live_providers1, &models_json1).unwrap();
    assert_eq!(provider1, "vllm");
    assert_eq!(model1, "meta-llama/Llama-3.1-8B-Instruct");

    // 2. Test bare Hugging Face repo ID with provider set to vllm: --provider vllm -m Qwen/Qwen2.5-Coder-7B-Instruct
    let opts2 = UnderOptions {
        model: Some("Qwen/Qwen2.5-Coder-7B-Instruct".to_string()),
        provider: Some("vllm".to_string()),
        base_url: None,
        api_key: None,
    };

    let (models_path2, live_providers2, _) = write_models_json(&client, &opts2).await;
    let models_content2 = std::fs::read_to_string(&models_path2).unwrap();
    let models_json2: ModelsJson = serde_json::from_str(&models_content2).unwrap();

    let (provider2, model2) = pick_model_spec(&opts2, &live_providers2, &models_json2).unwrap();
    assert_eq!(provider2, "vllm");
    assert_eq!(model2, "Qwen/Qwen2.5-Coder-7B-Instruct");
}

#[tokio::test]
async fn test_vllm_huggingface_prompt_execution() {
    let (mock_base_url, _server_thread) = spawn_mock_vllm_hf_server();
    let client = Client::builder().timeout(Duration::from_secs(5)).build().unwrap();

    let opts = UnderOptions {
        model: Some("meta-llama/Llama-3.1-8B-Instruct".to_string()),
        provider: Some("vllm".to_string()),
        base_url: Some(mock_base_url.clone()),
        api_key: None,
    };

    let (models_path, live_providers, _) = write_models_json(&client, &opts).await;
    let models_content = std::fs::read_to_string(&models_path).unwrap();
    let models_json: ModelsJson = serde_json::from_str(&models_content).unwrap();

    let (provider, model) = pick_model_spec(&opts, &live_providers, &models_json).unwrap();
    assert_eq!(provider, "vllm");
    assert_eq!(model, "meta-llama/Llama-3.1-8B-Instruct");

    let session = AgentSession {
        provider,
        model_id: model,
        base_url: mock_base_url,
        api_key: "vllm".to_string(),
        context_window: 131072,
        max_tokens: 4096,
    };

    let cwd = PathBuf::from(".");
    let res = run_agent_loop(&session, &client, "Test prompt for vLLM Hugging Face model", &cwd, 1)
        .await
        .expect("Agent loop failed on vLLM server");

    assert!(res.contains("vLLM with Hugging Face model execution verified!"));
}
