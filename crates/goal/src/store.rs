use std::path::Path;
use std::sync::Mutex;

use anyhow::{Context, Result};
use rusqlite::{params, Connection};
use tracing::{debug, info};

use crate::types::{Goal, GoalStatus, Phase};

// ─── GoalStore ────────────────────────────────────────────────────────────────

pub struct GoalStore {
    conn: Mutex<Connection>,
}

impl GoalStore {
    /// 새 GoalStore 생성. path가 None이면 :memory: 사용.
    pub fn open(path: Option<&Path>) -> Result<Self> {
        let conn = match path {
            Some(p) => Connection::open(p)
                .with_context(|| format!("Failed to open SQLite DB at {}", p.display()))?,
            None => Connection::open_in_memory()
                .context("Failed to open in-memory SQLite DB")?,
        };

        conn.execute_batch("PRAGMA journal_mode=WAL;")?;

        let store = Self {
            conn: Mutex::new(conn),
        };
        store.create_tables()?;
        info!("GoalStore initialized");
        Ok(store)
    }

    /// goals + phases 테이블 생성
    fn create_tables(&self) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS goals (
                id          TEXT PRIMARY KEY,
                description TEXT NOT NULL,
                status_json TEXT NOT NULL,
                attempt     INTEGER NOT NULL DEFAULT 0,
                max_attempts INTEGER NOT NULL DEFAULT 3,
                created_at  INTEGER NOT NULL,
                updated_at  INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS phases (
                id          TEXT PRIMARY KEY,
                goal_id     TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
                idx         INTEGER NOT NULL,
                description TEXT NOT NULL,
                status_json TEXT NOT NULL,
                result      TEXT,
                UNIQUE(goal_id, idx)
            );

            CREATE INDEX IF NOT EXISTS idx_goals_status ON goals(status_json);
            CREATE INDEX IF NOT EXISTS idx_phases_goal_id ON phases(goal_id);
            "#,
        )
        .context("Failed to create goal tables")?;
        debug!("Goal tables created/verified");
        Ok(())
    }

    /// Goal upsert (저장 또는 업데이트)
    pub fn save(&self, goal: &Goal) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let status_json = serde_json::to_string(&goal.status)
            .context("Failed to serialize GoalStatus")?;

        conn.execute(
            r#"
            INSERT INTO goals (id, description, status_json, attempt, max_attempts, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
            ON CONFLICT(id) DO UPDATE SET
                description  = excluded.description,
                status_json  = excluded.status_json,
                attempt      = excluded.attempt,
                max_attempts = excluded.max_attempts,
                updated_at   = excluded.updated_at
            "#,
            params![
                goal.id,
                goal.description,
                status_json,
                goal.attempt,
                goal.max_attempts,
                goal.created_at,
                goal.updated_at,
            ],
        )
        .context("Failed to upsert goal")?;

        // phases: 기존 삭제 후 재삽입
        conn.execute("DELETE FROM phases WHERE goal_id = ?1", params![goal.id])?;
        for (idx, phase) in goal.phases.iter().enumerate() {
            let phase_status_json = serde_json::to_string(&phase.status)
                .context("Failed to serialize PhaseStatus")?;
            conn.execute(
                r#"
                INSERT INTO phases (id, goal_id, idx, description, status_json, result)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                "#,
                params![
                    phase.id,
                    goal.id,
                    idx as i64,
                    phase.description,
                    phase_status_json,
                    phase.result,
                ],
            )
            .context("Failed to insert phase")?;
        }

        debug!("Goal saved: {}", goal.id);
        Ok(())
    }

    /// 단건 조회
    pub fn load(&self, id: &str) -> Result<Option<Goal>> {
        let conn = self.conn.lock().unwrap();

        let goal_opt = conn
            .query_row(
                "SELECT id, description, status_json, attempt, max_attempts, created_at, updated_at FROM goals WHERE id = ?1",
                params![id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, u32>(3)?,
                        row.get::<_, u32>(4)?,
                        row.get::<_, i64>(5)?,
                        row.get::<_, i64>(6)?,
                    ))
                },
            )
            .optional()
            .context("Failed to query goal")?;

        let Some((gid, description, status_json, attempt, max_attempts, created_at, updated_at)) =
            goal_opt
        else {
            return Ok(None);
        };

        let status: GoalStatus =
            serde_json::from_str(&status_json).context("Failed to deserialize GoalStatus")?;

        let phases = self.load_phases(&conn, &gid)?;

        Ok(Some(Goal {
            id: gid,
            description,
            status,
            phases,
            attempt,
            max_attempts,
            created_at,
            updated_at,
        }))
    }

    /// 활성 Goals 목록 (Pending / Planning / Executing / Replanning)
    pub fn list_active(&self) -> Result<Vec<Goal>> {
        let conn = self.conn.lock().unwrap();

        let mut stmt = conn.prepare(
            "SELECT id, description, status_json, attempt, max_attempts, created_at, updated_at FROM goals ORDER BY created_at ASC",
        )?;

        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, u32>(3)?,
                row.get::<_, u32>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, i64>(6)?,
            ))
        })?;

        let mut goals = Vec::new();
        for row in rows {
            let (gid, description, status_json, attempt, max_attempts, created_at, updated_at) =
                row?;
            let status: GoalStatus = serde_json::from_str(&status_json)
                .context("Failed to deserialize GoalStatus")?;

            if !status.is_active() {
                continue;
            }

            let phases = self.load_phases(&conn, &gid)?;
            goals.push(Goal {
                id: gid,
                description,
                status,
                phases,
                attempt,
                max_attempts,
                created_at,
                updated_at,
            });
        }

        Ok(goals)
    }

    /// 전체 Goals 목록
    pub fn list_all(&self) -> Result<Vec<Goal>> {
        let conn = self.conn.lock().unwrap();

        let mut stmt = conn.prepare(
            "SELECT id, description, status_json, attempt, max_attempts, created_at, updated_at FROM goals ORDER BY created_at ASC",
        )?;

        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, u32>(3)?,
                row.get::<_, u32>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, i64>(6)?,
            ))
        })?;

        let mut goals = Vec::new();
        for row in rows {
            let (gid, description, status_json, attempt, max_attempts, created_at, updated_at) =
                row?;
            let status: GoalStatus = serde_json::from_str(&status_json)
                .context("Failed to deserialize GoalStatus")?;
            let phases = self.load_phases(&conn, &gid)?;
            goals.push(Goal {
                id: gid,
                description,
                status,
                phases,
                attempt,
                max_attempts,
                created_at,
                updated_at,
            });
        }

        Ok(goals)
    }

    /// Goal 삭제
    pub fn delete(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM goals WHERE id = ?1", params![id])?;
        Ok(())
    }

    // ─── 내부 헬퍼 ─────────────────────────────────────────────────────────

    fn load_phases(&self, conn: &Connection, goal_id: &str) -> Result<Vec<Phase>> {
        let mut stmt = conn.prepare(
            "SELECT id, description, status_json, result FROM phases WHERE goal_id = ?1 ORDER BY idx ASC",
        )?;

        let rows = stmt.query_map(params![goal_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })?;

        let mut phases = Vec::new();
        for row in rows {
            let (pid, description, status_json, result) = row?;
            let status = serde_json::from_str(&status_json)
                .context("Failed to deserialize PhaseStatus")?;
            phases.push(Phase {
                id: pid,
                description,
                status,
                result,
            });
        }

        Ok(phases)
    }
}

// ─── rusqlite optional helper ────────────────────────────────────────────────

trait OptionalExt<T> {
    fn optional(self) -> Result<Option<T>>;
}

impl<T> OptionalExt<T> for std::result::Result<T, rusqlite::Error> {
    fn optional(self) -> Result<Option<T>> {
        match self {
            Ok(v) => Ok(Some(v)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{Goal, GoalStatus, Phase, PhaseStatus};

    fn test_store() -> GoalStore {
        GoalStore::open(None).expect("in-memory store")
    }

    #[test]
    fn test_save_and_load() {
        let store = test_store();
        let mut goal = Goal::new("테스트 목표");
        goal.phases.push(Phase::new("Phase 1"));
        goal.phases.push(Phase::new("Phase 2"));

        store.save(&goal).unwrap();
        let loaded = store.load(&goal.id).unwrap().unwrap();

        assert_eq!(loaded.id, goal.id);
        assert_eq!(loaded.description, "테스트 목표");
        assert_eq!(loaded.phases.len(), 2);
        assert_eq!(loaded.phases[0].description, "Phase 1");
    }

    #[test]
    fn test_list_active() {
        let store = test_store();

        let mut active = Goal::new("활성 목표");
        active.status = GoalStatus::Executing { current_phase: 0 };
        store.save(&active).unwrap();

        let mut done = Goal::new("완료 목표");
        done.status = GoalStatus::Completed;
        store.save(&done).unwrap();

        let actives = store.list_active().unwrap();
        assert_eq!(actives.len(), 1);
        assert_eq!(actives[0].id, active.id);
    }

    #[test]
    fn test_update_goal() {
        let store = test_store();
        let mut goal = Goal::new("업데이트 테스트");
        store.save(&goal).unwrap();

        goal.status = GoalStatus::Planning;
        goal.attempt = 1;
        goal.touch();
        store.save(&goal).unwrap();

        let loaded = store.load(&goal.id).unwrap().unwrap();
        assert_eq!(loaded.status, GoalStatus::Planning);
        assert_eq!(loaded.attempt, 1);
    }

    #[test]
    fn test_phase_status_serialization() {
        let store = test_store();
        let mut goal = Goal::new("Phase 상태 테스트");
        let mut phase = Phase::new("실패 Phase");
        phase.status = PhaseStatus::Failed {
            reason: "타임아웃".to_string(),
        };
        phase.result = Some("부분 결과".to_string());
        goal.phases.push(phase);
        store.save(&goal).unwrap();

        let loaded = store.load(&goal.id).unwrap().unwrap();
        let p = &loaded.phases[0];
        assert!(matches!(&p.status, PhaseStatus::Failed { reason } if reason == "타임아웃"));
        assert_eq!(p.result.as_deref(), Some("부분 결과"));
    }

    #[test]
    fn test_delete() {
        let store = test_store();
        let goal = Goal::new("삭제 테스트");
        store.save(&goal).unwrap();
        store.delete(&goal.id).unwrap();
        assert!(store.load(&goal.id).unwrap().is_none());
    }
}
