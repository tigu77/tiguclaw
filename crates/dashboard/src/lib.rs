//! tiguclaw-dashboard: Phase 9-1 웹 대시보드 백엔드.
//!
//! - axum WebSocket: 실시간 에이전트 이벤트 스트리밍
//! - REST API: 에이전트 목록 / 봇 상태 / 이벤트 로그

pub mod api;
pub mod server;
pub mod ws;

pub use server::DashboardServer;
