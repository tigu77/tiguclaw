//! Executor — Phase를 실행하고 결과 문자열을 반환한다.
//!
//! PhaseExecutor는 실제 tool (shell, write_file 등)을 사용해 Phase를 실행한다.
//! LLM에게 Phase 설명을 주고, tool call 루프를 돌려 실제 작업을 수행한다.

use std::sync::Arc;

use anyhow::Result;
use tracing::{debug, info, warn};

use tiguclaw_core::provider::{Provider, ToolDefinition};
use tiguclaw_core::tool::Tool;
use tiguclaw_core::types::{ChatMessage, ToolCall};

/// Phase를 실행하고 결과를 반환한다.
pub struct PhaseExecutor {
    provider: Arc<dyn Provider>,
    /// 실제 작업에 사용할 툴 목록 (shell, write_file 등).
    tools: Vec<Arc<dyn Tool>>,
}

impl PhaseExecutor {
    pub fn new(provider: Arc<dyn Provider>) -> Self {
        Self {
            provider,
            tools: vec![],
        }
    }

    /// 툴 목록을 주입한다.
    pub fn with_tools(mut self, tools: Vec<Arc<dyn Tool>>) -> Self {
        self.tools = tools;
        self
    }

    /// Phase를 실행한다.
    ///
    /// 툴이 있으면 LLM + tool call 루프로 실제 작업을 수행한다.
    /// 툴이 없으면 LLM 시뮬레이션으로 fallback한다.
    pub async fn execute(&self, phase: &tiguclaw_goal::types::Phase) -> Result<String> {
        info!("Executing phase: {}", phase.description);

        if self.tools.is_empty() {
            return self.simulate(phase).await;
        }

        self.execute_with_tools(phase).await
    }

    /// 실제 툴을 사용해 Phase를 실행하는 agentic loop.
    async fn execute_with_tools(&self, phase: &tiguclaw_goal::types::Phase) -> Result<String> {
        let system = "You are an autonomous executor agent. \
            Your job is to actually complete the given task using the tools available to you. \
            Use shell commands, file operations, and other tools to accomplish the task concretely. \
            Do NOT just describe what you would do — actually DO it. \
            When the task is complete, provide a brief summary of what was accomplished.";

        let user_msg = format!(
            "Execute the following task completely and return a result summary:\n\nTask: {}",
            phase.description
        );

        // 툴 정의 생성
        let tool_defs: Vec<ToolDefinition> = self
            .tools
            .iter()
            .map(|t| ToolDefinition {
                name: t.name().to_string(),
                description: t.description().to_string(),
                input_schema: t.schema(),
            })
            .collect();

        let mut history: Vec<ChatMessage> = vec![
            ChatMessage::system(system),
            ChatMessage::user(&user_msg),
        ];

        let max_iter = 10usize;
        let mut final_text = String::new();

        for iteration in 0..max_iter {
            debug!(iteration, "PhaseExecutor: calling provider");

            let response = self.provider.chat(&history, &tool_defs).await?;

            if response.tool_calls.is_empty() {
                // 최종 텍스트 응답
                final_text = response.text.trim().to_string();
                info!(iteration, "PhaseExecutor: phase complete, no more tool calls");
                break;
            }

            // tool call이 있으면 assistant message 히스토리에 추가
            let assistant_msg =
                ChatMessage::assistant_with_tools(&response.text, response.tool_calls.clone());
            history.push(assistant_msg);

            // 각 tool call 실행
            for tc in &response.tool_calls {
                info!(tool = %tc.name, id = %tc.id, "PhaseExecutor: executing tool");
                let result = execute_tool(&self.tools, tc).await;
                debug!(tool = %tc.name, result_len = result.len(), "tool result");

                let tool_msg = ChatMessage::tool_result(&tc.id, &result);
                history.push(tool_msg);
            }

            // 마지막 iteration에서 tool call이 여전히 있으면 루프 종료
            if iteration == max_iter - 1 {
                warn!("PhaseExecutor: max iterations reached");
                final_text = "Task execution reached iteration limit.".to_string();
            }
        }

        if final_text.is_empty() {
            final_text = "Phase executed (no summary returned).".to_string();
        }

        Ok(final_text)
    }

    /// 툴 없이 LLM 시뮬레이션 (fallback).
    async fn simulate(&self, phase: &tiguclaw_goal::types::Phase) -> Result<String> {
        let prompt = format!(
            r#"You are an AI executor. Simulate executing the following task and describe what was done.

Task: {}

Respond with a brief description of:
1. What actions were taken
2. The result/output
3. Any relevant details

Be concise (2-3 sentences max)."#,
            phase.description
        );

        let messages = vec![ChatMessage::user(prompt)];
        let response = self.provider.chat(&messages, &[]).await?;

        Ok(response.text.trim().to_string())
    }
}

/// tool call 하나를 실행하고 결과를 반환한다.
async fn execute_tool(tools: &[Arc<dyn Tool>], tc: &ToolCall) -> String {
    let tool = tools.iter().find(|t| t.name() == tc.name);
    match tool {
        Some(tool) => match tool.execute(&tc.args).await {
            Ok(result) => result,
            Err(e) => format!("Tool error: {e}"),
        },
        None => format!("Unknown tool: {}", tc.name),
    }
}
