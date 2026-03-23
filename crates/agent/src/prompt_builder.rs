//! System prompt assembler — combines base prompt, workspace context,
//! skills, and extra sections into a single system prompt string.

/// Assembles system prompt sections in a defined order.
pub struct PromptBuilder {
    base_prompt: String,
    workspace_context: Option<String>,
    skills_section: Option<String>,
    extra_sections: Vec<String>,
}

impl PromptBuilder {
    /// Create a new builder with the base system prompt.
    pub fn new(base_prompt: String) -> Self {
        Self {
            base_prompt,
            workspace_context: None,
            skills_section: None,
            extra_sections: Vec::new(),
        }
    }

    /// Add workspace context (SOUL.md, USER.md, etc.).
    pub fn with_workspace(mut self, context: String) -> Self {
        if !context.is_empty() {
            self.workspace_context = Some(context);
        }
        self
    }

    /// Add the available_skills XML section.
    pub fn with_skills(mut self, xml: String) -> Self {
        if !xml.is_empty() {
            self.skills_section = Some(xml);
        }
        self
    }

    /// Add an arbitrary extra section.
    pub fn with_section(mut self, section: String) -> Self {
        if !section.is_empty() {
            self.extra_sections.push(section);
        }
        self
    }

    /// Inject the universal agent principles section.
    ///
    /// Principles cover uncertainty handling, fact-checking, and communication
    /// guidelines that apply to every agent (T0/T1/T2).
    /// Order position: after skills, before extra sections.
    pub fn with_agent_principles(self) -> Self {
        let principles = "\
## 에이전트 공통 행동 원칙

### 불확실성 처리
- 태스크가 불명확하거나 범위가 모호하면 추측으로 실행하지 말고, 먼저 clarification을 요청하라.
- 확인되지 않은 정보는 절대 지어내지 마라. 모르면 \"확인 필요\"라고 명시하라.
- 결과가 불완전하거나 중간에 끊어졌으면 \"결과 불완전\"이라고 정직하게 보고하라.

### 정보 확인 우선
- 현황 파악이나 상태 보고 시 반드시 shell 툴이나 파일 읽기로 실제 확인 후 보고하라.
- 기억이나 이전 컨텍스트에만 의존하지 마라. 항상 실제 상태를 확인하라.

### 커뮤니케이션
- 작업 완료 후 결과를 명확하게 요약해서 보고하라.
- 에러나 실패 시 원인과 함께 보고하고, 해결 방법을 제안하라.";
        self.with_section(principles.to_string())
    }

    /// Build the final system prompt string.
    ///
    /// Order: base → workspace → skills → extras (including agent_principles).
    pub fn build(self) -> String {
        let mut parts = vec![self.base_prompt];

        if let Some(ws) = self.workspace_context {
            parts.push(ws);
        }
        if let Some(sk) = self.skills_section {
            parts.push(sk);
        }
        for extra in self.extra_sections {
            parts.push(extra);
        }

        parts.join("\n\n")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_base_only() {
        let prompt = PromptBuilder::new("You are a bot.".into()).build();
        assert_eq!(prompt, "You are a bot.");
    }

    #[test]
    fn test_build_full() {
        let prompt = PromptBuilder::new("Base prompt.".into())
            .with_workspace("## SOUL.md\nI am soul.".into())
            .with_skills("<available_skills>...</available_skills>".into())
            .with_section("Extra info.".into())
            .build();

        assert!(prompt.starts_with("Base prompt."));
        // Check order: workspace before skills before extra
        let ws_pos = prompt.find("SOUL.md").unwrap();
        let sk_pos = prompt.find("available_skills").unwrap();
        let ex_pos = prompt.find("Extra info").unwrap();
        assert!(ws_pos < sk_pos);
        assert!(sk_pos < ex_pos);
    }

    #[test]
    fn test_with_agent_principles() {
        let prompt = PromptBuilder::new("Base.".into())
            .with_workspace("Workspace.".into())
            .with_skills("<skills/>".into())
            .with_agent_principles()
            .with_section("Extra.".into())
            .build();

        // Principles should appear before Extra
        let principles_pos = prompt.find("에이전트 공통 행동 원칙").unwrap();
        let extra_pos = prompt.find("Extra.").unwrap();
        assert!(principles_pos < extra_pos);
        // Principles content check
        assert!(prompt.contains("불확실성 처리"));
        assert!(prompt.contains("정보 확인 우선"));
        assert!(prompt.contains("커뮤니케이션"));
    }

    #[test]
    fn test_empty_sections_skipped() {
        let prompt = PromptBuilder::new("Base.".into())
            .with_workspace(String::new())
            .with_skills(String::new())
            .with_section(String::new())
            .build();

        assert_eq!(prompt, "Base.");
    }

    #[test]
    fn test_multiple_extras() {
        let prompt = PromptBuilder::new("Base.".into())
            .with_section("Section A".into())
            .with_section("Section B".into())
            .build();

        assert!(prompt.contains("Section A"));
        assert!(prompt.contains("Section B"));
        let a_pos = prompt.find("Section A").unwrap();
        let b_pos = prompt.find("Section B").unwrap();
        assert!(a_pos < b_pos);
    }
}
