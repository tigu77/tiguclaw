//! 에스컬레이션 프로토콜 타입 — Phase 9-4.
//!
//! T2 → T1 → T0 계층을 따라 문제/도움 요청을 상위 에이전트에게 전달한다.

use serde::{Deserialize, Serialize};

/// 에스컬레이션 이유.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum EscalationReason {
    /// 태스크 실행 실패.
    TaskFailed { error: String },
    /// 방향 지도 요청.
    NeedsGuidance { question: String },
    /// 리소스 한계 초과.
    ResourceLimit { detail: String },
}

impl EscalationReason {
    /// 이유 타입 이름 반환.
    pub fn kind(&self) -> &str {
        match self {
            EscalationReason::TaskFailed { .. } => "task_failed",
            EscalationReason::NeedsGuidance { .. } => "needs_guidance",
            EscalationReason::ResourceLimit { .. } => "resource_limit",
        }
    }

    /// 이유 상세 설명 반환.
    pub fn detail(&self) -> &str {
        match self {
            EscalationReason::TaskFailed { error } => error,
            EscalationReason::NeedsGuidance { question } => question,
            EscalationReason::ResourceLimit { detail } => detail,
        }
    }
}

/// 에스컬레이션 보고서 — 하위 에이전트가 상위 에이전트에게 전달.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EscalationReport {
    /// 에스컬레이션을 보낸 에이전트 이름.
    pub from_agent: String,
    /// 에스컬레이션을 받는 에이전트 이름 (상위 에이전트).
    pub to_agent: String,
    /// 에스컬레이션 이유.
    pub reason: EscalationReason,
    /// 현재 작업 컨텍스트 요약.
    pub context: String,
    /// Unix timestamp (초).
    pub timestamp: u64,
}

impl EscalationReport {
    /// 새 에스컬레이션 보고서 생성.
    pub fn new(
        from_agent: impl Into<String>,
        to_agent: impl Into<String>,
        reason: EscalationReason,
        context: impl Into<String>,
    ) -> Self {
        Self {
            from_agent: from_agent.into(),
            to_agent: to_agent.into(),
            reason,
            context: context.into(),
            timestamp: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs(),
        }
    }

    /// LLM에 주입할 텍스트 표현 생성.
    pub fn to_prompt_text(&self) -> String {
        format!(
            "[ESCALATION from '{}' → '{}']\n\
             이유: {} — {}\n\
             컨텍스트: {}",
            self.from_agent,
            self.to_agent,
            self.reason.kind(),
            self.reason.detail(),
            self.context,
        )
    }
}
