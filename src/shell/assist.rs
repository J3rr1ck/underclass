use reqwest::Client;
use std::time::Duration;
use crate::agent::llm::{send_chat_completion, ChatCompletionRequest, ChatMessage};
use crate::config::{DEFAULT_DANGER_BASE, DEFAULT_DANGER_MODEL, DEFAULT_GUEST_KEY};
use crate::shell::rules::suggest_install_hint;

pub async fn run_assist(input: &str, hint_mode: bool) {
    if hint_mode {
        if let Some(hint) = suggest_install_hint(input) {
            eprintln!("  Hint: {hint}");
            return;
        }
    }

    let client = Client::builder().timeout(Duration::from_secs(5)).build().unwrap_or_default();
    let danger_base = std::env::var("UNDERCLASS_API_BASE").unwrap_or_else(|_| DEFAULT_DANGER_BASE.to_string());
    let danger_key = std::env::var("DANGER_API_KEY")
        .or_else(|_| std::env::var("UNDERCLASS_API_KEY"))
        .unwrap_or_else(|_| DEFAULT_GUEST_KEY.to_string());

    let sys = if hint_mode {
        "You are a CLI assistant. Given a command failure or missing command, output a concise 1-line shell hint or command to fix/install it. No markdown formatting."
    } else {
        "You are a CLI assistant. Translate the plain language user prompt into an exact, executable single bash shell command. Output ONLY the raw bash command line with no explanation or markdown code block wrapper."
    };

    let req = ChatCompletionRequest {
        model: DEFAULT_DANGER_MODEL.to_string(),
        messages: vec![
            ChatMessage { role: "system".to_string(), content: Some(sys.to_string()), tool_calls: None, tool_call_id: None },
            ChatMessage { role: "user".to_string(), content: Some(input.to_string()), tool_calls: None, tool_call_id: None },
        ],
        tools: None,
        max_tokens: Some(128),
        temperature: Some(0.1),
    };

    if let Ok(resp) = send_chat_completion(&client, &danger_base, &danger_key, None, &req).await {
        if let Some(choice) = resp.choices.first() {
            if let Some(ref text) = choice.message.content {
                let trimmed = text.trim().trim_start_matches("```bash").trim_start_matches("```").trim_end_matches("```").trim();
                println!("{trimmed}");
            }
        }
    }
}
