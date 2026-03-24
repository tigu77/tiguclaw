//! MemorySearchTool — 에이전트 메모리에서 관련 정보를 검색한다.

use async_trait::async_trait;
use serde_json::json;
use std::collections::HashMap;
use std::sync::Arc;

use tiguclaw_core::error::{Result, TiguError};
use tiguclaw_core::tool::Tool;
use tiguclaw_memory::MemoryBackend;

const DEFAULT_LIMIT: usize = 5;

/// Agent memory search tool.
///
/// FTS5 (BM25) + 벡터 + 시간 decay 하이브리드 검색을 지원하는 메모리 백엔드를 사용한다.
pub struct MemorySearchTool {
    memory: Arc<dyn MemoryBackend>,
}

impl MemorySearchTool {
    pub fn new(memory: Arc<dyn MemoryBackend>) -> Self {
        Self { memory }
    }
}

#[async_trait]
impl Tool for MemorySearchTool {
    fn name(&self) -> &str {
        "memory_search"
    }

    fn description(&self) -> &str {
        "Search agent memory for relevant information. \
         Use before answering questions about past work, decisions, or context."
    }

    fn schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Search query string."
                },
                "limit": {
                    "type": "number",
                    "description": "Maximum number of results to return (default 5)."
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

        let limit = args
            .get("limit")
            .and_then(|v| v.as_u64())
            .map(|v| v as usize)
            .unwrap_or(DEFAULT_LIMIT);

        let results = self
            .memory
            .search(query, limit)
            .map_err(|e| TiguError::Tool(format!("memory search failed: {e}")))?;

        if results.is_empty() {
            return Ok("No relevant memories found.".into());
        }

        let mut output = format!("Found {} result(s):\n\n", results.len());
        for (i, r) in results.iter().enumerate() {
            output.push_str(&format!(
                "{}. [score: {:.3}] [source: {}]\n{}\n\n",
                i + 1,
                r.score,
                r.source,
                r.content,
            ));
        }

        Ok(output.trim_end().to_string())
    }
}
