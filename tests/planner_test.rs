use reqwest::Client;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::thread;
use std::time::Duration;
use tempfile::tempdir;
use underclass::planner::{format_plan_as_prompt, generate_plan, repo_context, Plan, PlanStep};

fn spawn_mock_planner_server() -> (String, thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let base_url = format!("http://127.0.0.1:{}/v1", addr.port());

    let handle = thread::spawn(move || {
        for _ in 0..2 {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buffer = [0; 4096];
                let _ = stream.read(&mut buffer);
                let body = r#"{
                    "id": "chatcmpl-plan-1",
                    "object": "chat.completion",
                    "created": 1700000000,
                    "model": "planner-model",
                    "choices": [
                        {
                            "index": 0,
                            "message": {
                                "role": "assistant",
                                "content": "{\"steps\":[{\"file\":\"src/main.rs\",\"action\":\"Add error handling\"}],\"notes\":\"Planning verified\"}"
                            },
                            "finish_reason": "stop"
                        }
                    ]
                }"#;
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = stream.write_all(resp.as_bytes());
            }
        }
    });

    (base_url, handle)
}

#[test]
fn test_format_plan_as_prompt() {
    let plan = Plan {
        steps: vec![
            PlanStep {
                file: Some("src/app.rs".to_string()),
                action: "Fix null pointer check".to_string(),
            },
            PlanStep {
                file: None,
                action: "Run cargo test to verify".to_string(),
            },
        ],
        notes: Some("Crucial bug fix".to_string()),
    };

    let formatted = format_plan_as_prompt(&plan);
    assert!(formatted.contains("Notes: Crucial bug fix"));
    assert!(formatted.contains("1. [src/app.rs] Fix null pointer check"));
    assert!(formatted.contains("2. Run cargo test to verify"));
}

#[test]
fn test_repo_context_extraction() {
    let dir = tempdir().unwrap();
    let ctx = repo_context(dir.path());
    // Should run without error even in empty directory
    assert!(ctx.is_empty() || ctx.contains("Files") || ctx.contains("Uncommitted"));
}

#[tokio::test]
async fn test_generate_plan_mock_execution() {
    let (base_url, _thread) = spawn_mock_planner_server();
    let client = Client::builder().timeout(Duration::from_secs(3)).build().unwrap();
    let dir = tempdir().unwrap();

    let plan = generate_plan(&client, &base_url, "key", "model", "Fix bug in main", dir.path())
        .await
        .expect("Plan generation failed");

    assert_eq!(plan.steps.len(), 1);
    assert_eq!(plan.steps[0].file.as_deref(), Some("src/main.rs"));
    assert_eq!(plan.steps[0].action, "Add error handling");
    assert_eq!(plan.notes.as_deref(), Some("Planning verified"));
}
