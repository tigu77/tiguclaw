//! Security policy — tool-level approval control.
//!
//! Three approval levels:
//! - `auto`    — execute immediately (safe / read-only operations)
//! - `notify`  — execute immediately, send Telegram notification after
//! - `require` — wait for explicit approval from admin; auto-deny on timeout

use std::collections::HashMap;
use serde::Deserialize;

/// Approval level for a tool execution.
#[derive(Debug, Clone, Deserialize, PartialEq, Default)]
#[serde(rename_all = "lowercase")]
pub enum ApprovalLevel {
    #[default]
    Auto,
    Notify,
    Require,
}

/// Security policy configuration.
#[derive(Debug, Clone, Deserialize)]
pub struct SecurityPolicy {
    /// Whether the security policy is active. If false, all checks are bypassed.
    #[serde(default)]
    pub enabled: bool,

    /// Default approval level for tools not listed in `tool_levels`.
    #[serde(default)]
    pub default_level: ApprovalLevel,

    /// Per-tool approval level overrides.
    #[serde(default)]
    pub tool_levels: HashMap<String, ApprovalLevel>,

    /// Maximum number of concurrent agents (default: 10).
    #[serde(default = "default_max_agents")]
    pub max_agents: usize,

    /// Daily API cost limit in USD (default: 5.0).
    #[serde(default = "default_api_cost_limit")]
    pub api_cost_limit_usd: f64,

    /// Seconds to wait for approval before auto-denying (default: 60).
    #[serde(default = "default_require_timeout")]
    pub require_timeout_secs: u64,
}

fn default_max_agents() -> usize {
    10
}

fn default_api_cost_limit() -> f64 {
    5.0
}

fn default_require_timeout() -> u64 {
    60
}

impl Default for SecurityPolicy {
    fn default() -> Self {
        Self {
            enabled: false,
            default_level: ApprovalLevel::Auto,
            tool_levels: HashMap::new(),
            max_agents: 10,
            api_cost_limit_usd: 5.0,
            require_timeout_secs: 60,
        }
    }
}

impl SecurityPolicy {
    /// Return the approval level for a given tool name.
    /// Falls back to `default_level` if no specific override exists.
    pub fn level_for(&self, tool_name: &str) -> ApprovalLevel {
        self.tool_levels
            .get(tool_name)
            .cloned()
            .unwrap_or_else(|| self.default_level.clone())
    }
}
