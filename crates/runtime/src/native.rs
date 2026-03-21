//! NativeRuntime — executes shell commands on the host OS via tokio::process.

use async_trait::async_trait;
use tiguclaw_core::error::{Result, TiguError};
use tiguclaw_core::runtime::{CommandOutput, RuntimeAdapter};
use tokio::process::Command;
use tracing::{debug, warn};

/// Runtime that executes commands natively on macOS/Linux.
pub struct NativeRuntime {
    /// Shell binary path (e.g. "/bin/zsh").
    shell: String,
    /// Maximum execution time in seconds.
    timeout_secs: u64,
    /// Maximum output size in bytes before truncation.
    max_output_bytes: usize,
}

impl NativeRuntime {
    pub fn new(shell: String, timeout_secs: u64, max_output_bytes: usize) -> Self {
        Self { shell, timeout_secs, max_output_bytes }
    }

    /// Create from a core Config's runtime section.
    pub fn from_config(cfg: &tiguclaw_core::config::RuntimeConfig) -> Self {
        Self::new(cfg.shell.clone(), cfg.timeout_secs, cfg.max_output_bytes)
    }

    /// Truncate a string to at most `max_bytes` bytes, appending a notice if truncated.
    fn truncate_output(&self, raw: &str) -> (String, bool) {
        if raw.len() <= self.max_output_bytes {
            return (raw.to_string(), false);
        }
        // Find a valid UTF-8 boundary.
        let mut end = self.max_output_bytes;
        while end > 0 && !raw.is_char_boundary(end) {
            end -= 1;
        }
        let truncated = format!(
            "{}\n\n--- output truncated ({} / {} bytes) ---",
            &raw[..end],
            self.max_output_bytes,
            raw.len()
        );
        (truncated, true)
    }
}

#[async_trait]
impl RuntimeAdapter for NativeRuntime {
    fn has_shell(&self) -> bool {
        true
    }

    async fn exec_command(&self, command: &str) -> Result<CommandOutput> {
        debug!(command, "executing shell command");

        let child = Command::new(&self.shell)
            .arg("-c")
            .arg(command)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| TiguError::Runtime(format!("failed to spawn: {e}")))?;

        let timeout = tokio::time::Duration::from_secs(self.timeout_secs);
        let result = tokio::time::timeout(timeout, child.wait_with_output()).await;

        match result {
            Ok(Ok(output)) => {
                let raw_stdout = String::from_utf8_lossy(&output.stdout).to_string();
                let raw_stderr = String::from_utf8_lossy(&output.stderr).to_string();
                let (stdout, stdout_truncated) = self.truncate_output(&raw_stdout);
                let (stderr, stderr_truncated) = self.truncate_output(&raw_stderr);
                let truncated = stdout_truncated || stderr_truncated;

                let exit_code = output.status.code().unwrap_or(-1);
                debug!(exit_code, truncated, "command finished");

                Ok(CommandOutput { exit_code, stdout, stderr, truncated })
            }
            Ok(Err(e)) => {
                Err(TiguError::Runtime(format!("command failed: {e}")))
            }
            Err(_) => {
                warn!(command, timeout_secs = self.timeout_secs, "command timed out");
                Err(TiguError::Timeout(self.timeout_secs))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_echo() {
        let rt = NativeRuntime::new("/bin/sh".into(), 5, 50000);
        let out = rt.exec_command("echo hello").await.unwrap();
        assert_eq!(out.exit_code, 0);
        assert_eq!(out.stdout.trim(), "hello");
        assert!(!out.truncated);
    }

    #[tokio::test]
    async fn test_truncation() {
        let rt = NativeRuntime::new("/bin/sh".into(), 5, 10);
        let out = rt.exec_command("echo 'abcdefghijklmnopqrstuvwxyz'").await.unwrap();
        assert!(out.truncated);
        assert!(out.stdout.contains("truncated"));
    }

    #[tokio::test]
    async fn test_timeout() {
        let rt = NativeRuntime::new("/bin/sh".into(), 1, 50000);
        let result = rt.exec_command("sleep 10").await;
        assert!(matches!(result, Err(TiguError::Timeout(_))));
    }
}
