//! OAuth token utilities for Claude Code protocol compliance.
//!
//! When using OAuth tokens (`sk-ant-oat01-…`), the Anthropic API requires
//! requests to follow the Claude Code protocol: specific beta headers,
//! user-agent, system prompt format, and tool name mapping.

/// Claude CLI version to report in user-agent.
pub const CLAUDE_CODE_VERSION: &str = "2.1.62";

/// Beta features required for OAuth token authentication.
pub const OAUTH_BETA: &str =
    "claude-code-20250219,oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14";

/// Claude Code identity system prompt (must be the first system block).
pub const CLAUDE_CODE_IDENTITY: &str =
    "You are Claude Code, Anthropic's official CLI for Claude.";

/// Check whether the given API key is an OAuth token.
pub fn is_oauth_token(api_key: &str) -> bool {
    api_key.starts_with("sk-ant-oat")
}

/// Map internal tool names to Claude Code standard names.
///
/// Unknown names pass through unchanged.
pub fn to_claude_code_name(name: &str) -> &str {
    match name {
        "shell" => "Bash",
        "read_file" => "Read",
        "write_file" => "Write",
        "edit_file" => "Edit",
        "web_fetch" => "WebFetch",
        _ => name,
    }
}

/// Map Claude Code standard tool names back to internal names.
///
/// Unknown names pass through unchanged.
pub fn from_claude_code_name(name: &str) -> &str {
    match name {
        "Bash" => "shell",
        "Read" => "read_file",
        "Write" => "write_file",
        "Edit" => "edit_file",
        "WebFetch" => "web_fetch",
        _ => name,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_oauth_token() {
        assert!(is_oauth_token("sk-ant-oat01-abc123"));
        assert!(!is_oauth_token("sk-ant-api03-xyz789"));
        assert!(!is_oauth_token("some-random-key"));
    }

    #[test]
    fn test_to_claude_code_name() {
        assert_eq!(to_claude_code_name("shell"), "Bash");
        assert_eq!(to_claude_code_name("read_file"), "Read");
        assert_eq!(to_claude_code_name("write_file"), "Write");
        assert_eq!(to_claude_code_name("edit_file"), "Edit");
        assert_eq!(to_claude_code_name("web_fetch"), "WebFetch");
        assert_eq!(to_claude_code_name("unknown_tool"), "unknown_tool");
    }

    #[test]
    fn test_from_claude_code_name() {
        assert_eq!(from_claude_code_name("Bash"), "shell");
        assert_eq!(from_claude_code_name("Read"), "read_file");
        assert_eq!(from_claude_code_name("Write"), "write_file");
        assert_eq!(from_claude_code_name("Edit"), "edit_file");
        assert_eq!(from_claude_code_name("WebFetch"), "web_fetch");
        assert_eq!(from_claude_code_name("SomethingElse"), "SomethingElse");
    }

    #[test]
    fn test_roundtrip() {
        let names = ["shell", "read_file", "write_file", "edit_file", "web_fetch"];
        for name in names {
            assert_eq!(from_claude_code_name(to_claude_code_name(name)), name);
        }
    }
}
