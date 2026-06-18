# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-06-18

First public release.

### Added
- **Always-on assistant** — runs as a background service (macOS launchd) and restarts itself.
- **Multi-LLM routing** — mix `anthropic`, `openai`, `codex` (ChatGPT), `ollama` (local), and `google` (Gemini) via a single `provider:model` line; same abilities across adapters.
- **One assistant across channels** — Telegram, CLI, and HTTP share one conversation memory.
- **Background worker** — long tasks run in the background so the assistant stays chatty.
- **Local sub-agents** (`nano` tier) — delegate simple tasks to a free local model.
- **Onboard wizard** (`npm run onboard`) — guided setup: pick a provider, paste keys, write `.env`, register the service, health check.
- **Doctor** (`npm run doctor`) — checks keys, bot reachability, home, and service.
- **`tiguclaw` CLI** — `status | restart | logs` from anywhere after `npm link`.
- **HTTP bridge** — call the assistant from other local apps; data-driven custom endpoints and commands.
- **Bilingual README** (English + 한국어) with step-by-step key/token guides and an uninstall guide.

[Unreleased]: https://github.com/tigu77/tiguclaw/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/tigu77/tiguclaw/releases/tag/v0.1.0
