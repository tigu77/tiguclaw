//! Dashboard channel — injects messages from the REST API into the AgentLoop.
//!
//! `DashboardChannel` implements `Channel` so it can be attached to the primary
//! agent as an additional channel. Outgoing responses are silently accepted
//! (they are already persisted to `ConversationStore` by the agent).

use async_trait::async_trait;
use tokio::sync::{Mutex, mpsc};

use tiguclaw_core::channel::Channel;
use tiguclaw_core::error::Result;
use tiguclaw_core::types::ChannelMessage;

/// A channel that receives messages injected via the dashboard REST API.
///
/// Outgoing (`send`) calls are silently dropped — the response is already
/// persisted to `ConversationStore` by `handle_message`.
pub struct DashboardChannel {
    rx: Mutex<mpsc::Receiver<ChannelMessage>>,
}

impl DashboardChannel {
    /// Create a new `DashboardChannel` and return both the channel and the
    /// sender that can be used to inject messages.
    pub fn new() -> (Self, mpsc::Sender<ChannelMessage>) {
        let (tx, rx) = mpsc::channel(32);
        (Self { rx: Mutex::new(rx) }, tx)
    }
}

#[async_trait]
impl Channel for DashboardChannel {
    fn name(&self) -> &str {
        "dashboard"
    }

    /// Silently accept outgoing responses.
    /// The agent already persists replies to `ConversationStore`; the
    /// dashboard will surface them via `/api/conversations/:id` polling.
    async fn send(&self, _chat_id: &str, _text: &str) -> Result<()> {
        Ok(())
    }

    /// Forward injected messages to the agent loop.
    async fn listen(&self, tx: mpsc::Sender<ChannelMessage>) -> Result<()> {
        let mut rx = self.rx.lock().await;
        while let Some(msg) = rx.recv().await {
            if tx.send(msg).await.is_err() {
                break;
            }
        }
        Ok(())
    }
}
