use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::time::Duration;
use reqwest::Client;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<LlmToolCall>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmToolCall {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub function: LlmFunctionCall,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmFunctionCall {
    pub name: String,
    pub arguments: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatCompletionRequest {
    pub model: String,
    pub messages: Vec<ChatMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f32>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ChatCompletionResponse {
    pub id: Option<String>,
    pub choices: Vec<Choice>,
    pub usage: Option<Usage>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Choice {
    pub message: ChatMessage,
    pub finish_reason: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct Usage {
    pub prompt_tokens: Option<usize>,
    pub completion_tokens: Option<usize>,
    pub total_tokens: Option<usize>,
}

pub async fn send_chat_completion(
    client: &Client,
    base_url: &str,
    api_key: &str,
    headers_opt: Option<&HashMap<String, String>>,
    request: &ChatCompletionRequest,
) -> Result<ChatCompletionResponse, String> {
    let root = base_url.trim_end_matches('/').trim_end_matches("/v1");
    let endpoint = format!("{root}/v1/chat/completions");

    let mut req_builder = client.post(&endpoint)
        .header("authorization", format!("Bearer {api_key}"))
        .header("content-type", "application/json")
        .timeout(Duration::from_secs(120));

    if let Some(hdrs) = headers_opt {
        for (k, v) in hdrs {
            req_builder = req_builder.header(k, v);
        }
    }

    let resp = req_builder.json(request).send().await.map_err(|e| format!("HTTP request error: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("LLM Endpoint returned HTTP {status}: {body}"));
    }

    let completion: ChatCompletionResponse = resp.json().await.map_err(|e| format!("Failed to parse response JSON: {e}"))?;
    Ok(completion)
}
