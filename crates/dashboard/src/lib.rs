//! tiguclaw-dashboard: Phase 9-1 웹 대시보드 백엔드.
//!
//! - axum WebSocket: 실시간 에이전트 이벤트 스트리밍
//! - REST API: 에이전트 목록 / 봇 상태 / 이벤트 로그
//! - Timeline: SQLite 기반 이벤트 영속화 + REST API
//! - EventLog: 날짜별 JSONL 로그 파일 시스템

pub mod api;
pub mod event_log;
pub mod server;
pub mod timeline;
pub mod ws;

pub use event_log::EventLogger;
pub use server::DashboardServer;
pub use timeline::{TimelineDb, TimelineEvent};
