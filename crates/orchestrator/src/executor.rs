//! Executor — Phase를 실행하고 결과 문자열을 반환한다.
//!
//! 현재는 placeholder 구현. 추후 T1 에이전트 위임으로 교체 예정.

use std::sync::Arc;

use anyhow::Result;
use tracing::info;

use tiguclaw_core::provider::Provider;
use tiguclaw_core::types::ChatMessage;
use tiguclaw_goal::types::Phase;

/// Phase를 실행하고 결과를 반환한다.
pub struct PhaseExecutor {
    provider: Arc<dyn Provider>,
}

impl PhaseExecutor {
    pub fn new(provider: Arc<dyn Provider>) -> Self {
        Self { provider }
    }

    /// Phase를 실행한다.
    ///
    /// 현재 구현: LLM에게 Phase 완료를 시뮬레이션하도록 요청한다.
    /// TODO: 실제 shell 실행 또는 T1 에이전트 위임으로 교체
    pub async fn execute(&self, phase: &Phase) -> Result<String> {
        info!("Executing phase: {}", phase.description);

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
