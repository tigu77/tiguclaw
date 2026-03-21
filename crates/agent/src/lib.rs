//! tiguclaw-agent: agentic loop and tool implementations.

pub mod approval;
pub mod cancel;
pub mod context_commands;
pub mod heartbeat;
pub mod loop_;
pub mod message_handler;
pub mod monitor;
pub mod prompt_builder;
pub mod registry;
pub mod scheduler;
pub mod skills;
pub mod subprocess;
pub mod tools;
pub mod workspace;

pub use approval::ApprovalManager;
pub use loop_::AgentLoop;
pub use loop_::HookEvent;
pub use monitor::Monitor;
pub use prompt_builder::PromptBuilder;
pub use registry::{AgentRegistry, SpawnRequest};
pub use workspace::WorkspaceLoader;
