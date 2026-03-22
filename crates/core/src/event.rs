//! Phase 9-1: 대시보드 이벤트 타입 정의.
//!
//! DashboardServer가 broadcast 채널로 스트리밍하며,
//! Monitor/AgentRegistry가 이벤트를 생성한다.

use serde::Serialize;

/// 대시보드로 전달되는 실시간 이벤트.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", content = "data")]
pub enum DashboardEvent {
    /// 에이전트 spawn 이벤트.
    AgentSpawned { name: String, role: String, level: u8 },
    /// 에이전트 kill 이벤트.
    AgentKilled { name: String },
    /// 에이전트간 통신 이벤트 (message는 50자 truncate).
    AgentComm { from: String, to: String, message: String },
    /// 현재 실행 중인 전체 에이전트 목록 스냅샷.
    AgentStatus { agents: Vec<AgentStatusInfo> },
    /// 30초마다 전송되는 heartbeat ping.
    Heartbeat,
    /// 에이전트 LLM 요청 중.
    AgentThinking { name: String },
    /// 에이전트 툴 실행 중.
    AgentExecuting { name: String, tool: String },
    /// 에이전트 대기 상태.
    AgentIdle { name: String },
}

/// 에이전트 상태 정보 (REST API + WS 공용).
#[derive(Debug, Clone, Serialize)]
pub struct AgentStatusInfo {
    pub name: String,
    /// 로컬 별칭 — 같은 spec(name)으로 여러 인스턴스 구분용 (선택사항).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nickname: Option<String>,
    pub role: String,
    pub level: u8,
    pub channel_type: String,
    pub persistent: bool,
    /// 현재 에이전트 상태: "idle" | "thinking" | "executing:tool명"
    #[serde(default)]
    pub current_status: String,
    /// 부모 에이전트 이름 (L0는 None, L1은 supermaster 이름, L2는 L1 이름).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_agent: Option<String>,
    /// 소속 팀 이름 (선택사항).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub team: Option<String>,
}
