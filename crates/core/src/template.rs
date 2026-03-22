//! 에이전트 템플릿 시스템 — 사전 정의된 에이전트 설정을 TOML 파일로 관리.
//!
//! `templates/` 디렉토리에 `<name>.toml` 파일을 두면
//! `spawn_agent { template: "<name>" }` 한 줄로 에이전트를 즉시 생성할 수 있다.

use serde::Deserialize;
use std::path::PathBuf;

use crate::error::{Result, TiguError};

/// 에이전트 템플릿 최상위 구조체.
#[derive(Debug, Clone, Deserialize)]
pub struct AgentTemplate {
    pub agent: TemplateAgentSection,
    /// [Deprecated] personality 섹션 — 성격/소울은 이제 AGENT.md에 직접 작성.
    #[serde(default)]
    pub personality: Option<TemplatePersonalitySection>,
    pub capabilities: Option<TemplateCapabilitiesSection>,
}

/// [agent] 섹션 — 에이전트 기본 정보.
#[derive(Debug, Clone, Deserialize)]
pub struct TemplateAgentSection {
    pub name: String,
    pub description: String,
    pub level: u8,
    pub persistent: bool,
}

/// [personality] 섹션 — 시스템 프롬프트.
#[derive(Debug, Clone, Deserialize)]
pub struct TemplatePersonalitySection {
    pub system_prompt: String,
}

/// [capabilities] 섹션 — 툴 접근 제한 및 이터레이션 한도.
#[derive(Debug, Clone, Deserialize)]
pub struct TemplateCapabilitiesSection {
    pub allowed_tools: Option<Vec<String>>,
    pub max_tool_iterations: Option<usize>,
}

/// 템플릿 로더 — `templates_dir`에서 `.toml` 파일을 찾아 로드한다.
pub struct TemplateManager {
    templates_dir: PathBuf,
}

impl TemplateManager {
    /// 새 TemplateManager를 생성한다.
    /// `templates_dir`은 바이너리 실행 위치 기준 상대 경로거나 절대 경로.
    pub fn new(templates_dir: PathBuf) -> Self {
        Self { templates_dir }
    }

    /// 이름으로 템플릿을 로드한다. (`<templates_dir>/<name>.toml`)
    pub fn load(&self, name: &str) -> Result<AgentTemplate> {
        let path = self.templates_dir.join(format!("{name}.toml"));
        if !path.exists() {
            let available = self.list().join(", ");
            let hint = if available.is_empty() {
                format!(
                    "templates 디렉토리({})가 비어 있거나 존재하지 않습니다",
                    self.templates_dir.display()
                )
            } else {
                format!("사용 가능한 템플릿: {available}")
            };
            return Err(TiguError::Tool(format!(
                "템플릿 '{name}'을 찾을 수 없습니다. {hint}"
            )));
        }

        let raw = std::fs::read_to_string(&path).map_err(|e| {
            TiguError::Tool(format!("템플릿 파일 읽기 실패 ({}): {e}", path.display()))
        })?;

        let tmpl: AgentTemplate = toml::from_str(&raw).map_err(|e| {
            TiguError::Tool(format!(
                "템플릿 파싱 실패 ({}): {e}",
                path.display()
            ))
        })?;

        Ok(tmpl)
    }

    /// 사용 가능한 템플릿 이름 목록을 반환한다.
    pub fn list(&self) -> Vec<String> {
        let Ok(entries) = std::fs::read_dir(&self.templates_dir) else {
            return Vec::new();
        };

        let mut names: Vec<String> = entries
            .flatten()
            .filter_map(|e| {
                let p = e.path();
                if p.extension().and_then(|s| s.to_str()) == Some("toml") {
                    p.file_stem()
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
