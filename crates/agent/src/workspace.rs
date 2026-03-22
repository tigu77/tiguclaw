//! Workspace file loader — reads project context files and formats them
//! for injection into the system prompt.

use std::path::{Path, PathBuf};
use tracing::info;

/// Maximum file size to include (10 KB). Files exceeding this are truncated.
const MAX_FILE_BYTES: usize = 10 * 1024;

/// Core directive file — always loaded first if present.
const CORE_FILE: &str = "CORE.md";

/// Workspace files to inject, in order (after CORE.md).
const WORKSPACE_FILES: &[&str] = &[
    "SOUL.md",
    "USER.md",
    "IDENTITY.md",
    "AGENTS.md",
    "MEMORY.md",
    "HEARTBEAT.md",
    "TOOLS.md",
];

/// Loads workspace context files and formats them as a system prompt section.
pub struct WorkspaceLoader {
    workspace_dir: PathBuf,
}

impl WorkspaceLoader {
    pub fn new(workspace_dir: impl Into<PathBuf>) -> Self {
        Self {
            workspace_dir: workspace_dir.into(),
        }
    }

    /// Read all workspace files and format them as a prompt section.
    ///
    /// CORE.md is always loaded first (if present) as the top-priority directive.
    /// Returns an empty string if no files are found.
    pub fn load_context(&self) -> String {
        let mut sections = Vec::new();

        // Load CORE.md first — highest priority directive.
        match self.read_file(CORE_FILE) {
            Some(content) => {
                let trimmed = content.trim();
                if !trimmed.is_empty() {
                    let file_path = self.workspace_dir.join(CORE_FILE);
                    let display_path = file_path.display();
                    sections.push(format!("## {display_path}\n{trimmed}"));
                    info!(file = CORE_FILE, bytes = trimmed.len(), "loaded CORE.md (top-priority)");
                }
            }
            None => {
                tracing::warn!(
                    file = CORE_FILE,
                    workspace = %self.workspace_dir.display(),
                    "CORE.md not found — skipping (non-fatal)"
                );
            }
        }

        for &name in WORKSPACE_FILES {
            if let Some(content) = self.read_file(name) {
                let trimmed = content.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let file_path = self.workspace_dir.join(name);
                let display_path = file_path.display();
                sections.push(format!("## {display_path}\n{trimmed}"));
                info!(file = name, bytes = trimmed.len(), "loaded workspace file");
            }
        }

        if sections.is_empty() {
            return String::new();
        }

        let mut result = String::from(
            "## Project Context\nThe following project context files have been loaded:\n",
        );
        for section in sections {
            result.push('\n');
            result.push_str(&section);
        }
        result
    }

    /// clearance 파일 목록에 따라 워크스페이스 파일을 선별 로드한다.
    ///
    /// `files`에 포함된 파일만 순서대로 로드한다. 비어있으면 빈 문자열 반환.
    /// 기존 `load_context()`와 달리 CORE.md를 자동으로 먼저 로드하지 않는다.
    /// (파일 목록 순서 그대로 처리하므로, 목록에 CORE.md가 첫 번째에 있으면 자연히 먼저 로드됨.)
    pub fn load_context_with_clearance(&self, files: &[String]) -> String {
        if files.is_empty() {
            return String::new();
        }

        let mut sections = Vec::new();

        for name in files {
            if let Some(content) = self.read_file(name) {
                let trimmed = content.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let file_path = self.workspace_dir.join(name);
                let display_path = file_path.display();
                sections.push(format!("## {display_path}\n{trimmed}"));
                info!(file = %name, bytes = trimmed.len(), "loaded workspace file (clearance)");
            }
        }

        if sections.is_empty() {
            return String::new();
        }

        let mut result = String::from(
            "## Project Context\nThe following project context files have been loaded:\n",
        );
        for section in sections {
            result.push('\n');
            result.push_str(&section);
        }
        result
    }

    /// Read a single file from the workspace directory.
    ///
    /// Returns `None` if the file doesn't exist or can't be read.
    /// Truncates content exceeding [`MAX_FILE_BYTES`] with a warning.
    pub fn read_file(&self, name: &str) -> Option<String> {
        let path = self.workspace_dir.join(name);
        let content = std::fs::read_to_string(&path).ok()?;

        if content.len() > MAX_FILE_BYTES {
            tracing::warn!(
                file = name,
                size = content.len(),
                max = MAX_FILE_BYTES,
                "workspace file exceeds size limit, truncating"
            );
            let truncated = &content[..MAX_FILE_BYTES];
            // Find a safe UTF-8 boundary.
            let safe = match truncated.char_indices().last() {
                Some((idx, ch)) => idx + ch.len_utf8(),
                None => 0,
            };
            let mut result = content[..safe].to_string();
            result.push_str("\n\n... [truncated: file exceeds 10KB limit]");
            return Some(result);
        }

        Some(content)
    }

    /// Returns the workspace directory path.
    pub fn workspace_dir(&self) -> &Path {
        &self.workspace_dir
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn setup_workspace(files: &[(&str, &str)]) -> TempDir {
        let dir = TempDir::new().unwrap();
        for (name, content) in files {
            fs::write(dir.path().join(name), content).unwrap();
        }
        dir
    }

    #[test]
    fn test_load_context_basic() {
        let dir = setup_workspace(&[
            ("SOUL.md", "I am the soul."),
            ("USER.md", "User info here."),
        ]);
        let loader = WorkspaceLoader::new(dir.path());
        let context = loader.load_context();

        assert!(context.contains("Project Context"));
        assert!(context.contains("SOUL.md"));
        assert!(context.contains("I am the soul."));
        assert!(context.contains("USER.md"));
        assert!(context.contains("User info here."));
        // SOUL.md should appear before USER.md
        let soul_pos = context.find("SOUL.md").unwrap();
        let user_pos = context.find("USER.md").unwrap();
        assert!(soul_pos < user_pos);
    }

    #[test]
    fn test_core_md_loaded_first() {
        let dir = setup_workspace(&[
            ("CORE.md", "Core directives here."),
            ("SOUL.md", "I am the soul."),
            ("USER.md", "User info here."),
        ]);
        let loader = WorkspaceLoader::new(dir.path());
        let context = loader.load_context();

        assert!(context.contains("CORE.md"));
        assert!(context.contains("Core directives here."));
        // CORE.md must appear before SOUL.md
        let core_pos = context.find("CORE.md").unwrap();
        let soul_pos = context.find("SOUL.md").unwrap();
        assert!(core_pos < soul_pos, "CORE.md should appear before SOUL.md");
    }

    #[test]
    fn test_missing_core_md_non_fatal() {
        // No CORE.md present — should still load other files fine
        let dir = setup_workspace(&[("SOUL.md", "soul content")]);
        let loader = WorkspaceLoader::new(dir.path());
        let context = loader.load_context();

        assert!(!context.contains("CORE.md"));
        assert!(context.contains("SOUL.md"));
    }

    #[test]
    fn test_missing_files_skipped() {
        let dir = setup_workspace(&[("SOUL.md", "soul content")]);
        let loader = WorkspaceLoader::new(dir.path());
        let context = loader.load_context();

        assert!(context.contains("SOUL.md"));
        assert!(!context.contains("USER.md"));
        assert!(!context.contains("IDENTITY.md"));
    }

    #[test]
    fn test_empty_files_skipped() {
        let dir = setup_workspace(&[
            ("SOUL.md", "soul content"),
            ("USER.md", ""),
            ("IDENTITY.md", "   \n  "),
        ]);
        let loader = WorkspaceLoader::new(dir.path());
        let context = loader.load_context();

        assert!(context.contains("SOUL.md"));
        assert!(!context.contains("USER.md"));
        assert!(!context.contains("IDENTITY.md"));
    }

    #[test]
    fn test_no_files_returns_empty() {
        let dir = TempDir::new().unwrap();
        let loader = WorkspaceLoader::new(dir.path());
        let context = loader.load_context();
        assert!(context.is_empty());
    }

    #[test]
    fn test_truncate_large_file() {
        let dir = TempDir::new().unwrap();
        // Create a file larger than 10KB
        let large_content = "x".repeat(12_000);
        fs::write(dir.path().join("SOUL.md"), &large_content).unwrap();

        let loader = WorkspaceLoader::new(dir.path());
        let content = loader.read_file("SOUL.md").unwrap();

        assert!(content.len() < large_content.len());
        assert!(content.contains("truncated"));
    }

    #[test]
    fn test_read_file_not_found() {
        let dir = TempDir::new().unwrap();
        let loader = WorkspaceLoader::new(dir.path());
        assert!(loader.read_file("NONEXISTENT.md").is_none());
    }
}
