# LLM gateway

Let your own apps borrow tiguclaw's provider pool through an **OpenAI-compatible API** — one endpoint instead of one SDK per provider.

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

- ⚠️ **Don't put a subscription token behind this.** The gateway is where your own apps use this
  pool as their backend. With a subscription (Claude Pro/Max, ChatGPT Plus/Pro) token behind it,
  **a personal subscription becomes an arbitrary app's API backend** — a different thing from
  interactive personal use, and possibly not permitted by that provider's terms. Point the gateway's
  profile at **API-key providers** (or local Ollama) via `gateway.models`. Background:
  [Setup & operations · Before you use a subscription token](setup.en.md#before-you-use-a-subscription-token).

- **It answers as your app, not as the assistant.** Your `system` message is used as-is; no tiguclaw persona, tools, skills, or memory ride along. Calls run in an isolated working directory, so nothing leaks even with no `system` message. (Account details the provider itself injects are outside tiguclaw's control.)
- **The call is logged; the content isn't.** Gateway calls never mix into your conversations, but they do appear in the dashboard's **external call log** — not what was said, just which model handled how many messages, with tokens, duration, and success, all on your machine.
- **Function calling works on a subscription.** Send `tools` and the model returns `tool_calls` without executing them — whichever adapter runs the turn, no API key required. `tool_choice` (`"none"`, `"required"`, or a named function) is enforced.
- **Every response is one of three things** — a tool call, text, or an explicit error. Never an empty success.
- **Call it from your app's server**, not from a browser: the token is a shared secret and the port listens on localhost only.
- **Prefer a different backend than your assistant's.** If your app hammers the same subscription the assistant lives on, you'll feel it in both.

---

[← README](../README.en.md) · [한국어](gateway.md)
