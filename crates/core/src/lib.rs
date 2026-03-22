//! tiguclaw-core: shared types, traits, and configuration.

pub mod types;
pub mod error;
pub mod config;
pub mod backup;
pub mod event;
pub mod provider;
pub mod channel;
pub mod runtime;
pub mod tool;
pub mod security;
pub mod template;
pub mod agent_spec;
pub mod market;
pub mod escalation;

// Re-export key types for convenience.
pub use types::*;
pub use error::{TiguError, Result};
pub use config::Config;
pub use security::{ApprovalLevel, SecurityPolicy};
pub use template::{AgentTemplate, TemplateManager};
pub use agent_spec::{AgentSpec, AgentSpecManager};
pub use market::{MarketManager, PackageMeta, RegistryEntry};
