//! WriteFileTool — writes content to a file, creating parent directories as needed.

use async_trait::async_trait;
use serde_json::json;
use std::collections::HashMap;
use std::path::PathBuf;
use tracing::debug;

use tiguclaw_core::error::{Result, TiguError};
use tiguclaw_core::tool::Tool;

/// Tool that writes content to a file.
pub struct WriteFileTool {
    /// 에이전트 전용 워크스페이스 디렉토리.
    /// Some이면 상대 경로를 이 디렉토리 기준으로 해석한다.
    workspace_dir: Option<PathBuf>,
}

impl WriteFileTool {
    pub fn new() -> Self {
        Self { workspace_dir: None }
    }

    /// 워크스페이스 디렉토리를 설정한다.
    /// 상대 경로 입력 시 이 디렉토리 기준으로 변환된다.
    pub fn with_workspace_dir(self, dir: PathBuf) -> Self {
        Self { workspace_dir: Some(dir) }
    }
}

impl Default for WriteFileTool {
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
        let file_path_raw = args
            .get("file_path")
            .and_then(|v| v.as_str())
            .ok_or_else(|| TiguError::Tool("missing 'file_path' argument".into()))?;

        let content = args
            .get("content")
            .and_then(|v| v.as_str())
            .ok_or_else(|| TiguError::Tool("missing 'content' argument".into()))?;

        let path = resolve_path(file_path_raw, self.workspace_dir.as_ref());

        debug!(file_path = %path.display(), content_len = content.len(), "writing file");

        // Create parent directories if needed.
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                tokio::fs::create_dir_all(parent).await.map_err(|e| {
                    TiguError::Tool(format!(
                        "failed to create directories for '{}': {}",
                        path.display(), e
                    ))
                })?;
            }
        }

        let bytes = content.len();
        tokio::fs::write(&path, content).await.map_err(|e| {
            TiguError::Tool(format!("failed to write '{}': {}", path.display(), e))
        })?;

        Ok(format!("Written {} bytes to {}", bytes, path.display()))
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

    #[tokio::test]
    async fn test_write_relative_path_uses_workspace_dir() {
        let dir = TempDir::new().unwrap();
        let tool = WriteFileTool::new().with_workspace_dir(dir.path().to_path_buf());

        let mut args = HashMap::new();
        args.insert("file_path".into(), json!("plan.md"));
        args.insert("content".into(), json!("# Plan"));

        let result = tool.execute(&args).await.unwrap();
        assert!(result.contains("Written"));

        let expected = dir.path().join("plan.md");
        let content = std::fs::read_to_string(expected).unwrap();
        assert_eq!(content, "# Plan");
    }

    #[tokio::test]
    async fn test_write_absolute_path_ignores_workspace_dir() {
        let dir = TempDir::new().unwrap();
        let ws_dir = TempDir::new().unwrap();
        let path = dir.path().join("absolute.txt");

        let tool = WriteFileTool::new().with_workspace_dir(ws_dir.path().to_path_buf());

        let mut args = HashMap::new();
        args.insert("file_path".into(), json!(path.to_str().unwrap()));
        args.insert("content".into(), json!("absolute"));

        let result = tool.execute(&args).await.unwrap();
        assert!(result.contains("Written"));
        assert!(std::fs::read_to_string(&path).is_ok());
    }
}
