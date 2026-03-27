//! LlmValidator — Phase 실행 결과가 목표를 달성했는지 LLM으로 검증한다.

use std::sync::Arc;

use anyhow::{Context, Result};
use serde::Deserialize;
use tracing::debug;

use tiguclaw_core::provider::Provider;
use tiguclaw_core::types::ChatMessage;
use tiguclaw_goal::types::{Goal, Phase};

// ─── ValidationResult ────────────────────────────────────────────────────────

/// Phase 검증 결과.
#[derive(Debug, Clone)]
pub enum ValidationResult {
    /// 검증 통과 — Phase 목표 달성.
    Pass,
    /// 검증 실패.
    Fail {
        /// 실패 이유.
        reason: String,
        /// true이면 전체 계획을 재수립해야 함.
        should_replan: bool,
    },
}

impl ValidationResult {
    pub fn is_pass(&self) -> bool {
        matches!(self, ValidationResult::Pass)
    }

    pub fn is_fail(&self) -> bool {
        matches!(self, ValidationResult::Fail { .. })
    }
}

// ─── LLM response type ───────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct ValidateResponse {
    passed: bool,
    reason: Option<String>,
    should_replan: Option<bool>,
}

// ─── LlmValidator ────────────────────────────────────────────────────────────

/// LLM을 이용해 Phase 결과가 목표를 달성했는지 검증한다.
pub struct LlmValidator {
    provider: Arc<dyn Provider>,
}

impl LlmValidator {
    pub fn new(provider: Arc<dyn Provider>) -> Self {
        Self { provider }
    }

    /// Phase 결과(`result`)가 Goal 내 해당 Phase의 목표를 달성했는지 검증한다.
    pub async fn validate(
        &self,
        goal: &Goal,
        phase: &Phase,
        result: &str,
    ) -> Result<ValidationResult> {
        let prompt = format!(
            r#"You are a validation agent. Assess whether a phase result achieves its objective.

Overall Goal: {goal_description}
Current Phase: {phase_description}
Phase Result:
{result}

Return JSON only (no markdown, no explanation):
{{
  "passed": true|false,
  "reason": "brief explanation",
  "should_replan": true|false
}}

Rules:
- "passed": true only if the result clearly achieves the phase objective
- "reason": always provide a brief explanation
- "should_replan": true if the failure suggests the overall plan needs rethinking
  (false if it's a simple retry issue)"#,
            goal_description = goal.description,
            phase_description = phase.description,
        );

        let messages = vec![ChatMessage::user(prompt)];
        let response = self
            .provider
            .chat(&messages, &[])
            .await
            .context("LLM chat failed in validate()")?;

        let content = response.text.trim();
        debug!("validate() raw response: {}", content);

        let parsed = parse_validate_response(content)
            .context("Failed to parse validation response as JSON")?;

        if parsed.passed {
            Ok(ValidationResult::Pass)
        } else {
            Ok(ValidationResult::Fail {
                reason: parsed.reason.unwrap_or_else(|| "No reason provided".to_string()),
                should_replan: parsed.should_replan.unwrap_or(false),
            })
        }
    }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

fn parse_validate_response(content: &str) -> Result<ValidateResponse> {
    let json_str = strip_markdown_fences(content);
    serde_json::from_str(json_str)
        .with_context(|| format!("JSON parse error. Content: {}", json_str))
}

fn strip_markdown_fences(s: &str) -> &str {
    let s = s.trim();
    if s.starts_with("```") {
        let after_fence = s.trim_start_matches('`');
        let after_lang = after_fence
            .find('\n')
            .map(|i| &after_fence[i + 1..])
            .unwrap_or(after_fence);
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
    fn test_parse_validate_passed() {
        let json = r#"{"passed":true,"reason":"All checks passed","should_replan":false}"#;
        let r: ValidateResponse = serde_json::from_str(json).unwrap();
        assert!(r.passed);
    }

    #[test]
    fn test_parse_validate_failed_replan() {
        let json = r#"{"passed":false,"reason":"Wrong approach","should_replan":true}"#;
        let r: ValidateResponse = serde_json::from_str(json).unwrap();
        assert!(!r.passed);
        assert_eq!(r.should_replan, Some(true));
    }

    #[test]
    fn test_validation_result_helpers() {
        assert!(ValidationResult::Pass.is_pass());
        assert!(!ValidationResult::Pass.is_fail());

        let fail = ValidationResult::Fail {
            reason: "oops".to_string(),
            should_replan: false,
        };
        assert!(fail.is_fail());
        assert!(!fail.is_pass());
    }
}
