# tiguclaw

**English** · [한국어](README.ko.md)

Your always-on AI assistant. Everything Claude Code can do — plus several LLMs at once, reachable from Telegram, CLI, or HTTP as a single assistant. You run it on your own machine, with your own keys and your own bot.

> Think of it as a Claude Code that never sleeps, chats with you on Telegram, and can switch between Claude, GPT, Gemini, or a free local model — all with the same skills.

<p align="center">
  <img src="assets/banner.png" alt="tiguclaw — Personal AI Agent OS" width="720">
</p>

## What it does

- **Everything Claude Code can do** — read / write / edit files, run shell, web search, skills, sub-agents, hooks, slash commands, persistent memory… and more on top.
- **Many LLMs, one assistant** — mix `anthropic`, `openai`, `codex` (ChatGPT), `ollama` (local), and `google` (Gemini) with a single `provider:model` line. Switch freely; same abilities everywhere.
- **Always on** — runs as a background service and restarts itself if it ever dies.
- **One personality, many channels** — Telegram, CLI, and HTTP all reach the same assistant, sharing one conversation memory.
- **Delegates the heavy & the trivial** — hands long tasks to a background worker (so it stays chatty), and simple tasks to a free local model (the `nano` tier).
- **Your data stays home** — sessions, memory, and the database all live locally under `~/.tiguclaw`.

## Things you can ask it

Talk to it like a capable teammate — from Telegram, the CLI, or HTTP. A few examples:

**Code & your machine**
- "Fix the failing test in `~/projects/api` and open a branch."
- "What's eating my disk space? Clean up the obvious junk." *(it asks before deleting anything)*
- "Read these files and explain how auth works."

**Research & writing**
- "Research today's AI news and send me a short digest."
- "Draft a reply to this message: …"
- "Compare two libraries for my use case and recommend one."

**Long jobs, without the wait**
- "Scrape these 40 pages and build a table." → it hands the heavy work to a background worker and keeps chatting, then pings you when it's done.
- Routine, bulk, or simple tasks can be delegated to a free local model.

**Remember & schedule**
- "Remember that I prefer TypeScript and 2-space indents." → it persists across every chat.
- "Every weekday at 9am, send me a summary of X."
- "What did we decide about the database last week?"

**Make it yours — just by asking**
- "Add a `/standup` command that asks me three questions." → it registers the command (your Telegram menu updates live).
- "Expose an HTTP endpoint my other app can call to do X." → it wires it up, no changes to the core.
- "Turn this workflow into a reusable skill."

**Reach it anywhere** — your phone (Telegram), your terminal (CLI), or your own apps (HTTP). Same assistant, same memory.

> It has shell & file access to your machine, and **asks for your OK before anything destructive or irreversible** (see [`docs/security.md`](docs/security.md)).

## Quick start

You'll need **Node 20+**, **git**, one **LLM provider** (pick one below), and optionally a **Telegram bot**.

> ⚠️ Please read [`docs/security.md`](docs/security.md) first — the assistant gets shell & file access to *your* machine (the same self-chosen model as Claude Code).

```bash
git clone https://github.com/tigu77/tiguclaw.git && cd tiguclaw
npm install
npm run onboard   # interactive setup → .env → (codex) login → service → health check
```

That's it. `onboard` walks you through everything: pick your LLM, paste a key (or drop in a Telegram bot token), and it writes the `.env`, registers the always-on service, and runs a health check. Then just **message your Telegram bot** and it replies. (Only the owner ID you entered is allowed — an empty allowlist keeps the bot locked.)

### Pick a provider

| Provider | How |
|---|---|
| **Ollama (local)** | No key, free, offline. Just install Ollama. (Smaller models, lower quality.) |
| **Anthropic API key** | Grab one at console.anthropic.com — easiest, pay-as-you-go. |
| **Claude subscription** | Use your Claude Pro/Max plan — run `claude setup-token` (no API key, no per-token billing). |
| **OpenAI API key** | platform.openai.com — pay-as-you-go. |
| **codex (ChatGPT subscription)** | After install, run `npm run codex-auth` to log in. |

### Getting your keys & tokens

Step-by-step — you only need the provider you picked (+ a Telegram bot if you want chat). `onboard` prompts you for each and shows these hints inline.

**Telegram bot token** (the chat interface)
1. In Telegram, open **[@BotFather](https://t.me/BotFather)** → send `/newbot`.
2. Give it a display name, then a username ending in `bot` (e.g. `my_assistant_bot`).
3. BotFather replies with a token like `123456:ABC-DEF…` — copy it.
4. *(Recommended — lock to 1:1)* send `/setjoingroups` → **Disable**, and `/setprivacy` → **Enable**.

**Your Telegram user ID** (the owner allowlist)
- Easiest: during `onboard`, just send your bot one message — it auto-detects your ID.
- Manual: message **[@userinfobot](https://t.me/userinfobot)** — it replies with your numeric `Id`.

**Anthropic API key** (`sk-ant-…`)
1. Sign in at **console.anthropic.com**.
2. **Settings → API Keys → Create Key** → name it → copy (shown only once).
3. Add credit under **Plans & Billing** (pay-as-you-go).

**Claude subscription** (use your Claude Pro/Max plan instead of an API key)
1. Install the Claude Code CLI, then run **`claude setup-token`**.
2. Log in in the browser — it prints a long-lived token; copy it.
3. Paste it as `CLAUDE_CODE_OAUTH_TOKEN` (the wizard's **claude-sub** option, or in `.env`). No per-token billing — it runs on your subscription.

**OpenAI API key** (`sk-…`)
1. Sign in at **platform.openai.com**.
2. **API keys → Create new secret key** → copy.
3. Add credit under **Billing**.

**Google Gemini key** (optional)
1. Go to **aistudio.google.com** → **Get API key → Create API key** → copy. (Generous free tier.)

**codex (ChatGPT subscription)** — *no key to paste*
- After install, run `npm run codex-auth`: it opens a login URL → sign in to ChatGPT → approve. The token is saved and auto-refreshed. (Needs a ChatGPT Plus/Pro subscription.)

**Ollama (local)** — *no key*
1. Install from **ollama.com** (`brew install ollama` on macOS).
2. Pull a model: `ollama pull llama3.2` (or `ollama pull qwen2.5:7b` for better quality).

### Day to day

- **Control it from anywhere** — `onboard` runs `npm link` for you, so `tiguclaw status | restart | logs | doctor | uninstall` work from any folder, like a real app. *(Inside the repo, `npm run daemon:*` works too.)*
- **Manage the service** (same commands on macOS / Linux / Windows): `npm run daemon:status | daemon:restart | daemon:logs`.
- **Something off?** `npm run doctor` checks your keys, bot reachability, home, and service.

A few notes:

- Your `.env` holds the bot token & LLM keys — **never commit or share it** (it's already gitignored).
- LLM usage is **billed to you** (your keys / subscription).
- `npm run daemon:install` registers the always-on service per OS:
  - **macOS** → launchd (auto-restart on crash, starts at login).
  - **Linux** → systemd **user** service (`Restart=always`). To run on boot without logging in: `loginctl enable-linger $USER`.
  - **Windows** → Task Scheduler (starts at logon). KeepAlive is weaker than launchd; for full parity run under **WSL2**.
  - KeepAlive strength, honestly: macOS > Linux > Windows. The management commands above are the same on all three.

### Uninstall

1. **Stop & remove the service** — `npm run daemon:uninstall` (works on macOS launchd / Linux systemd user / Windows Task Scheduler).
2. **Delete your data** — ⚠️ irreversible (sessions, memory, DB, agents, skills): `rm -rf ~/.tiguclaw` (or whatever `TIGUCLAW_HOME` points to).
3. **Remove the global command** (only if you ran `npm link`) — `npm rm -g tiguclaw`.
4. **Delete the project folder** — `rm -rf tiguclaw`.
5. *(Optional)* Revoke externals — delete the bot in **@BotFather** (`/deletebot`), revoke API keys in their consoles, and `ollama rm <model>` for any local models you pulled.

## How it's built

- **Core** — one LLM runtime (adapter pool: claude / codex / openai / ollama / google) + router + SQLite store (sessions, memory, transcripts).
- **Channels** — Telegram / CLI / HTTP adapters render one abstract intent per channel.
- **Plugins** — scheduler (cron), file-watch, dashboard, http-bridge — extend without touching the core.
- **Capabilities are data** — agents, skills, memory, and hooks under `<home>/` extend the assistant endlessly (a microkernel + plugin ecosystem).

## Principles

1. **Superset of Claude Code** — includes every Claude Code ability, then builds on top.
2. **Multiple LLMs at once** — a different model per task, same abilities regardless of adapter.
3. **Always on** — a persistent daemon that restarts itself.
4. **One personality across channels** — the same assistant wherever you reach it.
5. **Build only what's real** — keep the core minimal; everything else extends through data (conventions, prompts, skills, hooks, memory).

## Changelog

See [`CHANGELOG.md`](CHANGELOG.md) for release notes (this project follows [SemVer](https://semver.org/)).

## License

MIT — see [`LICENSE`](LICENSE).
