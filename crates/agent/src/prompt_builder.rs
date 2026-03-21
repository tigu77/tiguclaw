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

    /// Build the final system prompt string.
    ///
    /// Order: base → workspace → skills → extras.
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
