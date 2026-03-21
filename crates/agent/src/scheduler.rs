//! Cron scheduler — simple hour/minute/day-based job scheduling.
//!
//! Checks each minute for due jobs and tracks last-run times to prevent
//! duplicate execution within the same minute.

use std::collections::HashMap;

/// A scheduled job.
#[derive(Debug, Clone)]
pub struct CronJob {
    /// Human-readable name.
    pub name: String,
    /// When to run.
    pub schedule: CronSchedule,
    /// Command or prompt to execute.
    pub command: String,
    /// Whether the job is active.
    pub enabled: bool,
}

/// Simple cron schedule based on hour, minute, and day-of-week.
#[derive(Debug, Clone)]
pub struct CronSchedule {
    /// Hour to run (0-23). `None` means every hour.
    pub hour: Option<u8>,
    /// Minute to run (0-59).
    pub minute: u8,
    /// Days of week to run. Empty = every day. 0=Sun, 1=Mon, ..., 6=Sat.
    pub days: Vec<u8>,
}

impl CronSchedule {
    /// Check if this schedule matches the given time.
    pub fn matches(&self, now: &chrono::DateTime<chrono::Local>) -> bool {
        use chrono::{Datelike, Timelike};

        // Check minute
        if now.minute() as u8 != self.minute {
            return false;
        }

        // Check hour (None = every hour)
        if let Some(h) = self.hour {
            if now.hour() as u8 != h {
                return false;
            }
        }

        // Check day of week (empty = every day)
        if !self.days.is_empty() {
            let weekday = now.weekday().num_days_from_sunday() as u8;
            if !self.days.contains(&weekday) {
                return false;
            }
        }

        true
    }
}

/// Scheduler that tracks jobs and their last-run times.
pub struct Scheduler {
    jobs: Vec<CronJob>,
    last_run: HashMap<String, chrono::DateTime<chrono::Local>>,
}

impl Scheduler {
    pub fn new(jobs: Vec<CronJob>) -> Self {
        Self {
            jobs,
            last_run: HashMap::new(),
        }
    }

    /// Return jobs that are due to run now.
    ///
    /// A job is due if:
    /// - It is enabled
    /// - Its schedule matches the current time
    /// - It hasn't already run in the current minute
    pub fn due_jobs(&mut self) -> Vec<CronJob> {
        let now = chrono::Local::now();
        self.due_jobs_at(now)
    }

    /// Testable version with explicit time.
    fn due_jobs_at(&mut self, now: chrono::DateTime<chrono::Local>) -> Vec<CronJob> {
        use chrono::Timelike;

        let mut result = Vec::new();

        for job in &self.jobs {
            if !job.enabled {
                continue;
            }

            if !job.schedule.matches(&now) {
                continue;
            }

            // Check if already ran this minute
            if let Some(last) = self.last_run.get(&job.name) {
                if last.hour() == now.hour()
                    && last.minute() == now.minute()
                    && last.date_naive() == now.date_naive()
                {
                    continue;
                }
            }

            self.last_run.insert(job.name.clone(), now);
            result.push(job.clone());
        }

        result
    }

    /// List all registered jobs.
    pub fn list(&self) -> &[CronJob] {
        &self.jobs
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Local, TimeZone};

    fn make_time(hour: u32, minute: u32) -> chrono::DateTime<chrono::Local> {
        Local::now()
            .date_naive()
            .and_hms_opt(hour, minute, 0)
            .map(|naive| Local.from_local_datetime(&naive).unwrap())
            .unwrap()
    }

    fn make_job(name: &str, hour: Option<u8>, minute: u8, enabled: bool) -> CronJob {
        CronJob {
            name: name.to_string(),
            schedule: CronSchedule {
                hour,
                minute,
                days: vec![],
            },
            command: format!("run {name}"),
            enabled,
        }
    }

    #[test]
    fn test_schedule_matches() {
        let sched = CronSchedule {
            hour: Some(7),
            minute: 0,
            days: vec![],
        };

        assert!(sched.matches(&make_time(7, 0)));
        assert!(!sched.matches(&make_time(7, 1)));
        assert!(!sched.matches(&make_time(8, 0)));
    }

    #[test]
    fn test_schedule_every_hour() {
        let sched = CronSchedule {
            hour: None,
            minute: 30,
            days: vec![],
        };

        assert!(sched.matches(&make_time(0, 30)));
        assert!(sched.matches(&make_time(12, 30)));
        assert!(sched.matches(&make_time(23, 30)));
        assert!(!sched.matches(&make_time(12, 31)));
    }

    #[test]
    fn test_schedule_day_filter() {
        use chrono::{Datelike, Timelike};
        let now = chrono::Local::now();
        let today_dow = now.weekday().num_days_from_sunday() as u8;
        let other_day = (today_dow + 1) % 7;

        let sched_today = CronSchedule {
            hour: None,
            minute: now.minute() as u8,
            days: vec![today_dow],
        };

        let sched_other = CronSchedule {
            hour: None,
            minute: now.minute() as u8,
            days: vec![other_day],
        };

        let test_time = make_time(now.hour(), now.minute());
        assert!(sched_today.matches(&test_time));
        assert!(!sched_other.matches(&test_time));
    }

    #[test]
    fn test_due_jobs_basic() {
        let mut scheduler = Scheduler::new(vec![
            make_job("morning", Some(7), 0, true),
            make_job("evening", Some(20), 0, true),
        ]);

        let due = scheduler.due_jobs_at(make_time(7, 0));
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].name, "morning");
    }

    #[test]
    fn test_due_jobs_skip_disabled() {
        let mut scheduler = Scheduler::new(vec![
            make_job("disabled", Some(7), 0, false),
        ]);

        let due = scheduler.due_jobs_at(make_time(7, 0));
        assert!(due.is_empty());
    }

    #[test]
    fn test_due_jobs_skip_already_run() {
        let mut scheduler = Scheduler::new(vec![
            make_job("morning", Some(7), 0, true),
        ]);

        // First call: should return the job
        let due = scheduler.due_jobs_at(make_time(7, 0));
        assert_eq!(due.len(), 1);

        // Second call same minute: should skip
        let due = scheduler.due_jobs_at(make_time(7, 0));
        assert!(due.is_empty());

        // Next minute: still shouldn't match (different minute)
        let due = scheduler.due_jobs_at(make_time(7, 1));
        assert!(due.is_empty());

        // Next day same time would match (different date), but we can't easily test that
        // without mocking the date.
    }

    #[test]
    fn test_list_jobs() {
        let scheduler = Scheduler::new(vec![
            make_job("a", Some(1), 0, true),
            make_job("b", Some(2), 0, false),
        ]);

        assert_eq!(scheduler.list().len(), 2);
        assert_eq!(scheduler.list()[0].name, "a");
        assert_eq!(scheduler.list()[1].name, "b");
    }
}
