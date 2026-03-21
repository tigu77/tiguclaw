//! WriteFileTool — writes content to a file, creating parent directories as needed.

use async_trait::async_trait;
use serde_json::json;
use std::collections::HashMap;
use tracing::debug;

use tiguclaw_core::error::{Result, TiguError};
use tiguclaw_core::tool::Tool;

/// Tool that writes content to a file.
pub struct WriteFileTool;

impl WriteFileTool {
    pub fn new() -> Self {
        Self
    }
}

impl Default for WriteFileTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Tool for WriteFileTool {
    fn name(&self) -> &str {
        "write_file"
    }

    fn description(&self) -> &str {
        "Write content to a file. Creates parent directories if needed. Overwrites existing files."
    }

    fn schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "file_path": {
                    "type": "string",
                    "description": "Path to the file to write."
                },
                "content": {
                    "type": "string",
                    "description": "Content to write to the file."
                }
            },
            "required": ["file_path", "content"]
        })
    }

    async fn execute(
        &self,
        args: &HashMap<String, serde_json::Value>,
    ) -> Result<String> {
        let file_path = args
            .get("file_path")
            .and_then(|v| v.as_str())
            .ok_or_else(|| TiguError::Tool("missing 'file_path' argument".into()))?;

        let content = args
            .get("content")
            .and_then(|v| v.as_str())
            .ok_or_else(|| TiguError::Tool("missing 'content' argument".into()))?;

        debug!(file_path, content_len = content.len(), "writing file");

        // Create parent directories if needed.
        let path = std::path::Path::new(file_path);
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                tokio::fs::create_dir_all(parent).await.map_err(|e| {
                    TiguError::Tool(format!(
                        "failed to create directories for '{}': {}",
                        file_path, e
                    ))
                })?;
            }
        }

        let bytes = content.len();
        tokio::fs::write(file_path, content).await.map_err(|e| {
            TiguError::Tool(format!("failed to write '{}': {}", file_path, e))
        })?;

        Ok(format!("Written {} bytes to {}", bytes, file_path))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[tokio::test]
    async fn test_write_new_file() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("output.txt");

        let tool = WriteFileTool::new();
        let mut args = HashMap::new();
        args.insert("file_path".into(), json!(path.to_str().unwrap()));
        args.insert("content".into(), json!("hello world"));

        let result = tool.execute(&args).await.unwrap();
        assert!(result.contains("Written"));
        assert!(result.contains("11 bytes"));

        let content = std::fs::read_to_string(&path).unwrap();
        assert_eq!(content, "hello world");
    }

    #[tokio::test]
    async fn test_write_creates_directories() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("a").join("b").join("c").join("file.txt");

        let tool = WriteFileTool::new();
        let mut args = HashMap::new();
        args.insert("file_path".into(), json!(path.to_str().unwrap()));
        args.insert("content".into(), json!("nested"));

        let result = tool.execute(&args).await.unwrap();
        assert!(result.contains("Written"));

        let content = std::fs::read_to_string(&path).unwrap();
        assert_eq!(content, "nested");
    }

    #[tokio::test]
    async fn test_write_overwrites_existing() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("existing.txt");
        std::fs::write(&path, "old content").unwrap();

        let tool = WriteFileTool::new();
        let mut args = HashMap::new();
        args.insert("file_path".into(), json!(path.to_str().unwrap()));
        args.insert("content".into(), json!("new content"));

        tool.execute(&args).await.unwrap();

        let content = std::fs::read_to_string(&path).unwrap();
        assert_eq!(content, "new content");
    }
}
