//! TierProvider — tier1/tier2 escalation-based routing with fallback chains.
//!
//! Routing logic:
//! - All requests → tier1 (fast, cost-effective)
//! - tier1 calls `escalate_to_tier2` tool → tier2 handles the full request
//!
//! Escalation conditions (injected into tier1 system prompt):
//! - 복잡한 설계 결정이나 아키텍처 판단이 필요한 경우
//! - 여러 트레이드오프를 깊이 분석해야 하는 경우
//! - 자신이 틀릴 가능성이 높다고 판단되는 경우
//!
//! Fallback logic:
//! - Each tier has a Vec of providers (primary + fallbacks).
//! - On error, the next provider in the chain is tried.
//! - All providers exhausted → last error returned.

use async_trait::async_trait;
use serde_json::json;
use tracing::{info, warn};

use tiguclaw_core::error::Result;
use tiguclaw_core::provider::{Provider, ThinkingLevel, ToolDefinition};
use tiguclaw_core::types::*;

use crate::AnthropicProvider;

/// Instructions injected into tier1 system prompt to guide escalation decisions.
const TIER1_ESCALATION_INSTRUCTIONS: &str = "\
## Escalation

You have access to `escalate_to_tier2` tool. Call it when:
- 복잡한 설계 결정이나 아키텍처 판단이 필요한 경우
- 여러 트레이드오프를 깊이 분석해야 하는 경우
- 자신이 틀릴 가능성이 높다고 판단되는 경우

When escalating, provide a clear `reason`. Do not mix escalation with other tool calls.";

/// Tool definition for escalation, injected into tier1 calls.
fn escalate_tool_definition() -> ToolDefinition {
    ToolDefinition {
        name: "escalate_to_tier2".into(),
        description: "Escalate this request to a more capable model (tier2). \
            Use when the request requires deep architectural judgment, complex tradeoff analysis, \
            or when you are uncertain about correctness.".into(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "reason": {
                    "type": "string",
                    "description": "Why escalation is needed (brief explanation)"
                }
            },
            "required": ["reason"]
        }),
    }
}

/// Tier-based provider that routes via escalation.
/// tier1 (normal) handles all requests; escalates to tier2 (deep) when needed.
///
/// `chat_with_options(ThinkingLevel::Deep)` bypasses escalation and sends
/// directly to the deep (tier2) model with adaptive thinking enabled.
pub struct TierProvider {
    tier1: Vec<AnthropicProvider>,
    tier2: Vec<AnthropicProvider>,
}

impl TierProvider {
    /// Create a new tier provider from two fallback chains.
    pub fn new(tier1: Vec<AnthropicProvider>, tier2: Vec<AnthropicProvider>) -> Self {
        Self { tier1, tier2 }
    }

    /// Create from a core config provider section.
    ///
    /// tier1 (normal_models / tier1 fallback):
    ///   - ThinkingMode::Off (빠른 응답)
    ///
    /// tier2 (deep_models / tier2 fallback):
    ///   - 항상 ThinkingMode::Adaptive + effort "high" (Deep Thinking 전용)
    ///
    /// config의 `thinking = "adaptive"` 설정은 더 이상 tier1/tier2 구분에 사용되지 않고,
    /// `chat_with_options(ThinkingLevel::Deep)` 호출 시 tier2가 활성화된다.
    pub fn from_config(cfg: &tiguclaw_core::config::ProviderConfig) -> Self {
        use crate::anthropic::ThinkingMode;

        let build_chain =
            |models: &[String], thinking: ThinkingMode, effort: Option<String>| -> Vec<AnthropicProvider> {
                models
                    .iter()
                    .map(|model| {
                        AnthropicProvider::with_thinking(
                            cfg.api_key.clone(),
                            model.clone(),
                            cfg.max_tokens,
                            thinking,
                            effort.clone(),
                        )
                    })
                    .collect()
            };

        let normal_models = cfg.tiers.get_normal_models();
        let deep_models = cfg.tiers.get_deep_models();

        Self::new(
            build_chain(normal_models, ThinkingMode::Off, None),
            build_chain(deep_models, ThinkingMode::Adaptive, Some("high".into())),
        )
    }

    /// Inject tier1 escalation instructions into the system message.
    /// If no system message exists, prepend one.
    fn inject_escalation_instructions(messages: &[ChatMessage]) -> Vec<ChatMessage> {
        let mut result = Vec::with_capacity(messages.len());
        let mut injected = false;

        for msg in messages {
            if msg.role == Role::System && !injected {
                let mut new_msg = msg.clone();
                new_msg.content.push_str("\n\n");
                new_msg.content.push_str(TIER1_ESCALATION_INSTRUCTIONS);
                result.push(new_msg);
                injected = true;
            } else {
                result.push(msg.clone());
            }
        }

        if !injected {
            result.insert(0, ChatMessage::system(TIER1_ESCALATION_INSTRUCTIONS));
        }

        result
    }
}

/// Try each provider in order; return the first success or the last error.
async fn chat_with_fallback(
    providers: &[AnthropicProvider],
    messages: &[ChatMessage],
    tools: &[ToolDefinition],
) -> Result<ChatResponse> {
    let mut last_err = None;
    for (i, provider) in providers.iter().enumerate() {
        match provider.chat(messages, tools).await {
            Ok(response) => {
                if i > 0 {
                    info!(model = provider.name(), "fallback succeeded");
                }
                return Ok(response);
            }
            Err(e) => {
                warn!(
                    model = provider.name(),
                    error = %e,
                    remaining = providers.len() - i - 1,
                    "provider failed, trying fallback"
                );
                last_err = Some(e);
            }
        }
    }
    Err(last_err.expect("providers list must not be empty"))
}

#[async_trait]
impl Provider for TierProvider {
    fn name(&self) -> &str {
        "anthropic-tier"
    }

    /// `ThinkingLevel::Deep` → tier2 (deep_models) + adaptive thinking으로 직접 전달.
    /// `ThinkingLevel::Normal` → 기존 tier1 escalation 흐름.
    async fn chat_with_options(
        &self,
        messages: &[ChatMessage],
        tools: &[ToolDefinition],
        thinking: ThinkingLevel,
    ) -> Result<ChatResponse> {
        match thinking {
            ThinkingLevel::Deep => {
                info!(
                    model = self.tier2.first().map(|p| p.name()).unwrap_or("none"),
                    "Deep Thinking 모드: tier2 직접 호출"
                );
                chat_with_fallback(&self.tier2, messages, tools).await
            }
            ThinkingLevel::Normal => self.chat(messages, tools).await,
        }
    }

    async fn chat(
        &self,
        messages: &[ChatMessage],
        tools: &[ToolDefinition],
    ) -> Result<ChatResponse> {
        // Build tier1 tool list with escalation tool injected.
        let mut tier1_tools = tools.to_vec();
        tier1_tools.push(escalate_tool_definition());

        // Inject escalation instructions into system message for tier1.
        let tier1_messages = Self::inject_escalation_instructions(messages);

        info!(
            model = self.tier1.first().map(|p| p.name()).unwrap_or("none"),
            fallbacks = self.tier1.len().saturating_sub(1),
            "tier1 handling request"
        );

        // Call tier1.
        let tier1_response = chat_with_fallback(&self.tier1, &tier1_messages, &tier1_tools).await?;

        // Check if tier1 wants to escalate.
        let escalation = tier1_response
            .tool_calls
            .iter()
            .find(|tc| tc.name == "escalate_to_tier2");

        if let Some(esc) = escalation {
            let reason = esc
                .args
                .get("reason")
                .and_then(|v| v.as_str())
                .unwrap_or("complex request");

            info!(
                reason,
                model = self.tier2.first().map(|p| p.name()).unwrap_or("none"),
                fallbacks = self.tier2.len().saturating_sub(1),
                "tier1 escalating to tier2"
            );

            // Call tier2 with original messages and tools (no escalation tool).
            chat_with_fallback(&self.tier2, messages, tools).await
        } else {
            // tier1 handled it — return response as-is.
            Ok(tier1_response)
        }
    }
}

// ── Backward compatibility aliases ───────────────────────────────────────────
// Keep CascadeProvider as a type alias so existing references compile.
pub type CascadeProvider = TierProvider;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_inject_escalation_instructions_appends_to_system() {
        let messages = vec![
            ChatMessage::system("You are a bot."),
            ChatMessage::user("help"),
        ];
        let result = TierProvider::inject_escalation_instructions(&messages);
        assert_eq!(result.len(), 2);
        assert!(result[0].content.contains("You are a bot."));
        assert!(result[0].content.contains("escalate_to_tier2"));
        assert_eq!(result[1].content, "help");
    }

    #[test]
    fn test_inject_escalation_instructions_no_system() {
        let messages = vec![ChatMessage::user("hello")];
        let result = TierProvider::inject_escalation_instructions(&messages);
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].role, Role::System);
        assert!(result[0].content.contains("escalate_to_tier2"));
        assert_eq!(result[1].content, "hello");
    }

    #[test]
    fn test_inject_escalation_instructions_only_first_system() {
        let messages = vec![
            ChatMessage::system("System 1."),
            ChatMessage::user("question"),
            ChatMessage::system("System 2."),
        ];
        let result = TierProvider::inject_escalation_instructions(&messages);
        assert_eq!(result.len(), 3);
        assert!(result[0].content.contains("escalate_to_tier2"));
        // Second system message should NOT be modified
        assert_eq!(result[2].content, "System 2.");
    }

    #[test]
    fn test_escalate_tool_definition() {
        let tool = escalate_tool_definition();
        assert_eq!(tool.name, "escalate_to_tier2");
        assert!(tool.input_schema["properties"]["reason"].is_object());
        assert_eq!(tool.input_schema["required"][0], "reason");
    }

    #[test]
    fn test_tier_provider_new() {
        let make = |model: &str| AnthropicProvider::new("key".into(), model.into(), 1024);
        let provider = TierProvider::new(
            vec![make("sonnet")],
            vec![make("opus"), make("sonnet")],
        );
        assert_eq!(provider.tier1.len(), 1);
        assert_eq!(provider.tier2.len(), 2);
        assert_eq!(provider.name(), "anthropic-tier");
    }

    #[test]
    fn test_from_config_builds_chains() {
        let cfg = tiguclaw_core::config::ProviderConfig {
            api_key: "test-key".into(),
            max_tokens: 2048,
            tiers: tiguclaw_core::config::TiersConfig {
                tier1: vec!["sonnet".into()],
                tier2: vec!["opus".into(), "sonnet".into()],
                normal_models: vec![],
                deep_models: vec![],
            },
            thinking: "off".into(),
        };
        let provider = TierProvider::from_config(&cfg);
        assert_eq!(provider.tier1.len(), 1);
        assert_eq!(provider.tier2.len(), 2);
        assert_eq!(provider.tier1[0].name(), "sonnet");
        assert_eq!(provider.tier2[0].name(), "opus");
        assert_eq!(provider.tier2[1].name(), "sonnet");
    }

    #[test]
    fn test_from_config_new_model_fields() {
        let cfg = tiguclaw_core::config::ProviderConfig {
            api_key: "test-key".into(),
            max_tokens: 4096,
            tiers: tiguclaw_core::config::TiersConfig {
                tier1: vec!["old-sonnet".into()],
                tier2: vec!["old-opus".into()],
                normal_models: vec!["new-sonnet".into()],
                deep_models: vec!["new-opus".into()],
            },
            thinking: "off".into(),
        };
        let provider = TierProvider::from_config(&cfg);
        // normal_models takes priority over tier1
        assert_eq!(provider.tier1[0].name(), "new-sonnet");
        // deep_models takes priority over tier2
        assert_eq!(provider.tier2[0].name(), "new-opus");
    }

    #[test]
    fn test_from_config_deep_thinking_always_adaptive() {
        let cfg = tiguclaw_core::config::ProviderConfig {
            api_key: "test-key".into(),
            max_tokens: 4096,
            tiers: tiguclaw_core::config::TiersConfig {
                tier1: vec!["sonnet".into()],
                tier2: vec!["opus".into()],
                normal_models: vec![],
                deep_models: vec![],
            },
            thinking: "off".into(),
        };
        let provider = TierProvider::from_config(&cfg);
        // tier1 → Off, tier2 → always Adaptive (Deep Thinking 전용)
        assert_eq!(provider.tier1[0].thinking_mode(), crate::ThinkingMode::Off);
        assert_eq!(provider.tier2[0].thinking_mode(), crate::ThinkingMode::Adaptive);
    }

    #[test]
    fn test_cascade_provider_alias() {
        // CascadeProvider is a type alias for TierProvider — verify compilation.
        fn _assert_provider<T: Provider>() {}
        _assert_provider::<CascadeProvider>();
    }

    #[test]
    fn test_tier_provider_implements_provider_trait() {
        fn _assert_provider<T: Provider>() {}
        _assert_provider::<TierProvider>();
    }
}
