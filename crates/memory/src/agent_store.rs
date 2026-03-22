//! AgentStore — 에이전트 영속화 저장소 (SQLite).
//!
//! `AgentRegistry`가 사용하는 SQLite 기반 저장소.
//! 재시작 시 상주 에이전트(persistent=true)를 자동 복원할 수 있도록
//! spawn/kill 이벤트를 저장한다.

use std::path::Path;
use std::sync::Mutex;

use anyhow::{Context, Result};
use rusqlite::{params, Connection};
use tracing::info;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/// DB에 저장되는 에이전트 정보.
#[derive(Debug, Clone)]
pub struct PersistedAgent {
    pub name: String,
    pub level: u8,
    /// "supermaster" | "master" | "mini" | "worker"
    pub agent_role: String,
    /// "telegram" | "internal"
    pub channel_type: String,
    /// 봇 토큰 — 민감 정보, 현재는 평문 저장
    /// TODO(Phase 10): 암호화 적용 예정 (AES-GCM or age)
    pub bot_token: Option<String>,
    pub admin_chat_id: Option<i64>,
    pub system_prompt: String,
    pub persistent: bool,
    /// "running" | "stopped" | "error"
    pub status: String,
    /// 부모 에이전트 이름 (트리 복원용)
    pub parent_agent: Option<String>,
    /// 소속 팀 이름
    pub team: Option<String>,
}

// ---------------------------------------------------------------------------
// AgentStore
// ---------------------------------------------------------------------------

/// 에이전트 영속화 저장소.
///
/// `Mutex<Connection>`으로 래핑 — rusqlite `Connection`은 Sync가 아님.
pub struct AgentStore {
    conn: Mutex<Connection>,
}

impl AgentStore {
    /// DB 열기 + 스키마 마이그레이션.
    pub fn open(path: &Path) -> Result<Self> {
        let conn = Connection::open(path)
            .with_context(|| format!("AgentStore: SQLite 열기 실패 — {}", path.display()))?;

        // WAL 모드로 읽기 성능 향상.
        conn.execute_batch("PRAGMA journal_mode=WAL;")?;

        let store = Self {
            conn: Mutex::new(conn),
        };
        store.init_tables()?;
        info!(path = %path.display(), "AgentStore initialized");
        Ok(store)
    }

    fn init_tables(&self) -> Result<()> {
        let conn = self.conn.lock().map_err(|e| anyhow::anyhow!("mutex poisoned: {e}"))?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS agents (
                name          TEXT PRIMARY KEY,
                level         INTEGER NOT NULL,
                agent_role    TEXT NOT NULL,
                channel_type  TEXT NOT NULL,
                bot_token     TEXT,
                admin_chat_id INTEGER,
                system_prompt TEXT NOT NULL,
                persistent    INTEGER NOT NULL DEFAULT 1,
                status        TEXT NOT NULL DEFAULT 'running',
                created_at    TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
            );",
        )
        .context("AgentStore: 테이블 생성 실패")?;

        // 마이그레이션: parent_agent / team 컬럼 추가 (없으면)
        for (col, ty) in &[("parent_agent", "TEXT"), ("team", "TEXT")] {
            let _ = conn.execute_batch(&format!(
                "ALTER TABLE agents ADD COLUMN {col} {ty};"
            ));
            // 이미 존재하면 "duplicate column name" 오류 → 무시
        }

        Ok(())
    }

    /// 에이전트 저장 (이미 있으면 REPLACE).
    pub fn save(&self, agent: &PersistedAgent) -> Result<()> {
        let conn = self.conn.lock().map_err(|e| anyhow::anyhow!("mutex poisoned: {e}"))?;
        conn.execute(
            "INSERT OR REPLACE INTO agents
                (name, level, agent_role, channel_type, bot_token, admin_chat_id,
                 system_prompt, persistent, status, parent_agent, team, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, datetime('now'))",
            params![
                agent.name,
                agent.level as i64,
                agent.agent_role,
                agent.channel_type,
                agent.bot_token,
                agent.admin_chat_id,
                agent.system_prompt,
                agent.persistent as i64,
                agent.status,
                agent.parent_agent,
                agent.team,
            ],
        )
        .with_context(|| format!("AgentStore: save 실패 — name={}", agent.name))?;
        Ok(())
    }

    /// 전체 에이전트 목록 로드.
    pub fn load_all(&self) -> Result<Vec<PersistedAgent>> {
        let conn = self.conn.lock().map_err(|e| anyhow::anyhow!("mutex poisoned: {e}"))?;
        let mut stmt = conn.prepare(
            "SELECT name, level, agent_role, channel_type, bot_token, admin_chat_id,
                    system_prompt, persistent, status, parent_agent, team
             FROM agents",
        )?;
        let agents = stmt
            .query_map([], |row| {
                Ok(PersistedAgent {
                    name: row.get(0)?,
                    level: row.get::<_, i64>(1)? as u8,
                    agent_role: row.get(2)?,
                    channel_type: row.get(3)?,
                    bot_token: row.get(4)?,
                    admin_chat_id: row.get(5)?,
                    system_prompt: row.get(6)?,
                    persistent: row.get::<_, i64>(7)? != 0,
                    status: row.get(8)?,
                    parent_agent: row.get(9)?,
                    team: row.get(10)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()
            .context("AgentStore: load_all 실패")?;
        Ok(agents)
    }

    /// 에이전트 삭제.
    pub fn remove(&self, name: &str) -> Result<()> {
        let conn = self.conn.lock().map_err(|e| anyhow::anyhow!("mutex poisoned: {e}"))?;
        conn.execute("DELETE FROM agents WHERE name = ?1", params![name])
            .with_context(|| format!("AgentStore: remove 실패 — name={name}"))?;
        Ok(())
    }

    /// 에이전트 상태 업데이트.
    pub fn update_status(&self, name: &str, status: &str) -> Result<()> {
        let conn = self.conn.lock().map_err(|e| anyhow::anyhow!("mutex poisoned: {e}"))?;
        conn.execute(
            "UPDATE agents SET status = ?1, updated_at = datetime('now') WHERE name = ?2",
            params![status, name],
        )
        .with_context(|| format!("AgentStore: update_status 실패 — name={name}"))?;
        Ok(())
    }
}
