//! 에이전트 태스크 툴 — send_to_agent, kill_agent, list_agents.

use async_trait::async_trait;
use serde_json::json;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

use tracing::{debug, info};

use tiguclaw_core::error::{Result, TiguError};
use tiguclaw_core::provider::ThinkingLevel;
use tiguclaw_core::tool::Tool;

use crate::registry::{AgentRegistry, AgentTask};

// ---------------------------------------------------------------------------
// send_to_agent
// ---------------------------------------------------------------------------

/// 에이전트에 태스크를 fire-and-forget으로 전달하는 툴.
///
/// L0 블로킹 방지: 즉시 "전달됨" 반환. 완료 시 L1이 report_to_parent로 보고한다.
/// hooks_url이 설정된 에이전트는 직통 HTTP POST로 전달하고,
/// 없으면 내부 mpsc 방식으로 전달한다.
///
/// # Input
/// ```json
/// { "name": "code-helper", "message": "이 함수 리팩토링 해줘: ..." }
/// ```
pub struct SendToAgentTool {
    registry: Arc<Mutex<AgentRegistry>>,
    /// 이 에이전트의 이름 — 모니터링 로그에서 from 필드로 사용.
    from_name: String,
}

impl SendToAgentTool {
    pub fn new(registry: Arc<Mutex<AgentRegistry>>) -> Self {
        Self {
            registry,
            from_name: "main".to_string(),
        }
    }

    /// 이 에이전트의 이름을 설정 (모니터링 로그 from 필드).
    pub fn with_from_name(mut self, name: impl Into<String>) -> Self {
        self.from_name = name.into();
        self
    }
}

#[async_trait]
impl Tool for SendToAgentTool {
    fn name(&self) -> &str {
        "send_to_agent"
    }

    fn description(&self) -> &str {
        "spawn된 하위 에이전트에 태스크를 전달합니다 (fire-and-forget). \
         즉시 '전달됨'을 반환하고 L0는 계속 응답 가능합니다. \
         에이전트 완료 시 report_to_parent로 보고가 돌아옵니다. \
         에이전트가 없으면 먼저 spawn_agent로 생성하세요."
    }

    fn schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "name": {
                    "type": "string",
                    "description": "태스크를 전달할 에이전트 이름."
                },
                "message": {
                    "type": "string",
                    "description": "에이전트에게 전달할 태스크 또는 메시지."
                },
                "deep_thinking": {
                    "type": "boolean",
                    "description": "true로 설정하면 에이전트가 깊은 사고(Deep) 모드로 처리합니다. 전략 수립, 설계, 복잡한 분석 등 고품질 판단이 필요할 때 사용하세요.",
                    "default": false
                }
            },
            "required": ["name", "message"]
        })
    }

    async fn execute(
        &self,
        args: &HashMap<String, serde_json::Value>,
    ) -> Result<String> {
        let name = args
            .get("name")
            .and_then(|v| v.as_str())
            .ok_or_else(|| TiguError::Tool("'name' 파라미터가 필요합니다".into()))?
            .to_string();

        let message = args
            .get("message")
            .and_then(|v| v.as_str())
            .ok_or_else(|| TiguError::Tool("'message' 파라미터가 필요합니다".into()))?
            .to_string();

        let thinking_level = if args
            .get("deep_thinking")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
        {
            ThinkingLevel::Deep
        } else {
            ThinkingLevel::Normal
        };

        // lock을 최소한으로 유지: send_info와 monitor를 꺼내고 즉시 해제.
        // lock을 잡은 채로 reply_rx.await하면 deadlock이 발생한다.
        let (send_info, monitor_opt) = {
            let registry = self.registry.lock().await;
            let info = registry.get_send_info(&name).ok_or_else(|| {
                TiguError::Tool(format!(
                    "에이전트 '{name}' 없음. list_agents로 목록 확인하세요."
                ))
            })?;
            let monitor = registry.monitor.clone();
            (info, monitor)
        }; // lock 해제

        // Phase 8-2: 모니터링 채널에 통신 이벤트 기록.
        if let Some(ref monitor) = monitor_opt {
            monitor.log_agent_comm(&self.from_name, &name, &message).await;
        }

        info!(
            from = %self.from_name,
            to = %name,
            deep = matches!(thinking_level, ThinkingLevel::Deep),
            "send_to_agent: 전달 시작"
        );

        // fire-and-forget: L0 블로킹 없이 즉시 반환.
        // hooks_url이 있으면 백그라운드 HTTP 전송, 없으면 IPC 채널로 전달 후 즉시 반환.
        if let Some(hooks_url) = send_info.hooks_url {
            // HTTP 경로: 백그라운드 태스크로 전송 (L0 블로킹 없음).
            let name_clone = name.clone();
            let token = send_info.hooks_token;
            let deep = matches!(thinking_level, ThinkingLevel::Deep);
            tokio::spawn(async move {
                debug!(
                    to = %name_clone,
                    url = %hooks_url,
                    deep,
                    "send_to_agent: 직통 HTTP fire-and-forget 전송"
                );
                let client = reqwest::Client::new();
                let mut req_builder = client
                    .post(format!("{hooks_url}/hooks/agent"))
                    .timeout(std::time::Duration::from_secs(300))
                    .json(&serde_json::json!({
                        "message": message,
                        "deliver": false,
                        "timeout_seconds": 290,
                        "deep_thinking": deep
                    }));
                if let Some(token) = token {
                    req_builder = req_builder.header("Authorization", format!("Bearer {token}"));
                }
                if let Err(e) = req_builder.send().await {
                    tracing::warn!(to = %name_clone, error = %e, "send_to_agent: HTTP 전송 실패");
                }
            });
        } else {
            // IPC 경로: reply_tx = None (fire-and-forget).
            let send_result = send_info
                .task_tx
                .send(AgentTask {
                    message,
                    reply_tx: None,
                    thinking_level,
                })
                .await;

            if send_result.is_err() {
                // 채널 닫힘 감지: 비-KeepAlive 에이전트는 레지스트리에서 제거.
                // KeepAlive 에이전트는 keepalive_agent_loop가 직접 정리/재spawn을 담당한다.
                if !send_info.is_keepalive {
                    let reg = self.registry.clone();
                    let dead_name = name.clone();
                    tokio::spawn(async move {
                        let mut registry = reg.lock().await;
                        registry.remove_dead_agent(&dead_name);
                        tracing::info!(
                            name = %dead_name,
                            "send_to_agent: 채널 닫힘 — 레지스트리에서 죽은 에이전트 제거"
                        );
                    });
                }
                return Err(TiguError::Tool(format!(
                    "에이전트 '{name}' 채널이 닫혔습니다. 종료되었을 수 있습니다."
                )));
            }
        }

        Ok(format!("✅ {name}에게 전달됨. 완료 시 보고드릴게요."))
    }
}

// ---------------------------------------------------------------------------
// kill_agent
// ---------------------------------------------------------------------------

/// 에이전트를 종료하는 툴.
///
/// # Input
/// ```json
/// { "name": "code-helper" }
/// ```
pub struct KillAgentTool {
    registry: Arc<Mutex<AgentRegistry>>,
}

impl KillAgentTool {
    pub fn new(registry: Arc<Mutex<AgentRegistry>>) -> Self {
        Self { registry }
    }
}

#[async_trait]
impl Tool for KillAgentTool {
    fn name(&self) -> &str {
        "kill_agent"
    }

    fn description(&self) -> &str {
        "실행 중인 하위 에이전트를 종료합니다."
    }

    fn schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "name": {
                    "type": "string",
                    "description": "종료할 에이전트 이름."
                }
            },
            "required": ["name"]
        })
    }

    async fn execute(
        &self,
        args: &HashMap<String, serde_json::Value>,
    ) -> Result<String> {
        let name = args
            .get("name")
            .and_then(|v| v.as_str())
            .ok_or_else(|| TiguError::Tool("'name' 파라미터가 필요합니다".into()))?;

        let mut registry = self.registry.lock().await;
        if registry.kill_agent(name) {
            Ok(format!("🛑 에이전트 '{name}' 종료 완료"))
        } else {
            Err(TiguError::Tool(format!(
                "에이전트 '{name}' 없음. list_agents로 목록을 확인하세요."
            )))
        }
    }
}

// ---------------------------------------------------------------------------
// list_agents
// ---------------------------------------------------------------------------

/// 현재 실행 중인 에이전트 목록을 반환하는 툴.
///
/// # Input
/// ```json
/// {}
/// ```
pub struct ListAgentsTool {
    registry: Arc<Mutex<AgentRegistry>>,
}

impl ListAgentsTool {
    pub fn new(registry: Arc<Mutex<AgentRegistry>>) -> Self {
        Self { registry }
    }
}

#[async_trait]
impl Tool for ListAgentsTool {
    fn name(&self) -> &str {
        "list_agents"
    }

    fn description(&self) -> &str {
        "현재 실행 중인 모든 하위 에이전트 목록을 반환합니다."
    }

    fn schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {}
        })
    }

    async fn execute(
        &self,
        _args: &HashMap<String, serde_json::Value>,
    ) -> Result<String> {
        let registry = self.registry.lock().await;
        let agents = registry.list();

        if agents.is_empty() {
            return Ok("실행 중인 에이전트가 없습니다. spawn_agent로 생성하세요.".into());
        }

        let mut lines = vec!["🤖 실행 중인 에이전트:".to_string()];
        for info in &agents {
            let persistent_label = if info.persistent { "상주" } else { "임시" };
            lines.push(format!(
                "  • {} (T{}, {}, {})",
                info.name, info.tier, persistent_label, info.channel_type
            ));
        }
        Ok(lines.join("\n"))
    }
}
