//! SendFileTool — sends a file to the admin via Telegram.

use async_trait::async_trait;
use serde_json::json;
use std::collections::HashMap;
use tracing::info;

use tiguclaw_core::error::{Result, TiguError};
use tiguclaw_core::tool::Tool;

/// Tool that sends a file to the admin via Telegram Bot API.
pub struct SendFileTool {
    bot_token: String,
    admin_chat_id: i64,
}

impl SendFileTool {
    pub fn new(bot_token: impl Into<String>, admin_chat_id: i64) -> Self {
        Self {
            bot_token: bot_token.into(),
            admin_chat_id,
        }
    }
}

#[async_trait]
impl Tool for SendFileTool {
    fn name(&self) -> &str {
        "send_file"
    }

    fn description(&self) -> &str {
        "Send a file to the user via Telegram. Use for documents, images, or any file the user requests."
    }

    fn schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "file_path": {
                    "type": "string",
                    "description": "Path to the file to send."
                },
                "caption": {
                    "type": "string",
                    "description": "Optional caption for the file."
                }
            },
            "required": ["file_path"]
        })
    }

    async fn execute(&self, args: &HashMap<String, serde_json::Value>) -> Result<String> {
        let file_path = args
            .get("file_path")
            .and_then(|v| v.as_str())
            .ok_or_else(|| TiguError::Tool("file_path is required".into()))?;

        let caption = args
            .get("caption")
            .and_then(|v| v.as_str());

        let path = std::path::Path::new(file_path);
        if !path.exists() {
            return Ok(format!("❌ 파일을 찾을 수 없습니다: {file_path}"));
        }

        // Use reqwest multipart to call Telegram sendDocument API.
        let url = format!(
            "https://api.telegram.org/bot{}/sendDocument",
            self.bot_token
        );

        let file_name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("file")
            .to_string();

        let file_bytes = tokio::fs::read(file_path)
            .await
            .map_err(|e| TiguError::Tool(format!("파일 읽기 실패: {e}")))?;

        let file_part = reqwest::multipart::Part::bytes(file_bytes)
            .file_name(file_name.clone());

        let mut form = reqwest::multipart::Form::new()
            .text("chat_id", self.admin_chat_id.to_string())
            .part("document", file_part);

        if let Some(cap) = caption {
            form = form.text("caption", cap.to_string());
        }

        let client = reqwest::Client::new();
        let resp = client
            .post(&url)
            .multipart(form)
            .send()
            .await
            .map_err(|e| TiguError::Tool(format!("전송 실패: {e}")))?;

        if resp.status().is_success() {
            info!(file = %file_path, "file sent to admin via Telegram");
            Ok(format!("✅ 파일 전송 완료: {file_name}"))
        } else {
            let body = resp.text().await.unwrap_or_default();
            Ok(format!("❌ 전송 실패: {body}"))
        }
    }
}
