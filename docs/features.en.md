# Full feature list

The README carries only **six** — the ones that answer "why not use something else."
Everything else lives here. Nothing was dropped.

[← README](../README.md) · [한국어](features.md)

## What it does

- **Claude Code's tools, as they are** — read/write/edit files, run shell, web search, skills, sub-agents, hooks, slash commands, persistent memory.
- **Many LLMs, one assistant** — `anthropic`, `openai`, `codex` (ChatGPT), `ollama` (local), and `google` (Gemini) ship built in, and **any OpenAI-compatible endpoint** (OpenRouter, Groq, vLLM, your own) drops in with three lines of config. Mix them with a single `provider:model` line. Switch freely and the abilities come along — shell, search, files, delegation all run on **the same tools whatever the model is**, so swapping models doesn't change the answer you get.
- **Always on** — runs as a background service and restarts itself if it ever dies.
- **Updates itself on request** — just ask it to update (or send `/update`). It pulls the latest, restarts, and pings you when it's back — no manual `git pull`. Your memory and sessions carry over, and if an update can't produce runnable code it rolls back and keeps running the previous version. When there's something to pull, the **dashboard tells you** in the top right, so you never have to go looking — click it and the page refreshes itself once the daemon is back.
- **Asks with buttons, not just text** — when it needs you to choose, it offers tappable options (Telegram and dashboard buttons, numbered in the CLI) — the same on every channel.
- **Talk, don't type** — send a voice note on Telegram or press-and-hold the mic in the dashboard; it transcribes and gets to work. Transcription is config-driven like everything else — a local model or a cloud one, your call.
- **Say something mid-task** — send a message while it's already working and it folds it into the turn in progress, instead of making you wait for the end or start over.
- **One personality, many channels** — Telegram, CLI, HTTP, and the web dashboard all reach the same assistant and share one conversation memory. Start on your phone, finish at your desk.
- **Delegates the heavy & the trivial** — hands a whole goal to a **manager** (which staffs it out as needed) so the chat stays free, and lighter work to a cheaper model tier. Which work lands on which tier is yours to set, in model profiles.
- **Several at once, and nothing forgotten** — it can start a handful of sub-agents and keep talking to you meanwhile. Whoever handed out the work **can't finish until the results are back**, so nothing gets dropped on the floor. Steer them mid-flight, or stop them.
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
  <img src="../assets/dashboard.png" alt="tiguclaw dashboard — chat, tool steps, background jobs panel" width="900">
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
- **Hooks that run on every model.** Drop a Claude Code-style `hooks` block in `settings.json` to observe or block tool calls (and gate turns), and the *same* config behaves identically whether the turn runs on `anthropic`, `codex`, or `openai`. See [Hooks](hooks.en.md).


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

## How it's built

- **Core** — one LLM runtime (adapter pool: claude / codex / openai / ollama / google) + router + SQLite store (sessions, memory, transcripts).
- **Channels** — Telegram / CLI / HTTP adapters render one abstract intent per channel.
- **Plugins** — scheduler (cron), file-watch, dashboard, http-bridge (dashboard API + the OpenAI-compatible gateway), self-growth (learns & proposes) — extend without touching the core.
- **Capabilities are data** — agents, skills, memory, and hooks under `<home>/` extend the assistant endlessly (a microkernel + plugin ecosystem).

---

Related — [Hooks](hooks.en.md) · [LLM gateway](gateway.en.md) · [Setup & operations](setup.en.md) · [Security](security.en.md)
