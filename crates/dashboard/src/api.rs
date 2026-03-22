//! Phase 9-1: REST API 핸들러.
//!
//! GET /api/agents              → 현재 에이전트 목록 (AgentStatusInfo 배열)
//! GET /api/status              → 봇 상태 (uptime, version)
//! GET /api/logs                → 최근 이벤트 히스토리 (최대 100개)
//! GET /api/conversations       → 최근 대화 목록 (최대 20개)
//! GET /api/conversations/:id   → 특정 대화 상세

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Steer handler
// ---------------------------------------------------------------------------

/// POST /api/agents/:name/steer body.
#[derive(Debug, Deserialize)]
pub struct SteerBody {
    pub message: String,
}

/// POST /api/agents/:name/steer — 실행 중인 에이전트에게 방향 전환 신호 전달.
pub async fn steer_agent(
    State(state): State<AppState>,
    Path(name): Path<String>,
    Json(body): Json<SteerBody>,
) -> StatusCode {
    if body.message.is_empty() {
        return StatusCode::BAD_REQUEST;
    }
    let reg = state.registry.lock().await;
    let sent = reg.send_steer(&name, body.message).await;
    if sent {
        StatusCode::OK
    } else {
        StatusCode::NOT_FOUND
    }
}

use tiguclaw_core::event::{AgentStatusInfo, DashboardEvent};

use crate::server::AppState;
use crate::timeline::TimelineEvent;

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
            parent_agent: None,
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

// ---------------------------------------------------------------------------
// Timeline handlers
// ---------------------------------------------------------------------------

/// GET /api/timeline?agent=이름 쿼리 파라미터.
#[derive(Debug, Deserialize)]
pub struct TimelineQuery {
    pub agent: Option<String>,
}

/// GET /api/timeline — 전체 타임라인 (최근 300개, ?agent=이름 필터 지원).
pub async fn get_timeline(
    State(state): State<AppState>,
    Query(query): Query<TimelineQuery>,
) -> Result<Json<Vec<TimelineEvent>>, StatusCode> {
    let db = state
        .timeline_db
        .as_ref()
        .ok_or(StatusCode::SERVICE_UNAVAILABLE)?;

    let events = db
        .get_timeline(query.agent.as_deref(), 300)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(events))
}

/// GET /api/agents/:name/timeline — 에이전트별 타임라인 (최근 200개).
pub async fn get_agent_timeline(
    State(state): State<AppState>,
    Path(name): Path<String>,
) -> Result<Json<Vec<TimelineEvent>>, StatusCode> {
    let db = state
        .timeline_db
        .as_ref()
        .ok_or(StatusCode::SERVICE_UNAVAILABLE)?;

    let events = db
        .get_timeline(Some(&name), 200)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(events))
}

// ---------------------------------------------------------------------------
// Conversation types
// ---------------------------------------------------------------------------

/// GET /api/conversations 응답 아이템.
#[derive(Debug, Serialize)]
pub struct ConversationSummary {
    pub id: String,
    pub agent_name: String,
    pub message_count: usize,
    pub last_message: String,
    pub last_message_role: String,
    pub updated_at: i64,
}

/// GET /api/conversations/:id 응답 내 메시지 아이템.
#[derive(Debug, Serialize)]
pub struct MessageItem {
    pub role: String,
    pub content: String,
    pub timestamp: i64,
}

/// GET /api/conversations/:id 응답.
#[derive(Debug, Serialize)]
pub struct ConversationDetail {
    pub id: String,
    pub agent_name: String,
    pub messages: Vec<MessageItem>,
}

// ---------------------------------------------------------------------------
// Conversation handlers
// ---------------------------------------------------------------------------

/// GET /api/conversations — 최근 20개 대화 목록.
pub async fn get_conversations(
    State(state): State<AppState>,
) -> Result<Json<Vec<ConversationSummary>>, StatusCode> {
    let path = state
        .conv_db_path
        .as_ref()
        .ok_or(StatusCode::SERVICE_UNAVAILABLE)?;

    let store = tiguclaw_memory::ConversationStore::open(path)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let rows = store
        .list_conversations(20)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let summaries = rows
        .into_iter()
        .map(|(chat_id, msg_count, last_content, last_role, updated_at)| {
            // chat_id를 그대로 agent_name으로 사용
            let agent_name = chat_id.clone();
            ConversationSummary {
                id: chat_id,
                agent_name,
                message_count: msg_count,
                last_message: last_content,
                last_message_role: last_role,
                updated_at,
            }
        })
        .collect();

    Ok(Json(summaries))
}

/// GET /api/conversations/:id — 특정 chat_id의 상세 메시지 목록.
pub async fn get_conversation_detail(
    State(state): State<AppState>,
    Path(chat_id): Path<String>,
) -> Result<Json<ConversationDetail>, StatusCode> {
    let path = state
        .conv_db_path
        .as_ref()
        .ok_or(StatusCode::SERVICE_UNAVAILABLE)?;

    let store = tiguclaw_memory::ConversationStore::open(path)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let rows = store
        .load_history_with_ts(&chat_id, 100)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let messages = rows
        .into_iter()
        .map(|(role, content, timestamp)| MessageItem {
            role,
            content,
            timestamp,
        })
        .collect();

    Ok(Json(ConversationDetail {
        agent_name: chat_id.clone(),
        id: chat_id,
        messages,
    }))
}
