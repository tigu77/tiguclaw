//! AgentSpec 시스템 — `agents/<name>/` 폴더 기반 에이전트 정의.
//!
//! `agents/` 디렉토리에 `<name>/agent.toml` + `<name>/AGENT.md`를 두면
//! `spawn_agent { agent_spec: "<name>" }` 한 줄로 에이전트를 즉시 생성할 수 있다.
//! 선택적으로 `personalities/<name>.md`를 통해 말투/스타일을 주입할 수 있다.

use serde::Deserialize;
use std::path::PathBuf;
use std::fs;

use crate::error::{Result, TiguError};

// ── Spec 구조체 ────────────────────────────────────────────────────────────────

/// 에이전트 스펙 최상위 구조체 (agents/{name}/agent.toml).
#[derive(Debug, Clone, Deserialize)]
pub struct AgentSpec {
    pub agent: AgentMeta,
    pub capabilities: Option<AgentCapabilities>,
    pub relations: Option<AgentRelations>,
}

/// [agent] 섹션 — 에이전트 기본 정보.
#[derive(Debug, Clone, Deserialize)]
pub struct AgentMeta {
    pub name: String,
    pub description: String,
    pub level: u8,
}

/// [capabilities] 섹션 — 툴 접근 제한 및 예산.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct AgentCapabilities {
    /// 허용 툴 목록. 비어있으면 전체 허용.
    #[serde(default)]
    pub tools: Vec<String>,
    /// 최대 서브 에이전트 spawn 수.
    #[serde(default = "default_max_spawn")]
    pub max_spawn: usize,
    /// 일일 예산 (USD).
    pub daily_budget_usd: Option<f64>,
}

/// [relations] 섹션 — spawn 가능한 하위 에이전트 목록.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct AgentRelations {
    #[serde(default)]
    pub spawnable_agents: Vec<String>,
}

fn default_max_spawn() -> usize {
    5
}

// ── AgentSpecManager ──────────────────────────────────────────────────────────

/// AgentSpec 로더 — `agents_dir`에서 폴더 기반 스펙을 로드하고
/// 시스템 프롬프트를 자동 생성한다.
pub struct AgentSpecManager {
    /// `agents/` 루트 디렉토리.
    specs_dir: PathBuf,
    /// `personalities/` 루트 디렉토리.
    personalities_dir: PathBuf,
    /// `shared/` 공통 컨텍스트 디렉토리.
    shared_dir: PathBuf,
    /// 각 shared 파일 최대 문자 수.
    max_shared_chars: usize,
}

/// 문자열을 최대 `max_chars` 유니코드 문자로 자른다.
fn truncate_chars(s: &str, max_chars: usize) -> String {
    if max_chars == 0 {
        return s.to_string();
    }
    let mut chars = s.chars();
    let mut result = String::new();
    let mut count = 0;
    while let Some(c) = chars.next() {
        if count >= max_chars {
            result.push_str("\n\n...(truncated)");
            break;
        }
        result.push(c);
        count += 1;
    }
    result
}

impl AgentSpecManager {
    /// 새 AgentSpecManager를 생성한다.
    pub fn new(specs_dir: PathBuf, personalities_dir: PathBuf) -> Self {
        Self {
            specs_dir,
            personalities_dir,
            shared_dir: PathBuf::from("shared"),
            max_shared_chars: 4000,
        }
    }

    /// shared 디렉토리를 설정한다 (builder pattern).
    pub fn with_shared_dir(mut self, dir: PathBuf, max_chars: usize) -> Self {
        self.shared_dir = dir;
        self.max_shared_chars = max_chars;
        self
    }

    /// shared/ 디렉토리의 모든 .md 파일을 정해진 순서로 로드한다.
    /// 순서: CORE.md → USER.md → MEMORY.md → 나머지 알파벳 순 (*.example 제외)
    pub fn load_shared_context(&self) -> String {
        if !self.shared_dir.exists() {
            return String::new();
        }

        let priority_order = ["CORE.md", "USER.md", "MEMORY.md"];
        let mut parts: Vec<String> = Vec::new();

        // 우선순위 파일 먼저
        for filename in &priority_order {
            let path = self.shared_dir.join(filename);
            if path.exists() {
                if let Ok(content) = fs::read_to_string(&path) {
                    parts.push(truncate_chars(&content, self.max_shared_chars));
                }
            }
        }

        // 나머지 .md 파일 (*.example 제외, 우선순위 파일 제외)
        let priority_set: std::collections::HashSet<&str> = priority_order.iter().copied().collect();
        if let Ok(entries) = fs::read_dir(&self.shared_dir) {
            let mut extra_files: Vec<PathBuf> = entries
                .flatten()
                .map(|e| e.path())
                .filter(|p| {
                    if let Some(name) = p.file_name().and_then(|n| n.to_str()) {
                        p.extension().and_then(|e| e.to_str()) == Some("md")
                            && !name.ends_with(".example")
                            && !priority_set.contains(name)
                    } else {
                        false
                    }
                })
                .collect();
            extra_files.sort();
            for path in extra_files {
                if let Ok(content) = fs::read_to_string(&path) {
                    parts.push(truncate_chars(&content, self.max_shared_chars));
                }
            }
        }

        parts.join("\n\n---\n\n")
    }

    /// `agents/{name}/agent.toml`을 로드한다.
    pub fn load_spec(&self, name: &str) -> Result<AgentSpec> {
        let path = self.specs_dir.join(name).join("agent.toml");
        if !path.exists() {
            let available = self.list_specs().join(", ");
            let hint = if available.is_empty() {
                format!(
                    "agents 디렉토리({})가 비어 있거나 존재하지 않습니다",
                    self.specs_dir.display()
                )
            } else {
                format!("사용 가능한 에이전트: {available}")
            };
            return Err(TiguError::Tool(format!(
                "에이전트 스펙 '{name}'을 찾을 수 없습니다. {hint}"
            )));
        }

        let raw = std::fs::read_to_string(&path).map_err(|e| {
            TiguError::Tool(format!("agent.toml 읽기 실패 ({}): {e}", path.display()))
        })?;

        let spec: AgentSpec = toml::from_str(&raw).map_err(|e| {
            TiguError::Tool(format!("agent.toml 파싱 실패 ({}): {e}", path.display()))
        })?;

        Ok(spec)
    }

    /// `agents/{name}/AGENT.md`를 로드한다.
    pub fn load_agent_prompt(&self, name: &str) -> Result<String> {
        let path = self.specs_dir.join(name).join("AGENT.md");
        if !path.exists() {
            return Err(TiguError::Tool(format!(
                "AGENT.md를 찾을 수 없습니다: {}",
                path.display()
            )));
        }
        std::fs::read_to_string(&path).map_err(|e| {
            TiguError::Tool(format!("AGENT.md 읽기 실패 ({}): {e}", path.display()))
        })
    }

    /// `personalities/{name}.md`를 로드한다.
    pub fn load_personality(&self, name: &str) -> Result<String> {
        let path = self.personalities_dir.join(format!("{name}.md"));
        if !path.exists() {
            return Err(TiguError::Tool(format!(
                "personality '{name}'을 찾을 수 없습니다: {}",
                path.display()
            )));
        }
        std::fs::read_to_string(&path).map_err(|e| {
            TiguError::Tool(format!(
                "personality 읽기 실패 ({}): {e}",
                path.display()
            ))
        })
    }

    /// 숨겨진 시스템 프롬프트를 자동 생성한다.
    ///
    /// 포맷:
    /// ```text
    /// ## System Configuration [Auto-generated, do not modify]
    /// - Name: {name}
    /// - Level: L{level} ({role_label})
    /// - Reports to: {parent_name}
    /// - Allowed tools: {tools} (or "all tools" if empty)
    /// - Max sub-agents: {max_spawn}
    /// - Daily budget: ${daily_budget_usd}  (있을 때만)
    ///
    /// You must not exceed these limits. If asked to perform actions outside your allowed tools, decline politely.
    /// ---
    /// ```
    pub fn build_hidden_system_prompt(&self, spec: &AgentSpec, parent_name: &str) -> String {
        let role_label = match spec.agent.level {
            0 => "supermaster",
            1 => "master",
            2 => "mini",
            3 => "worker",
            _ => "unknown",
        };

        let caps = spec
            .capabilities
            .as_ref()
            .cloned()
            .unwrap_or_default();

        let tools_str = if caps.tools.is_empty() {
            "all tools".to_string()
        } else {
            caps.tools.join(", ")
        };

        let budget_line = if let Some(budget) = caps.daily_budget_usd {
            format!("\n- Daily budget: ${budget:.2}")
        } else {
            String::new()
        };

        format!(
            "## System Configuration [Auto-generated, do not modify]\n\
             - Name: {name}\n\
             - Level: L{level} ({role_label})\n\
             - Reports to: {parent_name}\n\
             - Allowed tools: {tools_str}\n\
             - Max sub-agents: {max_spawn}{budget_line}\n\
             \n\
             You must not exceed these limits. If asked to perform actions outside your allowed tools, decline politely.\n\
             ---",
            name = spec.agent.name,
            level = spec.agent.level,
            role_label = role_label,
            parent_name = parent_name,
            tools_str = tools_str,
            max_spawn = caps.max_spawn,
            budget_line = budget_line,
        )
    }

    /// 전체 시스템 프롬프트를 조합한다.
    ///
    /// 순서: `hidden_prompt` → `shared context` → `AGENT.md` → `personality` (선택)
    pub fn build_full_system_prompt(
        &self,
        spec_name: &str,
        personality: Option<&str>,
        parent_name: &str,
    ) -> Result<String> {
        let spec = self.load_spec(spec_name)?;
        let hidden = self.build_hidden_system_prompt(&spec, parent_name);
        let shared = self.load_shared_context();
        let agent_md = self.load_agent_prompt(spec_name)?;

        let mut parts = vec![hidden];
        if !shared.is_empty() {
            parts.push(shared);
        }
        parts.push(agent_md);

        if let Some(p) = personality {
            let personality_content = self.load_personality(p)?;
            parts.push(format!("## Personality\n\n{}", personality_content));
        }

        Ok(parts.join("\n\n---\n\n"))
    }

    /// `agents/` 디렉토리의 spec 이름 목록을 반환한다.
    pub fn list_specs(&self) -> Vec<String> {
        let Ok(entries) = std::fs::read_dir(&self.specs_dir) else {
            return Vec::new();
        };

        let mut names: Vec<String> = entries
            .flatten()
            .filter_map(|e| {
                let p = e.path();
                if p.is_dir() && p.join("agent.toml").exists() {
                    p.file_name()
                        .and_then(|s| s.to_str())
                        .map(|s| s.to_string())
                } else {
                    None
                }
            })
            .collect();

        names.sort();
        names
    }
}
