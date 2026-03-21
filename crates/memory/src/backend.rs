use crate::types::{MemoryEntry, SearchResult};
use anyhow::Result;

/// 메모리 저장소 백엔드 trait
pub trait MemoryBackend: Send + Sync {
    /// 메모리 항목 저장, id 반환
    fn store(&self, entry: MemoryEntry) -> Result<String>;

    /// 텍스트 검색 (FTS5/BM25)
    fn search(&self, query: &str, limit: usize) -> Result<Vec<SearchResult>>;

    /// 삭제
    fn delete(&self, id: &str) -> Result<bool>;

    /// 네임드 컨텍스트 목록
    fn list_contexts(&self) -> Result<Vec<String>>;

    /// 네임드 컨텍스트 저장
    fn save_context(&self, name: &str, messages: &[serde_json::Value]) -> Result<()>;

    /// 네임드 컨텍스트 로드
    fn load_context(&self, name: &str) -> Result<Vec<serde_json::Value>>;

    /// 네임드 컨텍스트 삭제
    fn delete_context(&self, name: &str) -> Result<bool>;
}
