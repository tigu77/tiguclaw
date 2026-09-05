# Changelog

All notable changes to this project are documented here.
[한국어 변경 내역](CHANGELOG.ko.md)

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.49.0] - 2026-09-05

### Added

- **Stop a running turn from the composer.** While the assistant is working and the
  input box is empty, the send button becomes a stop button. Typing still sends, so you
  can keep talking to a turn that is already in progress.
- **Sign in to Claude and Codex from the dashboard.** Each subscription plugin's detail
  screen now has a sign-in button with a confirmation step, so a terminal is no longer
  required.

### Fixed

- **Replying to a Telegram message now returns to the conversation it came from.**
  Replies had been landing in whatever session was current instead.
- Several mobile layout problems: text standing on its side in narrow columns; the menu
  drawer neither opening by drag nor scrolling far enough to reach settings; scrolling
  inside a panel dragging the page behind it; an empty box under a button; and the
  inventory detail view running off screen.

### Changed

- `archive_memory` and `delete_memory` accept a list of names, so tidying several
  memories at once is one step.
- Self-growth proposals now say **where** a lesson belongs — a regression, a skill, or a
  standing directive — instead of always ending with "check with the user".


## [0.48.0] - 2026-09-04

### Changed

- Delegated agents and managers are now briefed only on what they can actually do.
  Previously they received the same operating constitution and skill list as the
  assistant, including instructions to use tools that aren't available at their level.
  No capability is lost — they can still find skills with `find_skills` and use any
  skill by name.
- Calling `find_skills` with **no argument** now returns the full list of available
  skills. It previously required a search term, so there was no way to discover what
  existed.
- The skill list now respects a **byte limit**. It previously capped only the number of
  entries, so a few skills with long descriptions could grow it without bound.

### Removed

- Removed the `schedule-safety-check` skill. What it did — checking, before a schedule is
  created, whether that prompt is safe to run unattended later — is now **built into the
  assistant's default behaviour**, so the same check applies in delegated turns too.

### Fixed

- Expanding a background job card now shows the **full** instructions. They were
  previously cut at 500 characters, and the same card would suddenly grow longer after a
  refresh. If the job has ended and the original text is gone, the card says so.
- Deleted skills and agents no longer linger in an installation and keep loading.


## [0.47.0] - 2026-09-03

### Added

- Settings now has a slider for the memory index size — the “what do I remember” list the
  assistant sees every turn. Slide it to 0 to leave the list out entirely (search still reaches
  your memories), or press Default to go back. The default is now 25 KB.
- `/memory-tidy` — a command that reviews your saved memories, merges duplicates and proposes
  what to drop. The assistant also offers it when the memory index reaches its cap, which you
  can now set with `memory.indexCapBytes`.
- Plugin categories can be collapsed and searched, matching the inventory. The detail pane adds
  kind, version, author, website and license — only the fields a plugin actually declares.
- The plugin list is grouped by kind — channel, trigger, observer, service. Bundled plugins now
  carry descriptions, so the list says what each one does.
- The plugin list now shows icon, name and description only; selecting one opens its detail on
  the right. A plugin can ship its own `icon` (png/webp); without one a default is used.
- A plugin can declare a setting read-only. The reverse is not possible — secrets and `.env`
  values stay protected no matter what a plugin declares.
- Plugin settings now surface values that live in your home `.env` — bridge and dashboard
  ports, Telegram allowed users, whether a bot token is set. Values owned by `.env` are shown
  read-only next to the variable they come from (secrets stay set/unset only).
- The dashboard module detail now shows what each LLM provider offers — by vendor when there
  are many models, otherwise per model with context size and tool support. Values the vendor
  does not report are left blank.
- `/providers` — lists the providers you have connected and the models each one offers.
  Providers with many models are summarised by vendor first, and you can narrow by name
  (`/providers openrouter sonnet`). Providers that could not be queried say so.

### Changed

- Delegated work now runs in parallel. The assistant hands out independent jobs and collects
  them in one go, instead of waiting for each one in turn — four sub-tasks that used to take
  the sum of their times now take about the longest one.
- Sub-agents and managers no longer carry your whole memory list. They still get the entries
  relevant to the job they were given, so they know what they need without paying for the rest.
- `tiguclaw doctor` now recognises a broken global link — when the `tiguclaw` command is still
  on your PATH but points nowhere — and tells you to run `npm link` in the install folder.
  Previously it only said it could not tell.
- When a reply from another session is copied to your channel, the label now shows the session
  key instead of `[unknown]`, so you can tell which run it came from. A named session still
  shows its name.
- Documentation file names now state their language — `docs/security.ko.md` (Korean) ·
  `docs/security.en.md` (English). Links to the old names need updating. `README.md` is
  unchanged.

## [0.46.0] - 2026-09-02

### Added

- Background work can carry a title. Job cards show "agent name · title", so several runs of
  the same agent stay distinguishable.

### Fixed

- Commands that answer with a choice list (such as the session list) left the dashboard stuck
  on "working".
- Scheduled and file-watch runs were not counted as in-flight, so a restart during one could
  cut it short. They now appear in the pre-restart check.
- The setup wizard and doctor kept asking about subscription sign-ins this installation cannot
  provide. They now offer only what is actually installed.

### Changed

- The changelog is split by language — [`CHANGELOG.en.md`](CHANGELOG.en.md) (English) ·
  [`CHANGELOG.ko.md`](CHANGELOG.ko.md) (Korean).

## [0.45.0] - 2026-09-01

### Fixed

- Background jobs kept working after announcing they were done. When a job now
  collects a child's result, it is shown the original task again and told the
  result is evidence, not a new instruction. It continues only if the result
  actually breaks the original completion criteria. Its permissions are unchanged.
- Background jobs that hit the tool-call limit were asked for a "final summary"
  and then resumed anyway. They are now asked for a checkpoint instead.
- Long background jobs could run without end — resuming past the tool-call limit
  had no cumulative cap.
- The explanation of why a model could not be used was truncated by long upstream
  error bodies.
- Prompt-truncation detection gained a middle band: when it cannot be certain,
  it says so.
- The same failure was recorded as a new memory each time because the job id differed.

### Changed

- Subscription sign-in is now a bundled plugin. Removing its folder disables only
  that subscription path; API-key users are unaffected. You can reinstall it into
  your home directory to restore it (Codex remains bundle-only because of token refresh).

## [0.44.1] - 2026-09-01

### Fixed

- If the connection dropped while a background job was writing its report, none of
  the text survived. The partial report is now delivered together with the fact
  that it was cut off. This covers every mid-stream failure, not one error type.

## [0.44.0] - 2026-09-01

### Added

- Model lists are fetched from every connected provider. OpenAI-compatible
  endpoints are queried over the standard path. Being listed does not guarantee
  a model works; if it does not, the "reason" below tells you why.
- `/models` shows each model's context size and tool-calling support. Nothing is
  shown for fields the vendor does not report.
- When a model truncates the prompt, the amount sent and the amount processed are
  reported. Small-context models drop instructions, memory and capability lists
  without raising an error.

### Fixed

- When a requested model cannot be used, the reason is stated. Previously only the
  fallback itself was reported.
- Long background jobs were cut at the tool-call limit and restarted from the
  beginning on the next run. They now checkpoint and continue (interactive turns
  are unchanged; this applies to background jobs only).
- The same failure was recorded separately each time because the job id differed.
- Weekly retrospectives were written even when there was no signal.

## [0.43.2] - 2026-08-31

### Fixed

- Plugin permission requirements were shown in Korean only — on the very screen the
  security document points to for pre-install review. They now follow the UI language.
- Removing a plugin did not survive a restart; the disabled state was never recorded.
- Reinstalling a previously disabled name brought it back disabled.
- Credential blocking in widget settings now inspects values as well: private keys,
  service tokens and connection strings are blocked even when the field name gives
  no hint. Ordinary-looking values cannot be detected — declare them as secrets in
  the settings spec.
- A home plugin could take over the name of a bundled plugin while that plugin was
  disabled. The list showed the bundled plugin's origin and permissions while other
  code ran. Names present on disk are now reserved.
- Disabling the dashboard from the plugin screen asked for no confirmation and
  removed the screen needed to undo it.
- Starting with `npm start` loaded no plugins at all.
- Rejected plugin setting changes were reported in the wrong language.
- Once a plugin's settings were changed, its settings folder was read as a plugin
  and failed every boot, making a healthy plugin look broken.
- Uppercase letters in a plugin name silently did nothing; the reason appeared only
  in the log. The naming rules are documented in [Writing plugins](docs/plugins.en.md) §2.

### Changed

- The security document now covers extensions ([`docs/security.en.md`](docs/security.en.md)).
  Plugins run in the daemon's process with no isolation, and `needs` is a declaration,
  not a sandbox.

## [0.43.1] - 2026-08-29

### Fixed

- Three more paths where a plugin could shadow a built-in capability — the list still
  showed it while the capability was gone.
- A malformed plugin name could write settings outside its own folder.
- Cleanup ran multiple times when disabling a plugin that filled several roles.
- The same warning repeated on every occurrence.
- Four places in the plugin documentation and comments did not follow the behaviour
  changed in 0.43.0.

## [0.43.0] - 2026-08-29

### Added

- [Writing plugins](docs/plugins.en.md) — you can build a widget and a tool from this
  document alone. The capability existed but had no documentation.
- Building a tool requires no dependencies: a name, a description and arguments.
  The previous SDK-based approach still works.
- Plugins can act without a conversation — observe events, send notifications, and ask
  the model when needed. Plugins that message you or call the model disclose that at
  install time.

### Changed

- TypeScript support is not ready yet; write plugins in JavaScript for now.
- Plugin tools are visible in every context. Previously they appeared only in direct
  conversation, not in scheduled runs or background jobs.
- Home widgets went from 12 to 24.
- Fewer constraints on plugins — only what can actually harm the user or the daemon.

### Fixed

- Disabling a plugin did not stop self-waking ones such as the scheduler or file watcher.
- A name collision let a plugin shadow one of your real conversations.
- A plugin could replace built-in capabilities such as memory or skills.
- Widgets with many settings were blocked by a settings-count limit.
- A plugin providing both tools and views was logged as providing nothing.

## [0.42.1] - 2026-08-29

### Fixed

- With a malformed `settings.json`, changing the theme or model reported success while
  wiping model profiles, theme and gateway settings. It now stops and reports which
  file failed to parse. Views and queries keep working.
- A faulty widget data function could restart the whole daemon. Only that widget now
  fails, with a recorded reason.
- Opening the same card in several tabs let later requests bypass the image size limit.

## [0.42.0] - 2026-08-29

### Added

- Widgets can be placed on the dashboard home. Arrangement is done by asking — there is
  no drag-and-drop grid.
- A "running work" widget — background jobs on the home screen instead of the drawer.
- Plugins can add views and settings. Settings a plugin declares appear on the settings
  screen automatically, and it can draw its own cards in replies or on the home screen.
  Passwords and keys show only as present or absent.
- A plugin menu — list, enable, disable, install, remove in one place, without a restart.
  Author and requested permissions are shown alongside.
- Plugins carry their own translations.

### Changed

- Notifications from other conversations are labelled with their origin.
- Release notes are fully readable in settings.
- The browser refreshes itself when a new build is served.

### Fixed

- Plugin cards went blank after scrolling up and back in a long conversation.
- Cards did not appear after a refresh; a release-notes row appeared with no update.
- Turn-card headers wrapped vertically on mobile.

## [0.41.0] - 2026-08-27

### Added

- ` ```mermaid ` blocks in replies are rendered as diagrams. The renderer is fetched only
  when used and never reaches the internet.
- Task lists, `<details>`, table alignment and `<kbd>` now render.
- The update confirmation shows the release notes for the version you are about to install.
- Installing with a Claude subscription obtains the token through a browser login.
  Previously you had to install a separate CLI and paste the token
  (`tiguclaw claude-auth` re-runs it).

### Changed

- Tool activity is preserved when reopening old conversations. Previously the text
  remained but the tool cards disappeared after a few days.
- The brand icon background is transparent — no black square in light themes.
- The agent knows its home directory and install location, so requests that place files
  land in the right place.

### Fixed

- `doctor` also checks the Claude runner — a present key with a missing runner is no
  longer reported as healthy.
- Claude launch failures are reported in plain language instead of internal option names.
- The browser kept using the old icon after a change.

## [0.40.1] - 2026-08-27

### Fixed

- Search (`Grep`/`Glob`) was silently dead on machines missing its underlying tool.
  It is now fetched at boot if absent, without delaying startup; if the download fails
  the reason is logged and retried next boot.

## [0.40.0] - 2026-08-27

### Added

- Themes are a single file. A `theme.css` in your home directory overrides colours,
  base font size and per-panel fonts. Any `<name>.css` under `themes/` becomes an option
  (`dark` and `light` ship by default), and you can ask the agent to switch.
- Search results can be narrowed to one session, via the toggle or by clicking a session
  name in the results.

### Changed

- The update button appears only when the version actually changed, not on every commit.
  Calling `/update` still pulls the latest state.
- Removed the permanently disabled buttons from the module task list.

### Fixed

- One plugin's configuration typo disabled every plugin after it. Only the faulty one is
  skipped now, with the reason logged.
- An empty value in a translation file overrode the base language, blanking parts of the UI.
- Deleted theme and language files remained listed after an update.
- The HTTP bridge could terminate the daemon if serialising a JSON response failed (latent).

---

Entries before 0.40.0 are available in Korean only — see [CHANGELOG.ko.md](CHANGELOG.ko.md).

[Unreleased]: https://github.com/tigu77/tiguclaw/compare/v0.49.0...HEAD
[0.49.0]: https://github.com/tigu77/tiguclaw/compare/v0.48.0...v0.49.0
[0.48.0]: https://github.com/tigu77/tiguclaw/compare/v0.47.0...v0.48.0
[0.47.0]: https://github.com/tigu77/tiguclaw/compare/v0.46.0...v0.47.0
[0.46.0]: https://github.com/tigu77/tiguclaw/compare/v0.45.0...v0.46.0
[0.45.0]: https://github.com/tigu77/tiguclaw/compare/v0.44.1...v0.45.0
[0.44.1]: https://github.com/tigu77/tiguclaw/compare/v0.44.0...v0.44.1
[0.44.0]: https://github.com/tigu77/tiguclaw/compare/v0.43.2...v0.44.0
[0.43.2]: https://github.com/tigu77/tiguclaw/compare/v0.43.1...v0.43.2
[0.43.1]: https://github.com/tigu77/tiguclaw/compare/v0.43.0...v0.43.1
[0.43.0]: https://github.com/tigu77/tiguclaw/compare/v0.42.1...v0.43.0
[0.42.1]: https://github.com/tigu77/tiguclaw/compare/v0.42.0...v0.42.1
[0.42.0]: https://github.com/tigu77/tiguclaw/compare/v0.41.0...v0.42.0
[0.41.0]: https://github.com/tigu77/tiguclaw/compare/v0.40.1...v0.41.0
[0.40.1]: https://github.com/tigu77/tiguclaw/compare/v0.40.0...v0.40.1
[0.40.0]: https://github.com/tigu77/tiguclaw/compare/v0.39.1...v0.40.0
