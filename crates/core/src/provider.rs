//! Provider trait — abstraction over LLM backends (e.g. Anthropic, OpenAI).

use async_trait::async_trait;
use crate::error::Result;
use crate::types::{ChatMessage, ChatResponse};

/// JSON schema describing a tool that the provider can invoke.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    /// JSON Schema for the tool's input parameters.
    pub input_schema: serde_json::Value,
}

/// Thinking level for a provider request.
///
/// Controls which model tier and thinking mode to use:
/// - `Normal`: 기본 모델 (tier1 / normal_models), 빠르고 저렴
/// - `Deep`: 고급 모델 (deep_models) + adaptive thinking 활성화
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ThinkingLevel {
    /// 기본 모드 — normal_models (tier1) 사용, thinking off.
    #[default]
    Normal,
    /// 깊은 사고 모드 — deep_models (tier2) + adaptive thinking 활성화.
    Deep,
}

/// An LLM provider that can generate chat completions.
#[async_trait]
pub trait Provider: Send + Sync {
    /// Human-readable provider name.
    fn name(&self) -> &str;

    /// Send a chat request and get a response (may include tool calls).
    async fn chat(
        &self,
        messages: &[ChatMessage],
        tools: &[ToolDefinition],
    ) -> Result<ChatResponse>;

    /// Send a chat request with explicit thinking level control.
    ///
    /// Default implementation falls back to `chat()` (Normal mode).
    /// Override to support `ThinkingLevel::Deep`.
    async fn chat_with_options(
        &self,
        messages: &[ChatMessage],
        tools: &[ToolDefinition],
        thinking: ThinkingLevel,
    ) -> Result<ChatResponse> {
        let _ = thinking; // base impl ignores thinking level
        self.chat(messages, tools).await
    }
}
