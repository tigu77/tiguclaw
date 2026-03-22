//! 날짜별 JSONL 이벤트 로그 파일 시스템.
//!
//! 경로: `~/.tiguclaw/data/logs/YYYY-MM-DD.jsonl`
//! 모든 DashboardEvent를 JSON Lines 포맷으로 append한다.
//! 자정 넘어가면 새 날짜 파일로 자동 전환.
//! 30일 초과 파일은 startup 시 자동 삭제.

use std::io::Write as _;
use std::path::{Path, PathBuf};

use anyhow::Result;
use chrono::{Local, NaiveDate};
use serde_json::Value;
use tiguclaw_core::event::DashboardEvent;
use tracing::{info, warn};

/// JSONL 이벤트 로거.
pub struct EventLogger {
    /// `~/.tiguclaw/data/logs/` 디렉토리 경로.
    logs_dir: PathBuf,
}

impl EventLogger {
    /// 새 EventLogger 생성. `data_dir`은 `~/.tiguclaw/data/`를 기대한다.
    pub fn new(data_dir: &Path) -> Self {
        let logs_dir = data_dir.join("logs");
        if let Err(e) = std::fs::create_dir_all(&logs_dir) {
            warn!(error = %e, path = %logs_dir.display(), "failed to create logs dir");
        }
        Self { logs_dir }
    }

    /// 오늘 날짜 문자열 (YYYY-MM-DD, local timezone).
    fn today() -> String {
        Local::now().format("%Y-%m-%d").to_string()
    }

    /// 특정 날짜의 JSONL 파일 경로.
    fn log_path(&self, date: &str) -> PathBuf {
        self.logs_dir.join(format!("{date}.jsonl"))
    }

    /// DashboardEvent를 오늘 날짜 파일에 JSONL append.
    /// Heartbeat는 저장 제외 (노이즈).
    pub fn append(&self, event: &DashboardEvent) -> Result<()> {
        // Heartbeat는 저장 제외
        if matches!(event, DashboardEvent::Heartbeat) {
            return Ok(());
        }

        let json = serde_json::to_string(event)?;
        let path = self.log_path(&Self::today());

        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)?;

        writeln!(file, "{json}")?;
        Ok(())
    }

    /// 오늘 로그 tail 읽기 (최신 `limit`개).
    pub fn read_today(&self, limit: usize) -> Result<Vec<Value>> {
        self.read_date(&Self::today(), limit)
    }

    /// 특정 날짜 로그 tail 읽기 (최신 `limit`개).
    pub fn read_date(&self, date: &str, limit: usize) -> Result<Vec<Value>> {
        let path = self.log_path(date);
        if !path.exists() {
            return Ok(vec![]);
        }

        let content = std::fs::read_to_string(&path)?;
        let lines: Vec<&str> = content.lines().collect();

        // tail: 마지막 limit개만 반환
        let start = if lines.len() > limit {
            lines.len() - limit
        } else {
            0
        };

        let mut result = Vec::new();
        for line in &lines[start..] {
            if line.trim().is_empty() {
                continue;
            }
            match serde_json::from_str::<Value>(line) {
                Ok(v) => result.push(v),
                Err(e) => warn!(error = %e, line, "failed to parse log line"),
            }
        }
        Ok(result)
    }

    /// 보관 중인 날짜 목록 반환 (최신순).
    pub fn list_dates(&self) -> Vec<String> {
        let Ok(entries) = std::fs::read_dir(&self.logs_dir) else {
            return vec![];
        };

        let mut dates: Vec<String> = entries
            .filter_map(|e| e.ok())
            .filter_map(|e| {
                let name = e.file_name();
                let s = name.to_string_lossy();
                if s.ends_with(".jsonl") && s.len() == 16 {
                    Some(s[..10].to_string()) // YYYY-MM-DD
                } else {
                    None
                }
            })
            .collect();

        dates.sort_by(|a, b| b.cmp(a)); // 최신순
        dates
    }

    /// 30일 초과 로그 파일 삭제 (startup 시 1회).
    pub fn cleanup_old(&self, keep_days: u32) {
        let Ok(entries) = std::fs::read_dir(&self.logs_dir) else {
            return;
        };

        let cutoff = Local::now()
            .date_naive()
            .checked_sub_days(chrono::Days::new(keep_days as u64))
            .unwrap_or_else(|| Local::now().date_naive());

        for entry in entries.filter_map(|e| e.ok()) {
            let name = entry.file_name();
            let s = name.to_string_lossy();
            if !s.ends_with(".jsonl") || s.len() != 16 {
                continue;
            }
            let date_str = &s[..10];
            if let Ok(date) = NaiveDate::parse_from_str(date_str, "%Y-%m-%d") {
                if date < cutoff {
                    match std::fs::remove_file(entry.path()) {
                        Ok(_) => info!(date = %date_str, "removed old log file"),
                        Err(e) => warn!(error = %e, date = %date_str, "failed to remove old log"),
                    }
                }
            }
        }
    }
}
