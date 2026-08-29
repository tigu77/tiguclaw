# Writing a plugin

> 한국어: [plugins.md](plugins.md)

tiguclaw grows through plugins. You should be able to build **one widget and one tool** from
this page alone — if you can't, that's a documentation bug. Please open an issue.

---

## 0. Read this first — there is no sandbox

Plugins run **in the same process** as the daemon. They can read files, reach the network, and
import core modules. The permission block (`needs`) below is a **declaration, not a fence** —
you can work around it.

Two things follow:

- **Installing is a trust decision.** Don't install a plugin when you don't know who wrote it.
- **Authors carry responsibility too.** What you ask for and what you send out is your call.
  tiguclaw only blocks things that *hurt the user or the daemon*.

---

## 1. Thirty seconds: one widget

A plugin is a folder. Create `<home>/plugins/hello/` (home is usually `~/.tiguclaw`).

**`package.json`**

```json
{
  "name": "hello",
  "version": "0.1.0",
  "description": "A widget that says hi",
  "author": "Your Name",
  "license": "MIT",
  "type": "module",
  "tiguclaw": {
    "schemaVersion": 1,
    "kind": "service",
    "name": "hello",
    "entry": "index.js",
    "needs": { "ui": ["chat-widget"] }
  }
}
```

**`index.js`** — the default export is a **class**.

```js
export default class Hello {
  // A data route: how a widget gets a value without going through the model.
  getDataRoutes() {
    return {
      greeting: {
        ttlMs: 60_000,                       // no refetch inside this window
        handler: async (query) => ({ text: `Hello, ${query.who ?? "world"}!` }),
      },
    };
  }
}
```

**`web/widget.js`** — the part that runs in the browser.

```js
window.tiguWidgets.register("hello/card", {
  mount(root, data, ctx) {
    const p = document.createElement("p");
    p.textContent = data?.text ?? "…";
    root.appendChild(p);
    // Register cleanup here — it runs when the card leaves the screen.
    ctx.onDispose(() => { /* clearInterval, etc. */ });
  },
});
```

> ★**The return value of `mount` is ignored.** Register cleanup with `ctx.onDispose(fn)` (or
> export an `unmount(root)` alongside `mount`). `return () => {}` is silently dropped.

Restart the daemon and the log shows:

```
registered data routes from plugin: hello (greeting)
```

Then the value is at `/api/plugin-data/hello/greeting?who=you`.

> **To put the widget on your home screen, just ask** — *"put the hello card at the top of my
> home."* There is no drag-and-drop grid; layout is data the assistant writes.

---

## 2. The manifest — the `tiguclaw` block in `package.json`

| Key | Meaning |
|---|---|
| `schemaVersion` | `1` for now |
| `name` | Plugin name. Keep it the same as the folder |
| `entry` | Path relative to the folder. **Default export must be a class** |
| `kind` | See below. A string or an array |
| `needs` | What you're asking for (§4) |
| `settings` | What you ask the person (§5) |

`description`, `author`, `homepage` and `license` are read from the **standard npm fields** — we
didn't invent new keys. They show up in the plugin list, and **`author` matters most**: with no
sandbox, "who wrote this" is the only thing a person can judge at install time.

### `kind` — what you stand as

| kind | Implement | When |
|---|---|---|
| `service` | (nothing) | Tools, widgets, data only. **Most plugins** — providing them is enough |
| `trigger` | `startTrigger()` | You need to wake up on your own |
| `observer` | `startObserver()` | You watch what goes by |
| `channel` | `startChannel()`, `name` | You add a new conversation channel |

Whatever the kind, these are called **if present** (duck typing):

- `start()` — once, right after load
- `stop()` / `dispose()` — on disable or removal. **Clean up timers and subscriptions here**
- `getMcpServer()` — tools for the model (§3)
- `getDataRoutes()` — values for widgets (§6)

---

## 3. Tools — what the model calls

**You import nothing.** Declare them as plain data.

```js
export default class Hello {
  getTools() {
    return [
      {
        name: "say_hello",                  // lowercase, digits, underscore
        description: "Greets someone",      // ★the model picks by this. Always write it
        parameters: {
          who: { type: "string", description: "who to greet" },
        },
        handler: async ({ who }, host) => `Hello, ${who}!`,
      },
    ];
  }
}
```

- Parameter types are `string`, `number`, `boolean`. `enum: [...]` narrows a string, and
  `required: false` lets the model omit it.
- **Return a string and that's the answer.** For an error, return `{ text, isError: true }`.
- **Throwing won't break the conversation** — only that call comes back as an error.
- A typo in a declaration drops **only that tool**, with the reason in the log.

Tools appear the same across **every backend** (Claude, Codex, OpenAI) — and in every kind of
turn: your own chat, a scheduled run, a subagent.

> ★**Why not the SDK?** A plugin installed in your home has no `node_modules`, so
> `import ... from "@anthropic-ai/claude-agent-sdk"` **dies at load time.** You can run
> `npm i` in the plugin folder, but that measured **247 MB** — too much to declare one tool.
> If you already use the SDK, `getMcpServer()` still works; the two are siblings.

---

## 4. `needs` — what you're asking for

```json
"needs": {
  "network": ["api.example.com"],
  "ui": ["chat-widget"],
  "outbound": true,
  "llm": true
}
```

| Key | Meaning |
|---|---|
| `network` | Hosts `host.fetch` may reach (https, exact match) |
| `ui` | Where you attach — `["chat-widget"]` for now |
| `outbound` | You may speak on your own via `host.say()` |
| `llm` | You may call the model via `host.ask()` — **that model gets no tools** |

An unknown key is logged and ignored — the plugin still loads.

We only ask you to declare things that **cost the user something**: a message arriving on their
phone, money spent, tools holding power. Passive things — subscribing to events, for instance —
need no declaration.

And remember §0: this is **not a security boundary**. The value of declaring is that the person
installing can *see* what you're asking for.

---

## 5. `settings` — what you ask the person

```json
"settings": [
  { "key": "units", "type": "enum", "values": ["metric", "imperial"], "default": "metric" },
  { "key": "apiKey", "type": "secret" }
]
```

Types: `string`, `number`, `boolean`, `enum`, `secret`.

Rows in the settings screen are generated **from this declaration**. You don't write UI code.

★**`secret` values are never stored in a file.** They're read from the home `.env`, and the
screen only shows **whether one is set**. If it isn't set, the key is simply absent (not an
empty string).

The name is `TIGUCLAW_PLUGIN_<name>_<key>`, uppercased, with `-` replaced by `_`:

```
hello       / apiKey   →  TIGUCLAW_PLUGIN_HELLO_APIKEY
my-plugin   / api-key  →  TIGUCLAW_PLUGIN_MY_PLUGIN_API_KEY
```

---

## 6. Data routes — how widgets get values

```js
getDataRoutes() {
  return {
    forecast: {
      ttlMs: 10 * 60_000,
      handler: async (query, host) => {
        const r = await host.fetch(`https://api.example.com/f?q=${query.place}`);
        return await r.json();
      },
    },
  };
}
```

- Served at `GET /api/plugin-data/<plugin>/<route>?...`
- **Inside the TTL the cache answers** — no matter how many tabs, one call goes out. Concurrent
  calls are joined.
- **Failures are never cached** — a refresh retries.
- **You can return bytes**: `{ contentType: "image/png", body: Uint8Array }` (map tiles and the
  like). The cap is 2 MB.

---

## 7. `host` — everything a plugin can touch

Handed to `getDataRoutes` handlers and tool implementations.

| | |
|---|---|
| `host.fetch(url, init)` | Outbound. Only hosts listed in `needs.network` |
| `host.settings` | Only *your* settings (§5). Not other plugins', not core's |
| `host.dataDir` | Your storage (`<home>/plugins/<name>`) |
| `host.locale` | Configured language — for passing to external APIs |
| `host.log(msg)` | Logging, automatically prefixed |
| `host.postCard({text, widget, data})` | Attach a card to **the reply in progress** |
| `host.on(type, fn)` | Subscribe to core events. Trailing `.` means prefix (`"worker."`) |
| `host.say({channel, target, text})` | Speak **on your own** (`needs.outbound`) |
| `host.ask({prompt, scope})` | Ask the model (`needs.llm`) |

★**`say` and `ask` report failure only in their return value** — nothing is logged. Always
check it:

```js
const r = await host.say({ channel: "telegram", target: null, text: "done" });
if (!r.ok) host.log(`not sent: ${r.error}`);   // this is where a missing needs.outbound lands

const a = await host.ask({ prompt: "summarise in one line" });
if (a.ok) host.log(a.text);                     // ★using `a` directly prints [object Object]
```

`postCard` and `say` differ. The first attaches to a reply in progress, so it only works
**during a turn**; the second speaks first, and works any time.

`ask` is deliberately narrow — you can't pick a model or provider. The user's profile settings
decide that, so your plugin keeps working whichever backend they switch to. The conversation
key isn't a parameter either; it's derived as `plugin:<name>:<scope>`, so you can't reach someone
else's conversation.

**Want to do something periodically?** Just use `setInterval`. Nothing stops you — clean it up
in `stop()` / `dispose()`.

---

## 8. The browser side — `window.tiguWidgets`

```js
window.tiguWidgets.register("<plugin>/<widget>", {
  mount(root, data, ctx) {
    // ... draw inside root
    ctx.onDispose(() => { /* stop timers and subscriptions */ });
  },
  // optional — if you'd rather tear down yourself
  unmount(root) {},
});
```

★**Cleanup only happens via `ctx.onDispose` or `unmount`.** A function returned from `mount`
is not used.

What `ctx` gives you:

- `ctx.t("key")` — translation. Don't send sentences from the server. Put
  `web/locales/en.json` and `ko.json` next to your widget and they follow the user's language.
- `ctx.resource(name, fetchSnapshot)` — live values. Ordering, reconnects and snapshots are not
  your problem: `.subscribe(fn)` hands you values.
- `ctx.onDispose(fn)` — cleanup to run when the card goes away.
- `ctx.locale` — the viewer's language.

Files under `web/` are served at `/plugin-asset/<plugin>/<path>`. Link your CSS from there.

**Don't hard-code colours.** Use the theme tokens (`var(--fg)` and friends) and your widget
follows the user's theme.

---

## 9. Writing it in TypeScript

**Just write it.** Compile, and point `entry` at the output — there is nothing to import from us.

★**We don't ship a types package.** The contract is **this document**. What's written here
(`getTools`, `getDataRoutes`, `host.*`, `window.tiguWidgets`) **won't break.** Anything else is
outside the promise.

A types package would bring versioning, sync and deprecations along with it — more debt for us
than value for you. If that changes, we'll build it then.

JSDoc is plenty for editor help:

```js
/** @param {{ text: string }} args @param {import("./types").PluginHost} host */
handler: async (args, host) => `hi, ${args.text}`,
```

---

## 10. Shipping

All three work. The loader only wants a **manifest and an importable entry point**.

| Form | How |
|---|---|
| Source folder | Drop it in `<home>/plugins/<name>/` |
| Bundled `.js` | Point `entry` at the bundle. No need to ship source |
| npm | `npm pack`, unpack into the home, then **rename the folder to the plugin name** (★) |

★**The folder name must be the plugin name.** An `npm pack` tarball has `package/` at its
root, so unpacking as-is gives you `<home>/plugins/package/`. The plugin loads and its tools and
data routes work — but **widget assets 404 and `host.dataDir` points at a folder that doesn't
exist**. Half of it works, silently. Rename the folder after unpacking.

Bundling and npm also mean you **don't have to publish your source**.

---

## 11. Things that don't work, and things to watch

- **A throwing handler won't kill the daemon** — that one request becomes a 502 and the reason
  is logged. But throwing from `start()` fails that plugin's load (others are unaffected).
- **Don't put keys in widget config.** Names like `apiKey` or `authToken` are rejected. That
  record goes to the browser and into backups — use a `secret` setting or `.env`.
- **Clean up when you're disabled.** Timers and subscriptions left running mean a disabled
  plugin keeps waking up.
- **Don't commit build output into `plugins/<name>/src/`** — if `index.ts` imports `./x.js` and
  that file exists, the stale one wins.

---

## 12. When you're stuck

If a plugin doesn't appear, start with the log — the `[plugin-loader]` line says why.

```
tiguclaw logs | grep plugin
```

Still stuck? [Open an issue](https://github.com/tigu77/tiguclaw/issues).
**"I followed the guide and it didn't work" is a valid bug report.**
