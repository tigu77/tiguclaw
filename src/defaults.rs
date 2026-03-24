//! 첫 실행 시 ~/.tiguclaw/shared/ 기본 파일 자동 생성.
//!
//! 새 유저는 설정 없이 바로 동작하며, 기존 파일이 있으면 덮어쓰지 않는다.

use std::path::Path;
use anyhow::Result;
use tracing::info;

const DEFAULT_CORE: &str = include_str!("defaults/CORE.md");
const DEFAULT_T0: &str = include_str!("defaults/T0.md");
const DEFAULT_T1: &str = include_str!("defaults/T1.md");
const DEFAULT_T2: &str = include_str!("defaults/T2.md");

/// shared 디렉토리에 기본 파일들을 생성한다.
/// 기존 파일이 있으면 덮어쓰지 않는다.
pub fn init_shared_defaults(shared_dir: &Path) -> Result<()> {
    std::fs::create_dir_all(shared_dir)?;

    let files = [
        ("CORE.md", DEFAULT_CORE),
        ("T0.md", DEFAULT_T0),
        ("T1.md", DEFAULT_T1),
        ("T2.md", DEFAULT_T2),
    ];

    for (name, content) in &files {
        let path = shared_dir.join(name);
        if !path.exists() {
            std::fs::write(&path, content)?;
            info!("created default shared file: {}", name);
        }
    }

    Ok(())
}
