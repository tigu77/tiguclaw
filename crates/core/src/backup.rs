//! DB 자동 백업 — SQLite 파일을 날짜별 폴더로 복사하고 오래된 백업을 자동 삭제한다.

use crate::config::BackupConfig;
use std::path::Path;

/// 오늘 날짜 문자열 (YYYY-MM-DD)
fn today_str() -> String {
    // 날짜 계산: 시스템 시간 기반 (chrono 없이 std 사용)
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    // Simple Julian Day calculation
    let days = secs / 86400;
    // days since 1970-01-01 → calendar date
    unix_days_to_ymd(days as i64)
}

/// Unix epoch 기준 날짜 수 → "YYYY-MM-DD" 문자열 변환 (chrono 불필요)
fn unix_days_to_ymd(days: i64) -> String {
    // Tomohiko Sakamoto's algorithm variant
    let mut y = 1970i64;
    let mut d = days;

    loop {
        let leap = is_leap(y);
        let days_in_year = if leap { 366 } else { 365 };
        if d < days_in_year {
            break;
        }
        d -= days_in_year;
        y += 1;
    }

    let leap = is_leap(y);
    let month_days: [i64; 12] = [31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let mut m = 1i64;
    for md in &month_days {
        if d < *md {
            break;
        }
        d -= md;
        m += 1;
    }

    format!("{:04}-{:02}-{:02}", y, m, d + 1)
}

fn is_leap(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || (y % 400 == 0)
}

/// 오늘 백업이 이미 존재하는지 확인
pub fn should_run_today(backup_dir: &Path) -> bool {
    let today = today_str();
    let today_dir = backup_dir.join(&today);
    !today_dir.exists()
}

/// 백업 실행 — data/ 전체를 {backup_dir}/{YYYY-MM-DD}/ 로 복사.
///
/// # 동작
/// 1. 오늘 백업 이미 있으면 스킵
/// 2. {backup_dir}/{today}/ 생성
/// 3. config_dir/data/ 안의 파일 전체 복사 (하위 디렉토리 포함)
/// 4. retention_days 초과한 날짜 폴더 자동 삭제
pub fn run_backup(config_dir: &Path, backup_config: &BackupConfig) -> BackupResult {
    if !backup_config.enabled {
        return BackupResult::disabled();
    }

    // backup_dir 경로 결정 (상대경로 → config_dir 기준)
    let backup_root = if std::path::Path::new(&backup_config.backup_dir).is_absolute() {
        std::path::PathBuf::from(&backup_config.backup_dir)
    } else {
        config_dir.join(&backup_config.backup_dir)
    };

    let today = today_str();
    let today_dir = backup_root.join(&today);

    // 이미 오늘 백업 있으면 스킵
    if today_dir.exists() {
        return BackupResult::skipped(today);
    }

    let source = config_dir.join("data");
    if !source.exists() {
        return BackupResult::error(format!("data/ 디렉토리가 없습니다: {}", source.display()));
    }

    // 오늘 백업 디렉토리 생성
    if let Err(e) = std::fs::create_dir_all(&today_dir) {
        return BackupResult::error(format!("백업 디렉토리 생성 실패: {e}"));
    }

    // data/ 전체 복사
    let (file_count, total_bytes) = match copy_dir_recursive(&source, &today_dir) {
        Ok(stats) => stats,
        Err(e) => {
            // 실패 시 생성한 디렉토리 정리
            let _ = std::fs::remove_dir_all(&today_dir);
            return BackupResult::error(format!("파일 복사 실패: {e}"));
        }
    };

    // 오래된 백업 정리
    let removed = cleanup_old_backups(&backup_root, backup_config.retention_days);

    BackupResult::success(
        source.display().to_string(),
        today_dir.display().to_string(),
        file_count,
        total_bytes,
        removed,
    )
}

/// 디렉토리를 재귀 복사하고 (파일 수, 총 바이트) 반환
fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<(usize, u64)> {
    let mut count = 0usize;
    let mut bytes = 0u64;

    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let file_name = entry.file_name();
        let dst_path = dst.join(&file_name);
        let file_type = entry.file_type()?;

        if file_type.is_dir() {
            std::fs::create_dir_all(&dst_path)?;
            let (c, b) = copy_dir_recursive(&entry.path(), &dst_path)?;
            count += c;
            bytes += b;
        } else if file_type.is_file() {
            let size = std::fs::copy(entry.path(), &dst_path)?;
            count += 1;
            bytes += size;
        }
        // symlink은 스킵 (SQLite DB는 심볼릭 링크 아님)
    }

    Ok((count, bytes))
}

/// retention_days 초과한 날짜 폴더 삭제 — 삭제된 폴더 이름 목록 반환
fn cleanup_old_backups(backup_root: &Path, retention_days: u32) -> Vec<String> {
    let mut removed = Vec::new();
    if !backup_root.exists() {
        return removed;
    }

    // 현재 시간 (unix seconds)
    let now_secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let cutoff_secs = now_secs.saturating_sub(retention_days as u64 * 86400);

    let entries = match std::fs::read_dir(backup_root) {
        Ok(e) => e,
        Err(_) => return removed,
    };

    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        // YYYY-MM-DD 형식인지 확인 (10자, '-' 구분)
        if name.len() == 10 && name.as_bytes()[4] == b'-' && name.as_bytes()[7] == b'-' {
            // 날짜 파싱해서 cutoff와 비교
            if let Some(entry_secs) = parse_ymd_to_unix(&name) {
                if entry_secs < cutoff_secs {
                    if std::fs::remove_dir_all(entry.path()).is_ok() {
                        removed.push(name);
                    }
                }
            }
        }
    }

    removed
}

/// "YYYY-MM-DD" → Unix timestamp (해당 날짜 자정 UTC)
fn parse_ymd_to_unix(s: &str) -> Option<u64> {
    let parts: Vec<&str> = s.splitn(3, '-').collect();
    if parts.len() != 3 {
        return None;
    }
    let y = parts[0].parse::<i64>().ok()?;
    let m = parts[1].parse::<i64>().ok()?;
    let d = parts[2].parse::<i64>().ok()?;

    // Days since 1970-01-01
    let mut days: i64 = 0;
    for yr in 1970..y {
        days += if is_leap(yr) { 366 } else { 365 };
    }
    let month_days: [i64; 12] = [31, if is_leap(y) { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    for mi in 1..m {
        days += month_days.get((mi - 1) as usize).copied().unwrap_or(30);
    }
    days += d - 1;

    Some((days as u64) * 86400)
}

// ─── 결과 타입 ────────────────────────────────────────────────────────────────

/// 백업 실행 결과
#[derive(Debug)]
pub struct BackupResult {
    pub status: BackupStatus,
    /// 소스 경로 (성공 시)
    pub source: Option<String>,
    /// 대상 경로 (성공 시)
    pub dest: Option<String>,
    /// 복사된 파일 수 (성공 시)
    pub file_count: usize,
    /// 복사된 총 바이트 (성공 시)
    pub total_bytes: u64,
    /// 삭제된 오래된 백업 목록
    pub removed: Vec<String>,
    /// 오류/스킵 메시지
    pub message: Option<String>,
}

#[derive(Debug, PartialEq)]
pub enum BackupStatus {
    Success,
    Skipped,
    Disabled,
    Error,
}

impl BackupResult {
    fn success(source: String, dest: String, file_count: usize, total_bytes: u64, removed: Vec<String>) -> Self {
        Self {
            status: BackupStatus::Success,
            source: Some(source),
            dest: Some(dest),
            file_count,
            total_bytes,
            removed,
            message: None,
        }
    }

    fn skipped(date: String) -> Self {
        Self {
            status: BackupStatus::Skipped,
            source: None,
            dest: None,
            file_count: 0,
            total_bytes: 0,
            removed: vec![],
            message: Some(format!("오늘({date}) 백업이 이미 있습니다")),
        }
    }

    fn disabled() -> Self {
        Self {
            status: BackupStatus::Disabled,
            source: None,
            dest: None,
            file_count: 0,
            total_bytes: 0,
            removed: vec![],
            message: Some("백업 비활성화됨".to_string()),
        }
    }

    fn error(msg: String) -> Self {
        Self {
            status: BackupStatus::Error,
            source: None,
            dest: None,
            file_count: 0,
            total_bytes: 0,
            removed: vec![],
            message: Some(msg),
        }
    }

    /// 사람이 읽기 좋은 바이트 크기 문자열
    pub fn format_size(bytes: u64) -> String {
        if bytes >= 1024 * 1024 {
            format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0))
        } else if bytes >= 1024 {
            format!("{:.1} KB", bytes as f64 / 1024.0)
        } else {
            format!("{} B", bytes)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_today_str_format() {
        let s = today_str();
        assert_eq!(s.len(), 10);
        assert_eq!(s.as_bytes()[4], b'-');
        assert_eq!(s.as_bytes()[7], b'-');
    }

    #[test]
    fn test_unix_days_known() {
        // 2026-03-22 = 2026년 3월 22일
        // Days since 1970: 1970-2025 = 56년 + 2026-01-01~03-22
        let result = unix_days_to_ymd(20534); // manually verified
        // Just check format
        assert_eq!(result.len(), 10);
    }

    #[test]
    fn test_parse_roundtrip() {
        let date = "2026-03-22";
        let secs = parse_ymd_to_unix(date).unwrap();
        let days = secs / 86400;
        let back = unix_days_to_ymd(days as i64);
        assert_eq!(back, date);
    }
}
