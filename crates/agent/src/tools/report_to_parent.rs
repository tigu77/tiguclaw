//! report_to_parent 툴 — L1 에이전트가 작업 완료 후 부모에게 보고한다.
//!
//! L0 비동기 위임 패턴의 완료 보고 담당:
//! - parent_hooks_url이 있으면 HTTP POST → /hooks/report
//! - 없으면 IPC를 통해 직접 주입 (registry 사용)
//!
//! 보고 메시지는 `[{agent_name}] {message}` 형태로 부모 inbox에 전달된다.

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use serde_json::json;
use tokio::sync::Mutex;

use tiguclaw_core::error::{Result, TiguError};
use tiguclaw_core::tool::Tool;

use crate::registry::AgentRegistry;

/// 부모 에이전트에게 완료 보고를 전송하는 툴.
///
/// # Input
/// ```json
/// { "message": "팀 구성 완료 — 5명 배치됨" }
/// ```
pub struct ReportToParentTool {
    /// 이 에이전트의 이름.
    agent_name: String,
    /// 부모 에이전트 이름 (IPC 방식 fallback 시 사용).
    parent_agent: String,
    /// 부모 에이전트 hooks base URL (예: "http://localhost:3001").
    /// Some이면 HTTP POST, None이면 registry IPC.
    parent_hooks_url: Option<String>,
    /// hooks 인증 토큰.
    parent_hooks_token: String,
    /// IPC fallback용 registry.
    registry: Option<Arc<Mutex<AgentRegistry>>>,
}

impl ReportToParentTool {
    /// HTTP 방식: parent_hooks_url이 있는 경우.
    pub fn new_http(
        agent_name: impl Into<String>,
        parent_agent: impl Into<String>,
        parent_hooks_url: impl Into<String>,
        parent_hooks_token: impl Into<String>,
    ) -> Self {
        Self {
            agent_name: agent_name.into(),
            parent_agent: parent_agent.into(),
            parent_hooks_url: Some(parent_hooks_url.into()),
            parent_hooks_token: parent_hooks_token.into(),
            registry: None,
        }
    }

    /// IPC 방식: registry를 통해 부모 에이전트에 직접 주입.
    pub fn new_ipc(
        agent_name: impl Into<String>,
        parent_agent: impl Into<String>,
        registry: Arc<Mutex<AgentRegistry>>,
    ) -> Self {
        Self {
            agent_name: agent_name.into(),
            parent_agent: parent_agent.into(),
            parent_hooks_url: None,
            parent_hooks_token: String::new(),
            registry: Some(registry),
        }
    }

    /// HTTP + IPC fallback 통합 생성자.
    pub fn new(
        agent_name: impl Into<String>,
        parent_agent: impl Into<String>,
        parent_hooks_url: Option<String>,
        parent_hooks_token: impl Into<String>,
        registry: Option<Arc<Mutex<AgentRegistry>>>,
    ) -> Self {
        Self {
            agent_name: agent_name.into(),
            parent_agent: parent_agent.into(),
            parent_hooks_url,
            parent_hooks_token: parent_hooks_token.into(),
            registry,
        }
    }
}

#[async_trait]
impl Tool for ReportToParentTool {
    fn name(&self) -> &str {
        "report_to_parent"
    }

    fn description(&self) -> &str {
        "작업 완료 후 부모 에이전트에게 결과를 보고합니다. \
         send_to_agent로 위임받은 태스크가 끝나면 반드시 이 툴로 보고하세요. \
         부모(L0)가 보고를 받아 사용자에게 알림을 전달합니다."
    }

    fn schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "message": {
                    "type": "string",
                    "description": "부모에게 전달할 완료 보고 내용. 무엇을 했고, 결과가 어떤지 간략히."
                }
            },
            "required": ["message"]
        })
    }

    async fn execute(&self, args: &HashMap<String, serde_json::Value>) -> Result<String> {
        let message = args
            .get("message")
            .and_then(|v| v.as_str())
            .ok_or_else(|| TiguError::Tool("'message' 파라미터가 필요합니다".into()))?
            .to_string();

        let formatted = format!("[{}] {}", self.agent_name, message);

        if let Some(ref hooks_url) = self.parent_hooks_url {
            // HTTP POST → /hooks/report
            let url = format!("{}/hooks/report", hooks_url.trim_end_matches('/'));

            let client = reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(10))
                .build()
                .map_err(|e| TiguError::Tool(format!("HTTP client 생성 실패: {e}")))?;

            let resp = client
                .post(&url)
                .header("Authorization", format!("Bearer {}", self.parent_hooks_token))
                .json(&serde_json::json!({
                    "from": self.agent_name,
                    "message": message
                }))
                .send()
                .await
                .map_err(|e| TiguError::Tool(format!("부모 에이전트 보고 전송 실패: {e}")))?;

            let status = resp.status();
            if status.is_success() {
                Ok(format!("✅ 부모 에이전트 '{}'에게 보고 완료.", self.parent_agent))
            } else {
                let body = resp.text().await.unwrap_or_default();
                Err(TiguError::Tool(format!(
                    "보고 전송 실패 (HTTP {}): {}",
                    status, body
                )))
            }
        } else if let Some(ref registry) = self.registry {
            // IPC fallback: 부모 에이전트 inbox에 직접 주입.
            let reg = registry.lock().await;
            let msg = tiguclaw_core::types::ChannelMessage {
                id: format!("report-{}", self.agent_name),
                sender: self.agent_name.clone(),
                content: formatted.clone(),
                timestamp: chrono::Local::now().timestamp(),
                source: None,
            };
            if reg.inject_dashboard_message(&self.parent_agent, msg).await {
                Ok(format!("✅ 부모 에이전트 '{}'에게 보고 완료 (IPC).", self.parent_agent))
            } else {
                Err(TiguError::Tool(format!(
                    "부모 에이전트 '{}' inbox 주입 실패 (에이전트가 없거나 채널 닫힘).",
                    self.parent_agent
                )))
            }
        } else {
            Err(TiguError::Tool(
                "report_to_parent: parent_hooks_url도 registry도 없습니다. 설정을 확인하세요.".into(),
            ))
        }
    }
}
