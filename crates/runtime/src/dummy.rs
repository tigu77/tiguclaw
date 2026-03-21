//! DummyRuntime — returns fixed output for testing purposes.

use async_trait::async_trait;
use tiguclaw_core::error::Result;
use tiguclaw_core::runtime::{CommandOutput, RuntimeAdapter};

/// A mock runtime that returns a fixed response for any command.
pub struct DummyRuntime {
    /// Fixed stdout to return.
    pub fixed_stdout: String,
    /// Fixed exit code to return.
    pub fixed_exit_code: i32,
    /// Whether this runtime reports shell support.
    pub shell_support: bool,
}

impl DummyRuntime {
    pub fn new() -> Self {
        Self {
            fixed_stdout: "dummy output".into(),
            fixed_exit_code: 0,
            shell_support: false,
        }
    }

    pub fn with_output(stdout: impl Into<String>, exit_code: i32) -> Self {
        Self {
            fixed_stdout: stdout.into(),
            fixed_exit_code: exit_code,
            shell_support: true,
        }
    }

    /// Set whether the runtime reports shell support.
    pub fn with_shell(mut self, has_shell: bool) -> Self {
        self.shell_support = has_shell;
        self
    }
}

impl Default for DummyRuntime {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl RuntimeAdapter for DummyRuntime {
    fn has_shell(&self) -> bool {
        self.shell_support
    }

    async fn exec_command(&self, _command: &str) -> Result<CommandOutput> {
        Ok(CommandOutput {
            exit_code: self.fixed_exit_code,
            stdout: self.fixed_stdout.clone(),
            stderr: String::new(),
            truncated: false,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_dummy_default() {
        let rt = DummyRuntime::new();
        assert!(!rt.has_shell());
        let out = rt.exec_command("anything").await.unwrap();
        assert_eq!(out.exit_code, 0);
        assert_eq!(out.stdout, "dummy output");
    }

    #[tokio::test]
    async fn test_dummy_custom() {
        let rt = DummyRuntime::with_output("custom", 42);
        assert!(rt.has_shell());
        let out = rt.exec_command("ignored").await.unwrap();
        assert_eq!(out.exit_code, 42);
        assert_eq!(out.stdout, "custom");
    }

    #[tokio::test]
    async fn test_dummy_shell_toggle() {
        let rt = DummyRuntime::new().with_shell(true);
        assert!(rt.has_shell());
    }
}
