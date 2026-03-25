//! ShellTool — executes shell commands via RuntimeAdapter.

use async_trait::async_trait;
use serde_json::json;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tracing::{debug, warn};

use tiguclaw_core::error::{Result, TiguError};
use tiguclaw_core::runtime::RuntimeAdapter;
use tiguclaw_core::tool::Tool;

/// Tool that executes shell commands using the configured runtime.
pub struct ShellTool {
    runtime: Arc<dyn RuntimeAdapter>,
    /// 에이전트 전용 워크스페이스 디렉토리.
    /// Some이면 모든 명령 앞에 `cd "<dir>" && ` 자동 prefix.
    workspace_dir: Option<PathBuf>,
}

impl ShellTool {
    pub fn new(runtime: Arc<dyn RuntimeAdapter>) -> Self {
        Self { runtime, workspace_dir: None }
    }

    /// 에이전트 전용 워크스페이스 디렉토리를 설정한다.
    ///
    /// 설정 시 모든 shell 명령 앞에 `cd "<dir>" && `를 자동으로 prefix하여
    /// 에이전트가 전용 워크스페이스 내에서 작업하도록 강제한다.
    pub fn with_workspace_dir(self, dir: PathBuf) -> Self {
        Self { workspace_dir: Some(dir), ..self }
    }
}

#[async_trait]
impl Tool for ShellTool {
    fn name(&self) -> &str {
        "shell"
    }

    fn description(&self) -> &str {
        "Execute a shell command on the host system and return its output. \
         Use this to run any CLI command, inspect files, check system status, etc."
    }

    fn schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "description": "The shell command to execute."
                }
            },
            "required": ["command"]
        })
    }

    async fn execute(
        &self,
        args: &HashMap<String, serde_json::Value>,
    ) -> Result<String> {
        let raw_command = args
            .get("command")
            .and_then(|v| v.as_str())
            .ok_or_else(|| TiguError::Tool("missing 'command' argument".into()))?;

        if !self.runtime.has_shell() {
            return Err(TiguError::Tool("runtime does not support shell execution".into()));
        }

        // workspace_dir가 설정된 경우 cd prefix를 추가해 cwd를 강제한다.
        let effective_command: String = match &self.workspace_dir {
            Some(dir) => {
                let dir_str = dir.to_string_lossy();
                format!("cd \"{}\" && {}", dir_str, raw_command)
            }
            None => raw_command.to_string(),
        };
        let command = effective_command.as_str();

        debug!(command, "executing shell tool");

        let output = self.runtime.exec_command(command).await?;

        // Format output for the model.
        let mut result = String::new();
        if !output.stdout.is_empty() {
            result.push_str(&output.stdout);
        }
        if !output.stderr.is_empty() {
            if !result.is_empty() {
                result.push_str("\n--- stderr ---\n");
            }
            result.push_str(&output.stderr);
        }
        if result.is_empty() {
            result.push_str("(no output)");
        }

        if output.exit_code != 0 {
            result.push_str(&format!("\n[exit code: {}]", output.exit_code));
        }
        if output.truncated {
            warn!(command, "output was truncated");
        }

        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tiguclaw_runtime::DummyRuntime;

    #[tokio::test]
    async fn test_shell_tool_basic() {
        let rt = Arc::new(DummyRuntime::with_output("hello world", 0));
        let tool = ShellTool::new(rt);

        assert_eq!(tool.name(), "shell");

        let mut args = HashMap::new();
        args.insert("command".into(), json!("echo hello"));
        let result = tool.execute(&args).await.unwrap();
        assert_eq!(result, "hello world");
    }

    #[tokio::test]
    async fn test_shell_tool_missing_command() {
        let rt = Arc::new(DummyRuntime::new());
        let tool = ShellTool::new(rt);

        let args = HashMap::new();
        let result = tool.execute(&args).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_shell_tool_no_shell() {
        // DummyRuntime has_shell() returns false.
        let rt = Arc::new(DummyRuntime::new());
        let tool = ShellTool::new(rt);

        let mut args = HashMap::new();
        args.insert("command".into(), json!("ls"));
        let result = tool.execute(&args).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_shell_tool_nonzero_exit() {
        let rt = Arc::new(DummyRuntime::with_output("error output", 1));
        let tool = ShellTool::new(rt);

        let mut args = HashMap::new();
        args.insert("command".into(), json!("false"));
        let result = tool.execute(&args).await.unwrap();
        assert!(result.contains("[exit code: 1]"));
    }
}
