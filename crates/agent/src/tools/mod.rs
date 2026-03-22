//! Built-in tools for the agentic loop.

pub mod agent_task;
pub mod auto_spawn;
pub mod edit_file;
pub mod escalate;
pub mod read_file;
pub mod report_to_parent;
pub mod shell;
pub mod spawn_agent;
pub mod web_fetch;
pub mod write_file;

pub use agent_task::{KillAgentTool, ListAgentsTool, SendToAgentTool};
pub use auto_spawn::AnalyzeWorkloadTool;
pub use edit_file::EditFileTool;
pub use escalate::EscalateToParentTool;
pub use read_file::ReadFileTool;
pub use report_to_parent::ReportToParentTool;
pub use shell::ShellTool;
pub use spawn_agent::SpawnAgentTool;
pub use web_fetch::WebFetchTool;
pub use write_file::WriteFileTool;
