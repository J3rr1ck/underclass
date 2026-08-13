use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Command;
use reqwest::Client;
use crate::agent::llm::{send_chat_completion, ChatCompletionRequest, ChatMessage};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanStep {
    pub file: Option<String>,
    pub action: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Plan {
    pub steps: Vec<PlanStep>,
    pub notes: Option<String>,
}

pub const PLAN_SYSTEM: &str = "You are planning work for a SMALL, LITERAL coding model that will execute your steps.\n\
It has file read/write/edit tools and a shell. It is not clever: it follows instructions exactly and\n\
fails when a step requires judgement or spans several files at once.\n\n\
Produce a plan as JSON only, no prose:\n\
{\"steps\":[{\"file\":\"path/to/file\",\"action\":\"one imperative instruction\"}],\"notes\":\"optional context\"}\n\n\
Rules for steps:\n\
- Each step must be independently executable and verifiable.\n\
- Name the exact file. Name the exact change. Quote the literal text to find and the literal text to replace it with wherever you can.\n\
- No step may require deciding whether to do something. You decide; the executor acts.\n\
- Prefer 1-6 steps. If the task genuinely needs more, the task is too large — say so in notes.\n\
- If a step needs a command run to verify, make that its own step with the exact command.\n\n\
NEVER emit an investigation step. Read X, examine structure, review code, analyse implementation and locate bug are all forbidden.\n\
Every step must change something or verify something.";

pub fn repo_context(cwd: &Path) -> String {
    let mut bits = Vec::new();

    if let Ok(out) = Command::new("git").args(["ls-files"]).current_dir(cwd).output() {
        if out.status.success() {
            let tree = String::from_utf8_lossy(&out.stdout);
            let lines: Vec<&str> = tree.lines().collect();
            let sample = lines.iter().take(200).copied().collect::<Vec<&str>>().join("\n");
            bits.push(format!("Files ({} tracked, first {}):\n{}", lines.len(), sample.lines().count(), sample));
        }
    }

    if let Ok(out) = Command::new("git").args(["status", "--porcelain"]).current_dir(cwd).output() {
        if out.status.success() {
            let status = String::from_utf8_lossy(&out.stdout);
            if !status.trim().is_empty() {
                let trimmed = status.chars().take(800).collect::<String>();
                bits.push(format!("Uncommitted changes:\n{trimmed}"));
            }
        }
    }

    bits.join("\n\n")
}

pub async fn generate_plan(
    client: &Client,
    base_url: &str,
    api_key: &str,
    model: &str,
    prompt: &str,
    cwd: &Path,
) -> Result<Plan, String> {
    let context = repo_context(cwd);
    let user_msg = if context.is_empty() {
        prompt.to_string()
    } else {
        format!("{prompt}\n\nRepo Context:\n{context}")
    };

    let req = ChatCompletionRequest {
        model: model.to_string(),
        messages: vec![
            ChatMessage { role: "system".to_string(), content: Some(PLAN_SYSTEM.to_string()), tool_calls: None, tool_call_id: None },
            ChatMessage { role: "user".to_string(), content: Some(user_msg), tool_calls: None, tool_call_id: None },
        ],
        tools: None,
        temperature: Some(0.1),
        max_tokens: Some(4096),
    };

    let resp = send_chat_completion(client, base_url, api_key, None, &req).await?;
    let content = resp.choices.first()
        .and_then(|c| c.message.content.clone())
        .ok_or_else(|| "Planner returned empty response".to_string())?;

    // Clean JSON codeblock wrappers if present
    let json_str = content.trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();

    serde_json::from_str::<Plan>(json_str).map_err(|e| format!("Failed to parse plan JSON: {e} ({json_str})"))
}

pub fn format_plan_as_prompt(plan: &Plan) -> String {
    let mut out = String::from("Execute the following plan step by step:\n");
    if let Some(ref notes) = plan.notes {
        out.push_str(&format!("Notes: {}\n\n", notes));
    }
    for (idx, step) in plan.steps.iter().enumerate() {
        if let Some(ref file) = step.file {
            out.push_str(&format!("{}. [{}] {}\n", idx + 1, file, step.action));
        } else {
            out.push_str(&format!("{}. {}\n", idx + 1, step.action));
        }
    }
    out
}
