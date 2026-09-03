# Security & trust model (self-hosted)

[한국어](security.ko.md) · **English**

tiguclaw is **self-hosted** — you run it on your own machine or server, with your own keys and your own bot. The security model follows from that: it's built to be powerful *on a machine you control*, not locked down for untrusted environments.

Six things worth understanding before you run it.

## 1. The assistant can touch your machine — by design

The assistant has tools to **run shell commands and read/write files on your machine** — the same self-chosen model as Claude Code, where you hand an agent a shell on your own computer. It doesn't prompt on every call (`bypassPermissions`); instead it acts as an active safety reviewer and **asks for your OK before anything destructive or irreversible**.

So run it accordingly: install it on *your own* machine, not on an untrusted or shared multi-user server. Shared, multi-tenant setups would need a separate sandbox design, which isn't part of this project today.

## 2. Anything you install runs with the **same reach** as the assistant

Plugins run **in the daemon's own process**. There's no isolation — a plugin can read and write
files, reach the network, and call into the core directly. So everything in §1 is true not just of
the assistant, but of **every extension you install.**

A plugin declares what it wants via `needs` (external hosts, UI, speaking on its own, calling the
model). That's **a declaration, not a jail.** If a plugin goes through the channels tiguclaw
provides (`host.fetch` and friends), those declarations are enforced — but nothing stops it from
skipping them and doing the work itself. So read `needs` as *"what this plugin said it would do"*,
never as *"the most it can do"*.

> **Installing is a trust decision.** Don't install plugins from people you don't know. It's the
> same call as installing an npm package, except this code runs where your conversations, your
> files, and your keys are.

To see what's installed and what it asks for:

- **The plugin list in the dashboard** shows each plugin's declarations alongside it.
- **The boot log** records one line per plugin: `[plugin-loader] <name>: …`, listing what it
  declared. (Heads-up: that summary is currently written in Korean, wherever your locale is set.)
- If something looks off, **disable it** (from the dashboard) or **delete it** — a plugin is just a
  folder at `<TIGUCLAW_HOME>/plugins/<name>`.

### Two kinds, and they call for different judgment

They sit in one list, but they come from different places — and so does your decision.

| | Shipped with the app | Installed by you |
|---|---|---|
| Examples | Dashboard · Telegram · CLI · HTTP bridge | Whatever you dropped into `<TIGUCLAW_HOME>/plugins/` |
| Who wrote it | tiguclaw's own code — trust it as much as you trust the app | **Possibly someone you don't know** |
| What you do | Nothing (turn off what you don't use) | ★**Decide before installing** |

- The **shipped** ones are the product's plumbing. Turn off what you don't use — Telegram and the
  dashboard are both optional. The HTTP bridge is the one exception: disabling it would remove the
  very screen you'd use to turn it back on.
- The **installed** ones are what the warning above is about. The dashboard list shows the origin.

Skills and MCP servers work the same way. The assistant is told to assess a new extension and ask
before enabling it — but **the final call is yours.**

## 3. The only thing exposed to the internet is one Telegram bot — lock it down

The CLI is local and the HTTP bridge requires a token. The **one entry point reachable from outside is your Telegram bot** — anyone who knows its username can send it a message.

So there's one must-do step:

> Put **only your own Telegram user ID** in `TELEGRAM_ALLOWED_USER_IDS` (in `.env`). Comma-separate if there's more than one.

- **Empty means the bot is locked** — every message is ignored. That's the safe default; it never opens itself up.
- Messages from anyone not on the allowlist are silently ignored (checked by `from.id`, in both DMs and groups) and only logged — never answered.

Skip this and anyone who finds your bot could drive your machine. It's the one security gate self-hosting depends on.

For an extra layer, lock the bot to 1:1 chats in [@BotFather](https://t.me/BotFather):
- `/setjoingroups` → **Disable** — stops the bot from being added to groups at all.
- `/setprivacy` → **Enable** (the default) — the bot only sees commands and replies in groups.

## 4. Never commit or share your secrets

Your `.env` holds the bot token, LLM API keys, OAuth tokens, and `HTTP_BRIDGE_TOKEN`.

- `.env` is gitignored — **never commit it, and never share it.**
- Before making any repo public, scan its tracked files *and its history* for secrets and personal data first (tokens, Telegram IDs, absolute paths, emails).

## 5. Where your data lives

Conversations, memory, the database, and logs all live under `<TIGUCLAW_HOME>` (default `~/.tiguclaw`) — outside the repo, on your machine. That's the directory to back up or migrate, and to keep private.

## 6. Cost

LLM calls are billed to you (pay-as-you-go API keys, or a subscription). Keep an eye on usage.
