//! Command handlers extracted from `loop_.rs`.
//!
//! All methods are `impl AgentLoop` blocks in the `loop_::command_runner` sub-module.
//! Child modules in Rust can access private fields of types defined in their parent module.

use std::sync::Arc;
use std::sync::atomic::Ordering;
use tokio::task::JoinHandle;
use tracing::{info, warn};

use tiguclaw_core::agent_spec::AgentSpecManager;
use tiguclaw_core::template::TemplateManager;
use tiguclaw_core::types::*;
use tiguclaw_memory::MemoryBackend;

use crate::cancel::CancellationToken;
use crate::context_commands::ContextCommand;
use crate::message_handler::HandleResult;

use super::AgentLoop;
use super::HookEvent;

impl AgentLoop {
    /// Handle a context command (save/load/list/delete + sub-agent commands).
    pub(super) async fn handle_context_command(&mut self, cmd: ContextCommand) -> String {
        // Sub-agent commands don't need context store.
        match &cmd {
            ContextCommand::Spawn { .. }
            | ContextCommand::Agents
            | ContextCommand::Steer { .. }
            | ContextCommand::Kill(_) => return self.handle_subagent_command(cmd).await,
            ContextCommand::Status => return self.handle_status().await,
            ContextCommand::Cancel => return "⏹ /cancel은 작업 처리 중에 사용하세요".to_string(),
            ContextCommand::Reset => return self.handle_reset().await,
            ContextCommand::AgentSpecs | ContextCommand::Templates => {
                return if matches!(cmd, ContextCommand::AgentSpecs) {
                    self.handle_agent_specs_command().await
                } else {
                    self.handle_templates_command().await
                };
            }
            _ => {}
        }

        let store = match &self.context_store {
            Some(s) => s.clone(),
            None => return "⚠️ 컨텍스트 저장소가 설정되지 않았습니다".to_string(),
        };

        match cmd {
            ContextCommand::New(name) => {
                let messages_to_save = {
                    let history = self.history.lock().await;
                    history
                        .iter()
                        .filter_map(|m| serde_json::to_value(m).ok())
                        .collect::<Vec<_>>()
                };
                let count = messages_to_save.len();

                let save_name = name.unwrap_or_else(|| {
                    chrono::Local::now().format("%Y-%m-%d %H:%M").to_string()
                });

                if count == 0 {
                    self.history.lock().await.clear();
                    return "🆕 새 대화 시작! (저장할 맥락 없음)".to_string();
                }

                let retention = self.context_retention_days;
                match store.save_context_with_retention(&save_name, &messages_to_save, retention) {
                    Ok(()) => {
                        self.history.lock().await.clear();
                        format!(
                            "✅ 맥락 저장됨: '{save_name}' ({count}개 메시지)\n🆕 새 대화 시작!"
                        )
                    }
                    Err(e) => format!("❌ 저장 실패: {e}"),
                }
            }
            ContextCommand::Contexts => match store.list_contexts_with_meta() {
                Ok(items) if items.is_empty() => "저장된 맥락 없음".to_string(),
                Ok(items) => {
                    let mut result = "📋 저장된 맥락 (최근순):\n".to_string();
                    for (i, (name, saved_at, preview)) in items.iter().enumerate() {
                        // saved_at: "YYYY-MM-DD HH:MM:SS" → trim to "YYYY-MM-DD HH:MM"
                        let time_display = if saved_at.len() >= 16 {
                            &saved_at[..16]
                        } else {
                            saved_at.as_str()
                        };
                        result.push_str(&format!(
                            "[{}] {} — \"{}\"\n    {}\n",
                            i + 1,
                            time_display,
                            name,
                            preview
                        ));
                    }
                    result
                }
                Err(e) => format!("❌ 목록 조회 실패: {e}"),
            },
            ContextCommand::Save(name) => {
                let history = self.history.lock().await;
                let messages: Vec<serde_json::Value> = history
                    .iter()
                    .filter_map(|m| serde_json::to_value(m).ok())
                    .collect();
                let count = messages.len();
                match store.save_context(&name, &messages) {
                    Ok(()) => format!("✅ 컨텍스트 '{name}' 저장 완료 ({count}개 메시지)"),
                    Err(e) => format!("❌ 저장 실패: {e}"),
                }
            }
            ContextCommand::SaveAuto => {
                // Auto-generate name from recent conversation
                let (messages_to_save, recent_text) = {
                    let history = self.history.lock().await;
                    let messages: Vec<serde_json::Value> = history
                        .iter()
                        .filter_map(|m| serde_json::to_value(m).ok())
                        .collect();
                    // Take last 10 messages for name generation
                    let recent: Vec<String> = history
                        .iter()
                        .rev()
                        .take(10)
                        .rev()
                        .map(|m| format!("[{:?}] {}", m.role, m.content.chars().take(200).collect::<String>()))
                        .collect();
                    (messages, recent.join("\n"))
                };

                let count = messages_to_save.len();
                if count == 0 {
                    return "⚠️ 저장할 대화 내용이 없습니다".to_string();
                }

                // Ask LLM to generate kebab-case name
                let auto_name = self.generate_context_name(&recent_text).await;

                // Append timestamp: name_YYYY-MM-DD-HH:MM
                let now = chrono::Local::now();
                let timestamp = now.format("%Y-%m-%d-%H:%M").to_string();
                let full_name = format!("{auto_name}_{timestamp}");

                match store.save_context(&full_name, &messages_to_save) {
                    Ok(()) => format!("✅ 컨텍스트 자동 저장 완료\n📌 이름: `{full_name}`\n💬 {count}개 메시지"),
                    Err(e) => format!("❌ 저장 실패: {e}"),
                }
            }
            ContextCommand::Load(name) => match store.load_context(&name) {
                Ok(values) => {
                    match serde_json::from_value::<Vec<ChatMessage>>(
                        serde_json::Value::Array(values),
                    ) {
                        Ok(msgs) => {
                            let count = msgs.len();
                            *self.history.lock().await = msgs;
                            format!("✅ 컨텍스트 '{name}' 로드 완료 ({count}개 메시지)")
                        }
                        Err(e) => format!("❌ 컨텍스트 복원 실패: {e}"),
                    }
                }
                Err(_) => format!("❌ 컨텍스트 '{name}'을 찾을 수 없습니다"),
            },
            ContextCommand::List => match store.list_contexts_with_meta() {
                Ok(items) if items.is_empty() => "저장된 컨텍스트가 없습니다".to_string(),
                Ok(items) => {
                    let mut result = "📋 저장된 컨텍스트:\n".to_string();
                    for (name, saved_at, preview) in &items {
                        result.push_str(&format!("  • `{name}`\n    🕐 {saved_at} | {preview}\n"));
                    }
                    result
                }
                Err(e) => format!("❌ 목록 조회 실패: {e}"),
            },
            ContextCommand::Delete(name) => match store.delete_context(&name) {
                Ok(true) => format!("✅ 컨텍스트 '{name}' 삭제 완료"),
                Ok(false) => format!("❌ 컨텍스트 '{name}'을 찾을 수 없습니다"),
                Err(e) => format!("❌ 삭제 실패: {e}"),
            },
            ContextCommand::None
            | ContextCommand::Spawn { .. }
            | ContextCommand::Agents
            | ContextCommand::Steer { .. }
            | ContextCommand::Kill(_)
            | ContextCommand::Status
            | ContextCommand::Cancel
            | ContextCommand::Reset
            | ContextCommand::Templates
            | ContextCommand::AgentSpecs => unreachable!(),
        }
    }

    /// Generate a kebab-case context name from recent conversation text using LLM.
    pub(super) async fn generate_context_name(&self, recent_text: &str) -> String {
        let prompt = format!(
            "아래 대화의 핵심 주제를 2~4개 한국어 키워드로 요약해서 kebab-case로만 반환해. \
            다른 설명 없이 키워드만. 예시: tiguclaw-tier-개선\n\n대화:\n{recent_text}"
        );

        let messages = vec![ChatMessage::user(prompt)];
        match self.provider.chat(&messages, &[]).await {
            Ok(response) => {
                let raw = response.text.trim().to_string();
                // Clean up: take first line, keep only alphanumeric, Korean, hyphens
                let first_line = raw.lines().next().unwrap_or("대화-저장").trim().to_string();
                // Sanitize: allow alphanumeric, Korean chars, hyphens
                let sanitized: String = first_line
                    .chars()
                    .map(|c| {
                        if c.is_alphanumeric() || c == '-' || c == '_' {
                            c
                        } else if c == ' ' {
                            '-'
                        } else {
                            '\0'
                        }
                    })
                    .filter(|&c| c != '\0')
                    .collect();
                let sanitized = sanitized.trim_matches('-').to_string();
                if sanitized.is_empty() {
                    "대화-저장".to_string()
                } else {
                    sanitized
                }
            }
            Err(e) => {
                warn!(error = %e, "Failed to generate context name via LLM, using fallback");
                "대화-저장".to_string()
            }
        }
    }

    /// Handle /reset and /clear commands — wipe in-memory history and DB history.
    pub(super) async fn handle_reset(&self) -> String {
        // 1. Clear in-memory history.
        self.history.lock().await.clear();

        // 2. Clear persisted history from DB (best-effort).
        if let Some(store) = &self.conversation_store {
            let conv_id = if !self.name.is_empty() {
                self.name.clone()
            } else {
                "default".to_string()
            };
            match store.clear_history(&conv_id) {
                Ok(()) => info!(conv_id = %conv_id, "conversation history cleared from DB"),
                Err(e) => warn!(error = %e, "failed to clear conversation history from DB"),
            }
        }

        info!("conversation history reset by user command");
        "대화 히스토리가 초기화됐어요. 새로 시작할게요! 🪨".to_string()
    }

    /// Handle /status command.
    pub(super) async fn handle_status(&self) -> String {
        let history = self.history.lock().await;
        let history_count = history.len();
        let agent_count = self.sub_manager.list().len();
        let uptime = self.start_time.elapsed();
        let hours = uptime.as_secs() / 3600;
        let mins = (uptime.as_secs() % 3600) / 60;

        // Cache statistics.
        let cache_read = self.cache_read_tokens.load(Ordering::Relaxed);
        let cache_write = self.cache_write_tokens.load(Ordering::Relaxed);
        let total_cache = cache_read + cache_write;
        let hit_pct = if total_cache > 0 {
            (cache_read as f64 / total_cache as f64 * 100.0) as u64
        } else {
            0
        };
        let cache_read_k = cache_read / 1000;
        let cache_write_k = cache_write / 1000;

        // Context token estimate: total chars / 4.
        let ctx_chars: usize = history.iter().map(|m| m.content.len()).sum();
        let ctx_tokens = ctx_chars / 4;
        let ctx_tokens_k = ctx_tokens / 1000;

        // Compaction count.
        let compactions = self.compaction_count.load(Ordering::Relaxed);

        format!(
            "🐯 *tiguclaw 상태*\n\
             🏷 에이전트: {}\n\
             ⏱ 가동: {}시간 {}분\n\
             🧠 Provider: {}\n\
             📡 채널: {}개 (primary: {})\n\
             🗄️ Cache: {}% hit · {}k cached / {}k written\n\
             📚 Context: ~{}k tokens (히스토리 {}개)\n\
             🧹 Compactions: {}\n\
             🤖 활성 서브에이전트: {}개\n\
             🔧 도구: {}개",
            self.name,
            hours,
            mins,
            self.provider.name(),
            self.channels.len(),
            self.primary_channel().name(),
            hit_pct,
            cache_read_k,
            cache_write_k,
            ctx_tokens_k,
            history_count,
            compactions,
            agent_count,
            self.tools.len(),
        )
    }

    /// Handle /agents command — list available agent specs (folder-based).
    pub(super) async fn handle_agent_specs_command(&self) -> String {
        let mgr = AgentSpecManager::new(self.agents_dir.clone());
        let list = mgr.list_specs();
        if list.is_empty() {
            return format!(
                "📂 사용 가능한 에이전트 스펙 없음 (디렉토리: {})\n\
                 agents/<이름>/agent.toml 파일을 추가하세요.",
                self.agents_dir.display()
            );
        }

        let mut result = "🤖 *사용 가능한 에이전트 스펙:*\n".to_string();
        for name in &list {
            let desc = mgr
                .load_spec(name)
                .map(|s| s.agent.description.clone())
                .unwrap_or_else(|_| "(설명 없음)".to_string());
            result.push_str(&format!("  • `{name}` — {desc}\n"));
        }
        result.push_str("\n사용 예시: `spawn_agent {{ agent_spec: \"researcher\" }}`");
        result
    }

    /// Handle /templates command — list available agent templates (deprecated, use /agents).
    pub(super) async fn handle_templates_command(&self) -> String {
        // First try new agent_spec directory
        let spec_mgr = AgentSpecManager::new(self.agents_dir.clone());
        let spec_list = spec_mgr.list_specs();
        if !spec_list.is_empty() {
            let mut result = "🤖 *사용 가능한 에이전트 스펙 (/agents로 이동):*\n".to_string();
            for name in &spec_list {
                let desc = spec_mgr
                    .load_spec(name)
                    .map(|s| s.agent.description.clone())
                    .unwrap_or_else(|_| "(설명 없음)".to_string());
                result.push_str(&format!("  • `{name}` — {desc}\n"));
            }
            result.push_str("\n💡 `/templates` → `/agents` 로 업그레이드됨. `spawn_agent {{ agent_spec: \"...\" }}` 사용.");
            return result;
        }

        // Fallback to old templates directory
        let mgr = TemplateManager::new(self.templates_dir.clone());
        let list = mgr.list();
        if list.is_empty() {
            return format!(
                "📂 사용 가능한 템플릿/스펙 없음\n\
                 agents/<이름>/agent.toml 또는 templates/<이름>.toml 파일을 추가하세요.",
            );
        }

        let mut result = "📋 *사용 가능한 에이전트 템플릿 (Deprecated):*\n".to_string();
        for name in &list {
            let desc = mgr
                .load(name)
                .map(|t| t.agent.description.clone())
                .unwrap_or_else(|_| "(설명 없음)".to_string());
            result.push_str(&format!("  • `{name}` — {desc}\n"));
        }
        result.push_str("\n사용 예시: `spawn_agent {{ template: \"researcher\" }}`");
        result
    }

    /// Handle sub-agent slash commands.
    pub(super) async fn handle_subagent_command(&mut self, cmd: ContextCommand) -> String {
        match cmd {
            ContextCommand::Spawn { label, task } => {
                let id = self
                    .sub_manager
                    .spawn(
                        label.clone(),
                        self.provider.clone(),
                        "You are a sub-agent. Complete the task concisely.".into(),
                        task.clone(),
                        self.report_tx.clone(),
                    )
                    .await;
                format!("🚀 서브에이전트 '{label}' 스폰 완료 (id: {})\n작업: {task}", id.0)
            }
            ContextCommand::Agents => {
                use std::collections::HashMap;

                // AgentInfo를 이름으로 빠르게 찾기 위한 맵과 상태 조회
                struct AgentEntry {
                    name: String,
                    nickname: Option<String>,
                    tier: u8,
                    team: Option<String>,
                    status: String,
                    parent_agent: Option<String>,
                }

                let mut entries: Vec<AgentEntry> = Vec::new();

                if let Some(registry) = &self.registry {
                    let reg = registry.lock().await;
                    let list = reg.list();
                    for info in &list {
                        let status = reg.get_status(&info.name);
                        entries.push(AgentEntry {
                            name: info.name.clone(),
                            nickname: info.nickname.clone(),
                            tier: info.tier,
                            team: info.team.clone(),
                            status,
                            parent_agent: info.parent_agent.clone(),
                        });
                    }
                }

                // parent_agent → children 맵 구성
                let mut children_map: HashMap<String, Vec<usize>> = HashMap::new();
                let mut root_indices: Vec<usize> = Vec::new();

                for (idx, entry) in entries.iter().enumerate() {
                    match &entry.parent_agent {
                        Some(parent) if !parent.is_empty() && parent != "user" => {
                            children_map.entry(parent.clone()).or_default().push(idx);
                        }
                        _ => {
                            // T0(슈퍼마스터)는 루트, 나머지 parent 없는 것도 루트
                            if entry.tier == 0 {
                                root_indices.insert(0, idx); // T0 맨 앞
                            } else {
                                root_indices.push(idx);
                            }
                        }
                    }
                }

                // 티어별 아이콘
                fn tier_icon(tier: u8) -> &'static str {
                    match tier {
                        0 => "🌟",
                        1 => "🤖",
                        _ => "🔧",
                    }
                }

                // 트리 출력 재귀 함수
                fn render_tree(
                    idx: usize,
                    entries: &[AgentEntry],
                    children_map: &HashMap<String, Vec<usize>>,
                    prefix: &str,
                    is_last: bool,
                    result: &mut String,
                ) {
                    let entry = &entries[idx];
                    let icon = tier_icon(entry.tier);
                    let connector = if prefix.is_empty() {
                        "".to_string()
                    } else if is_last {
                        format!("{prefix}└── ")
                    } else {
                        format!("{prefix}├── ")
                    };

                    // 닉네임 / 이름 표시
                    let display_name = if let Some(ref nick) = entry.nickname {
                        format!("{} / {}", nick, entry.name)
                    } else {
                        entry.name.clone()
                    };

                    // 팀 정보 표시
                    let team_str = entry.team.as_deref()
                        .filter(|t| !t.is_empty())
                        .map(|t| format!(", {t}"))
                        .unwrap_or_default();

                    let tier_label = format!("T{}", entry.tier);
                    result.push_str(&format!(
                        "{connector}{icon} {display_name} ({tier_label}{team_str}, {})\n",
                        entry.status
                    ));

                    // 자식 렌더링
                    let child_prefix = if is_last {
                        format!("{prefix}    ")
                    } else {
                        format!("{prefix}│   ")
                    };

                    if let Some(children) = children_map.get(&entry.name) {
                        let n = children.len();
                        for (i, &child_idx) in children.iter().enumerate() {
                            render_tree(child_idx, entries, children_map, &child_prefix, i == n - 1, result);
                        }
                    }
                }

                let mut result = String::new();
                let n_roots = root_indices.len();
                for (i, &root_idx) in root_indices.iter().enumerate() {
                    render_tree(root_idx, &entries, &children_map, "", i == n_roots - 1, &mut result);
                }

                // SubAgentManager (임시 서브에이전트) — 별도 섹션
                let sub_list = self.sub_manager.list();
                if !sub_list.is_empty() {
                    result.push_str("\n⚡ 임시 서브에이전트:\n");
                    for (id, label, status) in &sub_list {
                        result.push_str(&format!("  • {label} [{id}] — {status}\n"));
                    }
                }

                result.trim_end().to_string()
            }
            ContextCommand::Steer { label, message } => {
                match self.sub_manager.steer_by_label(&label, message.clone()).await {
                    Ok(()) => format!("🔄 '{label}' 방향 전환: {message}"),
                    Err(e) => format!("❌ steer 실패: {e}"),
                }
            }
            ContextCommand::Kill(label) => {
                match self.sub_manager.kill_by_label(&label).await {
                    Ok(()) => format!("🛑 '{label}' 종료 명령 전송"),
                    Err(e) => format!("❌ kill 실패: {e}"),
                }
            }
            _ => unreachable!(),
        }
    }

    /// Process an incoming HookEvent from the HTTP API.
    /// Hook-triggered messages always use the primary channel (index 0).
    pub(super) async fn handle_hook_event(
        &self,
        event: HookEvent,
        current_task: &mut Option<(JoinHandle<anyhow::Result<HandleResult>>, CancellationToken)>,
        pending_messages: &mut Vec<(usize, ChannelMessage)>,
        steer_queue: &mut Vec<String>,
    ) -> anyhow::Result<()> {
        use tiguclaw_hooks::types::WakeMode;

        match event {
            HookEvent::Wake { text, mode } => {
                info!(text = %text, mode = ?mode, "hook wake event received");
                let content = format!("[HOOK_WAKE] {text}");
                let msg = ChannelMessage {
                    id: "hook-wake".into(),
                    sender: "master".into(),
                    content,
                    timestamp: chrono::Local::now().timestamp(),
                    source: None,
                };
                match mode {
                    WakeMode::Now => {
                        if current_task.is_some() {
                            pending_messages.insert(0, (0, msg));
                        } else {
                            *current_task = self.try_spawn_handler(&msg, 0, None).await?;
                        }
                    }
                    WakeMode::NextHeartbeat => {
                        pending_messages.push((0, msg));
                    }
                }
            }
            HookEvent::Agent { message, deliver, to, response_tx } => {
                info!(
                    message_len = message.len(),
                    deliver,
                    to = %to,
                    "hook agent event received"
                );

                let sender = if deliver && !to.is_empty() {
                    to.clone()
                } else {
                    "hook-agent".to_string()
                };

                let msg = ChannelMessage {
                    id: format!("hook-agent-{}", uuid::Uuid::new_v4()),
                    sender,
                    content: message,
                    timestamp: chrono::Local::now().timestamp(),
                    source: None,
                };

                let task = self.try_spawn_handler(&msg, 0, Some(response_tx)).await?;
                if current_task.is_some() {
                    pending_messages.push((0, msg));
                    let _ = task;
                } else {
                    *current_task = task;
                }
            }

            // Phase 9-4: 하위 에이전트로부터 에스컬레이션 수신.
            HookEvent::Escalation { report } => {
                info!(
                    from = %report.from_agent,
                    reason = %report.reason.kind(),
                    "escalation hook event received"
                );
                let content = report.to_prompt_text();
                let msg = ChannelMessage {
                    id: format!("escalation-{}", report.from_agent),
                    sender: "escalation".into(),
                    content,
                    timestamp: chrono::Local::now().timestamp(),
                    source: None,
                };
                if current_task.is_some() {
                    pending_messages.push((0, msg));
                } else {
                    *current_task = self.try_spawn_handler(&msg, 0, None).await?;
                }
            }

            // Phase 9-4: steer 신호 (hooks API를 통해 수신된 경우).
            HookEvent::Steer { message } => {
                info!(message = %message, "steer hook event received");
                steer_queue.push(message);
            }

            // T1 에이전트 작업 완료 보고.
            HookEvent::Report { from, message } => {
                info!(from = %from, "report hook event received");
                let content = format!("[REPORT from {from}] {message}");
                let msg = ChannelMessage {
                    id: format!("report-{from}"),
                    sender: from,
                    content,
                    timestamp: chrono::Local::now().timestamp(),
                    source: None,
                };
                if current_task.is_some() {
                    pending_messages.push((0, msg));
                } else {
                    *current_task = self.try_spawn_handler(&msg, 0, None).await?;
                }
            }
        }
        Ok(())
    }
}

// Suppress unused import warnings — these are needed for method bodies above.
#[allow(unused_imports)]
use Arc as _;
