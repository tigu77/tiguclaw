use std::path::Path;
use std::sync::Mutex;

use anyhow::{Context, Result};
use rusqlite::{params, Connection};
use tracing::{debug, info};
use uuid::Uuid;

use crate::backend::MemoryBackend;
use crate::types::{MemoryEntry, SearchResult};

/// SQLite 기반 메모리 백엔드 (FTS5/BM25 텍스트 검색)
pub struct SqliteMemory {
    conn: Mutex<Connection>,
}

impl SqliteMemory {
    /// 새 SqliteMemory 생성. path가 None이면 :memory: 사용.
    pub fn open(path: Option<&Path>) -> Result<Self> {
        let conn = match path {
            Some(p) => Connection::open(p)
                .with_context(|| format!("Failed to open SQLite DB at {}", p.display()))?,
            None => Connection::open_in_memory()
                .context("Failed to open in-memory SQLite DB")?,
        };

        // WAL 모드
        conn.execute_batch("PRAGMA journal_mode=WAL;")?;

        let memory = Self {
            conn: Mutex::new(conn),
        };

        memory.init_tables()?;
        info!("SqliteMemory initialized (FTS5 only)");
        Ok(memory)
    }

    fn init_tables(&self) -> Result<()> {
        let conn = self.conn.lock().map_err(|e| anyhow::anyhow!("mutex poisoned: {e}"))?;

        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS memories (
                id TEXT PRIMARY KEY,
                content TEXT NOT NULL,
                source TEXT NOT NULL,
                tags TEXT NOT NULL DEFAULT '[]',
                metadata TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS contexts (
                name TEXT PRIMARY KEY,
                messages TEXT NOT NULL DEFAULT '[]',
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now')),
                expires_at TEXT
            );

            CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts
                USING fts5(content, content_rowid='rowid');",
        )?;

        // Migration: add expires_at column if it doesn't exist (for existing DBs).
        let _ = conn.execute_batch("ALTER TABLE contexts ADD COLUMN expires_at TEXT;");

        debug!("Memory tables initialized");
        Ok(())
    }

    /// 만료된 컨텍스트 삭제. `retention_days` 경과한 항목 제거.
    pub fn purge_expired(&self, retention_days: u64) -> Result<usize> {
        let conn = self.conn.lock().map_err(|e| anyhow::anyhow!("mutex poisoned: {e}"))?;
        let affected = conn.execute(
            "DELETE FROM contexts WHERE expires_at IS NOT NULL AND expires_at < datetime('now')",
            [],
        )?;
        // Also purge by updated_at for entries without expires_at (legacy).
        let affected2 = conn.execute(
            "DELETE FROM contexts WHERE expires_at IS NULL AND updated_at < datetime('now', ?1)",
            params![format!("-{retention_days} days")],
        )?;
        let total = affected + affected2;
        if total > 0 {
            info!(total, "Purged expired contexts");
        }
        Ok(total)
    }

    /// Save context with explicit retention days for `expires_at` calculation.
    /// Same as `save_context` but sets a custom expiry.
    pub fn save_context_with_retention(
        &self,
        name: &str,
        messages: &[serde_json::Value],
        retention_days: u64,
    ) -> Result<()> {
        let conn = self.conn.lock().map_err(|e| anyhow::anyhow!("mutex poisoned: {e}"))?;
        let msgs_json = serde_json::to_string(messages)?;
        let expires_expr = format!("+{retention_days} days");
        conn.execute(
            "INSERT INTO contexts (name, messages, expires_at)
             VALUES (?1, ?2, datetime('now', ?3))
             ON CONFLICT(name) DO UPDATE SET
               messages = ?2,
               updated_at = datetime('now'),
               expires_at = datetime('now', ?3)",
            params![name, msgs_json, expires_expr],
        )?;
        debug!(name = %name, count = messages.len(), retention_days, "Context saved");
        Ok(())
    }

    fn parse_tags(tags_json: &str) -> Vec<String> {
        serde_json::from_str(tags_json).unwrap_or_default()
    }

    /// 컨텍스트 목록 + 메타데이터 반환: (name, saved_at, first_message_preview)
    pub fn list_contexts_with_meta(&self) -> Result<Vec<(String, String, String)>> {
        let conn = self.conn.lock().map_err(|e| anyhow::anyhow!("mutex poisoned: {e}"))?;
        let mut stmt = conn.prepare(
            "SELECT name, updated_at, messages FROM contexts ORDER BY updated_at DESC",
        )?;
        let results = stmt
            .query_map([], |row| {
                let name: String = row.get(0)?;
                let saved_at: String = row.get(1)?;
                let messages_json: String = row.get(2)?;
                Ok((name, saved_at, messages_json))
            })?
            .collect::<Result<Vec<_>, _>>()?;

        let metas = results
            .into_iter()
            .map(|(name, saved_at, messages_json)| {
                let preview = serde_json::from_str::<Vec<serde_json::Value>>(&messages_json)
                    .ok()
                    .and_then(|msgs| {
                        msgs.into_iter().find_map(|m| {
                            m.get("content")
                                .and_then(|c| c.as_str())
                                .map(|s| {
                                    let trimmed = s.trim();
                                    if trimmed.len() > 60 {
                                        format!("{}…", &trimmed[..60])
                                    } else {
                                        trimmed.to_string()
                                    }
                                })
                        })
                    })
                    .unwrap_or_else(|| "(비어있음)".to_string());
                (name, saved_at, preview)
            })
            .collect();

        Ok(metas)
    }

    /// metadata JSON 에서 file_path로 기존 mtime 조회.
    pub fn get_mtime_for_file(&self, file_path: &str) -> Result<Option<String>> {
        let conn = self.conn.lock().map_err(|e| anyhow::anyhow!("mutex poisoned: {e}"))?;
        let mut stmt = conn.prepare(
            "SELECT metadata FROM memories
             WHERE metadata IS NOT NULL
               AND json_extract(metadata, '$.file_path') = ?1
             LIMIT 1",
        )?;
        let result: Option<String> = stmt
            .query_row(params![file_path], |row| {
                let meta: String = row.get(0)?;
                Ok(meta)
            })
            .ok();

        if let Some(meta_str) = result {
            let meta: serde_json::Value = serde_json::from_str(&meta_str)?;
            Ok(meta.get("mtime").and_then(|v| v.as_str()).map(String::from))
        } else {
            Ok(None)
        }
    }

    /// file_path 기준으로 기존 메모리 항목 일괄 삭제.
    pub fn delete_by_file_path(&self, file_path: &str) -> Result<usize> {
        let conn = self.conn.lock().map_err(|e| anyhow::anyhow!("mutex poisoned: {e}"))?;

        let mut stmt = conn.prepare(
            "SELECT rowid, id FROM memories
             WHERE metadata IS NOT NULL
               AND json_extract(metadata, '$.file_path') = ?1",
        )?;
        let targets: Vec<(i64, String)> = stmt
            .query_map(params![file_path], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;

        let count = targets.len();
        for (rowid, id) in &targets {
            let _ = conn.execute(
                "DELETE FROM memories_fts WHERE rowid = ?1",
                params![rowid],
            );
            conn.execute("DELETE FROM memories WHERE id = ?1", params![id])?;
        }

        if count > 0 {
            debug!(file_path = %file_path, count, "Deleted old chunks for file");
        }
        Ok(count)
    }
}

impl MemoryBackend for SqliteMemory {
    fn store(&self, entry: MemoryEntry) -> Result<String> {
        let id = Uuid::new_v4().to_string();
        let tags_json = serde_json::to_string(&entry.tags)?;
        let metadata_json = entry
            .metadata
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?;
        let conn = self.conn.lock().map_err(|e| anyhow::anyhow!("mutex poisoned: {e}"))?;

        conn.execute(
            "INSERT INTO memories (id, content, source, tags, metadata)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, entry.content, entry.source, tags_json, metadata_json],
        )?;

        // FTS 인덱스에 추가
        let rowid: i64 = conn.query_row(
            "SELECT rowid FROM memories WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )?;
        conn.execute(
            "INSERT INTO memories_fts (rowid, content) VALUES (?1, ?2)",
            params![rowid, entry.content],
        )?;

        debug!(id = %id, source = %entry.source, "Memory stored");
        Ok(id)
    }

    fn search(&self, query: &str, limit: usize) -> Result<Vec<SearchResult>> {
        let conn = self.conn.lock().map_err(|e| anyhow::anyhow!("mutex poisoned: {e}"))?;

        let mut stmt = conn.prepare(
            "SELECT m.id, m.content, m.source, m.tags, fts.rank
             FROM memories_fts fts
             JOIN memories m ON m.rowid = fts.rowid
             WHERE memories_fts MATCH ?1
             ORDER BY fts.rank
             LIMIT ?2",
        )?;

        let results = stmt
            .query_map(params![query, limit as i64], |row| {
                let rank: f64 = row.get(4)?;
                Ok(SearchResult {
                    id: row.get(0)?,
                    content: row.get(1)?,
                    source: row.get(2)?,
                    tags: Self::parse_tags(&row.get::<_, String>(3)?),
                    // FTS5 rank is negative (lower = better), normalize to positive score
                    score: -rank,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        debug!(query = %query, count = results.len(), "FTS5 search completed");
        Ok(results)
    }

    fn delete(&self, id: &str) -> Result<bool> {
        let conn = self.conn.lock().map_err(|e| anyhow::anyhow!("mutex poisoned: {e}"))?;

        let rowid: Option<i64> = conn
            .query_row(
                "SELECT rowid FROM memories WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .ok();

        if let Some(rowid) = rowid {
            conn.execute(
                "DELETE FROM memories_fts WHERE rowid = ?1",
                params![rowid],
            )?;
        }

        let affected = conn.execute("DELETE FROM memories WHERE id = ?1", params![id])?;
        debug!(id = %id, deleted = affected > 0, "Memory delete");
        Ok(affected > 0)
    }

    fn list_contexts(&self) -> Result<Vec<String>> {
        let conn = self.conn.lock().map_err(|e| anyhow::anyhow!("mutex poisoned: {e}"))?;
        let mut stmt = conn.prepare("SELECT name FROM contexts ORDER BY name")?;
        let names = stmt
            .query_map([], |row| row.get(0))?
            .collect::<Result<Vec<String>, _>>()?;
        Ok(names)
    }

    fn save_context(&self, name: &str, messages: &[serde_json::Value]) -> Result<()> {
        self.save_context_with_retention(name, messages, 3)
    }

    fn load_context(&self, name: &str) -> Result<Vec<serde_json::Value>> {
        let conn = self.conn.lock().map_err(|e| anyhow::anyhow!("mutex poisoned: {e}"))?;
        let msgs_json: String = conn.query_row(
            "SELECT messages FROM contexts WHERE name = ?1",
            params![name],
            |row| row.get(0),
        )?;
        let messages: Vec<serde_json::Value> = serde_json::from_str(&msgs_json)?;
        Ok(messages)
    }

    fn delete_context(&self, name: &str) -> Result<bool> {
        let conn = self.conn.lock().map_err(|e| anyhow::anyhow!("mutex poisoned: {e}"))?;
        let affected = conn.execute("DELETE FROM contexts WHERE name = ?1", params![name])?;
        debug!(name = %name, deleted = affected > 0, "Context delete");
        Ok(affected > 0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_memory() -> SqliteMemory {
        SqliteMemory::open(None).unwrap()
    }

    #[test]
    fn test_store_and_search() {
        let mem = make_memory();

        let id = mem
            .store(MemoryEntry {
                content: "Rust is a systems programming language".into(),
                source: "conversation".into(),
                tags: vec!["rust".into(), "programming".into()],
                metadata: None,
            })
            .unwrap();
        assert!(!id.is_empty());

        mem.store(MemoryEntry {
            content: "Python is great for data science".into(),
            source: "vault".into(),
            tags: vec!["python".into()],
            metadata: None,
        })
        .unwrap();

        let results = mem.search("Rust programming", 10).unwrap();
        assert!(!results.is_empty());
        assert!(results[0].content.contains("Rust"));
        assert_eq!(results[0].source, "conversation");
    }

    #[test]
    fn test_delete() {
        let mem = make_memory();
        let id = mem
            .store(MemoryEntry {
                content: "temporary memory".into(),
                source: "test".into(),
                tags: vec![],
                metadata: None,
            })
            .unwrap();

        assert!(mem.delete(&id).unwrap());
        assert!(!mem.delete(&id).unwrap()); // 이미 삭제됨
    }

    #[test]
    fn test_context_crud() {
        let mem = make_memory();

        assert!(mem.list_contexts().unwrap().is_empty());

        let messages = vec![
            serde_json::json!({"role": "user", "content": "hello"}),
            serde_json::json!({"role": "assistant", "content": "hi!"}),
        ];
        mem.save_context("chat-1", &messages).unwrap();

        let contexts = mem.list_contexts().unwrap();
        assert_eq!(contexts, vec!["chat-1"]);

        let loaded = mem.load_context("chat-1").unwrap();
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded[0]["role"], "user");

        let updated = vec![serde_json::json!({"role": "user", "content": "updated"})];
        mem.save_context("chat-1", &updated).unwrap();
        let loaded = mem.load_context("chat-1").unwrap();
        assert_eq!(loaded.len(), 1);

        assert!(mem.delete_context("chat-1").unwrap());
        assert!(!mem.delete_context("chat-1").unwrap());
        assert!(mem.list_contexts().unwrap().is_empty());
    }

    #[test]
    fn test_delete_by_file_path() {
        let mem = make_memory();

        let metadata = serde_json::json!({
            "file_path": "/tmp/test.md",
            "mtime": "1234567890",
        });

        mem.store(MemoryEntry {
            content: "chunk 1 content".into(),
            source: "vault".into(),
            tags: vec![],
            metadata: Some(metadata.clone()),
        })
        .unwrap();

        mem.store(MemoryEntry {
            content: "chunk 2 content".into(),
            source: "vault".into(),
            tags: vec![],
            metadata: Some(metadata),
        })
        .unwrap();

        let deleted = mem.delete_by_file_path("/tmp/test.md").unwrap();
        assert_eq!(deleted, 2);

        let results = mem.search("chunk", 10).unwrap();
        assert!(results.is_empty());
    }

    #[test]
    fn test_get_mtime_for_file() {
        let mem = make_memory();

        let metadata = serde_json::json!({
            "file_path": "/tmp/doc.md",
            "mtime": "9999999999",
        });

        mem.store(MemoryEntry {
            content: "some content".into(),
            source: "vault".into(),
            tags: vec![],
            metadata: Some(metadata),
        })
        .unwrap();

        let mtime = mem.get_mtime_for_file("/tmp/doc.md").unwrap();
        assert_eq!(mtime, Some("9999999999".to_string()));

        let missing = mem.get_mtime_for_file("/tmp/missing.md").unwrap();
        assert!(missing.is_none());
    }
}
