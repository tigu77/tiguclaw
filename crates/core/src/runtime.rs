//! RuntimeAdapter trait — abstraction over command execution environments.

use async_trait::async_trait;
use crate::error::Result;

/// Output from a command execution.
#[derive(Debug, Clone)]
pub struct CommandOutput {
    /// Exit code (0 = success).
    pub exit_code: i32,
    /// Captured stdout (may be truncated).
    pub stdout: String,
    /// Captured stderr (may be truncated).
    pub stderr: String,
    /// Whether the output was truncated due to size limits.
    pub truncated: bool,
}

/// A runtime that can execute shell commands.
#[async_trait]
pub trait RuntimeAdapter: Send + Sync {
    /// Whether this runtime supports shell execution.
    fn has_shell(&self) -> bool;

    /// Execute a command and return its output.
    async fn exec_command(&self, command: &str) -> Result<CommandOutput>;
}
