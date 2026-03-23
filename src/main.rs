//! tiguclaw entrypoint — assembles components and runs the agent.

use std::sync::Arc;

use anyhow::{Context, Result};
use clap::Parser as _;
use tokio::sync::{mpsc, Mutex};
use tracing::info;

fn main() -> Result<()> {
    // Parse CLI arguments.
    let cli = tiguclaw_cli::Cli::parse();

    // If a CLI subcommand was given (not `run`), dispatch synchronously and exit.
    // This avoids starting the tokio runtime (and fastembed model loading) for CLI commands.
    let should_run = tiguclaw_cli::dispatch(&cli)?;
    if !should_run {
        return Ok(());
    }

    // Run mode: start async tokio runtime.
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .context("failed to build tokio runtime")?
        .block_on(async_main())
}

async fn async_main() -> Result<()> {

    // Initialize tracing (only for bot run mode).
    tracing_subscriber::fmt::init();

    // Load configuration.
    let config = tiguclaw_core::Config::load("config.toml")
        .map_err(|e| anyhow::anyhow!("{e}"))
        .context("failed to load config")?;

    info!(
        tier1 = ?config.provider.tiers.tier1,
        tier2 = ?config.provider.tiers.tier2,
        thinking = %config.provider.thinking,
        "tiguclaw starting with tier escalation routing"
    );
    info!(shell = %config.runtime.shell, timeout = config.runtime.timeout_secs, "runtime config");

    // Primary channel config 결정 — primary=true이거나 첫 번째 항목.
    let primary_ch_cfg = config.channels.iter()
        .find(|c| c.primary || config.channels.len() == 1)
        .or_else(|| config.channels.first())
        .expect("channels 설정 필요: config.toml에 [[channels]] 항목이 최소 1개 있어야 합니다");

    // Build runtime.
    let runtime = Arc::new(tiguclaw_runtime::NativeRuntime::from_config(&config.runtime));

    // Build primary channel.
    let channel = Arc::new(
        tiguclaw_channel_telegram::TelegramChannel::new(
            &primary_ch_cfg.bot_token,
            primary_ch_cfg.admin_chat_id,
        ),
    );

    // Build tier provider (tier1 → escalate to tier2 on demand).
    let provider = Arc::new(
        tiguclaw_provider_anthropic::TierProvider::from_config(&config.provider),
    );

    // Build AgentRegistry용 base tools (Arc — registry와 L2 에이전트가 공유).
    // T1 에이전트용 레지스트리 툴은 나중에 registry Arc가 준비된 뒤 주입한다.
    // (registry_tools_base: 기본 5개, registry_tools는 에이전트 관리 툴 포함)
    let registry_tools_base: Vec<Arc<dyn tiguclaw_core::tool::Tool>> = {
        let runtime2 = Arc::new(tiguclaw_runtime::NativeRuntime::from_config(&config.runtime));
        vec![
            Arc::new(tiguclaw_agent::tools::ShellTool::new(runtime2)),
            Arc::new(tiguclaw_agent::tools::ReadFileTool::new()),
            Arc::new(tiguclaw_agent::tools::WriteFileTool::new()),
            Arc::new(tiguclaw_agent::tools::EditFileTool::new()),
            Arc::new(tiguclaw_agent::tools::WebFetchTool::new()),
        ]
    };

    // data 디렉토리 생성 (AgentStore, ConversationStore 등이 사용).
    let data_dir = std::path::Path::new("data");
    std::fs::create_dir_all(data_dir).context("create data directory")?;

    // AgentStore 생성 — 에이전트 영속화 저장소.
    let agent_store = Arc::new(
        tiguclaw_memory::AgentStore::open(&data_dir.join("agents.db"))
            .context("open agent store")?,
    );

    // Build AgentRegistry — L2 에이전트들은 provider와 registry_tools를 공유.
    let registry = Arc::new(Mutex::new(
        tiguclaw_agent::AgentRegistry::new_with_store(provider.clone(), registry_tools_base, agent_store),
    ));

    // primary channel inject_tx를 registry에 등록 — 대시보드 메시지를 메인채널로 직접 주입.
    {
        let mut reg = registry.lock().await;
        reg.set_primary_inject_tx(channel.inject_sender());
        // 슈퍼마스터 inbox_tx 등록 — completion callback이 inbox_txs에서 supermaster를 찾을 수 있도록.
        // 이 등록 없이는 from_name이 실제 supermaster 이름이어도 inbox_txs lookup이 None을 반환한다.
        reg.register_inbox_tx(&config.agent.name, channel.inject_sender());
        // spawn된 에이전트의 SpawnAgentTool 경로 설정 — 에이전트별 툴 인스턴스 생성 시 사용.
        reg.set_spawn_dirs(
            std::path::PathBuf::from(&config.agent.templates_dir),
            std::path::PathBuf::from(&config.agent.agents_dir),
        );
    }

    // T1 에이전트 공유 툴셋에 에이전트 관리 툴 추가 (registry Arc 준비 후 주입).
    // T1용 spawn_agent는 requester_tier=1로 설정 → T2(tier >= 2)만 spawn 가능.
    {
        let t1_templates_dir = std::path::PathBuf::from(&config.agent.templates_dir);
        let t1_agents_dir = std::path::PathBuf::from(&config.agent.agents_dir);
        let t1_spawn = tiguclaw_agent::tools::SpawnAgentTool::new(registry.clone())
            .with_templates_dir(t1_templates_dir)
            .with_agents_dir(t1_agents_dir)
            .with_requester_tier(1);
        let t1_send = tiguclaw_agent::tools::SendToAgentTool::new(registry.clone());
        let t1_list = tiguclaw_agent::tools::ListAgentsTool::new(registry.clone());
        let t1_kill = tiguclaw_agent::tools::KillAgentTool::new(registry.clone());
        let mut reg = registry.lock().await;
        reg.push_tool(Arc::new(t1_spawn));
        reg.push_tool(Arc::new(t1_send));
        reg.push_tool(Arc::new(t1_list));
        reg.push_tool(Arc::new(t1_kill));
        info!("T1 agent management tools injected into registry_tools (requester_tier=1)");
    }

    // Phase 9-1: 대시보드 서버 생성 (enabled 여부와 무관하게 event_tx 준비).
    let dashboard_server = if config.dashboard.enabled {
        let server = tiguclaw_dashboard::DashboardServer::new(
            registry.clone(),
            config.dashboard.cors_origin.clone(),
        )
        .with_admin_chat_id(primary_ch_cfg.admin_chat_id)
        .with_conv_db(data_dir.join("conversations.db"))
        .with_timeline_db(data_dir.join("timeline.db"))
        .with_event_logger(data_dir);
        info!(
            port = config.dashboard.port,
            cors_origin = %config.dashboard.cors_origin,
            "dashboard server enabled"
        );
        Some(server)
    } else {
        info!("dashboard disabled (set dashboard.enabled = true to activate)");
        None
    };

    // Phase 8-2: Monitor 생성 + registry에 주입.
    // Phase 9-1: dashboard event_tx 연동.
    {
        let monitor_channel = Arc::new(
            tiguclaw_channel_telegram::TelegramChannel::new(
                &primary_ch_cfg.bot_token,
                primary_ch_cfg.admin_chat_id,
            ),
        );
        // dashboard event_tx를 monitor에 공유.
        let event_tx_opt = dashboard_server.as_ref().map(|d| d.event_tx.clone());
        let monitor = Arc::new(
            tiguclaw_agent::Monitor::new(config.monitor.clone(), monitor_channel)
                .with_event_tx(event_tx_opt),
        );
        let mut reg = registry.lock().await;
        reg.set_monitor(monitor);

        // dashboard event_tx를 registry에도 공유.
        if let Some(ref ds) = dashboard_server {
            reg.set_event_tx(ds.event_tx.clone());
        }

        // spawn된 에이전트 대화 저장용 채널 (ConversationStore는 !Send이므로 별도 스레드로 위임).
        let (conv_tx, mut conv_rx) = tokio::sync::mpsc::channel::<(String, tiguclaw_core::types::ChatMessage, Option<String>)>(256);
        let (initiator_tx, mut initiator_rx) = tokio::sync::mpsc::channel::<(String, String)>(64);
        let conv_db_path = data_dir.join("conversations.db");
        std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
            rt.block_on(async move {
                let store = match tiguclaw_memory::ConversationStore::open(&conv_db_path) {
                    Ok(s) => s,
                    Err(e) => {
                        tracing::warn!(error = %e, "conv store open failed for spawned agents");
                        return;
                    }
                };
                loop {
                    tokio::select! {
                        Some((agent_name, msg, sender)) = conv_rx.recv() => {
                            if let Err(e) = store.save_message_with_sender(&agent_name, &msg, sender.as_deref()) {
                                tracing::warn!(agent = %agent_name, error = %e, "conv save failed");
                            }
                        }
                        Some((chat_id, initiator)) = initiator_rx.recv() => {
                            if let Err(e) = store.set_initiator(&chat_id, &initiator) {
                                tracing::warn!(chat_id = %chat_id, error = %e, "initiator save failed");
                            }
                        }
                        else => break,
                    }
                }
            });
        });
        reg.set_conv_save_tx(conv_tx);
        reg.set_initiator_tx(initiator_tx);
        reg.set_admin_chat_id(primary_ch_cfg.admin_chat_id);

        if config.monitor.enabled {
            info!(
                chat_id = %config.monitor.telegram_chat_id,
                log_comms = config.monitor.log_agent_comms,
                log_spawns = config.monitor.log_spawns,
                "monitor channel enabled"
            );
        } else {
            info!("monitor channel disabled (set monitor.enabled = true to activate)");
        }
    }

    // 시작 시 이전 상주 에이전트 복원 + 슈퍼마스터 자신을 registry에 등록.
    {
        let registry_arc_for_restore = registry.clone();
        let mut reg = registry.lock().await;
        reg.restore_from_store(Some(registry_arc_for_restore)).await;
        // 슈퍼마스터(L0) 자신을 API 목록 맨 앞에 포함되도록 등록.
        reg.set_supermaster(tiguclaw_core::event::AgentStatusInfo {
            name: config.agent.name.clone(),
            nickname: config.agent.nickname.clone(),
            tier: 0,
            channel_type: config.channels.first()
                .map(|c| c.channel_type.clone())
                .unwrap_or_else(|| "internal".to_string()),
            persistent: true,
            current_status: "idle".to_string(),
            parent_agent: None,
            team: config.agent.team.clone(),
            clearance: Some(config.agent.clearance.clone()),
        });
    }

    // L0 마스터용 base tools (Box — AgentLoop에 소유권 전달).
    // build_base_tools 헬퍼로 5개 공통 툴 생성.

    // Phase 8-3: 템플릿/에이전트 디렉토리 경로.
    let templates_dir = std::path::PathBuf::from(&config.agent.templates_dir);
    let agents_dir = std::path::PathBuf::from(&config.agent.agents_dir);

    // Agent management 툴 생성 (registry 공유).
    let spawn_agent_tool = tiguclaw_agent::tools::SpawnAgentTool::new(registry.clone())
        .with_templates_dir(templates_dir.clone())
        .with_agents_dir(agents_dir.clone())
        .with_owner_name(config.agent.name.clone());
    let send_to_agent_tool = tiguclaw_agent::tools::SendToAgentTool::new(registry.clone())
        .with_from_name(config.agent.name.clone()); // completion callback이 올바른 키로 inbox_txs 조회
    let kill_agent_tool = tiguclaw_agent::tools::KillAgentTool::new(registry.clone());
    let list_agents_tool = tiguclaw_agent::tools::ListAgentsTool::new(registry.clone());

    // 기본 5개 툴 + 에이전트 관리 툴.
    let mut tools = build_base_tools(runtime);
    tools.extend([
        Box::new(spawn_agent_tool) as Box<dyn tiguclaw_core::tool::Tool>,
        Box::new(send_to_agent_tool),
        Box::new(kill_agent_tool),
        Box::new(list_agents_tool),
    ]);

    // 파일 전송 툴 (Telegram sendDocument).
    let send_file_tool = tiguclaw_agent::tools::SendFileTool::new(
        &primary_ch_cfg.bot_token,
        primary_ch_cfg.admin_chat_id,
    );
    tools.push(Box::new(send_file_tool));

    // Phase 9-4: escalate_to_parent 툴 (parent_agent + parent_hooks_url이 설정된 경우에만).
    if let (Some(parent_agent), Some(parent_hooks_url)) = (
        config.agent.parent_agent.as_ref(),
        config.agent.parent_hooks_url.as_ref(),
    ) {
        let parent_hooks_token = config.agent.parent_hooks_token
            .clone()
            .unwrap_or_default();
        let escalate_tool = tiguclaw_agent::tools::EscalateToParentTool::new(
            &config.agent.name,
            parent_agent,
            parent_hooks_url,
            &parent_hooks_token,
        );
        tools.push(Box::new(escalate_tool));

        // report_to_parent 툴: L1이 부모(L0)에게 완료 보고 (fire-and-forget 패턴 완성).
        let report_tool = tiguclaw_agent::tools::ReportToParentTool::new_http(
            &config.agent.name,
            parent_agent,
            parent_hooks_url,
            &parent_hooks_token,
        );
        tools.push(Box::new(report_tool));

        info!(
            parent_agent = %parent_agent,
            parent_hooks_url = %parent_hooks_url,
            "escalate_to_parent + report_to_parent tools enabled"
        );
    }

    // Load system prompt — spec이 있으면 AgentSpecManager로, 없으면 system_prompt_file에서.
    let base_prompt = if let Some(spec_path) = &config.agent.spec {
        // "agents/supermaster" 형태이면 마지막 세그먼트(이름)만 추출.
        let spec_name = spec_path
            .split('/')
            .last()
            .unwrap_or(spec_path.as_str());
        let shared_dir = std::path::PathBuf::from(&config.agent.shared_dir);
        let spec_manager = tiguclaw_core::AgentSpecManager::new(agents_dir.clone())
            .with_shared_dir(shared_dir, config.agent.max_shared_chars);
        let prompt = spec_manager
            .build_full_system_prompt(spec_name, "human")
            .map_err(|e| anyhow::anyhow!("spec 프롬프트 로드 실패: {e}"))?;
        info!(
            spec = %spec_path,
            prompt_len = prompt.len(),
            "loaded system prompt from agents spec"
        );
        prompt
    } else {
        let prompt = load_system_prompt(&config.agent.system_prompt_file)?;
        info!(
            prompt_len = prompt.len(),
            "loaded system prompt from {}",
            config.agent.system_prompt_file
        );
        prompt
    };

    // Load workspace context files — clearance 기반 필터링 적용.
    let workspace_loader =
        tiguclaw_agent::WorkspaceLoader::new(&config.agent.workspace_dir);
    let workspace_context = {
        let clearance_files = config.clearance
            .get(&config.agent.clearance)
            .map(|p| p.files.clone())
            .unwrap_or_default();
        if clearance_files.is_empty() {
            // clearance 프리셋이 없거나 빈 경우 전체 로드 (하위 호환).
            workspace_loader.load_context()
        } else {
            workspace_loader.load_context_with_clearance(&clearance_files)
        }
    };
    if !workspace_context.is_empty() {
        info!(
            workspace_dir = %config.agent.workspace_dir,
            clearance = %config.agent.clearance,
            context_len = workspace_context.len(),
            "loaded workspace context"
        );
    }

    // 채널 컨텍스트 — 에이전트가 어떤 채널로 소통 중인지 인식
    let channel_context = format!(
        "## Communication Channel\nYou are communicating via **{}**. Format responses naturally with markdown (bold, italic, code blocks, etc.) — the system will auto-convert to the appropriate format for delivery.",
        (channel.as_ref() as &dyn tiguclaw_core::channel::Channel).name()
    );

    // 팀별 지침 주입 — config.agent.team이 설정된 경우 shared/teams/{team}.md 로드.
    let team_context = config.agent.team.as_deref().and_then(|team| {
        let shared_dir = std::path::PathBuf::from(&config.agent.shared_dir);
        tiguclaw_agent::WorkspaceLoader::load_team_context(&shared_dir, team)
    });

    // Assemble system prompt via PromptBuilder.
    let mut prompt_builder = tiguclaw_agent::PromptBuilder::new(base_prompt)
        .with_workspace(workspace_context)
        .with_section(channel_context);
    if let Some(tc) = team_context {
        prompt_builder = prompt_builder.with_section(tc);
    }
    let system_prompt = prompt_builder.build();
    info!(total_prompt_len = system_prompt.len(), "system prompt assembled");

    // Build conversation store for history persistence.
    #[allow(clippy::arc_with_non_send_sync)]
    let conv_store = Arc::new(
        tiguclaw_memory::ConversationStore::open(&data_dir.join("conversations.db"))
            .context("open conversation store")?,
    );

    // Build context store (SqliteMemory) for named context commands.
    // embeddings feature가 활성화되고 config.memory.embedding_provider = "fastembed"이면
    // 하이브리드 검색(벡터 + FTS5 + 시간 decay)을 활성화한다.
    let context_store = {
        let raw = tiguclaw_memory::SqliteMemory::open(Some(&data_dir.join("memory.db")))
            .context("open memory store for contexts")?;

        #[cfg(feature = "embeddings")]
        let raw = {
            if config.memory.embedding_provider == "fastembed" {
                match tiguclaw_memory::FastembedProvider::new() {
                    Ok(provider) => {
                        info!("embedding provider: fastembed (AllMiniLML6V2, dim=384)");
                        raw.with_embedding(std::sync::Arc::new(provider))
                            .context("init vector table")?
                    }
                    Err(e) => {
                        tracing::warn!("fastembed init failed, falling back to FTS5 only: {e}");
                        raw
                    }
                }
            } else {
                info!("embedding provider: none (FTS5 only)");
                raw
            }
        };

        Arc::new(raw)
    };

    // Scan skill directories.
    let skill_dirs: Vec<std::path::PathBuf> = config
        .agent
        .skill_dirs
        .iter()
        .map(std::path::PathBuf::from)
        .collect();
    let skill_dir_refs: Vec<&std::path::Path> = skill_dirs.iter().map(|p| p.as_path()).collect();
    let skill_manager = tiguclaw_agent::skills::SkillManager::scan(&skill_dir_refs)
        .context("failed to scan skill directories")?;
    info!(count = skill_manager.list().len(), "scanned skills");

    // Build hooks server if enabled.
    let (hooks_tx, hooks_rx) = mpsc::channel(64);
    if config.hooks.enabled {
        info!(port = config.hooks.port, "hooks HTTP API enabled");
        let hooks_config = tiguclaw_hooks::HookServerConfig {
            port: config.hooks.port,
            token: config.hooks.token.clone(),
        };
        let server = tiguclaw_hooks::HookServer::new(hooks_config, hooks_tx);
        server.start().await.context("failed to start hooks server")?;
    } else {
        info!("hooks HTTP API disabled (set hooks.enabled = true to enable)");
        // Drop sender so the receiver never blocks waiting.
        drop(hooks_tx);
    }

    // Phase 9-4: steer 채널 생성 — 대시보드 API / AgentRegistry에서 steer 신호를 전달.
    let (steer_tx_main, steer_rx_main) = tokio::sync::mpsc::channel::<String>(16);
    {
        let mut reg = registry.lock().await;
        reg.register_steer_tx(&config.agent.name, steer_tx_main);
    }

    // Build and run primary agent (L0).
    // apply_agent_config 헬퍼로 name/iterations/compaction/tool_result_chars 일괄 적용.
    let agent = tiguclaw_agent::AgentLoop::new(
        channel,
        provider.clone(),
        tools,
        system_prompt,
        config.agent.max_history,
        Some(conv_store),
    );
    let agent = apply_agent_config(agent, &config.agent.name, &config.agent);
    let agent = agent
        .with_role(config.agent.role.clone())
        .with_steer_rx(steer_rx_main)
        .with_registry(registry)
        .with_context_store(context_store)
        .with_context_retention_days(config.context.retention_days)
        .with_skills(skill_manager)
        .with_hooks_rx(hooks_rx)
        .with_templates_dir(templates_dir)
        .with_agents_dir(agents_dir);

    // Phase 10: 대시보드 event_tx를 AgentLoop에 연결 — 에이전트 상태 실시간 broadcast.
    let agent = if let Some(ref ds) = dashboard_server {
        agent.with_event_tx(ds.event_tx.clone())
    } else {
        agent
    };

    #[allow(unused_mut)]
    let mut agent = agent;

    // 멀티채널: [[channels]] 중 non-primary 항목을 순회하며 추가 채널 연결.
    let extra_ch_cfgs: Vec<_> = config.channels.iter()
        .filter(|c| !c.primary && c.channel_type == "telegram")
        .collect();
    for extra in &extra_ch_cfgs {
        info!(bot_token_prefix = &extra.bot_token[..extra.bot_token.len().min(8)], "attaching extra telegram channel");
        let extra_ch = Arc::new(
            tiguclaw_channel_telegram::TelegramChannel::new(
                &extra.bot_token,
                primary_ch_cfg.admin_chat_id,
            ),
        );
        agent = agent.with_channel(extra_ch);
    }
    info!(total_channels = extra_ch_cfgs.len() + 1, "channels attached to primary agent");

    // Phase 6: 멀티 에이전트 군단 — [[agents]] 항목을 순회하며 추가 에이전트 spawn.
    for entry in &config.agents {
        if !entry.enabled {
            info!(name = %entry.name, "agent entry disabled, skipping");
            continue;
        }

        match entry.tier {
            1 => {
                // L1: 독립 텔레그램 채널로 AgentLoop spawn.
                let token = entry
                    .bot_token
                    .clone()
                    .unwrap_or_else(|| primary_ch_cfg.bot_token.clone());
                let l1_channel = Arc::new(
                    tiguclaw_channel_telegram::TelegramChannel::new(
                        &token,
                        primary_ch_cfg.admin_chat_id,
                    ),
                );

                // 시스템 프롬프트: 전용 파일이 있으면 로드, 없으면 기본값 사용.
                let l1_prompt = if let Some(ref prompt_file) = entry.system_prompt_file {
                    load_system_prompt(prompt_file)?
                } else {
                    load_system_prompt(&config.agent.system_prompt_file)?
                };

                // 워크스페이스 컨텍스트 — clearance 기반 필터링 적용.
                let ws_dir = entry
                    .workspace_dir
                    .clone()
                    .unwrap_or_else(|| config.agent.workspace_dir.clone());
                let ws_loader = tiguclaw_agent::WorkspaceLoader::new(&ws_dir);
                let l1_clearance_files = config.clearance
                    .get(&entry.clearance)
                    .map(|p| p.files.clone())
                    .unwrap_or_else(|| vec!["CORE.md".to_string()]);
                let ws_ctx = if l1_clearance_files.is_empty() {
                    ws_loader.load_context()
                } else {
                    ws_loader.load_context_with_clearance(&l1_clearance_files)
                };
                let l1_channel_ctx = format!(
                    "## Communication Channel\nYou are communicating via **{}**. Format responses naturally with markdown (bold, italic, code blocks, etc.) — the system will auto-convert to the appropriate format for delivery.",
                    (l1_channel.as_ref() as &dyn tiguclaw_core::channel::Channel).name()
                );
                // 팀별 지침 주입 — entry.team (향후 확장용) 또는 전역 config.agent.team 참조.
                let l1_team_context = config.agent.team.as_deref().and_then(|team| {
                    let shared_dir = std::path::PathBuf::from(&config.agent.shared_dir);
                    tiguclaw_agent::WorkspaceLoader::load_team_context(&shared_dir, team)
                });
                let mut l1_builder = tiguclaw_agent::PromptBuilder::new(l1_prompt)
                    .with_workspace(ws_ctx)
                    .with_section(l1_channel_ctx);
                if let Some(tc) = l1_team_context {
                    l1_builder = l1_builder.with_section(tc);
                }
                let l1_system_prompt = l1_builder.build();

                let agent_name = entry.name.clone();
                let l1_provider = provider.clone();
                let l1_max_history = config.agent.max_history;
                // AgentConfig 클론 전달 (apply_agent_config 헬퍼에서 사용).
                let l1_agent_cfg = config.agent.clone();
                // runtime config 복사 (Send-safe 값들만)
                let l1_runtime_cfg = config.runtime.clone();
                // 대화 DB 경로 (문자열로 전달)
                let l1_conv_db_path = std::path::Path::new("data")
                    .join(format!("conversations-{}.db", entry.name));

                info!(name = %agent_name, level = 1, "spawning L1 agent (telegram)");

                // AgentLoop 및 ConversationStore는 !Send이므로
                // OS 스레드 + 별도 tokio 런타임에서 구성 및 실행.
                std::thread::spawn(move || {
                    let rt = tokio::runtime::Runtime::new()
                        .expect("failed to create tokio runtime for L1 agent");
                    rt.block_on(async move {
                        // 스레드 내부에서 !Send 타입들 구성.
                        let l1_runtime = Arc::new(
                            tiguclaw_runtime::NativeRuntime::from_config(&l1_runtime_cfg),
                        );
                        // build_base_tools 헬퍼로 5개 기본 툴 생성 (L0와 동일 패턴).
                        let l1_tools = build_base_tools(l1_runtime);
                        #[allow(clippy::arc_with_non_send_sync)]
                        let l1_conv_store = Arc::new(
                            tiguclaw_memory::ConversationStore::open(&l1_conv_db_path)
                                .expect("open l1 agent conversation store"),
                        );

                        let l1_base = tiguclaw_agent::AgentLoop::new(
                            l1_channel,
                            l1_provider,
                            l1_tools,
                            l1_system_prompt,
                            l1_max_history,
                            Some(l1_conv_store),
                        );
                        // apply_agent_config 헬퍼로 공통 설정 일괄 적용.
                        let mut l1_agent = apply_agent_config(l1_base, &agent_name, &l1_agent_cfg);

                        if let Err(e) = l1_agent.run().await {
                            tracing::error!(name = %agent_name, error = %e, "L1 agent error");
                        }
                    });
                });
            }
            2 => {
                // L2: 내부 mpsc 채널 — Phase 7에서 InternalChannel 구현 완료 예정.
                // 현재: stub 상태로 등록만 처리, 실제 메시지 라우팅 미구현.
                info!(
                    name = %entry.name,
                    reports_to = ?entry.reports_to,
                    "L2 agent registered (internal channel stub)"
                );
            }
            level => {
                tracing::warn!(name = %entry.name, level, "unknown agent level, skipping");
            }
        }
    }

    // Phase 7-2: Security policy — ApprovalManager (disabled by default).
    let mut agent = if config.security.enabled {
        info!(
            default_level = ?config.security.default_level,
            require_timeout = config.security.require_timeout_secs,
            "security policy enabled — ApprovalManager activated"
        );
        let admin_chat_id = primary_ch_cfg.admin_chat_id.to_string();
        let approval_mgr = Arc::new(tiguclaw_agent::ApprovalManager::new(
            config.security.clone(),
            // Use the primary telegram channel for approval notifications.
            Arc::new(tiguclaw_channel_telegram::TelegramChannel::new(
                &primary_ch_cfg.bot_token,
                primary_ch_cfg.admin_chat_id,
            )),
            admin_chat_id,
        ));
        agent.with_approval_manager(approval_mgr)
    } else {
        info!("security policy disabled (set security.enabled = true to activate)");
        agent
    };

    // Phase 9-1: 대시보드 서버 시작.
    if let Some(ds) = dashboard_server {
        let port = config.dashboard.port;
        tokio::spawn(async move {
            if let Err(e) = ds.start(port).await {
                tracing::error!(error = %e, "dashboard server error");
            }
        });
    }

    // 자동 백업 스케줄 — 시작 시 1회 + 이후 매 24시간마다 실행.
    {
        let backup_config = config.backup.clone();
        let config_dir = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
        tokio::spawn(async move {
            loop {
                let result = tiguclaw_core::backup::run_backup(&config_dir, &backup_config);
                match result.status {
                    tiguclaw_core::backup::BackupStatus::Success => {
                        tracing::info!(
                            files = result.file_count,
                            size = %tiguclaw_core::backup::BackupResult::format_size(result.total_bytes),
                            dest = ?result.dest,
                            removed = result.removed.len(),
                            "backup complete"
                        );
                    }
                    tiguclaw_core::backup::BackupStatus::Skipped => {
                        tracing::debug!(msg = ?result.message, "backup skipped");
                    }
                    tiguclaw_core::backup::BackupStatus::Disabled => {
                        tracing::debug!("backup disabled — exiting backup task");
                        break;
                    }
                    tiguclaw_core::backup::BackupStatus::Error => {
                        tracing::warn!(error = ?result.message, "backup failed");
                    }
                }
                tokio::time::sleep(std::time::Duration::from_secs(86400)).await;
            }
        });
    }

    info!("tiguclaw ready — listening for messages");

    // Run with graceful shutdown on Ctrl+C.
    tokio::select! {
        result = agent.run() => {
            if let Err(e) = result {
                tracing::error!(error = %e, "agent loop error");
            }
        }
        _ = tokio::signal::ctrl_c() => {
            info!("received Ctrl+C, shutting down");
        }
    }

    info!("tiguclaw stopped");
    Ok(())
}

/// 기본 5개 툴(shell, read, write, edit, web_fetch) 생성 헬퍼.
///
/// L0, L1 에이전트 모두 공통으로 사용하는 툴 목록.
fn build_base_tools(
    runtime: Arc<tiguclaw_runtime::NativeRuntime>,
) -> Vec<Box<dyn tiguclaw_core::tool::Tool>> {
    vec![
        Box::new(tiguclaw_agent::tools::ShellTool::new(runtime)),
        Box::new(tiguclaw_agent::tools::ReadFileTool::new()),
        Box::new(tiguclaw_agent::tools::WriteFileTool::new()),
        Box::new(tiguclaw_agent::tools::EditFileTool::new()),
        Box::new(tiguclaw_agent::tools::WebFetchTool::new()),
    ]
}

/// AgentLoop에 AgentConfig 공통 설정 적용 헬퍼.
///
/// name, max_tool_iterations, compaction_threshold, max_tool_result_chars를 일괄 적용한다.
fn apply_agent_config(
    agent: tiguclaw_agent::AgentLoop,
    name: &str,
    config: &tiguclaw_core::config::AgentConfig,
) -> tiguclaw_agent::AgentLoop {
    agent
        .with_name(name)
        .with_max_tool_iterations(config.max_tool_iterations)
        .with_compaction_threshold(config.compaction_threshold)
        .with_max_tool_result_chars(config.max_tool_result_chars)
}

/// Load system prompt from a file path, with a fallback default.
fn load_system_prompt(path: &str) -> Result<String> {
    match std::fs::read_to_string(path) {
        Ok(content) => Ok(content),
        Err(e) => {
            tracing::warn!(path, error = %e, "failed to load system prompt file, using default");
            Ok("You are tiguclaw, a helpful assistant that can execute shell commands. \
                Be concise and direct in your responses."
                .to_string())
        }
    }
}
