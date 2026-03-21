//! Core types shared across all crates.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Role in a chat conversation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    System,
    User,
    Assistant,
    /// Tool result fed back to the model.
    Tool,
}

/// A single message in a chat conversation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: Role,
    pub content: String,
    /// Present when role == Tool; the id of the tool call this responds to.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    /// Present when role == Assistant and the model requested tool calls.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<ToolCall>,
}

impl ChatMessage {
    pub fn system(content: impl Into<String>) -> Self {
        Self {
            role: Role::System,
            content: content.into(),
            tool_call_id: None,
            tool_calls: Vec::new(),
        }
    }

    pub fn user(content: impl Into<String>) -> Self {
        Self {
            role: Role::User,
            content: content.into(),
            tool_call_id: None,
            tool_calls: Vec::new(),
        }
    }

    pub fn assistant(content: impl Into<String>) -> Self {
        Self {
            role: Role::Assistant,
            content: content.into(),
            tool_call_id: None,
            tool_calls: Vec::new(),
        }
    }

    /// Assistant message that includes tool invocation requests.
    pub fn assistant_with_tools(
        content: impl Into<String>,
        tool_calls: Vec<ToolCall>,
    ) -> Self {
        Self {
            role: Role::Assistant,
            content: content.into(),
            tool_call_id: None,
            tool_calls,
        }
    }

    pub fn tool_result(tool_call_id: impl Into<String>, content: impl Into<String>) -> Self {
        Self {
            role: Role::Tool,
            content: content.into(),
            tool_call_id: Some(tool_call_id.into()),
            tool_calls: Vec::new(),
        }
    }
}

/// A tool invocation requested by the model.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    /// Unique id for this call (used to match tool results).
    pub id: String,
    /// Tool name.
    pub name: String,
    /// JSON arguments.
    pub args: HashMap<String, serde_json::Value>,
}

/// Token usage information.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Usage {
    pub input_tokens: u32,
    pub output_tokens: u32,
    #[serde(default)]
    pub cache_read_tokens: u32,
    #[serde(default)]
    pub cache_write_tokens: u32,
}

/// Response from a provider chat call.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatResponse {
    /// Text content (may be empty if only tool calls).
    pub text: String,
    /// Tool calls requested by the model.
    pub tool_calls: Vec<ToolCall>,
    /// Token usage.
    pub usage: Usage,
}

/// An inbound message from a channel (e.g. Telegram).
#[derive(Debug, Clone)]
pub struct ChannelMessage {
    /// Channel-specific message id.
    pub id: String,
    /// Sender identifier (e.g. chat_id).
    pub sender: String,
    /// Message text content.
    pub content: String,
    /// Unix timestamp in seconds.
    pub timestamp: i64,
}
