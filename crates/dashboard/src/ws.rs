//! Phase 9-1: WebSocket 핸들러 — 실시간 이벤트 스트리밍.
//!
//! 연결 즉시 현재 AgentStatus 이벤트를 전송하고,
//! broadcast::Receiver로 수신된 이벤트를 클라이언트에 JSON으로 전달한다.

use std::time::Duration;

use axum::{
    extract::{State, WebSocketUpgrade},
    response::Response,
};
use axum::extract::ws::{Message, WebSocket};
use tokio::sync::broadcast;
use tracing::{debug, warn};

use tiguclaw_core::event::{AgentStatusInfo, DashboardEvent};

use crate::server::AppState;

/// GET /ws — WebSocket 업그레이드 엔드포인트.
pub async fn ws_handler(ws: WebSocketUpgrade, State(state): State<AppState>) -> Response {
    ws.on_upgrade(|socket| handle_socket(socket, state))
}

/// 개별 WebSocket 연결 처리.
async fn handle_socket(mut socket: WebSocket, state: AppState) {
    debug!("dashboard WebSocket client connected");

    // 연결 즉시 현재 에이전트 상태 스냅샷 전송.
    let agents: Vec<AgentStatusInfo> = {
        let reg = state.registry.lock().await;
        reg.list()
            .into_iter()
            .map(|a| AgentStatusInfo {
                name: a.name.clone(),
                nickname: a.nickname.clone(),
                role: a.agent_role.label().to_string(),
                level: a.level,
                channel_type: a.channel_type,
                persistent: a.persistent,
                current_status: reg.get_status(&a.name),
                parent_agent: a.parent_agent,
                team: a.team,
            })
            .collect()
    };

    let initial_event = DashboardEvent::AgentStatus { agents };
    match serde_json::to_string(&initial_event) {
        Ok(json) => {
            if socket.send(Message::Text(json)).await.is_err() {
                debug!("dashboard WS client disconnected during initial send");
                return;
            }
        }
        Err(e) => {
            warn!(error = %e, "dashboard: initial AgentStatus 직렬화 실패");
        }
    }

    // broadcast::Receiver 구독.
    let mut rx = state.event_tx.subscribe();

    // 30초 heartbeat 인터벌 (서버 레벨 heartbeat와 별개로 클라이언트별 ping).
    let mut heartbeat = tokio::time::interval(Duration::from_secs(30));
    // 첫 tick은 즉시 발생하므로 skip.
    heartbeat.tick().await;

    loop {
        tokio::select! {
            // broadcast 이벤트 수신.
            result = rx.recv() => {
                match result {
                    Ok(event) => {
                        match serde_json::to_string(&event) {
                            Ok(json) => {
                                if socket.send(Message::Text(json)).await.is_err() {
                                    debug!("dashboard WS client disconnected");
                                    break;
                                }
                            }
                            Err(e) => {
                                warn!(error = %e, "dashboard: 이벤트 직렬화 실패 (건너뜀)");
                            }
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        warn!(skipped = n, "dashboard WS: broadcast lagged, 메시지 건너뜀");
                    }
                    Err(broadcast::error::RecvError::Closed) => {
                        debug!("dashboard WS: broadcast channel closed");
                        break;
                    }
                }
            }

            // Heartbeat.
            _ = heartbeat.tick() => {
                match serde_json::to_string(&DashboardEvent::Heartbeat) {
                    Ok(json) => {
                        if socket.send(Message::Text(json)).await.is_err() {
                            debug!("dashboard WS client disconnected during heartbeat");
                            break;
                        }
                    }
                    Err(e) => {
                        warn!(error = %e, "dashboard: heartbeat 직렬화 실패");
                    }
                }
            }

            // 클라이언트 메시지 수신 (연결 유지 확인 또는 무시).
            msg = socket.recv() => {
                match msg {
                    Some(Ok(Message::Close(_))) | None => {
                        debug!("dashboard WS client closed connection");
                        break;
                    }
                    Some(Ok(_)) => {
                        // 클라이언트 메시지는 무시 (read-only 스트림).
                    }
                    Some(Err(e)) => {
                        warn!(error = %e, "dashboard WS recv error");
                        break;
                    }
                }
            }
        }
    }

    debug!("dashboard WebSocket client disconnected");
}
