# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- Guideline: prefer the minimal structure when adding automation — fold related rollups (e.g. weekly/monthly summaries) into one routine that handles them by date, instead of a separate schedule per cadence.
- Guideline: when unsure what/where/how to act (ambiguous target, intent, or structure), confirm first instead of guessing — added to the assistant's required confirmation triggers.
- Guideline cleanup: the assistant authors approved skills directly (a skill is just a markdown file); the harness meta-skill is reserved for building multi-agent teams/orchestration. Removes a self-contradiction in the operating rules.

### Fixed
- Dashboard mobile chat: smaller, fixed header (subtitle hidden) with the message list scrolling on its own and the input pinned to the bottom — the header no longer scrolls away or eats the screen.

## [0.2.1] - 2026-06-30

### Changed
- **Proactive skill proposals** — the assistant now offers to save a workflow as a skill the moment it recognizes a clearly reusable one (by judgment, even on first sight), instead of only after it repeats. It also picks the right scope — a project-local skill for project/folder-specific work, a shared skill for general use. Still always a proposal you approve; never silent self-editing. Complements the existing frequency-based detection.

## [0.2.0] - 2026-06-30

### Added
- **Interactive dashboard chat** (Claude-Code-style) — live step-by-step progress as it works (each step shows what it touched), token streaming, clickable option buttons, and conversation history that survives restarts with scroll-back pagination.
- **Background tasks panel** — a side drawer that tracks background jobs (status, steps, and results) so you can watch long work without leaving the chat.
- **Self-update** — `update_self` tool + `/update` command: pulls the latest, gates on typecheck, auto-rolls-back on failure, and restarts.
- **Self-growth** — learns from its own mistakes and proposes reusable skills / skill improvements for you to approve (never silent self-editing).
- **Out-of-band restart** — Telegram `/restart` and a dashboard button to recover a stuck turn.
- **Per-tool activity for local/Gemini models** — openai-agents adapter parity, so tool steps are visible for `ollama`/`google` too.
- **Observability event sink** — persists observability events as an audit/metrics base.

### Changed
- Dashboard chat: newest message at the top, local date dividers, and time-only timestamps on each message.
- Scheduled (cron) messages now appear in the dashboard chat and history, not just on the destination channel.
- Worker delegation guidance refined (induce, don't force); codex history compaction via rolling summary (preserve instead of truncate) with an input-proportional first-token timeout.

### Fixed
- Windows: `/restart` respawn without a supervisor, `/update` `npm.cmd` ENOENT, and onboard/service registration without admin rights.
- Daemon hard backstop so a hung tool can't freeze the channel poller (fixes a multi-hour outage); crash-fast safety net for unhandled errors.
- Cross-platform `Glob`/`Grep` via bundled ripgrep; codex MCP tool timeout; HTTP bridge resource leak; `send_file` dedup recorded only on a successful send.

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

[Unreleased]: https://github.com/tigu77/tiguclaw/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/tigu77/tiguclaw/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/tigu77/tiguclaw/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/tigu77/tiguclaw/releases/tag/v0.1.0
