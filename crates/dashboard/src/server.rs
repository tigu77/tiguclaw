//! Phase 9-1: 대시보드 서버 — axum 라우터 조립 + 실행.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use anyhow::Result;
use axum::{Router, routing::get};
use tokio::sync::{broadcast, Mutex as TokioMutex};
use tower_http::cors::{Any, CorsLayer};
use tracing::info;

use tiguclaw_agent::AgentRegistry;
use tiguclaw_core::event::DashboardEvent;

use crate::api::{get_agents, get_logs, get_status};
use crate::ws::ws_handler;

/// 로그 히스토리 최대 크기.
const MAX_LOG_SIZE: usize = 100;
/// broadcast 채널 버퍼 크기.
const BROADCAST_CAPACITY: usize = 256;

/// axum 핸들러에 공유되는 앱 상태.
#[derive(Clone)]
pub struct AppState {
    /// 에이전트 레지스트리 (API에서 목록 조회용).
    pub registry: Arc<TokioMutex<AgentRegistry>>,
    /// 이벤트 broadcast sender (WS 클라이언트에 구독 제공).
    pub event_tx: broadcast::Sender<DashboardEvent>,
    /// 최근 이벤트 히스토리 (최대 100개).
    pub log: Arc<Mutex<VecDeque<DashboardEvent>>>,
    /// 서버 시작 시각.
    pub start_time: Instant,
}

/// 대시보드 서버.
///
/// `event_tx`를 Monitor와 AgentRegistry에 공유하면
/// 에이전트 이벤트가 WebSocket 클라이언트에 실시간 스트리밍된다.
pub struct DashboardServer {
    /// 외부에서 이벤트를 broadcast할 수 있는 sender.
    pub event_tx: broadcast::Sender<DashboardEvent>,
    log: Arc<Mutex<VecDeque<DashboardEvent>>>,
    registry: Arc<TokioMutex<AgentRegistry>>,
    cors_origin: String,
    start_time: Instant,
}

impl DashboardServer {
    /// 새 DashboardServer 생성.
    ///
    /// `registry`를 공유받아 REST API에서 에이전트 목록을 제공한다.
    pub fn new(registry: Arc<TokioMutex<AgentRegistry>>, cors_origin: String) -> Self {
        let (event_tx, _) = broadcast::channel(BROADCAST_CAPACITY);
        let log = Arc::new(Mutex::new(VecDeque::with_capacity(MAX_LOG_SIZE)));
        Self {
            event_tx,
            log,
            registry,
            cors_origin,
            start_time: Instant::now(),
        }
    }

    /// 이벤트를 로그에 저장하고 broadcast 채널로 전송 (sync 메서드).
    pub fn broadcast(&self, event: DashboardEvent) {
        {
            let mut log = self.log.lock().unwrap();
            if log.len() >= MAX_LOG_SIZE {
                log.pop_front();
            }
            log.push_back(event.clone());
        }
        let _ = self.event_tx.send(event);
    }

    /// 서버 시작. 이 메서드를 `tokio::spawn`으로 실행한다.
    pub async fn start(self, port: u16) -> Result<()> {
        // 이벤트 → 로그 저장 백그라운드 태스크.
        let log_clone = self.log.clone();
        let mut log_rx = self.event_tx.subscribe();
        tokio::spawn(async move {
            while let Ok(event) = log_rx.recv().await {
                let mut log = log_clone.lock().unwrap();
                if log.len() >= MAX_LOG_SIZE {
                    log.pop_front();
                }
                log.push_back(event);
            }
        });

        // 30초 heartbeat 백그라운드 태스크.
        let hb_tx = self.event_tx.clone();
        tokio::spawn(async move {
            let mut interval =
                tokio::time::interval(std::time::Duration::from_secs(30));
            loop {
                interval.tick().await;
                let _ = hb_tx.send(DashboardEvent::Heartbeat);
            }
        });

        // CORS 미들웨어.
        let cors = if self.cors_origin == "*" {
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods(Any)
                .allow_headers(Any)
        } else {
            let origin = self
                .cors_origin
                .parse::<axum::http::HeaderValue>()
                .unwrap_or(axum::http::HeaderValue::from_static("*"));
            CorsLayer::new()
                .allow_origin(origin)
                .allow_methods(Any)
                .allow_headers(Any)
        };

        let state = AppState {
            registry: self.registry,
            event_tx: self.event_tx,
            log: self.log,
            start_time: self.start_time,
        };

        let router = Router::new()
            .route("/ws", get(ws_handler))
            .route("/api/agents", get(get_agents))
            .route("/api/status", get(get_status))
            .route("/api/logs", get(get_logs))
            .layer(cors)
            .with_state(state);

        let addr = format!("0.0.0.0:{port}");
        info!(addr = %addr, "dashboard server starting");

        let listener = tokio::net::TcpListener::bind(&addr).await?;
        info!(addr = %addr, "dashboard server listening");

        axum::serve(listener, router).await?;
        Ok(())
    }
}
