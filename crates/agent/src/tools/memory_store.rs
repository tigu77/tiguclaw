//! MemoryStoreTool — 에이전트 메모리에 중요 정보를 저장한다.

use async_trait::async_trait;
use serde_json::json;
use std::collections::HashMap;
use std::sync::Arc;

use tiguclaw_core::error::{Result, TiguError};
use tiguclaw_core::tool::Tool;
use tiguclaw_memory::{MemoryBackend, MemoryEntry};

/// Agent memory store tool.
///
/// 에이전트가 중요한 정보를 메모리 백엔드에 저장하고, 저장된 항목의 ID를 반환한다.
pub struct MemoryStoreTool {
    memory: Arc<dyn MemoryBackend>,
    /// 메모리 항목의 출처 (에이전트 이름). 기본값 "agent".
    source: String,
}

impl MemoryStoreTool {
    pub fn new(memory: Arc<dyn MemoryBackend>) -> Self {
        Self {
            memory,
            source: "agent".to_string(),
        }
    }

    /// 저장 항목의 출처(source)를 에이전트 이름으로 설정한다.
    pub fn with_source(mut self, source: impl Into<String>) -> Self {
        self.source = source.into();
        self
    }
}

#[async_trait]
impl Tool for MemoryStoreTool {
    fn name(&self) -> &str {
        "memory_store"
    }

    fn description(&self) -> &str {
        "Store important information in agent memory for future retrieval."
    }

    fn schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "content": {
                    "type": "string",
                    "description": "Information to store in memory."
                },
                "tags": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "Optional list of tags for categorization."
                }
            },
            "required": ["content"]
        })
    }

    async fn execute(
        &self,
        args: &HashMap<String, serde_json::Value>,
    ) -> Result<String> {
        let content = args
            .get("content")
            .and_then(|v| v.as_str())
            .ok_or_else(|| TiguError::Tool("missing 'content' argument".into()))?
            .to_string();

        let tags: Vec<String> = args
            .get("tags")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default();

        let entry = MemoryEntry {
            content,
            source: self.source.clone(),
            tags,
            metadata: None,
        };

        let id = self
            .memory
            .store(entry)
            .map_err(|e| TiguError::Tool(format!("memory store failed: {e}")))?;

        Ok(format!("Stored memory with id: {id}"))
    }
}
