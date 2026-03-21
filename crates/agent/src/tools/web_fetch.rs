//! WebFetchTool — fetches and extracts readable content from a URL.

use async_trait::async_trait;
use serde_json::json;
use std::collections::HashMap;
use std::time::Duration;
use tracing::debug;

use tiguclaw_core::error::{Result, TiguError};
use tiguclaw_core::tool::Tool;

const DEFAULT_MAX_CHARS: usize = 10_000;
const REQUEST_TIMEOUT_SECS: u64 = 10;
const USER_AGENT: &str = "tiguclaw/0.1";

/// Tool that fetches and extracts readable content from a URL.
pub struct WebFetchTool {
    client: reqwest::Client,
}

impl WebFetchTool {
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
            .user_agent(USER_AGENT)
            .build()
            .expect("failed to build HTTP client");
        Self { client }
    }

    /// Create with a custom reqwest::Client (for testing or custom config).
    pub fn with_client(client: reqwest::Client) -> Self {
        Self { client }
    }
}

impl Default for WebFetchTool {
    fn default() -> Self {
        Self::new()
    }
}

/// Strip HTML tags using a simple approach (no regex dependency needed).
fn strip_html_tags(html: &str) -> String {
    let mut result = String::with_capacity(html.len());
    let mut in_tag = false;
    let mut in_script = false;
    let mut in_style = false;
    let lower = html.to_lowercase();
    let chars: Vec<char> = html.chars().collect();
    let lower_chars: Vec<char> = lower.chars().collect();

    let mut i = 0;
    while i < chars.len() {
        if !in_tag && chars[i] == '<' {
            in_tag = true;
            // Check for script/style opening tags.
            let remaining: String = lower_chars[i..].iter().take(10).collect();
            if remaining.starts_with("<script") {
                in_script = true;
            } else if remaining.starts_with("<style") {
                in_style = true;
            }
            // Check for closing tags.
            if remaining.starts_with("</script") {
                in_script = false;
            } else if remaining.starts_with("</style") {
                in_style = false;
            }
        } else if in_tag && chars[i] == '>' {
            in_tag = false;
        } else if !in_tag && !in_script && !in_style {
            result.push(chars[i]);
        }
        i += 1;
    }

    // Collapse whitespace and trim.
    let mut cleaned = String::with_capacity(result.len());
    let mut prev_whitespace = false;
    for ch in result.chars() {
        if ch.is_whitespace() {
            if !prev_whitespace {
                cleaned.push(if ch == '\n' { '\n' } else { ' ' });
            }
            prev_whitespace = true;
        } else {
            cleaned.push(ch);
            prev_whitespace = false;
        }
    }

    cleaned.trim().to_string()
}

#[async_trait]
impl Tool for WebFetchTool {
    fn name(&self) -> &str {
        "web_fetch"
    }

    fn description(&self) -> &str {
        "Fetch and extract readable content from a URL."
    }

    fn schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "url": {
                    "type": "string",
                    "description": "HTTP or HTTPS URL to fetch."
                },
                "max_chars": {
                    "type": "number",
                    "description": "Maximum characters to return (default 10000)."
                }
            },
            "required": ["url"]
        })
    }

    async fn execute(
        &self,
        args: &HashMap<String, serde_json::Value>,
    ) -> Result<String> {
        let url = args
            .get("url")
            .and_then(|v| v.as_str())
            .ok_or_else(|| TiguError::Tool("missing 'url' argument".into()))?;

        let max_chars = args
            .get("max_chars")
            .and_then(|v| v.as_u64())
            .map(|v| v as usize)
            .unwrap_or(DEFAULT_MAX_CHARS);

        debug!(url, max_chars, "fetching URL");

        let response = self.client.get(url).send().await.map_err(|e| {
            TiguError::Tool(format!("HTTP request failed for '{}': {}", url, e))
        })?;

        let status = response.status();
        if !status.is_success() {
            return Ok(format!("HTTP error {}: {}", status.as_u16(), status.canonical_reason().unwrap_or("Unknown")));
        }

        let body = response.text().await.map_err(|e| {
            TiguError::Tool(format!("failed to read response body: {}", e))
        })?;

        // Strip HTML tags if content looks like HTML.
        let text = if body.trim_start().starts_with('<') || body.contains("<html") || body.contains("<HTML") {
            strip_html_tags(&body)
        } else {
            body
        };

        // Truncate if needed.
        if text.len() > max_chars {
            let truncated = &text[..max_chars];
            Ok(format!(
                "{}\n\n[truncated: content exceeds {} char limit]",
                truncated, max_chars
            ))
        } else {
            Ok(text)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_strip_html_basic() {
        let html = "<html><body><h1>Title</h1><p>Hello world</p></body></html>";
        let text = strip_html_tags(html);
        assert!(text.contains("Title"));
        assert!(text.contains("Hello world"));
        assert!(!text.contains("<h1>"));
        assert!(!text.contains("<p>"));
    }

    #[test]
    fn test_strip_html_script_style() {
        let html = "<html><head><style>body{color:red}</style><script>alert('hi')</script></head><body>Content</body></html>";
        let text = strip_html_tags(html);
        assert!(text.contains("Content"));
        assert!(!text.contains("alert"));
        assert!(!text.contains("color:red"));
    }

    #[test]
    fn test_strip_html_plain_text() {
        let text = "Just plain text, no HTML.";
        let result = strip_html_tags(text);
        assert_eq!(result, text);
    }

    #[tokio::test]
    async fn test_web_fetch_missing_url() {
        let tool = WebFetchTool::new();
        let args = HashMap::new();
        let result = tool.execute(&args).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_web_fetch_schema() {
        let tool = WebFetchTool::new();
        let schema = tool.schema();
        assert_eq!(schema["required"][0], "url");
        assert!(schema["properties"]["url"].is_object());
        assert!(schema["properties"]["max_chars"].is_object());
    }
}
