# Setup & operations

Back to [README](../README.en.md) · [한국어](setup.md)

For people who just installed tiguclaw — or are about to. For *what it is*, see the [README](../README.en.md).

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
