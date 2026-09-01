# Changelog

All notable changes to this project are documented here.
[한국어 변경 내역](CHANGELOG.ko.md)

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/tigu77/tiguclaw/compare/v0.45.0...HEAD
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
