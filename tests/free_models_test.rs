use underclass::free_models::{pick_free_model, record_model_result, FreeModel};

#[test]
fn test_pick_free_model_ranking_and_preference() {
    let models = vec![
        FreeModel {
            id: "large-free-model".to_string(),
            name: Some("Large Free Model".to_string()),
            context_length: 131072,
            tools: true,
            reasoning: true,
        },
        FreeModel {
            id: "small-free-model".to_string(),
            name: Some("Small Free Model".to_string()),
            context_length: 8192,
            tools: true,
            reasoning: false,
        },
    ];

    // Default picks highest context length model
    let picked = pick_free_model(&models, &[]).unwrap();
    assert_eq!(picked.id, "large-free-model");

    // Preference overrides default highest context
    let preferred_picked = pick_free_model(&models, &["small-free-model".to_string()]).unwrap();
    assert_eq!(preferred_picked.id, "small-free-model");
}

#[test]
fn test_record_model_result_health_cooldown() {
    let test_id = "test-model-429-cooldown";
    record_model_result(test_id, 429);

    let models = vec![FreeModel {
        id: test_id.to_string(),
        name: None,
        context_length: 32768,
        tools: true,
        reasoning: false,
    }];

    // Model in rate-limited cooldown should not be picked
    let picked = pick_free_model(&models, &[]);
    assert!(picked.is_none());

    // Recovered status clears health block
    record_model_result(test_id, 200);
    let recovered = pick_free_model(&models, &[]);
    assert!(recovered.is_some());
}
