//! 마켓 패키지 관리 — Phase 9-3.
//!
//! 로컬 agent.toml을 ~/.tiguclaw/installed/ 에 설치하고
//! registry.toml로 목록을 관리한다.
//! Phase 10에서 원격 레지스트리 연동 예정.

use crate::error::{Result, TiguError};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

// ─── 패키지 메타 ──────────────────────────────────────────────────────────────

/// agent.toml의 `[package]` 섹션.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PackageMeta {
    pub id: String,
    pub version: String,
    pub author: String,
    pub license: String,
    pub description: String,
    pub min_tiguclaw: String,
    #[serde(default)]
    pub tags: Vec<String>,
}

/// 패키지 전체 (메타 + 에이전트 설정).
#[derive(Debug, Clone)]
pub struct MarketPackage {
    pub meta: PackageMeta,
    /// 원본 agent.toml 전체 문자열 — 파싱된 AgentConfig 대신 raw 보관.
    pub raw_toml: String,
}

// ─── 레지스트리 ───────────────────────────────────────────────────────────────

/// registry.toml 전체 구조.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Registry {
    #[serde(default)]
    pub packages: Vec<RegistryEntry>,
}

/// [[packages]] 항목.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegistryEntry {
    pub id: String,
    pub version: String,
    pub installed_at: String,
    /// "local" | "remote"
    pub source: String,
}

// ─── MarketManager ────────────────────────────────────────────────────────────

/// 마켓 패키지 관리자.
pub struct MarketManager {
    /// ~/.tiguclaw (또는 커스텀 설치 루트)
    pub root: PathBuf,
    /// Phase 10 원격 연동용 URL (현재 미사용)
    pub registry_url: String,
}

impl MarketManager {
    /// 새 MarketManager 생성.
    ///
    /// `root`: 설치 루트 디렉토리 (보통 `~/.tiguclaw`).
    pub fn new(root: impl Into<PathBuf>, registry_url: impl Into<String>) -> Self {
        Self {
            root: root.into(),
            registry_url: registry_url.into(),
        }
    }

    /// 기본값 (~/.tiguclaw) 으로 생성.
    pub fn default_manager() -> Self {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
        Self::new(
            PathBuf::from(home).join(".tiguclaw"),
            "https://clawhub.com/api",
        )
    }

    // ── 경로 헬퍼 ─────────────────────────────────────────────────────────────

    fn installed_dir(&self) -> PathBuf {
        self.root.join("installed")
    }

    fn package_dir(&self, id: &str) -> PathBuf {
        self.installed_dir().join(id)
    }

    fn registry_path(&self) -> PathBuf {
        self.root.join("registry.toml")
    }

    // ── 레지스트리 I/O ────────────────────────────────────────────────────────

    fn load_registry(&self) -> Result<Registry> {
        let path = self.registry_path();
        if !path.exists() {
            return Ok(Registry::default());
        }
        let content = std::fs::read_to_string(&path).map_err(|e| {
            TiguError::Config(format!("registry.toml 읽기 실패: {e}"))
        })?;
        toml::from_str(&content).map_err(|e| {
            TiguError::Config(format!("registry.toml 파싱 실패: {e}"))
        })
    }

    fn save_registry(&self, reg: &Registry) -> Result<()> {
        std::fs::create_dir_all(&self.root).map_err(|e| {
            TiguError::Config(format!("설치 루트 디렉토리 생성 실패: {e}"))
        })?;
        let content = toml::to_string_pretty(reg).map_err(|e| {
            TiguError::Config(format!("registry.toml 직렬화 실패: {e}"))
        })?;
        std::fs::write(self.registry_path(), content).map_err(|e| {
            TiguError::Config(format!("registry.toml 쓰기 실패: {e}"))
        })
    }

    // ── 공개 API ──────────────────────────────────────────────────────────────

    /// 로컬 agent.toml 경로로 패키지 설치.
    ///
    /// `[package]` 섹션이 있어야 한다.
    /// installed/{id}/agent.toml로 복사하고 registry.toml 업데이트.
    pub fn install_local(&self, agent_toml_path: impl AsRef<Path>) -> Result<PackageMeta> {
        let path = agent_toml_path.as_ref();
        let content = std::fs::read_to_string(path).map_err(|e| {
            TiguError::Config(format!("agent.toml 읽기 실패 ({}): {e}", path.display()))
        })?;

        // [package] 섹션 파싱
        let raw: toml::Value = toml::from_str(&content).map_err(|e| {
            TiguError::Config(format!("agent.toml 파싱 실패: {e}"))
        })?;

        let package_table = raw.get("package").ok_or_else(|| {
            TiguError::Config("agent.toml에 [package] 섹션이 없습니다".to_string())
        })?;

        let meta: PackageMeta = package_table.clone().try_into().map_err(|e| {
            TiguError::Config(format!("[package] 섹션 파싱 실패: {e}"))
        })?;

        // installed/{id}/ 디렉토리 생성
        let pkg_dir = self.package_dir(&meta.id);
        std::fs::create_dir_all(&pkg_dir).map_err(|e| {
            TiguError::Config(format!("패키지 디렉토리 생성 실패: {e}"))
        })?;

        // agent.toml 복사
        let dest = pkg_dir.join("agent.toml");
        std::fs::write(&dest, &content).map_err(|e| {
            TiguError::Config(format!("agent.toml 복사 실패: {e}"))
        })?;

        // registry.toml 업데이트
        let mut reg = self.load_registry()?;
        // 기존 항목 제거 (재설치 시 덮어쓰기)
        reg.packages.retain(|p| p.id != meta.id);
        reg.packages.push(RegistryEntry {
            id: meta.id.clone(),
            version: meta.version.clone(),
            installed_at: today_string(),
            source: "local".to_string(),
        });
        self.save_registry(&reg)?;

        Ok(meta)
    }

    /// 설치된 패키지 제거.
    pub fn remove(&self, id: &str) -> Result<()> {
        let pkg_dir = self.package_dir(id);
        if !pkg_dir.exists() {
            return Err(TiguError::Config(format!("패키지 '{id}'가 설치되어 있지 않습니다")));
        }

        // 디렉토리 삭제
        std::fs::remove_dir_all(&pkg_dir).map_err(|e| {
            TiguError::Config(format!("패키지 디렉토리 삭제 실패: {e}"))
        })?;

        // registry.toml에서 제거
        let mut reg = self.load_registry()?;
        reg.packages.retain(|p| p.id != id);
        self.save_registry(&reg)?;

        Ok(())
    }

    /// 설치된 패키지 목록 반환.
    pub fn list(&self) -> Result<Vec<RegistryEntry>> {
        Ok(self.load_registry()?.packages)
    }

    /// 특정 패키지 메타 정보 반환.
    pub fn info(&self, id: &str) -> Result<(PackageMeta, RegistryEntry)> {
        // registry에서 source 정보 가져오기
        let reg = self.load_registry()?;
        let entry = reg
            .packages
            .into_iter()
            .find(|p| p.id == id)
            .ok_or_else(|| TiguError::Config(format!("패키지 '{id}'가 설치되어 있지 않습니다")))?;

        // agent.toml에서 메타 읽기
        let toml_path = self.package_dir(id).join("agent.toml");
        let content = std::fs::read_to_string(&toml_path).map_err(|e| {
            TiguError::Config(format!("installed/{id}/agent.toml 읽기 실패: {e}"))
        })?;

        let raw: toml::Value = toml::from_str(&content).map_err(|e| {
            TiguError::Config(format!("agent.toml 파싱 실패: {e}"))
        })?;

        let package_table = raw.get("package").ok_or_else(|| {
            TiguError::Config(format!("installed/{id}/agent.toml에 [package] 섹션 없음"))
        })?;

        let meta: PackageMeta = package_table.clone().try_into().map_err(|e| {
            TiguError::Config(format!("[package] 파싱 실패: {e}"))
        })?;

        Ok((meta, entry))
    }
}

// ─── 날짜 헬퍼 ────────────────────────────────────────────────────────────────

/// 오늘 날짜를 YYYY-MM-DD 형식으로 반환.
fn today_string() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    unix_secs_to_date(secs)
}

fn unix_secs_to_date(secs: u64) -> String {
    fn is_leap(y: u64) -> bool {
        (y % 4 == 0 && y % 100 != 0) || (y % 400 == 0)
    }
    let mut y = 1970u64;
    let mut d = secs / 86400;
    loop {
        let dy = if is_leap(y) { 366 } else { 365 };
        if d < dy {
            break;
        }
        d -= dy;
        y += 1;
    }
    let leap = is_leap(y);
    let month_days: [u64; 12] = [31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let mut m = 1u64;
    for md in &month_days {
        if d < *md {
            break;
        }
        d -= md;
        m += 1;
    }
    format!("{:04}-{:02}-{:02}", y, m, d + 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_date_format() {
        // 2026-03-22 = days since epoch: 20533 → secs: 20533 * 86400
        let secs = 20533u64 * 86400;
        assert_eq!(unix_secs_to_date(secs), "2026-03-22");
    }
}
