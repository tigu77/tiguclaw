//! tiguclaw-hooks: HTTP API server for external service integration.
//!
//! Provides:
//! - POST /hooks/wake  — inject a system event / heartbeat trigger
//! - POST /hooks/agent — ask the agent to process a message and optionally deliver via Telegram

pub mod handler;
pub mod types;

use std::net::SocketAddr;
use std::sync::Arc;

use axum::{Router, routing::post};
use tokio::sync::mpsc;
use tracing::info;

pub use types::HookEvent;

use handler::{HookState, agent_handler, wake_handler};

/// Configuration for the hook server.
#[derive(Debug, Clone)]
pub struct HookServerConfig {
    pub port: u16,
    pub token: String,
}

/// The HTTP hook server.
pub struct HookServer {
    config: HookServerConfig,
    event_tx: mpsc::Sender<HookEvent>,
}

impl HookServer {
    /// Create a new HookServer.
    /// The caller must provide the `event_tx` half of an `mpsc::channel`; the
    /// `event_rx` half should be given to `AgentLoop` so it can process events.
    pub fn new(config: HookServerConfig, event_tx: mpsc::Sender<HookEvent>) -> Self {
        Self { config, event_tx }
    }

    /// Start the server (non-blocking — spawns a background task).
    pub async fn start(self) -> anyhow::Result<()> {
        let state = HookState {
            event_tx: self.event_tx,
            token: Arc::new(self.config.token),
        };

        let app = Router::new()
            .route("/hooks/wake", post(wake_handler))
            .route("/hooks/agent", post(agent_handler))
            .with_state(state);

        let addr = SocketAddr::from(([0, 0, 0, 0], self.config.port));
        info!(port = self.config.port, "hooks HTTP server starting");

        let listener = tokio::net::TcpListener::bind(addr).await?;
        info!(addr = %listener.local_addr()?, "hooks HTTP server listening");

        tokio::spawn(async move {
            if let Err(e) = axum::serve(listener, app).await {
                tracing::error!(error = %e, "hooks server error");
            }
        });

        Ok(())
    }
}
