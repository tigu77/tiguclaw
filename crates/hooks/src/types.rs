//! Request/response types for the Hooks HTTP API.

use serde::{Deserialize, Serialize};
use tiguclaw_core::escalation::EscalationReport;
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

/// POST /hooks/steer payload — 에이전트 방향 전환 신호.
#[derive(Debug, Clone, Deserialize)]
pub struct SteerPayload {
    /// 에이전트에게 전달할 방향 전환 메시지.
    pub message: String,
}

/// POST /hooks/report payload — T1 에이전트가 부모(T0)에게 완료 보고.
#[derive(Debug, Clone, Deserialize)]
pub struct ReportPayload {
    /// 보고하는 에이전트 이름.
    pub from: String,
    /// 보고 내용.
    pub message: String,
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
    /// Phase 9-4: 하위 에이전트로부터 에스컬레이션 수신.
    Escalation {
        report: EscalationReport,
    },
    /// Phase 9-4: 에이전트 방향 전환 신호 (steer).
    Steer {
        message: String,
    },
    /// T1 에이전트가 부모(T0)에게 작업 완료 보고.
    Report {
        from: String,
        message: String,
    },
}
