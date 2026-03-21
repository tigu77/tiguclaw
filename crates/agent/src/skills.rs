//! Skill system — scan directories for SKILL.md files, match by keyword.

use std::path::{Path, PathBuf};

/// Skill metadata parsed from SKILL.md front-matter.
#[derive(Debug, Clone)]
pub struct SkillMeta {
    pub name: String,
    pub description: String,
    pub location: PathBuf,
}

/// Manages discovered skills.
pub struct SkillManager {
    skills: Vec<SkillMeta>,
}

impl SkillManager {
    /// Scan directories for SKILL.md files and collect metadata.
    /// Non-existent directories are silently ignored.
    pub fn scan(dirs: &[&Path]) -> anyhow::Result<Self> {
        let mut skills = Vec::new();

        for dir in dirs {
            let dir = expand_tilde(dir);
            if !dir.is_dir() {
                continue;
            }
            let entries = std::fs::read_dir(&dir)?;
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_dir() {
                    continue;
                }
                let skill_md = path.join("SKILL.md");
                if !skill_md.is_file() {
                    continue;
                }
                let content = std::fs::read_to_string(&skill_md).unwrap_or_default();
                let (name, description) = parse_frontmatter(&content);
                let name = if name.is_empty() {
                    path.file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_default()
                } else {
                    name
                };
                skills.push(SkillMeta {
                    name,
                    description,
                    location: skill_md,
                });
            }
        }

        Ok(Self { skills })
    }

    /// Find the best matching skill for a user message via keyword overlap.
    /// Requires at least 2 keyword matches in the description.
    pub fn find_match(&self, message: &str) -> Option<&SkillMeta> {
        let msg_lower = message.to_lowercase();
        let msg_words: Vec<&str> = msg_lower.split_whitespace().collect();

        let mut best: Option<(usize, &SkillMeta)> = None;

        for skill in &self.skills {
            if skill.description.is_empty() {
                continue;
            }
            let desc_lower = skill.description.to_lowercase();
            let desc_words: Vec<&str> = desc_lower
                .split(|c: char| !c.is_alphanumeric())
                .filter(|w| w.len() >= 2)
                .collect();

            let count = desc_words
                .iter()
                .filter(|dw| msg_words.iter().any(|mw| mw.contains(*dw) || dw.contains(mw)))
                .count();

            if count >= 2 && best.is_none_or(|(best_count, _)| count > best_count) {
                best = Some((count, skill));
            }
        }

        best.map(|(_, skill)| skill)
    }

    /// Return all discovered skills.
    pub fn list(&self) -> &[SkillMeta] {
        &self.skills
    }

    /// Read the full contents of a SKILL.md file.
    pub fn read_skill(meta: &SkillMeta) -> anyhow::Result<String> {
        Ok(std::fs::read_to_string(&meta.location)?)
    }

    /// Generate `<available_skills>` XML section for injection into system prompt.
    pub fn available_skills_xml(&self) -> String {
        if self.skills.is_empty() {
            return String::new();
        }
        let mut xml = String::from("\n<available_skills>\n");
        for skill in &self.skills {
            xml.push_str("  <skill>\n");
            xml.push_str(&format!("    <name>{}</name>\n", skill.name));
            xml.push_str(&format!("    <description>{}</description>\n", skill.description));
            xml.push_str(&format!(
                "    <location>{}</location>\n",
                skill.location.display()
            ));
            xml.push_str("  </skill>\n");
        }
        xml.push_str("</available_skills>\n");
        xml
    }
}

/// Parse YAML-like front-matter from SKILL.md content.
/// Returns (name, description). Both may be empty if no front-matter found.
fn parse_frontmatter(content: &str) -> (String, String) {
    let mut name = String::new();
    let mut description = String::new();

    let trimmed = content.trim_start();
    if !trimmed.starts_with("---") {
        return (name, description);
    }

    // Find the closing `---`
    let after_first = &trimmed[3..];
    let after_first = after_first.trim_start_matches(['\r', '\n']);
    let end = after_first.find("\n---");
    let block = match end {
        Some(pos) => &after_first[..pos],
        None => return (name, description),
    };

    for line in block.lines() {
        let line = line.trim();
        if let Some(val) = line.strip_prefix("name:") {
            name = val.trim().trim_matches('"').trim_matches('\'').to_string();
        } else if let Some(val) = line.strip_prefix("description:") {
            description = val.trim().trim_matches('"').trim_matches('\'').to_string();
        }
    }

    (name, description)
}

/// Expand `~` at the start of a path to the user's home directory.
fn expand_tilde(path: &Path) -> PathBuf {
    let s = path.to_string_lossy();
    if s.starts_with("~/") || s == "~" {
        if let Some(home) = home_dir() {
            return home.join(&s[2..]);
        }
    }
    path.to_path_buf()
}

/// Get the user's home directory.
fn home_dir() -> Option<PathBuf> {
    std::env::var("HOME")
        .ok()
        .map(PathBuf::from)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn test_parse_frontmatter_normal() {
        let content = "---\nname: bot-restart\ndescription: Build, commit, and restart the bot.\n---\n\n# Bot Restart\nSome instructions.";
        let (name, desc) = parse_frontmatter(content);
        assert_eq!(name, "bot-restart");
        assert_eq!(desc, "Build, commit, and restart the bot.");
    }

    #[test]
    fn test_parse_frontmatter_quoted() {
        let content = "---\nname: \"my-skill\"\ndescription: 'Do something cool'\n---\n";
        let (name, desc) = parse_frontmatter(content);
        assert_eq!(name, "my-skill");
        assert_eq!(desc, "Do something cool");
    }

    #[test]
    fn test_parse_frontmatter_missing() {
        let content = "# No front-matter\nJust content.";
        let (name, desc) = parse_frontmatter(content);
        assert!(name.is_empty());
        assert!(desc.is_empty());
    }

    #[test]
    fn test_parse_frontmatter_empty() {
        let (name, desc) = parse_frontmatter("");
        assert!(name.is_empty());
        assert!(desc.is_empty());
    }

    #[test]
    fn test_parse_frontmatter_no_closing() {
        let content = "---\nname: broken\n";
        let (name, desc) = parse_frontmatter(content);
        assert!(name.is_empty());
        assert!(desc.is_empty());
    }

    #[test]
    fn test_scan_finds_skills() {
        let tmp = TempDir::new().unwrap();
        let skill_dir = tmp.path().join("my-skill");
        fs::create_dir_all(&skill_dir).unwrap();
        fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: my-skill\ndescription: A test skill for testing.\n---\n# My Skill\n",
        )
        .unwrap();

        let mgr = SkillManager::scan(&[tmp.path()]).unwrap();
        assert_eq!(mgr.list().len(), 1);
        assert_eq!(mgr.list()[0].name, "my-skill");
        assert_eq!(mgr.list()[0].description, "A test skill for testing.");
    }

    #[test]
    fn test_scan_no_frontmatter_uses_folder_name() {
        let tmp = TempDir::new().unwrap();
        let skill_dir = tmp.path().join("cool-tool");
        fs::create_dir_all(&skill_dir).unwrap();
        fs::write(skill_dir.join("SKILL.md"), "# Just a heading\nNo front-matter here.").unwrap();

        let mgr = SkillManager::scan(&[tmp.path()]).unwrap();
        assert_eq!(mgr.list().len(), 1);
        assert_eq!(mgr.list()[0].name, "cool-tool");
        assert!(mgr.list()[0].description.is_empty());
    }

    #[test]
    fn test_scan_ignores_nonexistent_dir() {
        let mgr = SkillManager::scan(&[Path::new("/nonexistent/path/12345")]).unwrap();
        assert!(mgr.list().is_empty());
    }

    #[test]
    fn test_scan_ignores_files_without_skill_md() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join("not-a-skill");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("README.md"), "# Not a skill").unwrap();

        let mgr = SkillManager::scan(&[tmp.path()]).unwrap();
        assert!(mgr.list().is_empty());
    }

    #[test]
    fn test_find_match_two_keywords() {
        let tmp = TempDir::new().unwrap();
        let s1 = tmp.path().join("weather");
        fs::create_dir_all(&s1).unwrap();
        fs::write(
            s1.join("SKILL.md"),
            "---\nname: weather\ndescription: Get current weather and forecasts for any location.\n---\n",
        )
        .unwrap();

        let s2 = tmp.path().join("git");
        fs::create_dir_all(&s2).unwrap();
        fs::write(
            s2.join("SKILL.md"),
            "---\nname: git\ndescription: Git operations commit push pull.\n---\n",
        )
        .unwrap();

        let mgr = SkillManager::scan(&[tmp.path()]).unwrap();

        // "weather forecast" matches weather skill (weather + forecasts)
        let matched = mgr.find_match("what's the weather forecast today");
        assert!(matched.is_some());
        assert_eq!(matched.unwrap().name, "weather");
    }

    #[test]
    fn test_find_match_none() {
        let tmp = TempDir::new().unwrap();
        let s1 = tmp.path().join("weather");
        fs::create_dir_all(&s1).unwrap();
        fs::write(
            s1.join("SKILL.md"),
            "---\nname: weather\ndescription: Get current weather and forecasts.\n---\n",
        )
        .unwrap();

        let mgr = SkillManager::scan(&[tmp.path()]).unwrap();
        // Only one keyword match — not enough
        let matched = mgr.find_match("tell me about cooking");
        assert!(matched.is_none());
    }

    #[test]
    fn test_find_match_best_of_multiple() {
        let tmp = TempDir::new().unwrap();

        let s1 = tmp.path().join("bot-restart");
        fs::create_dir_all(&s1).unwrap();
        fs::write(
            s1.join("SKILL.md"),
            "---\nname: bot-restart\ndescription: Build commit and restart the bot service.\n---\n",
        )
        .unwrap();

        let s2 = tmp.path().join("bot-status");
        fs::create_dir_all(&s2).unwrap();
        fs::write(
            s2.join("SKILL.md"),
            "---\nname: bot-status\ndescription: Check bot health status and logs.\n---\n",
        )
        .unwrap();

        let mgr = SkillManager::scan(&[tmp.path()]).unwrap();

        // "restart the bot service" should match bot-restart better
        let matched = mgr.find_match("restart the bot service");
        assert!(matched.is_some());
        assert_eq!(matched.unwrap().name, "bot-restart");
    }

    #[test]
    fn test_available_skills_xml_empty() {
        let mgr = SkillManager { skills: vec![] };
        assert!(mgr.available_skills_xml().is_empty());
    }

    #[test]
    fn test_available_skills_xml_generation() {
        let mgr = SkillManager {
            skills: vec![
                SkillMeta {
                    name: "weather".into(),
                    description: "Get weather forecasts.".into(),
                    location: PathBuf::from("skills/weather/SKILL.md"),
                },
                SkillMeta {
                    name: "git".into(),
                    description: "Git operations.".into(),
                    location: PathBuf::from("skills/git/SKILL.md"),
                },
            ],
        };
        let xml = mgr.available_skills_xml();
        assert!(xml.contains("<available_skills>"));
        assert!(xml.contains("</available_skills>"));
        assert!(xml.contains("<name>weather</name>"));
        assert!(xml.contains("<description>Get weather forecasts.</description>"));
        assert!(xml.contains("<location>skills/weather/SKILL.md</location>"));
        assert!(xml.contains("<name>git</name>"));
    }

    #[test]
    fn test_read_skill() {
        let tmp = TempDir::new().unwrap();
        let skill_dir = tmp.path().join("test-skill");
        fs::create_dir_all(&skill_dir).unwrap();
        let skill_path = skill_dir.join("SKILL.md");
        fs::write(&skill_path, "---\nname: test\ndescription: Test.\n---\n# Instructions\nDo stuff.").unwrap();

        let meta = SkillMeta {
            name: "test".into(),
            description: "Test.".into(),
            location: skill_path,
        };
        let content = SkillManager::read_skill(&meta).unwrap();
        assert!(content.contains("# Instructions"));
    }

    #[test]
    fn test_expand_tilde() {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
        let expanded = expand_tilde(Path::new("~/foo/bar"));
        assert_eq!(expanded, PathBuf::from(format!("{home}/foo/bar")));

        // Non-tilde path unchanged
        let unchanged = expand_tilde(Path::new("/absolute/path"));
        assert_eq!(unchanged, PathBuf::from("/absolute/path"));
    }
}
