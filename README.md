<!-- TODO: replace with assets/demo.gif — goal in → manager wires up sub-agents → result, under 30s -->

# tiguclaw

**English** · [한국어](README.ko.md)

[![CI](https://img.shields.io/github/actions/workflow/status/tigu77/tiguclaw/ci.yml?branch=main&label=CI)](https://github.com/tigu77/tiguclaw/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/tigu77/tiguclaw)](https://github.com/tigu77/tiguclaw/releases)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-green)](https://nodejs.org)

**The more agents you add, the more you have to manage.**
tiguclaw is an always-on AI assistant built so that **you only ever talk to one of them**.
You state the goal; the assistant assembles whatever organization it needs. On your machine, with your keys and your bot.

<p align="center">
  <img src="assets/banner.jpg" alt="tiguclaw — Personal AI Agent OS" width="720">
</p>

**Want it running now → [Quick start](#quick-start)** (download, run `onboard` once, done).

## Demo

<!-- TODO: assets/demo.gif — record: goal in → manager wires up sub-agents → result, under 30s.
     Until then the dashboard screenshot stands in. -->

<p align="center">
  <img src="assets/dashboard.png" alt="tiguclaw dashboard — chat, tool steps, background work panel" width="900">
  <br><sub>The web dashboard — every step as it happens, with managers and sub-agents running in the right-hand panel.</sub>
</p>

## Why this exists

The better AI tools get, the more there is for a person to manage. You create agents, define roles,
decide who gets what, pick models, run them in parallel, re-run the failures, collect the results.
At that point the AI isn't doing your work — **you have become the manager of an AI organization.**

tiguclaw goes the other way. You talk to **one assistant** and state a goal. The organization is
assembled by the assistant, sized to the goal.

## Who owns what

```text
you ──goal──▶ main assistant ──┬──▶ manager ──┬──▶ sub-agent
                               │              ├──▶ sub-agent
              result ◀─────────┤              └──▶ sub-agent
                               └──▶ sub-agent
```

- **Main assistant — owns the relationship.** The one you keep talking to. It holds context, memory
  and projects, and decides whether to do the work itself or hand it off.
- **Manager — owns the goal.** Not a background worker for slow jobs but a **field commander**: it
  splits the goal itself, attaches sub-agents, reads what comes back and judges whether the goal is
  met. **It does not finish before collecting results** — that is enforced by the core, not requested.
- **Sub-agent — owns one task.** Research, implementation, verification; hands it back to its caller.

Depth **stops here.** A manager cannot spawn another manager, and a sub-agent cannot spawn anyone.
Wide as needed, never deeper — a deliberate limit against runaway cost, blurred responsibility, and
"no idea when this ends."

The default is **watching**. You can see who is doing what in the dashboard and steer or stop them.
But the goal finishing without you is the default.

## Quick start

You need **Node 20+**, **git**, **one LLM provider** (below), and optionally a **Telegram bot**.

> ⚠️ Please read [`docs/security.en.md`](docs/security.en.md) first — the assistant can reach *your*
> shell and files (the same self-selecting model as Claude Code), and **asks for your OK before
> anything destructive or irreversible**.

```bash
# macOS · Linux
curl -fsSL https://raw.githubusercontent.com/tigu77/tiguclaw/main/install.sh | sh
```

```powershell
# Windows (PowerShell — no admin rights needed)
irm https://raw.githubusercontent.com/tigu77/tiguclaw/main/install.ps1 | iex
```

Download, install, and the setup wizard, in one go. Default location is `tiguclaw/` under your home —
override with `TIGUCLAW_DIR`. All it needs is **Node.js 20+ and git**; if they're already there it
won't overwrite, it tells you. (Stick to an LTS — **20 · 22 · 24**. Prebuilt native binaries track LTS,
so odd-numbered releases may require C++ build tools.)

<details>
<summary><b>Prefer to do it yourself</b> (same thing, by hand)</summary>

```bash
git clone https://github.com/tigu77/tiguclaw.git && cd tiguclaw
node bin/tiguclaw.mjs onboard   # installs dependencies too — this one line is all of it
```

`onboard` installs dependencies first if they're missing (no separate `npm ci`). Once it finishes you
get a global `tiguclaw` command, and from then on **`tiguclaw update`** pulls, installs, builds and
restarts in one step.
</details>

That's it. `onboard` walks you through everything: pick an LLM, paste a key (or a Telegram bot token),
`.env`, the always-on service, and verification. Then **message your Telegram bot** and it answers.
(Only the owner ID you entered is allowed — an empty allowlist locks the bot.)

### Open the dashboard

The daemon starts the web dashboard for you — there's nothing extra to run. While it's up:

**http://127.0.0.1:7010**

That's the full chat UI: tool steps live, streaming answers, session tabs, background work panel.
If 7010 is taken, change `DASHBOARD_PORT` in `.env`.

> **Local-only on purpose.** The dashboard binds to `127.0.0.1` and has no browser login — the bridge
> token is injected server-side and never reaches the page, so **reaching this port is the permission**.
> To use it from your phone, don't open the port; tunnel over a private network (e.g. `tailscale serve 7010`).
> `DASHBOARD_HOST=0.0.0.0` only if you know the trade.
>
> If you reach it remotely by **name** (e.g. MagicDNS `*.ts.net`), add that name to
> `DASHBOARD_ALLOWED_HOSTS` in `.env` — that's the DNS-rebinding guard. **Reaching it by IP needs
> no configuration.** If you forget, the 403 tells you exactly what to add.

If the dashboard isn't there, the usual cause is a missing `HTTP_BRIDGE_TOKEN` — the daemon logs
`dashboard: HTTP_BRIDGE_TOKEN not set … spawn skipped`. `npm run onboard` generates one and
`npm run doctor` verifies it.

### Pick a provider

You need one LLM. **Ollama** (free, local, no key), **Anthropic / OpenAI API keys**, **Claude or
ChatGPT subscriptions**, and **any OpenAI-compatible endpoint** (OpenRouter, Groq, vLLM…) all work.
`onboard` asks and guides; switching later doesn't change what the assistant can do.

→ Keys, config examples, day-to-day commands, updating and uninstalling live in
**[Setup & operations](docs/setup.en.md)**.

**If something's off**, run `tiguclaw doctor` first — it checks keys, home, service, native modules and
the global command, and tells you what to do about whatever it finds. Still stuck? Open an
[issue](https://github.com/tigu77/tiguclaw/issues/new/choose). For security problems use
[SECURITY](.github/SECURITY.md), not a public issue.

## What it does

Six things. Everything else is in [the full feature list](docs/features.en.md).

1. **Always on** — runs as a background service, restarts itself when it dies, and updates itself when
   you ask ("update yourself" or `/update`), rolling back if the new code won't build.
2. **Same assistant wherever you come in** — Telegram, CLI, HTTP, web dashboard. One identity, shared
   memory. Start on your phone, finish at your desk.
3. **Hand over whole goals** — big work goes to a **manager** that assembles its own sub-agents and
   isn't done until it has collected results. Your conversation keeps going meanwhile.
4. **Many LLMs, one surface** — `anthropic`, `openai`, `codex` (ChatGPT), `ollama` (local), `google`,
   plus any OpenAI-compatible endpoint. Cross-provider fallback, and the same tools on every model.
5. **Extend by asking** — new slash commands, HTTP endpoints, scheduled work and reusable skills are
   added as *data* under your home, without patching the core.
6. **Your data stays on your machine** — sessions, memory and DB all local (`~/.tiguclaw`).

It also speaks **Claude Code's formats directly**: the same tools, the same `settings.json` `hooks`
block, and the same skill layout — existing ones carry over unchanged.

## Read next

| | |
|---|---|
| [Setup & operations](docs/setup.en.md) | Keys, config, everyday commands, updating, uninstalling |
| [Full feature list](docs/features.en.md) | Everything not in the six above |
| [Hooks](docs/hooks.en.md) | Observe or block tool calls — Claude Code `hooks` format |
| [LLM gateway](docs/gateway.en.md) | Use tiguclaw as the OpenAI-compatible backend for your own apps |
| [Security](docs/security.en.md) | What the assistant can reach, and what it asks before doing |
| [Code map](docs/code-map.md) · [Core boundaries](docs/core-boundaries.md) | What lives where; boot, routing, permissions |
| [Contributing](CONTRIBUTING.md) | How changes land |

## Principles

The first question before building anything: **does this create something new for the user to manage?**
If it does, we look again at whether the assistant or a manager can carry it instead. Rather than making
agents easier to manage, make them **not need managing**; rather than adding model choices, let it choose;
rather than shipping a workflow editor, let the plan fall out of the goal. Sensible defaults before settings.

1. **Don't grow what you have to manage** — the question above, applied to every feature.
2. **Always on** — a daemon that restarts itself.
3. **One assistant across channels** — whichever channel you come in through.
4. **Many LLMs at once** — a different model per job, same capabilities regardless of adapter.
5. **Build only the real work** — a minimal core; everything else extends as data (conventions,
   prompts, skills, hooks, memory).

## Changelog

Release notes are in [`CHANGELOG.md`](CHANGELOG.md). This project follows [SemVer](https://semver.org/).

## Credits

tiguclaw stands on a few open-source projects.

- **[OpenClaw](https://github.com/openclaw/openclaw)** (MIT, © Peter Steinberger)
  — shaped much of the adapter and capability design. The codex OAuth adapter, skill discovery and
  payload policy all follow patterns OpenClaw laid down.
- The harness meta-skill (sub-agent teams + orchestration) is **adapted and ported from
  [revfactory/harness](https://github.com/revfactory/harness)** (Apache-2.0), reworked for tiguclaw's
  home/skill model and its multi-LLM, sub-agent runtime.
- And tiguclaw is built on Anthropic's **Claude Agent SDK**, supporting **Claude Code**'s tool, hook
  and skill formats.

Deep thanks to all three.

## License

Apache License 2.0 — see [`LICENSE`](LICENSE).

> Up to v0.21.1 this was MIT. Versions you took then stay usable under MIT; Apache-2.0 applies from
> that point on.
