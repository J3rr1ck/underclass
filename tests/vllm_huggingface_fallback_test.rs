use reqwest::Client;
use std::time::Duration;
use underclass::config::{pick_model_spec, write_models_json, ModelsJson, UnderOptions};

#[tokio::test]
async fn test_vllm_and_huggingface_fallback_resolution() {
    let client = Client::builder().timeout(Duration::from_secs(3)).build().unwrap();

    // 1. Test Hugging Face fallback when HF_TOKEN or explicit provider/model is given
    std::env::set_var("HF_TOKEN", "hf_test_token_sample");

    let opts = UnderOptions {
        model: Some("meta-llama/Llama-3.1-8B-Instruct".to_string()),
        provider: None,
        base_url: None,
        api_key: None,
    };

    let (models_path, live_providers, _) = write_models_json(&client, &opts).await;
    assert!(live_providers.contains(&"huggingface".to_string()));

    let models_content = std::fs::read_to_string(&models_path).expect("Failed to read models.json");
    let models_json: ModelsJson = serde_json::from_str(&models_content).expect("Failed to parse models.json");

    let (provider, model) = pick_model_spec(&opts, &live_providers, &models_json)
        .expect("Failed to resolve Hugging Face model fallback");

    assert_eq!(provider, "huggingface");
    assert_eq!(model, "meta-llama/Llama-3.1-8B-Instruct");

    std::env::remove_var("HF_TOKEN");
}

#[tokio::test]
async fn test_vllm_provider_prefix_resolution() {
    let client = Client::builder().timeout(Duration::from_secs(3)).build().unwrap();

    let opts = UnderOptions {
        model: Some("vllm/Qwen/Qwen2.5-Coder-7B-Instruct".to_string()),
        provider: Some("vllm".to_string()),
        base_url: Some("http://localhost:8000/v1".to_string()),
        api_key: None,
    };

    let (models_path, live_providers, _) = write_models_json(&client, &opts).await;
    assert!(live_providers.contains(&"vllm".to_string()));

    let models_content = std::fs::read_to_string(&models_path).expect("Failed to read models.json");
    let models_json: ModelsJson = serde_json::from_str(&models_content).expect("Failed to parse models.json");

    let (provider, model) = pick_model_spec(&opts, &live_providers, &models_json)
        .expect("Failed to resolve vllm spec");

    assert_eq!(provider, "vllm");
    assert_eq!(model, "Qwen/Qwen2.5-Coder-7B-Instruct");
}
