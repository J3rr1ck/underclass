use tempfile::tempdir;
use underclass::telemetry::{record_run, RunRecord};

#[test]
fn test_record_run_json_serialization() {
    let rec = RunRecord {
        ts: "2026-08-12T19:00:00Z".to_string(),
        provider: "vllm".to_string(),
        model: "meta-llama/Llama-3.1-8B-Instruct".to_string(),
        tier: Some("normal".to_string()),
        prompt_head: "Fix bug in parser".to_string(),
        prompt_length: 17,
        tokens_in: 500,
        tokens_out: 120,
        duration_ms: 1500,
        tool_calls: 2,
        tools: vec!["read".to_string(), "edit".to_string()],
        outcome: "ok".to_string(),
        error_message: None,
        tag: Some("exp-1".to_string()),
        session_id: Some("session-123".to_string()),
    };

    let serialized = serde_json::to_string(&rec).expect("Failed to serialize RunRecord");
    assert!(serialized.contains("\"promptHead\":\"Fix bug in parser\""));
    assert!(serialized.contains("\"tokensIn\":500"));
    assert!(serialized.contains("\"tokensOut\":120"));
    assert!(serialized.contains("\"toolCalls\":2"));
    assert!(serialized.contains("\"outcome\":\"ok\""));

    let deserialized: RunRecord = serde_json::from_str(&serialized).expect("Failed to deserialize RunRecord");
    assert_eq!(deserialized.provider, "vllm");
    assert_eq!(deserialized.model, "meta-llama/Llama-3.1-8B-Instruct");
    assert_eq!(deserialized.tools, vec!["read", "edit"]);
}
