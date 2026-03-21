//! Heartbeat — periodic polling system.
//!
//! Generates prompts at regular intervals, reading HEARTBEAT.md if present.
//! Respects quiet hours to avoid unnecessary activity.

use std::path::Path;

/// Configuration for the heartbeat system.
#[derive(Debug, Clone)]
pub struct HeartbeatConfig {
    /// Polling interval in seconds (default: 600 = 10 minutes).
    pub interval_secs: u64,
    /// Path to HEARTBEAT.md file.
    pub heartbeat_file: String,
    /// Quiet hours start (hour, 0-23). Default: 23.
    pub quiet_start: u8,
    /// Quiet hours end (hour, 0-23). Default: 8.
    pub quiet_end: u8,
}

impl Default for HeartbeatConfig {
    fn default() -> Self {
        Self {
            interval_secs: 600,
            heartbeat_file: "HEARTBEAT.md".to_string(),
            quiet_start: 23,
            quiet_end: 8,
        }
    }
}

/// Heartbeat polling system.
pub struct Heartbeat {
    config: HeartbeatConfig,
}

impl Heartbeat {
    pub fn new(config: HeartbeatConfig) -> Self {
        Self { config }
    }

    /// Check if the current time falls within quiet hours.
    ///
    /// Quiet hours wrap around midnight: e.g. 23:00 → 08:00.
    pub fn is_quiet_hour(&self) -> bool {
        Self::is_quiet_hour_at(self.config.quiet_start, self.config.quiet_end, chrono::Local::now())
    }

    /// Testable version: check if a given time is within quiet hours.
    fn is_quiet_hour_at(quiet_start: u8, quiet_end: u8, now: chrono::DateTime<chrono::Local>) -> bool {
        use chrono::Timelike;
        let hour = now.hour() as u8;

        if quiet_start <= quiet_end {
            // Same-day range: e.g. 2:00 → 6:00
            hour >= quiet_start && hour < quiet_end
        } else {
            // Wraps midnight: e.g. 23:00 → 8:00
            hour >= quiet_start || hour < quiet_end
        }
    }

    /// Generate a heartbeat prompt.
    ///
    /// Returns `None` during quiet hours.
    /// Reads HEARTBEAT.md if it exists and includes its content.
    pub fn generate_prompt(&self) -> Option<String> {
        if self.is_quiet_hour() {
            return None;
        }

        let mut prompt = "Heartbeat poll: Read HEARTBEAT.md if it exists. Follow it strictly.\n\
                          Do not infer or repeat old tasks. If nothing needs attention, reply HEARTBEAT_OK."
            .to_string();

        let path = Path::new(&self.config.heartbeat_file);
        if path.exists() {
            if let Ok(content) = std::fs::read_to_string(path) {
                if !content.trim().is_empty() {
                    prompt.push_str("\n\n");
                    prompt.push_str(&content);
                }
            }
        }

        Some(prompt)
    }

    /// Get the polling interval in seconds.
    pub fn interval_secs(&self) -> u64 {
        self.config.interval_secs
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Local, Timelike, TimeZone};

    fn make_time(hour: u32, minute: u32) -> chrono::DateTime<chrono::Local> {
        Local::now()
            .date_naive()
            .and_hms_opt(hour, minute, 0)
            .map(|naive| Local.from_local_datetime(&naive).unwrap())
            .unwrap()
    }

    #[test]
    fn test_quiet_hour_midnight_wrap() {
        // Quiet 23:00 → 08:00
        assert!(Heartbeat::is_quiet_hour_at(23, 8, make_time(23, 30)));
        assert!(Heartbeat::is_quiet_hour_at(23, 8, make_time(0, 0)));
        assert!(Heartbeat::is_quiet_hour_at(23, 8, make_time(3, 0)));
        assert!(Heartbeat::is_quiet_hour_at(23, 8, make_time(7, 59)));
        assert!(!Heartbeat::is_quiet_hour_at(23, 8, make_time(8, 0)));
        assert!(!Heartbeat::is_quiet_hour_at(23, 8, make_time(12, 0)));
        assert!(!Heartbeat::is_quiet_hour_at(23, 8, make_time(22, 59)));
    }

    #[test]
    fn test_quiet_hour_same_day() {
        // Quiet 2:00 → 6:00
        assert!(Heartbeat::is_quiet_hour_at(2, 6, make_time(2, 0)));
        assert!(Heartbeat::is_quiet_hour_at(2, 6, make_time(4, 0)));
        assert!(Heartbeat::is_quiet_hour_at(2, 6, make_time(5, 59)));
        assert!(!Heartbeat::is_quiet_hour_at(2, 6, make_time(6, 0)));
        assert!(!Heartbeat::is_quiet_hour_at(2, 6, make_time(1, 0)));
        assert!(!Heartbeat::is_quiet_hour_at(2, 6, make_time(23, 0)));
    }

    #[test]
    fn test_generate_prompt_no_file() {
        let hb = Heartbeat::new(HeartbeatConfig {
            heartbeat_file: "/tmp/nonexistent_heartbeat_test.md".to_string(),
            quiet_start: 0,
            quiet_end: 0, // no quiet hours
            ..Default::default()
        });

        let prompt = hb.generate_prompt().unwrap();
        assert!(prompt.contains("Heartbeat poll"));
        assert!(prompt.contains("HEARTBEAT_OK"));
    }

    #[test]
    fn test_generate_prompt_with_file() {
        let tmp = std::env::temp_dir().join("tiguclaw_test_heartbeat.md");
        std::fs::write(&tmp, "Check email\nReview PRs").unwrap();

        let hb = Heartbeat::new(HeartbeatConfig {
            heartbeat_file: tmp.to_string_lossy().to_string(),
            quiet_start: 0,
            quiet_end: 0,
            ..Default::default()
        });

        let prompt = hb.generate_prompt().unwrap();
        assert!(prompt.contains("Check email"));
        assert!(prompt.contains("Review PRs"));

        let _ = std::fs::remove_file(&tmp);
    }

    #[test]
    fn test_generate_prompt_quiet_returns_none() {
        // Set quiet hours to cover all 24 hours (23 → 23 wraps, but let's use 0 → 24 equivalent)
        // Actually, quiet_start=0, quiet_end=24 won't work. Use a range that covers current hour.
        let now_hour = chrono::Local::now().hour() as u8;
        let hb = Heartbeat::new(HeartbeatConfig {
            quiet_start: now_hour,
            quiet_end: now_hour.wrapping_add(1) % 24,
            ..Default::default()
        });

        assert!(hb.generate_prompt().is_none());
    }
}
