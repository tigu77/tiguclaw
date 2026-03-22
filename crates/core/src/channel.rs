//! Channel trait — abstraction over messaging platforms (e.g. Telegram).

use async_trait::async_trait;
use tokio::sync::mpsc;
use crate::error::Result;
use crate::types::ChannelMessage;

/// A messaging channel that can send and receive messages.
#[async_trait]
pub trait Channel: Send + Sync {
    /// Human-readable channel name (e.g. "telegram").
    fn name(&self) -> &str;

    /// Send a text message to a specific recipient/chat.
    async fn send(&self, chat_id: &str, text: &str) -> Result<()>;

    /// Start listening for inbound messages, forwarding them through the sender.
    /// This should run until the channel is shut down.
    async fn listen(&self, tx: mpsc::Sender<ChannelMessage>) -> Result<()>;

    /// Send a "typing..." indicator. No-op by default.
    async fn send_typing(&self, _chat_id: &str) -> Result<()> {
        Ok(())
    }

    /// Send a file/document with optional caption. No-op by default.
    async fn send_document(&self, _chat_id: &str, _file_path: &str, _caption: Option<&str>) -> Result<()> {
        Ok(())
    }
}
