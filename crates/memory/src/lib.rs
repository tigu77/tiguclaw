//! tiguclaw-memory: 메모리 저장/검색 크레이트
//!
//! SQLite + FTS5 텍스트 검색 (BM25).
//! `embeddings` feature 활성 시 fastembed + sqlite-vec 벡터 검색 + 시간 decay 하이브리드 검색.

pub mod agent_store;
pub mod backend;
pub mod conversation;
pub mod embedding;
pub mod sqlite;
pub mod types;

// Re-exports
pub use agent_store::{AgentStore, PersistedAgent};
pub use backend::MemoryBackend;
pub use conversation::ConversationStore;
pub use embedding::{EmbeddingProvider, NoEmbedding};
pub use sqlite::SqliteMemory;
pub use types::{MemoryEntry, SearchResult};

#[cfg(feature = "embeddings")]
pub use embedding::FastembedProvider;
