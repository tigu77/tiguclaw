//! Configuration loading from config.toml + .env overrides.

use crate::error::TiguError;
use crate::security::SecurityPolicy;
use serde::Deserialize;
use std::collections::HashMap;
use std::path::Path;

/// Top-level configuration.
#[derive(Debug, Clone, Deserialize)]
pub struct Config {
    /// 채널 목록 — `[[channels]]` 배열로 통일.
    /// 첫 번째 항목 또는 `primary = true`인 항목이 메인 채널.
    #[serde(default)]
    pub channels: Vec<ChannelConfig>,
    pub provider: ProviderConfig,
    pub runtime: RuntimeConfig,
    pub agent: AgentConfig,
    #[serde(default)]
    pub heartbeat: Option<HeartbeatCfg>,
    #[serde(default)]
    pub cron: Vec<CronCfg>,
    #[serde(default)]
    pub hooks: HooksConfig,
    /// Phase 6: 멀티 에이전트 군단 — L1/L2 에이전트 목록 (없으면 빈 Vec).
    #[serde(default)]
    pub agents: Vec<AgentEntry>,
    /// Phase 7-2: 툴 실행 승인 정책 (기본값: disabled).
    #[serde(default)]
    pub security: SecurityPolicy,
    /// Phase 8-1: 자율 spawn 설정.
    #[serde(default)]
    pub auto_spawn: AutoSpawnConfig,
    /// Phase 8-2: 모니터링 채널 설정.
    #[serde(default)]
    pub monitor: MonitorConfig,
    /// Phase 9-1: 웹 대시보드 설정.
    #[serde(default)]
    pub dashboard: DashboardConfig,
    /// 컨텍스트 보존 설정.
    #[serde(default)]
    pub context: ContextConfig,
    /// 메모리/임베딩 설정.
    #[serde(default)]
    pub memory: MemoryConfig,
    /// DB 자동 백업 설정.
    #[serde(default)]
    pub backup: BackupConfig,
    /// Phase 9-3: 마켓 설정.
    #[serde(default)]
    pub market: MarketConfig,
    /// 에이전트 컨텍스트 접근 권한 프리셋 (full / standard / minimal 및 커스텀).
    #[serde(default = "default_clearance_presets")]
    pub clearance: HashMap<String, ClearancePreset>,
}

// ─── ClearancePreset ────────────────────────────────────────────────────────

/// 에이전트 컨텍스트 접근 권한 프리셋 — 읽어들일 워크스페이스 파일 목록 정의.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct ClearancePreset {
    /// 이 clearance 레벨에서 로드할 워크스페이스 파일 목록 (순서대로 로드됨).
    pub files: Vec<String>,
}

/// 기본 clearance 프리셋 3개 (full / standard / minimal).
fn default_clearance_presets() -> HashMap<String, ClearancePreset> {
    let mut map = HashMap::new();
    map.insert(
        "full".to_string(),
        ClearancePreset {
            files: vec![
                "CORE.md".to_string(),
                "SOUL.md".to_string(),
                "USER.md".to_string(),
                "IDENTITY.md".to_string(),
                "AGENTS.md".to_string(),
                "MEMORY.md".to_string(),
                "HEARTBEAT.md".to_string(),
                "TOOLS.md".to_string(),
            ],
        },
    );
    map.insert(
        "standard".to_string(),
        ClearancePreset {
            files: vec!["CORE.md".to_string(), "USER.md".to_string()],
        },
    );
    map.insert(
        "minimal".to_string(),
        ClearancePreset {
            files: vec!["CORE.md".to_string()],
        },
    );
    map
}

// ─── MemoryConfig / EmbeddingConfig ─────────────────────────────────────────

/// 메모리 백엔드 + 임베딩 설정.
#[derive(Debug, Clone, Deserialize)]
pub struct MemoryConfig {
    /// 임베딩 제공자: "fastembed" | "none" (기본값: "fastembed")
    #[serde(default = "default_embedding_provider")]
    pub embedding_provider: String,
    /// 사용할 임베딩 모델 이름 (기본값: "AllMiniLML6V2")
    #[serde(default = "default_embedding_model")]
    pub embedding_model: String,
}

impl Default for MemoryConfig {
    fn default() -> Self {
        Self {
            embedding_provider: default_embedding_provider(),
            embedding_model: default_embedding_model(),
        }
    }
}

fn default_embedding_provider() -> String {
    "fastembed".to_string()
}

fn default_embedding_model() -> String {
    "AllMiniLML6V2".to_string()
}

/// 채널 설정 — `[[channels]]` 배열 항목.
///
/// `[telegram]` + `[[extra_channels]]` 구조를 단일 배열로 통일.
/// `primary = true`이거나 배열 첫 번째 항목이 메인 채널로 사용된다.
#[derive(Debug, Clone, Deserialize)]
pub struct ChannelConfig {
    /// 채널 타입: "telegram" | "discord" | "slack" (향후 확장)
    #[serde(rename = "type")]
    pub channel_type: String,
    /// Telegram: 봇 토큰 (${ENV_VAR} 형식으로 환경 변수 참조 가능).
    #[serde(default)]
    pub bot_token: String,
    /// Telegram: 관리자 chat_id (응답을 보낼 대상).
    #[serde(default)]
    pub admin_chat_id: i64,
    /// 메인 채널 여부 (true이면 primary, 없으면 첫 번째 항목이 primary).
    #[serde(default)]
    pub primary: bool,
}

/// @deprecated — `[[channels]]` 배열로 통일 완료. 하위 호환용으로 구조체만 유지.
#[derive(Debug, Clone, Deserialize)]
pub struct ExtraChannelConfig {
    /// 채널 종류: 현재 "telegram"만 지원.
    pub r#type: String,
    /// 봇 토큰 (${ENV_VAR} 형식으로 환경 변수 참조 가능).
    pub bot_token: String,
}

/// Phase 6: 멀티 에이전트 군단 항목.
///
/// level=1: 마스터급 — 텔레그램 봇 보유, 독립 AgentLoop
/// level=2: 미니에이전트 — 내부 IPC (현재 stub)
#[derive(Debug, Clone, Deserialize)]
pub struct AgentEntry {
    /// 에이전트 식별 이름.
    pub name: String,
    /// 계층 레벨: 1=마스터급, 2=미니에이전트.
    pub level: u8,
    /// 채널 종류: "telegram" | "internal".
    pub channel: String,
    /// level=1일 때 필요한 텔레그램 봇 토큰 (없으면 기본 봇 토큰 사용).
    pub bot_token: Option<String>,
    /// level=2일 때 보고할 부모 에이전트명.
    pub reports_to: Option<String>,
    /// 이 에이전트 전용 시스템 프롬프트 파일 경로.
    pub system_prompt_file: Option<String>,
    /// 이 에이전트의 워크스페이스 디렉토리.
    pub workspace_dir: Option<String>,
    /// 이 에이전트 전용 hooks 포트.
    pub hooks_port: Option<u16>,
    /// 활성화 여부.
    pub enabled: bool,
    /// 컨텍스트 접근 권한 프리셋 이름 (default: L1+="minimal").
    #[serde(default = "default_entry_clearance")]
    pub clearance: String,
    /// 이 에이전트에서 허용할 스킬(툴) 목록. 빈 배열이면 전부 허용.
    #[serde(default)]
    pub skills: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TelegramConfig {
    /// Bot token — resolved from env var via `${TELEGRAM_BOT_TOKEN}` syntax or literal.
    pub bot_token: String,
    /// Only respond to this chat id.
    pub admin_chat_id: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ProviderConfig {
    /// API key — resolved from env var.
    pub api_key: String,
    pub max_tokens: u32,
    /// Tier-based routing configuration (tier1 → tier2 escalation).
    pub tiers: TiersConfig,
    /// Thinking mode: "off" or "adaptive" (default: "off").
    /// Adaptive thinking lets Claude decide when to think, controlled by effort level.
    /// Note: adaptive thinking is only supported on claude-3-7 models, not claude-sonnet-4/opus-4.
    #[serde(default = "default_thinking")]
    pub thinking: String,
}

fn default_thinking() -> String {
    "off".to_string()
}

/// Tier-based model routing — two tiers with escalation support.
/// Each tier is a Vec of model names; the first model is preferred,
/// subsequent models serve as fallbacks on error.
#[derive(Debug, Clone, Deserialize)]
pub struct TiersConfig {
    /// Default tier: fast, cost-effective models. First is preferred.
    pub tier1: Vec<String>,
    /// Escalation tier: more capable models for complex requests. First is preferred.
    pub tier2: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RuntimeConfig {
    pub shell: String,
    pub timeout_secs: u64,
    pub max_output_bytes: usize,
}

/// 에이전트 역할 계층 (L0~L3).
#[derive(Debug, Clone, Deserialize, Default, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum AgentRole {
    /// L0: 전체 지휘권 — 슈퍼마스터, 정태님 주 소통창구 (1개만 존재)
    Supermaster,
    /// L1: 도메인 전담 — 텔레그램 봇 보유 마스터급
    #[default]
    Master,
    /// L2: 내부 전용 — 상주 미니에이전트 (IPC)
    Mini,
    /// L3: 임시 워커 — 기존 SubAgentManager
    Worker,
}

// ---------------------------------------------------------------------------
// 공개 기본값 상수 — agent crate 및 main.rs에서 참조용.
// config.rs의 default_*() 함수들은 이 상수를 사용한다.
// ---------------------------------------------------------------------------

/// 기본 최대 툴 호출 반복 횟수.
pub const DEFAULT_MAX_TOOL_ITERATIONS: usize = 20;
/// 기본 컨텍스트 요약 임계값 (추정 토큰 수).
pub const DEFAULT_COMPACTION_THRESHOLD: usize = 80_000;
/// 기본 툴 결과 최대 문자 수.
pub const DEFAULT_MAX_TOOL_RESULT_CHARS: usize = 20_000;
/// 기본 하트비트 주기 (초).
pub const DEFAULT_HEARTBEAT_INTERVAL_SECS: u64 = 600;
/// 기본 컨텍스트 보존 기간 (일).
pub const DEFAULT_CONTEXT_RETENTION_DAYS: u64 = 3;

impl AgentRole {
    pub fn label(&self) -> &str {
        match self {
            AgentRole::Supermaster => "L0",
            AgentRole::Master => "L1",
            AgentRole::Mini => "L2",
            AgentRole::Worker => "L3",
        }
    }

    pub fn display_name(&self) -> &str {
        match self {
            AgentRole::Supermaster => "슈퍼마스터",
            AgentRole::Master => "마스터",
            AgentRole::Mini => "미니",
            AgentRole::Worker => "워커",
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct AgentConfig {
    /// 에이전트 이름 (default: "agent")
    #[serde(default = "default_agent_name")]
    pub name: String,
    /// agents/<name>/ 폴더 기반 스펙 경로 (예: "agents/supermaster").
    /// 설정 시 system_prompt_file 대신 AgentSpecManager로 프롬프트 로드.
    pub spec: Option<String>,
    #[serde(default = "default_system_prompt_file")]
    pub system_prompt_file: String,
    pub max_history: usize,
    #[serde(default)]
    pub skill_dirs: Vec<String>,
    #[serde(default = "default_workspace_dir")]
    pub workspace_dir: String,
    /// Maximum number of tool call iterations per message (default: 20).
    #[serde(default = "default_max_tool_iterations")]
    pub max_tool_iterations: usize,
    /// Token threshold for context compaction via LLM summarization (default: 80000 tokens).
    /// When estimated token count exceeds this, history is summarized and replaced.
    /// Token estimation: total chars / 4. Set to 0 to disable.
    #[serde(default = "default_compaction_threshold")]
    pub compaction_threshold: usize,
    /// Maximum characters for a single tool result (0 = unlimited).
    /// Default: 20000
    #[serde(default = "default_max_tool_result_chars")]
    pub max_tool_result_chars: usize,
    /// 이 인스턴스의 역할 계층 (default: master = L1).
    #[serde(default)]
    pub role: AgentRole,
    /// Phase 8-3: 에이전트 템플릿 디렉토리 경로 (default: "templates"). Deprecated: agents_dir 사용 권장.
    #[serde(default = "default_templates_dir")]
    pub templates_dir: String,
    /// 에이전트 폴더 기반 스펙 디렉토리 (default: "agents").
    #[serde(default = "default_agents_dir")]
    pub agents_dir: String,
    /// 퍼스널리티 디렉토리 (default: "personalities").
    #[serde(default = "default_personalities_dir")]
    pub personalities_dir: String,
    /// shared/ 컨텍스트 디렉토리 (default: "shared").
    #[serde(default = "default_shared_dir")]
    pub shared_dir: String,
    /// 각 shared 파일 최대 문자 수 (default: 4000).
    #[serde(default = "default_max_shared_chars")]
    pub max_shared_chars: usize,
    /// 컨텍스트 접근 권한 프리셋 이름 (default: L0="full").
    /// 지정된 이름으로 [clearance.*] 섹션을 조회하여 로드할 파일 목록을 결정한다.
    #[serde(default = "default_agent_clearance")]
    pub clearance: String,
    /// 이 에이전트에서 허용할 스킬(툴) 목록. 빈 배열이면 전부 허용.
    #[serde(default)]
    pub skills: Vec<String>,
}

fn default_agent_name() -> String {
    "agent".to_string()
}

fn default_system_prompt_file() -> String {
    "system-prompt.md".to_string()
}

fn default_templates_dir() -> String {
    "templates".to_string()
}

fn default_agents_dir() -> String {
    "agents".to_string()
}

fn default_personalities_dir() -> String {
    "personalities".to_string()
}

fn default_shared_dir() -> String {
    "shared".to_string()
}

fn default_max_shared_chars() -> usize {
    4000
}

fn default_agent_clearance() -> String {
    "full".to_string()
}

fn default_entry_clearance() -> String {
    "minimal".to_string()
}

fn default_max_tool_iterations() -> usize {
    DEFAULT_MAX_TOOL_ITERATIONS
}

fn default_compaction_threshold() -> usize {
    DEFAULT_COMPACTION_THRESHOLD
}

fn default_max_tool_result_chars() -> usize {
    DEFAULT_MAX_TOOL_RESULT_CHARS
}

fn default_workspace_dir() -> String {
    ".".to_string()
}



/// Heartbeat configuration.
#[derive(Debug, Clone, Deserialize)]
pub struct HeartbeatCfg {
    pub interval_secs: u64,
    pub heartbeat_file: String,
    #[serde(default = "default_quiet_start")]
    pub quiet_start: u8,
    #[serde(default = "default_quiet_end")]
    pub quiet_end: u8,
}

fn default_quiet_start() -> u8 {
    23
}

fn default_quiet_end() -> u8 {
    8
}

/// Cron job configuration.
#[derive(Debug, Clone, Deserialize)]
pub struct CronCfg {
    pub name: String,
    pub hour: Option<u8>,
    #[serde(default)]
    pub minute: u8,
    pub command: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub days: Vec<u8>,
}

fn default_true() -> bool {
    true
}

/// Hooks HTTP API configuration.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct HooksConfig {
    /// Whether to enable the hooks HTTP server (default: false).
    #[serde(default)]
    pub enabled: bool,
    /// Bearer token for authentication.
    #[serde(default)]
    pub token: String,
    /// Port to listen on (default: 3001).
    #[serde(default = "default_hooks_port")]
    pub port: u16,
}

fn default_hooks_port() -> u16 {
    3001
}

/// Phase 8-1: 자율 spawn 설정.
///
/// 슈퍼마스터가 상황을 판단하여 스스로 에이전트를 spawn하는 자율화 기능.
/// `enabled = false`이면 완전히 bypass된다.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct AutoSpawnConfig {
    /// 자율 spawn 활성화 여부 (기본값: false).
    #[serde(default)]
    pub enabled: bool,
    /// 자율 spawn 최대 에이전트 수 (기본값: 3).
    #[serde(default = "default_max_auto_agents")]
    pub max_auto_agents: u8,
    /// spawn 트리거: "workload" | "schedule" | "both" (기본값: "workload").
    #[serde(default = "default_spawn_trigger")]
    pub spawn_trigger: String,
    /// 유휴 에이전트 자동 종료 시간(초). 0이면 비활성화 (기본값: 300).
    #[serde(default = "default_idle_timeout_secs")]
    pub idle_timeout_secs: u64,
}

fn default_max_auto_agents() -> u8 {
    3
}

fn default_spawn_trigger() -> String {
    "workload".to_string()
}

fn default_idle_timeout_secs() -> u64 {
    300
}

/// Phase 8-2: 모니터링 채널 설정.
///
/// 에이전트 통신 내역, spawn/kill 이벤트를 텔레그램 채널에 실시간 포스팅한다.
/// `enabled = false`이면 완전히 bypass된다.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct MonitorConfig {
    /// 모니터링 활성화 여부 (기본값: false).
    #[serde(default)]
    pub enabled: bool,
    /// 모니터링 메시지를 보낼 텔레그램 chat_id (채널/그룹).
    #[serde(default)]
    pub telegram_chat_id: String,
    /// 에이전트간 통신 로깅 여부 (기본값: true).
    #[serde(default = "default_true")]
    pub log_agent_comms: bool,
    /// spawn/kill 이벤트 로깅 여부 (기본값: true).
    #[serde(default = "default_true")]
    pub log_spawns: bool,
}

/// Phase 9-1: 웹 대시보드 설정.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct DashboardConfig {
    /// 대시보드 서버 활성화 여부 (기본값: false).
    #[serde(default)]
    pub enabled: bool,
    /// 대시보드 서버 포트 (기본값: 3002).
    #[serde(default = "default_dashboard_port")]
    pub port: u16,
    /// CORS 허용 오리진 (기본값: "*").
    #[serde(default = "default_cors_origin")]
    pub cors_origin: String,
}

fn default_dashboard_port() -> u16 {
    3002
}

fn default_cors_origin() -> String {
    "*".to_string()
}

/// DB 자동 백업 설정.
#[derive(Debug, Clone, Deserialize)]
pub struct BackupConfig {
    /// 백업 활성화 여부 (기본값: true).
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// 백업 보관 일수 (기본값: 7).
    #[serde(default = "default_backup_retention_days")]
    pub retention_days: u32,
    /// 백업 디렉토리 (기본값: "backups").
    #[serde(default = "default_backup_dir")]
    pub backup_dir: String,
}

impl Default for BackupConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            retention_days: default_backup_retention_days(),
            backup_dir: default_backup_dir(),
        }
    }
}

fn default_backup_retention_days() -> u32 {
    7
}

fn default_backup_dir() -> String {
    "backups".to_string()
}

/// 컨텍스트 보존 설정.
#[derive(Debug, Clone, Deserialize)]
pub struct ContextConfig {
    /// 저장된 맥락 보존 기간 (일, 기본값: 3).
    #[serde(default = "default_retention_days")]
    pub retention_days: u64,
}

impl Default for ContextConfig {
    fn default() -> Self {
        Self {
            retention_days: default_retention_days(),
        }
    }
}

fn default_retention_days() -> u64 {
    DEFAULT_CONTEXT_RETENTION_DAYS
}

/// Phase 9-3: 마켓 설정.
#[derive(Debug, Clone, Deserialize)]
pub struct MarketConfig {
    /// Phase 10 원격 레지스트리 URL (현재 미사용).
    #[serde(default = "default_registry_url")]
    pub registry_url: String,
}

impl Default for MarketConfig {
    fn default() -> Self {
        Self {
            registry_url: default_registry_url(),
        }
    }
}

fn default_registry_url() -> String {
    "https://tiguclaw-hub.com/api".to_string()
}

impl Config {
    /// Load config from a TOML file, resolving `${ENV_VAR}` placeholders
    /// with values from the environment (loaded via dotenvy).
    pub fn load(path: impl AsRef<Path>) -> crate::error::Result<Self> {
        // Load .env if present (silently ignore if missing).
        let _ = dotenvy::dotenv();

        let raw = std::fs::read_to_string(path.as_ref()).map_err(|e| {
            TiguError::Config(format!("failed to read config file: {e}"))
        })?;

        // Resolve ${VAR} placeholders with env values.
        let resolved = resolve_env_vars(&raw);

        let config: Config = toml::from_str(&resolved).map_err(|e| {
            TiguError::Config(format!("failed to parse config: {e}"))
        })?;

        Ok(config)
    }
}

/// Replace `${VAR_NAME}` patterns with the corresponding environment variable value.
/// If the env var is not set, leaves the placeholder as-is.
fn resolve_env_vars(input: &str) -> String {
    let mut result = input.to_string();
    // Simple regex-free approach: scan for ${...} patterns.
    while let Some(start) = result.find("${") {
        if let Some(end) = result[start..].find('}') {
            let end = start + end;
            let var_name = &result[start + 2..end];
            let value = std::env::var(var_name).unwrap_or_default();
            result = format!("{}{}{}", &result[..start], value, &result[end + 1..]);
        } else {
            break;
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_resolve_env_vars() {
        std::env::set_var("TEST_TIGUVAR", "hello123");
        let input = "token = \"${TEST_TIGUVAR}\"";
        let resolved = resolve_env_vars(input);
        assert_eq!(resolved, "token = \"hello123\"");
    }
}
