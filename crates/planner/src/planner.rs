//! LlmPlanner — LLM을 이용해 Goal을 Phase 목록으로 분해한다.

use std::sync::Arc;

use anyhow::{anyhow, Context, Result};
use serde::Deserialize;
use tracing::{debug, warn};

use tiguclaw_core::provider::Provider;
use tiguclaw_core::types::ChatMessage;
use tiguclaw_goal::types::{Goal, Phase};

// ─── Response types ───────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct PlanResponse {
    phases: Vec<PhaseSpec>,
}

#[derive(Debug, Deserialize)]
struct PhaseSpec {
    description: String,
    #[allow(dead_code)]
    expected_output: Option<String>,
}

// ─── LlmPlanner ──────────────────────────────────────────────────────────────

/// LLM을 이용해 Goal 설명을 실행 가능한 Phase 목록으로 분해한다.
pub struct LlmPlanner {
    provider: Arc<dyn Provider>,
}

impl LlmPlanner {
    pub fn new(provider: Arc<dyn Provider>) -> Self {
        Self { provider }
    }

    /// Goal 설명을 받아 Phase 목록을 반환한다.
    pub async fn plan(&self, goal_description: &str) -> Result<Vec<Phase>> {
        let prompt = format!(
            r#"You are a task planner. Break down the following goal into concrete, executable phases.
Goal: {goal_description}

Return JSON only (no markdown, no explanation):
{{
  "phases": [
    {{"description": "...", "expected_output": "..."}},
    ...
  ]
}}

Rules:
- Max 5 phases
- Each phase must be independently verifiable
- Phases are sequential
- Be specific and actionable"#
        );

        let messages = vec![ChatMessage::user(prompt)];
        let response = self
            .provider
            .chat(&messages, &[])
            .await
            .context("LLM chat failed in plan()")?;

        let content = response.text.trim();
        debug!("plan() raw response: {}", content);

        let parsed = parse_plan_response(content)
            .context("Failed to parse plan response as JSON")?;

        if parsed.is_empty() {
            return Err(anyhow!("Planner returned empty phase list"));
        }

        Ok(parsed)
    }

    /// 실패 피드백을 반영해서 재계획한다.
    pub async fn replan(&self, goal: &Goal, feedback: &str) -> Result<Vec<Phase>> {
        let completed_phases: Vec<String> = goal
            .phases
            .iter()
            .filter(|p| matches!(p.status, tiguclaw_goal::types::PhaseStatus::Completed))
            .map(|p| format!("- {}", p.description))
            .collect();

        let failed_phases: Vec<String> = goal
            .phases
            .iter()
            .filter(|p| matches!(p.status, tiguclaw_goal::types::PhaseStatus::Failed { .. }))
            .map(|p| format!("- {}", p.description))
            .collect();

        let prompt = format!(
            r#"You are a task planner. A goal has partially failed and needs replanning.

Goal: {goal_description}

Completed phases:
{completed}

Failed phases:
{failed}

Failure feedback: {feedback}

Return a new plan as JSON only (no markdown, no explanation):
{{
  "phases": [
    {{"description": "...", "expected_output": "..."}},
    ...
  ]
}}

Rules:
- Max 5 phases total
- Skip already completed work
- Address the failure reason
- Each phase must be independently verifiable
- Phases are sequential"#,
            goal_description = goal.description,
            completed = if completed_phases.is_empty() {
                "(none)".to_string()
            } else {
                completed_phases.join("\n")
            },
            failed = if failed_phases.is_empty() {
                "(none)".to_string()
            } else {
                failed_phases.join("\n")
            },
        );

        let messages = vec![ChatMessage::user(prompt)];
        let response = self
            .provider
            .chat(&messages, &[])
            .await
            .context("LLM chat failed in replan()")?;

        let content = response.text.trim();
        debug!("replan() raw response: {}", content);

        let parsed = parse_plan_response(content)
            .context("Failed to parse replan response as JSON")?;

        if parsed.is_empty() {
            warn!("replan() returned empty phase list, falling back to single retry phase");
            return Ok(vec![Phase::new(format!(
                "Retry goal: {} (addressing: {})",
                goal.description, feedback
            ))]);
        }

        Ok(parsed)
    }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/// JSON 문자열을 파싱해서 Phase 벡터를 반환한다.
/// LLM이 ```json ... ``` 블록으로 감싸서 응답하는 경우도 처리한다.
fn parse_plan_response(content: &str) -> Result<Vec<Phase>> {
    // 마크다운 코드 블록 제거
    let json_str = strip_markdown_fences(content);

    let plan: PlanResponse = serde_json::from_str(json_str)
        .with_context(|| format!("JSON parse error. Content: {}", json_str))?;

    let phases = plan
        .phases
        .into_iter()
        .map(|spec| Phase::new(spec.description))
        .collect();

    Ok(phases)
}

fn strip_markdown_fences(s: &str) -> &str {
    let s = s.trim();
    // ```json ... ``` or ``` ... ```
    if s.starts_with("```") {
        let after_fence = s.trim_start_matches('`');
        // skip language tag (e.g. "json\n")
        let after_lang = after_fence
            .find('\n')
            .map(|i| &after_fence[i + 1..])
            .unwrap_or(after_fence);
        // strip trailing ```
        let stripped = after_lang
            .rfind("```")
            .map(|i| after_lang[..i].trim())
            .unwrap_or(after_lang.trim());
        stripped
    } else {
        s
    }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_strip_markdown_fences() {
        let input = "```json\n{\"phases\":[]}\n```";
        assert_eq!(strip_markdown_fences(input), "{\"phases\":[]}");
    }

    #[test]
    fn test_parse_plan_response_valid() {
        let json = r#"{"phases":[{"description":"Step 1","expected_output":"done"}]}"#;
        let phases = parse_plan_response(json).unwrap();
        assert_eq!(phases.len(), 1);
        assert_eq!(phases[0].description, "Step 1");
    }

    #[test]
    fn test_parse_plan_response_with_fence() {
        let json = "```json\n{\"phases\":[{\"description\":\"Step A\",\"expected_output\":\"ok\"}]}\n```";
        let phases = parse_plan_response(json).unwrap();
        assert_eq!(phases.len(), 1);
    }
}
