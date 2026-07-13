# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.83] - 2026-07-13

### Added
- **Endpoint calls now have their own main-menu view**, with each call's full request and response and per-call collapse/expand — moved out of the background drawer, nothing truncated.
- **The assistant can now check its own runtime health.** A read-only `maintenance_status` reports whether storage stays within its designed bounds (hot working set vs. preserved records), and background job records now self-bound (running jobs are always kept).

### Fixed
- **Dashboard chat no longer blanks out earlier messages while a long response is streaming.** During a multi-step reply, previous messages stayed put instead of collapsing into empty space (a render-only issue — a refresh restored them). Message history is no longer unmounted while a turn is live.
- **The "working…" indicator stays visible through a model fallback.** When the primary model hits a transient error and the turn falls back to another model, the indicator no longer flickers off mid-response.

## [0.3.82] - 2026-07-12

### Changed
- **API endpoint calls no longer clutter the dashboard chat.** When an external app calls one of tiguclaw's custom HTTP endpoints, that machine-to-machine exchange used to stream into the chat view alongside your real conversation. Those calls now go to a dedicated "🔌 Endpoint calls" section in the background drawer — showing each call's endpoint, time, success/failure, and a response preview — while the chat stays focused on actual conversation. Full request/response records remain in the database as before.

## [0.3.81] - 2026-07-12

### Changed
- **When you work inside a registered project that has its own harness (dedicated skills and agents), tiguclaw now routes substantial work through that harness instead of quietly doing everything itself in one pass.** Design, new features, MVP builds, and multi-file refactors go to the project's purpose-built team; only genuinely small, localized changes are done inline. It decides "substantial vs simple" by whether the task involves structure or design decisions — not by how many lines it is — so asking it to "design an extensible X and build the MVP" no longer bypasses the very team you set up for that project.

## [0.3.80] - 2026-07-11

### Added
- **tiguclaw now reliably recognizes and reaches for its own capabilities when you describe a need — even an indirect one.** Previously, asked to do something in roundabout terms (e.g. "let an external app call you"), it could miss that it already had the right built-in tool and fall back to a clumsy workaround. Now it maps your request to what it can actually do first, and if nothing fits, it considers acquiring the capability — building a new skill or subagent, connecting an external tool, or exposing a custom HTTP endpoint. A new `find_capabilities` lookup lets it survey what's available in the moment across every model backend.

## [0.3.79] - 2026-07-11

### Fixed
- **Dashboard chat: mobile progress indicator, attachment remove button, and smoother typing.** On phones the "working…" indicator now stays visible while the assistant replies — previously the on-screen keyboard hid it just below the input box, so it now sits just above the input where it's always in view. The ✕ button for removing an attached file is no longer clipped by the thumbnail's rounded corner and floats fully on top of the chip. And typing in the chat box stays instant no matter how long the conversation is: the input's auto-resize no longer forces a full layout recalculation on every keystroke (which got costly as message history piled up), so keystrokes no longer lag.

## [0.3.78] - 2026-07-11

### Changed
- **The dashboard chat stays fast and smooth no matter how long the conversation gets.** The message list is now virtualized — only the messages near what you're viewing are kept rendered, so typing and scrolling stay responsive even in very long, tool-heavy conversations (previously they got progressively laggy as history piled up). Scrolling loads older messages seamlessly, and a "jump to latest" button appears when you've scrolled up. Tool-step cards restored from history now show their model backend (matching live), for consistency.

## [0.3.77] - 2026-07-11

### Added
- **The dashboard chat now scrolls sensibly.** When you send a message it jumps to the bottom, and while you're viewing the latest messages it follows new ones as they arrive — so you always see the newest reply. If you've scrolled up to read earlier history, it leaves you there instead of yanking you down; scroll back to the bottom and it resumes following.

## [0.3.76] - 2026-07-11

### Added
- **The dashboard now shows which model a background job is running on, and lets you expand a job's tool steps to see the full detail.** Background workers now display a model-tier badge (e.g. a high-tier code review shows it), matching what subagents already showed. And a background job's tool steps — which previously showed only a one-line summary — can now be clicked to reveal the same rich diff and output view as the main chat, on demand. The job timeline stays compact by default (no chat-noise), and expands only when you want the detail.

## [0.3.75] - 2026-07-11

### Added
- **Background workers can now run on a higher-quality model when the task needs it.** When the assistant kicks off a background job, it can pick the model tier for that job — so a code review, a design task, or hard reasoning runs on a stronger model, while bulk or simple jobs stay on a cheaper, faster one. Previously every background worker ran on the default model regardless of the task. There's also a dedicated high-tier code-review helper for when review quality really matters. Simple and cheap tasks are unaffected; nothing runs on an expensive model unless the work calls for it.

### Changed
- **Smarter about when to spin up a multi-agent team vs. just doing the work.** Coordinating multiple agents costs several times the tokens of a single pass, so the guidance now asks "is a team actually worth it?" up front — reserving fan-out for genuinely independent, sizable subtasks and keeping small or tightly-coupled work on a single agent. Less wasted effort, same results.

## [0.3.74] - 2026-07-11

### Added
- **A `skill-creator` skill — the assistant can now author and improve its own skills properly.** Ask it to make or refine a skill and it follows a real process: draft with the right structure and a well-targeted trigger description, do a quick sanity check, and ship on your approval. For skills where it matters, it can optionally *prove* an improvement with a small controlled eval — run test prompts with and without the skill, score them, and report a before/after table — so "this is better" is backed by data instead of a guess. The eval is opt-in, not mandatory: most skills just need the quick path. Unlike the equivalent tooling elsewhere, the eval is model-agnostic, so the same skill can be benchmarked across different backends. Skills are never changed automatically — a person always approves.

## [0.3.73] - 2026-07-11

### Added
- **Slash-command autocomplete in the dashboard chat.** Type `/` at the start of the chat box and a menu of available commands pops up — filter by typing, navigate with ↑/↓, accept with Enter/Tab or a click, dismiss with Esc. Matches the Claude Code / Telegram slash-menu experience in the web dashboard.

### Fixed
- **The command menu is now the same across every channel.** Built-in slash commands were maintained in three separate places that had drifted apart — so the Telegram menu was silently missing `/model`, `/schedule`, and `/stop`. All channels (Telegram, dashboard, and the reserved-name guard for custom commands) now draw from a single source, so the same command list shows everywhere and can't drift again.

## [0.3.72] - 2026-07-10

### Added
- **`/clear` resets a conversation's context — and it now actually works on every model backend.** Send `/clear` (or the existing `/reset`) to start a fresh conversation: earlier turns are no longer fed to the model. Previously `/reset` only took effect on the Claude backend — on the Codex and OpenAI/local backends the assistant kept re-injecting the prior conversation, so a "reset" didn't really reset. Now all three backends honor it uniformly. Your history isn't deleted (memory search and the dashboard transcript stay intact) — like Claude Code's `/clear`, only the live context is cut, matching the behavior across every channel and model.

## [0.3.71] - 2026-07-10

### Added
- **You can now interrupt a turn in progress with `/stop`.** If the assistant is working on something and you want to change direction, send `/stop` — it cancels the in-progress turn for that conversation (without restarting the daemon), and your next message is handled as a fresh turn. Works across all channels and model backends. A cancel is treated as an intentional action, not a failure, so it doesn't pollute error tracking or trigger fallbacks. (This is the "interrupt and redirect" form of steering; seamless mid-turn steering that keeps in-progress work is a separate, larger change.)

## [0.3.70] - 2026-07-10

### Added
- **Local/small models that don't support tool-calling now still respond, instead of failing.** Many local models (e.g. Ollama vision models like `llava`) don't support function-calling, so passing them tools made the whole turn fail with a "does not support tools" error. The OpenAI adapter now detects this and automatically retries once without tools, so those models can still answer (text and image questions). Models that do support tools (OpenAI, Gemini, etc.) are unaffected. Combined with the previous release, this makes vision-capable local models usable for image Q&A.

## [0.3.69] - 2026-07-10

### Added
- **The OpenAI backend can now actually see attached images (vision), matching the Claude and Codex backends.** Previously, when using OpenAI/Google(Gemini)/local OpenAI-compatible models, an attached image was only referenced as a file path in text, so those models couldn't view it. Now the image is sent to the model as visual input on vision-capable models (e.g. GPT‑4o, Gemini, and vision-capable local models). Models without vision support fall back to the previous text-reference behavior, so nothing regresses. (Past turns are reconstructed as text only, so a single un-viewable image can't wedge a conversation.)

## [0.3.68] - 2026-07-10

### Fixed
- **Self-update completion notices now appear in the same dashboard conversation you triggered them from.** When you asked the assistant to update itself from the web dashboard, the "update complete — restarted" notice was posted to a generic thread instead of the conversation you were in, so it looked out of place. It now lands in the right conversation. (Notifications from proactive actions — schedules, file-watch, background workers, self-update, restart — already showed in the dashboard; this only corrects which conversation the self-update notice is grouped under.)

## [0.3.67] - 2026-07-10

### Added
- **Images and files you attach now stay in the chat history after a reload.** Previously an attachment preview only showed during the live session and disappeared on refresh (attachments weren't stored with the message). Now the message keeps a lightweight reference to the already-saved file, and the dashboard serves it back — so your sent images/files render in past history too, including image-only messages (no caption). The image bytes aren't duplicated into the database; only a reference is stored, and the file is served from a local, token-protected endpoint with path-traversal protection.

## [0.3.66] - 2026-07-10

### Fixed
- **An image the model can't process no longer breaks the whole conversation.** Previously, if you sent an image Claude couldn't process, that failure got baked into the conversation's resumed session — so *every* later message (even plain text) kept failing with the same error until the thread was manually reset. Now the assistant detects this, self-heals the thread (dropping only the un-processable turn while keeping your conversation context and model choice), and replies with a clear "couldn't process that image — check the format/size and try another" message instead of a raw error.

## [0.3.65] - 2026-07-10

### Fixed
- **Images and files you attach in the dashboard chat now show up in your sent message card.** Previously an attachment was sent to the assistant but never appeared in the chat, so there was no visual confirmation of what you sent. Sent messages now render a thumbnail (for images) or a file chip inline in the bubble. (These previews are shown for the live session; because attachments aren't stored in the chat log, reloading the page shows past messages as text only.)

## [0.3.64] - 2026-07-10

### Changed
- **On mobile, Enter in the dashboard chat input now inserts a line break instead of sending.** On phones the on-screen keyboard's Enter key kept sending the message mid-thought; now it adds a newline, and you send with the "Send" button. Desktop is unchanged — Enter still sends, Shift+Enter still adds a newline. The distinction is based on whether the primary input is touch (not screen width), so a narrow desktop window with a physical keyboard still sends on Enter.

## [0.3.63] - 2026-07-10

### Fixed
- **Built-in slash commands now work in the web dashboard chat and no longer leave it stuck on "working".** Commands like `/status`, `/memo`, `/schedule`, and `/plugins` replied over the channel but didn't emit the completion event the dashboard uses to (1) render the reply and (2) clear the "working" spinner. As a result, in the dashboard the command appeared to do nothing and the spinner kept spinning, even though it worked fine on Telegram. Every built-in command (and error replies) now emits that event, so replies show up in the dashboard chat and the spinner clears — matching normal turns.

## [0.3.62] - 2026-07-10

### Changed
- **Hitting a backend's usage limit now gives a clear message instead of a raw error.** When an LLM backend returns a rate-limit/usage-limit error (e.g. Codex's `429 usage_limit_reached`), the assistant replied with the raw JSON, which was confusing. It now says which backend hit its limit, roughly how many minutes until it resets, and suggests switching backends or using a multi-model pool for automatic fallback. Other errors are still shown as-is. (No automatic cross-backend fallback is added — that stays a configuration choice; this only makes the message clear.)

## [0.3.61] - 2026-07-10

### Added
- **Diffs are now syntax-highlighted too, not just fenced code blocks.** The code inside an Edit/Write diff card is colored by language (detected from the file's extension), while the `+`/`-` markers keep their green/red so the added/removed signal stays clear — the GitHub-style combination of a tinted line plus highlighted code. Falls back to plain text when the language can't be determined. (Command/read output blocks are left plain for now.)

## [0.3.60] - 2026-07-10

### Changed
- **Project cards no longer show an "active" status badge.** Since almost every project is active by default, the badge appeared on every card as noise; it's now omitted for active projects and only shown for the meaningful exceptions — "paused" and "done". (The card's subtle left-edge color still reflects status.)

## [0.3.59] - 2026-07-10

### Changed
- **The context-tag bar collapses to a single line and expands with a scroll when you have many tags.** As learned tag chips accumulate, the bar no longer grows tall enough to push the input around: it shows one line by default with a toggle (that includes the tag count), and expanding it caps the height and scrolls, so it never takes over the screen no matter how many tags you have.

## [0.3.58] - 2026-07-10

### Changed
- **Code highlighting now uses the real highlight.js library instead of a hand-rolled one.** The syntax highlighter added in 0.3.57 was a small custom implementation; it's been replaced with highlight.js v11 (bundled locally as a single vendored file, like the markdown parser — no CDN, works offline), for accurate highlighting across dozens of languages.

### Fixed
- **The violet context-tag chips are easier to read.** Newly-typed tags (which don't yet match a known project or skill) were dimmed too much, and the violet chips were low-contrast; both are now brighter.

## [0.3.57] - 2026-07-10

### Added
- **Code blocks in the dashboard chat are now syntax-highlighted by language.** Fenced code in the assistant's replies gets per-language coloring for comments, strings, numbers, keywords, and common types (JavaScript/TypeScript, Python, C#, Java, Go, Rust, C/C++, shell, JSON, YAML, SQL, plus a generic fallback). It's a small self-contained highlighter bundled into the dashboard — no external library, CDN, or build step — so it works offline like the rest of the local dashboard.

## [0.3.56] - 2026-07-10

### Changed
- **Context-tag chips are now removable, toggle in and out of the input, and show which tags are real.** Clicking a chip inserts its tag if it's not in the input and removes it if it already is (so you can clear a tag you added), and the chips for tags currently in your message are highlighted. Learned tag chips have a small × to delete them from the bar (registered projects stay, since they're seeded from the registry). Tags that actually match a project, skill, or agent render solid; ones that don't (typos, ad-hoc topics) render faded/dashed so junk is easy to spot and clear.

## [0.3.55] - 2026-07-10

### Changed
- **Context tags are no longer project-only, and you can use several at once.** A `#<tag>` can point to a registered project, a skill (e.g. `#code-review`), or any recurring topic — the assistant resolves each accordingly, and multiple tags in one message are all honored (e.g. `#ProjectA #code-review`). The dashboard tag bar now seeds from your registered projects and *learns* the tags you type: any `#tag` you send appears as a chip next time (project chips in blue, other tags in violet), most-recently-used first.

## [0.3.54] - 2026-07-10

### Added
- **A context-tag bar above the dashboard chat input for one-click project context.** Your registered projects appear as chips above the input; clicking one inserts a `#<project>` tag (e.g. `#SMGS Android`) at the cursor, so the assistant knows the message is about that project without you re-explaining the topic each time. Chips are ordered most-recently-used first, duplicate insertion is prevented, and the bar hides when you have no projects. The tag is a plain-text convention (channel- and backend-neutral — you can type it in Telegram too): the assistant matches it to the project registry and works in that project's scope.

## [0.3.53] - 2026-07-10

### Changed
- **The wrapper skills now read a project's main instructions first and reflect them into the project's context.** A Claude Code skill/agent assumes the conventions set by the project's `CLAUDE.md` (and Codex's by `AGENTS.md`); copying the skill alone loses that context. `claude-wrapper-sync` / `codex-wrapper-sync` now first read those main-instruction files and capture their essentials into the project's `PROJECT.md` before wrapping — so the imported skills operate with the right context on every backend (rather than relying on a Claude-only auto-load).

## [0.3.52] - 2026-07-10

### Fixed
- **The wrapper skills now copy the source content instead of pointing at it by an absolute path.** When importing a Claude Code/Codex skill, the assistant could create a thin wrapper that referenced the original file by a machine-specific absolute path (e.g. `E:/work/.../SKILL.md`), which breaks when the assistant's home is synced to another machine. The `claude-wrapper-sync` / `codex-wrapper-sync` skills now make a self-contained full copy the default, forbid absolute/machine-specific paths, and only allow a reference at all when it's a project-scoped wrap using a project-relative path.

## [0.3.51] - 2026-07-10

### Added
- **Import agents and skills from a Claude Code or Codex project with two new built-in skills.** `claude-wrapper-sync` brings a project's `.claude/{agents,skills,commands}` into your assistant, and `codex-wrapper-sync` brings Codex's `~/.codex/skills`. The three tools share essentially the same on-disk format (agents are `<name>.md`, skills are `SKILL.md`), so wrapping is mostly validate-and-copy — with a dry-run preview and a confirmation before anything is overwritten. Wrapped assets are discovered live (no restart) and work identically across the Claude, Codex, and OpenAI backends.

### Changed
- **Project-scoped assets now live in a `.tiguclaw/` meta folder.** Like `.claude/` and `.codex/`, a project's tiguclaw skills/agents/commands now sit under `<project>/.tiguclaw/{skills,agents,commands}` instead of scattered top-level folders — so they no longer collide with a project's own `skills/` or `agents/` directories. The legacy flat layout is still discovered (deprecated) so nothing breaks; new assets are written under `.tiguclaw/`. Project `.mcp.json` stays where it is (it's the Claude Code standard).

## [0.3.50] - 2026-07-10

### Added
- **Messages you send while the assistant is still working now show up immediately, marked "queued".** A message sent mid-turn is held in the per-thread queue and processed as soon as the current turn finishes (it was never lost) — but until then it didn't appear in the dashboard chat, so it was unclear whether it registered. It now shows right away with a "⏳ queued" badge, and the badge clears the moment the assistant starts processing it. No duplicate bubble appears when it does.

## [0.3.49] - 2026-07-10

### Fixed
- **A tool whose result is an error now shows its output preview tinted red across all backends.** The error tint previously relied on a backend-specific flag that the built-in file tools don't set (they return their errors as `Error: …` text rather than a flagged failure), so tool errors often rendered without the red highlight. The preview now also recognizes an `Error:`-prefixed result, so failed reads, greps, fetches, and shell commands are consistently marked — identically on the Claude, Codex, and OpenAI backends. Only a result that *starts* with `Error:` is flagged, so output that merely mentions the word isn't mislabeled.

## [0.3.48] - 2026-07-10

### Fixed
- **`Bash` and `WebFetch` timeouts are now interpreted in seconds, matching their documentation.** The tool descriptions said the timeout defaulted to 120s (Bash) / 30s (WebFetch), but the code treated the value as milliseconds — so a model passing `timeout: 120` got 120 ms and the command was killed instantly (and `WebFetch` failed after 30 ms). The parameter is now seconds as documented, clamped to the same maximums, with the unit spelled out in the parameter description. (Applies to the built-in file tools used by the Codex/OpenAI backends; the Claude backend uses the SDK's own tools, which were unaffected.)

## [0.3.47] - 2026-07-10

### Added
- **More tools show an output preview in the dashboard chat.** In addition to `Bash`, `Read`, `Grep`, and `Glob`, the collapsible output preview now also appears for `WebFetch` (fetched web content), `BashOutput` (background shell output), and `WebSearch`. Tools whose result is just a confirmation (a file write, a shell kill, a todo update) stay preview-free.

## [0.3.46] - 2026-07-10

### Changed
- **The active (and most recent) tool bundle now stays expanded, instead of collapsing the moment a turn finishes.** Since the tool cards now carry the useful detail (diffs, command output), auto-collapsing a turn the instant it completed meant fast turns flashed by before you could see anything. The live view now keeps the current/most-recent turn expanded, and collapses the previous one only when a new turn starts — so you always see what's happening now, without the chat piling up. (Older turns restored on page reload still start collapsed.)

## [0.3.45] - 2026-07-10

### Added
- **Scrolling back through older chat history now restores the tool cards too, not just the messages.** Previously only the most recent page of history rebuilt the tool steps, diffs, outputs, and per-turn grouping; scrolling further up showed a bare list of messages. Older pages now reconstruct the same collapsible "N steps" turn cards (with their diffs and output previews) as the initial view, using the shared grouping logic. (A turn that straddles a page boundary can still split into two cards — a minor, rare cosmetic edge.)

## [0.3.44] - 2026-07-09

### Fixed
- **The file drag-and-drop highlight no longer gets stuck on the dashboard.** When you drag a file over the chat panel, a dashed outline marks the drop zone. It could stay visible after you cancelled the drag, moved the pointer over a message, or dropped outside the panel, because the clear-on-leave check only fired when leaving the panel element itself. It now clears whenever the drag genuinely leaves the panel (or the window), with a global drop/drag-end safety net.

## [0.3.43] - 2026-07-09

### Fixed
- **Large tool diffs and outputs now survive to the dashboard history, and a background scan no longer breaks on them.** The rich tool cards added in 0.3.40 could produce an event record larger than the persistence size cap; when that happened the record was truncated mid-JSON into invalid JSON. That had two effects: a big diff or command output silently failed to reappear after a page reload, and an internal maintenance scan (the self-improvement/skill-proposal pass) aborted each cycle on the malformed record. Oversized records are now truncated to still-valid JSON (keeping the step's identity, dropping only the oversized preview), the size cap was raised so typical diffs/outputs are kept in full, and the queries that read these records now skip any already-malformed row instead of failing — so existing installs recover immediately.

## [0.3.42] - 2026-07-09

### Fixed
- **Tool steps stay grouped by turn after a page reload, just like they are live.** When persisted tool steps were restored on refresh, they were drawn as a flat list of individual lines instead of the collapsible "N steps" turn card you see while a turn runs — so reloading scattered a bundled turn into loose lines. History now regroups consecutive steps from the same turn into a collapsible card (matching the live view), collapsed by default; click the card to reveal its steps, and a step to reveal its diff or output.

## [0.3.41] - 2026-07-09

### Changed
- **Tool cards in the dashboard chat now expand and collapse as a single unit, and stay put.** A tool step is a compact one-line summary by default (for an edit: the file and its `+added -removed`); click anywhere on it to expand the full diff or output, click again to collapse. The expanded state is sticky — it no longer closes when you move the mouse away. Edit steps also drop the noisy inline argument echo from the collapsed line (the diff header already shows the path), and an expanded block now shows all of its captured lines instead of scrolling within a fixed height.

## [0.3.40] - 2026-07-09

### Added
- **The dashboard chat now shows what a tool actually did — diffs and output, inline and expandable.** A file edit shows a green/red line diff with a `+added -removed` count (the way a code review does); a new file write shows its added lines; and `Bash`, `Read`, `Grep`, and `Glob` show a preview of their output (errors tinted red). Each block is collapsed to a one-line summary you can click to expand, so the chat stays clean. Like the tool steps themselves, these are recorded and restored when you reload the page. The structured data is captured in the LLM runtime (identically across the Claude, Codex, and OpenAI backends) and only rendered by the dashboard, so it's backend-neutral and stays out of your chat channels; previews are size-capped so a huge file or command output can't bloat anything.

## [0.3.39] - 2026-07-09

### Fixed
- **The dashboard chat now keeps your tool steps after a refresh.** Tool activity (a file read, an edit, a shell command) was shown live while a turn ran but vanished when you reloaded the page — so revisiting a past conversation showed only the messages, not what the assistant actually did. Those steps were already recorded; the chat history now returns them alongside the messages and renders each as a compact step line, interleaved in time. Live steps and reloaded steps are de-duplicated, so a step never appears twice. (Older steps reached by scrolling further up aren't restored yet — only the recent history shown on load.)

## [0.3.38] - 2026-07-09

### Added
- **A local OpenAI-compatible LLM gateway — use tiguclaw's multi-LLM backend from your own apps.** Set `LLM_GATEWAY_TOKEN` and the daemon exposes `POST /v1/chat/completions` on the HTTP bridge, backed by tiguclaw's provider pool with fallback. Point any OpenAI-compatible client at `http://127.0.0.1:<bridge-port>/v1` with that token and you get chat completions — streaming (`stream: true`, SSE) or not — from whichever backend you route to. The call is neutral (your `system` message is honored; the assistant's own persona, tools, memory, and transcripts are never mixed in), so it behaves like a plain model API. Route it to a different backend than the assistant (via `LLM_GATEWAY_MODELS`, e.g. a paid API vs. the assistant's subscription) to keep their rate limits separate; there's a concurrency cap (`LLM_GATEWAY_MAX_CONCURRENCY`, default 4). The endpoint is disabled unless the token is set, binds to localhost, and expects your app's server (not a browser) to hold the token.

## [0.3.37] - 2026-07-09

### Added
- **Configuration now lives in your home directory, not the repo checkout.** tiguclaw reads its `.env` from the runtime home (`$TIGUCLAW_HOME`, default `~/.tiguclaw/.env`), and `tiguclaw init` writes it there — so you can clone the public repo, keep it as pure code, and `git pull` without ever touching your config. Existing installs with a `.env` at the repo root keep working (it's used as a fallback), so nothing breaks; to migrate, just move your `.env` into the home directory. Environment variables always take precedence over the file.

### Fixed
- **The dashboard chat no longer gets stuck showing "working…" forever.** After a reconnect, the event replay could re-deliver an old "message received" event and make the chat think a long-finished turn was still running (e.g. a spinner stuck at "working · 15m 22s"). The indicator now only activates for recent turns and self-clears any turn that has been "running" implausibly long.
- **A tool step no longer blinks forever when a turn ends without a clean reply.** If a turn finished via an error or a hung tool (so no final reply arrived), the last tool step kept pulsing as if still in progress. It now stops as soon as the turn ends, however it ends.

## [0.3.36] - 2026-07-09

### Fixed
- **The dashboard now shows your assistant's name even when it's written as prose.** The assistant is guided to record its identity in `AGENT.md` as "your name is X", but the dashboard's name reader only recognized a structured `이름: X` / `name: X` field — so a naturally-worded name fell back to "tiguclaw". The reader now also understands the prose form ("(your) name is X"), and the assistant is now told to also add a clear `name:` line when it sets or changes its name.
- **The Runtime Inventory's Plugins section is no longer empty on a fresh install.** Bundled non-channel plugins (dashboard, scheduler, file-watch, self-growth) weren't listed anywhere, and a plugin declaring multiple kinds (e.g. the HTTP bridge, which is both a channel and an observer) was skipped by the channel scan. Bundled plugins now appear — the HTTP bridge under Channels, and the service/trigger/observer plugins under Plugins — alongside any home-installed plugins.

## [0.3.35] - 2026-07-08

### Added
- **The dashboard now shows each agent's model tier, and a project's own MCP servers.** Agent cards in the Runtime Inventory (and a project's dedicated agents in the project detail) now carry a small badge with the agent's model tier (`high`/`mid`/`low`/`nano`, or an explicit `provider:model`), so you can see at a glance which model an agent runs on. A project's detail panel also gained a **"dedicated MCP"** section listing the MCP servers declared in that project's `.mcp.json` — the project-scoped servers that are exposed only when work is delegated to it.

## [0.3.34] - 2026-07-08

### Added
- **Project-scoped MCP servers.** An MCP server can now belong to a specific project instead of being global: declare it in that project's `<project>/.mcp.json` (the same format Claude Code uses) and its tools are exposed **only when work is delegated to that project** (`spawn_agent(path=…)`), not on every turn. Global servers (in `<home>/mcp.json`) remain available everywhere. `add_mcp_server` / `list_mcp_servers` / `remove_mcp_server` take an optional `path` to target a project's config (omit it for global), and `project_capabilities(path)` now lists a project's own MCP servers. This keeps a project-specific tool (e.g. a Unity MCP) from bloating unrelated turns — and it connects lazily, only when you actually work in that project. The assistant reaches a project's MCP tools by delegating to the project, the same way it does for project-specific skills and agents.

### Fixed
- **The Runtime Inventory now shows connected external MCP servers.** Servers registered via `add_mcp_server` (stored in `<home>/mcp.json`) were never listed in the dashboard's Runtime Inventory because it only read a different config file. They now appear alongside the built-in in-process servers.

## [0.3.33] - 2026-07-08

### Added
- **The dashboard's progress indicator now reflects turns from every channel — as one assistant.** When a message is being handled from Telegram (or CLI), the dashboard chat shows the same `✳️ <assistant> 작업 중 · 8m 38s` spinner and elapsed timer it shows for your own dashboard messages, clearing when the reply arrives. Whichever channel a request came from, the dashboard presents it as the single assistant at work (no per-channel labels) — consistent with the single-persona model.

### Fixed
- **Typing in the dashboard chat input is no longer laggy.** The auto-resizing input measured its height on every keystroke, forcing a full layout reflow each time on a dashboard whose DOM is constantly updating from the live stream. Measurement is now batched to one per animation frame, so typing stays responsive.

## [0.3.32] - 2026-07-08

### Added
- **Attach files to the dashboard chat — paste, drag-and-drop, or the 📎 button.** Pasted or dropped files (images, PDFs, text, etc.) are saved and passed to the assistant just like a Telegram attachment, so you can share a screenshot or a file and ask about it right from the dashboard. Attachments show as small square thumbnails above the input — a live preview for images, an extension card for other files — each removable with a corner ✕. Caps: 10MB per file, 25MB per message, 10 files; a file-only message (no text) is allowed.
- **Per-tool execution time in the activity view.** Each tool step now shows how long that tool actually took (e.g. `1.8s`), measured on the Claude, codex, and OpenAI backends alike, with a warning tint past 90 seconds — so you can see at a glance which step was slow.
- **Shift+Enter inserts a newline in the dashboard chat.** The input is now a growing multi-line box: Enter sends, Shift+Enter adds a line, and it resizes to fit (Korean/IME composition no longer mis-sends on Enter).

### Changed
- **The "working" indicator now shows a spinner and a live elapsed timer.** While a turn is in progress the chat shows `✳️ <assistant> 작업 중 · 8m 38s`, counting up until the reply arrives (and clearing when it does) — so a long-running turn reads as clearly working rather than stuck.

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

[Unreleased]: https://github.com/tigu77/tiguclaw/compare/v0.3.83...HEAD
[0.3.83]: https://github.com/tigu77/tiguclaw/compare/v0.3.82...v0.3.83
[0.3.82]: https://github.com/tigu77/tiguclaw/compare/v0.3.81...v0.3.82
[0.3.81]: https://github.com/tigu77/tiguclaw/compare/v0.3.80...v0.3.81
[0.3.80]: https://github.com/tigu77/tiguclaw/compare/v0.3.79...v0.3.80
[0.3.79]: https://github.com/tigu77/tiguclaw/compare/v0.3.78...v0.3.79
[0.3.78]: https://github.com/tigu77/tiguclaw/compare/v0.3.77...v0.3.78
[0.3.77]: https://github.com/tigu77/tiguclaw/compare/v0.3.76...v0.3.77
[0.3.76]: https://github.com/tigu77/tiguclaw/compare/v0.3.75...v0.3.76
[0.3.75]: https://github.com/tigu77/tiguclaw/compare/v0.3.74...v0.3.75
[0.3.74]: https://github.com/tigu77/tiguclaw/compare/v0.3.73...v0.3.74
[0.3.73]: https://github.com/tigu77/tiguclaw/compare/v0.3.72...v0.3.73
[0.3.72]: https://github.com/tigu77/tiguclaw/compare/v0.3.71...v0.3.72
[0.3.71]: https://github.com/tigu77/tiguclaw/compare/v0.3.70...v0.3.71
[0.3.70]: https://github.com/tigu77/tiguclaw/compare/v0.3.69...v0.3.70
[0.3.69]: https://github.com/tigu77/tiguclaw/compare/v0.3.68...v0.3.69
[0.3.68]: https://github.com/tigu77/tiguclaw/compare/v0.3.67...v0.3.68
[0.3.67]: https://github.com/tigu77/tiguclaw/compare/v0.3.66...v0.3.67
[0.3.66]: https://github.com/tigu77/tiguclaw/compare/v0.3.65...v0.3.66
[0.3.65]: https://github.com/tigu77/tiguclaw/compare/v0.3.64...v0.3.65
[0.3.64]: https://github.com/tigu77/tiguclaw/compare/v0.3.63...v0.3.64
[0.3.63]: https://github.com/tigu77/tiguclaw/compare/v0.3.62...v0.3.63
[0.3.62]: https://github.com/tigu77/tiguclaw/compare/v0.3.61...v0.3.62
[0.3.61]: https://github.com/tigu77/tiguclaw/compare/v0.3.60...v0.3.61
[0.3.60]: https://github.com/tigu77/tiguclaw/compare/v0.3.59...v0.3.60
[0.3.59]: https://github.com/tigu77/tiguclaw/compare/v0.3.58...v0.3.59
[0.3.58]: https://github.com/tigu77/tiguclaw/compare/v0.3.57...v0.3.58
[0.3.57]: https://github.com/tigu77/tiguclaw/compare/v0.3.56...v0.3.57
[0.3.56]: https://github.com/tigu77/tiguclaw/compare/v0.3.55...v0.3.56
[0.3.55]: https://github.com/tigu77/tiguclaw/compare/v0.3.54...v0.3.55
[0.3.54]: https://github.com/tigu77/tiguclaw/compare/v0.3.53...v0.3.54
[0.3.53]: https://github.com/tigu77/tiguclaw/compare/v0.3.52...v0.3.53
[0.3.52]: https://github.com/tigu77/tiguclaw/compare/v0.3.51...v0.3.52
[0.3.51]: https://github.com/tigu77/tiguclaw/compare/v0.3.50...v0.3.51
[0.3.50]: https://github.com/tigu77/tiguclaw/compare/v0.3.49...v0.3.50
[0.3.49]: https://github.com/tigu77/tiguclaw/compare/v0.3.48...v0.3.49
[0.3.48]: https://github.com/tigu77/tiguclaw/compare/v0.3.47...v0.3.48
[0.3.47]: https://github.com/tigu77/tiguclaw/compare/v0.3.46...v0.3.47
[0.3.46]: https://github.com/tigu77/tiguclaw/compare/v0.3.45...v0.3.46
[0.3.45]: https://github.com/tigu77/tiguclaw/compare/v0.3.44...v0.3.45
[0.3.44]: https://github.com/tigu77/tiguclaw/compare/v0.3.43...v0.3.44
[0.3.43]: https://github.com/tigu77/tiguclaw/compare/v0.3.42...v0.3.43
[0.3.42]: https://github.com/tigu77/tiguclaw/compare/v0.3.41...v0.3.42
[0.3.41]: https://github.com/tigu77/tiguclaw/compare/v0.3.40...v0.3.41
[0.3.40]: https://github.com/tigu77/tiguclaw/compare/v0.3.39...v0.3.40
[0.3.39]: https://github.com/tigu77/tiguclaw/compare/v0.3.38...v0.3.39
[0.3.38]: https://github.com/tigu77/tiguclaw/compare/v0.3.37...v0.3.38
[0.3.37]: https://github.com/tigu77/tiguclaw/compare/v0.3.36...v0.3.37
[0.3.36]: https://github.com/tigu77/tiguclaw/compare/v0.3.35...v0.3.36
[0.3.35]: https://github.com/tigu77/tiguclaw/compare/v0.3.34...v0.3.35
[0.3.34]: https://github.com/tigu77/tiguclaw/compare/v0.3.33...v0.3.34
[0.3.33]: https://github.com/tigu77/tiguclaw/compare/v0.3.32...v0.3.33
[0.3.32]: https://github.com/tigu77/tiguclaw/compare/v0.3.31...v0.3.32
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
