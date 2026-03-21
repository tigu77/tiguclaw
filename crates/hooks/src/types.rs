//! Request/response types for the Hooks HTTP API.

use serde::{Deserialize, Serialize};
use tokio::sync::oneshot;

/// POST /hooks/wake payload.
#[derive(Debug, Clone, Deserialize)]
pub struct WakePayload {
    /// Human-readable description of the event.
    pub text: String,
    /// "now" = inject immediately, "next-heartbeat" = queue until next heartbeat tick.
    #[serde(default = "default_mode")]
    pub mode: WakeMode,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum WakeMode {
    Now,
    NextHeartbeat,
}

fn default_mode() -> WakeMode {
    WakeMode::Now
}

/// POST /hooks/agent payload.
#[derive(Debug, Clone, Deserialize)]
pub struct AgentPayload {
    /// Message content for the agent to process.
    pub message: String,
    /// Whether to deliver the agent response via the specified channel.
    #[serde(default)]
    pub deliver: bool,
    /// Delivery channel (default: "telegram").
    #[serde(default = "default_channel")]
    pub channel: String,
    /// Recipient chat_id (Telegram) or equivalent.
    #[serde(default)]
    pub to: String,
    /// Maximum seconds to wait for the agent to respond (default: 60).
    #[serde(default = "default_timeout")]
    pub timeout_seconds: u64,
}

fn default_channel() -> String {
    "telegram".to_string()
}

fn default_timeout() -> u64 {
    60
}

/// Standard success/error JSON response.
#[derive(Debug, Serialize)]
pub struct ApiResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl ApiResponse {
    pub fn ok() -> Self {
        Self { ok: true, message: None, error: None }
    }
    pub fn with_message(msg: impl Into<String>) -> Self {
        Self { ok: true, message: Some(msg.into()), error: None }
    }
    pub fn err(e: impl Into<String>) -> Self {
        Self { ok: false, message: None, error: Some(e.into()) }
    }
}

/// Events sent from HookServer to AgentLoop.
#[derive(Debug)]
pub enum HookEvent {
    /// Trigger a heartbeat immediately (or queue for next heartbeat).
    Wake {
        text: String,
        mode: WakeMode,
    },
    /// Ask the agent to process a message, optionally deliver to `to`.
    Agent {
        message: String,
        deliver: bool,
        to: String,
        /// Caller waits on this channel for the agent's response text.
        response_tx: oneshot::Sender<String>,
    },
}
