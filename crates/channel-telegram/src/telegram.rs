//! TelegramChannel — Channel trait implementation using teloxide long polling.

/// Convert markdown text to Telegram-safe HTML.
///
/// Telegram supports only: <b> <i> <u> <s> <code> <pre> <a>
/// Unsupported elements (headings, lists, etc.) are rendered as plain text.
fn markdown_to_telegram_html(text: &str) -> String {
    use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};

    let mut opts = Options::empty();
    opts.insert(Options::ENABLE_STRIKETHROUGH);
    opts.insert(Options::ENABLE_TABLES);

    let parser = Parser::new_ext(text, opts);
    let mut output = String::with_capacity(text.len());
    let mut in_code_block = false;

    for event in parser {
        match event {
            // Block-level opening tags
            Event::Start(Tag::Paragraph) => {}
            Event::End(TagEnd::Paragraph) => {
                output.push('\n');
            }
            Event::Start(Tag::Heading { .. }) => {}
            Event::End(TagEnd::Heading(_)) => {
                output.push('\n');
            }
            Event::Start(Tag::BlockQuote(_)) => {}
            Event::End(TagEnd::BlockQuote(_)) => {}
            Event::Start(Tag::CodeBlock(_)) => {
                in_code_block = true;
                output.push_str("<pre>");
            }
            Event::End(TagEnd::CodeBlock) => {
                in_code_block = false;
                output.push_str("</pre>");
            }
            Event::Start(Tag::List(_)) => {}
            Event::End(TagEnd::List(_)) => {
                output.push('\n');
            }
            Event::Start(Tag::Item) => {
                output.push_str("• ");
            }
            Event::End(TagEnd::Item) => {
                output.push('\n');
            }

            // Inline formatting
            Event::Start(Tag::Strong) => output.push_str("<b>"),
            Event::End(TagEnd::Strong) => output.push_str("</b>"),
            Event::Start(Tag::Emphasis) => output.push_str("<i>"),
            Event::End(TagEnd::Emphasis) => output.push_str("</i>"),
            Event::Start(Tag::Strikethrough) => output.push_str("<s>"),
            Event::End(TagEnd::Strikethrough) => output.push_str("</s>"),

            // Links
            Event::Start(Tag::Link { dest_url, .. }) => {
                output.push_str("<a href=\"");
                output.push_str(&escape_html(&dest_url));
                output.push_str("\">");
            }
            Event::End(TagEnd::Link) => output.push_str("</a>"),

            // Images — just show alt text
            Event::Start(Tag::Image { .. }) => {}
            Event::End(TagEnd::Image) => {}

            // Inline code
            Event::Code(code) => {
                output.push_str("<code>");
                output.push_str(&escape_html(&code));
                output.push_str("</code>");
            }

            // Text content
            Event::Text(text) => {
                if in_code_block {
                    output.push_str(&escape_html(&text));
                } else {
                    output.push_str(&escape_html(&text));
                }
            }
            Event::SoftBreak => output.push('\n'),
            Event::HardBreak => output.push('\n'),
            Event::Rule => output.push_str("\n---\n"),

            // HTML passthrough — strip tags for safety
            Event::Html(_) | Event::InlineHtml(_) => {}

            _ => {}
        }
    }

    // Trim trailing whitespace
    output.trim_end().to_string()
}

/// Escape HTML special characters for Telegram HTML parse mode.
fn escape_html(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

use async_trait::async_trait;
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};
use teloxide::prelude::*;
use teloxide::types::ParseMode;
use tokio::sync::mpsc;
use tracing::{debug, info, warn};

use tiguclaw_core::channel::Channel;
use tiguclaw_core::error::{Result, TiguError};
use tiguclaw_core::types::ChannelMessage;

/// Download a Telegram file by file_id and save to ~/.tiguclaw/media/inbound/.
/// Returns the absolute path to the saved file.
async fn download_telegram_file(bot: &Bot, file_id: &str, ext: &str) -> Result<String> {
    // Resolve file path from Telegram
    let file = bot
        .get_file(file_id)
        .await
        .map_err(|e| TiguError::Channel(format!("get_file failed: {e}")))?;

    let token = bot.token();
    let url = format!("https://api.telegram.org/file/bot{}/{}", token, file.path);

    // Build destination directory
    let home = std::env::var("HOME")
        .map_err(|_| TiguError::Channel("HOME env not set".to_string()))?;
    let media_dir = std::path::PathBuf::from(&home).join(".tiguclaw/media/inbound");

    tokio::fs::create_dir_all(&media_dir)
        .await
        .map_err(|e| TiguError::Channel(format!("create_dir_all failed: {e}")))?;

    // Use millisecond timestamp for unique filename
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let filename = format!("{}.{}", ts, ext);
    let dest_path = media_dir.join(&filename);

    // Download bytes
    let client = reqwest::Client::new();
    let bytes = client
        .get(&url)
        .send()
        .await
        .map_err(|e| TiguError::Channel(format!("download request failed: {e}")))?
        .bytes()
        .await
        .map_err(|e| TiguError::Channel(format!("download read failed: {e}")))?;

    tokio::fs::write(&dest_path, &bytes)
        .await
        .map_err(|e| TiguError::Channel(format!("write file failed: {e}")))?;

    Ok(dest_path.to_string_lossy().to_string())
}

/// Maximum Telegram message length in characters.
const MAX_MSG_LEN: usize = 4096;

/// Telegram channel using teloxide long polling.
pub struct TelegramChannel {
    bot: Bot,
    admin_chat_id: Arc<AtomicI64>,
    /// Sender for external message injection (dashboard → agent).
    /// Messages sent here are forwarded to the AgentLoop as if they came from Telegram.
    inject_tx: mpsc::Sender<ChannelMessage>,
    /// Receiver for injected messages — consumed once by `listen()`.
    inject_rx: std::sync::Mutex<Option<mpsc::Receiver<ChannelMessage>>>,
}

impl TelegramChannel {
    /// Create from a core config telegram section.
    pub fn from_config(cfg: &tiguclaw_core::config::TelegramConfig) -> Self {
        let bot = Bot::new(&cfg.bot_token);
        let (inject_tx, inject_rx) = mpsc::channel(32);
        Self {
            bot,
            admin_chat_id: Arc::new(AtomicI64::new(cfg.admin_chat_id)),
            inject_tx,
            inject_rx: std::sync::Mutex::new(Some(inject_rx)),
        }
    }

    pub fn new(bot_token: &str, admin_chat_id: i64) -> Self {
        let (inject_tx, inject_rx) = mpsc::channel(32);
        Self {
            bot: Bot::new(bot_token),
            admin_chat_id: Arc::new(AtomicI64::new(admin_chat_id)),
            inject_tx,
            inject_rx: std::sync::Mutex::new(Some(inject_rx)),
        }
    }

    /// Returns a clone of the inject sender.
    ///
    /// Messages sent to this sender are forwarded into the AgentLoop
    /// as if they arrived from the Telegram channel (sender = admin_chat_id).
    /// Used by the dashboard REST API to route messages through the primary channel.
    pub fn inject_sender(&self) -> mpsc::Sender<ChannelMessage> {
        self.inject_tx.clone()
    }
}

/// Update admin_chat_id = 0 in config.toml with the given chat_id.
fn update_admin_chat_id_in_config(chat_id: i64) -> Result<()> {
    let config_path = std::env::current_dir()
        .map_err(|e| TiguError::Config(format!("cannot get current dir: {e}")))?
        .join("config.toml");

    let content = std::fs::read_to_string(&config_path)
        .map_err(|e| TiguError::Config(format!("cannot read config.toml: {e}")))?;

    let updated = content.replace(
        "admin_chat_id = 0",
        &format!("admin_chat_id = {}", chat_id),
    );

    std::fs::write(&config_path, updated)
        .map_err(|e| TiguError::Config(format!("cannot write config.toml: {e}")))?;

    Ok(())
}

#[async_trait]
impl Channel for TelegramChannel {
    fn name(&self) -> &str {
        "telegram"
    }

    async fn send_typing(&self, chat_id: &str) -> Result<()> {
        let chat_id: i64 = if chat_id == "master" {
            let id = self.admin_chat_id.load(std::sync::atomic::Ordering::SeqCst);
            if id == 0 { return Ok(()); }
            id
        } else {
            chat_id
                .parse()
                .map_err(|_| TiguError::Channel(format!("invalid chat_id: {chat_id}")))?
        };

        let _ = self
            .bot
            .send_chat_action(ChatId(chat_id), teloxide::types::ChatAction::Typing)
            .await;

        Ok(())
    }

    async fn send(&self, chat_id: &str, text: &str) -> Result<()> {
        // "master" is a special alias for the admin_chat_id.
        let chat_id: i64 = if chat_id == "master" {
            let id = self.admin_chat_id.load(std::sync::atomic::Ordering::SeqCst);
            if id == 0 {
                return Err(TiguError::Channel("admin_chat_id not set yet".to_string()));
            }
            id
        } else {
            chat_id
                .parse()
                .map_err(|_| TiguError::Channel(format!("invalid chat_id: {chat_id}")))?
        };

        let html_text = markdown_to_telegram_html(text);
        let chunks = split_message(&html_text, MAX_MSG_LEN);
        for chunk in &chunks {
            // Send as HTML (markdown already converted).
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

    async fn send_document(&self, chat_id: &str, file_path: &str, caption: Option<&str>) -> Result<()> {
        let chat_id: i64 = chat_id
            .parse()
            .map_err(|_| TiguError::Channel(format!("invalid chat_id: {chat_id}")))?;

        let path = std::path::PathBuf::from(file_path);
        if !path.exists() {
            return Err(TiguError::Channel(format!("file not found: {file_path}")));
        }

        let input_file = teloxide::types::InputFile::file(&path);
        let mut req = self.bot.send_document(ChatId(chat_id), input_file);
        if let Some(cap) = caption {
            req = req.caption(cap);
        }

        req.await
            .map_err(|e| TiguError::Channel(format!("send_document failed: {e}")))?;

        Ok(())
    }

    async fn listen(&self, tx: mpsc::Sender<ChannelMessage>) -> Result<()> {
        let current_admin = self.admin_chat_id.load(Ordering::SeqCst);
        info!(admin_chat_id = current_admin, "starting telegram listener");

        // Forward injected messages (e.g. from dashboard) → AgentLoop tx.
        if let Some(mut inject_rx) = self.inject_rx.lock().unwrap().take() {
            let tx_inject = tx.clone();
            tokio::spawn(async move {
                while let Some(msg) = inject_rx.recv().await {
                    if tx_inject.send(msg).await.is_err() {
                        break;
                    }
                }
            });
        }

        let admin_chat_id = Arc::clone(&self.admin_chat_id);
        let bot_for_welcome = self.bot.clone();
        let tx = tx.clone();
        let bot = self.bot.clone();

        // Restart loop: if the dispatcher exits for any reason (e.g. TerminatedByOtherGetUpdates),
        // wait briefly and restart. This ensures message reception survives transient polling errors.
        loop {
            let tx_loop = tx.clone();
            let admin_chat_id_loop = Arc::clone(&admin_chat_id);
            let bot_loop = bot_for_welcome.clone();

            let handler = Update::filter_message().endpoint(
                move |msg: Message| {
                    let tx = tx_loop.clone();
                    let admin_chat_id = Arc::clone(&admin_chat_id_loop);
                    let bot_for_welcome = bot_loop.clone();
                    async move {
                        let sender_id = msg.chat.id.0;
                        let current_admin = admin_chat_id.load(Ordering::SeqCst);

                        // Auto-register first user as admin if admin_chat_id == 0
                        if current_admin == 0 {
                            info!(chat_id = sender_id, "auto-registering first user as admin");
                            admin_chat_id.store(sender_id, Ordering::SeqCst);

                            if let Err(e) = update_admin_chat_id_in_config(sender_id) {
                                warn!("failed to update config.toml: {}", e);
                            }

                            let welcome = format!(
                                "✅ Admin registered! Your chat ID: {}\n🐯 tiguclaw is ready. What can I help you with?",
                                sender_id
                            );
                            let _ = bot_for_welcome
                                .send_message(msg.chat.id, welcome)
                                .await;

                            // Fall through to process this message normally
                        } else if msg.chat.id != ChatId(current_admin) {
                            warn!(
                                chat_id = sender_id,
                                "ignoring message from non-admin"
                            );
                            return respond(());
                        }

                        // Determine content from message type.
                        let content_opt: Option<String> = if let Some(text) = msg.text() {
                            // Plain text message.
                            Some(text.to_string())
                        } else if let Some(photos) = msg.photo() {
                            // Photo — pick the largest size (last in array).
                            if let Some(photo) = photos.last() {
                                let caption = msg.caption().unwrap_or("");
                                match download_telegram_file(&bot_for_welcome, &photo.file.id, "jpg").await {
                                    Ok(path) => {
                                        let mut content = format!("[이미지: {}]", path);
                                        if !caption.is_empty() {
                                            content.push_str(&format!("\n캡션: {}", caption));
                                        }
                                        Some(content)
                                    }
                                    Err(e) => {
                                        warn!("photo download failed: {}", e);
                                        Some(format!("[이미지 다운로드 실패: {}]", e))
                                    }
                                }
                            } else {
                                None
                            }
                        } else if let Some(doc) = msg.document() {
                            // Document / file.
                            let filename = doc.file_name.clone().unwrap_or_else(|| "file".to_string());
                            let ext = filename
                                .rsplit('.')
                                .next()
                                .unwrap_or("bin")
                                .to_string();
                            let caption = msg.caption().unwrap_or("");
                            match download_telegram_file(&bot_for_welcome, &doc.file.id, &ext).await {
                                Ok(path) => {
                                    let mut content = format!("[파일: {}, {}]", filename, path);
                                    if !caption.is_empty() {
                                        content.push_str(&format!("\n캡션: {}", caption));
                                    }
                                    Some(content)
                                }
                                Err(e) => {
                                    warn!("document download failed: {}", e);
                                    Some(format!("[파일 다운로드 실패: {}]", e))
                                }
                            }
                        } else if let Some(voice) = msg.voice() {
                            // Voice message.
                            let duration = voice.duration.seconds();
                            match download_telegram_file(&bot_for_welcome, &voice.file.id, "ogg").await {
                                Ok(path) => Some(format!("[음성메시지: {}, 길이: {}초]", path, duration)),
                                Err(e) => {
                                    warn!("voice download failed: {}", e);
                                    Some(format!("[음성 다운로드 실패: {}]", e))
                                }
                            }
                        } else if let Some(video) = msg.video() {
                            // Video message.
                            let duration = video.duration.seconds();
                            let caption = msg.caption().unwrap_or("");
                            match download_telegram_file(&bot_for_welcome, &video.file.id, "mp4").await {
                                Ok(path) => {
                                    let mut content = format!("[비디오: {}, 길이: {}초]", path, duration);
                                    if !caption.is_empty() {
                                        content.push_str(&format!("\n캡션: {}", caption));
                                    }
                                    Some(content)
                                }
                                Err(e) => {
                                    warn!("video download failed: {}", e);
                                    Some(format!("[비디오 다운로드 실패: {}]", e))
                                }
                            }
                        } else if let Some(sticker) = msg.sticker() {
                            // Sticker — no download, just emoji text.
                            let emoji = sticker.emoji.as_deref().unwrap_or("?");
                            Some(format!("[스티커: {}]", emoji))
                        } else if let Some(loc) = msg.location() {
                            // Location.
                            Some(format!("[위치: 위도 {}, 경도 {}]", loc.latitude, loc.longitude))
                        } else {
                            // Unsupported message type — ignore.
                            None
                        };

                        if let Some(content) = content_opt {
                            let channel_msg = ChannelMessage {
                                id: msg.id.0.to_string(),
                                sender: msg.chat.id.0.to_string(),
                                content,
                                timestamp: msg.date.timestamp(),
                                source: None,
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

            Dispatcher::builder(bot.clone(), handler)
                .build()
                .dispatch()
                .await;

            // If the receiver is closed (normal shutdown), stop the loop.
            if tx.is_closed() {
                info!("telegram channel receiver closed, stopping listener");
                break;
            }

            warn!("telegram dispatcher exited unexpectedly (e.g. TerminatedByOtherGetUpdates), restarting in 5s");
            tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
        }

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
