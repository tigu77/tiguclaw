# tiguclaw

[한국어](README.md) · **English**

Your always-on AI assistant. It does everything Claude Code does, and runs several LLMs at once. Telegram, the web dashboard, the CLI, HTTP — every door leads to the same assistant. It runs on your machine, with your keys and your bot.

<p align="center">
  <img src="assets/banner.jpg" alt="tiguclaw — Personal AI Agent OS" width="720">
</p>

**Just want to install it? → [Quick start](#quick-start)** (`npm ci`, then `npm run onboard`). Everything below is what it can do.

## What it does

- **Claude Code's tools, as they are** — read/write/edit files, run shell, web search, skills, sub-agents, hooks, slash commands, persistent memory.
- **Many LLMs, one assistant** — `anthropic`, `openai`, `codex` (ChatGPT), `ollama` (local), and `google` (Gemini) ship built in, and **any OpenAI-compatible endpoint** (OpenRouter, Groq, vLLM, your own) drops in with three lines of config. Mix them with a single `provider:model` line. Switch freely and the abilities come along — shell, search, files, delegation all run on **the same tools whatever the model is**, so swapping models doesn't change the answer you get.
- **Always on** — runs as a background service and restarts itself if it ever dies.
- **Updates itself on request** — just ask it to update (or send `/update`). It pulls the latest, restarts, and pings you when it's back — no manual `git pull`. Your memory and sessions carry over, and if an update can't produce runnable code it rolls back and keeps running the previous version.
- **Asks with buttons, not just text** — when it needs you to choose, it offers tappable options (Telegram and dashboard buttons, numbered in the CLI) — the same on every channel.
- **Talk, don't type** — send a voice note on Telegram or press-and-hold the mic in the dashboard; it transcribes and gets to work. Transcription is config-driven like everything else — a local model or a cloud one, your call.
- **Say something mid-task** — send a message while it's already working and it folds it into the turn in progress, instead of making you wait for the end or start over.
- **One personality, many channels** — Telegram, CLI, HTTP, and the web dashboard all reach the same assistant and share one conversation memory. Start on your phone, finish at your desk.
- **Delegates the heavy & the trivial** — hands long tasks to a background **manager** (so it stays chatty), and lighter work to a cheaper model tier. Which work lands on which tier is yours to set, in model profiles.
- **Learns as it works** — it turns its own repeated failures into operational lessons it follows next time, and when it spots a workflow worth reusing — even the first time it sees one — it offers to save it as a skill in the right place (project-local or shared). Always a proposal you approve — it never rewrites itself silently.
- **Notices its own trouble** — it sweeps its own recent history for things that went wrong quietly (a scheduled message that never arrived, a job that died) and tells you first. Where the fix is safe and reversible — resending that one message, say — it just does it and says so; anything else it brings to you.
- **When it stalls, it says so** — if a tool hangs with no response, it tells you on screen, and pings your Telegram if that's where you were talking. If nothing comes back it cuts the turn. No more wondering whether it's working or stuck.
- **Rename a conversation by asking** — "call this one 'billing refactor'" is enough. Handy once several conversations are running at once.
- **Your data stays home** — sessions, memory, and the database all live locally under `~/.tiguclaw`.
- **Ask from the dashboard, get pinged on Telegram** — flip 📤 in the composer to mirror replies to another channel, so long jobs that finish while you're away still reach your phone. **Reply to that message and it lands back in the conversation that produced it** — even when several conversations share one chat.
- **It suggests your next message** *(off by default)* — after a turn, a grey draft sits in the composer; Tab (or tap the input on mobile) fills it in. Sending is still yours. It costs a few tokens per turn, so you turn it on in **Settings**.
- **Outbound calls are logged too** — HTTP endpoints you opened and LLM gateway calls share one view. Not the content: just which model handled how many messages, with tokens, duration, and success.
- **Refresh without losing your place** — the view you were on, your session tabs, and the background panel all come back.

## What's different

Where it diverges from similar tools.

- **A web dashboard.** Watch the work happen step by step — reasoning and tool calls in the order they occur, edits with diffs and real file line numbers. Session tabs hold parallel conversations; a side panel tracks background jobs. Scrollback survives restarts, and the composer has shell-style ↑/↓ history and `#tags` for context.

<p align="center">
  <img src="assets/dashboard.png" alt="tiguclaw dashboard — chat, tool steps, background jobs panel" width="900">
  <br><sub>The web dashboard — every step as it happens, with managers and sub-agents running live in the side panel.</sub>
</p>

- **Works on a phone.** The dashboard has its own mobile layout rather than a shrunken desktop one — drawer navigation, master-detail panels, a chat input built for a phone keyboard. Check a long-running job or kick off a task from the couch, then finish it at your desk in the same conversation.
- **Projects.** Point at a folder and say "register this as a project", or skip the folder entirely — "let's start a project for X" and it creates the working folder for you. Either way it writes the `PROJECT.md` (description, status) and registers it; an existing one is used as-is. After that, `#name` is enough to mean that project, and its own skills, sub-agents, and MCP tools come along.
- **Connect any MCP server, on the fly.** Ask it to add an MCP server and it wires up those external tools — globally or scoped to a single project — without touching the core.
- **Model tiers you actually control.** Name model profiles — `default`, `high`, `mid`, `low` — as cross-provider pools with automatic fallback. The main turn runs one tier while sub-agents and managers run another; edit them just by asking, or list them with `/models`.
- **Watch the work happen.** Sub-agents and long-running managers run as tracked jobs you follow in the dashboard — status, steps, results.
- **Extend it by asking.** New slash commands, HTTP endpoints, scheduled jobs, reusable skills — it adds them as *data* under your home, never by patching the core (so updates stay clean).
- **Use it as your apps' LLM backend.** Point any OpenAI-compatible client at the built-in gateway (`POST /v1/chat/completions`, `GET /v1/models`) and your own app inherits the whole pool — cross-provider fallback, images in, tool calls passed straight through, streaming if you ask for it. One endpoint instead of one SDK per provider. Off until you set a gateway token, and it answers as *your app*, never as the assistant.
- **See what a turn costs — and what actually answered.** Every turn shows tokens in / out and the cache-hit rate right in the chat, so waste is visible instead of theoretical. Each reply, tool run, and background job is labelled with the model that *actually* produced it — which is not always the tier you asked for, once a rate limit sends work to a fallback. `/status` names any model that's cooling down.
- **Hooks that run on every model.** Drop a Claude Code-style `hooks` block in `settings.json` to observe or block tool calls (and gate turns), and the *same* config behaves identically whether the turn runs on `anthropic`, `codex`, or `openai`. See [Hooks](#hooks).

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
- "Scrape these 40 pages and build a table." → it hands the heavy work to a background manager and keeps chatting, then pings you when it's done.
- Routine, bulk, or simple tasks can go to a free local model — point a lower tier at `ollama` in your model profiles and that's where they land.

**Remember & schedule**
- "Remember that I prefer TypeScript and 2-space indents." → it persists across every chat.
- "Every weekday at 9am, send me a summary of X."
- "What did we decide about the database last week?"

**Make it yours — just by asking**
- "Add a `/standup` command that asks me three questions." → it registers the command (your Telegram menu updates live).
- "Expose an HTTP endpoint my other app can call to do X." → it wires it up, no changes to the core.
- "Turn this workflow into a reusable skill."

**Reach it anywhere** — your phone (Telegram), your terminal (CLI), or your own apps (HTTP). Same assistant, same memory.

> It has shell & file access to your machine, and **asks for your OK before anything destructive or irreversible** (see [`docs/security.en.md`](docs/security.en.md)).

## Quick start

You'll need **Node 20+**, **git**, one **LLM provider** (pick one below), and optionally a **Telegram bot**.

> ⚠️ Please read [`docs/security.en.md`](docs/security.en.md) first — the assistant gets shell & file access to *your* machine (the same self-chosen model as Claude Code).

**One line:**

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/tigu77/tiguclaw/main/install.sh | sh
```

```powershell
# Windows (PowerShell — no admin rights needed)
irm https://raw.githubusercontent.com/tigu77/tiguclaw/main/install.ps1 | iex
```

It clones, installs, and hands you straight to the setup wizard. Default location is `tiguclaw/` under your home — override it with `TIGUCLAW_DIR`. All you need is **Node.js 20+ and git**, and if it's already installed the script tells you instead of overwriting.

<details>
<summary><b>Prefer to do it yourself?</b> (same steps, by hand)</summary>

```bash
git clone https://github.com/tigu77/tiguclaw.git && cd tiguclaw
npm ci            # clean, reproducible install from the lockfile (or: npm install)
npm run onboard   # interactive setup → .env → (codex) login → service → health check
```
</details>

That's it. `onboard` walks you through everything: pick your LLM, paste a key (or drop in a Telegram bot token), and it writes the `.env`, registers the always-on service, and runs a health check. Then just **message your Telegram bot** and it replies. (Only the owner ID you entered is allowed — an empty allowlist keeps the bot locked.)

### Open the dashboard

The daemon starts the web dashboard for you — there is no separate command. Once it's running:

**http://127.0.0.1:7010**

That's the full chat UI: live tool steps, streaming replies, session tabs, the background-jobs panel. Change the port with `DASHBOARD_PORT` in your `.env` if 7010 is taken.

> **It's local-only on purpose.** The dashboard binds to `127.0.0.1`, and there's no browser login — the bridge token is injected server-side and never reaches the page, so *reaching the port is the permission*. To use it from your phone, don't open the port: tunnel it over a private network (e.g. `tailscale serve 7010`). Set `DASHBOARD_HOST=0.0.0.0` only if you know what that costs.

If the dashboard isn't there, the usual cause is a missing `HTTP_BRIDGE_TOKEN` — the daemon logs `dashboard: HTTP_BRIDGE_TOKEN not set … spawn skipped`. `npm run onboard` generates one; `npm run doctor` checks it.

### Pick a provider

You need one LLM. **Ollama** (free, local, no key), **Anthropic / OpenAI API keys**, a **Claude or ChatGPT subscription**, or **any OpenAI-compatible endpoint** (OpenRouter, Groq, vLLM…). `onboard` walks you through it, and switching later doesn't change what the assistant can do.

→ How to get each key, config examples, day-to-day commands, updating, and uninstalling all live in **[Setup & operations](docs/setup.en.md)**.

## How it's built

- **Core** — one LLM runtime (adapter pool: claude / codex / openai / ollama / google) + router + SQLite store (sessions, memory, transcripts).
- **Channels** — Telegram / CLI / HTTP adapters render one abstract intent per channel.
- **Plugins** — scheduler (cron), file-watch, dashboard, http-bridge (dashboard API + the OpenAI-compatible gateway), self-growth (learns & proposes) — extend without touching the core.
- **Capabilities are data** — agents, skills, memory, and hooks under `<home>/` extend the assistant endlessly (a microkernel + plugin ecosystem).

## Hooks

Hooks are shell commands the assistant runs at defined moments — to observe what it's doing, or to block an action before it happens. They use the **same `hooks` format as Claude Code's `settings.json`**, so if you already write Claude Code hooks, they carry straight over.

Five events are wired up:

| Event | When it fires | Typical use |
|---|---|---|
| `UserPromptSubmit` | before a turn starts | log or gate incoming prompts |
| `PreToolUse` | before a tool runs | **block** a tool call (e.g. deny writes to a path) |
| `PostToolUse` | after a tool returns | observe / audit tool results |
| `SubagentStop` | after a delegated sub-agent finishes | review or record delegated work |
| `Stop` | after a turn finishes | post-turn notifications or logging |

Each hook receives a small JSON payload on stdin (`tool_name`, `tool_input`, `cwd`, and so on). For `PreToolUse`, exit code `2` blocks the tool — the assistant sees your reason (on stderr) in place of the tool result and moves on. Any other non-zero exit is isolated and logged, so a broken hook never takes the daemon down.

Add a block to `<home>/settings.json`. The optional `matcher` is a regexp against the tool name (empty = every tool):

```jsonc
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          { "type": "command", "command": "~/.tiguclaw/hooks/guard-writes.sh" }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "~/.tiguclaw/hooks/audit.sh" }
        ]
      }
    ]
  }
}
```

A guard script might exit `2` to refuse any write outside a directory you allow:

```bash
#!/usr/bin/env bash
read -r payload
path=$(printf '%s' "$payload" | jq -r '.tool_input.file_path // empty')
case "$path" in
  "$HOME"/projects/*) exit 0 ;;              # allow
  *) echo "writes are only allowed under ~/projects" >&2; exit 2 ;;  # block
esac
```

A few things worth knowing:

- **The same config runs on every LLM.** One `settings.json` `hooks` block behaves identically whether the turn runs on `anthropic`, `codex`, or `openai` — a single hook engine drives all three, so there's nothing provider-specific to learn or maintain.
- **Per-project hooks.** Put the same block in `<project>/.tiguclaw/settings.json` and it fires only while the assistant works in that folder. If the project already has Claude Code hooks in `<project>/.claude/settings.json`, those are read as-is — nothing to copy over. The two layers **stack; they don't override** — a safety hook set globally can't be silently switched off by a project's settings.
- **You can watch them.** Hook runs show up in the dashboard's activity monitor (a blocked call is tinted red), and every registered hook is listed under the **🪝 Hooks** category in the dashboard inventory.

Hooks **observe and block** tool calls. On top of that, whatever a `UserPromptSubmit` or `PreToolUse` hook writes to stdout becomes **context the assistant reads** before deciding. One thing is still missing: **rewriting a tool's input**. That comes later.

## LLM gateway

Your own apps can borrow tiguclaw's provider pool over an **OpenAI-compatible API** — one endpoint instead of one SDK per provider, with the same cross-provider fallback the assistant runs on.

It's **off until you give it a token**. Add one to `<home>/.env`:

```bash
LLM_GATEWAY_TOKEN=<a long random string>
```

Then point any OpenAI client at the http-bridge port (`7011` by default, bound to `127.0.0.1`):

```bash
curl http://127.0.0.1:7011/v1/chat/completions \
  -H "Authorization: Bearer $LLM_GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "tier:high",
    "messages": [
      { "role": "system",  "content": "You are my app's assistant." },
      { "role": "user",    "content": "Summarize this in one line: …" }
    ]
  }'
```

| Route | What you get |
|---|---|
| `POST /v1/chat/completions` | Streaming with `"stream": true` (SSE chunks), images via `image_url`, and any `tools` you define passed straight through to the model. |
| `GET /v1/models` | The ids you can put in `model` — your named profiles as `tier:<name>`, plus the configured `provider:model` entries. |

`model` takes `provider:model` (`anthropic:claude-sonnet-5`), `tier:<profile>` for one of your named pools, or anything else to fall back to the gateway's default pool.

Tune it live in `<home>/settings.json` — re-read on every request, so nothing needs a restart:

```jsonc
{
  "gateway": {
    "enabled": true,        // kill switch — turns it off without removing the token
    "models": ["tier:high", "anthropic:claude-sonnet-5"],
    "maxConcurrency": 4     // beyond this the gateway returns 429, so a busy app can't starve the assistant
  }
}
```

Worth knowing:

- **It answers as your app, not as the assistant.** Your `system` message is used as-is; no tiguclaw persona, tools, skills, or memory ride along. Calls run in an isolated working directory, so nothing leaks even with no `system` message. (Account details the provider itself injects are outside tiguclaw's control.)
- **The call is logged; the content isn't.** Gateway calls never mix into your conversations, but they do appear in the dashboard's **external call log** — not what was said, just which model handled how many messages, with tokens, duration, and success, all on your machine.
- **Function calling works on a subscription.** Send `tools` and the model returns `tool_calls` without executing them — whichever adapter runs the turn, no API key required. `tool_choice` (`"none"`, `"required"`, or a named function) is enforced.
- **Every response is one of three things** — a tool call, text, or an explicit error. Never an empty success.
- **Call it from your app's server**, not from a browser: the token is a shared secret and the port listens on localhost only.
- **Prefer a different backend than your assistant's.** If your app hammers the same subscription the assistant lives on, you'll feel it in both.

## Principles

1. **Superset of Claude Code** — includes every Claude Code ability, then builds on top.
2. **Multiple LLMs at once** — a different model per task, same abilities regardless of adapter.
3. **Always on** — a persistent daemon that restarts itself.
4. **One personality across channels** — the same assistant wherever you reach it.
5. **Build only what's real** — keep the core minimal; everything else extends through data (conventions, prompts, skills, hooks, memory).

## Changelog

See [`CHANGELOG.md`](CHANGELOG.md) for release notes (this project follows [SemVer](https://semver.org/)).

## Credits

tiguclaw stands on the shoulders of a few open-source projects.

- **[OpenClaw](https://github.com/openclaw/openclaw)** (MIT, © Peter Steinberger)
  shaped much of the adapter and capability design — the codex OAuth adapter,
  skill discovery, and payload policy all follow patterns it pioneered.
- The harness meta-skill (a team of sub-agents with an orchestration layer) is
  **adapted from [revfactory/harness](https://github.com/revfactory/harness)**
  (Apache-2.0), modified to fit tiguclaw's home/skill model and its multi-LLM,
  sub-agent-only runtime.
- And of course tiguclaw is a superset of **Claude Code**, built on Anthropic's
  **Claude Agent SDK**.

Huge thanks to all of them.

## License

Apache License 2.0 — see [`LICENSE`](LICENSE).

> Releases up to v0.21.1 were MIT. Anything you took under those terms stays MIT; Apache-2.0 applies from the next release on.
