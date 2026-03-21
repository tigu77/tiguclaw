//! Common error types for tiguclaw.

use thiserror::Error;

/// Top-level error enum covering all subsystems.
#[derive(Error, Debug)]
pub enum TiguError {
    #[error("Provider error: {0}")]
    Provider(String),

    #[error("Channel error: {0}")]
    Channel(String),

    #[error("Runtime error: {0}")]
    Runtime(String),

    #[error("Tool error: {0}")]
    Tool(String),

    #[error("Config error: {0}")]
    Config(String),

    #[error("Timeout after {0}s")]
    Timeout(u64),

    #[error(transparent)]
    Other(#[from] anyhow::Error),
}

/// Convenience Result alias.
pub type Result<T> = std::result::Result<T, TiguError>;
