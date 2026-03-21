//! Conversation history persistence backed by SQLite.
//!
//! Stores chat messages per `chat_id` so the agent can resume context
//! across restarts.  System messages are **not** stored — they are
//! injected from the system prompt on every request.

use anyhow::{Context, Result};
use rusqlite::{params, Connection};
use tracing::{debug, info};

use tiguclaw_core::types::{ChatMessage, Role, ToolCall};

/// SQLite-backed conversation history store.
pub struct ConversationStore {
    conn: Connection,
}

impl ConversationStore {
    /// Create a store from an existing connection and ensure the schema exists.
    pub fn new(conn: Connection) -> Result<Self> {
        let store = Self { conn };
        store.ensure_schema()?;
        info!("conversation store initialized");
        Ok(store)
    }

    /// Open (or create) a file-backed database.
    pub fn open(path: &std::path::Path) -> Result<Self> {
        let conn =
            Connection::open(path).with_context(|| format!("open db: {}", path.display()))?;
        Self::new(conn)
    }

    /// Create an in-memory database (useful for tests).
    pub fn in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        Self::new(conn)
    }

    // ── public API ──────────────────────────────────────────────────

    /// Persist a single message. System messages are silently skipped.
    pub fn save_message(&self, chat_id: &str, message: &ChatMessage) -> Result<()> {
        if message.role == Role::System {
            debug!("skipping system message (not persisted)");
            return Ok(());
        }

        let role = role_to_str(&message.role);
        let tool_calls_json = if message.tool_calls.is_empty() {
            None
        } else {
            Some(serde_json::to_string(&message.tool_calls)?)
        };

        self.conn.execute(
            "INSERT INTO conversations (chat_id, role, content, tool_call_id, tool_calls)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                chat_id,
                role,
                message.content,
                message.tool_call_id,
                tool_calls_json,
            ],
        )?;

        debug!(chat_id, role, "saved message");
        Ok(())
    }

    /// Load the most recent `limit` messages for a chat, oldest first.
    pub fn load_history(&self, chat_id: &str, limit: usize) -> Result<Vec<ChatMessage>> {
        let mut stmt = self.conn.prepare(
            "SELECT role, content, tool_call_id, tool_calls
             FROM (
                 SELECT role, content, tool_call_id, tool_calls, id
                 FROM conversations
                 WHERE chat_id = ?1
                 ORDER BY id DESC
                 LIMIT ?2
             ) sub
             ORDER BY id ASC",
        )?;

        let rows = stmt.query_map(params![chat_id, limit as i64], |row| {
            let role: String = row.get(0)?;
            let content: String = row.get(1)?;
            let tool_call_id: Option<String> = row.get(2)?;
            let tool_calls_json: Option<String> = row.get(3)?;
            Ok((role, content, tool_call_id, tool_calls_json))
        })?;

        let mut messages = Vec::new();
        for row in rows {
            let (role_str, content, tool_call_id, tool_calls_json) = row?;
            let role = str_to_role(&role_str)?;
            let tool_calls: Vec<ToolCall> = match tool_calls_json {
                Some(json) => serde_json::from_str(&json)
                    .with_context(|| format!("deserialize tool_calls: {json}"))?,
                None => Vec::new(),
            };
            messages.push(ChatMessage {
                role,
                content,
                tool_call_id,
                tool_calls,
            });
        }

        debug!(chat_id, count = messages.len(), "loaded history");
        Ok(messages)
    }

    /// Delete all messages for a chat.
    pub fn clear_history(&self, chat_id: &str) -> Result<()> {
        let deleted = self
            .conn
            .execute("DELETE FROM conversations WHERE chat_id = ?1", params![chat_id])?;
        info!(chat_id, deleted, "cleared history");
        Ok(())
    }

    /// Count stored messages for a chat.
    pub fn count(&self, chat_id: &str) -> Result<usize> {
        let n: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM conversations WHERE chat_id = ?1",
            params![chat_id],
            |row| row.get(0),
        )?;
        Ok(n as usize)
    }

    /// List recent conversation summaries (for dashboard API).
    ///
    /// Returns `(chat_id, message_count, last_content, last_role, updated_at_unix)`.
    pub fn list_conversations(&self, limit: usize) -> Result<Vec<(String, usize, String, String, i64)>> {
        let mut stmt = self.conn.prepare(
            "SELECT
                chat_id,
                COUNT(*) as msg_count,
                (SELECT content FROM conversations c2
                 WHERE c2.chat_id = c.chat_id AND c2.role IN ('user', 'assistant')
                 ORDER BY c2.id DESC LIMIT 1) as last_content,
                (SELECT role FROM conversations c2
                 WHERE c2.chat_id = c.chat_id AND c2.role IN ('user', 'assistant')
                 ORDER BY c2.id DESC LIMIT 1) as last_role,
                CAST(strftime('%s', MAX(created_at)) AS INTEGER) as updated_at
             FROM conversations c
             WHERE role IN ('user', 'assistant')
             GROUP BY chat_id
             ORDER BY updated_at DESC
             LIMIT ?1",
        )?;

        let rows = stmt.query_map(params![limit as i64], |row| {
            let chat_id: String = row.get(0)?;
            let msg_count: i64 = row.get(1)?;
            let last_content: String = row.get(2).unwrap_or_default();
            let last_role: String = row.get(3).unwrap_or_default();
            let updated_at: i64 = row.get(4).unwrap_or(0);
            Ok((chat_id, msg_count as usize, last_content, last_role, updated_at))
        })?;

        let mut results = Vec::new();
        for row in rows {
            results.push(row?);
        }
        Ok(results)
    }

    /// Load message history with timestamps for dashboard display.
    ///
    /// Returns `(role, content, timestamp_unix)`.
    pub fn load_history_with_ts(&self, chat_id: &str, limit: usize) -> Result<Vec<(String, String, i64)>> {
        let mut stmt = self.conn.prepare(
            "SELECT role, content, CAST(strftime('%s', created_at) AS INTEGER) as ts
             FROM (
                 SELECT role, content, created_at, id
                 FROM conversations
                 WHERE chat_id = ?1 AND role IN ('user', 'assistant')
                 ORDER BY id DESC
                 LIMIT ?2
             ) sub
             ORDER BY id ASC",
        )?;

        let rows = stmt.query_map(params![chat_id, limit as i64], |row| {
            let role: String = row.get(0)?;
            let content: String = row.get(1)?;
            let ts: i64 = row.get(2).unwrap_or(0);
            Ok((role, content, ts))
        })?;

        let mut results = Vec::new();
        for row in rows {
            results.push(row?);
        }
        Ok(results)
    }

    // ── internal ────────────────────────────────────────────────────

    fn ensure_schema(&self) -> Result<()> {
        self.conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS conversations (
                 id          INTEGER PRIMARY KEY AUTOINCREMENT,
                 chat_id     TEXT NOT NULL,
                 role        TEXT NOT NULL,
                 content     TEXT NOT NULL,
                 tool_call_id TEXT,
                 tool_calls  TEXT,
                 created_at  TEXT NOT NULL DEFAULT (datetime('now'))
             );
             CREATE INDEX IF NOT EXISTS idx_conv_chat_id
                 ON conversations(chat_id);",
        )?;
        Ok(())
    }
}

// ── helpers ─────────────────────────────────────────────────────────

fn role_to_str(role: &Role) -> &'static str {
    match role {
        Role::System => "system",
        Role::User => "user",
        Role::Assistant => "assistant",
        Role::Tool => "tool",
    }
}

fn str_to_role(s: &str) -> Result<Role> {
    match s {
        "system" => Ok(Role::System),
        "user" => Ok(Role::User),
        "assistant" => Ok(Role::Assistant),
        "tool" => Ok(Role::Tool),
        other => anyhow::bail!("unknown role: {other}"),
    }
}

// ── tests ───────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn make_store() -> ConversationStore {
        ConversationStore::in_memory().unwrap()
    }

    #[test]
    fn save_and_load_roundtrip() {
        let store = make_store();
        let chat = "chat_1";

        store
            .save_message(chat, &ChatMessage::user("hello"))
            .unwrap();
        store
            .save_message(chat, &ChatMessage::assistant("hi there"))
            .unwrap();

        let history = store.load_history(chat, 10).unwrap();
        assert_eq!(history.len(), 2);
        assert_eq!(history[0].content, "hello");
        assert_eq!(history[0].role, Role::User);
        assert_eq!(history[1].content, "hi there");
        assert_eq!(history[1].role, Role::Assistant);
    }

    #[test]
    fn system_messages_skipped() {
        let store = make_store();
        store
            .save_message("c", &ChatMessage::system("you are a bot"))
            .unwrap();
        assert_eq!(store.count("c").unwrap(), 0);
    }

    #[test]
    fn load_history_respects_limit() {
        let store = make_store();
        for i in 0..10 {
            store
                .save_message("c", &ChatMessage::user(format!("msg {i}")))
                .unwrap();
        }
        let history = store.load_history("c", 3).unwrap();
        assert_eq!(history.len(), 3);
        // Should be the 3 most recent, oldest first.
        assert_eq!(history[0].content, "msg 7");
        assert_eq!(history[2].content, "msg 9");
    }

    #[test]
    fn clear_history_works() {
        let store = make_store();
        store
            .save_message("c", &ChatMessage::user("a"))
            .unwrap();
        store
            .save_message("c", &ChatMessage::user("b"))
            .unwrap();
        assert_eq!(store.count("c").unwrap(), 2);
        store.clear_history("c").unwrap();
        assert_eq!(store.count("c").unwrap(), 0);
    }

    #[test]
    fn tool_calls_roundtrip() {
        let store = make_store();
        let chat = "tc";

        let tool_call = ToolCall {
            id: "tc_1".into(),
            name: "shell".into(),
            args: {
                let mut m = HashMap::new();
                m.insert(
                    "command".to_string(),
                    serde_json::Value::String("ls".into()),
                );
                m
            },
        };
        let msg = ChatMessage::assistant_with_tools("thinking...", vec![tool_call]);
        store.save_message(chat, &msg).unwrap();

        // Tool result
        let result = ChatMessage::tool_result("tc_1", "file1\nfile2");
        store.save_message(chat, &result).unwrap();

        let history = store.load_history(chat, 10).unwrap();
        assert_eq!(history.len(), 2);

        // Verify tool calls deserialized correctly.
        assert_eq!(history[0].tool_calls.len(), 1);
        assert_eq!(history[0].tool_calls[0].name, "shell");
        assert_eq!(history[0].tool_calls[0].id, "tc_1");

        // Verify tool result.
        assert_eq!(history[1].role, Role::Tool);
        assert_eq!(history[1].tool_call_id.as_deref(), Some("tc_1"));
        assert_eq!(history[1].content, "file1\nfile2");
    }

    #[test]
    fn separate_chat_ids() {
        let store = make_store();
        store
            .save_message("a", &ChatMessage::user("from a"))
            .unwrap();
        store
            .save_message("b", &ChatMessage::user("from b"))
            .unwrap();
        assert_eq!(store.count("a").unwrap(), 1);
        assert_eq!(store.count("b").unwrap(), 1);
        let ha = store.load_history("a", 10).unwrap();
        assert_eq!(ha[0].content, "from a");
    }
}
