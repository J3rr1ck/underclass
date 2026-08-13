use colored::Colorize;
use reqwest::Client;
use std::path::Path;
use std::time::Instant;
use crate::agent::llm::{send_chat_completion, ChatCompletionRequest, ChatMessage};
use crate::preferences::load_preferences;
use crate::project_rules::inspect_project;
use crate::telemetry::{record_run, RunRecord};
use crate::tools::dispatch_tool;

pub struct AgentSession {
    pub provider: String,
    pub model_id: String,
    pub base_url: String,
    pub api_key: String,
    pub context_window: usize,
    pub max_tokens: usize,
}

pub async fn run_agent_loop(
    session: &AgentSession,
    client: &Client,
    prompt: &str,
    cwd: &Path,
    max_turns: usize,
) -> Result<String, String> {
    let start_time = Instant::now();
    let effective_max_turns = std::env::var("UNDERCLASS_MAX_TURNS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(max_turns);

    println!("{}", format!("Starting task with model: {}/{}", session.provider, session.model_id).bold().cyan());

    // 1. Build System Prompt
    let proj_info = inspect_project(cwd);
    let prefs = load_preferences(true);

    let mut system_prompt = String::from(
        "You are Underclass, a high-performance local-first AI coding agent.\n\
         You have access to tools: read, write, edit, bash, grep, find, ls, repo_search, hash_edit, line_anchored_edit, batch_edit.\n\
         Analyze the project carefully, make targeted edits, test your work, and provide clear summaries."
    );

    if !proj_info.rules.is_empty() {
        system_prompt.push_str("\n\nStanding Project Rules:\n");
        for r in proj_info.rules {
            system_prompt.push_str(&format!("{}\n", r));
        }
    }

    if !prefs.standing_instructions.is_empty() {
        system_prompt.push_str("\n\nUser Preferences:\n");
        for p in prefs.standing_instructions {
            system_prompt.push_str(&format!("- {}\n", p));
        }
    }

    let mut messages = vec![
        ChatMessage {
            role: "system".to_string(),
            content: Some(system_prompt),
            tool_calls: None,
            tool_call_id: None,
        },
        ChatMessage {
            role: "user".to_string(),
            content: Some(prompt.to_string()),
            tool_calls: None,
            tool_call_id: None,
        },
    ];

    let mut turn = 0;
    let mut total_tokens_in = 0;
    let mut total_tokens_out = 0;
    let mut total_tool_calls = 0;
    let mut used_tools: Vec<String> = Vec::new();
    let mut final_response = String::new();

    while turn < effective_max_turns {
        turn += 1;
        println!("\n--- Agent Turn {turn} ---");

        let tools = get_tools_schema();
        let req = ChatCompletionRequest {
            model: session.model_id.clone(),
            messages: messages.clone(),
            tools: Some(tools),
            temperature: Some(0.2),
            max_tokens: Some(session.max_tokens),
        };

        let resp = match send_chat_completion(client, &session.base_url, &session.api_key, None, &req).await {
            Ok(r) => r,
            Err(e) => {
                let err_msg = format!("LLM request failed: {e}");
                eprintln!("{}", err_msg.red());
                let prompt_head = prompt.lines().next().unwrap_or(prompt).chars().take(80).collect::<String>();
                record_run(&RunRecord {
                    ts: chrono::Utc::now().to_rfc3339(),
                    provider: session.provider.clone(),
                    model: session.model_id.clone(),
                    tier: None,
                    prompt_head,
                    prompt_length: prompt.len(),
                    tokens_in: total_tokens_in,
                    tokens_out: total_tokens_out,
                    duration_ms: start_time.elapsed().as_millis() as u64,
                    tool_calls: total_tool_calls,
                    tools: used_tools,
                    outcome: "error".to_string(),
                    error_message: Some(e.clone()),
                    tag: std::env::var("UNDER_RUN_TAG").ok(),
                    session_id: None,
                });
                return Err(err_msg);
            }
        };

        if let Some(ref usage) = resp.usage {
            total_tokens_in += usage.prompt_tokens.unwrap_or(0);
            total_tokens_out += usage.completion_tokens.unwrap_or(0);
        }

        if resp.choices.is_empty() {
            break;
        }

        let choice = &resp.choices[0];
        let msg = &choice.message;

        if let Some(ref content) = msg.content {
            if !content.trim().is_empty() {
                println!("{content}");
                final_response = content.clone();
            }
        }

        messages.push(msg.clone());

        if let Some(ref tool_calls) = msg.tool_calls {
            if !tool_calls.is_empty() {
                total_tool_calls += tool_calls.len();
                for tc in tool_calls {
                    let tool_name = tc.function.name.clone();
                    if !used_tools.contains(&tool_name) {
                        used_tools.push(tool_name.clone());
                    }

                    println!("  {} Tool call: {} args: {}", "→".cyan(), tool_name.bold(), tc.function.arguments);
                    let args_json: serde_json::Value = serde_json::from_str(&tc.function.arguments)
                        .unwrap_or(serde_json::json!({}));
                    let result = dispatch_tool(&tc.function.name, &args_json, cwd);

                    if result.is_error {
                        println!("  {} Tool failed: {}", "✗".red(), result.output);
                    } else {
                        println!("  {} Tool output: {}", "✓".green(), result.output.lines().next().unwrap_or(""));
                    }

                    messages.push(ChatMessage {
                        role: "tool".to_string(),
                        content: Some(result.output),
                        tool_calls: None,
                        tool_call_id: Some(tc.id.clone()),
                    });
                }
                continue;
            }
        }

        // If no tool calls, conversation finished
        break;
    }

    let prompt_head = prompt.lines().next().unwrap_or(prompt).chars().take(80).collect::<String>();
    record_run(&RunRecord {
        ts: chrono::Utc::now().to_rfc3339(),
        provider: session.provider.clone(),
        model: session.model_id.clone(),
        tier: None,
        prompt_head,
        prompt_length: prompt.len(),
        tokens_in: total_tokens_in,
        tokens_out: total_tokens_out,
        duration_ms: start_time.elapsed().as_millis() as u64,
        tool_calls: total_tool_calls,
        tools: used_tools,
        outcome: "ok".to_string(),
        error_message: None,
        tag: std::env::var("UNDER_RUN_TAG").ok(),
        session_id: None,
    });

    println!("{}", format!("\nTask completed successfully! (In: {} tokens, Out: {} tokens, Tools: {})", total_tokens_in, total_tokens_out, total_tool_calls).bold().green());
    Ok(final_response)
}

fn get_tools_schema() -> Vec<serde_json::Value> {
    serde_json::from_str(r#"[
        {
            "type": "function",
            "function": {
                "name": "read",
                "description": "Read file contents safely.",
                "parameters": {
                    "type": "object",
                    "properties": { "path": { "type": "string" } },
                    "required": ["path"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "write",
                "description": "Create or overwrite a file.",
                "parameters": {
                    "type": "object",
                    "properties": { "path": { "type": "string" }, "content": { "type": "string" } },
                    "required": ["path", "content"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "edit",
                "description": "Replace a unique string search block with replacement text.",
                "parameters": {
                    "type": "object",
                    "properties": { "path": { "type": "string" }, "search": { "type": "string" }, "replace": { "type": "string" } },
                    "required": ["path", "search", "replace"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "bash",
                "description": "Run a bash shell command.",
                "parameters": {
                    "type": "object",
                    "properties": { "command": { "type": "string" } },
                    "required": ["command"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "grep",
                "description": "Search codebase using ripgrep.",
                "parameters": {
                    "type": "object",
                    "properties": { "query": { "type": "string" } },
                    "required": ["query"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "find",
                "description": "Find files by glob/name pattern.",
                "parameters": {
                    "type": "object",
                    "properties": { "pattern": { "type": "string" } },
                    "required": ["pattern"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "repo_search",
                "description": "Search code structure and symbol definitions.",
                "parameters": {
                    "type": "object",
                    "properties": { "query": { "type": "string" } },
                    "required": ["query"]
                }
            }
        }
    ]"#).unwrap()
}
