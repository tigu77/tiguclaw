//! WebSearchTool — Brave Search API를 사용한 웹 검색 툴.

use async_trait::async_trait;
use serde_json::json;
use std::collections::HashMap;
use std::time::Duration;
use tracing::debug;

use tiguclaw_core::error::{Result, TiguError};
use tiguclaw_core::tool::Tool;

const DEFAULT_COUNT: u64 = 5;
const REQUEST_TIMEOUT_SECS: u64 = 10;
const BRAVE_SEARCH_URL: &str = "https://api.search.brave.com/res/v1/web/search";

/// Tool that searches the web using the Brave Search API.
pub struct WebSearchTool {
    client: reqwest::Client,
    api_key: String,
}

impl WebSearchTool {
    pub fn new(api_key: impl Into<String>) -> Self {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
            .build()
            .expect("failed to build HTTP client for WebSearchTool");
        Self {
            client,
            api_key: api_key.into(),
        }
    }
}

#[async_trait]
impl Tool for WebSearchTool {
    fn name(&self) -> &str {
        "web_search"
    }

    fn description(&self) -> &str {
        "Search the web using Brave Search API. Returns titles, URLs, and descriptions for the query."
    }

    fn schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Search query string."
                },
                "count": {
                    "type": "number",
                    "description": "Number of results to return (default: 5, max: 20)."
                }
            },
            "required": ["query"]
        })
    }

    async fn execute(
        &self,
        args: &HashMap<String, serde_json::Value>,
    ) -> Result<String> {
        let query = args
            .get("query")
            .and_then(|v| v.as_str())
            .ok_or_else(|| TiguError::Tool("missing 'query' argument".into()))?;

        let count = args
            .get("count")
            .and_then(|v| v.as_u64())
            .unwrap_or(DEFAULT_COUNT)
            .min(20);

        debug!(query, count, "searching web via Brave API");

        let response = self
            .client
            .get(BRAVE_SEARCH_URL)
            .query(&[("q", query), ("count", &count.to_string())])
            .header("Accept", "application/json")
            .header("Accept-Encoding", "gzip")
            .header("X-Subscription-Token", &self.api_key)
            .send()
            .await
            .map_err(|e| TiguError::Tool(format!("Brave Search request failed: {e}")))?;

        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            return Err(TiguError::Tool(format!(
                "Brave Search API error {}: {}",
                status.as_u16(),
                body
            )));
        }

        let data: serde_json::Value = response
            .json()
            .await
            .map_err(|e| TiguError::Tool(format!("failed to parse Brave Search response: {e}")))?;

        // Extract web results.
        let results = data
            .get("web")
            .and_then(|w| w.get("results"))
            .and_then(|r| r.as_array());

        match results {
            None => Ok("No results found.".to_string()),
            Some(items) if items.is_empty() => Ok("No results found.".to_string()),
            Some(items) => {
                let mut output = String::new();
                for (i, item) in items.iter().enumerate() {
                    let title = item
                        .get("title")
                        .and_then(|v| v.as_str())
                        .unwrap_or("(no title)");
                    let url = item
                        .get("url")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    let description = item
                        .get("description")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");

                    output.push_str(&format!(
                        "{}. {}\n   URL: {}\n   {}\n\n",
                        i + 1,
                        title,
                        url,
                        description
                    ));
                }
                Ok(output.trim_end().to_string())
            }
        }
    }
}
