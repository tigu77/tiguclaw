//! Tool trait — abstraction over executable tools the agent can invoke.

use async_trait::async_trait;
use crate::error::Result;

/// A tool that the agent can call during the agentic loop.
#[async_trait]
pub trait Tool: Send + Sync {
    /// Unique tool name (must match what the provider sees).
    fn name(&self) -> &str;

    /// Human-readable description for the LLM.
    fn description(&self) -> &str;

    /// JSON Schema describing the tool's input parameters.
    fn schema(&self) -> serde_json::Value;

    /// Execute the tool with the given JSON arguments, returning a text result.
    async fn execute(
        &self,
        args: &std::collections::HashMap<String, serde_json::Value>,
    ) -> Result<String>;
}
