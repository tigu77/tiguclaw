# Security & trust model (self-hosted)

**English** · [한국어](security.ko.md)

tiguclaw is **self-hosted** — you run it on your own machine or server, with your own keys and your own bot. The security model follows from that: it's built to be powerful *on a machine you control*, not locked down for untrusted environments.

Five things worth understanding before you run it.

## 1. The assistant can touch your machine — by design

The assistant has tools to **run shell commands and read/write files on your machine** — the same self-chosen model as Claude Code, where you hand an agent a shell on your own computer. It doesn't prompt on every call (`bypassPermissions`); instead it acts as an active safety reviewer and **asks for your OK before anything destructive or irreversible**.

So run it accordingly: install it on *your own* machine, not on an untrusted or shared multi-user server. Shared, multi-tenant setups would need a separate sandbox design, which isn't part of this project today.

## 2. The only thing exposed to the internet is one Telegram bot — lock it down

The CLI is local and the HTTP bridge requires a token. The **one entry point reachable from outside is your Telegram bot** — anyone who knows its username can send it a message.

So there's one must-do step:

> Put **only your own Telegram user ID** in `TELEGRAM_ALLOWED_USER_IDS` (in `.env`). Comma-separate if there's more than one.

- **Empty means the bot is locked** — every message is ignored. That's the safe default; it never opens itself up.
- Messages from anyone not on the allowlist are silently ignored (checked by `from.id`, in both DMs and groups) and only logged — never answered.

Skip this and anyone who finds your bot could drive your machine. It's the one security gate self-hosting depends on.

For an extra layer, lock the bot to 1:1 chats in [@BotFather](https://t.me/BotFather):
- `/setjoingroups` → **Disable** — stops the bot from being added to groups at all.
- `/setprivacy` → **Enable** (the default) — the bot only sees commands and replies in groups.

## 3. Never commit or share your secrets

Your `.env` holds the bot token, LLM API keys, OAuth tokens, and `HTTP_BRIDGE_TOKEN`.

- `.env` is gitignored — **never commit it, and never share it.**
- Before making any repo public, scan its tracked files *and its history* for secrets and personal data first (tokens, Telegram IDs, absolute paths, emails).

## 4. Where your data lives

Conversations, memory, the database, and logs all live under `<TIGUCLAW_HOME>` (default `~/.tiguclaw`) — outside the repo, on your machine. That's the directory to back up or migrate, and to keep private.

## 5. Cost

LLM calls are billed to you (pay-as-you-go API keys, or a subscription). Keep an eye on usage.
