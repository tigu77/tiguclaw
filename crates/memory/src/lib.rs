//! tiguclaw-memory: 메모리 저장/검색 크레이트
//!
//! SQLite + FTS5 텍스트 검색 (BM25). 임베딩/벡터 검색 없음.

pub mod agent_store;
pub mod backend;
pub mod conversation;
pub mod sqlite;
pub mod types;

// Re-exports
pub use agent_store::{AgentStore, PersistedAgent};
pub use backend::MemoryBackend;
pub use conversation::ConversationStore;
pub use sqlite::SqliteMemory;
pub use types::{MemoryEntry, SearchResult};
