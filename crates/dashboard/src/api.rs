//! Phase 9-1: REST API 핸들러.
//!
//! GET /api/agents  → 현재 에이전트 목록 (AgentStatusInfo 배열)
//! GET /api/status  → 봇 상태 (uptime, version)
//! GET /api/logs    → 최근 이벤트 히스토리 (최대 100개)

use axum::{extract::State, Json};
use serde::Serialize;

use tiguclaw_core::event::{AgentStatusInfo, DashboardEvent};

use crate::server::AppState;

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

/// GET /api/status 응답.
#[derive(Debug, Serialize)]
pub struct BotStatus {
    pub uptime_secs: u64,
    pub version: String,
    pub agent_count: usize,
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/// GET /api/agents — 현재 실행 중인 에이전트 목록.
pub async fn get_agents(State(state): State<AppState>) -> Json<Vec<AgentStatusInfo>> {
    let reg = state.registry.lock().await;
    let agents = reg
        .list()
        .into_iter()
        .map(|a| AgentStatusInfo {
            name: a.name.clone(),
            role: a.agent_role.label().to_string(),
            level: a.level,
            channel_type: a.channel_type,
            persistent: a.persistent,
            current_status: reg.get_status(&a.name),
        })
        .collect::<Vec<_>>();
    Json(agents)
}

/// GET /api/status — 봇 상태 정보.
pub async fn get_status(State(state): State<AppState>) -> Json<BotStatus> {
    let uptime_secs = state.start_time.elapsed().as_secs();
    let agent_count = {
        let reg = state.registry.lock().await;
        reg.list().len()
    };
    Json(BotStatus {
        uptime_secs,
        version: env!("CARGO_PKG_VERSION").to_string(),
        agent_count,
    })
}

/// GET /api/logs — 최근 이벤트 히스토리 (최대 100개).
pub async fn get_logs(State(state): State<AppState>) -> Json<Vec<DashboardEvent>> {
    let log = state.log.lock().unwrap();
    Json(log.iter().cloned().collect())
}
