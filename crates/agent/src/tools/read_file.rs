//! ReadFileTool — reads file contents with optional offset/limit.

use async_trait::async_trait;
use serde_json::json;
use std::collections::HashMap;
use tracing::debug;

use tiguclaw_core::error::{Result, TiguError};
use tiguclaw_core::tool::Tool;

const MAX_FILE_SIZE: usize = 50 * 1024; // 50KB

/// Tool that reads the contents of a text file.
pub struct ReadFileTool;

impl ReadFileTool {
    pub fn new() -> Self {
        Self
    }
}

impl Default for ReadFileTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Tool for ReadFileTool {
    fn name(&self) -> &str {
        "read_file"
    }

    fn description(&self) -> &str {
        "Read the contents of a file. Supports text files."
    }

    fn schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "file_path": {
                    "type": "string",
                    "description": "Path to the file to read."
                },
                "offset": {
                    "type": "number",
                    "description": "Line number to start reading from (1-indexed)."
                },
                "limit": {
                    "type": "number",
                    "description": "Maximum number of lines to read."
                }
            },
            "required": ["file_path"]
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

        let offset = args
            .get("offset")
            .and_then(|v| v.as_u64())
            .map(|v| v as usize);

        let limit = args
            .get("limit")
            .and_then(|v| v.as_u64())
            .map(|v| v as usize);

        debug!(file_path, ?offset, ?limit, "reading file");

        // Expand leading `~` to the home directory.
        let expanded_path;
        let file_path = if file_path.starts_with('~') {
            let home = std::env::var("HOME").unwrap_or_default();
            expanded_path = format!("{}{}", home, &file_path[1..]);
            expanded_path.as_str()
        } else {
            file_path
        };

        // Read raw bytes first to detect binary.
        let bytes = tokio::fs::read(file_path).await.map_err(|e| {
            TiguError::Tool(format!("failed to read '{}': {}", file_path, e))
        })?;

        // Binary detection: check for null bytes in first 8KB.
        let check_len = bytes.len().min(8192);
        if bytes[..check_len].contains(&0) {
            return Ok("Binary file, cannot read as text".into());
        }

        let content = String::from_utf8(bytes).map_err(|_| {
            TiguError::Tool("Binary file, cannot read as text".into())
        })?;

        // Apply offset/limit if specified.
        let output = if offset.is_some() || limit.is_some() {
            let lines: Vec<&str> = content.lines().collect();
            let start = offset.unwrap_or(1).saturating_sub(1); // 1-indexed → 0-indexed
            let end = if let Some(lim) = limit {
                (start + lim).min(lines.len())
            } else {
                lines.len()
            };

            if start >= lines.len() {
                return Ok(format!(
                    "Offset {} exceeds file length ({} lines)",
                    start + 1,
                    lines.len()
                ));
            }

            lines[start..end].join("\n")
        } else {
            content
        };

        // Truncate if too large.
        if output.len() > MAX_FILE_SIZE {
            let truncated = &output[..MAX_FILE_SIZE];
            Ok(format!(
                "{}\n\n[truncated: file exceeds 50KB limit, showing first 50KB]",
                truncated
            ))
        } else {
            Ok(output)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::TempDir;

    #[tokio::test]
    async fn test_read_existing_file() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("test.txt");
        std::fs::write(&path, "hello\nworld\n").unwrap();

        let tool = ReadFileTool::new();
        let mut args = HashMap::new();
        args.insert("file_path".into(), json!(path.to_str().unwrap()));

        let result = tool.execute(&args).await.unwrap();
        assert!(result.contains("hello"));
        assert!(result.contains("world"));
    }

    #[tokio::test]
    async fn test_read_with_offset_and_limit() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("lines.txt");
        std::fs::write(&path, "line1\nline2\nline3\nline4\nline5\n").unwrap();

        let tool = ReadFileTool::new();
        let mut args = HashMap::new();
        args.insert("file_path".into(), json!(path.to_str().unwrap()));
        args.insert("offset".into(), json!(2));
        args.insert("limit".into(), json!(2));

        let result = tool.execute(&args).await.unwrap();
        assert!(result.contains("line2"));
        assert!(result.contains("line3"));
        assert!(!result.contains("line1"));
        assert!(!result.contains("line4"));
    }

    #[tokio::test]
    async fn test_read_nonexistent_file() {
        let tool = ReadFileTool::new();
        let mut args = HashMap::new();
        args.insert("file_path".into(), json!("/tmp/nonexistent_tiguclaw_test_file.txt"));

        let result = tool.execute(&args).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_read_binary_file() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("binary.bin");
        let mut f = std::fs::File::create(&path).unwrap();
        f.write_all(&[0x00, 0x01, 0x02, 0xFF]).unwrap();

        let tool = ReadFileTool::new();
        let mut args = HashMap::new();
        args.insert("file_path".into(), json!(path.to_str().unwrap()));

        let result = tool.execute(&args).await.unwrap();
        assert_eq!(result, "Binary file, cannot read as text");
    }
}
