//! ReadFileTool — reads file contents with optional offset/limit.

use async_trait::async_trait;
use serde_json::json;
use std::collections::HashMap;
use std::path::PathBuf;
use tracing::debug;

use tiguclaw_core::error::{Result, TiguError};
use tiguclaw_core::tool::Tool;

const MAX_FILE_SIZE: usize = 50 * 1024; // 50KB

/// Tool that reads the contents of a text file.
pub struct ReadFileTool {
    /// 에이전트 전용 워크스페이스 디렉토리.
    /// Some이면 상대 경로를 이 디렉토리 기준으로 해석한다.
    workspace_dir: Option<PathBuf>,
}

impl ReadFileTool {
    pub fn new() -> Self {
        Self { workspace_dir: None }
    }

    /// 워크스페이스 디렉토리를 설정한다.
    /// 상대 경로 입력 시 이 디렉토리 기준으로 변환된다.
    pub fn with_workspace_dir(self, dir: PathBuf) -> Self {
        Self { workspace_dir: Some(dir) }
    }
}

impl Default for ReadFileTool {
    fn default() -> Self {
        Self::new()
    }
}

/// 경로를 해석한다.
/// - `~`로 시작하면 HOME 디렉토리로 확장
/// - 절대 경로면 그대로 사용
/// - 상대 경로이고 workspace_dir이 있으면 workspace_dir 기준으로 변환
fn resolve_path(raw: &str, workspace_dir: Option<&PathBuf>) -> PathBuf {
    if raw.starts_with('~') {
        let home = std::env::var("HOME").unwrap_or_default();
        PathBuf::from(format!("{}{}", home, &raw[1..]))
    } else {
        let p = PathBuf::from(raw);
        if p.is_absolute() {
            p
        } else if let Some(ws) = workspace_dir {
            ws.join(p)
        } else {
            p
        }
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
        let file_path_raw = args
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

        let path = resolve_path(file_path_raw, self.workspace_dir.as_ref());

        debug!(file_path = %path.display(), ?offset, ?limit, "reading file");

        // Read raw bytes first to detect binary.
        let bytes = tokio::fs::read(&path).await.map_err(|e| {
            TiguError::Tool(format!("failed to read '{}': {}", path.display(), e))
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

    #[tokio::test]
    async fn test_read_relative_path_uses_workspace_dir() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("plan.md");
        std::fs::write(&path, "# Plan").unwrap();

        let tool = ReadFileTool::new().with_workspace_dir(dir.path().to_path_buf());

        let mut args = HashMap::new();
        args.insert("file_path".into(), json!("plan.md"));

        let result = tool.execute(&args).await.unwrap();
        assert_eq!(result, "# Plan");
    }

    #[tokio::test]
    async fn test_read_absolute_path_ignores_workspace_dir() {
        let dir = TempDir::new().unwrap();
        let ws_dir = TempDir::new().unwrap();
        let path = dir.path().join("absolute.txt");
        std::fs::write(&path, "absolute content").unwrap();

        let tool = ReadFileTool::new().with_workspace_dir(ws_dir.path().to_path_buf());

        let mut args = HashMap::new();
        args.insert("file_path".into(), json!(path.to_str().unwrap()));

        let result = tool.execute(&args).await.unwrap();
        assert_eq!(result, "absolute content");
    }
}
