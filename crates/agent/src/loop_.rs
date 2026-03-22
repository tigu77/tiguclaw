//! Agentic loop — receives messages, dispatches to handler, manages sub-agents.
//!
//! The main `run()` loop is non-blocking: LLM calls run in a spawned task
//! so new messages (including `/cancel`) can be received at any time.

use std::sync::Arc;
use std::sync::atomic::AtomicU64;
use std::time::Duration;
use tokio::sync::{mpsc, Mutex};
use tokio::task::JoinHandle;
use tracing::{debug, error, info, warn};

use tiguclaw_core::channel::Channel;
use tiguclaw_core::config::{
    AgentRole, AutoSpawnConfig,
    DEFAULT_COMPACTION_THRESHOLD, DEFAULT_CONTEXT_RETENTION_DAYS,
    DEFAULT_HEARTBEAT_INTERVAL_SECS, DEFAULT_MAX_TOOL_ITERATIONS,
    DEFAULT_MAX_TOOL_RESULT_CHARS,
};
use tiguclaw_core::event::DashboardEvent;
use tiguclaw_core::provider::Provider;
use tiguclaw_core::tool::Tool;
use tiguclaw_core::types::*;
use tiguclaw_memory::{ConversationStore, SqliteMemory};

use crate::approval::ApprovalManager;
use crate::cancel::CancellationToken;
use crate::context_commands::{self, ContextCommand};
use crate::heartbeat::{Heartbeat, HeartbeatConfig};
use crate::message_handler::{self, HandleResult, HandlerContext};
use crate::registry::AgentRegistry;
use crate::scheduler::{CronJob, Scheduler};
use crate::skills::SkillManager;
use crate::subprocess::{SubAgentManager, SubAgentReport, SubAgentStatus};

// ---------------------------------------------------------------------------
// 루프 내부 상수
// ---------------------------------------------------------------------------

/// 크론 체크 주기 (초).
const CRON_CHECK_INTERVAL_SECS: u64 = 60;
/// 유휴 에이전트 정리 주기 (초).
const IDLE_CLEANUP_INTERVAL_SECS: u64 = 60;
/// 통합 채널 버퍼 크기.
const CHANNEL_BUF_SIZE: usize = 64;

mod command_runner;

/// Re-export HookEvent for use in main.rs.
pub use tiguclaw_hooks::HookEvent;

/// The main agent loop that bridges channels, providers, and tools.
pub struct AgentLoop {
    /// 에이전트 식별 이름 (Phase 6 멀티 에이전트 군단용).
    name: String,
    /// 이 인스턴스의 역할 계층 (L0~L3).
    role: AgentRole,
    /// All registered channels (primary = index 0).
    channels: Vec<Arc<dyn Channel>>,
    provider: Arc<dyn Provider>,
    tools: Vec<Arc<dyn Tool>>,
    system_prompt: String,
    max_history: usize,
    max_tool_iterations: usize,
    compaction_threshold: usize,
    max_tool_result_chars: usize,
    history: Arc<Mutex<Vec<ChatMessage>>>,
    conversation_store: Option<Arc<ConversationStore>>,
    context_store: Option<Arc<SqliteMemory>>,
    skill_manager: Option<SkillManager>,
    sub_manager: SubAgentManager,
    report_rx: mpsc::Receiver<SubAgentReport>,
    report_tx: mpsc::Sender<SubAgentReport>,
    /// 동적으로 spawn된 에이전트 레지스트리 (Phase 6-2).
    registry: Option<Arc<Mutex<AgentRegistry>>>,
    /// Channel for handler tasks to send messages to persist.
    persist_tx: mpsc::UnboundedSender<(String, ChatMessage)>,
    persist_rx: mpsc::UnboundedReceiver<(String, ChatMessage)>,
    /// Heartbeat polling system.
    heartbeat: Option<Heartbeat>,
    /// Cron job scheduler.
    scheduler: Scheduler,
    /// Start time for uptime tracking.
    start_time: std::time::Instant,
    /// Accumulated cache read tokens (for hit rate).
    cache_read_tokens: Arc<AtomicU64>,
    /// Accumulated cache write tokens.
    cache_write_tokens: Arc<AtomicU64>,
    /// Number of context compactions performed.
    compaction_count: Arc<AtomicU64>,
    /// Optional hooks event receiver from the HTTP API server.
    hooks_rx: Option<mpsc::Receiver<HookEvent>>,
    /// Phase 9-4: steer 메시지 수신기 (AgentRegistry 또는 대시보드 API에서 전달).
    steer_rx: Option<mpsc::Receiver<String>>,
    /// Optional approval manager for security policy enforcement.
    approval_manager: Option<Arc<ApprovalManager>>,
    /// Phase 8-1: 자율 spawn 설정.
    auto_spawn_config: Option<AutoSpawnConfig>,
    /// 대시보드 broadcast sender — 에이전트 상태 이벤트 전송용.
    event_tx: Option<tokio::sync::broadcast::Sender<DashboardEvent>>,
    /// Phase 8-3: 템플릿 디렉토리 경로 (legacy).
    templates_dir: std::path::PathBuf,
    /// 에이전트 스펙 폴더 기반 디렉토리.
    agents_dir: std::path::PathBuf,
    /// 퍼스널리티 디렉토리.
    personalities_dir: std::path::PathBuf,
    /// 컨텍스트 보존 기간 (일, 기본값: 3).
    context_retention_days: u64,
}

impl AgentLoop {
    pub fn new(
        channel: Arc<dyn Channel>,
        provider: Arc<dyn Provider>,
        tools: Vec<Box<dyn Tool>>,
        system_prompt: String,
        max_history: usize,
        conversation_store: Option<Arc<ConversationStore>>,
    ) -> Self {
        let (report_tx, report_rx) = mpsc::channel(32);
        let (persist_tx, persist_rx) = mpsc::unbounded_channel();
        // Convert Box<dyn Tool> → Arc<dyn Tool> for sharing across tasks.
        let tools: Vec<Arc<dyn Tool>> = tools.into_iter().map(Arc::from).collect();
        Self {
            name: "default".to_string(),
            role: AgentRole::Master,
            channels: vec![channel],
            provider,
            tools,
            system_prompt,
            max_history,
            max_tool_iterations: DEFAULT_MAX_TOOL_ITERATIONS,
            compaction_threshold: DEFAULT_COMPACTION_THRESHOLD,
            max_tool_result_chars: DEFAULT_MAX_TOOL_RESULT_CHARS,
            history: Arc::new(Mutex::new(Vec::new())),
            conversation_store,
            context_store: None,
            skill_manager: None,
            sub_manager: SubAgentManager::new(),
            report_rx,
            report_tx,
            registry: None,
            persist_tx,
            persist_rx,
            heartbeat: None,
            scheduler: Scheduler::new(vec![]),
            start_time: std::time::Instant::now(),
            cache_read_tokens: Arc::new(AtomicU64::new(0)),
            cache_write_tokens: Arc::new(AtomicU64::new(0)),
            compaction_count: Arc::new(AtomicU64::new(0)),
            hooks_rx: None,
            steer_rx: None,
            approval_manager: None,
            auto_spawn_config: None,
            templates_dir: std::path::PathBuf::from("templates"),
            agents_dir: std::path::PathBuf::from("agents"),
            personalities_dir: std::path::PathBuf::from("personalities"),
            context_retention_days: DEFAULT_CONTEXT_RETENTION_DAYS,
            event_tx: None,
        }
    }

    /// Set the context store for named context commands.
    pub fn with_context_store(mut self, store: Arc<SqliteMemory>) -> Self {
        self.context_store = Some(store);
        self
    }

    /// Set the context retention period in days (default: 3).
    pub fn with_context_retention_days(mut self, days: u64) -> Self {
        self.context_retention_days = days;
        self
    }

    /// Append workspace context to the system prompt.
    pub fn with_workspace(mut self, context: String) -> Self {
        if !context.is_empty() {
            self.system_prompt.push_str("\n\n");
            self.system_prompt.push_str(&context);
        }
        self
    }

    /// Set the skill manager and inject available_skills into system prompt.
    pub fn with_skills(mut self, manager: SkillManager) -> Self {
        let xml = manager.available_skills_xml();
        if !xml.is_empty() {
            self.system_prompt.push_str(&xml);
        }
        self.skill_manager = Some(manager);
        self
    }

    /// Set the heartbeat configuration.
    pub fn with_heartbeat(mut self, config: HeartbeatConfig) -> Self {
        self.heartbeat = Some(Heartbeat::new(config));
        self
    }

    /// Set the cron job scheduler.
    pub fn with_cron_jobs(mut self, jobs: Vec<CronJob>) -> Self {
        self.scheduler = Scheduler::new(jobs);
        self
    }

    /// Override the maximum tool call iterations (default: 20).
    pub fn with_max_tool_iterations(mut self, n: usize) -> Self {
        self.max_tool_iterations = n;
        self
    }

    /// Override the context compaction threshold (default: 80000 tokens; 0 = disabled).
    pub fn with_compaction_threshold(mut self, threshold: usize) -> Self {
        self.compaction_threshold = threshold;
        self
    }

    /// Override the maximum tool result characters (default: 20000; 0 = unlimited).
    pub fn with_max_tool_result_chars(mut self, chars: usize) -> Self {
        self.max_tool_result_chars = chars;
        self
    }

    /// Attach a hooks event receiver so the agent loop can process HTTP hook events.
    pub fn with_hooks_rx(mut self, rx: mpsc::Receiver<HookEvent>) -> Self {
        self.hooks_rx = Some(rx);
        self
    }

    /// Phase 9-4: steer 메시지 수신기 연결.
    /// 대시보드 API 또는 AgentRegistry에서 steer 신호를 보낼 수 있다.
    pub fn with_steer_rx(mut self, rx: mpsc::Receiver<String>) -> Self {
        self.steer_rx = Some(rx);
        self
    }

    /// Attach an approval manager for security policy enforcement (Phase 7-2).
    pub fn with_approval_manager(mut self, mgr: Arc<ApprovalManager>) -> Self {
        self.approval_manager = Some(mgr);
        self
    }

    /// Set the auto-spawn configuration (Phase 8-1).
    pub fn with_auto_spawn_config(mut self, cfg: AutoSpawnConfig) -> Self {
        self.auto_spawn_config = Some(cfg);
        self
    }

    /// Set the templates directory path (Phase 8-3, legacy).
    pub fn with_templates_dir(mut self, dir: std::path::PathBuf) -> Self {
        self.templates_dir = dir;
        self
    }

    /// Set the agents directory path (folder-based specs).
    pub fn with_agents_dir(mut self, dir: std::path::PathBuf) -> Self {
        self.agents_dir = dir;
        self
    }

    /// Set the personalities directory path.
    pub fn with_personalities_dir(mut self, dir: std::path::PathBuf) -> Self {
        self.personalities_dir = dir;
        self
    }

    /// 대시보드 broadcast sender 설정 — 에이전트 상태 이벤트를 실시간 전송한다.
    pub fn with_event_tx(mut self, tx: tokio::sync::broadcast::Sender<DashboardEvent>) -> Self {
        self.event_tx = Some(tx);
        self
    }

    /// Attach the AgentRegistry for dynamic agent spawning (Phase 6-2).
    pub fn with_registry(mut self, registry: Arc<Mutex<AgentRegistry>>) -> Self {
        self.registry = Some(registry);
        self
    }

    /// Add an additional channel to listen on (multi-channel support).
    ///
    /// Messages from each channel are received concurrently and replies are
    /// routed back to the originating channel.
    pub fn with_channel(mut self, channel: Arc<dyn Channel>) -> Self {
        self.channels.push(channel);
        self
    }

    /// Set the agent name for identification in multi-agent setups (Phase 6).
    pub fn with_name(mut self, name: &str) -> Self {
        self.name = name.to_string();
        self
    }

    /// Set the agent role (L0~L3 hierarchy).
    pub fn with_role(mut self, role: AgentRole) -> Self {
        self.role = role;
        self
    }

    /// Return the agent's name.
    pub fn name(&self) -> &str {
        &self.name
    }

    /// Return the agent's role.
    pub fn role(&self) -> &AgentRole {
        &self.role
    }

    /// Return the primary (first) channel.
    fn primary_channel(&self) -> &Arc<dyn Channel> {
        &self.channels[0]
    }

    /// Run the agent loop. Blocks until all channels are closed or shutdown.
    pub async fn run(&mut self) -> tiguclaw_core::error::Result<()> {
        // Unified channel: each listener tags messages with its channel index.
        let (unified_tx, mut rx) = mpsc::channel::<(usize, ChannelMessage)>(CHANNEL_BUF_SIZE);

        // Spawn one listener per registered channel.
        let mut listener_handles = Vec::new();
        for (idx, ch) in self.channels.iter().enumerate() {
            let ch = ch.clone();
            let tx = unified_tx.clone();
            let handle = tokio::spawn(async move {
                // Intermediate channel to wrap messages with their source index.
                let (inner_tx, mut inner_rx) = mpsc::channel::<ChannelMessage>(32);
                let fwd_tx = tx.clone();
                let fwd = tokio::spawn(async move {
                    while let Some(msg) = inner_rx.recv().await {
                        let _ = fwd_tx.send((idx, msg)).await;
                    }
                });
                if let Err(e) = ch.listen(inner_tx).await {
                    error!(channel_idx = idx, "channel listener error: {e}");
                }
                fwd.abort();
            });
            listener_handles.push(handle);
        }
        // Drop the original sender — only the per-channel clones remain.
        drop(unified_tx);

        info!(
            primary_channel = self.primary_channel().name(),
            total_channels = self.channels.len(),
            provider = self.provider.name(),
            tools = self.tools.len(),
            "agent loop started"
        );

        // Purge expired contexts at startup.
        if let Some(store) = &self.context_store {
            let retention = self.context_retention_days;
            match store.purge_expired(retention) {
                Ok(n) if n > 0 => info!(count = n, "purged expired contexts"),
                Ok(_) => {}
                Err(e) => warn!(error = %e, "context purge failed"),
            }
        }

        // Restore persisted history.
        if let Some(store) = &self.conversation_store {
            match store.load_history("default", self.max_history) {
                Ok(msgs) if !msgs.is_empty() => {
                    info!(count = msgs.len(), "restored conversation history from db");
                    *self.history.lock().await = msgs;
                }
                Ok(_) => debug!("no prior conversation history"),
                Err(e) => warn!(error = %e, "failed to load conversation history"),
            }
        }

        // Heartbeat interval timer.
        let heartbeat_secs = self
            .heartbeat
            .as_ref()
            .map(|h| h.interval_secs())
            .unwrap_or(DEFAULT_HEARTBEAT_INTERVAL_SECS);
        let mut heartbeat_interval = tokio::time::interval(Duration::from_secs(heartbeat_secs));
        heartbeat_interval.tick().await; // consume the first immediate tick

        // Cron check interval.
        let mut cron_interval = tokio::time::interval(Duration::from_secs(CRON_CHECK_INTERVAL_SECS));
        cron_interval.tick().await; // consume the first immediate tick

        // Phase 8-1: Idle agent cleanup interval.
        let idle_timeout_secs = self
            .auto_spawn_config
            .as_ref()
            .map(|cfg| cfg.idle_timeout_secs)
            .unwrap_or(0);
        let idle_cleanup_enabled = idle_timeout_secs > 0 && self.registry.is_some();
        let mut idle_cleanup_interval =
            tokio::time::interval(Duration::from_secs(IDLE_CLEANUP_INTERVAL_SECS));
        idle_cleanup_interval.tick().await; // consume the first immediate tick

        // Current running LLM task + its cancellation token.
        let mut current_task: Option<(JoinHandle<anyhow::Result<HandleResult>>, CancellationToken)> =
            None;
        // Messages queued while a task is running; tagged with source channel index.
        let mut pending_messages: Vec<(usize, ChannelMessage)> = Vec::new();
        // Phase 9-4: steer 지시문 대기열 — 다음 LLM 호출 시 주입.
        let mut steer_queue: Vec<String> = Vec::new();

        loop {
            // If there's no active task but pending messages exist, start one.
            if current_task.is_none() && !pending_messages.is_empty() {
                let (ch_idx, msg) = pending_messages.remove(0);
                let steers = std::mem::take(&mut steer_queue);
                current_task = self
                    .try_spawn_handler_with_steer(&msg, ch_idx, None, steers)
                    .await?;
            }

            // Build a future for the current task (if any).
            // We need this outside select! to avoid borrow issues.
            let has_task = current_task.is_some();

            tokio::select! {
                // ── Inbound channel message ──
                channel_msg = rx.recv() => {
                    match channel_msg {
                        Some((channel_idx, msg)) => {
                            info!(
                                sender = %msg.sender,
                                channel_idx,
                                content_len = msg.content.len(),
                                "received message"
                            );

                            // Source channel for routing replies back.
                            let src_channel = self.channels[channel_idx].clone();

                            // /cancel → cancel current task
                            if msg.content.trim().eq_ignore_ascii_case("/cancel") {
                                if let Some((handle, token)) = current_task.take() {
                                    token.cancel();
                                    handle.abort();
                                    pending_messages.clear();
                                    let _ = src_channel.send(&msg.sender, "⏹ 작업 취소됨").await;
                                    info!("current task cancelled by user");
                                } else {
                                    let _ = src_channel.send(&msg.sender, "진행 중인 작업이 없습니다").await;
                                }
                                continue;
                            }

                            // /approve <id> → dispatch approval response
                            if let Some(stripped) = msg.content.trim().strip_prefix("/approve ") {
                                let approval_id = stripped.trim();
                                if let Some(ref mgr) = self.approval_manager {
                                    mgr.handle_approval_response(approval_id, true).await;
                                    let _ = src_channel
                                        .send(&msg.sender, &format!("✅ 승인됨: `{}`", approval_id))
                                        .await;
                                } else {
                                    let _ = src_channel
                                        .send(&msg.sender, "⚠️ 승인 관리자가 활성화되지 않았습니다")
                                        .await;
                                }
                                continue;
                            }

                            // /deny <id> → dispatch denial response
                            if let Some(stripped) = msg.content.trim().strip_prefix("/deny ") {
                                let approval_id = stripped.trim();
                                if let Some(ref mgr) = self.approval_manager {
                                    mgr.handle_approval_response(approval_id, false).await;
                                    let _ = src_channel
                                        .send(&msg.sender, &format!("🚫 거부됨: `{}`", approval_id))
                                        .await;
                                } else {
                                    let _ = src_channel
                                        .send(&msg.sender, "⚠️ 승인 관리자가 활성화되지 않았습니다")
                                        .await;
                                }
                                continue;
                            }

                            // Slash commands that don't need LLM → handle synchronously.
                            if let Some(err_msg) = context_commands::missing_arg_message(&msg.content) {
                                let _ = src_channel.send(&msg.sender, &err_msg).await;
                                continue;
                            }
                            match context_commands::parse_command(&msg.content) {
                                ContextCommand::None => {} // fall through
                                cmd => {
                                    let response = self.handle_context_command(cmd).await;
                                    let _ = src_channel.send(&msg.sender, &response).await;
                                    continue;
                                }
                            }
                            // Note: SaveAuto is handled inside handle_context_command above

                            // If a task is already running, queue the message.
                            if current_task.is_some() {
                                let _ = src_channel
                                    .send(&msg.sender, "⏳ 이전 작업 처리 중... 잠시만 기다려주세요")
                                    .await;
                                pending_messages.push((channel_idx, msg));
                                continue;
                            }

                            // Spawn handler task for the message (with any pending steer directives).
                            let steers = std::mem::take(&mut steer_queue);
                            current_task = self
                                .try_spawn_handler_with_steer(&msg, channel_idx, None, steers)
                                .await?;
                        }
                        None => break, // All channels closed → shutdown.
                    }
                }

                // ── Persistence queue (from handler tasks) ──
                Some((chat_id, msg)) = self.persist_rx.recv() => {
                    if let Some(store) = &self.conversation_store {
                        if let Err(e) = store.save_message(&chat_id, &msg) {
                            warn!(error = %e, "failed to persist message");
                        }
                    }
                }

                // ── Sub-agent reports ──
                Some(report) = self.report_rx.recv() => {
                    self.handle_sub_report(report).await;
                }

                // ── Heartbeat tick ──
                _ = heartbeat_interval.tick() => {
                    if let Some(ref hb) = self.heartbeat {
                        if let Some(prompt) = hb.generate_prompt() {
                            info!("heartbeat tick — generating prompt");
                            let msg = ChannelMessage {
                                id: "heartbeat".into(),
                                sender: "master".into(),
                                content: prompt,
                                timestamp: chrono::Local::now().timestamp(),
                            };
                            if current_task.is_some() {
                                pending_messages.push((0, msg));
                            } else {
                                current_task = self.try_spawn_handler(&msg, 0, None).await?;
                            }
                        } else {
                            debug!("heartbeat tick — quiet hours, skipping");
                        }
                    }
                }

                // ── Cron tick (every minute) ──
                _ = cron_interval.tick() => {
                    let due = self.scheduler.due_jobs();
                    for job in due {
                        info!(job = %job.name, "cron job due");
                        let msg = ChannelMessage {
                            id: format!("cron-{}", job.name),
                            sender: "master".into(),
                            content: job.command.clone(),
                            timestamp: chrono::Local::now().timestamp(),
                        };
                        if current_task.is_some() {
                            pending_messages.push((0, msg));
                        } else {
                            current_task = self.try_spawn_handler(&msg, 0, None).await?;
                        }
                    }
                }

                // ── Idle agent cleanup (Phase 8-1) ──
                _ = idle_cleanup_interval.tick(), if idle_cleanup_enabled => {
                    if let Some(registry) = &self.registry {
                        let removed = registry.lock().await.cleanup_idle_agents(idle_timeout_secs);
                        if !removed.is_empty() {
                            info!(count = removed.len(), agents = ?removed, "idle agents auto-terminated");
                            let notice = format!(
                                "🧹 유휴 에이전트 자동 종료: {} ({}초 미활동)",
                                removed.join(", "),
                                idle_timeout_secs
                            );
                            let _ = self.primary_channel().send("master", &notice).await;
                        }
                    }
                }

                // ── Hook events from HTTP API ──
                Some(event) = async {
                    if let Some(ref mut rx) = self.hooks_rx {
                        rx.recv().await
                    } else {
                        std::future::pending().await
                    }
                } => {
                    self.handle_hook_event(event, &mut current_task, &mut pending_messages, &mut steer_queue).await?;
                }

                // ── Phase 9-4: Steer 메시지 (AgentRegistry 또는 대시보드 API에서) ──
                Some(steer_msg) = async {
                    if let Some(ref mut rx) = self.steer_rx {
                        rx.recv().await
                    } else {
                        std::future::pending().await
                    }
                } => {
                    info!(message = %steer_msg, "steer directive received");
                    steer_queue.push(steer_msg.clone());
                    // steer 수신을 즉시 알림 (현재 작업이 없으면 큐에만 추가).
                    if current_task.is_none() {
                        debug!("steer queued (no active task) — will apply to next message");
                    } else {
                        debug!("steer queued — will apply after current task completes");
                    }
                }

                // ── Current task completion ──
                // Only poll if we actually have a task.
                result = async {
                    if let Some((ref mut handle, _)) = current_task {
                        handle.await
                    } else {
                        // Never resolves — other branches will fire.
                        std::future::pending().await
                    }
                }, if has_task => {
                    current_task = None;
                    match result {
                        Ok(Ok(HandleResult::Done)) => {
                            debug!("handler task completed");
                        }
                        Ok(Ok(HandleResult::Cancelled)) => {
                            debug!("handler task was cancelled");
                        }
                        Ok(Err(e)) => {
                            error!(error = %e, "handler task failed");
                            let _ = self.primary_channel().send("master", &format!("⚠️ Error: {e}")).await;
                        }
                        Err(e) => {
                            // JoinError (panic or abort)
                            if !e.is_cancelled() {
                                error!(error = %e, "handler task panicked");
                            }
                        }
                    }
                }
            }
        }

        info!("message channel closed, shutting down");
        for handle in listener_handles {
            handle.abort();
        }
        Ok(())
    }

    /// Try to spawn a handler task for a user message.
    /// `channel_idx` identifies which registered channel the message came from;
    /// replies will be routed back to that channel.
    /// `steer_directives` — Phase 9-4: 이 태스크에 주입할 steer 지시문 목록.
    pub(super) async fn try_spawn_handler(
        &self,
        msg: &ChannelMessage,
        channel_idx: usize,
        response_tx: Option<tokio::sync::oneshot::Sender<String>>,
    ) -> anyhow::Result<Option<(JoinHandle<anyhow::Result<HandleResult>>, CancellationToken)>> {
        self.try_spawn_handler_with_steer(msg, channel_idx, response_tx, vec![]).await
    }

    /// try_spawn_handler의 내부 구현 — steer 지시문을 받는다.
    pub(super) async fn try_spawn_handler_with_steer(
        &self,
        msg: &ChannelMessage,
        channel_idx: usize,
        response_tx: Option<tokio::sync::oneshot::Sender<String>>,
        steer_directives: Vec<String>,
    ) -> anyhow::Result<Option<(JoinHandle<anyhow::Result<HandleResult>>, CancellationToken)>> {
        let src_channel = self.channels[channel_idx].clone();
        // Send typing indicator before starting LLM call.
        let _ = src_channel.send_typing(&msg.sender).await;

        let token = CancellationToken::new();
        let ctx = Arc::new(HandlerContext {
            channel: src_channel,
            provider: self.provider.clone(),
            tools: self.tools.clone(),
            system_prompt: self.system_prompt.clone(),
            history: self.history.clone(),
            max_history: self.max_history,
            max_tool_iterations: self.max_tool_iterations,
            compaction_threshold: self.compaction_threshold,
            max_tool_result_chars: self.max_tool_result_chars,
            persist_tx: self.persist_tx.clone(),
            cache_read_tokens: self.cache_read_tokens.clone(),
            cache_write_tokens: self.cache_write_tokens.clone(),
            compaction_count: self.compaction_count.clone(),
            approval_manager: self.approval_manager.clone(),
            agent_name: self.name.clone(),
            event_tx: self.event_tx.clone(),
            steer_directives,
        });
        let chat_id = msg.sender.clone();
        let user_text = msg.content.clone();
        let cancel = token.clone();

        let handle = tokio::spawn(async move {
            let result = message_handler::handle_message(ctx, chat_id, user_text, cancel).await;
            if let Some(tx) = response_tx {
                let _ = tx.send("처리 완료".to_string());
            }
            result
        });

        Ok(Some((handle, token)))
    }

    /// Process a sub-agent completion report.
    async fn handle_sub_report(&mut self, report: SubAgentReport) {
        info!(
            agent = %report.label,
            status = %report.status,
            "sub-agent report received"
        );
        let notice = match &report.status {
            SubAgentStatus::Completed(result) => {
                format!("✅ {label} 완료: {result}", label = report.label)
            }
            SubAgentStatus::Failed(err) => {
                format!("❌ {label} 실패: {err}", label = report.label)
            }
            SubAgentStatus::Killed => {
                format!("🛑 {label} 종료됨", label = report.label)
            }
            SubAgentStatus::Running => return,
        };
        if let Err(e) = self.primary_channel().send("master", &notice).await {
            warn!(error = %e, "failed to send sub-agent report to channel");
        }
        self.sub_manager.cleanup();
    }
}


#[cfg(test)]
mod tests;
