# 🐯 tiguclaw

**Agent OS in Rust** — Spawn, orchestrate, and monitor AI agents via Telegram.

> One supermaster. Unlimited sub-agents. Real-time dashboard.

English | [한국어](README.ko.md)

## What is tiguclaw?

tiguclaw is a lightweight agent operating system written in Rust. It lets you run a hierarchy of AI agents (L0→L3) that can spawn each other, communicate via IPC, and be monitored through a web dashboard — all controlled from Telegram.

## Architecture

```
L0 Supermaster (you talk to this)
├── L1 Master agents (persistent, optional bot token)
│   ├── L2 Mini agents (internal IPC)
│   └── L3 Worker agents (ephemeral tasks)
└── Dashboard (real-time web UI)
```

## Features

- **Multi-level agent hierarchy** — L0~L3 roles with spawn/kill/steer
- **Telegram-native** — Chat with your agent army from your phone
- **Real-time dashboard** — WebSocket-powered web UI (React/Next.js)
- **Agent templates** — researcher, coder, hotdeal and custom templates
- **Context management** — `/new`, `/contexts`, `/save`, `/load` with retention
- **Auto-spawn** — Agents spawn sub-agents autonomously based on workload
- **Approval policy** — Control which operations need human sign-off
- **Model escalation** — Sonnet handles all requests; escalates to Opus automatically when complexity demands it
- **Prompt caching** — Anthropic cache for cost efficiency
- **Monitoring channel** — Broadcast events to a Telegram group
- **Hooks HTTP API** — `POST /hooks/agent` for external integrations

## Quick Start

```bash
# Prerequisites: Rust, SQLite
git clone https://github.com/tigu77/tiguclaw
cd tiguclaw
cp config.toml.example config.toml  # Edit with your tokens
cargo build --release
./target/release/tiguclaw
```

## Configuration

```toml
[agent]
name = "MyAgent"

[[channels]]
type = "telegram"
bot_token = "${TELEGRAM_BOT_TOKEN}"
admin_chat_id = 123456789
primary = true

[dashboard]
enabled = true
port = 3002
```

## Dashboard

The dashboard is a separate Next.js project in `tiguclaw-dashboard/`.

```bash
cd tiguclaw-dashboard
npm install && npm run build
NODE_ENV=production node server.js
# Open http://localhost:3000
# WebSocket + REST API proxied from tiguclaw :3002
```

## Slash Commands

| Command | Description |
|---------|-------------|
| `/spawn <label> <task>` | Spawn a sub-agent |
| `/agents` | List active agents |
| `/kill <label>` | Kill an agent |
| `/steer <label> <message>` | Redirect a sub-agent |
| `/send <label> <message>` | Send message to a sub-agent |
| `/new [name]` | Save context & start fresh |
| `/contexts` | List saved contexts |
| `/save <name>` | Save current context |
| `/load <name>` | Load a saved context |
| `/status` | Show stats & costs |
| `/templates` | List agent templates |

## Roadmap

- [x] Multi-level agent hierarchy (L0~L3)
- [x] Real-time web dashboard
- [x] Agent templates & auto-spawn
- [x] Context management with retention
- [ ] Agent marketplace
- [ ] Distributed agents across machines
- [ ] Discord / Slack channels

## License

MIT
