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
}
