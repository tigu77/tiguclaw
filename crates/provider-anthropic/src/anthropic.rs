//! AnthropicProvider — Provider trait implementation using Anthropic Messages API.
//!
//! Uses non-streaming requests for simplicity in Phase 1.
//! Handles tool_use / tool_result message conversion between core types
//! and the Anthropic API format.

use async_trait::async_trait;
use reqwest::Client;
use serde_json::{json, Value};
use tracing::{debug, warn};

use tiguclaw_core::error::{Result, TiguError};
use tiguclaw_core::provider::{Provider, ToolDefinition};
use tiguclaw_core::types::*;

use crate::oauth;

const API_URL: &str = "https://api.anthropic.com/v1/messages";
const API_VERSION: &str = "2023-06-01";

/// Minimum max_tokens required for adaptive thinking.
const ADAPTIVE_MIN_MAX_TOKENS: u32 = 16384;

/// Thinking mode for Anthropic adaptive thinking.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThinkingMode {
    /// No thinking — standard request.
    Off,
    /// Adaptive thinking — model decides when to think.
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
}

impl AnthropicProvider {
    pub fn new(api_key: String, model: String, max_tokens: u32) -> Self {
        let use_oauth = api_key.starts_with("sk-ant-oat");
        Self {
            client: Client::new(),
            api_key,
            model,
            max_tokens,
            use_oauth,
            thinking: ThinkingMode::Off,
            effort: None,
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
        Self {
            client: Client::new(),
            api_key,
            model,
            max_tokens,
            use_oauth,
            thinking,
            effort,
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
}

#[async_trait]
impl Provider for AnthropicProvider {
    fn name(&self) -> &str {
        &self.model
    }

    async fn chat(
        &self,
        messages: &[ChatMessage],
        tools: &[ToolDefinition],
    ) -> Result<ChatResponse> {
        let (system, api_messages) = Self::convert_messages(messages);
        let api_tools = Self::convert_tools(tools, self.use_oauth);

        // Adaptive thinking requires max_tokens >= 16384.
        let effective_max_tokens = if self.thinking == ThinkingMode::Adaptive {
            self.max_tokens.max(ADAPTIVE_MIN_MAX_TOKENS)
        } else {
            self.max_tokens
        };

        let mut body = json!({
            "model": self.model,
            "max_tokens": effective_max_tokens,
            "messages": api_messages,
        });

        // Add adaptive thinking configuration.
        if self.thinking == ThinkingMode::Adaptive {
            body["thinking"] = json!({"type": "adaptive"});
            if let Some(ref effort) = self.effort {
                body["output_config"] = json!({"effort": effort});
            }
        }

        // System prompt: OAuth requires array format with Claude Code identity first.
        // In both modes, add cache_control to the last system block to enable prompt caching.
        if self.use_oauth {
            let mut system_blocks = vec![json!({
                "type": "text",
                "text": oauth::CLAUDE_CODE_IDENTITY,
            })];
            if !system.is_empty() {
                // Attach cache_control to the user system prompt (last block).
                system_blocks.push(json!({
                    "type": "text",
                    "text": system,
                    "cache_control": {"type": "ephemeral"},
                }));
            } else {
                // No user system prompt — cache the identity block.
                system_blocks[0]["cache_control"] = json!({"type": "ephemeral"});
            }
            body["system"] = json!(system_blocks);
        } else if !system.is_empty() {
            // Array format required for cache_control blocks.
            body["system"] = json!([{
                "type": "text",
                "text": system,
                "cache_control": {"type": "ephemeral"},
            }]);
        }

        if !api_tools.is_empty() {
            body["tools"] = Value::Array(api_tools);
        }

        debug!(model = %self.model, msg_count = messages.len(), request_body = %body, "sending chat request");

        let mut request = self
            .client
            .post(API_URL)
            .header("anthropic-version", API_VERSION)
            .header("content-type", "application/json");

        if self.use_oauth {
            // Combine OAuth beta features with prompt caching.
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

        let response = request
            .json(&body)
            .send()
            .await
            .map_err(|e| TiguError::Provider(format!("request failed: {e}")))?;

        let status = response.status();
        let response_body: Value = response
            .json()
            .await
            .map_err(|e| TiguError::Provider(format!("failed to parse response: {e}")))?;

        if !status.is_success() {
            warn!(body = %response_body, "API error response body");
            let error_msg = response_body["error"]["message"]
                .as_str()
                .unwrap_or("unknown error");
            let error_type = response_body["error"]["type"]
                .as_str()
                .unwrap_or("unknown");

            // Handle specific error types.
            match status.as_u16() {
                429 => {
                    warn!("rate limited by Anthropic API");
                    return Err(TiguError::Provider(format!(
                        "rate limited: {error_msg}"
                    )));
                }
                529 => {
                    warn!("Anthropic API overloaded");
                    return Err(TiguError::Provider(format!(
                        "overloaded: {error_msg}"
                    )));
                }
                _ => {
                    return Err(TiguError::Provider(format!(
                        "API error ({status}, {error_type}): {error_msg}"
                    )));
                }
            }
        }

        let chat_response = Self::parse_response(&response_body, self.use_oauth)?;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_thinking_mode_adaptive_body() {
        // Verify that with_thinking creates a provider with the right mode.
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
        // Adaptive thinking responses may include "thinking" content blocks.
        // They should be skipped (only "text" extracted).
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

        // Assistant message should have content array with text + tool_use.
        let assistant_content = api_msgs[1]["content"].as_array().unwrap();
        assert_eq!(assistant_content.len(), 2);
        assert_eq!(assistant_content[0]["type"], "text");
        assert_eq!(assistant_content[1]["type"], "tool_use");

        // Tool result should be a user message with tool_result content.
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
