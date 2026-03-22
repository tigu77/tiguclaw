//! Phase 9-1: 대시보드 서버 — axum 라우터 조립 + 실행.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use anyhow::Result;
use axum::{Router, routing::get};
use tokio::sync::{broadcast, Mutex as TokioMutex};
use tower_http::cors::{Any, CorsLayer};
use tower_http::services::{ServeDir, ServeFile};
use tracing::{info, warn};

use tiguclaw_agent::AgentRegistry;
use tiguclaw_core::event::DashboardEvent;

use crate::api::{
    get_agents, get_agent_timeline, get_conversation_detail, get_conversations, get_logs,
    get_status, get_timeline, post_chat, steer_agent,
};
use crate::timeline::TimelineDb;
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
    /// 대화 히스토리 DB 경로 (대화 이력 API용).
    pub conv_db_path: Option<std::path::PathBuf>,
    /// 타임라인 DB (이벤트 영속화).
    pub timeline_db: Option<Arc<TimelineDb>>,
    /// 관리자 텔레그램 chat_id — 대시보드 메시지 주입 시 sender로 사용.
    pub admin_chat_id: i64,
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
    /// 대화 히스토리 DB 경로 (optional).
    conv_db_path: Option<std::path::PathBuf>,
    /// 정적 파일 디렉토리 (optional). None이면 API만 동작.
    dashboard_dir: Option<PathBuf>,
    /// 타임라인 DB (optional).
    timeline_db: Option<Arc<TimelineDb>>,
    /// 관리자 텔레그램 chat_id — 대시보드 메시지 주입 시 sender로 사용.
    admin_chat_id: i64,
}

impl DashboardServer {
    /// 새 DashboardServer 생성.
    ///
    /// `registry`를 공유받아 REST API에서 에이전트 목록을 제공한다.
    pub fn new(registry: Arc<TokioMutex<AgentRegistry>>, cors_origin: String) -> Self {
        let (event_tx, _) = broadcast::channel(BROADCAST_CAPACITY);
        let log = Arc::new(Mutex::new(VecDeque::with_capacity(MAX_LOG_SIZE)));
        // ~/.tiguclaw/dashboard/ 가 있으면 자동으로 정적 파일 서브
        let dashboard_dir = dirs::home_dir()
            .map(|h| h.join(".tiguclaw").join("dashboard"))
            .filter(|p| p.exists());
        Self {
            event_tx,
            log,
            registry,
            cors_origin,
            start_time: Instant::now(),
            conv_db_path: None,
            dashboard_dir,
            timeline_db: None,
            admin_chat_id: 0,
        }
    }

    /// 관리자 텔레그램 chat_id 설정 (builder 패턴).
    pub fn with_admin_chat_id(mut self, admin_chat_id: i64) -> Self {
        self.admin_chat_id = admin_chat_id;
        self
    }

    /// 대화 히스토리 DB 경로 설정 (builder 패턴).
    pub fn with_conv_db(mut self, path: std::path::PathBuf) -> Self {
        self.conv_db_path = Some(path);
        self
    }

    /// 정적 파일 디렉토리 수동 설정 (builder 패턴).
    pub fn with_dashboard_dir(mut self, path: PathBuf) -> Self {
        self.dashboard_dir = Some(path);
        self
    }

    /// 타임라인 DB 경로 설정 (builder 패턴).
    pub fn with_timeline_db(mut self, path: std::path::PathBuf) -> Self {
        match TimelineDb::open(&path) {
            Ok(db) => {
                info!(path = %path.display(), "timeline DB opened");
                self.timeline_db = Some(Arc::new(db));
            }
            Err(e) => {
                warn!(error = %e, path = %path.display(), "timeline DB open failed — timeline disabled");
            }
        }
        self
    }

    /// 이벤트를 로그에 저장하고 broadcast 채널로 전송 (sync 메서드).
    pub fn broadcast(&self, event: DashboardEvent) {
        // 타임라인 DB에 저장
        if let Some(ref db) = self.timeline_db {
            if let Err(e) = db.insert(&event) {
                warn!(error = %e, "timeline DB insert failed");
            }
        }
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
        // 이벤트 → 로그 저장 + 타임라인 DB 저장 백그라운드 태스크.
        let log_clone = self.log.clone();
        let timeline_db_clone = self.timeline_db.clone();
        let mut log_rx = self.event_tx.subscribe();
        tokio::spawn(async move {
            while let Ok(event) = log_rx.recv().await {
                // 타임라인 DB 저장
                if let Some(ref db) = timeline_db_clone {
                    if let Err(e) = db.insert(&event) {
                        warn!(error = %e, "timeline DB background insert failed");
                    }
                }
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
            conv_db_path: self.conv_db_path,
            timeline_db: self.timeline_db,
            admin_chat_id: self.admin_chat_id,
        };

        let mut router = Router::new()
            .route("/ws", get(ws_handler))
            .route("/api/agents", get(get_agents))
            .route("/api/status", get(get_status))
            .route("/api/logs", get(get_logs))
            .route("/api/timeline", get(get_timeline))
            .route("/api/agents/:name/timeline", get(get_agent_timeline))
            .route("/api/agents/:name/steer", axum::routing::post(steer_agent))
            .route("/api/chat", axum::routing::post(post_chat))
            .route("/api/conversations", get(get_conversations))
            .route("/api/conversations/:id", get(get_conversation_detail))
            .layer(cors)
            .with_state(state);

        // 정적 파일 서브: ~/.tiguclaw/dashboard/ 존재 시 SPA fallback 추가
        if let Some(ref dir) = self.dashboard_dir {
            info!(dir = %dir.display(), "serving static dashboard files");
            let index = dir.join("index.html");
            router = router.fallback_service(
                ServeDir::new(dir).fallback(ServeFile::new(index)),
            );
        }

        let addr = format!("0.0.0.0:{port}");
        info!(addr = %addr, "dashboard server starting");

        let listener = tokio::net::TcpListener::bind(&addr).await?;
        info!(addr = %addr, "dashboard server listening");

        axum::serve(listener, router).await?;
        Ok(())
    }
}
