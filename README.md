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

### Install

```bash
git clone https://github.com/tigu77/tiguclaw
cd tiguclaw
bash install.sh   # builds & installs to ~/.local/bin
```

> **One-liner** (after the repo goes public):
> ```bash
> curl -fsSL https://raw.githubusercontent.com/tigu77/tiguclaw/main/install.sh | bash
> ```

### Setup (run once)

```bash
mkdir ~/.tiguclaw && cd ~/.tiguclaw
tiguclaw init     # interactive: bot token, API key, agent name
```

### Start

```bash
tiguclaw gateway install   # registers as a background service
```

## Architecture

```
tiguclaw (single binary)
├── Agent loop (L0 Supermaster)
│   ├── L1 Master agents (persistent, optional bot token)
│   │   ├── L2 Mini agents (internal IPC)
│   │   └── L3 Worker agents (ephemeral tasks)
├── REST API + WebSocket (axum, port 3002)
└── Dashboard (static files served from ~/.tiguclaw/dashboard/)
```

## Agent Structure

```
agents/
├── supermaster/
│   ├── agent.toml    ← role, level, allowed tools, limits
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
```

## Features

- **Multi-level agent hierarchy** — L0~L3 roles with spawn/kill/steer
- **Telegram-native** — Control your agent army from your phone
- **Real-time dashboard** — WebSocket-powered web UI, built-in (no Node.js required)
- **Hybrid memory search** — local embeddings (fastembed) + vector search (sqlite-vec) + BM25 + time decay
- **Built-in dashboard** — served directly by axum at `localhost:3002`, no separate process needed
- **Plugin-style dashboard** — swap or customize via `~/.tiguclaw/dashboard/`
- **Agent folder structure** — `agents/{name}/AGENT.md` + `agent.toml`
- **Shared context** — `shared/` folder injected into every agent's prompt
- **Hidden system prompt** — role, tools, and limits auto-injected at spawn
- **Personality packs** — swap tone and style without changing core logic
- **Context management** — `/new`, `/contexts`, `/save`, `/load` with retention
- **Auto-spawn** — Agents spawn sub-agents autonomously based on workload
- **Approval policy** — Control which operations need human sign-off
- **Model escalation** — Sonnet handles all requests; escalates to Opus when complexity demands
- **Prompt caching** — Anthropic cache for cost efficiency
- **Monitoring channel** — Broadcast events to a Telegram group
- **Hooks HTTP API** — `POST /hooks/agent` for external integrations

## Configuration

```toml
[agent]
name = "MyAgent"
spec = "agents/supermaster"

[[channels]]
type = "telegram"
bot_token = "${TELEGRAM_BOT_TOKEN}"
admin_chat_id = 123456789
primary = true

[dashboard]
enabled = true
port = 3002
```

See `config.toml.example` for the full configuration reference.

## Dashboard

The dashboard is built into tiguclaw and served at `http://localhost:3002`. No Node.js required.

To develop a custom dashboard:

```bash
cd dashboard && npm install && npm run dev
# Then set the env var to proxy to your dev server:
export TIGUCLAW_DEV_DASHBOARD=http://localhost:3001
```

You can also swap the dashboard entirely by placing your own static files in `~/.tiguclaw/dashboard/`.

## Slash Commands

| Command | Description |
|---------|-------------|
| `/spawn <label> <task>` | Spawn a sub-agent |
| `/agents` | List active agents |
| `/kill <label>` | Kill an agent |
| `/steer <label> <message>` | Redirect a sub-agent |
| `/send <label> <message>` | Send message to a sub-agent |
| `/specs` | List available agent specs |
| `/new [name]` | Save context & start fresh |
| `/contexts` | List saved contexts |
| `/save <name>` | Save current context |
| `/load <name>` | Load a saved context |
| `/status` | Show stats & costs |

## Roadmap

- [x] Multi-level agent hierarchy (L0~L3)
- [x] Real-time web dashboard (built-in, no Node.js)
- [x] Hybrid memory search (fastembed + sqlite-vec + BM25)
- [x] Agent folder structure + personality packs
- [x] Shared context (`shared/`)
- [x] Auto-spawn & approval policy
- [x] Context management with retention
- [ ] Agent marketplace (`tiguclaw market`)
- [ ] Distributed agents across machines
- [ ] Discord / Slack channels

## License

MIT — see [LICENSE](LICENSE)
