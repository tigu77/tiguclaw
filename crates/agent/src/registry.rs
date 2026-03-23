//! AgentRegistry — 런타임에 동적으로 spawn된 에이전트(L2/L3) 관리.
//!
//! L1 마스터 에이전트가 `spawn_agent` 툴을 통해 하위 에이전트를 동적으로 생성하고,
//! `send_to_agent` / `kill_agent` / `list_agents` 툴로 제어한다.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use tokio::sync::{broadcast, mpsc, oneshot, Mutex};
use tokio::task::JoinHandle;
use tracing::{debug, info, warn};

use tiguclaw_core::types::ChannelMessage;

use tiguclaw_core::event::{AgentStatusInfo, DashboardEvent};

use tiguclaw_channel_telegram::TelegramChannel;
use tiguclaw_core::channel::Channel;
use tiguclaw_core::config::AgentRole;
use tiguclaw_core::provider::{Provider, ThinkingLevel, ToolDefinition};
use tiguclaw_core::tool::Tool;
use tiguclaw_core::types::{ChatMessage, ToolCall};
use tiguclaw_memory::{AgentStore, PersistedAgent};

use crate::monitor::Monitor;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/// 에이전트에 전달하는 태스크.
pub struct AgentTask {
    pub message: String,
    /// fire-and-forget 모드일 때 None. L0 블로킹 방지를 위해 send_to_agent는 None 사용.
    pub reply_tx: Option<oneshot::Sender<String>>,
    /// LLM 사고 수준 — Normal(기본) 또는 Deep(깊은 사고 모드).
    #[allow(dead_code)]
    pub thinking_level: ThinkingLevel,
    /// 완료 시 결과를 돌려보낼 채널 (fire-and-forget용).
    /// Some이면 완료 후 이 채널로 결과 전송. reply_tx보다 우선순위가 낮다.
    pub completion_tx: Option<mpsc::Sender<String>>,
}

/// `send_to_agent` 완료 콜백 전달 시 필요한 채널 정보.
pub struct CompletionDeliveryInfo {
    /// 슈퍼마스터/DashboardChannel inbox — 있으면 최우선으로 사용.
    pub inbox_tx: Option<mpsc::Sender<ChannelMessage>>,
    /// 스폰된 에이전트의 task_tx — inbox_tx 없을 때 사용.
    pub agent_task_tx: Option<mpsc::Sender<AgentTask>>,
    /// 프라이머리(텔레그램) inject_tx — 최후 fallback.
    pub primary_inject_tx: Option<mpsc::Sender<ChannelMessage>>,
    /// L0 admin_chat_id — ChannelMessage.sender 값으로 사용.
    pub admin_chat_id: i64,
}

/// 에이전트 스폰 요청.
pub struct SpawnRequest {
    pub name: String,
    /// 로컬 별칭 (선택사항) — 같은 spec(name)으로 여러 인스턴스 구분용.
    pub nickname: Option<String>,
    pub tier: u8,
    /// 에이전트 역할 설명 — 시스템 프롬프트 자동 생성에 사용.
    pub role: String,
    /// 에이전트 계층 역할 (L0~L3).
    pub agent_role: AgentRole,
    /// 모델 티어 (None = 기본값).
    pub model_tier: Option<u8>,
    /// true = 상주, false = 태스크 완료 후 소멸 (현재 구현에서는 상주와 동일하게 채널 유지).
    pub persistent: bool,
    /// Some(token) → 텔레그램 채널로 직접 통신하는 L1 에이전트로 spawn.
    /// None → 기존 InternalChannel(IPC) 방식 L2 에이전트.
    pub bot_token: Option<String>,
    /// 텔레그램 admin chat id. bot_token이 Some일 때 사용.
    pub admin_chat_id: Option<i64>,
    /// 복원 시 사용할 시스템 프롬프트 오버라이드.
    /// Some이면 role 기반 자동 생성 대신 이 값을 사용.
    pub system_prompt_override: Option<String>,
    /// Phase 8-2: 이 에이전트의 Hooks HTTP API 엔드포인트 (예: "http://localhost:3002").
    /// Some이면 send_to_agent가 IPC 대신 직통 HTTP로 메시지를 전달한다.
    pub hooks_url: Option<String>,
    /// Phase 8-2: 직통 Hooks API 인증 토큰.
    pub hooks_token: Option<String>,
    /// 부모 에이전트 이름 (L0는 None, L1은 supermaster 이름, L2는 L1 이름).
    pub parent_agent: Option<String>,
    /// 소속 팀 이름 (선택사항).
    pub team: Option<String>,
    /// 툴 접근 수준 ("full" | "limited"). 기본 "full".
    pub clearance: Option<String>,
}

/// 실행 중인 에이전트 정보 (list 응답용).
#[derive(Debug, Clone)]
pub struct AgentInfo {
    pub name: String,
    /// 로컬 별칭 — 같은 spec(name)으로 여러 인스턴스 구분용 (선택사항).
    pub nickname: Option<String>,
    pub tier: u8,
    pub persistent: bool,
    /// "telegram" | "internal"
    pub channel_type: String,
    pub agent_role: AgentRole,
    /// Phase 8-2: 직통 Hooks 엔드포인트 (있는 경우).
    pub hooks_url: Option<String>,
    /// 부모 에이전트 이름.
    pub parent_agent: Option<String>,
    /// 소속 팀 이름 (선택사항).
    pub team: Option<String>,
    /// 툴 접근 수준 ("full" | "limited").
    pub clearance: Option<String>,
}

// ---------------------------------------------------------------------------
// Internal handle
// ---------------------------------------------------------------------------

struct AgentHandle {
    name: String,
    /// 로컬 별칭 (선택사항).
    nickname: Option<String>,
    tier: u8,
    persistent: bool,
    /// "telegram" | "internal"
    channel_type: String,
    agent_role: AgentRole,
    task_tx: mpsc::Sender<AgentTask>,
    join_handle: JoinHandle<()>,
    /// 마지막 활동 시간 (Unix timestamp). 유휴 에이전트 자동 종료에 사용.
    last_active: Arc<AtomicI64>,
    /// Phase 8-2: 직통 Hooks 엔드포인트.
    hooks_url: Option<String>,
    /// Phase 8-2: 직통 Hooks 인증 토큰.
    hooks_token: Option<String>,
    /// Phase 9-4: steer 신호 송신기.
    steer_tx: mpsc::Sender<String>,
    /// 부모 에이전트 이름.
    parent_agent: Option<String>,
    /// 소속 팀 이름 (선택사항).
    team: Option<String>,
    /// 툴 접근 수준 ("full" | "limited").
    clearance: Option<String>,
    /// KeepAlive: kill_agent() 호출 시 true로 설정 → keepalive 루프가 재spawn을 중단한다.
    intentionally_killed: Arc<AtomicBool>,
    /// true이면 이 에이전트는 KeepAlive 루프로 관리됨 (채널 닫힘 시 자동 재spawn).
    is_keepalive: bool,
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/// `send_to_agent` 툴에서 한 번의 lock으로 꺼내는 전송용 정보.
pub struct AgentSendInfo {
    pub task_tx: mpsc::Sender<AgentTask>,
    pub hooks_url: Option<String>,
    pub hooks_token: Option<String>,
    /// true이면 KeepAlive 관리 에이전트 — 채널 닫힘 시 registry에서 제거하지 않음.
    pub is_keepalive: bool,
}

/// 동적으로 spawn된 에이전트들을 관리하는 레지스트리.
///
/// `Arc<Mutex<AgentRegistry>>`로 래핑되어 툴들과 공유된다.
pub struct AgentRegistry {
    agents: HashMap<String, AgentHandle>,
    provider: Arc<dyn Provider>,
    tools: Vec<Arc<dyn Tool>>,
    /// SQLite 영속화 저장소. None이면 영속화 비활성화.
    store: Option<Arc<AgentStore>>,
    /// Phase 8-2: 이벤트 모니터 (None이면 모니터링 비활성화).
    pub monitor: Option<Arc<Monitor>>,
    /// Phase 9-1: 대시보드 broadcast sender (None이면 비활성화).
    event_tx: Option<broadcast::Sender<DashboardEvent>>,
    /// 슈퍼마스터(L0) 자신의 정보 — GET /api/agents 및 broadcast에 항상 포함.
    supermaster: Option<AgentStatusInfo>,
    /// 에이전트별 현재 실행 상태 ("idle" | "thinking" | "executing:tool명").
    status_map: HashMap<String, String>,
    /// Phase 9-4: 에이전트별 steer 송신기 (슈퍼마스터 포함).
    steer_txs: HashMap<String, mpsc::Sender<String>>,
    /// 대시보드 메시지 주입 채널 (에이전트별 inbox_tx).
    inbox_txs: HashMap<String, mpsc::Sender<ChannelMessage>>,
    /// 프라이머리 채널(TelegramChannel)의 inject sender — 대시보드 메시지를 메인채널로 직접 주입.
    primary_inject_tx: Option<mpsc::Sender<ChannelMessage>>,
    /// spawn된 에이전트 대화 저장용 채널 (ConversationStore는 !Send이므로 채널로 위임).
    /// 튜플: (chat_id, ChatMessage, sender: Option<String>)
    conv_save_tx: Option<mpsc::Sender<(String, ChatMessage, Option<String>)>>,
    /// 대화 initiator 저장 채널: (chat_id, initiator)
    initiator_tx: Option<mpsc::Sender<(String, String)>>,
    /// L0 admin_chat_id — spawn 에이전트 보고 시 수신자.
    admin_chat_id: i64,
}

impl AgentRegistry {
    /// 새 레지스트리 생성. provider와 tools는 spawn된 에이전트들이 공유한다.
    pub fn new(provider: Arc<dyn Provider>, tools: Vec<Arc<dyn Tool>>) -> Self {
        Self {
            agents: HashMap::new(),
            provider,
            tools,
            store: None,
            monitor: None,
            event_tx: None,
            supermaster: None,
            status_map: HashMap::new(),
            steer_txs: HashMap::new(),
            inbox_txs: HashMap::new(),
            primary_inject_tx: None,
            conv_save_tx: None,
            initiator_tx: None,
            admin_chat_id: 0,
        }
    }

    /// AgentStore가 연결된 레지스트리 생성.
    pub fn new_with_store(
        provider: Arc<dyn Provider>,
        tools: Vec<Arc<dyn Tool>>,
        store: Arc<AgentStore>,
    ) -> Self {
        Self {
            agents: HashMap::new(),
            provider,
            tools,
            store: Some(store),
            monitor: None,
            event_tx: None,
            supermaster: None,
            status_map: HashMap::new(),
            steer_txs: HashMap::new(),
            inbox_txs: HashMap::new(),
            primary_inject_tx: None,
            conv_save_tx: None,
            initiator_tx: None,
            admin_chat_id: 0,
        }
    }

    /// spawn된 에이전트 대화 저장용 채널 설정.
    pub fn set_conv_save_tx(&mut self, tx: mpsc::Sender<(String, ChatMessage, Option<String>)>) {
        self.conv_save_tx = Some(tx);
    }

    /// 대화 initiator 저장용 채널 설정.
    pub fn set_initiator_tx(&mut self, tx: mpsc::Sender<(String, String)>) {
        self.initiator_tx = Some(tx);
    }

    /// L0 admin_chat_id 설정 (spawn 에이전트 보고 수신자).
    pub fn set_admin_chat_id(&mut self, id: i64) {
        self.admin_chat_id = id;
    }

    /// 에이전트 현재 상태 업데이트 ("idle" | "thinking" | "executing:tool명").
    pub fn update_status(&mut self, name: &str, status: &str) {
        self.status_map.insert(name.to_string(), status.to_string());
    }

    /// 에이전트 현재 상태 조회. 없으면 "idle" 반환.
    pub fn get_status(&self, name: &str) -> String {
        self.status_map.get(name).cloned().unwrap_or_else(|| "idle".to_string())
    }

    /// 슈퍼마스터(L0) 자신의 정보를 등록한다.
    ///
    /// 등록 후 `list()` 및 `broadcast_agent_status()` 결과 맨 앞에 포함된다.
    pub fn set_supermaster(&mut self, info: AgentStatusInfo) {
        self.supermaster = Some(info);
    }

    /// Phase 8-2: Monitor 설정. spawn/kill/comm 이벤트가 모니터링 채널에 기록된다.
    pub fn set_monitor(&mut self, monitor: Arc<Monitor>) {
        self.monitor = Some(monitor);
    }

    /// Phase 9-1: 대시보드 broadcast sender 설정.
    pub fn set_event_tx(&mut self, tx: broadcast::Sender<DashboardEvent>) {
        self.event_tx = Some(tx);
    }

    /// Phase 9-1: 현재 에이전트 목록을 AgentStatus 이벤트로 broadcast.
    /// 슈퍼마스터(L0) 자신도 목록 맨 앞에 포함된다.
    pub fn broadcast_agent_status(&self) {
        if let Some(ref tx) = self.event_tx {
            let mut agents: Vec<AgentStatusInfo> = Vec::new();
            // 슈퍼마스터 자신을 맨 앞에 추가.
            if let Some(ref sm) = self.supermaster {
                let mut sm_info = sm.clone();
                sm_info.current_status = self.get_status(&sm.name);
                agents.push(sm_info);
            }
            agents.extend(self.agents.values().map(|h| AgentStatusInfo {
                name: h.name.clone(),
                nickname: h.nickname.clone(),
                tier: h.tier,
                channel_type: h.channel_type.clone(),
                persistent: h.persistent,
                current_status: self.get_status(&h.name),
                parent_agent: h.parent_agent.clone(),
                team: h.team.clone(),
                clearance: h.clearance.clone(),
            }));
            let _ = tx.send(DashboardEvent::AgentStatus { agents });
        }
    }

    /// Phase 9-4: 에이전트의 steer 송신기를 등록한다 (슈퍼마스터 포함).
    pub fn register_steer_tx(&mut self, name: &str, tx: mpsc::Sender<String>) {
        self.steer_txs.insert(name.to_string(), tx);
    }

    /// 대시보드 메시지 주입용 inbox_tx를 등록한다 (슈퍼마스터용).
    pub fn register_inbox_tx(&mut self, name: &str, tx: mpsc::Sender<ChannelMessage>) {
        self.inbox_txs.insert(name.to_string(), tx);
    }

    /// 에이전트의 inbox_tx를 반환한다 (대시보드 메시지 주입용).
    pub fn get_inbox_tx(&self, name: &str) -> Option<mpsc::Sender<ChannelMessage>> {
        self.inbox_txs.get(name).cloned()
    }

    /// 에이전트에게 대시보드 메시지를 주입한다.
    /// - 슈퍼마스터: inbox_txs에 등록된 DashboardChannel 채널로 전달
    /// - 스폰된 에이전트: task_tx로 전달 (fire-and-forget)
    pub async fn inject_dashboard_message(&self, name: &str, msg: ChannelMessage) -> bool {
        // 슈퍼마스터 (inbox_txs)
        if let Some(tx) = self.inbox_txs.get(name) {
            return tx.send(msg).await.is_ok();
        }
        // 스폰된 에이전트 (task_tx) — fire-and-forget (reply_tx = None)
        if let Some(handle) = self.agents.get(name) {
            let content = msg.content.clone();
            if handle.task_tx.send(AgentTask { message: content, reply_tx: None, thinking_level: ThinkingLevel::Normal, completion_tx: None }).await.is_ok() {
                return true;
            }
        }
        false
    }

    /// 프라이머리 채널(TelegramChannel)의 inject sender를 등록한다.
    ///
    /// 대시보드 메시지를 텔레그램 채널 inbox로 직접 주입할 때 사용한다.
    pub fn set_primary_inject_tx(&mut self, tx: mpsc::Sender<ChannelMessage>) {
        self.primary_inject_tx = Some(tx);
    }

    /// 프라이머리 채널(TelegramChannel)로 메시지를 직접 주입한다.
    ///
    /// sender를 admin_chat_id로 설정하면 에이전트 응답이 텔레그램으로 전달된다.
    /// 반환값: true = 성공, false = inject_tx 미등록 또는 채널 닫힘.
    pub async fn inject_to_primary_channel(&self, msg: ChannelMessage) -> bool {
        if let Some(tx) = &self.primary_inject_tx {
            tx.send(msg).await.is_ok()
        } else {
            false
        }
    }

    /// Phase 9-4: 에이전트에게 steer 지시문을 전달한다.
    /// 반환값: true = 전송 성공, false = 에이전트 없음 또는 채널 닫힘.
    pub async fn send_steer(&self, name: &str, message: String) -> bool {
        if let Some(tx) = self.steer_txs.get(name) {
            tx.send(message).await.is_ok()
        } else {
            // 레지스트리에 없으면 spawn된 에이전트의 steer_tx 확인.
            if let Some(h) = self.agents.get(name) {
                h.steer_tx.send(message).await.is_ok()
            } else {
                false
            }
        }
    }

    /// send_to_agent 완료 콜백 전달용 채널 정보를 한 번의 lock으로 반환.
    ///
    /// 호출자는 lock 해제 후 비동기 전송을 수행해야 deadlock을 피할 수 있다.
    pub fn get_completion_delivery_info(&self, to_name: &str) -> CompletionDeliveryInfo {
        CompletionDeliveryInfo {
            inbox_tx: self.inbox_txs.get(to_name).cloned(),
            agent_task_tx: self.agents.get(to_name).map(|h| h.task_tx.clone()),
            primary_inject_tx: self.primary_inject_tx.clone(),
            admin_chat_id: self.admin_chat_id,
        }
    }

    /// Phase 8-2: 전송용 정보를 한 번의 접근으로 반환 (lock 최소화용).
    pub fn get_send_info(&self, name: &str) -> Option<AgentSendInfo> {
        self.agents.get(name).map(|h| AgentSendInfo {
            task_tx: h.task_tx.clone(),
            hooks_url: h.hooks_url.clone(),
            hooks_token: h.hooks_token.clone(),
            is_keepalive: h.is_keepalive,
        })
    }

    /// 채널이 닫힌 죽은 에이전트를 레지스트리에서 제거한다 (JoinHandle abort 없이).
    ///
    /// `send_to_agent`에서 채널 닫힘 감지 시, 비-KeepAlive 에이전트 정리에 사용한다.
    pub fn remove_dead_agent(&mut self, name: &str) {
        if let Some(_handle) = self.agents.remove(name) {
            // join_handle은 abort하지 않음 — 이미 종료됐으므로.
            self.status_map.remove(name);
            if let Some(ref store) = self.store {
                if let Err(e) = store.remove(name) {
                    warn!(name, error = %e, "remove_dead_agent: AgentStore remove 실패 (무시)");
                }
            }
            info!(name, "remove_dead_agent: 죽은 에이전트 레지스트리에서 제거");
            self.broadcast_agent_status();
        }
    }

    /// KeepAlive 재spawn 시 에이전트의 채널 송신기를 갱신한다.
    ///
    /// keepalive_agent_loop에서 새 run 시작 전 호출된다.
    pub fn update_agent_task_tx(
        &mut self,
        name: &str,
        new_task_tx: mpsc::Sender<AgentTask>,
        new_steer_tx: mpsc::Sender<String>,
    ) {
        if let Some(handle) = self.agents.get_mut(name) {
            handle.task_tx = new_task_tx;
            handle.steer_tx = new_steer_tx;
            handle.last_active.store(chrono::Local::now().timestamp(), Ordering::Relaxed);
            debug!(name, "update_agent_task_tx: 채널 갱신 완료");
        }
    }

    /// 새 에이전트를 spawn하고 이름을 반환한다.
    ///
    /// `registry_arc`가 Some이면 persistent=false 에이전트가 완료됐을 때 자동으로 registry에서 제거된다.
    pub async fn spawn_agent(
        &mut self,
        req: SpawnRequest,
        registry_arc: Option<Arc<Mutex<AgentRegistry>>>,
    ) -> anyhow::Result<String> {
        if self.agents.contains_key(&req.name) {
            return Err(anyhow::anyhow!(
                "에이전트 '{}' 이미 존재합니다. kill 후 다시 시도하세요.",
                req.name
            ));
        }

        // 슈퍼마스터는 1개만 허용.
        if req.agent_role == AgentRole::Supermaster {
            let already = self.agents.values().any(|h| h.agent_role == AgentRole::Supermaster);
            if already {
                return Err(anyhow::anyhow!("슈퍼마스터는 1개만 존재할 수 있습니다. 기존 슈퍼마스터를 먼저 kill하세요."));
            }
        }

        // 역할 기반 시스템 프롬프트 자동 생성 (오버라이드 우선).
        let system_prompt = req
            .system_prompt_override
            .clone()
            .unwrap_or_else(|| build_system_prompt(&req.name, &req.role));
        // store 저장용 복사본 (spawn 클로저에 moved 되기 전).
        let system_prompt_for_store = system_prompt.clone();

        let (task_tx, task_rx) = mpsc::channel::<AgentTask>(32);
        // Phase 9-4: steer 채널 생성.
        let (steer_tx_handle, steer_rx_spawned) = mpsc::channel::<String>(8);
        let provider = self.provider.clone();
        let tools = self.tools.clone();
        // 부모 에이전트의 inject_tx — 작업 완료 시 결과 자동 주입용.
        let parent_inject_tx = self.primary_inject_tx.clone();
        let _parent_name = req.parent_agent.clone();
        // 부모 에이전트의 task_tx — initiator가 에이전트인 경우 완료 결과를 직접 push.
        // parent_agent가 "user"이거나 없으면 None (→ primary_inject_tx로 fallback).
        let parent_task_tx: Option<mpsc::Sender<AgentTask>> = req
            .parent_agent
            .as_ref()
            .filter(|p| !p.is_empty() && p.as_str() != "user")
            .and_then(|parent_name| self.agents.get(parent_name))
            .map(|h| h.task_tx.clone());
        // 대시보드 이벤트 + 대화 저장용.
        let spawn_event_tx = self.event_tx.clone();
        let spawn_conv_tx = self.conv_save_tx.clone();
        let admin_chat_id_val = self.admin_chat_id;

        let name = req.name.clone();

        let channel_type: String;
        let join_handle: JoinHandle<()>;
        // KeepAlive 관련 변수 (persistent 내부 에이전트일 때만 Some).
        let mut keepalive_flag: bool = false;
        let mut intentionally_killed_arc: Option<Arc<AtomicBool>> = None;

        if let Some(bot_token) = req.bot_token.clone() {
            // bot_token 있음 → TelegramChannel로 직접 소통하는 L1 에이전트.
            // send_to_agent 동시 지원은 TODO.
            let admin_chat_id = req.admin_chat_id.unwrap_or(0);
            channel_type = "telegram".to_string();
            join_handle = tokio::spawn(async move {
                run_telegram_agent(
                    name.clone(),
                    provider,
                    tools,
                    system_prompt,
                    bot_token,
                    admin_chat_id,
                )
                .await;
                debug!(name = %name, "telegram agent task ended");
            });
        } else {
            // bot_token 없음 → 기존 InternalChannel(IPC) 방식.
            channel_type = "internal".to_string();
            let persistent_flag = req.persistent;
            if !persistent_flag {
                // Non-persistent: 첫 태스크 완료 후 loop 종료 + registry에서 자동 제거.
                let (cleanup_tx, cleanup_rx) = oneshot::channel::<String>();
                let inject_tx = parent_inject_tx.clone();
                let agent_name_for_report = name.clone();
                let etx = spawn_event_tx.clone();
                let conv_tx_clone = spawn_conv_tx.clone();
                let ptx = parent_task_tx.clone();
                join_handle = tokio::spawn(async move {
                    run_spawned_agent(name.clone(), provider, tools, system_prompt, task_rx, steer_rx_spawned, false, inject_tx, agent_name_for_report, etx, conv_tx_clone, admin_chat_id_val, ptx).await;
                    debug!(name = %name, "non-persistent agent task ended");
                    let _ = cleanup_tx.send(name.clone());
                });
                if let Some(reg_arc) = registry_arc {
                    tokio::spawn(async move {
                        if let Ok(agent_name) = cleanup_rx.await {
                            let mut reg = reg_arc.lock().await;
                            if let Some(handle) = reg.agents.get(&agent_name) {
                                if !handle.persistent {
                                    reg.agents.remove(&agent_name);
                                    info!(name = %agent_name, "non-persistent agent auto-removed after completion");
                                }
                            }
                        }
                    });
                }
            } else {
                // Persistent (상주) 에이전트: KeepAlive 루프로 감쌈.
                // 크래시/패닉 등 비정상 종료 시 backoff 후 자동 재spawn.
                let intentionally_killed = Arc::new(AtomicBool::new(false));
                let ik = intentionally_killed.clone();
                let inject_tx = parent_inject_tx.clone();
                let agent_name_for_report = name.clone();
                let etx = spawn_event_tx.clone();
                let conv_tx_clone = spawn_conv_tx.clone();
                let ptx = parent_task_tx.clone();
                // registry_arc가 Some이어야 keepalive가 task_tx를 갱신할 수 있다.
                // None인 경우(restore_from_store 등) keepalive 없이 단순 spawn으로 fallback.
                if let Some(reg_arc) = registry_arc {
                    let ka_reg = reg_arc.clone();
                    join_handle = tokio::spawn(async move {
                        keepalive_agent_loop(
                            name.clone(),
                            provider,
                            tools,
                            system_prompt,
                            task_rx,
                            steer_rx_spawned,
                            inject_tx,
                            agent_name_for_report,
                            etx,
                            conv_tx_clone,
                            admin_chat_id_val,
                            ptx,
                            ka_reg,
                            ik,
                        )
                        .await;
                        debug!(name = %name, "keepalive agent loop fully ended");
                    });
                    // is_keepalive = true — kill_agent와 send_to_agent가 이를 확인.
                    keepalive_flag = true;
                    intentionally_killed_arc = Some(intentionally_killed);
                } else {
                    // registry_arc 없음: 단순 persistent 실행 (재spawn 없음).
                    join_handle = tokio::spawn(async move {
                        run_spawned_agent(name.clone(), provider, tools, system_prompt, task_rx, steer_rx_spawned, true, inject_tx, agent_name_for_report, etx, conv_tx_clone, admin_chat_id_val, ptx).await;
                        debug!(name = %name, "persistent agent (no-keepalive) task ended");
                    });
                }
            }
        }

        let last_active = Arc::new(AtomicI64::new(chrono::Local::now().timestamp()));

        self.agents.insert(
            req.name.clone(),
            AgentHandle {
                name: req.name.clone(),
                nickname: req.nickname.clone(),
                tier: req.tier,
                persistent: req.persistent,
                channel_type: channel_type.clone(),
                agent_role: req.agent_role.clone(),
                task_tx,
                join_handle,
                last_active,
                hooks_url: req.hooks_url.clone(),
                hooks_token: req.hooks_token.clone(),
                steer_tx: steer_tx_handle,
                parent_agent: req.parent_agent.clone(),
                team: req.team.clone(),
                clearance: req.clearance.clone(),
                intentionally_killed: intentionally_killed_arc
                    .unwrap_or_else(|| Arc::new(AtomicBool::new(false))),
                is_keepalive: keepalive_flag,
            },
        );

        info!(
            name = %req.name,
            tier = req.tier,
            persistent = req.persistent,
            channel_type = %channel_type,
            hooks_url = ?req.hooks_url,
            "registry agent spawned"
        );

        // Phase 8-2: 모니터링 채널에 spawn 이벤트 기록.
        // Phase 9-1: 대시보드 broadcast 포함.
        if let Some(ref monitor) = self.monitor {
            let monitor = monitor.clone();
            let name = req.name.clone();
            let tier = req.tier;
            tokio::spawn(async move {
                monitor.log_spawn(&name, tier).await;
            });
        }

        // 새 에이전트 상태를 "idle"로 초기화.
        self.status_map.insert(req.name.clone(), "idle".to_string());

        // initiator 저장: parent_agent가 있으면 부모 에이전트 이름, 없으면 "user".
        if let Some(ref itx) = self.initiator_tx {
            let chat_id = req.name.clone();
            let initiator = req.parent_agent.clone().unwrap_or_else(|| "user".to_string());
            let itx = itx.clone();
            tokio::spawn(async move {
                let _ = itx.send((chat_id, initiator)).await;
            });
        }

        // Phase 9-1: AgentStatus 스냅샷 broadcast (spawn 후 전체 목록 갱신).
        self.broadcast_agent_status();

        // persistent=true인 에이전트만 DB에 저장.
        if req.persistent {
            if let Some(ref store) = self.store {
                let persisted = PersistedAgent {
                    name: req.name.clone(),
                    tier: req.tier,
                    agent_role: agent_role_to_str(&req.agent_role).to_string(),
                    channel_type: channel_type.clone(),
                    bot_token: req.bot_token.clone(),
                    admin_chat_id: req.admin_chat_id,
                    system_prompt: system_prompt_for_store,
                    persistent: true,
                    status: "running".to_string(),
                    parent_agent: req.parent_agent.clone(),
                    team: req.team.clone(),
                    clearance: req.clearance.clone(),
                };
                if let Err(e) = store.save(&persisted) {
                    warn!(name = %req.name, error = %e, "AgentStore save 실패 (무시)");
                }
            }
        }

        Ok(req.name)
    }

    /// 에이전트의 task_tx를 반환한다. lock 최소화용 헬퍼.
    ///
    /// `SendToAgentTool::execute`에서 lock 안에서 task_tx만 꺼내고
    /// lock을 즉시 해제한 뒤 응답을 기다리는 패턴에 사용한다.
    pub fn get_task_tx(&self, name: &str) -> Option<mpsc::Sender<AgentTask>> {
        self.agents.get(name).map(|h| h.task_tx.clone())
    }

    /// 에이전트에 태스크를 전달하고 응답을 기다린다.
    ///
    /// # 주의
    /// 이 메서드는 내부적으로 `reply_rx.await`로 에이전트 응답을 기다린다.
    /// `Arc<Mutex<AgentRegistry>>`의 lock을 잡은 상태에서 호출하면 deadlock이 발생한다.
    /// 대신 `get_task_tx`로 task_tx를 꺼낸 뒤 lock을 해제하고 직접 send/await하거나,
    /// lock 없이 호출하는 컨텍스트에서만 사용하라.
    pub async fn send_task(&self, name: &str, message: String) -> anyhow::Result<String> {
        let (task_tx, last_active) = self
            .agents
            .get(name)
            .map(|h| (h.task_tx.clone(), h.last_active.clone()))
            .ok_or_else(|| anyhow::anyhow!("에이전트 '{}' 없음. list_agents로 목록 확인하세요.", name))?;

        // 활동 시간 갱신
        last_active.store(chrono::Local::now().timestamp(), Ordering::Relaxed);

        let (reply_tx, reply_rx) = oneshot::channel();
        task_tx
            .send(AgentTask {
                message,
                reply_tx: Some(reply_tx),
                thinking_level: ThinkingLevel::Normal,
                completion_tx: None,
            })
            .await
            .map_err(|_| anyhow::anyhow!("에이전트 '{}' 채널이 닫혔습니다. 종료되었을 수 있습니다.", name))?;

        reply_rx
            .await
            .map_err(|_| anyhow::anyhow!("에이전트 '{}' 응답 수신 실패 (에이전트가 패닉했을 수 있음)", name))
    }

    /// 에이전트를 종료한다. 반환값: true = 성공, false = 에이전트 없음.
    pub fn kill_agent(&mut self, name: &str) -> bool {
        if let Some(handle) = self.agents.remove(name) {
            // KeepAlive 루프에게 의도적 종료임을 알려 재spawn을 막는다.
            handle.intentionally_killed.store(true, Ordering::Relaxed);
            handle.join_handle.abort();
            info!(name, "registry agent killed");
            // status_map에서도 제거.
            self.status_map.remove(name);
            // DB에서도 제거.
            if let Some(ref store) = self.store {
                if let Err(e) = store.remove(name) {
                    warn!(name, error = %e, "AgentStore remove 실패 (무시)");
                }
            }
            // Phase 8-2: 모니터링 채널에 kill 이벤트 기록.
            // Phase 9-1: 대시보드 broadcast 포함.
            if let Some(ref monitor) = self.monitor {
                let monitor = monitor.clone();
                let agent_name = name.to_string();
                tokio::spawn(async move {
                    monitor.log_kill(&agent_name).await;
                });
            }

            // Phase 9-1: AgentStatus 스냅샷 broadcast (kill 후 전체 목록 갱신).
            self.broadcast_agent_status();
            true
        } else {
            false
        }
    }

    /// 유휴 에이전트를 자동 종료한다.
    ///
    /// `idle_timeout_secs` 초 이상 활동이 없는 에이전트를 종료하고 종료된 이름 목록을 반환.
    pub fn cleanup_idle_agents(&mut self, idle_timeout_secs: u64) -> Vec<String> {
        if idle_timeout_secs == 0 {
            return vec![];
        }

        let now = chrono::Local::now().timestamp();
        let threshold = idle_timeout_secs as i64;

        let idle_names: Vec<String> = self
            .agents
            .iter()
            .filter(|(_, h)| {
                let last = h.last_active.load(Ordering::Relaxed);
                (now - last) >= threshold
            })
            .map(|(name, _)| name.clone())
            .collect();

        let mut removed = Vec::new();
        for name in idle_names {
            if let Some(handle) = self.agents.remove(&name) {
                handle.join_handle.abort();
                info!(name = %name, idle_secs = idle_timeout_secs, "idle agent auto-terminated");
                // DB에서도 제거
                if let Some(ref store) = self.store {
                    if let Err(e) = store.remove(&name) {
                        warn!(name = %name, error = %e, "AgentStore remove 실패 (무시)");
                    }
                }
                removed.push(name);
            }
        }

        removed
    }

    /// 현재 실행 중인 에이전트 목록 반환.
    /// 슈퍼마스터(L0) 자신이 set_supermaster()로 등록된 경우 맨 앞에 포함된다.
    pub fn list(&self) -> Vec<AgentInfo> {
        let mut result: Vec<AgentInfo> = Vec::new();
        // 슈퍼마스터 자신을 맨 앞에 추가.
        if let Some(ref sm) = self.supermaster {
            result.push(AgentInfo {
                name: sm.name.clone(),
                nickname: sm.nickname.clone(),
                tier: sm.tier,
                persistent: sm.persistent,
                channel_type: sm.channel_type.clone(),
                agent_role: AgentRole::Supermaster,
                hooks_url: None,
                parent_agent: None,
                team: sm.team.clone(),
                clearance: Some("full".to_string()),
            });
        }
        // Supermaster는 이미 위에서 추가했으므로 제외.
        let sm_name = self.supermaster.as_ref().map(|s| s.name.as_str()).unwrap_or("");
        result.extend(
            self.agents.values()
                .filter(|h| h.name != sm_name)
                .map(|h| AgentInfo {
                    name: h.name.clone(),
                    nickname: h.nickname.clone(),
                    tier: h.tier,
                    persistent: h.persistent,
                    channel_type: h.channel_type.clone(),
                    agent_role: h.agent_role.clone(),
                    hooks_url: h.hooks_url.clone(),
                    parent_agent: h.parent_agent.clone(),
                    team: h.team.clone(),
                    clearance: h.clearance.clone(),
                })
        );
        result
    }

    /// 특정 팀에 속한 에이전트 이름 목록 반환.
    pub fn list_by_team(&self, team_name: &str) -> Vec<String> {
        self.agents
            .values()
            .filter(|h| h.team.as_deref() == Some(team_name))
            .map(|h| h.name.clone())
            .collect()
    }

    /// 팀 목록 반환 (팀명 → 에이전트 수).
    pub fn team_summary(&self) -> std::collections::HashMap<String, usize> {
        let mut map: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
        for h in self.agents.values() {
            if let Some(ref t) = h.team {
                if !t.is_empty() {
                    *map.entry(t.clone()).or_insert(0) += 1;
                }
            }
        }
        map
    }

    /// 특정 팀의 에이전트를 모두 kill한다. 반환값: kill된 이름 목록.
    pub fn kill_team(&mut self, team_name: &str) -> Vec<String> {
        let names: Vec<String> = self
            .agents
            .iter()
            .filter(|(_, h)| h.team.as_deref() == Some(team_name))
            .map(|(name, _)| name.clone())
            .collect();
        let mut killed = Vec::new();
        for name in names {
            if self.kill_agent(&name) {
                killed.push(name);
            }
        }
        killed
    }

    /// DB에서 에이전트 목록을 로드하여 status="running"인 것들을 재spawn한다.
    ///
    /// `registry_arc`를 전달하면 복원된 persistent 에이전트가 KeepAlive 모드로 실행된다.
    /// 실패해도 tiguclaw 시작은 계속된다 (에러 로그만).
    pub async fn restore_from_store(&mut self, registry_arc: Option<Arc<Mutex<AgentRegistry>>>) {
        let store = match &self.store {
            Some(s) => s.clone(),
            None => return,
        };

        let agents = match store.load_all() {
            Ok(a) => a,
            Err(e) => {
                warn!(error = %e, "AgentStore load_all 실패 — 복원 건너뜀");
                return;
            }
        };

        let to_restore: Vec<PersistedAgent> = agents
            .into_iter()
            .filter(|a| a.status == "running")
            .collect();

        if to_restore.is_empty() {
            info!("restore_from_store: 복원할 에이전트 없음");
            return;
        }

        info!(count = to_restore.len(), "restore_from_store: 에이전트 복원 시작");

        for pa in to_restore {
            let req = SpawnRequest {
                name: pa.name.clone(),
                nickname: None,
                tier: pa.tier,
                role: String::new(), // system_prompt_override로 대체되므로 미사용
                agent_role: str_to_agent_role(&pa.agent_role),
                model_tier: None,
                persistent: pa.persistent,
                bot_token: pa.bot_token.clone(),
                admin_chat_id: pa.admin_chat_id,
                system_prompt_override: Some(pa.system_prompt.clone()),
                hooks_url: None,
                hooks_token: None,
                parent_agent: pa.parent_agent.clone(),
                team: pa.team.clone(),
                clearance: pa.clearance.clone().or_else(|| {
                    Some(if pa.tier == 0 { "full" } else { "minimal" }.to_string())
                }),
            };

            match self.spawn_agent(req, registry_arc.clone()).await {
                Ok(name) => {
                    info!(name = %name, "restore_from_store: 에이전트 복원 완료");
                }
                Err(e) => {
                    warn!(name = %pa.name, error = %e, "restore_from_store: 에이전트 복원 실패");
                    // DB 상태를 "error"로 업데이트.
                    if let Err(e2) = store.update_status(&pa.name, "error") {
                        warn!(name = %pa.name, error = %e2, "update_status error 실패 (무시)");
                    }
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// AgentRole 직렬화 헬퍼
// ---------------------------------------------------------------------------

fn agent_role_to_str(role: &AgentRole) -> &'static str {
    match role {
        AgentRole::Supermaster => "supermaster",
        AgentRole::Master => "master",
        AgentRole::Mini => "mini",
        AgentRole::Worker => "worker",
    }
}

fn str_to_agent_role(s: &str) -> AgentRole {
    match s {
        "supermaster" => AgentRole::Supermaster,
        "master" => AgentRole::Master,
        "mini" => AgentRole::Mini,
        "worker" => AgentRole::Worker,
        _ => AgentRole::Master,
    }
}

// ---------------------------------------------------------------------------
// System prompt builder
// ---------------------------------------------------------------------------

fn build_system_prompt(name: &str, role: &str) -> String {
    format!(
        "당신은 '{name}'이라는 이름의 AI 에이전트입니다.\n\n\
         역할: {role}\n\n\
         주어진 태스크를 정확하고 효율적으로 처리하세요. \
         결과는 명확하고 간결하게 반환하세요.\n\
         마스터 에이전트의 하위 에이전트로서, \
         할당된 태스크에만 집중합니다."
    )
}

// ---------------------------------------------------------------------------
// KeepAlive 루프
// ---------------------------------------------------------------------------

/// 상주(persistent) 에이전트를 KeepAlive 루프로 실행한다.
///
/// `run_spawned_agent`가 비정상 종료(채널 닫힘, 패닉 등)하면 지수 백오프 후 재spawn한다.
/// `intentionally_killed` 플래그가 true이거나 최대 재시도 횟수를 초과하면 루프를 종료한다.
async fn keepalive_agent_loop(
    name: String,
    provider: Arc<dyn Provider>,
    tools: Vec<Arc<dyn Tool>>,
    system_prompt: String,
    initial_task_rx: mpsc::Receiver<AgentTask>,
    initial_steer_rx: mpsc::Receiver<String>,
    inject_tx: Option<mpsc::Sender<ChannelMessage>>,
    agent_name_for_report: String,
    event_tx: Option<broadcast::Sender<DashboardEvent>>,
    conv_save_tx: Option<mpsc::Sender<(String, ChatMessage, Option<String>)>>,
    admin_chat_id: i64,
    parent_task_tx: Option<mpsc::Sender<AgentTask>>,
    registry_arc: Arc<Mutex<AgentRegistry>>,
    intentionally_killed: Arc<AtomicBool>,
) {
    const MAX_RETRIES: u32 = 5;
    let mut attempt: u32 = 0;
    let mut current_task_rx = initial_task_rx;
    let mut current_steer_rx = initial_steer_rx;

    info!(name = %name, "keepalive: loop started");

    loop {
        run_spawned_agent(
            name.clone(),
            provider.clone(),
            tools.clone(),
            system_prompt.clone(),
            current_task_rx,
            current_steer_rx,
            true, // persistent
            inject_tx.clone(),
            agent_name_for_report.clone(),
            event_tx.clone(),
            conv_save_tx.clone(),
            admin_chat_id,
            parent_task_tx.clone(),
        )
        .await;

        // 의도적 종료(kill_agent) 여부 확인.
        if intentionally_killed.load(Ordering::Relaxed) {
            info!(name = %name, "keepalive: intentionally killed — stopping keepalive loop");
            break;
        }

        attempt += 1;
        if attempt > MAX_RETRIES {
            warn!(
                name = %name,
                max_retries = MAX_RETRIES,
                "keepalive: max retries exceeded — removing agent from registry"
            );
            let mut reg = registry_arc.lock().await;
            reg.remove_dead_agent(&name);
            break;
        }

        // 지수 백오프: 2^attempt 초 (최대 32초).
        let delay_secs = 2u64.pow(attempt.min(5));
        warn!(
            name = %name,
            attempt,
            delay_secs,
            "keepalive: agent exited unexpectedly — respawning after backoff"
        );
        tokio::time::sleep(tokio::time::Duration::from_secs(delay_secs)).await;

        // 의도적 종료: backoff 대기 중에 kill됐을 수도 있음.
        if intentionally_killed.load(Ordering::Relaxed) {
            info!(name = %name, "keepalive: killed during backoff — stopping");
            break;
        }

        // 새 채널 생성 후 레지스트리 task_tx 갱신.
        let (new_task_tx, new_task_rx) = mpsc::channel::<AgentTask>(32);
        let (new_steer_tx, new_steer_rx) = mpsc::channel::<String>(8);

        {
            let mut reg = registry_arc.lock().await;
            reg.update_agent_task_tx(&name, new_task_tx, new_steer_tx);
        }

        info!(name = %name, attempt, "keepalive: channels refreshed — restarting agent");
        current_task_rx = new_task_rx;
        current_steer_rx = new_steer_rx;
    }

    info!(name = %name, "keepalive: loop ended");
}

// ---------------------------------------------------------------------------
// Spawned agent execution loop
// ---------------------------------------------------------------------------

/// TelegramChannel을 사용하는 L1 에이전트 루프.
///
/// 텔레그램에서 직접 메시지를 수신하여 처리하고 응답을 전송한다.
/// NOTE: send_to_agent(IPC) 동시 지원은 TODO.
async fn run_telegram_agent(
    name: String,
    provider: Arc<dyn Provider>,
    tools: Vec<Arc<dyn Tool>>,
    system_prompt: String,
    bot_token: String,
    admin_chat_id: i64,
) {
    info!(name = %name, admin_chat_id, "telegram agent loop started");

    let channel = Arc::new(TelegramChannel::new(&bot_token, admin_chat_id));
    let (tx, mut rx) = mpsc::channel::<tiguclaw_core::types::ChannelMessage>(32);

    // 텔레그램 listener를 별도 태스크로 실행.
    let channel_for_listen = channel.clone();
    tokio::spawn(async move {
        if let Err(e) = channel_for_listen.listen(tx).await {
            warn!(name = "telegram-listener", error = %e, "telegram listener error");
        }
    });

    let mut history: Vec<ChatMessage> = Vec::new();

    while let Some(msg) = rx.recv().await {
        debug!(name = %name, sender = %msg.sender, "telegram agent received message");

        // typing indicator
        let _ = channel.send_typing(&msg.sender).await;

        let result = run_agent_task(
            &name,
            &provider,
            &tools,
            &system_prompt,
            &mut history,
            msg.content,
            ThinkingLevel::Normal,
            &None,
            &None,
        )
        .await;

        let response = match result {
            Ok(text) => text,
            Err(e) => {
                warn!(name = %name, error = %e, "telegram agent task failed");
                format!("❌ 에이전트 오류: {e}")
            }
        };

        if let Err(e) = channel.send(&msg.sender, &response).await {
            warn!(name = %name, error = %e, "failed to send telegram response");
        }
    }

    info!(name = %name, "telegram agent loop ended");
}

/// spawn된 에이전트의 메인 루프.
///
/// `task_rx`에서 `AgentTask`를 수신하여 처리하고 `reply_tx`로 응답을 반환한다.
/// `steer_rx`에서 steer 지시문을 수신하여 다음 태스크에 주입한다.
/// 채널이 닫히면 루프를 종료한다.
async fn run_spawned_agent(
    name: String,
    provider: Arc<dyn Provider>,
    tools: Vec<Arc<dyn Tool>>,
    system_prompt: String,
    mut task_rx: mpsc::Receiver<AgentTask>,
    mut steer_rx: mpsc::Receiver<String>,
    persistent: bool,
    parent_inject_tx: Option<mpsc::Sender<ChannelMessage>>,
    agent_name: String,
    event_tx: Option<broadcast::Sender<DashboardEvent>>,
    conv_save_tx: Option<mpsc::Sender<(String, ChatMessage, Option<String>)>>,
    admin_chat_id: i64,
    // initiator가 에이전트인 경우 해당 에이전트의 task_tx (완료 결과 push용).
    // None이면 primary_inject_tx(텔레그램)로 fallback.
    parent_task_tx: Option<mpsc::Sender<AgentTask>>,
) {
    info!(name = %name, persistent, "spawned agent loop started");

    // 대화 이력 (에이전트별로 유지).
    let mut history: Vec<ChatMessage> = Vec::new();
    // Phase 9-4: steer 지시문 대기열.
    let mut steer_queue: Vec<String> = Vec::new();

    loop {
        // steer 대기열을 비동기로 드레인하지 않고 try_recv로 폴링.
        while let Ok(steer_msg) = steer_rx.try_recv() {
            info!(name = %name, message = %steer_msg, "spawned agent received steer directive");
            steer_queue.push(steer_msg);
        }

        let task = match task_rx.recv().await {
            Some(t) => t,
            None => break, // channel closed
        };

        info!(name = %name, message_len = %task.message.len(), "agent received task, processing");

        // steer 지시문이 있으면 태스크 메시지 앞에 주입.
        let effective_message = if !steer_queue.is_empty() {
            let steer_block = steer_queue
                .drain(..)
                .map(|d| format!("[STEER DIRECTIVE] {d}"))
                .collect::<Vec<_>>()
                .join("\n");
            format!("{steer_block}\n\n{}", task.message)
        } else {
            task.message
        };

        let result = run_agent_task(
            &name,
            &provider,
            &tools,
            &system_prompt,
            &mut history,
            effective_message,
            task.thinking_level,
            &event_tx,
            &conv_save_tx,
        )
        .await;

        let response = match result {
            Ok(text) => text,
            Err(e) => {
                warn!(name = %name, error = %e, "agent task failed");
                format!("❌ 에이전트 오류: {e}")
            }
        };

        if let Some(reply_tx) = task.reply_tx {
            if reply_tx.send(response.clone()).is_err() {
                warn!(name = %name, "reply_tx dropped before response could be sent");
            }
        } else if let Some(completion_tx) = task.completion_tx {
            // completion_tx 있으면 새 방식: send_to_agent 완료 콜백으로 결과 전달.
            if completion_tx.send(response.clone()).await.is_err() {
                warn!(name = %name, "completion_tx closed before response could be sent");
            } else {
                info!(name = %name, "completion result sent via completion_tx");
            }
        } else if let Some(ref ptx) = parent_task_tx {
            // initiator가 에이전트 → 부모 에이전트의 task_tx로 완료 결과 push.
            let report_msg = format!("[{}] 완료:\n{}", agent_name, &response[..response.len().min(2000)]);
            let sent = ptx
                .send(AgentTask {
                    message: report_msg.clone(),
                    reply_tx: None,
                    completion_tx: None,
                    thinking_level: ThinkingLevel::Normal,
                })
                .await;
            if sent.is_err() {
                warn!(name = %name, "parent agent task_tx closed — fallback to inject_tx");
                // 부모 에이전트가 이미 종료됐으면 primary(텔레그램)로 fallback.
                if let Some(ref inject_tx) = parent_inject_tx {
                    let channel_msg = ChannelMessage {
                        id: String::new(),
                        sender: admin_chat_id.to_string(),
                        content: format!("[{}] 완료 (부모 에이전트 종료 → 직접 보고):\n{}", agent_name, &response[..response.len().min(500)]),
                        timestamp: std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_secs() as i64,
                        source: Some("agent-report".into()),
                    };
                    if inject_tx.send(channel_msg).await.is_err() {
                        warn!(name = %name, "fallback inject_tx also closed — report lost");
                    }
                }
            } else {
                info!(name = %name, "completion result pushed to parent agent via task_tx");
            }
        } else if let Some(ref inject_tx) = parent_inject_tx {
            // initiator가 user → 기존 방식: primary(텔레그램)로 보고.
            let report_msg = format!("[{}] 작업 완료:\n{}", agent_name, &response[..response.len().min(500)]);
            let channel_msg = ChannelMessage {
                id: String::new(),
                sender: admin_chat_id.to_string(),
                content: report_msg,
                timestamp: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs() as i64,
                source: Some("agent-report".into()),
            };
            if inject_tx.send(channel_msg).await.is_err() {
                warn!(name = %name, "parent inject_tx closed — report not delivered");
            } else {
                info!(name = %name, "auto-reported to parent via inject_tx");
            }
        }

        // Non-persistent 에이전트는 첫 태스크 완료 후 루프를 종료한다.
        if !persistent {
            break;
        }
    }

    info!(name = %name, "spawned agent loop ended (channel closed)");
}

/// 단일 태스크에 대한 LLM + 툴 실행 루프.
async fn run_agent_task(
    name: &str,
    provider: &Arc<dyn Provider>,
    tools: &[Arc<dyn Tool>],
    system_prompt: &str,
    history: &mut Vec<ChatMessage>,
    user_message: String,
    thinking_level: ThinkingLevel,
    event_tx: &Option<broadcast::Sender<DashboardEvent>>,
    conv_save_tx: &Option<mpsc::Sender<(String, ChatMessage, Option<String>)>>,
) -> anyhow::Result<String> {
    // 사용자 메시지 추가.
    // sender = Some("agent"): spawn 에이전트에 주입되는 user 메시지는 부모 에이전트가 보낸 것.
    let user_msg = ChatMessage::user(&user_message);
    if let Some(ref tx) = conv_save_tx {
        let _ = tx.send((name.to_string(), user_msg.clone(), Some("agent".to_string()))).await;
    }
    history.push(user_msg);

    // 툴 정의 빌드.
    let tool_defs: Vec<ToolDefinition> = tools
        .iter()
        .map(|t| ToolDefinition {
            name: t.name().to_string(),
            description: t.description().to_string(),
            input_schema: t.schema(),
        })
        .collect();

    // 시스템 프롬프트 + 이력으로 메시지 구성.
    let mut messages = Vec::new();
    messages.push(ChatMessage::system(system_prompt));
    messages.extend(history.iter().cloned());

    // LLM + 툴 루프 (최대 10회 반복).
    const MAX_ITERATIONS: usize = 10;

    info!(
        name = %name,
        history_len = history.len(),
        deep = matches!(thinking_level, ThinkingLevel::Deep),
        "run_agent_task: LLM 루프 시작"
    );

    for iteration in 0..MAX_ITERATIONS {
        info!(name = %name, iteration, msg_count = messages.len(), "run_agent_task: LLM 호출 시작");
        if let Some(ref tx) = event_tx {
            let _ = tx.send(DashboardEvent::AgentThinking { name: name.to_string() });
        }
        let response = provider
            .chat_with_options(&messages, &tool_defs, thinking_level)
            .await
            .map_err(|e| {
                warn!(name = %name, iteration, error = %e, "run_agent_task: LLM 호출 실패");
                anyhow::anyhow!("provider error: {e}")
            })?;
        info!(name = %name, iteration, text_len = response.text.len(), tool_count = response.tool_calls.len(), "run_agent_task: LLM 응답 수신");

        // 텍스트 응답만 있으면 완료.
        if response.tool_calls.is_empty() {
            let reply = response.text.clone();
            // 이력에 assistant 응답 추가.
            if !response.text.is_empty() {
                let assistant_msg = ChatMessage::assistant(&response.text);
                if let Some(ref tx) = conv_save_tx {
                    let _ = tx.send((name.to_string(), assistant_msg.clone(), None)).await;
                }
                history.push(assistant_msg);
            }
            if let Some(ref tx) = event_tx {
                let _ = tx.send(DashboardEvent::AgentIdle { name: name.to_string() });
            }
            info!(name = %name, iteration, reply_len = reply.len(), "run_agent_task: 완료");
            return Ok(reply);
        }

        // 툴 호출이 있으면: assistant_with_tools 메시지 추가 후 실행.
        let assistant_msg = ChatMessage::assistant_with_tools(
            &response.text,
            response.tool_calls.clone(),
        );
        messages.push(assistant_msg);

        // 모든 툴 호출 실행.
        for tool_call in &response.tool_calls {
            info!(name = %name, iteration, tool = %tool_call.name, "run_agent_task: 툴 실행 시작");
            if let Some(ref tx) = event_tx {
                let _ = tx.send(DashboardEvent::AgentExecuting {
                    name: name.to_string(),
                    tool: tool_call.name.clone(),
                });
            }
            let result = execute_tool(tools, tool_call).await;
            info!(
                name = %name,
                tool = %tool_call.name,
                result_len = result.len(),
                "run_agent_task: 툴 실행 완료"
            );
            messages.push(ChatMessage::tool_result(&tool_call.id, &result));
        }

        // 최대 반복 경고.
        if iteration == MAX_ITERATIONS - 2 {
            messages.push(ChatMessage::user(
                "[System: 툴 호출 한도에 거의 도달했습니다. 지금까지의 결과를 바탕으로 최종 답변을 제공하세요.]",
            ));
        }
    }

    // 최대 반복 초과.
    let final_response = provider
        .chat_with_options(&messages, &[], thinking_level)
        .await
        .map_err(|e| anyhow::anyhow!("final provider call failed: {e}"))?;

    let reply = final_response.text.clone();
    if !reply.is_empty() {
        let assistant_msg = ChatMessage::assistant(&reply);
        if let Some(ref tx) = conv_save_tx {
            let _ = tx.send((name.to_string(), assistant_msg.clone(), None)).await;
        }
        history.push(assistant_msg);
    }
    if let Some(ref tx) = event_tx {
        let _ = tx.send(DashboardEvent::AgentIdle { name: name.to_string() });
    }
    Ok(reply)
}

/// 단일 툴 호출 실행. 에러 시 에러 메시지를 문자열로 반환.
async fn execute_tool(tools: &[Arc<dyn Tool>], tool_call: &ToolCall) -> String {
    let tool = tools.iter().find(|t| t.name() == tool_call.name);
    match tool {
        Some(t) => match t.execute(&tool_call.args).await {
            Ok(result) => result,
            Err(e) => format!("툴 실행 오류: {e}"),
        },
        None => format!("알 수 없는 툴: {}", tool_call.name),
    }
}
