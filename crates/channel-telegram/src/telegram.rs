//! TelegramChannel — Channel trait implementation using teloxide long polling.

use async_trait::async_trait;
use teloxide::prelude::*;
use teloxide::types::ParseMode;
use tokio::sync::mpsc;
use tracing::{debug, info, warn};

use tiguclaw_core::channel::Channel;
use tiguclaw_core::error::{Result, TiguError};
use tiguclaw_core::types::ChannelMessage;

/// Maximum Telegram message length in characters.
const MAX_MSG_LEN: usize = 4096;

/// Telegram channel using teloxide long polling.
pub struct TelegramChannel {
    bot: Bot,
    admin_chat_id: i64,
}

impl TelegramChannel {
    /// Create from a core config telegram section.
    pub fn from_config(cfg: &tiguclaw_core::config::TelegramConfig) -> Self {
        let bot = Bot::new(&cfg.bot_token);
        Self {
            bot,
            admin_chat_id: cfg.admin_chat_id,
        }
    }

    pub fn new(bot_token: &str, admin_chat_id: i64) -> Self {
        Self {
            bot: Bot::new(bot_token),
            admin_chat_id,
        }
    }
}

#[async_trait]
impl Channel for TelegramChannel {
    fn name(&self) -> &str {
        "telegram"
    }

    async fn send_typing(&self, chat_id: &str) -> Result<()> {
        let chat_id: i64 = chat_id
            .parse()
            .map_err(|_| TiguError::Channel(format!("invalid chat_id: {chat_id}")))?;

        let _ = self
            .bot
            .send_chat_action(ChatId(chat_id), teloxide::types::ChatAction::Typing)
            .await;

        Ok(())
    }

    async fn send(&self, chat_id: &str, text: &str) -> Result<()> {
        let chat_id: i64 = chat_id
            .parse()
            .map_err(|_| TiguError::Channel(format!("invalid chat_id: {chat_id}")))?;

        let chunks = split_message(text, MAX_MSG_LEN);
        for chunk in &chunks {
            // Try Markdown first, fall back to plain text on failure.
            let result = self
                .bot
                .send_message(ChatId(chat_id), chunk)
                .parse_mode(ParseMode::Html)
                .await;

            match result {
                Ok(_) => {}
                Err(_) => {
                    debug!("markdown send failed, retrying as plain text");
                    self.bot
                        .send_message(ChatId(chat_id), chunk)
                        .await
                        .map_err(|e| TiguError::Channel(format!("send failed: {e}")))?;
                }
            }
        }

        Ok(())
    }

    async fn listen(&self, tx: mpsc::Sender<ChannelMessage>) -> Result<()> {
        info!(admin_chat_id = self.admin_chat_id, "starting telegram listener");

        let admin_chat_id = ChatId(self.admin_chat_id);
        let tx = tx.clone();

        let handler = Update::filter_message().endpoint(
            move |msg: Message| {
                let tx = tx.clone();
                async move {
                    // Filter: only respond to admin.
                    if msg.chat.id != admin_chat_id {
                        warn!(
                            chat_id = msg.chat.id.0,
                            "ignoring message from non-admin"
                        );
                        return respond(());
                    }

                    // Only handle text messages.
                    if let Some(text) = msg.text() {
                        let channel_msg = ChannelMessage {
                            id: msg.id.0.to_string(),
                            sender: msg.chat.id.0.to_string(),
                            content: text.to_string(),
                            timestamp: msg.date.timestamp(),
                        };
                        debug!(msg_id = %channel_msg.id, "received telegram message");
                        if tx.send(channel_msg).await.is_err() {
                            warn!("channel receiver dropped");
                        }
                    }

                    respond(())
                }
            },
        );

        Dispatcher::builder(self.bot.clone(), handler)
            .build()
            .dispatch()
            .await;

        Ok(())
    }
}

/// Split a message into chunks that fit within the Telegram limit.
/// Tries to split at newlines when possible.
fn split_message(text: &str, max_len: usize) -> Vec<String> {
    if text.len() <= max_len {
        return vec![text.to_string()];
    }

    let mut chunks = Vec::new();
    let mut remaining = text;

    while !remaining.is_empty() {
        if remaining.len() <= max_len {
            chunks.push(remaining.to_string());
            break;
        }

        // Try to find a newline to split at.
        let split_at = remaining[..max_len]
            .rfind('\n')
            .unwrap_or(max_len);

        let (chunk, rest) = remaining.split_at(split_at);
        chunks.push(chunk.to_string());

        // Skip the newline if we split there.
        remaining = if let Some(stripped) = rest.strip_prefix('\n') {
            stripped
        } else {
            rest
        };
    }

    chunks
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_split_short_message() {
        let chunks = split_message("hello", 4096);
        assert_eq!(chunks, vec!["hello"]);
    }

    #[test]
    fn test_split_long_message() {
        let text = "a\n".repeat(3000);
        let chunks = split_message(&text, 4096);
        assert!(chunks.len() > 1);
        for chunk in &chunks {
            assert!(chunk.len() <= 4096);
        }
    }

    #[test]
    fn test_split_no_newlines() {
        let text = "a".repeat(5000);
        let chunks = split_message(&text, 4096);
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0].len(), 4096);
        assert_eq!(chunks[1].len(), 904);
    }
}
