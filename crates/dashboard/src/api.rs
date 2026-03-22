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
use serde_json::Value as JsonValue;
use serde::{Deserialize, Serialize};
use tiguclaw_core::types::ChannelMessage;

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

use tiguclaw_core::event::AgentStatusInfo;

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
            nickname: a.nickname.clone(),
            tier: a.tier,
            channel_type: a.channel_type,
            persistent: a.persistent,
            current_status: reg.get_status(&a.name),
            parent_agent: a.parent_agent,
            team: a.team,
            clearance: a.clearance,
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

/// GET /api/logs 쿼리 파라미터.
#[derive(Debug, Deserialize)]
pub struct LogsQuery {
    pub date: Option<String>,
    pub limit: Option<usize>,
}

/// GET /api/logs?date=YYYY-MM-DD&limit=500 — 날짜별 JSONL 로그 조회 (기본: 오늘).
///
/// EventLogger가 없으면 인메모리 로그를 반환 (하위 호환).
pub async fn get_logs_file(
    State(state): State<AppState>,
    Query(query): Query<LogsQuery>,
) -> Json<Vec<JsonValue>> {
    let limit = query.limit.unwrap_or(500);

    if let Some(ref logger) = state.event_logger {
        let result = if let Some(ref date) = query.date {
            logger.read_date(date, limit)
        } else {
            logger.read_today(limit)
        };
        match result {
            Ok(events) => return Json(events),
            Err(e) => {
                tracing::warn!(error = %e, "event log read failed, falling back to in-memory");
            }
        }
    }

    // fallback: 인메모리 로그
    let log = state.log.lock().unwrap();
    let events: Vec<JsonValue> = log
        .iter()
        .take(limit)
        .filter_map(|e| serde_json::to_value(e).ok())
        .collect();
    Json(events)
}

/// GET /api/logs/dates — 보관 중인 날짜 목록.
pub async fn get_log_dates(
    State(state): State<AppState>,
) -> Json<Vec<String>> {
    if let Some(ref logger) = state.event_logger {
        Json(logger.list_dates())
    } else {
        Json(vec![])
    }
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
    let store = state.conv_store.as_ref().ok_or(StatusCode::SERVICE_UNAVAILABLE)?;
    let store = store.lock().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

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
    let store = state.conv_store.as_ref().ok_or(StatusCode::SERVICE_UNAVAILABLE)?;
    let store = store.lock().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

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

// ---------------------------------------------------------------------------
// Chat injection handler
// ---------------------------------------------------------------------------

/// POST /api/chat 요청 바디.
#[derive(Debug, Deserialize)]
pub struct ChatBody {
    pub agent_name: String,
    pub message: String,
}

/// POST /api/chat 응답.
#[derive(Debug, Serialize)]
pub struct ChatResponse {
    pub ok: bool,
}

/// POST /api/chat — 대시보드에서 에이전트로 메시지 주입.
///
/// Body: `{ agent_name: String, message: String }`
///
/// 메시지를 프라이머리 채널(TelegramChannel)로 직접 주입한다.
/// sender를 admin_chat_id로 설정하여 에이전트 응답이 텔레그램으로 전달되도록 한다.
/// 대시보드는 `/api/conversations/:id` 폴링으로 응답을 확인할 수 있다.
pub async fn post_chat(
    State(state): State<AppState>,
    Json(body): Json<ChatBody>,
) -> Result<Json<ChatResponse>, StatusCode> {
    if body.message.is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }

    let msg = ChannelMessage {
        id: format!("dashboard-{}", chrono::Utc::now().timestamp_millis()),
        // admin_chat_id를 sender로 설정 → 에이전트 응답이 텔레그램으로 전달됨.
        sender: state.admin_chat_id.to_string(),
        content: body.message,
        timestamp: chrono::Utc::now().timestamp(),
        source: Some("dashboard".to_string()),
    };

    let reg = state.registry.lock().await;
    let sent = reg.inject_to_primary_channel(msg).await;
    drop(reg);

    if sent {
        Ok(Json(ChatResponse { ok: true }))
    } else {
        Err(StatusCode::SERVICE_UNAVAILABLE)
    }
}
