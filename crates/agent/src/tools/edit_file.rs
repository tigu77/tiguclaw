//! EditFileTool — edits a file by replacing exact text.

use async_trait::async_trait;
use serde_json::json;
use std::collections::HashMap;
use tracing::debug;

use tiguclaw_core::error::{Result, TiguError};
use tiguclaw_core::tool::Tool;

/// Tool that edits a file by replacing an exact text match.
pub struct EditFileTool;

impl EditFileTool {
    pub fn new() -> Self {
        Self
    }
}

impl Default for EditFileTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Tool for EditFileTool {
    fn name(&self) -> &str {
        "edit_file"
    }

    fn description(&self) -> &str {
        "Edit a file by replacing exact text. The old_text must match exactly."
    }

    fn schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "file_path": {
                    "type": "string",
                    "description": "Path to the file to edit."
                },
                "old_text": {
                    "type": "string",
                    "description": "Exact text to find and replace (must match exactly)."
                },
                "new_text": {
                    "type": "string",
                    "description": "New text to replace the old text with."
                }
            },
            "required": ["file_path", "old_text", "new_text"]
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

        let old_text = args
            .get("old_text")
            .and_then(|v| v.as_str())
            .ok_or_else(|| TiguError::Tool("missing 'old_text' argument".into()))?;

        let new_text = args
            .get("new_text")
            .and_then(|v| v.as_str())
            .ok_or_else(|| TiguError::Tool("missing 'new_text' argument".into()))?;

        debug!(file_path, old_len = old_text.len(), new_len = new_text.len(), "editing file");

        // Read the file.
        let content = tokio::fs::read_to_string(file_path).await.map_err(|e| {
            TiguError::Tool(format!("failed to read '{}': {}", file_path, e))
        })?;

        // Count occurrences.
        let count = content.matches(old_text).count();

        match count {
            0 => Ok("old_text not found in file".into()),
            1 => {
                let new_content = content.replacen(old_text, new_text, 1);
                tokio::fs::write(file_path, &new_content).await.map_err(|e| {
                    TiguError::Tool(format!("failed to write '{}': {}", file_path, e))
                })?;

                Ok(format!(
                    "Edited {}: replaced {} chars with {} chars",
                    file_path,
                    old_text.len(),
                    new_text.len()
                ))
            }
            n => Ok(format!(
                "old_text found {} times, must be unique",
                n
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[tokio::test]
    async fn test_edit_replace_success() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("test.txt");
        std::fs::write(&path, "hello world").unwrap();

        let tool = EditFileTool::new();
        let mut args = HashMap::new();
        args.insert("file_path".into(), json!(path.to_str().unwrap()));
        args.insert("old_text".into(), json!("world"));
        args.insert("new_text".into(), json!("rust"));

        let result = tool.execute(&args).await.unwrap();
        assert!(result.contains("Edited"));
        assert!(result.contains("replaced 5 chars with 4 chars"));

        let content = std::fs::read_to_string(&path).unwrap();
        assert_eq!(content, "hello rust");
    }

    #[tokio::test]
    async fn test_edit_old_text_not_found() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("test.txt");
        std::fs::write(&path, "hello world").unwrap();

        let tool = EditFileTool::new();
        let mut args = HashMap::new();
        args.insert("file_path".into(), json!(path.to_str().unwrap()));
        args.insert("old_text".into(), json!("xyz"));
        args.insert("new_text".into(), json!("abc"));

        let result = tool.execute(&args).await.unwrap();
        assert_eq!(result, "old_text not found in file");
    }

    #[tokio::test]
    async fn test_edit_old_text_duplicate() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("test.txt");
        std::fs::write(&path, "aaa bbb aaa").unwrap();

        let tool = EditFileTool::new();
        let mut args = HashMap::new();
        args.insert("file_path".into(), json!(path.to_str().unwrap()));
        args.insert("old_text".into(), json!("aaa"));
        args.insert("new_text".into(), json!("ccc"));

        let result = tool.execute(&args).await.unwrap();
        assert!(result.contains("found 2 times"));

        // File should be unchanged.
        let content = std::fs::read_to_string(&path).unwrap();
        assert_eq!(content, "aaa bbb aaa");
    }
}
