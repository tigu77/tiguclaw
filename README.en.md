# tiguclaw

[한국어](README.md) · **English**

Your always-on AI assistant. It does everything Claude Code does, and runs several LLMs at once. Telegram, the web dashboard, the CLI, HTTP — every door leads to the same assistant. It runs on your machine, with your keys and your bot.

> Think of it as a Claude Code that never sleeps, chats with you on Telegram, and can switch between Claude, GPT, Gemini, or a free local model — all with the same skills.

<p align="center">
  <img src="assets/banner.jpg" alt="tiguclaw — Personal AI Agent OS" width="720">
</p>

**Just want to install it? → [Quick start](#quick-start)** (`npm ci`, then `npm run onboard`). Everything below is what it can do.

## What it does

- **Everything Claude Code can do** — read / write / edit files, run shell, web search, skills, sub-agents, hooks, slash commands, persistent memory… and more on top.
- **Many LLMs, one assistant** — `anthropic`, `openai`, `codex` (ChatGPT), `ollama` (local), and `google` (Gemini) ship built in, and **any OpenAI-compatible endpoint** (OpenRouter, Groq, vLLM, your own) drops in with three lines of config. Mix them with a single `provider:model` line. Switch freely and the abilities come along — shell, search, files, delegation all run on **the same tools whatever the model is**, so swapping models doesn't change the answer you get.
- **Always on** — runs as a background service and restarts itself if it ever dies.
- **Updates itself on request** — just ask it to update (or send `/update`). It pulls the latest, restarts, and pings you when it's back — no manual `git pull`. Your memory and sessions carry over, and if an update can't produce runnable code it rolls back and keeps running the previous version.
- **Asks with buttons, not just text** — when it needs you to choose, it offers tappable options (Telegram and dashboard buttons, numbered in the CLI) — the same on every channel.
- **Talk, don't type** — send a voice note on Telegram or press-and-hold the mic in the dashboard; it transcribes and gets to work. Transcription is config-driven like everything else — a local model or a cloud one, your call.
- **Say something mid-task** — send a message while it's already working and it folds it into the turn in progress, instead of making you wait for the end or start over.
- **One personality, many channels** — Telegram, CLI, HTTP, and a built-in web dashboard all reach the same assistant, sharing one conversation memory. The dashboard is a full chat: live step-by-step progress as it works (each step shows what it touched), replies that stream in, and scrollback that survives restarts. A side panel tracks background jobs — their status, steps, and results — so you can watch long work without leaving the conversation.
- **Delegates the heavy & the trivial** — hands long tasks to a background worker (so it stays chatty), and lighter work to a cheaper model tier. Which work lands on which tier is yours to set, in model profiles.
- **Learns as it works** — it turns its own repeated failures into operational lessons it follows next time, and when it spots a workflow worth reusing — even the first time it sees one — it offers to save it as a skill in the right place (project-local or shared). Always a proposal you approve — it never rewrites itself silently.
- **Notices its own trouble** — it sweeps its own recent history for things that went wrong quietly (a scheduled message that never arrived, a job that died) and tells you first. Where the fix is safe and reversible — resending that one message, say — it just does it and says so; anything else it brings to you.
- **When it stalls, it says so** — if a tool hangs with no response, it tells you on screen, and pings your Telegram if that's where you were talking. If nothing comes back it cuts the turn. No more wondering whether it's working or stuck.
- **Rename a conversation by asking** — "call this one 'billing refactor'" is enough. Handy once several conversations are running at once.
- **Your data stays home** — sessions, memory, and the database all live locally under `~/.tiguclaw`.

## Highlights

A few things that set it apart from a plain chatbot:

- **A real web dashboard, not just a log.** Open it in your browser and watch the assistant think and act in real time — reasoning and tool steps interleaved in the order they happen (like Claude Code's web app), rich tool cards with diffs and output (edits show the actual file line numbers), and scrollback that survives restarts. The chat input has shell-style ↑/↓ history, per session tab. Parallel conversations live in session tabs (reorder them, drafts kept per tab). A side panel tracks background jobs with per-step timelines; tap to answer multiple-choice prompts, reply to a specific message, or steer with `#tags`.
- **It fits in your pocket.** The dashboard is a real mobile UI, not a squeezed desktop one — drawer navigation, master-detail panels, a chat input that behaves on a phone keyboard. Check a long-running job or kick off a task from the couch, then finish it at your desk in the same conversation.
- **Projects.** Point it at a folder with a `PROJECT.md` and it picks up that project's own skills, sub-agents, and MCP tools — delegate work per-project, each with exactly the right capabilities.
- **Connect any MCP server, on the fly.** Ask it to add an MCP server and it wires up those external tools — globally or scoped to a single project — without touching the core. Full Claude Code MCP parity, and then some.
- **Model tiers you actually control.** Name model profiles — `default`, `high`, `mid`, `low` — as cross-provider pools with automatic fallback. The main turn runs one tier while sub-agents and workers run another; edit them just by asking, or list them with `/models`.
- **Watch the work happen.** Sub-agents and long-running workers run as tracked jobs you follow in the dashboard — status, steps, results. It's Claude Code's Task tool, made observable.
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
- "Scrape these 40 pages and build a table." → it hands the heavy work to a background worker and keeps chatting, then pings you when it's done.
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

| Provider | How |
|---|---|
| **Ollama (local)** | No key, free, offline. Just install Ollama. (Smaller models, lower quality.) |
| **Anthropic API key** | Grab one at console.anthropic.com — easiest, pay-as-you-go. |
| **Claude subscription** | Use your Claude Pro/Max plan — run `claude setup-token` (no API key, no per-token billing). |
| **OpenAI API key** | platform.openai.com — pay-as-you-go. |
| **codex (ChatGPT subscription)** | After install, run `npm run codex-auth` to log in. |
| **Anything OpenAI-compatible** | OpenRouter, Groq, Together, vLLM, your own endpoint — add it in `settings.json`, no code. See below. |

#### Adding an OpenAI-compatible provider

Any endpoint that speaks the OpenAI API works as a first-class provider — you don't
write an adapter, you write three lines. Put this in `<home>/settings.json`:

```json
{
  "models": {
    "providers": {
      "openrouter": {
        "adapter": "openai",
        "baseURL": "https://openrouter.ai/api/v1",
        "apiKeyEnv": "OPENROUTER_API_KEY"
      }
    }
  }
}
```

Then set `OPENROUTER_API_KEY` in your `.env` and use it anywhere a model is named:
`openrouter:anthropic/claude-sonnet-5`, in a model profile pool, as a fallback target.
OpenRouter alone puts a few hundred models one line away.

Notes: the key lives in your environment, never in the file (`apiKeyEnv` is the variable
*name*). Built-in provider names can't be redefined — writing `anthropic` here is ignored,
so a stray config can't quietly reroute a trusted name somewhere else. An `adapter` other
than `openai`, `claude`, or `codex-oauth` is rejected rather than half-working.

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

- **Control it from anywhere** — `onboard` runs `npm link` for you, so `tiguclaw status | restart | stop | start | update | logs | doctor | uninstall` work from any folder, like a real app. **`update` doubles as the repair command** — see [Updating](#updating). *(Inside the repo, `npm run daemon:*` works too.)*
- **Manage the service** (same commands on macOS / Linux / Windows): `npm run daemon:status | daemon:restart | daemon:stop | daemon:start | daemon:logs`.
- **Pause vs remove** — `daemon:stop` stops the process but keeps it registered (it still auto-starts at next login); `daemon:start` resumes it. `daemon:uninstall` removes the registration entirely.
- **Something off?** `npm run doctor` checks your keys, bot reachability, home, and service.

**Teaching it your rules.** Say *"from now on, always X"* and it writes that into `AGENT.md` in your
runtime home — its identity file, and the one place your standing instructions live. Anything there
is loaded on **every** turn, so it can't quietly fall out of scope. Facts you only need occasionally
(schedules, links, numbers) go to memory instead, and details about one project belong in that
project's own folder. The rule of thumb it follows: *does this need to be there every single turn?*
— if not, it moves the detail down and keeps a pointer.

A few notes:

- Your `.env` holds the bot token & LLM keys — **never commit or share it** (it's already gitignored).
- LLM usage is **billed to you** (your keys / subscription).
- Install with **`npm ci`** for a clean, reproducible setup — it installs exactly from `package-lock.json` and won't modify it. `npm install` works too but may tweak the lockfile locally; no need to commit those changes.
- `npm run daemon:install` registers the always-on service per OS:
  - **macOS** → launchd (auto-restart on crash, starts at login).
  - **Linux** → systemd **user** service (`Restart=always`). To run on boot without logging in: `loginctl enable-linger $USER`.
  - **Windows** → registry Run key (HKCU — **no admin needed**; starts at logon, runs hidden). No crash-restart; for full KeepAlive run under **WSL2**.
  - KeepAlive strength, honestly: macOS > Linux > Windows. The management commands above are the same on all three.
- **Lifecycle always works, even if deps break** — install / uninstall / restart / stop / start / **update** run on plain Node (no build step, no `tsx`), so you can stop, remove, or **repair with `tiguclaw update`** even when `node_modules` is broken or missing.
- **If something is broken, `tiguclaw update` is the one command.** It stops the daemon, runs `npm ci`, rebuilds, and starts again — rolling back if any step fails. ★Don't run `npm ci` yourself: while the daemon is running it holds the native module file (`EPERM`), so the install silently leaves you without it. That's how a working setup gets broken. Stopping first is exactly why `update` exists.

### Updating

Just **ask it** — "update yourself" (or send `/update`). It pulls the latest code, restarts, and pings you when it's back. Your memory, sessions, and settings carry over — updates only touch the code, never your data. If an update can't produce runnable code, it rolls back and keeps running the previous version (you're never left with a dead daemon).

Prefer the terminal? Run **`tiguclaw update`** — it does the same thing (stop → pull → `npm ci` → rebuild → start, rolling back on failure), and it still works when the daemon won't even boot.

★Don't run `git pull` or `npm ci` by hand. Miss one step — especially `npm ci` without stopping first — and the native module won't install, leaving the daemon unable to start. `update` knows the order.

### Reinstalling & runtime mode

**Reinstall / repair** — just re-run `npm run onboard` (or `npm run daemon:install`); it overwrites the service registration in place. Handy after moving the repo folder or if the service ever gets into a bad state — it's safe and leaves your data untouched.

**Runtime mode** — `npm run onboard` installs the **compiled build** by default: it compiles to `dist/` for you and runs `node dist/src/index.js` — fast startup, no on-the-fly transpile. Nothing extra to do.

If you'd rather run straight from **TypeScript source** — no build step, and updates apply the instant they're pulled (handy while developing) — install with `TIGUCLAW_RUNTIME=source`:

```bash
TIGUCLAW_RUNTIME=source npm run onboard
```

The mode is pinned when you install, so it never changes on its own — updates keep whichever mode you chose (a built install recompiles automatically, a few extra seconds per update). To switch later, set `TIGUCLAW_RUNTIME` and re-run the install.

### Uninstall

1. **Stop & remove the service** — `npm run daemon:uninstall` (works on macOS launchd / Linux systemd user / Windows registry Run).
2. **Delete your data** — ⚠️ irreversible (sessions, memory, DB, agents, skills): `rm -rf ~/.tiguclaw` (or whatever `TIGUCLAW_HOME` points to).
3. **Remove the global command** (only if you ran `npm link`) — `npm rm -g tiguclaw`.
4. **Delete the project folder** — `rm -rf tiguclaw`.
5. *(Optional)* Revoke externals — delete the bot in **@BotFather** (`/deletebot`), revoke API keys in their consoles, and `ollama rm <model>` for any local models you pulled.

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

- **It answers as your app, not as the assistant.** Your `system` message is used as-is — no tiguclaw persona, no tools, no skills, no memory — and gateway calls never show up in your conversations or dashboard. Calls run in an isolated working directory, so nothing leaks even if you send no `system` message. (Account details the LLM provider itself injects are outside tiguclaw's control.)
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
