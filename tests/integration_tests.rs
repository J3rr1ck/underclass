use underclass::config::{bare_model_id, context_too_small, generation_budget};
use underclass::engines::LOCAL_ENGINES;
use underclass::model_map::{classify_task, Tier};

#[test]
fn test_bare_model_id() {
    assert_eq!(bare_model_id("lmstudio/qwen3"), "qwen3");
    assert_eq!(bare_model_id("ollama/llama3"), "llama3");
    assert_eq!(bare_model_id("mlx-community/Qwen3-4B"), "mlx-community/Qwen3-4B");
}

#[test]
fn test_classify_task() {
    assert_eq!(classify_task("why did this build fail?"), Tier::Thinking);
    assert_eq!(classify_task("add a null check in src/app.ts"), Tier::Tiny);
    assert_eq!(classify_task("implement user authentication pipeline"), Tier::Normal);
}

#[test]
fn test_generation_budget() {
    let budget = generation_budget(32768, 4000, 8192);
    assert!(budget > 1000);
}

#[test]
fn test_local_engines_list() {
    assert!(LOCAL_ENGINES.len() >= 18);
    let ids: Vec<&str> = LOCAL_ENGINES.iter().map(|e| e.id).collect();
    assert!(ids.contains(&"lmstudio"));
    assert!(ids.contains(&"ollama"));
    assert!(ids.contains(&"vllm"));
    assert!(ids.contains(&"llamacpp"));
    assert!(ids.contains(&"jan"));
    assert!(ids.contains(&"koboldcpp"));
    assert!(ids.contains(&"aphrodite"));
    assert!(ids.contains(&"exllamav2"));
}
