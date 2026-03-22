# 🐯 tiguclaw

<p align="center">
  <strong>Agent OS in Rust — spawn, orchestrate, and monitor AI agents via Telegram.</strong>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License"></a>
  <a href="https://www.rust-lang.org"><img src="https://img.shields.io/badge/built_with-Rust-orange?style=for-the-badge&logo=rust" alt="Built with Rust"></a>
  <img src="https://img.shields.io/badge/AI-LLM_Agnostic-blueviolet?style=for-the-badge" alt="LLM Agnostic">
</p>

> One supermaster. Unlimited sub-agents. Real-time dashboard.

[한국어](README.ko.md) · [Contributing](CONTRIBUTING.md) · [License](LICENSE)

---

## What is tiguclaw?

tiguclaw is a lightweight agent operating system written in Rust. Run a hierarchy of AI agents (L0→L3) that can spawn each other, communicate via IPC, and be monitored through a built-in web dashboard — all controlled from Telegram.

Think of it as a personal AI army: one supermaster you talk to, and unlimited specialized sub-agents it commands.

## Quick Start

### Prerequisites

- [Rust](https://rustup.rs)
- Telegram bot token ([@BotFather](https://t.me/BotFather))
- Anthropic API key ([console.anthropic.com](https://console.anthropic.com))

### Install & Init

```bash
curl -fsSL https://raw.githubusercontent.com/tigu77/tiguclaw/main/install.sh | bash
tiguclaw init   # interactive setup — offers gateway install when done
```

### Uninstall

```bash
curl -fsSL https://raw.githubusercontent.com/tigu77/tiguclaw/main/uninstall.sh | bash
```

## Architecture

```
tiguclaw (single binary)
├── L0 Supermaster (delegation_only — never blocks on sub-tasks)
│   ├── L1 Master agents (persistent, optional bot token)
│   │   ├── L2 Mini agents (internal IPC, escalate_to_parent on failure)
│   │   └── L3 Worker agents (ephemeral tasks)
├── REST API + WebSocket (axum, port 3002)
│   └── /hooks/agent · /hooks/steer · /hooks/escalate
└── Dashboard (timeline view + real-time WS, DB-persisted)
```

### Clearance Levels

Each agent has a **clearance** setting that controls tool access:

| Preset | Description |
|--------|-------------|
| `full` | All tools enabled — for trusted L0/L1 agents |
| `standard` | Default — balanced access for most agents |
| `minimal` | Restricted — for untrusted or ephemeral workers |

Set per-agent in `agent.toml`:
```toml
[agent]
clearance = "standard"   # full | standard | minimal
```

### Escalation Protocol

When an L2 agent fails or gets stuck, it automatically escalates:
1. L2 reports failure to L1 via `escalate_to_parent` tool
2. L1 assesses and either retries or escalates to L0
3. L0 decides: reassign, spawn new agent, or surface to human

## Agent Structure

```
agents/
├── supermaster/
│   ├── agent.toml    ← role, level, clearance, allowed tools, limits
│   └── AGENT.md      ← identity & capabilities
├── researcher/
├── coder/
└── analyst/

shared/               ← shared across all agents
├── CORE.md           ← common principles
├── USER.md           ← user profile
└── MEMORY.md         ← long-term memory summary

personalities/        ← swappable personality packs
├── gentle.md
└── concise.md

installed/            ← market-installed agent packs
```

## Features

- **Multi-level agent hierarchy** — L0~L3 roles with spawn/kill/steer
- **Clearance system** — full/standard/minimal presets, per-agent in `agent.toml`
- **Escalation protocol** — L2 failure → L1 report → L0 escalation via `escalate_to_parent`
- **L0 availability guarantee** — `delegation_only = true` ensures L0 is always responsive
- **Steer** — redirect a running agent mid-task (`/steer`, CLI, or dashboard)
- **Telegram-native** — Control your agent army from your phone
- **Timeline dashboard** — per-agent and global event flow, DB-persisted, real-time WS
- **Hybrid memory search** — local embeddings (fastembed) + vector search (sqlite-vec) + BM25 + time decay
- **DB auto-backup** — configurable retention, `tiguclaw backup` CLI
- **Agent marketplace** — `tiguclaw market` CLI, `[package]` spec, `installed/` structure
- **Channel context injection** — agents are told which channel they're operating in
- **Agent folder structure** — `agents/{name}/AGENT.md` + `agent.toml`
- **Shared context** — `shared/` folder injected into every agent's prompt
- **Personality packs** — swap tone and style without changing core logic
- **Context management** — `/new`, `/contexts`, `/save`, `/load` with retention
- **Auto-spawn** — Agents spawn sub-agents autonomously based on workload
- **Approval policy** — Control which operations need human sign-off
- **Model escalation** — Sonnet handles all requests; escalates to Opus when complexity demands
- **Prompt caching** — Anthropic cache for cost efficiency
- **Monitoring channel** — Broadcast events to a Telegram group
- **Hooks HTTP API** — `POST /hooks/agent` · `/hooks/steer` for external integrations

## Configuration

```toml
[agent]
name = "MyAgent"
spec = "agents/supermaster"
delegation_only = true   # L0: stay available, never block
clearance = "full"       # full | standard | minimal

[[channels]]
type = "telegram"
bot_token = "${TELEGRAM_BOT_TOKEN}"
admin_chat_id = 123456789
primary = true

[dashboard]
enabled = true
port = 3002

[backup]
enabled = true
retention_days = 7       # keep last N days of DB snapshots

[package]
name = "my-agent-pack"
version = "1.0.0"
description = "Custom agent pack for tiguclaw market"
```

See `config.toml.example` for the full configuration reference.

## Extensibility

tiguclaw is built on three core traits — everything is a plugin:

| Trait | Purpose | Built-in |
|-------|---------|---------|
| `Channel` | Messaging platform | Telegram |
| `Provider` | LLM backend | Anthropic (Claude) |
| `Tool` | Agent capabilities | shell, web_fetch, spawn_agent, escalate... |

Implement any trait to add your own:

```rust
// Custom channel (Discord, Slack, WhatsApp...)
impl Channel for MyChannel {
    fn name(&self) -> &str { "discord" }
    async fn send(&self, chat_id: &str, text: &str) -> Result<()> { ... }
    async fn listen(&self, tx: Sender<ChannelMessage>) -> Result<()> { ... }
}

// Custom tool
impl Tool for MyTool {
    fn name(&self) -> &str { "my_tool" }
    fn description(&self) -> &str { "Does something useful" }
    async fn execute(&self, args: &HashMap<String, Value>) -> Result<String> { ... }
}

// Custom LLM provider (OpenAI, Gemini, local...)
impl Provider for MyProvider {
    fn name(&self) -> &str { "openai" }
    async fn complete(&self, messages: &[Message], ...) -> Result<Response> { ... }
}
```

The dashboard UI is also swappable — place any static files in `~/.tiguclaw/dashboard/`.

## Dashboard

The dashboard is built into tiguclaw and served at `http://localhost:3002`. No Node.js required.

Features the **timeline view** — per-agent and global event streams with DB persistence and real-time WebSocket updates.

To develop a custom dashboard:

```bash
cd dashboard && npm install && npm run dev
export TIGUCLAW_DEV_DASHBOARD=http://localhost:3001
```

You can also swap the dashboard entirely by placing your own static files in `~/.tiguclaw/dashboard/`.

## Slash Commands

| Command | Description |
|---------|-------------|
| `/spawn <label> <task>` | Spawn a sub-agent |
| `/agents` | List active agents |
| `/kill <label>` | Kill an agent |
| `/steer <label> <message>` | Redirect a running agent |
| `/send <label> <message>` | Send message to a sub-agent |
| `/specs` | List available agent specs |
| `/new [name]` | Save context & start fresh |
| `/contexts` | List saved contexts |
| `/save <name>` | Save current context |
| `/load <name>` | Load a saved context |
| `/status` | Show stats & costs |

CLI equivalent: `tiguclaw steer <name> "<message>"`

## CLI Reference

| Command | Description |
|---------|-------------|
| `tiguclaw init` | Interactive setup (offers gateway install on completion) |
| `tiguclaw gateway install` | Register as background service |
| `tiguclaw backup` | Manual DB backup |
| `tiguclaw market` | Browse & install agent packs |
| `tiguclaw steer <name> "<msg>"` | Redirect a running agent |

## Roadmap

- [x] Multi-level agent hierarchy (L0~L3)
- [x] Real-time web dashboard (built-in, no Node.js)
- [x] Timeline dashboard (per-agent & global, DB-persisted, WS)
- [x] Hybrid memory search (fastembed + sqlite-vec + BM25)
- [x] Agent folder structure + personality packs
- [x] Shared context (`shared/`)
- [x] Auto-spawn & approval policy
- [x] Context management with retention
- [x] Clearance system (full / standard / minimal)
- [x] Escalation protocol (L2 → L1 → L0)
- [x] L0 availability guarantee (`delegation_only`)
- [x] Steer (mid-task redirect via CLI / hook / dashboard)
- [x] DB auto-backup + retention
- [x] Agent marketplace CLI (`tiguclaw market`)
- [x] Channel context injection
- [ ] tiguclaw-hub — community market repository (Phase 10, separate repo)
- [ ] Distributed agents across machines
- [ ] Discord / Slack channels

## License

MIT — see [LICENSE](LICENSE)
