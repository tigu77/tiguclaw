use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result};
use chrono::Utc;
use rusqlite::{params, Connection};
use tracing::{debug, info};
use uuid::Uuid;

use crate::backend::MemoryBackend;
use crate::embedding::EmbeddingProvider;
use crate::types::{MemoryEntry, SearchResult};

// ─── sqlite-vec 확장 등록 (embeddings feature) ──────────────────────────────

/// sqlite-vec 확장을 프로세스 전역으로 한 번만 등록한다.
/// `sqlite3_auto_extension`을 사용하므로 이 호출 이후에 열리는 모든
/// SQLite 연결에 vec0 모듈이 자동으로 로드된다.
#[cfg(feature = "embeddings")]
fn ensure_sqlite_vec_registered() {
    use std::sync::Once;
    static INIT: Once = Once::new();
    INIT.call_once(|| {
        unsafe {
            // sqlite_vec::sqlite3_vec_init 은 extern "C" fn() 으로 선언됨.
            // sqlite3_auto_extension 의 콜백 시그니처와 동일하다.
            rusqlite::ffi::sqlite3_auto_extension(Some(
                std::mem::transmute(sqlite_vec::sqlite3_vec_init as *const ()),
            ));
        }
        debug!("sqlite-vec registered via sqlite3_auto_extension");
    });
}

/// float32 벡터를 sqlite-vec 용 little-endian BLOB으로 직렬화
fn serialize_f32(v: &[f32]) -> Vec<u8> {
    v.iter().flat_map(|f| f.to_le_bytes()).collect()
}

// ─── SqliteMemory ─────────────────────────────────────────────────────────

/// SQLite 기반 메모리 백엔드 (FTS5/BM25 + 선택적 벡터 검색)
pub struct SqliteMemory {
    conn: Mutex<Connection>,
    /// 임베딩 제공자 — None이면 FTS5 only
    embedding_provider: Option<Arc<dyn EmbeddingProvider>>,
}

impl SqliteMemory {
    /// 새 SqliteMemory 생성. path가 None이면 :memory: 사용.
    /// `embeddings` feature 활성 시 sqlite-vec 확장을 전역 등록한 뒤 연결을 열어
    /// 이후 `with_embedding()` 호출 시 vec0 가상 테이블을 사용할 수 있다.
    pub fn open(path: Option<&Path>) -> Result<Self> {
        // sqlite-vec 확장을 Connection::open 이전에 등록해야 vec0 가상 테이블이 동작한다.
        #[cfg(feature = "embeddings")]
        ensure_sqlite_vec_registered();

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
            embedding_provider: None,
        };

        memory.init_tables()?;
        info!("SqliteMemory initialized (FTS5 only)");
        Ok(memory)
    }

    /// 임베딩 제공자를 설정하고 vec0 가상 테이블을 초기화하는 빌더 메서드.
    /// `open()` 후에 체인 호출: `SqliteMemory::open(...)?.with_embedding(provider)?`
    pub fn with_embedding(mut self, provider: Arc<dyn EmbeddingProvider>) -> Result<Self> {
        if provider.dimension() > 0 {
            self.init_vec_table(provider.dimension())?;
            info!(
                dim = provider.dimension(),
                "SqliteMemory: vector search (sqlite-vec + fastembed) enabled"
            );
        }
        self.embedding_provider = Some(provider);
        Ok(self)
    }

    // ─── 테이블 초기화 ─────────────────────────────────────────────────────

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

    /// sqlite-vec vec0 가상 테이블 초기화
    fn init_vec_table(&self, dim: usize) -> Result<()> {
        let conn = self.conn.lock().map_err(|e| anyhow::anyhow!("mutex poisoned: {e}"))?;
        conn.execute_batch(&format!(
            "CREATE VIRTUAL TABLE IF NOT EXISTS memory_vss
             USING vec0(embedding float[{dim}]);",
        ))?;
        debug!(dim, "memory_vss vector table ready");
        Ok(())
    }

    // ─── 내부 검색 헬퍼 ────────────────────────────────────────────────────

    /// FTS5 BM25 키워드 검색: (rowid, rank) 반환
    fn fts_search_raw(&self, query: &str, limit: usize) -> Result<Vec<(i64, f64)>> {
        let conn = self.conn.lock().map_err(|e| anyhow::anyhow!("mutex poisoned: {e}"))?;
        let mut stmt = conn.prepare(
            "SELECT m.rowid, fts.rank
             FROM memories_fts fts
             JOIN memories m ON m.rowid = fts.rowid
             WHERE memories_fts MATCH ?1
             ORDER BY fts.rank
             LIMIT ?2",
        )?;
        let results = stmt
            .query_map(params![query, limit as i64], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, f64>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(results)
    }

    /// 벡터 유사도 KNN 검색: (rowid, distance) 반환
    fn vector_search_raw(&self, query_vec: &[f32], limit: usize) -> Result<Vec<(i64, f32)>> {
        let blob = serialize_f32(query_vec);
        let conn = self.conn.lock().map_err(|e| anyhow::anyhow!("mutex poisoned: {e}"))?;

        let mut stmt = conn.prepare(
            "SELECT rowid, distance
             FROM memory_vss
             WHERE embedding MATCH ?1 AND k = ?2
             ORDER BY distance",
        )?;
        let results = stmt
            .query_map(params![blob, limit as i64], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, f32>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()
            .unwrap_or_default();
        Ok(results)
    }

    /// rowid 목록으로 메모리 항목 + created_at_unix 일괄 조회
    fn fetch_entries_by_rowids(
        &self,
        rowids: &[i64],
        conn: &Connection,
    ) -> Result<HashMap<i64, (SearchResult, i64)>> {
        if rowids.is_empty() {
            return Ok(HashMap::new());
        }

        let placeholders: String = (1..=rowids.len())
            .map(|i| format!("?{i}"))
            .collect::<Vec<_>>()
            .join(", ");

        let sql = format!(
            "SELECT rowid, id, content, source, tags,
                    CAST(strftime('%s', created_at) AS INTEGER) as created_unix
             FROM memories
             WHERE rowid IN ({placeholders})"
        );

        let mut stmt = conn.prepare(&sql)?;
        let params_boxed: Vec<Box<dyn rusqlite::ToSql>> = rowids
            .iter()
            .map(|r| Box::new(*r) as Box<dyn rusqlite::ToSql>)
            .collect();

        let results = stmt
            .query_map(rusqlite::params_from_iter(params_boxed.iter()), |row| {
                let rowid: i64 = row.get(0)?;
                let created_unix: i64 = row.get(5).unwrap_or(0);
                let sr = SearchResult {
                    id: row.get(1)?,
                    content: row.get(2)?,
                    source: row.get(3)?,
                    tags: serde_json::from_str(&row.get::<_, String>(4)?)
                        .unwrap_or_default(),
                    score: 0.0,
                };
                Ok((rowid, (sr, created_unix)))
            })?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(results.into_iter().collect())
    }

    /// 시간 감쇠 함수: 30일 반감기 지수 감쇠 (0.0 ~ 1.0)
    fn time_decay(created_at_unix: i64) -> f32 {
        let now = Utc::now().timestamp();
        let age_days = (now - created_at_unix).max(0) as f32 / 86400.0;
        (-age_days / 30.0).exp()
    }

    /// 하이브리드 스코어 머지:
    ///   score = 0.6 * vec_score + 0.3 * bm25_score + 0.1 * time_decay
    fn merge_results(
        &self,
        vec_raw: Vec<(i64, f32)>,  // (rowid, distance) — 작을수록 유사
        fts_raw: Vec<(i64, f64)>,  // (rowid, rank)     — 더 음수일수록 좋음
        limit: usize,
    ) -> Result<Vec<SearchResult>> {
        if vec_raw.is_empty() && fts_raw.is_empty() {
            return Ok(vec![]);
        }

        // distance → similarity: 1 / (1 + distance)
        let vec_scores: HashMap<i64, f32> = vec_raw
            .iter()
            .map(|(rid, dist)| (*rid, 1.0_f32 / (1.0 + dist)))
            .collect();

        // FTS rank(음수) → 정규화 BM25 score
        let max_abs_rank = fts_raw
            .iter()
            .map(|(_, r)| r.abs())
            .fold(f64::EPSILON, f64::max);
        let bm25_scores: HashMap<i64, f32> = fts_raw
            .iter()
            .map(|(rid, rank)| (*rid, (rank.abs() / max_abs_rank) as f32))
            .collect();

        // 유니크 rowid 집합
        let mut all_rowids: Vec<i64> = vec_scores
            .keys()
            .chain(bm25_scores.keys())
            .copied()
            .collect();
        all_rowids.sort_unstable();
        all_rowids.dedup();

        let conn = self.conn.lock().map_err(|e| anyhow::anyhow!("mutex poisoned: {e}"))?;
        let entries = self.fetch_entries_by_rowids(&all_rowids, &conn)?;
        drop(conn);

        let mut scored: Vec<(f32, SearchResult)> = entries
            .into_iter()
            .map(|(rowid, (mut sr, created_unix))| {
                let vs = vec_scores.get(&rowid).copied().unwrap_or(0.0);
                let bs = bm25_scores.get(&rowid).copied().unwrap_or(0.0);
                let td = Self::time_decay(created_unix);
                let score = 0.6 * vs + 0.3 * bs + 0.1 * td;
                sr.score = score as f64;
                (score, sr)
            })
            .collect();

        scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
        scored.truncate(limit);

        Ok(scored.into_iter().map(|(_, sr)| sr).collect())
    }

    // ─── 공개 유틸리티 ────────────────────────────────────────────────────

    /// 만료된 컨텍스트 삭제
    pub fn purge_expired(&self, retention_days: u64) -> Result<usize> {
        let conn = self.conn.lock().map_err(|e| anyhow::anyhow!("mutex poisoned: {e}"))?;
        let affected = conn.execute(
            "DELETE FROM contexts WHERE expires_at IS NOT NULL AND expires_at < datetime('now')",
            [],
        )?;
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

    /// Save context with explicit retention days
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

    /// metadata JSON 에서 file_path로 기존 mtime 조회
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

    /// file_path 기준으로 기존 메모리 항목 일괄 삭제
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
            // memory_vss 삭제 (있을 때만, 실패해도 무시)
            let _ = conn.execute(
                "DELETE FROM memory_vss WHERE rowid = ?1",
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

// ─── MemoryBackend 구현 ───────────────────────────────────────────────────

impl MemoryBackend for SqliteMemory {
    fn store(&self, entry: MemoryEntry) -> Result<String> {
        // 1. 임베딩 생성 (뮤텍스 바깥에서 — 추론 시간이 길 수 있음)
        let embedding: Option<Vec<f32>> = if let Some(provider) = &self.embedding_provider {
            let vecs = provider.embed(&[entry.content.clone()])?;
            vecs.into_iter().next()
        } else {
            None
        };

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

        // 2. 벡터 인덱스에 추가 (memory_vss가 없을 때는 자동으로 무시)
        if let Some(v) = embedding {
            let blob = serialize_f32(&v);
            let _ = conn.execute(
                "INSERT INTO memory_vss(rowid, embedding) VALUES (?1, ?2)",
                params![rowid, blob],
            );
        }

        debug!(id = %id, source = %entry.source, "Memory stored");
        Ok(id)
    }

    fn search(&self, query: &str, limit: usize) -> Result<Vec<SearchResult>> {
        // 1. 벡터 검색 (임베딩 제공자 있을 때)
        let vec_raw: Vec<(i64, f32)> = if let Some(provider) = &self.embedding_provider {
            match provider.embed(&[query.to_string()]) {
                Ok(q_vecs) => {
                    if let Some(v) = q_vecs.into_iter().next() {
                        self.vector_search_raw(&v, limit * 2).unwrap_or_default()
                    } else {
                        vec![]
                    }
                }
                Err(e) => {
                    debug!("vector search failed, falling back to FTS5: {e}");
                    vec![]
                }
            }
        } else {
            vec![]
        };

        // 2. FTS5 BM25 키워드 검색
        let fts_raw = self.fts_search_raw(query, limit * 2).unwrap_or_default();

        // 결과 없음
        if vec_raw.is_empty() && fts_raw.is_empty() {
            return Ok(vec![]);
        }

        // 임베딩이 없으면 FTS 결과만 반환 (기존 동작 유지 + 성능 보존)
        if self.embedding_provider.is_none() {
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
                        score: -rank,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            debug!(query = %query, count = results.len(), "FTS5-only search completed");
            return Ok(results);
        }

        // 3. 하이브리드 스코어링 + 머지
        let merged = self.merge_results(vec_raw, fts_raw, limit)?;
        debug!(query = %query, count = merged.len(), "hybrid search completed");
        Ok(merged)
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
            let _ = conn.execute(
                "DELETE FROM memory_vss WHERE rowid = ?1",
                params![rowid],
            );
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

// ─── 테스트 ───────────────────────────────────────────────────────────────

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
        assert!(!mem.delete(&id).unwrap());
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

    #[test]
    fn test_time_decay() {
        let now = Utc::now().timestamp();
        let decay = SqliteMemory::time_decay(now);
        assert!(decay > 0.99, "fresh entry should have decay ~1.0, got {decay}");

        let old = now - 30 * 86400;
        let decay_old = SqliteMemory::time_decay(old);
        assert!(
            (decay_old - 0.368).abs() < 0.01,
            "30-day old entry should have decay ~0.368, got {decay_old}"
        );
    }
}
