use serde::{Deserialize, Serialize};

/// 메모리에 저장할 항목
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryEntry {
    /// 메모리 내용
    pub content: String,
    /// 출처: "conversation", "vault", "memory_md" 등
    pub source: String,
    /// 태그 목록
    pub tags: Vec<String>,
    /// 추가 메타데이터 (JSON)
    pub metadata: Option<serde_json::Value>,
}

/// 검색 결과
#[derive(Debug, Clone)]
pub struct SearchResult {
    pub id: String,
    pub content: String,
    pub source: String,
    pub score: f64,
    pub tags: Vec<String>,
}
