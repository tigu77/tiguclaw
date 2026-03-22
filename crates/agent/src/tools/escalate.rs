//! escalate_to_parent 툴 — Phase 9-4.
//!
//! 에이전트가 상위 에이전트에게 에스컬레이션 보고서를 HTTP POST로 전달한다.
//! 상위 에이전트의 hooks 서버 `/hooks/escalation` 엔드포인트를 사용한다.

use async_trait::async_trait;
use serde_json::json;

use tiguclaw_core::error::{Result, TiguError};
use tiguclaw_core::escalation::{EscalationReason, EscalationReport};
use tiguclaw_core::tool::Tool;

/// 상위 에이전트에게 에스컬레이션 보고서를 전송하는 툴.
///
/// # Input
/// ```json
/// {
///   "reason": "task_failed|needs_guidance|resource_limit",
///   "detail": "에러 메시지 또는 질문",
///   "context": "현재 작업 컨텍스트 요약"
/// }
/// ```
pub struct EscalateToParentTool {
    /// 이 에이전트의 이름.
    agent_name: String,
    /// 상위 에이전트 이름.
    parent_agent: String,
    /// 상위 에이전트 hooks base URL (예: "http://localhost:3001").
    parent_hooks_url: String,
    /// hooks 인증 토큰.
    parent_hooks_token: String,
}

impl EscalateToParentTool {
    pub fn new(
        agent_name: impl Into<String>,
        parent_agent: impl Into<String>,
        parent_hooks_url: impl Into<String>,
        parent_hooks_token: impl Into<String>,
    ) -> Self {
        Self {
            agent_name: agent_name.into(),
            parent_agent: parent_agent.into(),
            parent_hooks_url: parent_hooks_url.into(),
            parent_hooks_token: parent_hooks_token.into(),
        }
    }
}

#[async_trait]
impl Tool for EscalateToParentTool {
    fn name(&self) -> &str {
        "escalate_to_parent"
    }

    fn description(&self) -> &str {
        "상위 에이전트에게 에스컬레이션 보고서를 전송합니다. \
         태스크 실패, 가이던스 요청, 리소스 한계 초과 시 사용하세요. \
         상위 에이전트가 상황을 판단하여 재지시하거나 사용자에게 보고합니다."
    }

    fn schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "reason": {
                    "type": "string",
                    "enum": ["task_failed", "needs_guidance", "resource_limit"],
                    "description": "에스컬레이션 이유: task_failed=작업실패, needs_guidance=가이던스필요, resource_limit=리소스한계"
                },
                "detail": {
                    "type": "string",
                    "description": "에러 메시지, 질문 내용, 또는 리소스 한계 상세 설명"
                },
                "context": {
                    "type": "string",
                    "description": "현재 작업 컨텍스트 요약 (무슨 작업을 하다가 이 상황이 됐는지)"
                }
            },
            "required": ["reason", "detail", "context"]
        })
    }

    async fn execute(&self, args: &std::collections::HashMap<String, serde_json::Value>) -> Result<String> {
        let reason_str = args
            .get("reason")
            .and_then(|v| v.as_str())
            .ok_or_else(|| TiguError::Tool("reason 필드가 필요합니다".into()))?;

        let detail = args
            .get("detail")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let context = args
            .get("context")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let reason = match reason_str {
            "task_failed" => EscalationReason::TaskFailed { error: detail.clone() },
            "needs_guidance" => EscalationReason::NeedsGuidance { question: detail.clone() },
            "resource_limit" => EscalationReason::ResourceLimit { detail: detail.clone() },
            other => {
                return Err(TiguError::Tool(format!(
                    "알 수 없는 reason: '{}'. task_failed|needs_guidance|resource_limit 중 하나를 사용하세요.",
                    other
                )));
            }
        };

        let report = EscalationReport::new(
            &self.agent_name,
            &self.parent_agent,
            reason,
            context,
        );

        // Serialize and POST to parent's hooks /hooks/escalation endpoint.
        let url = format!("{}/hooks/escalation", self.parent_hooks_url.trim_end_matches('/'));

        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .map_err(|e| TiguError::Tool(format!("HTTP client 생성 실패: {e}")))?;

        let resp = client
            .post(&url)
            .header("Authorization", format!("Bearer {}", self.parent_hooks_token))
            .json(&report)
            .send()
            .await
            .map_err(|e| TiguError::Tool(format!("에스컬레이션 전송 실패: {e}")))?;

        let status = resp.status();
        if status.is_success() {
            Ok(format!(
                "✅ 에스컬레이션 전송 완료 → '{}' ({})\n이유: {} — {}",
                self.parent_agent,
                status,
                reason_str,
                detail,
            ))
        } else {
            let body = resp.text().await.unwrap_or_default();
            Err(TiguError::Tool(format!(
                "에스컬레이션 전송 실패 (HTTP {}): {}",
                status, body
            )))
        }
    }
}
