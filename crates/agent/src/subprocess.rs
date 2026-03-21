//! Sub-agent spawning and management for the multi-agent process tree.
//!
//! Each sub-agent runs as an independent tokio task, communicating with
//! the parent via channels. Sub-agents have no direct channel access —
//! they report exclusively to their parent.

use std::sync::Arc;
use tokio::sync::{mpsc, RwLock};
use tracing::{debug, error, info};
use uuid::Uuid;

use tiguclaw_core::provider::{Provider, ToolDefinition};
use tiguclaw_core::types::ChatMessage;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// Unique identifier for a sub-agent.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct SubAgentId(pub String);

impl std::fmt::Display for SubAgentId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// Commands sent from parent → sub-agent.
#[derive(Debug)]
pub enum SubAgentCommand {
    /// Redirect / steer the sub-agent with additional context.
    Steer(String),
    /// Terminate immediately.
    Kill,
}

/// Lifecycle status of a sub-agent.
#[derive(Debug, Clone, PartialEq)]
pub enum SubAgentStatus {
    Running,
    Completed(String),
    Failed(String),
    Killed,
}

impl std::fmt::Display for SubAgentStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Running => write!(f, "🔄 Running"),
            Self::Completed(r) => write!(f, "✅ Completed: {r}"),
            Self::Failed(e) => write!(f, "❌ Failed: {e}"),
            Self::Killed => write!(f, "🛑 Killed"),
        }
    }
}

/// Report sent from sub-agent → parent upon completion.
#[derive(Debug)]
pub struct SubAgentReport {
    pub agent_id: SubAgentId,
    pub label: String,
    pub status: SubAgentStatus,
}

// ---------------------------------------------------------------------------
// Handle (internal)
// ---------------------------------------------------------------------------

/// Handle to a running sub-agent task.
#[allow(dead_code)]
struct SubAgentHandle {
    id: SubAgentId,
    label: String,
    command_tx: mpsc::Sender<SubAgentCommand>,
    status: Arc<RwLock<SubAgentStatus>>,
    join_handle: tokio::task::JoinHandle<()>,
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

/// Manages the lifecycle of child sub-agents.
pub struct SubAgentManager {
    agents: Vec<SubAgentHandle>,
}

impl Default for SubAgentManager {
    fn default() -> Self {
        Self::new()
    }
}

impl SubAgentManager {
    pub fn new() -> Self {
        Self {
            agents: Vec::new(),
        }
    }

    /// Spawn a new sub-agent.
    ///
    /// The sub-agent runs `provider.chat()` with the given `system_prompt` and
    /// `task`, then reports the result via `report_tx`. It listens for
    /// `Steer` / `Kill` commands while processing.
    pub async fn spawn(
        &mut self,
        label: String,
        provider: Arc<dyn Provider>,
        system_prompt: String,
        task: String,
        report_tx: mpsc::Sender<SubAgentReport>,
    ) -> SubAgentId {
        let id = SubAgentId(Uuid::new_v4().to_string());
        let (command_tx, command_rx) = mpsc::channel::<SubAgentCommand>(16);
        let status = Arc::new(RwLock::new(SubAgentStatus::Running));

        let agent_id = id.clone();
        let agent_label = label.clone();
        let status_clone = status.clone();

        let join_handle = tokio::spawn(async move {
            let result = run_sub_agent(
                provider,
                system_prompt,
                task,
                command_rx,
                status_clone.clone(),
            )
            .await;

            // Update final status.
            let final_status = {
                let current = status_clone.read().await;
                if *current == SubAgentStatus::Killed {
                    SubAgentStatus::Killed
                } else {
                    match &result {
                        Ok(text) => SubAgentStatus::Completed(text.clone()),
                        Err(e) => SubAgentStatus::Failed(e.to_string()),
                    }
                }
            };

            {
                let mut s = status_clone.write().await;
                *s = final_status.clone();
            }

            // Report to parent.
            let report = SubAgentReport {
                agent_id,
                label: agent_label,
                status: final_status,
            };
            if let Err(e) = report_tx.send(report).await {
                error!("failed to send sub-agent report: {e}");
            }
        });

        info!(id = %id, label = %label, "sub-agent spawned");

        self.agents.push(SubAgentHandle {
            id: id.clone(),
            label,
            command_tx,
            status,
            join_handle,
        });

        id
    }

    /// Send a steer command to redirect a sub-agent.
    pub async fn steer(&self, id: &SubAgentId, message: String) -> anyhow::Result<()> {
        let handle = self
            .agents
            .iter()
            .find(|a| a.id == *id)
            .ok_or_else(|| anyhow::anyhow!("sub-agent not found: {}", id.0))?;

        handle
            .command_tx
            .send(SubAgentCommand::Steer(message))
            .await
            .map_err(|_| anyhow::anyhow!("sub-agent channel closed"))?;

        Ok(())
    }

    /// Kill a sub-agent.
    pub async fn kill(&self, id: &SubAgentId) -> anyhow::Result<()> {
        let handle = self
            .agents
            .iter()
            .find(|a| a.id == *id)
            .ok_or_else(|| anyhow::anyhow!("sub-agent not found: {}", id.0))?;

        // Update status first so the task sees it.
        {
            let mut s = handle.status.write().await;
            *s = SubAgentStatus::Killed;
        }

        let _ = handle.command_tx.send(SubAgentCommand::Kill).await;
        Ok(())
    }

    /// Find a sub-agent by label and steer it.
    pub async fn steer_by_label(&self, label: &str, message: String) -> anyhow::Result<()> {
        let id = self.find_id_by_label(label)?;
        self.steer(&id, message).await
    }

    /// Find a sub-agent by label and kill it.
    pub async fn kill_by_label(&self, label: &str) -> anyhow::Result<()> {
        let id = self.find_id_by_label(label)?;
        self.kill(&id).await
    }

    /// List all agents with their current status.
    pub fn list(&self) -> Vec<(SubAgentId, String, SubAgentStatus)> {
        // Use try_read to avoid blocking; fall back to Running if locked.
        self.agents
            .iter()
            .map(|a| {
                let status = match a.status.try_read() {
                    Ok(s) => s.clone(),
                    Err(_) => SubAgentStatus::Running,
                };
                (a.id.clone(), a.label.clone(), status)
            })
            .collect()
    }

    /// Remove completed/failed/killed agents from the list.
    pub fn cleanup(&mut self) {
        self.agents.retain(|a| {
            match a.status.try_read() {
                Ok(s) => *s == SubAgentStatus::Running,
                Err(_) => true, // keep if can't read (probably still running)
            }
        });
    }

    fn find_id_by_label(&self, label: &str) -> anyhow::Result<SubAgentId> {
        self.agents
            .iter()
            .find(|a| a.label == label)
            .map(|a| a.id.clone())
            .ok_or_else(|| anyhow::anyhow!("sub-agent '{label}' not found"))
    }
}

// ---------------------------------------------------------------------------
// Sub-agent task
// ---------------------------------------------------------------------------

/// Core execution loop for a sub-agent.
///
/// Calls `provider.chat()` with the task, then listens for steer/kill.
/// On steer, appends a user message and calls chat again.
async fn run_sub_agent(
    provider: Arc<dyn Provider>,
    system_prompt: String,
    task: String,
    mut command_rx: mpsc::Receiver<SubAgentCommand>,
    status: Arc<RwLock<SubAgentStatus>>,
) -> anyhow::Result<String> {
    let mut messages = vec![
        ChatMessage::system(&system_prompt),
        ChatMessage::user(&task),
    ];
    let no_tools: Vec<ToolDefinition> = Vec::new();

    debug!(task = %task, "sub-agent starting task");

    // Initial chat call.
    let response = provider
        .chat(&messages, &no_tools)
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))?;

    messages.push(ChatMessage::assistant(&response.text));
    let mut last_result = response.text;

    // Listen for steer/kill commands.
    loop {
        // Check if killed.
        {
            let s = status.read().await;
            if *s == SubAgentStatus::Killed {
                return Ok(last_result);
            }
        }

        // Non-blocking check for commands.
        match command_rx.try_recv() {
            Ok(SubAgentCommand::Kill) => {
                info!("sub-agent received kill");
                return Ok(last_result);
            }
            Ok(SubAgentCommand::Steer(msg)) => {
                debug!(steer = %msg, "sub-agent steered");
                messages.push(ChatMessage::user(&msg));

                let response = provider
                    .chat(&messages, &no_tools)
                    .await
                    .map_err(|e| anyhow::anyhow!("{e}"))?;

                messages.push(ChatMessage::assistant(&response.text));
                last_result = response.text;
            }
            Err(mpsc::error::TryRecvError::Empty) => {
                // No more commands — we're done with initial task.
                break;
            }
            Err(mpsc::error::TryRecvError::Disconnected) => {
                break;
            }
        }
    }

    Ok(last_result)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use tiguclaw_core::error::Result;
    use tiguclaw_core::types::{ChatResponse, Usage};

    /// Provider that returns the task text as the response.
    struct EchoProvider;

    #[async_trait]
    impl Provider for EchoProvider {
        fn name(&self) -> &str {
            "echo"
        }

        async fn chat(
            &self,
            messages: &[ChatMessage],
            _tools: &[ToolDefinition],
        ) -> Result<ChatResponse> {
            // Return the last user message as the response.
            let last_user = messages
                .iter()
                .rev()
                .find(|m| m.role == tiguclaw_core::types::Role::User)
                .map(|m| m.content.clone())
                .unwrap_or_default();

            Ok(ChatResponse {
                text: format!("echo: {last_user}"),
                tool_calls: Vec::new(),
                usage: Usage::default(),
            })
        }
    }

    /// Provider that always fails.
    struct FailProvider;

    #[async_trait]
    impl Provider for FailProvider {
        fn name(&self) -> &str {
            "fail"
        }

        async fn chat(
            &self,
            _messages: &[ChatMessage],
            _tools: &[ToolDefinition],
        ) -> Result<ChatResponse> {
            Err(tiguclaw_core::error::TiguError::Provider(
                "simulated failure".into(),
            ))
        }
    }

    #[tokio::test]
    async fn test_spawn_and_complete() {
        let (report_tx, mut report_rx) = mpsc::channel(8);
        let mut manager = SubAgentManager::new();

        let provider = Arc::new(EchoProvider);
        let id = manager
            .spawn(
                "test-agent".into(),
                provider,
                "You are a test.".into(),
                "do something".into(),
                report_tx,
            )
            .await;

        // Wait for report.
        let report = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            report_rx.recv(),
        )
        .await
        .expect("timeout")
        .expect("no report");

        assert_eq!(report.agent_id, id);
        assert_eq!(report.label, "test-agent");
        match &report.status {
            SubAgentStatus::Completed(text) => {
                assert!(text.contains("echo: do something"));
            }
            other => panic!("expected Completed, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn test_spawn_failure() {
        let (report_tx, mut report_rx) = mpsc::channel(8);
        let mut manager = SubAgentManager::new();

        let provider = Arc::new(FailProvider);
        manager
            .spawn(
                "fail-agent".into(),
                provider,
                "system".into(),
                "task".into(),
                report_tx,
            )
            .await;

        let report = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            report_rx.recv(),
        )
        .await
        .expect("timeout")
        .expect("no report");

        match &report.status {
            SubAgentStatus::Failed(e) => {
                assert!(e.contains("simulated failure"));
            }
            other => panic!("expected Failed, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn test_kill_agent() {
        let (report_tx, mut report_rx) = mpsc::channel(8);
        let mut manager = SubAgentManager::new();

        /// Slow provider that waits before responding.
        struct SlowProvider;

        #[async_trait]
        impl Provider for SlowProvider {
            fn name(&self) -> &str {
                "slow"
            }

            async fn chat(
                &self,
                _messages: &[ChatMessage],
                _tools: &[ToolDefinition],
            ) -> Result<ChatResponse> {
                tokio::time::sleep(std::time::Duration::from_secs(10)).await;
                Ok(ChatResponse {
                    text: "done".into(),
                    tool_calls: Vec::new(),
                    usage: Usage::default(),
                })
            }
        }

        let provider = Arc::new(SlowProvider);
        let id = manager
            .spawn(
                "slow-agent".into(),
                provider,
                "system".into(),
                "task".into(),
                report_tx,
            )
            .await;

        // Kill immediately.
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        manager.kill(&id).await.unwrap();

        // The join handle gets aborted indirectly; we just verify status.
        let status = manager.agents[0].status.read().await.clone();
        assert_eq!(status, SubAgentStatus::Killed);
    }

    #[tokio::test]
    async fn test_list_agents() {
        let (report_tx, _report_rx) = mpsc::channel(8);
        let mut manager = SubAgentManager::new();
        let provider = Arc::new(EchoProvider);

        manager
            .spawn(
                "agent-1".into(),
                provider.clone(),
                "sys".into(),
                "t1".into(),
                report_tx.clone(),
            )
            .await;

        manager
            .spawn(
                "agent-2".into(),
                provider,
                "sys".into(),
                "t2".into(),
                report_tx,
            )
            .await;

        let list = manager.list();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].1, "agent-1");
        assert_eq!(list[1].1, "agent-2");
    }

    #[tokio::test]
    async fn test_cleanup() {
        let (report_tx, mut report_rx) = mpsc::channel(8);
        let mut manager = SubAgentManager::new();
        let provider = Arc::new(EchoProvider);

        manager
            .spawn(
                "done-agent".into(),
                provider,
                "sys".into(),
                "task".into(),
                report_tx,
            )
            .await;

        // Wait for completion.
        let _ = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            report_rx.recv(),
        )
        .await;

        // Small delay for status to propagate.
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        manager.cleanup();
        assert_eq!(manager.agents.len(), 0);
    }
}
