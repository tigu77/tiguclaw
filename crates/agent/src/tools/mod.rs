//! Built-in tools for the agentic loop.

pub mod agent_task;
pub mod auto_spawn;
pub mod edit_file;
pub mod escalate;
pub mod memory_search;
pub mod memory_store;
pub mod read_file;
pub mod report_to_parent;
pub mod shell;
pub mod spawn_agent;
pub mod send_file;
pub mod web_fetch;
pub mod web_search;
pub mod write_file;

pub use agent_task::{KillAgentTool, ListAgentsTool, SendToAgentTool};
pub use auto_spawn::AnalyzeWorkloadTool;
pub use edit_file::EditFileTool;
pub use escalate::EscalateToParentTool;
pub use memory_search::MemorySearchTool;
pub use memory_store::MemoryStoreTool;
pub use read_file::ReadFileTool;
pub use report_to_parent::ReportToParentTool;
pub use send_file::SendFileTool;
pub use shell::ShellTool;
pub use spawn_agent::SpawnAgentTool;
pub use web_fetch::WebFetchTool;
pub use web_search::WebSearchTool;
pub use write_file::WriteFileTool;
