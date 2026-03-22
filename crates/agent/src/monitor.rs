//! Phase 8-2: 모니터링 채널 — 에이전트 이벤트를 텔레그램 채널에 실시간 기록.
//! Phase 9-1: 대시보드 broadcast event_tx 연동.

use std::sync::Arc;

use tokio::sync::broadcast;
use tracing::warn;

use tiguclaw_core::channel::Channel;
use tiguclaw_core::config::MonitorConfig;
use tiguclaw_core::event::{AgentStatusInfo, DashboardEvent};

/// 에이전트 이벤트 모니터.
///
/// `enabled = false`이면 모든 메서드가 즉시 반환된다 (완전 bypass).
pub struct Monitor {
    config: MonitorConfig,
    channel: Arc<dyn Channel>,
    /// Phase 9-1: 대시보드 broadcast sender (None이면 비활성화).
    event_tx: Option<broadcast::Sender<DashboardEvent>>,
}

impl Monitor {
    /// 새 Monitor 생성.
    pub fn new(config: MonitorConfig, channel: Arc<dyn Channel>) -> Self {
        Self {
            config,
            channel,
            event_tx: None,
        }
    }

    /// Phase 9-1: 대시보드 broadcast sender 설정 (빌더 패턴).
    pub fn with_event_tx(mut self, tx: Option<broadcast::Sender<DashboardEvent>>) -> Self {
        self.event_tx = tx;
        self
    }

    /// 에이전트간 통신 이벤트 기록.
    ///
    /// 포맷: `[from → to] message` (message는 50자 truncate)
    pub async fn log_agent_comm(&self, from: &str, to: &str, message: &str) {
        if !self.config.enabled || !self.config.log_agent_comms {
            return;
        }
        let truncated = truncate(message, 50);
        let text = format!("[{from} → {to}] {truncated}");
        self.send(&text).await;

        // Phase 9-1: 대시보드 이벤트 broadcast.
        if let Some(ref tx) = self.event_tx {
            let event = DashboardEvent::AgentComm {
                from: from.to_string(),
                to: to.to_string(),
                message: truncated,
            };
            let _ = tx.send(event);
        }
    }

    /// spawn 이벤트 기록.
    pub async fn log_spawn(&self, name: &str, tier: u8) {
        if !self.config.enabled || !self.config.log_spawns {
            return;
        }
        let text = format!("🟢 spawn: {name} (T{tier})");
        self.send(&text).await;

        // Phase 9-1: 대시보드 이벤트 broadcast.
        if let Some(ref tx) = self.event_tx {
            let event = DashboardEvent::AgentSpawned {
                name: name.to_string(),
                tier,
            };
            let _ = tx.send(event);
        }
    }

    /// kill 이벤트 기록.
    pub async fn log_kill(&self, name: &str) {
        if !self.config.enabled || !self.config.log_spawns {
            return;
        }
        let text = format!("🔴 kill: {name}");
        self.send(&text).await;

        // Phase 9-1: 대시보드 이벤트 broadcast.
        if let Some(ref tx) = self.event_tx {
            let event = DashboardEvent::AgentKilled {
                name: name.to_string(),
            };
            let _ = tx.send(event);
        }
    }

    /// Phase 9-1: AgentStatus 스냅샷 broadcast.
    pub fn broadcast_agent_status(&self, agents: Vec<AgentStatusInfo>) {
        if let Some(ref tx) = self.event_tx {
            let event = DashboardEvent::AgentStatus { agents };
            let _ = tx.send(event);
        }
    }

    /// Phase 9-1: event_tx가 설정되어 있는지 확인.
    pub fn has_event_tx(&self) -> bool {
        self.event_tx.is_some()
    }

    /// 모니터링 채널로 텍스트 전송.
    async fn send(&self, text: &str) {
        if self.config.telegram_chat_id.is_empty() {
            return;
        }
        if let Err(e) = self.channel.send(&self.config.telegram_chat_id, text).await {
            warn!(error = %e, "monitor: 모니터링 채널 전송 실패 (무시)");
        }
    }
}

/// 문자열을 최대 `max_chars`자로 truncate. 초과 시 '…' 추가.
fn truncate(s: &str, max_chars: usize) -> String {
    let chars: Vec<char> = s.chars().collect();
    if chars.len() <= max_chars {
        s.to_string()
    } else {
        let truncated: String = chars[..max_chars].iter().collect();
        format!("{truncated}…")
    }
}

#[cfg(test)]
mod tests {
    use super::truncate;

    #[test]
    fn test_truncate_short() {
        assert_eq!(truncate("hello", 50), "hello");
    }

    #[test]
    fn test_truncate_long() {
        let s = "a".repeat(60);
        let result = truncate(&s, 50);
        assert_eq!(result.chars().count(), 51); // 50 + '…'
    }
}
