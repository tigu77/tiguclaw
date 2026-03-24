//! Axum route handlers for /hooks/wake and /hooks/agent.

use std::sync::Arc;
use std::time::Duration;

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    Json,
};
use tokio::sync::{mpsc, oneshot};
use tracing::{info, warn};

use tiguclaw_core::escalation::EscalationReport;

use crate::types::{AgentPayload, ApiResponse, HookEvent, ReportPayload, SteerPayload, WakePayload};

/// Shared server state.
#[derive(Clone)]
pub struct HookState {
    /// Channel to send HookEvents to the AgentLoop.
    pub event_tx: mpsc::Sender<HookEvent>,
    /// Bearer token for authentication.
    pub token: Arc<String>,
}

/// Extract and validate Bearer token. Returns Err(401 response) on failure.
fn check_auth(headers: &HeaderMap, expected: &str) -> Result<(), (StatusCode, Json<ApiResponse>)> {
    let auth = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    let bearer = auth.strip_prefix("Bearer ").unwrap_or("");
    if bearer != expected {
        warn!("hook request rejected: invalid or missing Bearer token");
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(ApiResponse::err("unauthorized")),
        ));
    }
    Ok(())
}

/// POST /hooks/wake
pub async fn wake_handler(
    State(state): State<HookState>,
    headers: HeaderMap,
    Json(payload): Json<WakePayload>,
) -> impl IntoResponse {
    if let Err(resp) = check_auth(&headers, &state.token) {
        return resp.into_response();
    }

    info!(text = %payload.text, mode = ?payload.mode, "wake hook received");

    let event = HookEvent::Wake {
        text: payload.text,
        mode: payload.mode,
    };

    match state.event_tx.send(event).await {
        Ok(()) => (StatusCode::OK, Json(ApiResponse::ok())).into_response(),
        Err(e) => {
            warn!(error = %e, "failed to send wake event to agent loop");
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(ApiResponse::err("agent loop unavailable")),
            )
                .into_response()
        }
    }
}

/// POST /hooks/agent
pub async fn agent_handler(
    State(state): State<HookState>,
    headers: HeaderMap,
    Json(payload): Json<AgentPayload>,
) -> impl IntoResponse {
    if let Err(resp) = check_auth(&headers, &state.token) {
        return resp.into_response();
    }

    info!(
        message_len = payload.message.len(),
        deliver = payload.deliver,
        to = %payload.to,
        timeout = payload.timeout_seconds,
        "agent hook received"
    );

    let (response_tx, response_rx) = oneshot::channel::<String>();
    let timeout_secs = payload.timeout_seconds;

    let event = HookEvent::Agent {
        message: payload.message,
        deliver: payload.deliver,
        to: payload.to,
        response_tx,
    };

    if let Err(e) = state.event_tx.send(event).await {
        warn!(error = %e, "failed to send agent event to agent loop");
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(ApiResponse::err("agent loop unavailable")),
        )
            .into_response();
    }

    // Wait for agent response with timeout.
    match tokio::time::timeout(Duration::from_secs(timeout_secs), response_rx).await {
        Ok(Ok(response)) => {
            (StatusCode::OK, Json(ApiResponse::with_message(response))).into_response()
        }
        Ok(Err(_)) => {
            // Sender dropped (agent loop likely shut down).
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(ApiResponse::err("agent loop disconnected")),
            )
                .into_response()
        }
        Err(_) => {
            // Timeout.
            (
                StatusCode::GATEWAY_TIMEOUT,
                Json(ApiResponse::err(format!(
                    "agent did not respond within {timeout_secs}s"
                ))),
            )
                .into_response()
        }
    }
}

/// POST /hooks/escalation — Phase 9-4.
/// 하위 에이전트로부터 에스컬레이션 보고서 수신.
pub async fn escalation_handler(
    State(state): State<HookState>,
    headers: HeaderMap,
    Json(report): Json<EscalationReport>,
) -> impl IntoResponse {
    if let Err(resp) = check_auth(&headers, &state.token) {
        return resp.into_response();
    }

    info!(
        from = %report.from_agent,
        to = %report.to_agent,
        reason = %report.reason.kind(),
        "escalation received"
    );

    let event = HookEvent::Escalation { report };

    match state.event_tx.send(event).await {
        Ok(()) => (StatusCode::OK, Json(ApiResponse::ok())).into_response(),
        Err(e) => {
            warn!(error = %e, "failed to send escalation event to agent loop");
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(ApiResponse::err("agent loop unavailable")),
            )
                .into_response()
        }
    }
}

/// POST /hooks/report — T1 에이전트가 부모(T0)에게 완료 보고.
///
/// Body: `{ "from": "roblox-master", "message": "팀 구성 완료" }`
pub async fn report_handler(
    State(state): State<HookState>,
    headers: HeaderMap,
    Json(payload): Json<ReportPayload>,
) -> impl IntoResponse {
    if let Err(resp) = check_auth(&headers, &state.token) {
        return resp.into_response();
    }

    info!(from = %payload.from, "report hook received");

    let event = HookEvent::Report {
        from: payload.from,
        message: payload.message,
    };

    match state.event_tx.send(event).await {
        Ok(()) => (StatusCode::OK, Json(ApiResponse::ok())).into_response(),
        Err(e) => {
            warn!(error = %e, "failed to send report event to agent loop");
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(ApiResponse::err("agent loop unavailable")),
            )
                .into_response()
        }
    }
}

/// POST /hooks/steer — Phase 9-4.
/// 에이전트에게 방향 전환 신호 전달.
pub async fn steer_handler(
    State(state): State<HookState>,
    headers: HeaderMap,
    Json(payload): Json<SteerPayload>,
) -> impl IntoResponse {
    if let Err(resp) = check_auth(&headers, &state.token) {
        return resp.into_response();
    }

    info!(message_len = payload.message.len(), "steer hook received");

    let event = HookEvent::Steer { message: payload.message };

    match state.event_tx.send(event).await {
        Ok(()) => (StatusCode::OK, Json(ApiResponse::ok())).into_response(),
        Err(e) => {
            warn!(error = %e, "failed to send steer event to agent loop");
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(ApiResponse::err("agent loop unavailable")),
            )
                .into_response()
        }
    }
}
