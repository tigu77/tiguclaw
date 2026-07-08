# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.31] - 2026-07-08

### Added
- **A built-in `code-review` skill for debugging and code review.** When you ask "why is this bug happening", "review this code", or "is this fix okay?", the assistant now follows a consistent method: pin the *root cause* (not the symptom) by tracing the code path, then — crucially — check whether the *same root cause* also affects adjacent fields/paths (so it doesn't fix one bug and leave its siblings), propose a minimal fix that matches the codebase's existing idioms, and add a short, optional note on a more robust direction. Correctness first, brevity always.

### Changed
- **Sub-agent model tiers now follow the provider you chose at install.** Previously the `high`/`mid`/`low` tiers were hardcoded to Anthropic models regardless of your provider — so a codex- or OpenAI-only install had its sub-agent tiers pointing at Claude models it might have no key for. New installs now set the tiers to the chosen provider (Anthropic/claude-sub keep the opus/sonnet/haiku spread; OpenAI and codex default to their own models), and you can still refine them in `.env`.
- **The default model pool is now a last-resort fallback for a misconfigured tier.** If a sub-agent's tier points at a provider you have no credentials for, the run now falls back once to your `REGION_A_MODELS` default pool (with a notice) instead of failing. This only triggers on configuration errors (unknown model · missing credentials) — genuine runtime faults (stalls, hangs, timeouts) are never masked, so a backend defect still surfaces instead of silently switching models.
- **The "tool is taking a while" warning is now OS-neutral and points at the right cause.** It previously said "macOS permission dialog", which was misleading on Windows and didn't mention that an external MCP tool can hang when its server is connected but the target app/editor isn't running. The warning (and the background-worker ping) now say so.

### Fixed
- **The dashboard chat no longer shows a false "timeout" error on long turns.** A long-running turn (e.g. a multi-minute codex answer) could make the chat give up and show a timeout while the real answer was still on its way over the live stream. The chat now shows a "working…" indicator and waits for the streamed reply instead of falsely erroring.

## [0.3.30] - 2026-07-07

### Changed
- **The assistant now reliably reaches for a project's dedicated skills and agents.** Its operating guidance still said project-specific skills/agents "weren't wired up" — stale since 0.3.26 — which could stop it from using them. It now correctly discovers and uses them via the folder path (`project_capabilities`, and `spawn_agent` / `invoke_skill` with a `path`), while common (home) capabilities always remain available.

## [0.3.29] - 2026-07-07

### Added
- **Registering a folder with no `PROJECT.md` now writes one for you.** When you ask the assistant to register a folder as a project and it has no `PROJECT.md`, it briefly analyzes the folder (key files, structure, purpose), drafts a `PROJECT.md` (name · description · status, plus notes), registers it, and tells you what it named and summarized the project as — which you can adjust. An existing `PROJECT.md` is never overwritten.

## [0.3.28] - 2026-07-07

### Added
- **The Runtime Inventory view is now a clean, expandable list.** Channels, plugins, skills, agents, and MCP servers each show as a one-line row — name and a layer badge collapsed — and clicking a row expands it in place to reveal a short description plus its source path and metadata. MCP entries are tagged in-process vs. external so you can see connected external MCP servers at a glance.
- **The dashboard chat now labels the assistant with its own name.** The name comes from your `AGENT.md` (the `이름`/`name` field), falling back to `tiguclaw` when none is set — so if you give your assistant a name, it shows up in the chat instead of a hardcoded label.

### Fixed
- **The Runtime Inventory view no longer resets every ~30 seconds.** A background refresh was rebuilding the whole list on a timer, collapsing any rows you had expanded and losing your scroll position; the refresh now only rebuilds when the inventory actually changed.

## [0.3.27] - 2026-07-07

### Added
- **Connect external MCP servers by just asking.** New `add_mcp_server` / `list_mcp_servers` / `remove_mcp_server` tools let the assistant register any standard MCP server — an stdio command (e.g. `npx -y @modelcontextprotocol/server-github`) or an SSE URL — into `<home>/mcp.json` from a normal conversation, with no config-file editing. After a restart the server connects and its tools become available to the assistant on **both the Claude and the codex/openai backends** (the assistant connects it natively on Claude, and via the standard MCP client on the others). Because adding a server runs an arbitrary command and exposes its tools, the assistant confirms with you before registering one. Previously external MCP servers were only listed in the dashboard, never actually connected.

## [0.3.26] - 2026-07-07

### Added
- **Delegate work scoped to a project folder — no "entering" required.** `spawn_agent`, `invoke_skill`, and `run_in_background` now take an optional `path`: point any of them at a folder and the sub-agent / skill / background worker runs in that folder's context — its dedicated agents and skills are discovered there, and relative file operations are resolved against it. Give different `path`s in one turn and the work fans out across projects in parallel. The assistant stays stateless — instead of switching into a project, it names the folder per task. A new `project_capabilities(path)` tool lists a folder's dedicated agents (with model tier) and skills plus the `PROJECT.md` summary, so the assistant knows what it can delegate there. Relative file paths now resolve against the working folder consistently across the Claude and codex adapters.
- **See which agents are working in each project.** A project's detail panel now shows its live agent/worker cards — the same rich cards as the Agents view (kind, model tier, status, one-line task, current step, elapsed, expandable) — split into "in progress" and "recent" sections, so you can watch what's running for that project. Each project card also shows a "🤖 N running" badge, and `run_in_background(path=…)` workers are attributed to their project too.
- **Find skills and agents by keyword when you have a lot of them.** New `find_skills(query)` / `find_agents(query)` tools search by name and description. The prompt's capability index is now capped (showing the most-used first) and points to search for the rest, so a large library of skills/agents no longer grows the prompt every turn.

### Fixed
- **`related` in `PROJECT.md` now works as a YAML list too.** Previously only the single-line comma form (`related: A, B`) was parsed; related projects written as a bullet list (`- ../other`) were silently dropped. Both forms now resolve and appear as clickable chips in the project detail.

## [0.3.25] - 2026-07-07

### Added
- **Projects — register folders as projects and see them in the dashboard.** Mark any folder as a project by adding a `PROJECT.md` (frontmatter: `name` · `description` · `status` · `related`), then register it — the assistant manages the registry with new `project_register` / `project_list` / `project_update` / `project_forget` tools (both adapters). The dashboard gains a "Projects" view: a grid of project cards (name + status), and clicking one opens a side panel with the full description, the project's **dedicated skills and agents** (discovered from its `skills/` and `agents/` folders), and any related projects. The registry is a thin index — the source of truth is each folder's `PROJECT.md`, so it travels with the folder. (This first phase surfaces and manages projects; a follow-up will let you *enter* a project so its dedicated skills/agents activate for the conversation.)

## [0.3.24] - 2026-07-06

### Fixed
- **A fresh install could report "SELF_GROWTH.md not found."** The self-growth plugin adds a note reminding the assistant to read `SELF_GROWTH.md` at the start of a task, but that file is only created once the first learned directive is written — so on a brand-new instance with no directives yet, the assistant would follow the pointer to a file that didn't exist. The plugin now seeds an empty `SELF_GROWTH.md` (header only) on startup, so the pointer never dangles.

## [0.3.23] - 2026-07-06

### Fixed
- **The dashboard "Agents" view could show an empty list under the "All" tab even when the count said there were jobs.** The running/all toggle updated the count but didn't clear the running-only CSS filter, so completed jobs stayed hidden. Switching to "All" now shows them.
- **Smoothed out rendering jank in the agents/background panels** when many events arrive at once — the view now coalesces re-renders to one per frame instead of rebuilding on every event.

### Added
- **Job cards now show what each one is working on, and can be expanded.** Every agent/worker card shows a one-line task summary under its name — so multiple same-named sub-agents (e.g. several `quick` fan-outs) are distinguishable — and clicking a card expands it to reveal the full task, the result or error, and its step timeline.

## [0.3.22] - 2026-07-06

### Added
- **Built-in general-purpose sub-agents (`quick`, `general`) — delegate small tasks cheaply without writing a spec.** `quick` runs on a low (cheap, fast) model tier for small jobs like summarize/extract/transform — ideal for fanning out many at once — and `general` is a mid-tier catch-all. The assistant is now nudged to reach for `quick` for small independent sub-tasks, so bulk simple work runs on a cheap model in parallel without you authoring any agent files. Sub-agents you define still use the tier in their own spec. (`nano`/local tier is only used when you explicitly ask.)
- **A sub-agent's model tier is now visible** — shown as a chip on the agent card in the dashboard and next to each entry in `/agents`, so you can see which grade (low/mid/high) each running sub-agent is on.

## [0.3.21] - 2026-07-04

### Changed
- **The assistant now fans out independent sub-agents in parallel on its own.** With parallel execution in place (0.3.19), the system prompt now nudges the assistant to spawn several sub-agents at once for independent sub-tasks — matching Claude Code's behavior. Ask it to summarize three unrelated documents and it runs them concurrently rather than one at a time, without you having to say "in parallel"; sub-tasks that depend on each other still run in order. Applies to both the codex and Claude adapters.

## [0.3.20] - 2026-07-04

### Fixed
- **"Cancel" could target a running sub-agent by mistake, sending a false "cancelled" notice and flipping the job's status.** After workers and sub-agents were unified into one job registry (0.3.17), the cancel path didn't distinguish them: cancelling by name/id could match a sub-agent job, which has no real abort hook — so you'd get a "🛑 cancelled" reply while the sub-agent kept running, and its later completion would overwrite the state back to "done". Cancellation is now restricted to background workers only (both in the core `cancelJob` and the cancel tool); asking to cancel a sub-agent returns a clear explanation instead. (Sub-agents still appear in the list — only cancellation is worker-only.)
- **A failed Claude sub-agent was recorded as "done" instead of "failed."** The Claude adapter ignored the tool-result error flag, so a sub-agent that failed still showed as completed — inconsistent with the codex adapter, which records failures. The error flag is now read, so a failed sub-agent is marked failed on both adapters.

## [0.3.19] - 2026-07-04

### Changed
- **Codex tool calls (and sub-agents) now run in parallel within a turn.** The codex adapter previously executed a turn's tool calls one at a time, so delegating to several sub-agents at once (fan-out) ran them serially — noticeably slower than the Claude adapter, which parallelizes. A turn's independent tool calls now execute concurrently (matching the Claude adapter and Claude Code), so multiple sub-agents and tools run at the same time. Result ordering, per-tool timeouts, slow-tool warnings and error handling are all preserved, and single-tool turns behave exactly as before. Safe concurrent tool dispatch relies on the per-turn tool-server isolation shipped in 0.3.16.

## [0.3.18] - 2026-07-03

### Added
- **A dedicated "Agents" view in the dashboard, and an `/agents` command** — see what your assistant is running in the background at a glance. The dashboard's left sidebar now has an "Agents" entry (with a live count of in-progress jobs) that opens a view listing every running background job — workers and sub-agents alike — with its type, name, elapsed time and current step, plus a running/all toggle. On Telegram, `/agents` (also added to the command menu) replies instantly with the same summary, with no LLM round-trip. Both are built on the unified job model from 0.3.17 and add no new endpoints.

## [0.3.17] - 2026-07-03

### Added
- **Sub-agents are now visible in the dashboard as background jobs, with their per-step activity.** Previously only detached background workers (`run_in_background`) showed up; sub-agents (delegated via `spawn_agent` / the Task tool) ran invisibly inline, so a long-running sub-agent looked like the assistant had simply gone quiet. Now each running sub-agent appears as its own job card — labelled with the sub-agent's name and showing its tool steps — for both the codex and Claude adapters (Claude sub-agent steps are recovered from the SDK stream via `parent_tool_use_id`). Sub-agents still return their result to the parent exactly as before; only observability was added. Workers and sub-agents are now unified under a single job model (`worker_jobs.kind = worker | agent`), with re-injection, worker timeouts, cancellation and restart-recovery kept exclusive to detached workers.

## [0.3.16] - 2026-07-03

### Fixed
- **Background jobs (and sub-agents) could hang indefinitely on their very first tool call.** Each in-process tool server (file operations, memory, to-dos) was a single shared instance that every model turn connected fresh and closed when it ended. When a turn spawned a background worker and then finished, its cleanup closed that shared instance out from under the still-running worker — so the worker's next tool call (e.g. a file read) waited forever for a reply that never came, stalling the whole job for 8–11 minutes per call until a timeout. Each turn now gets its own tool-server instances, so one turn's cleanup can no longer break another turn's concurrent tool calls. (This aligns those three servers with the pattern the other nine in-process servers already used.)

### Added
- **Optional MCP bridge tracing for diagnosing tool-call stalls** (`MCP_BRIDGE_TRACE=1`, off by default): logs each tool call's send/receive with a per-request id and the in-flight count, so a tool call that never returns is directly visible in the log.

## [0.3.15] - 2026-07-03

### Fixed
- **Dashboard background-job steps duplicated on every refresh — looking like an infinite loop.** Worker step lines weren't de-duplicated, so each time the page reconnected (a refresh replays the recent event buffer) the same steps were appended again, stacking up until it looked like the job was repeating the same actions forever. Steps are now de-duplicated by sequence, so a refresh no longer multiplies them. (The job wasn't actually looping — only the rendering was.)

### Added
- **Streaming model output is now traceable for after-the-fact diagnosis** — for interactive turns *and background workers/sub-agents*. Previously only a completed turn's final text was saved (in transcripts), and streaming was only observable for the main chat (never for background jobs), so a stuck or looping worker's narration was invisible. The token stream is now written to the log as low-volume coalesced snapshots (a `[stream-trace]` line roughly every 12 seconds or 1500 characters, per thread), for every turn including workers.
- **A stuck background job now tells you it's stuck** — instead of looking like a mysterious slowdown for tens of minutes. When a tool call on the `codex` line runs longer than a threshold (default 90s, `CODEX_TOOL_SLOW_WARN_MS`) — well before the hard 8-minute timeout — it's logged as `[tool-slow]`, and for a background job you also get a one-time notification: *"the job is stuck on tool X — check whether a permission dialog is waiting on your Mac."* This turns a silent block on a **macOS permission prompt** (or a hung/slow tool) into an actionable heads-up in seconds.

## [0.3.14] - 2026-07-03

### Fixed
- **Dashboard background-job cards missing their status badge (and the header count not updating) when the page was opened while a job was already running.** A job card can be built either from the job's start/finish lifecycle events or from its live activity. Only the lifecycle path set the status label ("🟡 running") and refreshed the header "background N" count — so if the dashboard connected mid-job (e.g. a refresh while a job runs) it only saw activity, and the card showed no status and the header count stayed empty. Card creation now sets a default running status and refreshes the count, regardless of which path created it.

## [0.3.13] - 2026-07-03

### Fixed
- **The `codex` (ChatGPT) model line no longer lets one pathologically slow response consume an entire background job.** The stall guard resets every time any answer text streams in, so if the backend dribbles output *very* slowly (a token every couple of minutes), a single turn could crawl for 10–20 minutes without the guard ever firing — and a multi-step job would hit the 30-minute wall-clock limit with nothing to show (observed live during a ChatGPT-backend slowdown). A single response turn now also has an absolute wall-clock cap (default 10 minutes, `CODEX_TURN_MAX_MS`): if one turn exceeds it — regardless of trickle — the step is retried from the same context (not switched to another model), so a spiky slowdown can recover instead of eating the whole budget. This is orthogonal to the existing no-progress guard (which still catches dead connections at 5 minutes).

### Changed
- **Dashboard shows a subtle pulse on in-progress indicators** — running background-job cards, the background-tasks badge count, and the currently-running step now gently pulse so it's obvious something is actively working. Respects `prefers-reduced-motion`.

## [0.3.12] - 2026-07-03

### Fixed
- **A hung tool call on the `codex` (ChatGPT) model line no longer freezes a background job for up to 30 minutes.** The stream-stall guard only watches the model's streaming response, and tool execution was deliberately exempt (to avoid killing legitimately long tools). But that left a gap: if a tool call itself hung, nothing caught it until the blunt 30-minute worker wall-clock limit — losing all the work with nothing to show (observed live: a maintenance job frozen ~19 minutes inside a shell command). Each tool call now has its own generous wall-clock timeout (default 8 minutes): if it's exceeded, that one call is turned into a tool error so the job keeps going and the model adapts, instead of the whole turn freezing. Tunable via `CODEX_TOOL_TIMEOUT_MS`. (The Claude line already had this via its SDK — this restores parity.)

## [0.3.11] - 2026-07-03

### Fixed
- **The `codex` (ChatGPT) model line now finishes large multi-step tasks instead of stopping partway with a "here's what I got done" report.** Background jobs like a daily wiki/library cleanup — which legitimately need dozens of tool calls (read many files, write several summaries, scan, etc.) — were hitting an internal 25-tool-call cap every run: the model was forced to wrap up mid-task, and the next day's run started over from scratch and never converged. The cap was doing double duty (runaway defense *and* task-completion signal); those are now separated. Runaway protection is handled by the progress-aware stall guard and the wall-clock turn backstop (which cut only genuine no-progress, not legitimately long work), so the tool-iteration limit is raised to a far safety ceiling (default 150) and the task now ends *naturally when the model is actually done* — matching how the Claude line already behaves (an LLM-agnostic parity fix). Tunable via `CODEX_MAX_TOOL_ITERATIONS_HARD`; `CODEX_MAX_TOOL_ITERATIONS` is now a soft progress-checkpoint interval.

## [0.3.10] - 2026-07-03

### Changed
- **`/update` is now robust to environment quirks — it never gets blocked by the on-instance typecheck.** Three times in a row the self-update typecheck step broke for environment reasons (Windows `npm.cmd`, `tsc` not on PATH, TypeScript absent on production installs), and each time the safety rollback undid a *perfectly good* pull — so the deterministic gate was blocking legitimate updates instead of catching broken code. The typecheck is now **advisory**: it still runs and logs its result when `tsc` is available, but it never rolls back or aborts the update. Every published release is already typechecked upstream (clean-room + plugin-load verification), so the on-instance re-check was redundant defense that only added brittleness. The update now always applies when the pull and dependency install succeed. (`git pull` failures and `npm install` failures still roll back — those are genuine "can't update", not environment noise.) This matches why natural-language "update yourself" was already reliable while the `/update` command was fragile.

## [0.3.9] - 2026-07-02

### Fixed
- **`/update` no longer fails on installs without the TypeScript dev-dependency** (e.g. production installs or `NODE_ENV=production`, where `npm install` omits dev-deps). The update was aborting with `Cannot find module .../typescript/bin/tsc` because the typecheck safety-gate needs `tsc`. Now the gate runs only when `tsc` is present and is skipped with a warning otherwise (published releases are already typechecked upstream), so the update proceeds instead of being permanently blocked. `npm install` also now includes dev-deps, so the gate re-enables once dependencies change.

## [0.3.8] - 2026-07-02

### Added
- **Self-growth learns from background-task failures.** When a background job fails, the assistant analyzes the cause and proposes a fix — improve a skill, adjust a prompt/setting, redesign the task (e.g. make it incremental so partial progress survives), or flag a core-code issue for the developer. Everything is a suggestion you approve; nothing is auto-applied or self-edited. (Failure signals are gated and de-duplicated so a rare failure doesn't spam.)

## [0.3.7] - 2026-07-02

### Fixed
- **The `codex` (ChatGPT) model line could hang or spin without recovering** — a background task or reply would stall for the whole 30-minute cap and then fail with nothing to show, losing the work. The stream is now guarded on *actual progress*: as long as answer text or tool calls are flowing it's never interrupted, but if only "still thinking" heartbeats arrive with no real output for a few minutes (a dead connection or a thinking-loop), the current step is aborted and **retried from the same context** (not switched to another model), so the work continues instead of failing. Applies to both background workers and interactive replies. Workers also send a brief "resuming…" note. Tunable via `CODEX_NO_PROGRESS_MS` / `CODEX_STALL_MAX_RETRIES`.

### Changed
- Dashboard now shows a persistent scrollbar in the chat and side panels (previously the OS overlay scrollbar auto-hid, making it hard to tell there was more to scroll).

## [0.3.6] - 2026-07-01

### Internal
- Removed one more piece of duplicated logic (no behavior change): the four plugins that subscribe to the event bus each repeated the same "unsubscribe safely on stop" idiom; it's now a single shared helper.

## [0.3.5] - 2026-07-01

### Internal
- Removed duplicated logic (no behavior change): the Telegram "format → split → send with plain-text fallback" flow, previously copied across four send paths, is now one helper; the system-context assembly order, previously replicated in all three model adapters (which must stay identical for cross-model parity), is now a single shared builder that structurally enforces the ordering.

## [0.3.4] - 2026-07-01

### Changed
- Proactive messages the assistant sends outside a normal reply — background-worker completions, restart/update notifications — now show up in the dashboard chat and history like everything else. Previously each of these send paths was implemented separately and only some recorded the message, so they were invisible on the dashboard. They now go through a single outbound path, so delivery and dashboard visibility are consistent.

### Internal
- Consolidated duplicated logic: one outbound helper (channel routing + send + observability) instead of per-feature copies across the scheduler, file-watch, worker, and restart/update paths; one Telegram `tg:<chatId>` parser instead of five copies. No behavior change beyond the dashboard-visibility fix above.

## [0.3.3] - 2026-07-01

### Fixed
- **`/update` could get permanently stuck** with `error: Your local changes to the following files would be overwritten by merge: package-lock.json`. `package-lock.json` is regenerated by `npm install` and drifts across platforms/npm versions, which blocked the `git pull --ff-only` that self-update relies on — so the daemon could no longer update itself. Self-update now discards local drift in that one generated file before pulling (your own uncommitted changes to any other file are still left untouched, so a genuine conflict is still reported honestly). If an instance is already stuck, run one natural-language "update yourself" first — the assistant reconciles it — after which `/update` works again.

## [0.3.2] - 2026-07-01

### Fixed
- **Scheduler plugin failed to load** (regression in 0.3.1) — a stray quote in the `add_schedule` help text broke the plugin's parse, so it silently didn't start and **every cron and reboot schedule stopped firing**. Fixed the string. Upgrade from 0.3.1 as soon as possible.

### Added
- **Built-in restart notification** — after any restart (`/restart`, a crash, or an automatic supervisor restart) the assistant sends a `✅ 재시작 완료` message to your most recent chat, with zero setup (it uses the last active conversation, so there's nothing to configure at install time). If you already run your own reboot-notification schedule, the built-in stays quiet so you don't get duplicates.

### Internal
- Release gate now parse-checks every plugin entrypoint (`verify:plugins`). Plugins are loaded at runtime and were outside `tsc`'s scope, which is how the 0.3.1 scheduler breakage slipped through.

## [0.3.1] - 2026-07-01

### Fixed
- Windows `/update` typecheck gate — ran `tsc` directly via node instead of through `npm run` so the update no longer fails with "'tsc' is not recognized" on Windows.
- Fixed-message notification schedules (e.g. a restart alert) no longer arrive with a spurious "message sent" report or a "shall I send it?" prompt. The `add_schedule` guidance now steers the assistant to phrase such schedules as *reply with exactly this text* — which the scheduler delivers — instead of *send this message*, which tripped the external-send confirmation and tacked a completion narration onto the alert.

### Changed
- Dashboard chat is back to the standard order — newest message at the bottom, opening pinned to the bottom (scroll up for history). Also a smaller top bar on mobile.

## [0.3.0] - 2026-06-30

### Added
- Dashboard labels each sub-agent's activity with its name (e.g. `🤖 researcher`) so you can tell who did what in a multi-agent turn.
- Background shell commands for the codex/openai model lines — `Bash(run_in_background)` + `BashOutput` (poll) + `KillShell`, matching what the Claude line already has. Long builds/servers/scripts run without blocking the conversation.

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

[Unreleased]: https://github.com/tigu77/tiguclaw/compare/v0.3.31...HEAD
[0.3.31]: https://github.com/tigu77/tiguclaw/compare/v0.3.30...v0.3.31
[0.3.30]: https://github.com/tigu77/tiguclaw/compare/v0.3.29...v0.3.30
[0.3.29]: https://github.com/tigu77/tiguclaw/compare/v0.3.28...v0.3.29
[0.3.28]: https://github.com/tigu77/tiguclaw/compare/v0.3.27...v0.3.28
[0.3.27]: https://github.com/tigu77/tiguclaw/compare/v0.3.26...v0.3.27
[0.3.26]: https://github.com/tigu77/tiguclaw/compare/v0.3.25...v0.3.26
[0.3.25]: https://github.com/tigu77/tiguclaw/compare/v0.3.24...v0.3.25
[0.3.24]: https://github.com/tigu77/tiguclaw/compare/v0.3.23...v0.3.24
[0.3.23]: https://github.com/tigu77/tiguclaw/compare/v0.3.22...v0.3.23
[0.3.22]: https://github.com/tigu77/tiguclaw/compare/v0.3.21...v0.3.22
[0.3.21]: https://github.com/tigu77/tiguclaw/compare/v0.3.20...v0.3.21
[0.3.20]: https://github.com/tigu77/tiguclaw/compare/v0.3.19...v0.3.20
[0.3.19]: https://github.com/tigu77/tiguclaw/compare/v0.3.18...v0.3.19
[0.3.18]: https://github.com/tigu77/tiguclaw/compare/v0.3.17...v0.3.18
[0.3.17]: https://github.com/tigu77/tiguclaw/compare/v0.3.16...v0.3.17
[0.3.16]: https://github.com/tigu77/tiguclaw/compare/v0.3.15...v0.3.16
[0.3.15]: https://github.com/tigu77/tiguclaw/compare/v0.3.14...v0.3.15
[0.3.14]: https://github.com/tigu77/tiguclaw/compare/v0.3.13...v0.3.14
[0.3.13]: https://github.com/tigu77/tiguclaw/compare/v0.3.12...v0.3.13
[0.3.12]: https://github.com/tigu77/tiguclaw/compare/v0.3.11...v0.3.12
[0.3.11]: https://github.com/tigu77/tiguclaw/compare/v0.3.10...v0.3.11
[0.3.10]: https://github.com/tigu77/tiguclaw/compare/v0.3.9...v0.3.10
[0.3.9]: https://github.com/tigu77/tiguclaw/compare/v0.3.8...v0.3.9
[0.3.8]: https://github.com/tigu77/tiguclaw/compare/v0.3.7...v0.3.8
[0.3.7]: https://github.com/tigu77/tiguclaw/compare/v0.3.6...v0.3.7
[0.3.6]: https://github.com/tigu77/tiguclaw/compare/v0.3.5...v0.3.6
[0.3.5]: https://github.com/tigu77/tiguclaw/compare/v0.3.4...v0.3.5
[0.3.4]: https://github.com/tigu77/tiguclaw/compare/v0.3.3...v0.3.4
[0.3.3]: https://github.com/tigu77/tiguclaw/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/tigu77/tiguclaw/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/tigu77/tiguclaw/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/tigu77/tiguclaw/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/tigu77/tiguclaw/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/tigu77/tiguclaw/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/tigu77/tiguclaw/releases/tag/v0.1.0
