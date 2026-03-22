//! tiguclaw CLI — subcommand system for managing the tiguclaw agent.

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use std::path::PathBuf;

// ─── CLI definition ──────────────────────────────────────────────────────────

#[derive(Parser)]
#[command(name = "tiguclaw", about = "tiguclaw agent CLI", version)]
pub struct Cli {
    #[command(subcommand)]
    pub command: Option<Commands>,
}

#[derive(Subcommand)]
pub enum Commands {
    /// Run the agent (default when no subcommand is given)
    Run,

    /// Manage the LaunchAgent gateway service
    Gateway {
        #[command(subcommand)]
        action: GatewayAction,
    },

    /// View agent logs
    Logs {
        /// Follow log output (like tail -f)
        #[arg(short, long)]
        follow: bool,
    },

    /// Show overall agent health status
    Status,

    /// Manage AI model cascade configuration
    Models {
        #[command(subcommand)]
        action: ModelsAction,
    },

    /// List available skills
    Skills {
        #[command(subcommand)]
        action: SkillsAction,
    },

    /// Manage conversation memory
    Memory {
        #[command(subcommand)]
        action: MemoryAction,
    },

    /// Read or write config.toml values
    Config {
        #[command(subcommand)]
        action: ConfigAction,
    },

    /// Interactive setup wizard — creates config.toml and shared/USER.md
    Init {
        /// Skip prompts and use defaults (for CI/testing)
        #[arg(long)]
        yes: bool,
        /// Installation directory (default: ~/.tiguclaw)
        #[arg(long, value_name = "DIR")]
        dir: Option<PathBuf>,
        /// Reinitialize even if already initialized
        #[arg(long)]
        force: bool,
    },

    /// Run a manual DB backup immediately
    Backup,
}

#[derive(Subcommand)]
pub enum GatewayAction {
    /// Create LaunchAgent plist and load it
    Install {
        /// Installation directory (default: ~/.tiguclaw)
        #[arg(long, value_name = "DIR")]
        dir: Option<PathBuf>,
    },
    /// Unload and delete LaunchAgent plist
    Uninstall,
    /// Start the service
    Start,
    /// Stop the service
    Stop,
    /// Restart the service
    Restart,
    /// Show service status (PID, uptime)
    Status,
}

#[derive(Subcommand)]
pub enum ModelsAction {
    /// Show current cascade model configuration
    List,
    /// Change the model for a tier (tier1/tier2)
    Set {
        /// Tier name: tier1 or tier2
        tier: String,
        /// Model name (e.g. claude-sonnet-4-20250514)
        model: String,
    },
}

#[derive(Subcommand)]
pub enum SkillsAction {
    /// List all available skills
    List,
}

#[derive(Subcommand)]
pub enum MemoryAction {
    /// Show memory database statistics
    Stats,
    /// Clear conversation history (with confirmation)
    Clear,
}

#[derive(Subcommand)]
pub enum ConfigAction {
    /// Get a config value (dot notation: provider.api_key)
    Get { key: String },
    /// Set a config value (dot notation: provider.api_key)
    Set { key: String, value: String },
}

// ─── Constants ───────────────────────────────────────────────────────────────

const LABEL_BASE: &str = "com.tiguclaw.agent";
const LOG_PATH: &str = "/tmp/tiguclaw.log";
const CONFIG_FILE: &str = "config.toml";

/// 기본 설치 디렉토리: ~/.tiguclaw
fn install_dir() -> PathBuf {
    dirs_home().join(".tiguclaw")
}

/// 특정 dir의 이름에서 라벨 suffix 추출
/// ~/.tiguclaw       → "com.tiguclaw.agent"
/// ~/.tiguclaw-work  → "com.tiguclaw.agent.work"
/// ~/.tiguclaw-x-y   → "com.tiguclaw.agent.x-y"
fn instance_label_for(dir: &std::path::Path) -> String {
    let dir_name = dir
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("tiguclaw");
    if let Some(suffix) = dir_name.strip_prefix(".tiguclaw-") {
        format!("{}.{}", LABEL_BASE, suffix)
    } else {
        LABEL_BASE.to_string()
    }
}

fn instance_label() -> String {
    instance_label_for(&install_dir())
}

fn plist_path() -> PathBuf {
    dirs_home()
        .join("Library")
        .join("LaunchAgents")
        .join(format!("{}.plist", instance_label()))
}

fn dirs_home() -> PathBuf {
    std::env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/tmp"))
}

fn uid() -> u32 {
    #[cfg(unix)]
    {
        extern "C" {
            fn getuid() -> u32;
        }
        // SAFETY: getuid() is always safe to call
        unsafe { getuid() }
    }
    #[cfg(not(unix))]
    {
        1000
    }
}

// ─── Dispatch ────────────────────────────────────────────────────────────────

/// Dispatch a CLI command. Returns Ok(true) if the bot should run, Ok(false) if CLI handled.
pub fn dispatch(cli: &Cli) -> Result<bool> {
    match &cli.command {
        None | Some(Commands::Run) => Ok(true),
        Some(cmd) => {
            run_command(cmd)?;
            Ok(false)
        }
    }
}

fn run_command(cmd: &Commands) -> Result<()> {
    match cmd {
        Commands::Run => unreachable!(),
        Commands::Gateway { action } => gateway(action),
        Commands::Logs { follow } => logs(*follow),
        Commands::Status => status(),
        Commands::Models { action } => models(action),
        Commands::Skills { action } => skills(action),
        Commands::Memory { action } => memory(action),
        Commands::Config { action } => config_cmd(action),
        Commands::Init { yes, dir, force } => init(*yes, dir.clone(), *force),
        Commands::Backup => backup_now(),
    }
}

// ─── Gateway ─────────────────────────────────────────────────────────────────

fn gateway(action: &GatewayAction) -> Result<()> {
    match action {
        GatewayAction::Install { dir } => gateway_install(dir.clone()),
        GatewayAction::Uninstall => gateway_uninstall(),
        GatewayAction::Start => gateway_start(),
        GatewayAction::Stop => gateway_stop(),
        GatewayAction::Restart => gateway_restart(),
        GatewayAction::Status => gateway_status(),
    }
}

fn gateway_install(dir: Option<PathBuf>) -> Result<()> {
    let install_dir = dir.unwrap_or_else(install_dir);

    // Install dir 생성 및 이동
    std::fs::create_dir_all(&install_dir)
        .context("failed to create install directory")?;
    std::env::set_current_dir(&install_dir)
        .context("failed to change to install directory")?;

    let bin = std::env::current_exe().context("failed to get current executable path")?;
    let bin_str = bin.to_string_lossy();
    let label = instance_label_for(&install_dir);
    let plist = dirs_home()
        .join("Library")
        .join("LaunchAgents")
        .join(format!("{}.plist", label));

    // Create LaunchAgents directory if needed
    std::fs::create_dir_all(plist.parent().unwrap())
        .context("failed to create LaunchAgents directory")?;

    let content = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
    "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>{label}</string>
    <key>ProgramArguments</key>
    <array>
        <string>{bin_str}</string>
        <string>run</string>
    </array>
    <key>StandardOutPath</key>
    <string>{LOG_PATH}</string>
    <key>StandardErrorPath</key>
    <string>{LOG_PATH}</string>
    <key>KeepAlive</key>
    <true/>
    <key>RunAtLoad</key>
    <true/>
    <key>WorkingDirectory</key>
    <string>{working_dir}</string>
</dict>
</plist>
"#,
        working_dir = install_dir.to_string_lossy()
    );

    std::fs::write(&plist, &content).context("failed to write plist")?;
    println!("✅ Plist written to {}", plist.display());

    // unload 먼저 (이미 없으면 무시)
    let _ = std::process::Command::new("launchctl")
        .args(["unload", &plist.to_string_lossy()])
        .output();

    // load
    let out = std::process::Command::new("launchctl")
        .args(["load", &plist.to_string_lossy()])
        .output()
        .context("launchctl load failed")?;

    if out.status.success() {
        println!("✅ Gateway installed and started.");
    } else {
        let err = String::from_utf8_lossy(&out.stderr);
        println!("⚠️  Plist installed but failed to start: {}", err.trim());
        println!("   Try: launchctl load {}", plist.display());
    }

    // dashboard 배포
    let dashboard_dst = dirs_home().join(".tiguclaw").join("dashboard");
    if dashboard_dst.exists() {
        println!("ℹ️  Dashboard already deployed at ~/.tiguclaw/dashboard/");
    } else {
        // binary 옆에 dashboard/ 있으면 복사
        let binary_dir = std::env::current_exe()?
            .parent()
            .unwrap_or(std::path::Path::new("."))
            .to_path_buf();
        let dashboard_src = binary_dir.join("dashboard");
        if dashboard_src.exists() {
            copy_dir_all(&dashboard_src, &dashboard_dst)
                .context("failed to copy dashboard files")?;
            println!("✅ Dashboard deployed to ~/.tiguclaw/dashboard/");
        } else {
            println!("ℹ️  Dashboard not bundled — API-only mode (http://localhost:3002/api)");
        }
    }

    println!("\n✅ Gateway service registered for {}", install_dir.display());
    Ok(())
}

/// 디렉토리를 재귀적으로 복사한다.
fn copy_dir_all(src: &std::path::Path, dst: &std::path::Path) -> Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let dst_path = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_all(&entry.path(), &dst_path)?;
        } else {
            std::fs::copy(entry.path(), &dst_path)?;
        }
    }
    Ok(())
}

fn gateway_uninstall() -> Result<()> {
    let plist = plist_path();
    if plist.exists() {
        let out = std::process::Command::new("launchctl")
            .args(["unload", &plist.to_string_lossy()])
            .output()
            .context("launchctl unload failed")?;
        print_output(&out);

        std::fs::remove_file(&plist).context("failed to remove plist")?;
        println!("✅ Gateway uninstalled.");
    } else {
        println!("ℹ️  Plist not found at {}. Nothing to do.", plist.display());
    }
    Ok(())
}

fn gateway_start() -> Result<()> {
    let label = instance_label();
    let target = format!("gui/{}/{}", uid(), label);
    let out = std::process::Command::new("launchctl")
        .args(["start", &target])
        .output()
        .context("launchctl start failed")?;
    print_output(&out);
    if out.status.success() {
        println!("✅ Gateway started.");
    }
    Ok(())
}

fn gateway_stop() -> Result<()> {
    let label = instance_label();
    let target = format!("gui/{}/{}", uid(), label);
    let out = std::process::Command::new("launchctl")
        .args(["stop", &target])
        .output()
        .context("launchctl stop failed")?;
    print_output(&out);
    if out.status.success() {
        println!("✅ Gateway stopped.");
    }
    Ok(())
}

fn gateway_restart() -> Result<()> {
    let label = instance_label();
    let target = format!("gui/{}/{}", uid(), label);
    let out = std::process::Command::new("launchctl")
        .args(["kickstart", "-k", &target])
        .output()
        .context("launchctl kickstart failed")?;
    print_output(&out);
    if out.status.success() {
        println!("✅ Gateway restarted.");
    }
    Ok(())
}

fn gateway_status() -> Result<()> {
    let label = instance_label();
    let out = std::process::Command::new("launchctl")
        .args(["list", &label])
        .output()
        .context("launchctl list failed")?;

    let text = String::from_utf8_lossy(&out.stdout);
    if !out.status.success() || text.trim().is_empty() || text.contains("Could not find") {
        println!("❌ Gateway is NOT running (service not found).");
        return Ok(());
    }

    // Parse PID and LastExitStatus from launchctl list output
    let mut pid = None;
    let mut last_exit = None;
    for line in text.lines() {
        let line = line.trim();
        if let Some(val) = line.strip_prefix("\"PID\" = ") {
            pid = Some(val.trim_end_matches(';').trim_matches('"').to_string());
        }
        if let Some(val) = line.strip_prefix("\"LastExitStatus\" = ") {
            last_exit = Some(val.trim_end_matches(';').to_string());
        }
    }

    match pid {
        Some(p) => {
            println!("✅ Gateway is RUNNING");
            println!("   PID: {}", p);
        }
        None => {
            println!("❌ Gateway is NOT running");
            if let Some(exit) = &last_exit {
                println!("   LastExitStatus: {}", exit);
            }
        }
    }

    println!("   Plist: {}", plist_path().display());
    println!("   Log:   {LOG_PATH}");
    Ok(())
}

// ─── Logs ─────────────────────────────────────────────────────────────────────

fn logs(follow: bool) -> Result<()> {
    if follow {
        let mut child = std::process::Command::new("tail")
            .args(["-f", LOG_PATH])
            .spawn()
            .context("failed to spawn tail -f")?;
        child.wait()?;
    } else {
        let out = std::process::Command::new("tail")
            .args(["-n", "100", LOG_PATH])
            .output()
            .context("failed to read log")?;
        if out.stdout.is_empty() && !std::path::Path::new(LOG_PATH).exists() {
            println!("ℹ️  Log file not found: {LOG_PATH}");
        } else {
            print!("{}", String::from_utf8_lossy(&out.stdout));
        }
    }
    Ok(())
}

// ─── Status ───────────────────────────────────────────────────────────────────

fn status() -> Result<()> {
    let label = instance_label();
    println!("=== tiguclaw status ===\n");

    // Gateway status
    let out = std::process::Command::new("launchctl")
        .args(["list", &label])
        .output();
    match out {
        Ok(o) if o.status.success() => {
            let text = String::from_utf8_lossy(&o.stdout);
            let running = text.contains("\"PID\"");
            if running {
                println!("🟢 Gateway:  RUNNING");
            } else {
                println!("🔴 Gateway:  stopped (loaded but not running)");
            }
        }
        _ => println!("⚫ Gateway:  not installed"),
    }

    // Config / models
    match load_toml_doc(CONFIG_FILE) {
        Ok(doc) => {
            let tiers = &doc["provider"]["tiers"];
            println!("\n📊 Model tiers:");
            for tier in &["tier1", "tier2"] {
                if let Some(arr) = tiers[*tier].as_array() {
                    let models: Vec<&str> = arr
                        .iter()
                        .filter_map(|v| v.as_str())
                        .collect();
                    println!("   {:5} → {}", tier, models.join(", "));
                }
            }
        }
        Err(e) => println!("\n⚠️  Could not read config: {e}"),
    }

    // Memory DBs
    println!("\n💾 Memory databases:");
    for db in &["data/conversations.db", "data/memory.db"] {
        let p = std::path::Path::new(db);
        if p.exists() {
            let size = p.metadata().map(|m| m.len()).unwrap_or(0);
            println!("   {} ({:.1} KB)", db, size as f64 / 1024.0);
        } else {
            println!("   {} — not found", db);
        }
    }

    Ok(())
}

// ─── Models ───────────────────────────────────────────────────────────────────

fn models(action: &ModelsAction) -> Result<()> {
    match action {
        ModelsAction::List => models_list(),
        ModelsAction::Set { tier, model } => models_set(tier, model),
    }
}

fn models_list() -> Result<()> {
    let doc = load_toml_doc(CONFIG_FILE)?;
    let tiers = &doc["provider"]["tiers"];
    println!("Model tier configuration:");
    for tier in &["tier1", "tier2"] {
        if let Some(arr) = tiers[*tier].as_array() {
            let models: Vec<&str> = arr.iter().filter_map(|v| v.as_str()).collect();
            println!("  {:5} → {}", tier, models.join(", "));
        }
    }
    Ok(())
}

fn models_set(tier: &str, model: &str) -> Result<()> {
    if !["tier1", "tier2"].contains(&tier) {
        anyhow::bail!("Invalid tier '{}'. Must be: tier1 or tier2", tier);
    }

    let mut doc = load_toml_doc(CONFIG_FILE)?;

    // Replace first element of the tier array, keeping the rest as fallbacks
    let arr = doc["provider"]["tiers"][tier]
        .as_array_mut()
        .context(format!("tiers.{tier} is not an array in config.toml"))?;

    if arr.is_empty() {
        arr.push(model);
    } else {
        // Replace by removing and inserting
        arr.remove(0);
        arr.insert(0, model);
    }

    save_toml_doc(CONFIG_FILE, &doc)?;
    println!("✅ Set {tier} model → {model}");
    Ok(())
}

// ─── Skills ───────────────────────────────────────────────────────────────────

fn skills(action: &SkillsAction) -> Result<()> {
    match action {
        SkillsAction::List => skills_list(),
    }
}

fn skills_list() -> Result<()> {
    let doc = load_toml_doc(CONFIG_FILE)?;

    let dirs: Vec<String> = doc["agent"]["skill_dirs"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str())
                .map(expand_tilde)
                .collect()
        })
        .unwrap_or_default();

    if dirs.is_empty() {
        println!("No skill_dirs configured.");
        return Ok(());
    }

    let mut found = false;
    for dir in &dirs {
        let p = std::path::Path::new(dir);
        if !p.exists() {
            println!("  [{}] (not found)", dir);
            continue;
        }

        // Each subdirectory that contains SKILL.md is a skill
        if let Ok(entries) = std::fs::read_dir(p) {
            for entry in entries.flatten() {
                let skill_md = entry.path().join("SKILL.md");
                if skill_md.exists() {
                    let name = entry.file_name().to_string_lossy().to_string();
                    // Try to read first description line
                    let desc = read_skill_description(&skill_md).unwrap_or_default();
                    if desc.is_empty() {
                        println!("  {name}");
                    } else {
                        println!("  {name:20} — {desc}");
                    }
                    found = true;
                }
            }
        }
    }

    if !found {
        println!("No skills found in configured directories.");
    }
    Ok(())
}

fn read_skill_description(skill_md: &std::path::Path) -> Option<String> {
    let content = std::fs::read_to_string(skill_md).ok()?;
    // Look for first non-empty, non-heading line
    for line in content.lines() {
        let trimmed = line.trim();
        if !trimmed.is_empty() && !trimmed.starts_with('#') {
            return Some(trimmed.chars().take(80).collect());
        }
    }
    None
}

fn expand_tilde(s: &str) -> String {
    if let Some(stripped) = s.strip_prefix("~/") {
        format!(
            "{}/{}",
            dirs_home().to_string_lossy(),
            stripped
        )
    } else {
        s.to_string()
    }
}

// ─── Memory ───────────────────────────────────────────────────────────────────

fn memory(action: &MemoryAction) -> Result<()> {
    match action {
        MemoryAction::Stats => memory_stats(),
        MemoryAction::Clear => memory_clear(),
    }
}

fn memory_stats() -> Result<()> {
    println!("=== Memory database stats ===\n");

    let dbs = [
        ("conversations.db", "data/conversations.db"),
        ("memory.db", "data/memory.db"),
    ];

    for (name, path) in &dbs {
        let p = std::path::Path::new(path);
        if !p.exists() {
            println!("{name}: not found");
            continue;
        }

        let size = p.metadata()?.len();
        println!("{name}:");
        println!("  Size: {:.1} KB ({} bytes)", size as f64 / 1024.0, size);

        // Count conversations
        if let Ok(conn) = rusqlite::Connection::open(p) {
            // Try conversations table
            let conv_count: Option<i64> = conn
                .query_row("SELECT COUNT(*) FROM conversations", [], |r| r.get(0))
                .ok();
            if let Some(n) = conv_count {
                println!("  Conversations: {n}");
            }

            // Try messages table
            let msg_count: Option<i64> = conn
                .query_row("SELECT COUNT(*) FROM messages", [], |r| r.get(0))
                .ok();
            if let Some(n) = msg_count {
                println!("  Messages: {n}");
            }

            // Try memory/entries table
            let mem_count: Option<i64> = conn
                .query_row("SELECT COUNT(*) FROM memory", [], |r| r.get(0))
                .ok();
            if let Some(n) = mem_count {
                println!("  Memory entries: {n}");
            }
        }
        println!();
    }
    Ok(())
}

fn memory_clear() -> Result<()> {
    print!("⚠️  This will clear ALL conversation history. Are you sure? [y/N] ");
    use std::io::Write;
    std::io::stdout().flush()?;

    let mut input = String::new();
    std::io::stdin().read_line(&mut input)?;

    if input.trim().to_lowercase() != "y" {
        println!("Cancelled.");
        return Ok(());
    }

    let dbs = ["data/conversations.db", "data/memory.db"];
    for path in &dbs {
        let p = std::path::Path::new(path);
        if p.exists() {
            if let Ok(conn) = rusqlite::Connection::open(p) {
                // Clear main tables
                let _ = conn.execute_batch(
                    "DELETE FROM messages; DELETE FROM conversations;",
                );
                let _ = conn.execute("DELETE FROM memory", []);
                println!("✅ Cleared {path}");
            }
        } else {
            println!("ℹ️  {path} not found, skipping.");
        }
    }
    Ok(())
}

// ─── Config ───────────────────────────────────────────────────────────────────

fn config_cmd(action: &ConfigAction) -> Result<()> {
    match action {
        ConfigAction::Get { key } => config_get(key),
        ConfigAction::Set { key, value } => config_set(key, value),
    }
}

fn config_get(key: &str) -> Result<()> {
    let doc = load_toml_doc(CONFIG_FILE)?;
    let parts: Vec<&str> = key.split('.').collect();
    let val = navigate_toml(&doc, &parts)
        .context(format!("Key '{key}' not found in config.toml"))?;
    println!("{key} = {val}");
    Ok(())
}

fn config_set(key: &str, value: &str) -> Result<()> {
    let mut doc = load_toml_doc(CONFIG_FILE)?;
    let parts: Vec<&str> = key.split('.').collect();

    if parts.is_empty() {
        anyhow::bail!("Empty key");
    }

    set_toml_value(&mut doc, &parts, value)?;
    save_toml_doc(CONFIG_FILE, &doc)?;
    println!("✅ Set {key} = {value}");
    Ok(())
}

// ─── Init ─────────────────────────────────────────────────────────────────────

/// .env 파일에서 KEY=VALUE 파싱
fn read_env_file(path: &std::path::Path) -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();
    if let Ok(content) = std::fs::read_to_string(path) {
        for line in content.lines() {
            if let Some((k, v)) = line.split_once('=') {
                map.insert(k.trim().to_string(), v.trim().to_string());
            }
        }
    }
    map
}

/// 민감한 값 마스킹 (앞 6자만 표시)
fn mask_secret(s: &str) -> String {
    if s.len() > 6 {
        format!("{}****", &s[..6])
    } else {
        "****".to_string()
    }
}

fn init(yes: bool, dir: Option<PathBuf>, force: bool) -> Result<()> {
    let install_dir = dir.unwrap_or_else(install_dir);

    println!("🐯 tiguclaw setup wizard\n");
    println!("📁 Install directory: {}", install_dir.display());

    // 1. 기존 설정 로드 (있으면 기본값으로 활용)
    let config_path = install_dir.join(CONFIG_FILE);
    let env_path = install_dir.join(".env");
    let already_init = config_path.exists();

    if already_init && !force {
        println!("📝 Already initialized — updating existing config (Enter to keep current values)\n");
    }

    // 기존 .env 값 읽기
    let existing_env = read_env_file(&env_path);
    let existing_bot_token = existing_env.get("TELEGRAM_BOT_TOKEN").cloned().unwrap_or_default();
    let existing_api_key = existing_env.get("ANTHROPIC_API_KEY").cloned().unwrap_or_default();

    // 기존 config.toml 값 읽기
    let (existing_agent_name, existing_port) = if already_init {
        let doc = load_toml_doc(config_path.to_str().unwrap_or(CONFIG_FILE)).unwrap_or_default();
        let name = doc.get("agent")
            .and_then(|a| a.get("name"))
            .and_then(|v| v.as_str())
            .unwrap_or("MyAgent")
            .to_string();
        let port = doc.get("dashboard")
            .and_then(|d| d.get("port"))
            .and_then(|v| v.as_integer())
            .unwrap_or(3002) as u16;
        (name, port)
    } else {
        ("MyAgent".to_string(), 3002u16)
    };

    // config.toml.example 읽기 — chdir 전에 (binary 옆 또는 cwd에서 찾음)
    // 기존 init인 경우 example 없어도 진행 가능
    let example = if already_init && !force {
        std::fs::read_to_string(&config_path).unwrap_or_default()
    } else {
        find_config_example()?
    };

    // Install dir 생성 및 이동
    std::fs::create_dir_all(&install_dir)
        .context("failed to create install directory")?;

    // 2. 필수 정보 입력받기
    let bot_token = if yes {
        if existing_bot_token.is_empty() { "YOUR_TELEGRAM_BOT_TOKEN".to_string() } else { existing_bot_token.clone() }
    } else {
        let default_label = if existing_bot_token.is_empty() {
            "Telegram bot token (from @BotFather)".to_string()
        } else {
            format!("Telegram bot token [{}]", mask_secret(&existing_bot_token))
        };
        let input = prompt(&default_label)?;
        if input.is_empty() && !existing_bot_token.is_empty() {
            existing_bot_token.clone()
        } else {
            input
        }
    };

    // admin_chat_id is auto-registered on first /start — no prompt needed

    let api_key = if yes {
        if existing_api_key.is_empty() { "${ANTHROPIC_API_KEY}".to_string() } else { existing_api_key.clone() }
    } else {
        let default_label = if existing_api_key.is_empty() {
            "Anthropic API key (from console.anthropic.com)".to_string()
        } else {
            format!("Anthropic API key [{}]", mask_secret(&existing_api_key))
        };
        let input = prompt(&default_label)?;
        if input.is_empty() && !existing_api_key.is_empty() {
            existing_api_key.clone()
        } else {
            input
        }
    };

    let agent_name = if yes {
        existing_agent_name.clone()
    } else {
        let s = prompt_with_default("Agent name", &existing_agent_name)?;
        if s.is_empty() { existing_agent_name.clone() } else { s }
    };

    let dashboard_port: u16 = if yes {
        existing_port
    } else {
        let s = prompt_with_default("Dashboard port", &existing_port.to_string())?;
        s.trim().parse().unwrap_or(existing_port)
    };

    // install_dir로 이동 후 파일 생성
    std::env::set_current_dir(&install_dir)
        .context("failed to change to install directory")?;

    // 3. .env 파일 생성 (실제 키는 .env에)
    let env_content = format!(
        "TELEGRAM_BOT_TOKEN={}\nANTHROPIC_API_KEY={}\n",
        bot_token, api_key
    );
    std::fs::write(".env", &env_content)?;
    println!("\n✅ .env created (tokens stored here)");

    // 4. config.toml.example 읽어서 값 치환 (환경변수 참조 유지)
    let config_content = example
        .replace("\"MyAgent\"", &format!("\"{}\"", agent_name))
        .replace("port = 3002", &format!("port = {}", dashboard_port));
    // bot_token, api_key는 .env의 환경변수 참조 그대로 유지

    std::fs::write(CONFIG_FILE, &config_content)?;
    println!("✅ config.toml created");

    // 5. shared/USER.md 생성 (USER.md.example 기반)
    std::fs::create_dir_all("shared")?;
    if !std::path::Path::new("shared/USER.md").exists() {
        if let Ok(user_example) = std::fs::read_to_string("shared/USER.md.example") {
            let user_content = user_example.replace("Your Name", &agent_name);
            std::fs::write("shared/USER.md", &user_content)?;
            println!("✅ shared/USER.md created");
        }
    }

    // 6. data/ 디렉토리 생성
    std::fs::create_dir_all("data")?;
    println!("✅ data/ directory ready");

    // 7. 완료 안내
    println!("\n✅ tiguclaw initialized at {}/", install_dir.display());
    println!("\nNext steps:");
    println!("  1. Edit {}/shared/USER.md with your info", install_dir.display());
    println!("  2. tiguclaw gateway install   # Register as a background service");
    println!("  3. Send /start to your bot to auto-register as admin");

    Ok(())
}

/// config.toml.example 파일 찾기
/// 우선순위: binary 옆 → current directory
fn find_config_example() -> Result<String> {
    // 1. binary 옆
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            let p = parent.join("config.toml.example");
            if p.exists() {
                return Ok(std::fs::read_to_string(p)?);
            }
        }
    }
    // 2. current directory
    if let Ok(s) = std::fs::read_to_string("config.toml.example") {
        return Ok(s);
    }
    anyhow::bail!(
        "config.toml.example not found.\n\
         Looked next to the binary and in the current directory.\n\
         Make sure the config.toml.example file is alongside the tiguclaw binary."
    )
}

fn prompt(label: &str) -> Result<String> {
    use std::io::Write;
    print!("{}: ", label);
    std::io::stdout().flush()?;
    let mut input = String::new();
    std::io::stdin().read_line(&mut input)?;
    Ok(input.trim().to_string())
}

fn prompt_with_default(label: &str, default: &str) -> Result<String> {
    use std::io::Write;
    print!("{} [{}]: ", label, default);
    std::io::stdout().flush()?;
    let mut input = String::new();
    std::io::stdin().read_line(&mut input)?;
    let s = input.trim().to_string();
    Ok(if s.is_empty() { default.to_string() } else { s })
}

// ─── TOML helpers ─────────────────────────────────────────────────────────────

fn load_toml_doc(path: &str) -> Result<toml_edit::DocumentMut> {
    let content = std::fs::read_to_string(path)
        .context(format!("failed to read {path}"))?;
    content
        .parse::<toml_edit::DocumentMut>()
        .context("failed to parse config.toml")
}

fn save_toml_doc(path: &str, doc: &toml_edit::DocumentMut) -> Result<()> {
    std::fs::write(path, doc.to_string()).context(format!("failed to write {path}"))
}

fn navigate_toml(
    doc: &toml_edit::DocumentMut,
    parts: &[&str],
) -> Option<String> {
    let mut cur: &toml_edit::Item = doc.as_item();
    for part in parts {
        cur = cur.get(part)?;
    }
    Some(cur.to_string().trim().to_string())
}

fn set_toml_value(
    doc: &mut toml_edit::DocumentMut,
    parts: &[&str],
    value: &str,
) -> Result<()> {
    if parts.len() == 1 {
        doc[parts[0]] = toml_edit::value(value);
        return Ok(());
    }

    // Navigate to the parent table
    let (parents, last) = parts.split_at(parts.len() - 1);
    let last = last[0];

    let mut cur = doc.as_table_mut();
    for part in parents {
        cur = cur
            .entry(part)
            .or_insert(toml_edit::Item::Table(toml_edit::Table::new()))
            .as_table_mut()
            .context(format!("'{part}' is not a table"))?;
    }

    // Try to preserve type: if existing value is bool/int, parse accordingly
    let existing = cur.get(last);
    let new_item = if let Some(existing_item) = existing {
        if existing_item.is_bool() {
            if let Ok(b) = value.parse::<bool>() {
                toml_edit::value(b)
            } else {
                toml_edit::value(value)
            }
        } else if existing_item.is_integer() {
            if let Ok(i) = value.parse::<i64>() {
                toml_edit::value(i)
            } else {
                toml_edit::value(value)
            }
        } else {
            toml_edit::value(value)
        }
    } else {
        toml_edit::value(value)
    };

    cur[last] = new_item;
    Ok(())
}

// ─── Backup ───────────────────────────────────────────────────────────────────

fn backup_now() -> Result<()> {
    use tiguclaw_core::backup::{run_backup, BackupResult, BackupStatus};
    use tiguclaw_core::Config;

    let config = Config::load(CONFIG_FILE)
        .map_err(|e| anyhow::anyhow!("config 로드 실패: {e}"))?;

    let config_dir = std::env::current_dir().context("현재 디렉토리 확인 실패")?;
    let backup_cfg = &config.backup;

    if !backup_cfg.enabled {
        println!("ℹ️  백업이 비활성화되어 있습니다 (config.toml: backup.enabled = false)");
        return Ok(());
    }

    // 소스/대상 경로 미리 계산 (출력용)
    let backup_root = if std::path::Path::new(&backup_cfg.backup_dir).is_absolute() {
        std::path::PathBuf::from(&backup_cfg.backup_dir)
    } else {
        config_dir.join(&backup_cfg.backup_dir)
    };

    // 오늘 날짜 (간단 계산)
    let today = {
        use std::time::{SystemTime, UNIX_EPOCH};
        let secs = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let days = secs / 86400;
        unix_days_to_ymd_cli(days as i64)
    };

    let data_dir = config_dir.join("data");
    let dest_dir = backup_root.join(&today);

    println!(
        "📦 Backing up {} → {}/",
        data_dir.display(),
        dest_dir.display()
    );

    let result = run_backup(&config_dir, backup_cfg);

    match result.status {
        BackupStatus::Success => {
            println!(
                "✅ Backup complete ({} files, {})",
                result.file_count,
                BackupResult::format_size(result.total_bytes)
            );
            for removed in &result.removed {
                println!("🗑️  Removed old backup: {}/{}", backup_cfg.backup_dir, removed);
            }
        }
        BackupStatus::Skipped => {
            println!(
                "ℹ️  {}",
                result.message.as_deref().unwrap_or("오늘 백업이 이미 있습니다")
            );
        }
        BackupStatus::Disabled => {
            println!("ℹ️  백업이 비활성화되어 있습니다");
        }
        BackupStatus::Error => {
            let msg = result.message.as_deref().unwrap_or("알 수 없는 오류");
            anyhow::bail!("백업 실패: {}", msg);
        }
    }

    Ok(())
}

/// YYYY-MM-DD 날짜 문자열 생성 (cli 전용 — core 의존 없이 동일 로직)
fn unix_days_to_ymd_cli(days: i64) -> String {
    fn is_leap(y: i64) -> bool {
        (y % 4 == 0 && y % 100 != 0) || (y % 400 == 0)
    }
    let mut y = 1970i64;
    let mut d = days;
    loop {
        let days_in_year = if is_leap(y) { 366 } else { 365 };
        if d < days_in_year { break; }
        d -= days_in_year;
        y += 1;
    }
    let leap = is_leap(y);
    let month_days: [i64; 12] = [31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let mut m = 1i64;
    for md in &month_days {
        if d < *md { break; }
        d -= md;
        m += 1;
    }
    format!("{:04}-{:02}-{:02}", y, m, d + 1)
}

// ─── Utility ──────────────────────────────────────────────────────────────────

fn print_output(out: &std::process::Output) {
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    if !stdout.is_empty() {
        print!("{stdout}");
    }
    if !stderr.is_empty() {
        eprint!("{stderr}");
    }
}
