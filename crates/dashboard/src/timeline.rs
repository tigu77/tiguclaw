//! 타임라인 이벤트 SQLite 저장소.
//!
//! `timeline_events` 테이블에 DashboardEvent를 저장하고
//! REST API로 조회할 수 있게 한다.

use std::path::Path;
use std::sync::Mutex;

use anyhow::Result;
use rusqlite::{params, Connection};
use serde::Serialize;

use tiguclaw_core::event::DashboardEvent;

/// 타임라인 이벤트 (REST API 응답용).
#[derive(Debug, Clone, Serialize)]
pub struct TimelineEvent {
    pub id: i64,
    pub event_type: String,
    pub agent_name: String,
    pub from_agent: Option<String>,
    pub to_agent: Option<String>,
    pub message: Option<String>,
    pub tool: Option<String>,
    /// Unix milliseconds
    pub timestamp: i64,
}

/// SQLite 기반 타임라인 저장소.
pub struct TimelineDb {
    conn: Mutex<Connection>,
}

impl TimelineDb {
    /// 새 TimelineDb 열기 (없으면 생성).
    pub fn open(path: &Path) -> Result<Self> {
        let conn = Connection::open(path)?;
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             CREATE TABLE IF NOT EXISTS timeline_events (
                 id          INTEGER PRIMARY KEY AUTOINCREMENT,
                 event_type  TEXT    NOT NULL,
                 agent_name  TEXT    NOT NULL DEFAULT '',
                 from_agent  TEXT,
                 to_agent    TEXT,
                 message     TEXT,
                 tool        TEXT,
                 timestamp   INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_tl_ts    ON timeline_events(timestamp DESC);
             CREATE INDEX IF NOT EXISTS idx_tl_agent ON timeline_events(agent_name, timestamp DESC);",
        )?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// DashboardEvent를 DB에 저장 (Heartbeat/AgentStatus/CostUpdate 무시).
    pub fn insert(&self, event: &DashboardEvent) -> Result<()> {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64;

        // (event_type, agent_name, from_agent, to_agent, message, tool)
        let row: Option<(&str, &str, Option<&str>, Option<&str>, Option<&str>, Option<&str>)> =
            match event {
                DashboardEvent::AgentSpawned { name, .. } => {
                    Some(("spawn", name.as_str(), None, None, None, None))
                }
                DashboardEvent::AgentKilled { name } => {
                    Some(("kill", name.as_str(), None, None, None, None))
                }
                DashboardEvent::AgentComm { from, to, message } => Some((
                    "comm",
                    from.as_str(),
                    Some(from.as_str()),
                    Some(to.as_str()),
                    Some(message.as_str()),
                    None,
                )),
                DashboardEvent::AgentThinking { name } => {
                    Some(("thinking", name.as_str(), None, None, None, None))
                }
                DashboardEvent::AgentExecuting { name, tool } => {
                    Some(("executing", name.as_str(), None, None, None, Some(tool.as_str())))
                }
                DashboardEvent::AgentIdle { name } => {
                    Some(("idle", name.as_str(), None, None, None, None))
                }
                _ => None, // Heartbeat, CostUpdate, AgentStatus 저장 안 함
            };

        if let Some((event_type, agent_name, from_agent, to_agent, message, tool)) = row {
            let conn = self.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO timeline_events
                    (event_type, agent_name, from_agent, to_agent, message, tool, timestamp)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![event_type, agent_name, from_agent, to_agent, message, tool, ts],
            )?;
        }
        Ok(())
    }

    /// 타임라인 조회 (최신 우선, 옵션 에이전트 필터).
    pub fn get_timeline(
        &self,
        agent_filter: Option<&str>,
        limit: usize,
    ) -> Result<Vec<TimelineEvent>> {
        let conn = self.conn.lock().unwrap();
        let limit = limit as i64;

        let rows = if let Some(agent) = agent_filter {
            let mut stmt = conn.prepare(
                "SELECT id, event_type, agent_name, from_agent, to_agent, message, tool, timestamp
                 FROM timeline_events
                 WHERE agent_name = ?1
                 ORDER BY timestamp DESC LIMIT ?2",
            )?;
            let x = stmt.query_map(params![agent, limit], map_row)?
                .collect::<Result<Vec<_>, _>>()?;
            x
        } else {
            let mut stmt = conn.prepare(
                "SELECT id, event_type, agent_name, from_agent, to_agent, message, tool, timestamp
                 FROM timeline_events
                 ORDER BY timestamp DESC LIMIT ?1",
            )?;
            let x = stmt.query_map(params![limit], map_row)?
                .collect::<Result<Vec<_>, _>>()?;
            x
        };

        Ok(rows)
    }
}

fn map_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<TimelineEvent> {
    Ok(TimelineEvent {
        id: row.get(0)?,
        event_type: row.get(1)?,
        agent_name: row.get(2)?,
        from_agent: row.get(3)?,
        to_agent: row.get(4)?,
        message: row.get(5)?,
        tool: row.get(6)?,
        timestamp: row.get(7)?,
    })
}
