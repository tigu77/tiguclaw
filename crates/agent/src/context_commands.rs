//! Slash command parser for named context operations (save/load/list/delete).

/// Parsed context command from user input.
#[derive(Debug, PartialEq)]
pub enum ContextCommand {
    /// /save <name> — save current history as a named context
    Save(String),
    /// /save (no name) — auto-generate name from conversation context
    SaveAuto,
    /// /load <name> — load a named context, replacing current history
    Load(String),
    /// /list — list all saved contexts
    List,
    /// /delete <name> — delete a named context
    Delete(String),
    /// /new [name] — save current context then start fresh
    New(Option<String>),
    /// /contexts — list saved contexts in recent-first order
    Contexts,
    /// /spawn <label> <task> — spawn a sub-agent
    Spawn { label: String, task: String },
    /// /agents — list active sub-agents
    Agents,
    /// /steer <label> <message> — redirect a sub-agent
    Steer { label: String, message: String },
    /// /kill <label> — terminate a sub-agent
    Kill(String),
    /// /status — show bot status
    Status,
    /// /cancel — cancel current task
    Cancel,
    /// /stop — cancel current task AND kill all sub-agents (cascade stop)
    StopAll,
    /// /specs — list available agent specs (folder-based, new)
    AgentSpecs,
    /// /templates — list available agent templates (deprecated, alias for /specs)
    Templates,
    /// /reset — clear conversation history (also triggered by Korean keywords)
    Reset,
    /// /goal <description> — run a goal through plan→execute→validate loop
    Goal(String),
    /// Not a context command — pass through to LLM
    None,
}

/// Parse a message for context slash commands.
///
/// Commands are case-insensitive and whitespace-trimmed.
/// Commands that require an argument (/save, /load, /delete) return `None`
/// if the argument is missing.
pub fn parse_command(text: &str) -> ContextCommand {
    let trimmed = text.trim();

    // Split into command and argument parts.
    let mut parts = trimmed.splitn(2, char::is_whitespace);
    let cmd = parts.next().unwrap_or("").to_lowercase();
    let arg = parts.next().map(|s| s.trim().to_string());

    match cmd.as_str() {
        "/save" => match arg {
            Some(name) if !name.is_empty() => ContextCommand::Save(name),
            _ => ContextCommand::SaveAuto,
        },
        "/load" => match arg {
            Some(name) if !name.is_empty() => ContextCommand::Load(name),
            _ => ContextCommand::None,
        },
        "/list" => ContextCommand::List,
        "/delete" => match arg {
            Some(name) if !name.is_empty() => ContextCommand::Delete(name),
            _ => ContextCommand::None,
        },
        "/new" => match arg {
            Some(name) if !name.is_empty() => ContextCommand::New(Some(name)),
            _ => ContextCommand::New(None),
        },
        "/contexts" => ContextCommand::Contexts,
        "/spawn" => match arg {
            Some(rest) if !rest.is_empty() => {
                let mut parts = rest.splitn(2, char::is_whitespace);
                let label = parts.next().unwrap().to_string();
                let task = parts.next().map(|s| s.trim().to_string());
                match task {
                    Some(t) if !t.is_empty() => ContextCommand::Spawn { label, task: t },
                    _ => ContextCommand::None,
                }
            }
            _ => ContextCommand::None,
        },
        "/agents" => ContextCommand::Agents,
        "/steer" => match arg {
            Some(rest) if !rest.is_empty() => {
                let mut parts = rest.splitn(2, char::is_whitespace);
                let label = parts.next().unwrap().to_string();
                let message = parts.next().map(|s| s.trim().to_string());
                match message {
                    Some(m) if !m.is_empty() => ContextCommand::Steer { label, message: m },
                    _ => ContextCommand::None,
                }
            }
            _ => ContextCommand::None,
        },
        "/kill" => match arg {
            Some(name) if !name.is_empty() => ContextCommand::Kill(name),
            _ => ContextCommand::None,
        },
        "/status" => ContextCommand::Status,
        "/cancel" => ContextCommand::Cancel,
        "/stop" => ContextCommand::StopAll,
        "/specs" => ContextCommand::AgentSpecs,
        "/templates" => ContextCommand::Templates,
        "/reset" | "/clear" => ContextCommand::Reset,
        "/goal" => match arg {
            Some(desc) if !desc.is_empty() => ContextCommand::Goal(desc),
            _ => ContextCommand::None,
        },
        _ => {
            // Korean reset keywords (exact match on full trimmed text).
            let full = trimmed.to_lowercase();
            if matches!(
                full.as_str(),
                "리셋" | "컨텍스트 초기화" | "대화 초기화" | "히스토리 초기화"
            ) {
                ContextCommand::Reset
            } else if matches!(full.as_str(), "멈춰" | "중단" | "전부 멈춰" | "다 멈춰") {
                ContextCommand::StopAll
            } else {
                ContextCommand::None
            }
        }
    }
}

/// Check if a message is a context command that's missing its required argument.
/// Returns an error message if so, None otherwise.
pub fn missing_arg_message(text: &str) -> Option<String> {
    let trimmed = text.trim();
    let mut parts = trimmed.splitn(2, char::is_whitespace);
    let cmd = parts.next().unwrap_or("").to_lowercase();
    let arg = parts.next().map(|s| s.trim().to_string());
    let has_arg = arg.is_some_and(|a| !a.is_empty());

    match cmd.as_str() {
        // /save without arg is valid (auto-name mode), so no error
        "/load" if !has_arg => Some("⚠️ 사용법: /load <이름>".to_string()),
        "/delete" if !has_arg => Some("⚠️ 사용법: /delete <이름>".to_string()),
        "/spawn" if !has_arg => Some("⚠️ 사용법: /spawn <라벨> <작업>".to_string()),
        "/steer" if !has_arg => Some("⚠️ 사용법: /steer <라벨> <메시지>".to_string()),
        "/kill" if !has_arg => Some("⚠️ 사용법: /kill <라벨>".to_string()),
        "/goal" if !has_arg => Some("⚠️ 사용법: /goal <목표 설명>".to_string()),
        _ => Option::None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_save_command() {
        assert_eq!(
            parse_command("/save my-context"),
            ContextCommand::Save("my-context".into())
        );
        assert_eq!(
            parse_command("  /SAVE  My Context  "),
            ContextCommand::Save("My Context".into())
        );
    }

    #[test]
    fn test_load_command() {
        assert_eq!(
            parse_command("/load my-context"),
            ContextCommand::Load("my-context".into())
        );
        assert_eq!(
            parse_command("/Load test"),
            ContextCommand::Load("test".into())
        );
    }

    #[test]
    fn test_list_command() {
        assert_eq!(parse_command("/list"), ContextCommand::List);
        assert_eq!(parse_command("  /LIST  "), ContextCommand::List);
    }

    #[test]
    fn test_delete_command() {
        assert_eq!(
            parse_command("/delete old-ctx"),
            ContextCommand::Delete("old-ctx".into())
        );
    }

    #[test]
    fn test_normal_message() {
        assert_eq!(parse_command("hello world"), ContextCommand::None);
        assert_eq!(parse_command("what is /save?"), ContextCommand::None);
        assert_eq!(parse_command(""), ContextCommand::None);
    }

    #[test]
    fn test_missing_argument_returns_none() {
        // /save without name now returns SaveAuto (auto-name mode)
        assert_eq!(parse_command("/save"), ContextCommand::SaveAuto);
        assert_eq!(parse_command("/save   "), ContextCommand::SaveAuto);
        // Other commands still require their arg
        assert_eq!(parse_command("/load"), ContextCommand::None);
        assert_eq!(parse_command("/delete"), ContextCommand::None);
    }

    #[test]
    fn test_save_auto_command() {
        assert_eq!(parse_command("/save"), ContextCommand::SaveAuto);
        assert_eq!(parse_command("  /SAVE  "), ContextCommand::SaveAuto);
    }

    #[test]
    fn test_reset_command() {
        assert_eq!(parse_command("/reset"), ContextCommand::Reset);
        assert_eq!(parse_command("/clear"), ContextCommand::Reset);
        assert_eq!(parse_command("  /RESET  "), ContextCommand::Reset);
        assert_eq!(parse_command("리셋"), ContextCommand::Reset);
        assert_eq!(parse_command("컨텍스트 초기화"), ContextCommand::Reset);
        assert_eq!(parse_command("대화 초기화"), ContextCommand::Reset);
        assert_eq!(parse_command("히스토리 초기화"), ContextCommand::Reset);
        // Should NOT match partial text
        assert_eq!(parse_command("리셋해줘"), ContextCommand::None);
    }

    #[test]
    fn test_missing_arg_message() {
        assert!(missing_arg_message("/save").is_none()); // /save without arg is now valid (auto-name)
        assert!(missing_arg_message("/load").is_some());
        assert!(missing_arg_message("/delete").is_some());
        assert!(missing_arg_message("/spawn").is_some());
        assert!(missing_arg_message("/steer").is_some());
        assert!(missing_arg_message("/kill").is_some());
        assert!(missing_arg_message("/list").is_none());
        assert!(missing_arg_message("/agents").is_none());
        assert!(missing_arg_message("hello").is_none());
    }

    #[test]
    fn test_spawn_command() {
        assert_eq!(
            parse_command("/spawn worker do the thing"),
            ContextCommand::Spawn {
                label: "worker".into(),
                task: "do the thing".into(),
            }
        );
        // Missing task
        assert_eq!(parse_command("/spawn worker"), ContextCommand::None);
        // Missing both
        assert_eq!(parse_command("/spawn"), ContextCommand::None);
    }

    #[test]
    fn test_agents_command() {
        assert_eq!(parse_command("/agents"), ContextCommand::Agents);
        assert_eq!(parse_command("  /AGENTS  "), ContextCommand::Agents);
    }

    #[test]
    fn test_steer_command() {
        assert_eq!(
            parse_command("/steer worker change direction"),
            ContextCommand::Steer {
                label: "worker".into(),
                message: "change direction".into(),
            }
        );
        assert_eq!(parse_command("/steer worker"), ContextCommand::None);
        assert_eq!(parse_command("/steer"), ContextCommand::None);
    }

    #[test]
    fn test_kill_command() {
        assert_eq!(
            parse_command("/kill worker"),
            ContextCommand::Kill("worker".into())
        );
        assert_eq!(parse_command("/kill"), ContextCommand::None);
    }
}
