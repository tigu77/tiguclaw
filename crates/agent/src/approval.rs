//! Approval manager — enforces SecurityPolicy before tool execution.
//!
//! Three levels:
//! - Auto    → execute immediately
//! - Notify  → execute immediately + send Telegram notification (FYI)
//! - Require → send approval request to Telegram, wait for /approve or /deny

use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::Mutex;

use tokio::sync::oneshot;
use tokio::time;
use tracing::{info, warn};
use uuid::Uuid;

use tiguclaw_core::channel::Channel;
use tiguclaw_core::security::{ApprovalLevel, SecurityPolicy};

/// Manages tool approval workflow based on SecurityPolicy.
pub struct ApprovalManager {
    policy: SecurityPolicy,
    channel: Arc<dyn Channel>,
    chat_id: String,
    /// approval_id → oneshot sender waiting for admin response.
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<bool>>>>,
}

impl ApprovalManager {
    pub fn new(policy: SecurityPolicy, channel: Arc<dyn Channel>, chat_id: String) -> Self {
        Self {
            policy,
            channel,
            chat_id,
            pending: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Check policy before executing a tool.
    ///
    /// Returns:
    /// - `Ok(true)`  — proceed with execution
    /// - `Ok(false)` — denied (require level, admin said no)
    /// - `Err(_)`    — timed out or channel error → treat as denial
    pub async fn check(&self, tool_name: &str, args_summary: &str) -> anyhow::Result<bool> {
        // Bypass everything when policy is disabled.
        if !self.policy.enabled {
            return Ok(true);
        }

        let level = self.policy.level_for(tool_name);

        match level {
            ApprovalLevel::Auto => Ok(true),

            ApprovalLevel::Notify => {
                // Execute immediately, but let admin know.
                let msg = format!(
                    "📋 *\\[알림\\]* `{}` 실행됨\n`{}`",
                    tool_name,
                    truncate(args_summary, 300)
                );
                let _ = self.channel.send(&self.chat_id, &msg).await;
                Ok(true)
            }

            ApprovalLevel::Require => {
                // Generate short unique ID for this approval request.
                let approval_id = Uuid::new_v4()
                    .to_string()
                    .split('-')
                    .next()
                    .unwrap_or("req")
                    .to_string();

                let (tx, rx) = oneshot::channel();

                // Register sender before sending the telegram message.
                self.pending.lock().await.insert(approval_id.clone(), tx);

                let msg = format!(
                    "⚠️ *\\[승인 요청\\]* `{}` 실행 대기 중\n`{}`\n\n✅ 승인: `/approve {}`\n🚫 거부: `/deny {}`\n⏱ {}초 내 응답 없으면 자동 거부",
                    tool_name,
                    truncate(args_summary, 300),
                    approval_id,
                    approval_id,
                    self.policy.require_timeout_secs
                );

                if let Err(e) = self.channel.send(&self.chat_id, &msg).await {
                    // Clean up and fail.
                    self.pending.lock().await.remove(&approval_id);
                    return Err(anyhow::anyhow!("failed to send approval request: {e}"));
                }

                info!(
                    tool = tool_name,
                    approval_id = %approval_id,
                    timeout_secs = self.policy.require_timeout_secs,
                    "waiting for approval"
                );

                let timeout_dur = time::Duration::from_secs(self.policy.require_timeout_secs);
                match time::timeout(timeout_dur, rx).await {
                    Ok(Ok(approved)) => {
                        info!(tool = tool_name, approved, "approval response received");
                        Ok(approved)
                    }
                    Ok(Err(_)) => {
                        // Sender was dropped (unlikely).
                        warn!(tool = tool_name, "approval oneshot channel dropped");
                        Err(anyhow::anyhow!("approval channel dropped unexpectedly"))
                    }
                    Err(_timeout) => {
                        // Timed out — remove stale entry and auto-deny.
                        self.pending.lock().await.remove(&approval_id);
                        warn!(
                            tool = tool_name,
                            approval_id = %approval_id,
                            "approval timed out — auto-denying"
                        );
                        let _ = self
                            .channel
                            .send(
                                &self.chat_id,
                                &format!("⏱ `{}` 승인 타임아웃 — 자동 거부됨", tool_name),
                            )
                            .await;
                        Err(anyhow::anyhow!("approval timed out"))
                    }
                }
            }
        }
    }

    /// Dispatch an admin's /approve or /deny response.
    ///
    /// Called from the main loop when an admin sends `/approve <id>` or `/deny <id>`.
    pub async fn handle_approval_response(&self, approval_id: &str, approved: bool) {
        let sender = self.pending.lock().await.remove(approval_id);

        match sender {
            Some(tx) => {
                let _ = tx.send(approved);
                info!(approval_id, approved, "approval response dispatched");
            }
            None => {
                warn!(approval_id, "no pending approval found for id (may have timed out)");
            }
        }
    }
}

/// Truncate a string to at most `max_chars` characters.
fn truncate(s: &str, max_chars: usize) -> &str {
    if s.len() <= max_chars {
        return s;
    }
    // Find a safe UTF-8 boundary.
    let mut end = max_chars;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}
