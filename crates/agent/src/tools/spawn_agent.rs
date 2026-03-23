//! spawn_agent 툴 — L1 마스터가 하위 에이전트를 동적으로 생성.

use async_trait::async_trait;
use serde_json::json;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::Mutex;

use tiguclaw_core::agent_spec::AgentSpecManager;
use tiguclaw_core::config::AgentRole;
use tiguclaw_core::error::{Result, TiguError};
use tiguclaw_core::template::TemplateManager;
use tiguclaw_core::tool::Tool;

use crate::registry::{AgentRegistry, SpawnRequest};

/// 하위 에이전트를 동적으로 spawn하는 툴.
///
/// # Input
/// ```json
/// {
///   "name": "code-helper",
///   "level": 2,
///   "role": "코딩 전담 도우미. 리팩토링, 코드 리뷰를 담당한다.",
///   "persistent": true
/// }
/// ```
/// 또는 템플릿을 이용한 간편 spawn:
/// ```json
/// { "template": "researcher" }
/// ```
pub struct SpawnAgentTool {
    registry: Arc<Mutex<AgentRegistry>>,
    /// 템플릿 디렉토리 경로 (legacy). None이면 "templates" 기본값 사용.
    templates_dir: PathBuf,
    /// 에이전트 스펙 폴더 기반 디렉토리.
    agents_dir: PathBuf,
    /// 이 툴을 소유한 에이전트 이름 (spawn 시 parent_agent로 자동 설정).
    owner_name: Option<String>,
    /// 이 툴을 사용하는 에이전트의 티어 (0=제한 없음, 1=T2+만 spawn 가능 등).
    requester_tier: u8,
}

impl SpawnAgentTool {
    pub fn new(registry: Arc<Mutex<AgentRegistry>>) -> Self {
        Self {
            registry,
            templates_dir: PathBuf::from("templates"),
            agents_dir: PathBuf::from("agents"),
            owner_name: None,
            requester_tier: 0,
        }
    }

    /// templates 디렉토리 경로를 지정한다 (legacy).
    pub fn with_templates_dir(mut self, dir: PathBuf) -> Self {
        self.templates_dir = dir;
        self
    }

    /// agents 디렉토리 경로를 지정한다.
    pub fn with_agents_dir(mut self, dir: PathBuf) -> Self {
        self.agents_dir = dir;
        self
    }

    /// 이 툴을 소유한 에이전트 이름을 설정한다.
    /// spawn된 에이전트의 parent_agent가 이 이름으로 자동 설정된다.
    pub fn with_owner_name(mut self, name: String) -> Self {
        self.owner_name = Some(name);
        self
    }

    /// 이 툴을 사용하는 에이전트의 티어를 설정한다.
    ///
    /// - `0` (기본값): 제한 없음 — 모든 티어의 에이전트 spawn 가능.
    /// - `1`: T2 이상(tier >= 2)만 spawn 가능.
    /// - `2`: T3 이상(tier >= 3)만 spawn 가능.
    pub fn with_requester_tier(mut self, tier: u8) -> Self {
        self.requester_tier = tier;
        self
    }
}

#[async_trait]
impl Tool for SpawnAgentTool {
    fn name(&self) -> &str {
        "spawn_agent"
    }

    fn description(&self) -> &str {
        "하위 에이전트(L2)를 동적으로 생성합니다. \
         에이전트는 독립적인 대화 이력과 툴 실행 능력을 가집니다. \
         persistent=true이면 상주하며 여러 태스크를 처리합니다."
    }

    fn schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "agent_spec": {
                    "type": "string",
                    "description": "agents/ 폴더 기반 스펙 이름 (예: researcher, coder, analyst). agent.toml + AGENT.md에서 설정 자동 로드. 시스템 프롬프트 자동 주입."
                },
                "template": {
                    "type": "string",
                    "description": "[Deprecated] 사전 정의 템플릿 이름. agent_spec 사용 권장."
                },
                "name": {
                    "type": "string",
                    "description": "에이전트 고유 이름 (예: code-helper, data-analyst). kebab-case 권장."
                },
                "tier": {
                    "type": "integer",
                    "description": "에이전트 티어. T0=최상위(자동설정), T1=1, T2=2. 기본값 1.",
                    "default": 1
                },
                "role": {
                    "type": "string",
                    "description": "에이전트 역할 설명. 시스템 프롬프트 생성에 사용됨."
                },
                "agent_role": {
                    "type": "string",
                    "enum": ["supermaster", "master", "mini", "worker"],
                    "description": "에이전트 계층 역할. supermaster(L0, 1개만 가능), master(L1), mini(L2), worker(L3). 기본값: master"
                },
                "persistent": {
                    "type": "boolean",
                    "description": "true=상주 에이전트, false=임시(기본: true)",
                    "default": true
                },
                "bot_token": {
                    "type": "string",
                    "description": "텔레그램 봇 토큰. 있으면 L1 에이전트(텔레그램 직접 소통 가능), 없으면 L2(내부 IPC만)."
                },
                "admin_chat_id": {
                    "type": "integer",
                    "description": "텔레그램 admin chat id. bot_token과 함께 사용."
                },
                "hooks_url": {
                    "type": "string",
                    "description": "Phase 8-2: 이 에이전트의 Hooks HTTP API 엔드포인트 (예: 'http://localhost:3002'). 설정 시 send_to_agent가 직통 HTTP로 메시지를 전달한다."
                },
                "hooks_token": {
                    "type": "string",
                    "description": "Phase 8-2: 직통 Hooks API 인증 토큰."
                },
                "parent_agent": {
                    "type": "string",
                    "description": "부모 에이전트 이름 (트리 계층 표시용). 미지정 시 이 툴을 소유한 에이전트 이름으로 자동 설정."
                },
                "team": {
                    "type": "string",
                    "description": "소속 팀 이름 (대시보드 그룹핑용). 예: 'research-team', 'code-team'."
                }
            },
            "required": ["name", "role"]
        })
    }

    async fn execute(
        &self,
        args: &HashMap<String, serde_json::Value>,
    ) -> Result<String> {
        // ── 티어 제한 검증 ────────────────────────────────────────────────────
        // requester_tier > 0이면 요청된 tier가 requester_tier보다 높아야 한다.
        // 예: T1(requester_tier=1)은 tier >= 2인 에이전트만 spawn 가능.
        if self.requester_tier > 0 {
            let requested_tier = args.get("tier").and_then(|v| v.as_u64()).unwrap_or(1) as u8;
            if requested_tier <= self.requester_tier {
                return Err(TiguError::Tool(format!(
                    "하위 티어 에이전트만 spawn 가능합니다. 요청자 티어: {}, 요청 티어: {} (최소 {} 이상이어야 합니다)",
                    self.requester_tier,
                    requested_tier,
                    self.requester_tier + 1,
                )));
            }
        }

        // ── agent_spec 로드 (새 폴더 기반 방식) ──────────────────────────────
        let agent_spec_name = args.get("agent_spec").and_then(|v| v.as_str());
        let spec_mgr = AgentSpecManager::new(self.agents_dir.clone());
        let agent_spec = if let Some(sname) = agent_spec_name {
            Some(spec_mgr.load_spec(sname)?)
        } else {
            None
        };

        // ── 템플릿 로드 (legacy, 있으면 기본값으로 사용) ──────────────────────
        let template_name = args.get("template").and_then(|v| v.as_str());
        let tmpl = if let Some(tname) = template_name {
            let mgr = TemplateManager::new(self.templates_dir.clone());
            Some(mgr.load(tname)?)
        } else {
            None
        };

        // ── name: 명시적 > agent_spec > 템플릿 > 에러 ────────────────────────
        let name = if let Some(n) = args.get("name").and_then(|v| v.as_str()) {
            n.to_string()
        } else if let Some(ref s) = agent_spec {
            s.agent.name.clone()
        } else if let Some(ref t) = tmpl {
            t.agent.name.clone()
        } else {
            return Err(TiguError::Tool("'name', 'agent_spec', 또는 'template' 파라미터가 필요합니다".into()));
        };

        // ── role / system_prompt: 명시적 > agent_spec > 템플릿 > 에러 ─────────
        // agent_spec 사용 시 전체 시스템 프롬프트를 자동 생성한다.
        let (role, system_prompt_override) = if let Some(r) = args.get("role").and_then(|v| v.as_str()) {
            (r.to_string(), None)
        } else if let Some(sname) = agent_spec_name {
            let full_prompt = spec_mgr.build_full_system_prompt(sname, "supermaster")?;
            ("".to_string(), Some(full_prompt))
        } else if let Some(ref t) = tmpl {
            let prompt = t.personality.as_ref()
                .map(|p| p.system_prompt.trim().to_string())
                .unwrap_or_default();
            (prompt, None)
        } else {
            return Err(TiguError::Tool("'role', 'agent_spec', 또는 'template' 파라미터가 필요합니다".into()));
        };

        // ── tier / persistent: 명시적 > agent_spec > 템플릿 > 기본값 ─────────
        let tier = if let Some(t) = args.get("tier").and_then(|v| v.as_u64()) {
            t as u8
        } else if let Some(ref s) = agent_spec {
            s.agent.tier
        } else if let Some(ref t) = tmpl {
            t.agent.tier
        } else {
            1
        };

        let persistent = if let Some(p) = args.get("persistent").and_then(|v| v.as_bool()) {
            p
        } else if let Some(ref t) = tmpl {
            t.agent.persistent
        } else {
            true
        };

        let bot_token = args
            .get("bot_token")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let admin_chat_id = args
            .get("admin_chat_id")
            .and_then(|v| v.as_i64());

        let agent_role = match args
            .get("agent_role")
            .and_then(|v| v.as_str())
            .unwrap_or("master")
        {
            "supermaster" => AgentRole::Supermaster,
            "mini" => AgentRole::Mini,
            "worker" => AgentRole::Worker,
            _ => AgentRole::Master,
        };

        let channel_type = if bot_token.is_some() { "telegram" } else { "internal" };

        let hooks_url = args
            .get("hooks_url")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let hooks_token = args
            .get("hooks_token")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let has_hooks = hooks_url.is_some();

        // parent_agent: 명시적 파라미터 > owner_name (자동) 순으로 결정.
        let parent_agent = args
            .get("parent_agent")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .or_else(|| self.owner_name.clone());

        // ── team 강제 검증 ────────────────────────────────────────────────────
        // owner_name이 있으면 (T1 에이전트) team을 owner_name으로 강제 설정.
        // 호출자가 다른 팀을 지정하거나 팀을 생략해도 강제 교체된다.
        let mut team = args
            .get("team")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        if let Some(ref owner) = self.owner_name {
            if team.as_deref().unwrap_or("") != owner.as_str() {
                tracing::warn!(
                    "spawn_agent: team 필드를 '{}' 로 강제 설정 (요청값: {:?})",
                    owner,
                    team
                );
                team = Some(owner.clone());
            }
        }

        // ── clearance 자동 설정 (tier 기반) ──────────────────────────────────
        // clearance가 명시되지 않으면 tier에 따라 자동 결정:
        //   tier 1  → "standard" (T1.md)
        //   tier 2+ → "worker"   (T2.md)
        let clearance = {
            let preset = if tier <= 1 {
                "standard"
            } else {
                "worker"
            };
            Some(preset.to_string())
        };

        let req = SpawnRequest {
            name: name.clone(),
            nickname: None,
            tier,
            role,
            agent_role,
            model_tier: None,
            persistent,
            bot_token,
            admin_chat_id,
            system_prompt_override,
            hooks_url: hooks_url.clone(),
            hooks_token,
            parent_agent,
            team,
            clearance,
        };

        let registry_arc = self.registry.clone();
        let mut registry = registry_arc.lock().await;
        match registry.spawn_agent(req, Some(registry_arc.clone())).await {
            Ok(_) => {
                let hooks_note = if has_hooks {
                    "\n🔗 직통 HTTP 활성화 — hooks_url 경유 send_to_agent 지원.".to_string()
                } else {
                    String::new()
                };
                let template_note = if let Some(sname) = agent_spec_name {
                    format!(" [agent_spec: {sname}]")
                } else if let Some(tname) = template_name {
                    format!(" [템플릿: {tname}]")
                } else {
                    String::new()
                };
                Ok(format!(
                    "✅ 에이전트 '{name}' 생성 완료{template_note} (tier={tier}, persistent={persistent}, channel={channel_type}){hooks_note}\n\
                     {}",
                    if channel_type == "telegram" {
                        "텔레그램 채널 연결됨 — 텔레그램에서 직접 메시지를 받습니다."
                    } else {
                        "send_to_agent으로 태스크를 전달하세요."
                    }
                ))
            }
            Err(e) => Err(TiguError::Tool(e.to_string())),
        }
    }
}
