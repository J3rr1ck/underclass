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

    let mut total_tokens_in = 0;
    let mut total_tokens_out = 0;
    let mut total_tool_calls = 0;
    let mut final_response = String::new();

    let tools_schema = get_tools_schema();

    for turn in 1..=max_turns {
        println!("{}", format!("\n--- Agent Turn {} ---", turn).bold().dimmed());

        let req = ChatCompletionRequest {
            model: session.model_id.clone(),
            messages: messages.clone(),
            tools: Some(tools_schema.clone()),
            max_tokens: Some(session.max_tokens),
            temperature: Some(0.2),
        };

        let response = match send_chat_completion(client, &session.base_url, &session.api_key, None, &req).await {
            Ok(resp) => resp,
            Err(e) => {
                println!("  {} Turn failed: {}", "✗".red(), e);
                record_run(&RunRecord {
                    timestamp: chrono::Utc::now().to_rfc3339(),
                    provider: session.provider.clone(),
                    model: session.model_id.clone(),
                    prompt: prompt.to_string(),
                    tokens_in: total_tokens_in,
                    tokens_out: total_tokens_out,
                    duration_ms: start_time.elapsed().as_millis() as u64,
                    tool_calls: total_tool_calls,
                    success: false,
                    finish_reason: "error".to_string(),
                });
                return Err(e);
            }
        };

        if let Some(usage) = &response.usage {
            total_tokens_in += usage.prompt_tokens.unwrap_or(0);
            total_tokens_out += usage.completion_tokens.unwrap_or(0);
        }

        let choice = match response.choices.first() {
            Some(c) => c,
            None => break,
        };

        if let Some(ref text) = choice.message.content {
            if !text.trim().is_empty() {
                println!("{}", text);
                final_response = text.clone();
            }
        }

        // Check if model emitted tool calls
        if let Some(ref tool_calls) = choice.message.tool_calls {
            if !tool_calls.is_empty() {
                messages.push(choice.message.clone());
                for tc in tool_calls {
                    total_tool_calls += 1;
                    println!("  {} Calling tool: {}", "⚡".yellow(), tc.function.name.bold());

                    let args_val: serde_json::Value = serde_json::from_str(&tc.function.arguments).unwrap_or_default();
                    let result = dispatch_tool(&tc.function.name, &args_val, cwd);

                    let status_icon = if result.is_error { "✗".red() } else { "✓".green() };
                    println!("    {} Tool result: {}", status_icon, result.output.lines().next().unwrap_or("").dimmed());

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

    record_run(&RunRecord {
        timestamp: chrono::Utc::now().to_rfc3339(),
        provider: session.provider.clone(),
        model: session.model_id.clone(),
        prompt: prompt.to_string(),
        tokens_in: total_tokens_in,
        tokens_out: total_tokens_out,
        duration_ms: start_time.elapsed().as_millis() as u64,
        tool_calls: total_tool_calls,
        success: true,
        finish_reason: "stop".to_string(),
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
