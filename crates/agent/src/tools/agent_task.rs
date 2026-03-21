//! 에이전트 태스크 툴 — send_to_agent, kill_agent, list_agents.

use async_trait::async_trait;
use serde_json::json;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

use tokio::sync::oneshot;
use tracing::debug;

use tiguclaw_core::error::{Result, TiguError};
use tiguclaw_core::tool::Tool;

use crate::registry::{AgentRegistry, AgentTask};

// ---------------------------------------------------------------------------
// send_to_agent
// ---------------------------------------------------------------------------

/// 에이전트에 태스크를 전달하고 응답을 기다리는 툴.
///
/// hooks_url이 설정된 에이전트는 직통 HTTP POST로 전달하고,
/// 없으면 기존 내부 mpsc 방식으로 전달한다.
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
        "spawn된 하위 에이전트에 태스크를 전달하고 결과를 받습니다. \
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

        // Phase 8-2: hooks_url이 있으면 직통 HTTP 전송, 없으면 기존 IPC 방식.
        if let Some(hooks_url) = send_info.hooks_url {
            debug!(
                from = %self.from_name,
                to = %name,
                url = %hooks_url,
                "send_to_agent: 직통 HTTP 전송"
            );
            let client = reqwest::Client::new();
            let mut req_builder = client
                .post(format!("{hooks_url}/hooks/agent"))
                .timeout(std::time::Duration::from_secs(120))
                .json(&serde_json::json!({
                    "message": message,
                    "deliver": false,
                    "timeout_seconds": 110
                }));

            if let Some(token) = send_info.hooks_token {
                req_builder = req_builder.header("Authorization", format!("Bearer {token}"));
            }

            let http_resp = req_builder.send().await.map_err(|e| {
                TiguError::Tool(format!("에이전트 '{name}' 직통 HTTP 전송 실패: {e}"))
            })?;

            let status = http_resp.status();
            let body: serde_json::Value = http_resp.json().await.map_err(|e| {
                TiguError::Tool(format!("에이전트 '{name}' 응답 파싱 실패: {e}"))
            })?;

            if !status.is_success() {
                let err_msg = body["error"].as_str().unwrap_or("unknown error");
                return Err(TiguError::Tool(format!(
                    "에이전트 '{name}' HTTP 오류 {status}: {err_msg}"
                )));
            }

            let response_text = body["message"].as_str().unwrap_or("").to_string();
            Ok(format!("[{name}] {response_text}"))
        } else {
            // 기존 내부 mpsc 방식.
            let (reply_tx, reply_rx) = oneshot::channel();
            send_info
                .task_tx
                .send(AgentTask {
                    message,
                    reply_tx,
                })
                .await
                .map_err(|_| {
                    TiguError::Tool(format!(
                        "에이전트 '{name}' 채널이 닫혔습니다. 종료되었을 수 있습니다."
                    ))
                })?;

            // lock 없이 응답 대기 — deadlock 없음.
            let response = reply_rx.await.map_err(|_| {
                TiguError::Tool(format!(
                    "에이전트 '{name}' 응답 수신 실패 (에이전트가 패닉했을 수 있음)"
                ))
            })?;

            Ok(format!("[{name}] {response}"))
        }
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
                "  • {} (L{}, {}, {})",
                info.name, info.level, persistent_label, info.channel_type
            ));
        }
        Ok(lines.join("\n"))
    }
}
