//! AnthropicProvider — Provider trait implementation using Anthropic Messages API.
//!
//! Uses streaming (SSE) requests.
//! Handles tool_use / tool_result message conversion between core types
//! and the Anthropic API format.
//!
//! # Retry strategy
//!
//! Transient errors (429, 5xx, network failures, stream timeouts) are retried
//! up to 3 times with exponential backoff (300ms → 30s, jitter enabled).
//! A circuit breaker opens after 3 consecutive failures, blocking requests for
//! 30 seconds before allowing a retry probe.

use std::collections::HashMap;
use std::time::Duration;

use async_trait::async_trait;
use backon::{ExponentialBuilder, Retryable};
use futures_util::StreamExt;
use reqwest::Client;
use serde_json::{json, Value};
use tokio::time::{timeout, sleep};
use tracing::{debug, warn};

use tiguclaw_core::error::{Result, TiguError};
use tiguclaw_core::provider::{Provider, ToolDefinition};
use tiguclaw_core::types::*;

use crate::circuit_breaker::CircuitBreaker;
use crate::oauth;
use crate::retry::{is_retryable, parse_retry_after};

const API_URL: &str = "https://api.anthropic.com/v1/messages";
const API_VERSION: &str = "2023-06-01";

/// Circuit breaker: open after this many consecutive failures.
const CB_THRESHOLD: u32 = 3;
/// Circuit breaker: block requests for this duration after opening.
const CB_COOLDOWN: Duration = Duration::from_secs(30);

/// Thinking mode.
///
/// NOTE: `Adaptive` was removed — claude-opus-4 does not support `{"type":"adaptive"}`
/// and sending it causes API errors that trigger double-delivery bugs.
/// Deep mode now simply routes to the deep model without any special API parameter.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThinkingMode {
    /// Standard request — no thinking parameter sent.
    Off,
    /// Kept for config/code compatibility; behaves identically to Off.
    /// The thinking API parameter is NOT sent regardless of this value.
    Adaptive,
}

/// Anthropic Claude provider using the Messages API.
/// Supports both API key (sk-ant-api...) and OAuth token (sk-ant-oat...) auth.
pub struct AnthropicProvider {
    client: Client,
    api_key: String,
    model: String,
    max_tokens: u32,
    use_oauth: bool,
    thinking: ThinkingMode,
    effort: Option<String>,
    circuit_breaker: CircuitBreaker,
}

impl AnthropicProvider {
    pub fn new(api_key: String, model: String, max_tokens: u32) -> Self {
        let use_oauth = api_key.starts_with("sk-ant-oat");
        let client = Client::builder()
            .timeout(std::time::Duration::from_secs(120))
            .connect_timeout(std::time::Duration::from_secs(10))
            .build()
            .expect("reqwest client build failed");
        Self {
            client,
            api_key,
            model,
            max_tokens,
            use_oauth,
            thinking: ThinkingMode::Off,
            effort: None,
            circuit_breaker: CircuitBreaker::new(CB_THRESHOLD, CB_COOLDOWN),
        }
    }

    /// Create a new provider with thinking mode and effort level.
    pub fn with_thinking(
        api_key: String,
        model: String,
        max_tokens: u32,
        thinking: ThinkingMode,
        effort: Option<String>,
    ) -> Self {
        let use_oauth = api_key.starts_with("sk-ant-oat");
        let client = Client::builder()
            .timeout(std::time::Duration::from_secs(120))
            .connect_timeout(std::time::Duration::from_secs(10))
            .build()
            .expect("reqwest client build failed");
        Self {
            client,
            api_key,
            model,
            max_tokens,
            use_oauth,
            thinking,
            effort,
            circuit_breaker: CircuitBreaker::new(CB_THRESHOLD, CB_COOLDOWN),
        }
    }

    /// Return the model identifier this provider targets.
    pub fn model(&self) -> &str {
        &self.model
    }

    /// Return the thinking mode for this provider.
    pub fn thinking_mode(&self) -> ThinkingMode {
        self.thinking
    }

    /// 독립적인 circuit breaker를 가진 새 `AnthropicProvider` 인스턴스를 반환한다.
    ///
    /// reqwest `Client`는 내부적으로 Arc로 래핑되어 있어 공유해도 안전하다.
    /// API 키, 모델, 설정값은 복사하고 circuit breaker만 새로 생성한다.
    pub(crate) fn clone_fresh_internal(&self) -> Self {
        Self {
            client: self.client.clone(),
            api_key: self.api_key.clone(),
            model: self.model.clone(),
            max_tokens: self.max_tokens,
            use_oauth: self.use_oauth,
            thinking: self.thinking,
            effort: self.effort.clone(),
            circuit_breaker: CircuitBreaker::new(CB_THRESHOLD, CB_COOLDOWN),
        }
    }

    /// Convert core ChatMessages to Anthropic API format.
    /// Returns (system_prompt, api_messages).
    fn convert_messages(messages: &[ChatMessage]) -> (String, Vec<Value>) {
        let mut system = String::new();
        let mut api_messages: Vec<Value> = Vec::new();

        let mut i = 0;
        while i < messages.len() {
            let msg = &messages[i];
            match msg.role {
                Role::System => {
                    if !system.is_empty() {
                        system.push('\n');
                    }
                    system.push_str(&msg.content);
                    i += 1;
                }
                Role::User => {
                    api_messages.push(json!({
                        "role": "user",
                        "content": msg.content,
                    }));
                    i += 1;
                }
                Role::Assistant => {
                    if msg.tool_calls.is_empty() {
                        api_messages.push(json!({
                            "role": "assistant",
                            "content": msg.content,
                        }));
                    } else {
                        let mut content: Vec<Value> = Vec::new();
                        if !msg.content.is_empty() {
                            content.push(json!({
                                "type": "text",
                                "text": msg.content,
                            }));
                        }
                        for tc in &msg.tool_calls {
                            content.push(json!({
                                "type": "tool_use",
                                "id": tc.id,
                                "name": tc.name,
                                "input": tc.args,
                            }));
                        }
                        api_messages.push(json!({
                            "role": "assistant",
                            "content": content,
                        }));
                    }
                    i += 1;
                }
                Role::Tool => {
                    // Collect consecutive tool results into a single user message.
                    let mut tool_results: Vec<Value> = Vec::new();
                    while i < messages.len() && messages[i].role == Role::Tool {
                        let tr = &messages[i];
                        tool_results.push(json!({
                            "type": "tool_result",
                            "tool_use_id": tr.tool_call_id.as_deref().unwrap_or("unknown"),
                            "content": tr.content,
                        }));
                        i += 1;
                    }
                    api_messages.push(json!({
                        "role": "user",
                        "content": tool_results,
                    }));
                }
            }
        }

        (system, api_messages)
    }

    /// Convert Anthropic tool definitions to API format.
    ///
    /// When `use_oauth` is true, tool names are mapped to Claude Code
    /// standard names (e.g. `shell` → `Bash`).
    fn convert_tools(tools: &[ToolDefinition], use_oauth: bool) -> Vec<Value> {
        tools
            .iter()
            .map(|t| {
                let name = if use_oauth {
                    oauth::to_claude_code_name(&t.name).to_string()
                } else {
                    t.name.clone()
                };
                json!({
                    "name": name,
                    "description": t.description,
                    "input_schema": t.input_schema,
                })
            })
            .collect()
    }

    /// Parse an Anthropic API response body into a ChatResponse.
    ///
    /// When `use_oauth` is true, tool names in the response are mapped back
    /// from Claude Code names to internal names (e.g. `Bash` → `shell`).
    fn parse_response(body: &Value, use_oauth: bool) -> Result<ChatResponse> {
        let mut text = String::new();
        let mut tool_calls = Vec::new();

        let content = body["content"]
            .as_array()
            .ok_or_else(|| TiguError::Provider("missing content array in response".into()))?;

        for block in content {
            match block["type"].as_str() {
                Some("text") => {
                    if let Some(t) = block["text"].as_str() {
                        text.push_str(t);
                    }
                }
                Some("tool_use") => {
                    let id = block["id"]
                        .as_str()
                        .unwrap_or("unknown")
                        .to_string();
                    let raw_name = block["name"]
                        .as_str()
                        .unwrap_or("unknown");
                    let name = if use_oauth {
                        oauth::from_claude_code_name(raw_name).to_string()
                    } else {
                        raw_name.to_string()
                    };
                    let args = block["input"]
                        .as_object()
                        .map(|o| o.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
                        .unwrap_or_default();
                    tool_calls.push(ToolCall { id, name, args });
                }
                _ => {}
            }
        }

        let usage = Usage {
            input_tokens: body["usage"]["input_tokens"].as_u64().unwrap_or(0) as u32,
            output_tokens: body["usage"]["output_tokens"].as_u64().unwrap_or(0) as u32,
            cache_read_tokens: body["usage"]["cache_read_input_tokens"]
                .as_u64()
                .unwrap_or(0) as u32,
            cache_write_tokens: body["usage"]["cache_creation_input_tokens"]
                .as_u64()
                .unwrap_or(0) as u32,
        };

        Ok(ChatResponse {
            text,
            tool_calls,
            usage,
        })
    }

    /// Core HTTP request + SSE stream parsing. This is the unit retried by backon.
    ///
    /// Separated from `chat()` so the retry closure can call it multiple times
    /// without owning the converted message data.
    async fn do_request(
        &self,
        system: &str,
        api_messages: &[Value],
        api_tools: &[Value],
        effective_max_tokens: u32,
    ) -> Result<ChatResponse> {
        let mut body = json!({
            "model": self.model,
            "max_tokens": effective_max_tokens,
            "messages": api_messages,
            "stream": true,
        });

        // NOTE: adaptive thinking parameter intentionally omitted.
        // claude-opus-4 and newer models do not support {"type":"adaptive"} and return
        // a 400 error when it is present, which caused double-delivery via retry logic.

        // System prompt: OAuth requires array format with Claude Code identity first.
        // In both modes, add cache_control to the last system block to enable prompt caching.
        if self.use_oauth {
            let mut system_blocks = vec![json!({
                "type": "text",
                "text": oauth::CLAUDE_CODE_IDENTITY,
            })];
            if !system.is_empty() {
                system_blocks.push(json!({
                    "type": "text",
                    "text": system,
                    "cache_control": {"type": "ephemeral"},
                }));
            } else {
                system_blocks[0]["cache_control"] = json!({"type": "ephemeral"});
            }
            body["system"] = json!(system_blocks);
        } else if !system.is_empty() {
            body["system"] = json!([{
                "type": "text",
                "text": system,
                "cache_control": {"type": "ephemeral"},
            }]);
        }

        if !api_tools.is_empty() {
            body["tools"] = Value::Array(api_tools.to_vec());
        }

        debug!(model = %self.model, msg_count = api_messages.len(), "sending chat request");

        let mut request = self
            .client
            .post(API_URL)
            .header("anthropic-version", API_VERSION)
            .header("content-type", "application/json");

        if self.use_oauth {
            let beta = format!("{},prompt-caching-2024-07-31", oauth::OAUTH_BETA);
            request = request
                .header("Authorization", format!("Bearer {}", self.api_key))
                .header("anthropic-beta", beta)
                .header(
                    "user-agent",
                    format!("claude-cli/{}", oauth::CLAUDE_CODE_VERSION),
                )
                .header("x-app", "cli")
                .header("accept", "application/json")
                .header("anthropic-dangerous-direct-browser-access", "true");
        } else {
            request = request
                .header("x-api-key", &self.api_key)
                .header("anthropic-beta", "prompt-caching-2024-07-31");
        }

        let response = timeout(Duration::from_secs(30), request.json(&body).send())
            .await
            .map_err(|_| TiguError::Provider("connection timeout (30s)".into()))?
            .map_err(|e| TiguError::Provider(format!("request failed: {e}")))?;

        let status = response.status();

        // Non-2xx: read full JSON body and surface the API error.
        if !status.is_success() {
            // Save headers before consuming the response body.
            let retry_after = parse_retry_after(response.headers());

            let response_body: Value = response
                .json()
                .await
                .map_err(|e| TiguError::Provider(format!("failed to parse error response: {e}")))?;
            warn!(status = %status, body = %response_body, "API error response");
            let error_msg = response_body["error"]["message"]
                .as_str()
                .unwrap_or("unknown error");
            let error_type = response_body["error"]["type"]
                .as_str()
                .unwrap_or("unknown");

            match status.as_u16() {
                429 => {
                    // Respect retry-after header: sleep before returning so the
                    // caller (backon) doesn't retry too soon.
                    if let Some(wait) = retry_after {
                        warn!(wait_secs = wait.as_secs(), "rate limited — sleeping retry-after");
                        sleep(wait).await;
                    } else {
                        warn!("rate limited by Anthropic API");
                    }
                    return Err(TiguError::Provider(format!("rate limited: {error_msg}")));
                }
                529 => {
                    warn!("Anthropic API overloaded");
                    return Err(TiguError::Provider(format!("overloaded: {error_msg}")));
                }
                _ => {
                    return Err(TiguError::Provider(format!(
                        "API error ({status}, {error_type}): {error_msg}"
                    )));
                }
            }
        }

        // --- SSE streaming with per-chunk 30s timeout ---
        //
        // The reqwest client already has a 120s total timeout as a fallback.
        // The per-chunk timeout fires if no new bytes arrive within 30s,
        // catching hanging connections that bypass the total timeout.
        let byte_stream = response.bytes_stream();
        tokio::pin!(byte_stream);

        let mut line_buf: Vec<u8> = Vec::new();
        let mut text = String::new();
        let mut tool_calls: Vec<ToolCall> = Vec::new();
        let mut tool_input_bufs: HashMap<usize, (String, String, String)> = HashMap::new();
        let mut usage = Usage {
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
        };

        'stream: loop {
            match timeout(Duration::from_secs(30), byte_stream.next()).await {
                Ok(Some(Ok(chunk))) => {
                    for &byte in chunk.iter() {
                        if byte == b'\n' {
                            let line = String::from_utf8_lossy(&line_buf).into_owned();
                            line_buf.clear();

                            if let Some(data) = line.strip_prefix("data: ") {
                                if data == "[DONE]" {
                                    break 'stream;
                                }
                                if let Ok(event) = serde_json::from_str::<Value>(data) {
                                    match event["type"].as_str() {
                                        Some("message_start") => {
                                            let u = &event["message"]["usage"];
                                            usage.input_tokens =
                                                u["input_tokens"].as_u64().unwrap_or(0) as u32;
                                            usage.cache_read_tokens =
                                                u["cache_read_input_tokens"].as_u64().unwrap_or(0)
                                                    as u32;
                                            usage.cache_write_tokens =
                                                u["cache_creation_input_tokens"]
                                                    .as_u64()
                                                    .unwrap_or(0) as u32;
                                        }
                                        Some("content_block_start") => {
                                            let idx =
                                                event["index"].as_u64().unwrap_or(0) as usize;
                                            let block = &event["content_block"];
                                            if block["type"].as_str() == Some("tool_use") {
                                                let id = block["id"]
                                                    .as_str()
                                                    .unwrap_or("unknown")
                                                    .to_string();
                                                let raw_name =
                                                    block["name"].as_str().unwrap_or("unknown");
                                                let name = if self.use_oauth {
                                                    oauth::from_claude_code_name(raw_name)
                                                        .to_string()
                                                } else {
                                                    raw_name.to_string()
                                                };
                                                tool_input_bufs
                                                    .insert(idx, (id, name, String::new()));
                                            }
                                        }
                                        Some("content_block_delta") => {
                                            let idx =
                                                event["index"].as_u64().unwrap_or(0) as usize;
                                            let delta = &event["delta"];
                                            match delta["type"].as_str() {
                                                Some("text_delta") => {
                                                    if let Some(t) = delta["text"].as_str() {
                                                        text.push_str(t);
                                                    }
                                                }
                                                Some("input_json_delta") => {
                                                    if let Some(partial) =
                                                        delta["partial_json"].as_str()
                                                    {
                                                        if let Some(buf) =
                                                            tool_input_bufs.get_mut(&idx)
                                                        {
                                                            buf.2.push_str(partial);
                                                        }
                                                    }
                                                }
                                                _ => {}
                                            }
                                        }
                                        Some("content_block_stop") => {
                                            let idx =
                                                event["index"].as_u64().unwrap_or(0) as usize;
                                            if let Some((id, name, json_str)) =
                                                tool_input_bufs.remove(&idx)
                                            {
                                                let args = serde_json::from_str::<
                                                    serde_json::Map<String, Value>,
                                                >(&json_str)
                                                .map(|m| m.into_iter().collect())
                                                .unwrap_or_default();
                                                tool_calls.push(ToolCall { id, name, args });
                                            }
                                        }
                                        Some("message_delta") => {
                                            let u = &event["usage"];
                                            usage.output_tokens =
                                                u["output_tokens"].as_u64().unwrap_or(0) as u32;
                                        }
                                        Some("message_stop") => {
                                            break 'stream;
                                        }
                                        Some("error") => {
                                            let err_msg = event["error"]["message"]
                                                .as_str()
                                                .unwrap_or("stream error");
                                            return Err(TiguError::Provider(format!(
                                                "SSE error: {err_msg}"
                                            )));
                                        }
                                        _ => {}
                                    }
                                }
                            }
                        } else if byte != b'\r' {
                            line_buf.push(byte);
                        }
                    }
                }
                Ok(Some(Err(e))) => {
                    return Err(TiguError::Provider(format!("stream read error: {e}")));
                }
                Ok(None) => break,
                Err(_elapsed) => {
                    warn!("streaming chunk timeout (30s) — aborting request");
                    return Err(TiguError::Provider(
                        "LLM 스트리밍 타임아웃: 30초간 응답 없음".into(),
                    ));
                }
            }
        }

        let chat_response = ChatResponse {
            text,
            tool_calls,
            usage,
        };
        debug!(
            text_len = chat_response.text.len(),
            tool_calls = chat_response.tool_calls.len(),
            input_tokens = chat_response.usage.input_tokens,
            output_tokens = chat_response.usage.output_tokens,
            "received chat response"
        );

        Ok(chat_response)
    }
}

#[async_trait]
impl Provider for AnthropicProvider {
    fn name(&self) -> &str {
        &self.model
    }

    fn clone_fresh(&self) -> std::sync::Arc<dyn Provider> {
        std::sync::Arc::new(self.clone_fresh_internal())
    }

    async fn chat(
        &self,
        messages: &[ChatMessage],
        tools: &[ToolDefinition],
    ) -> Result<ChatResponse> {
        // --- Circuit breaker check ---
        if let Some(remaining) = self.circuit_breaker.check() {
            let secs = remaining.as_secs().max(1);
            warn!(secs, "circuit breaker open — rejecting request");
            return Err(TiguError::Provider(format!(
                "Circuit breaker open — API 연결 불안정, {secs}초 후 재시도"
            )));
        }

        let (system, api_messages) = Self::convert_messages(messages);
        let api_tools = Self::convert_tools(tools, self.use_oauth);

        let effective_max_tokens = self.max_tokens;

        // --- Retry with exponential backoff ---
        let backoff = ExponentialBuilder::default()
            .with_min_delay(Duration::from_millis(300))
            .with_max_delay(Duration::from_secs(30))
            .with_max_times(3)
            .with_jitter();

        let result = (|| async {
            self.do_request(&system, &api_messages, &api_tools, effective_max_tokens)
                .await
        })
        .retry(backoff)
        .when(|e| is_retryable(e))
        .notify(|err, dur| {
            warn!(error = %err, delay_ms = dur.as_millis(), "LLM API retry");
        })
        .await;

        // --- Circuit breaker bookkeeping ---
        match result {
            Ok(r) => {
                self.circuit_breaker.record_success();
                Ok(r)
            }
            Err(e) => {
                self.circuit_breaker.record_failure();
                Err(e)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_thinking_mode_adaptive_body() {
        let provider = AnthropicProvider::with_thinking(
            "key".into(),
            "claude-sonnet-4".into(),
            4096,
            ThinkingMode::Adaptive,
            Some("high".into()),
        );
        assert_eq!(provider.thinking_mode(), ThinkingMode::Adaptive);
    }

    #[test]
    fn test_thinking_mode_off_by_default() {
        let provider = AnthropicProvider::new("key".into(), "claude-haiku-4".into(), 4096);
        assert_eq!(provider.thinking_mode(), ThinkingMode::Off);
    }

    #[test]
    fn test_parse_response_with_thinking_block() {
        let body = json!({
            "content": [
                {"type": "thinking", "thinking": "Let me consider..."},
                {"type": "text", "text": "The answer is 42."}
            ],
            "usage": {
                "input_tokens": 100,
                "output_tokens": 50,
                "cache_read_input_tokens": 80,
                "cache_creation_input_tokens": 20
            }
        });

        let resp = AnthropicProvider::parse_response(&body, false).unwrap();
        assert_eq!(resp.text, "The answer is 42.");
        assert!(resp.tool_calls.is_empty());
        assert_eq!(resp.usage.input_tokens, 100);
        assert_eq!(resp.usage.output_tokens, 50);
        assert_eq!(resp.usage.cache_read_tokens, 80);
        assert_eq!(resp.usage.cache_write_tokens, 20);
    }

    #[test]
    fn test_convert_simple_messages() {
        let messages = vec![
            ChatMessage::system("You are helpful."),
            ChatMessage::user("Hello"),
            ChatMessage::assistant("Hi there!"),
        ];

        let (system, api_msgs) = AnthropicProvider::convert_messages(&messages);
        assert_eq!(system, "You are helpful.");
        assert_eq!(api_msgs.len(), 2);
        assert_eq!(api_msgs[0]["role"], "user");
        assert_eq!(api_msgs[1]["role"], "assistant");
    }

    #[test]
    fn test_convert_tool_messages() {
        let messages = vec![
            ChatMessage::user("run ls"),
            ChatMessage::assistant_with_tools(
                "Let me check.",
                vec![ToolCall {
                    id: "tc_1".into(),
                    name: "shell".into(),
                    args: [("command".into(), json!("ls"))].into(),
                }],
            ),
            ChatMessage::tool_result("tc_1", "file1\nfile2"),
        ];

        let (_, api_msgs) = AnthropicProvider::convert_messages(&messages);
        assert_eq!(api_msgs.len(), 3);

        let assistant_content = api_msgs[1]["content"].as_array().unwrap();
        assert_eq!(assistant_content.len(), 2);
        assert_eq!(assistant_content[0]["type"], "text");
        assert_eq!(assistant_content[1]["type"], "tool_use");

        assert_eq!(api_msgs[2]["role"], "user");
        let tool_content = api_msgs[2]["content"].as_array().unwrap();
        assert_eq!(tool_content[0]["type"], "tool_result");
        assert_eq!(tool_content[0]["tool_use_id"], "tc_1");
    }

    #[test]
    fn test_parse_text_response() {
        let body = json!({
            "content": [
                {"type": "text", "text": "Hello world"}
            ],
            "usage": {"input_tokens": 10, "output_tokens": 5}
        });

        let resp = AnthropicProvider::parse_response(&body, false).unwrap();
        assert_eq!(resp.text, "Hello world");
        assert!(resp.tool_calls.is_empty());
        assert_eq!(resp.usage.input_tokens, 10);
    }

    #[test]
    fn test_parse_tool_response() {
        let body = json!({
            "content": [
                {"type": "text", "text": "Let me check."},
                {
                    "type": "tool_use",
                    "id": "toolu_123",
                    "name": "shell",
                    "input": {"command": "ls -la"}
                }
            ],
            "usage": {"input_tokens": 20, "output_tokens": 30}
        });

        let resp = AnthropicProvider::parse_response(&body, false).unwrap();
        assert_eq!(resp.text, "Let me check.");
        assert_eq!(resp.tool_calls.len(), 1);
        assert_eq!(resp.tool_calls[0].name, "shell");
        assert_eq!(resp.tool_calls[0].args["command"], "ls -la");
    }

    #[test]
    fn test_parse_tool_response_oauth_remaps_names() {
        let body = json!({
            "content": [
                {
                    "type": "tool_use",
                    "id": "toolu_456",
                    "name": "Bash",
                    "input": {"command": "ls"}
                }
            ],
            "usage": {"input_tokens": 10, "output_tokens": 5}
        });

        let resp = AnthropicProvider::parse_response(&body, true).unwrap();
        assert_eq!(resp.tool_calls[0].name, "shell");
    }

    #[test]
    fn test_convert_tools_oauth_remaps_names() {
        let tools = vec![ToolDefinition {
            name: "shell".into(),
            description: "Run a command".into(),
            input_schema: json!({"type": "object"}),
        }];

        let result = AnthropicProvider::convert_tools(&tools, true);
        assert_eq!(result[0]["name"], "Bash");

        let result_no_oauth = AnthropicProvider::convert_tools(&tools, false);
        assert_eq!(result_no_oauth[0]["name"], "shell");
    }
}
