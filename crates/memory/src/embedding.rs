//! EmbeddingProvider trait + 구현체들
//!
//! `embeddings` feature 없이도 NoEmbedding(폴백)으로 동작한다.

use anyhow::Result;

/// 임베딩 생성 trait
pub trait EmbeddingProvider: Send + Sync {
    fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>>;
    fn dimension(&self) -> usize;
}

// ─── fastembed 기반 로컬 임베딩 ─────────────────────────────────────────────

#[cfg(feature = "embeddings")]
pub struct FastembedProvider {
    /// fastembed TextEmbedding — embed()가 &self라 Mutex 불필요하지만
    /// 버전 호환성을 위해 std::sync::Mutex로 감싼다.
    model: std::sync::Mutex<fastembed::TextEmbedding>,
    dim: usize,
}

#[cfg(feature = "embeddings")]
impl FastembedProvider {
    pub fn new() -> Result<Self> {
        use fastembed::{EmbeddingModel, InitOptions, TextEmbedding};
        let model = TextEmbedding::try_new(
            InitOptions::new(EmbeddingModel::AllMiniLML6V2).with_show_download_progress(true),
        )?;
        Ok(Self {
            model: std::sync::Mutex::new(model),
            dim: 384,
        })
    }
}

#[cfg(feature = "embeddings")]
impl EmbeddingProvider for FastembedProvider {
    fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>> {
        let refs: Vec<&str> = texts.iter().map(|s| s.as_str()).collect();
        let model = self
            .model
            .lock()
            .map_err(|e| anyhow::anyhow!("fastembed mutex poisoned: {e}"))?;
        let embeddings = model.embed(refs, None)?;
        Ok(embeddings)
    }

    fn dimension(&self) -> usize {
        self.dim
    }
}

// ─── 폴백: 임베딩 없음 (FTS5 only) ─────────────────────────────────────────

/// embeddings feature가 없거나 provider가 "none"일 때 사용하는 no-op 구현.
pub struct NoEmbedding;

impl EmbeddingProvider for NoEmbedding {
    fn embed(&self, _texts: &[String]) -> Result<Vec<Vec<f32>>> {
        Ok(vec![])
    }

    fn dimension(&self) -> usize {
        0
    }
}
