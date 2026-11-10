/** Real local HTTP parser + source-evaluated handlers; synthetic auth/provider only, no daemon or credentials. */
import http from "node:http";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { EventEmitter } from "node:events";
import { AsyncLocalStorage } from "node:async_hooks";
import { assert as assertion, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";

const assert = (name: string, ok: boolean, got: unknown = ok): Assertion => assertion(name, ok, got);
const source = (file: string): string => readFileSync(new URL(`../../../${file}`, import.meta.url), "utf8");
// Strip imports only: evaluate the actual implementation with explicit synthetic boundaries.
const evaluate = (text: string, globals: Record<string, unknown>): any => {
  const ast = ts.createSourceFile("fixture.ts", text, ts.ScriptTarget.Latest, true);
  const body = ast.statements.filter((s) => !ts.isImportDeclaration(s)).map((s) => s.getFullText(ast)).join("\n");
  const output = ts.transpileModule(body, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  vm.runInNewContext(output, { exports, URL, URLSearchParams, Buffer, console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, ...globals });
  return exports;
};
const json = (res: http.ServerResponse, status: number, body: unknown): void => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
const request = (server: http.Server, target: string, method = "GET", headers: Record<string, string> = {}): Promise<{ status: number; text: string; allow?: string }> => new Promise((resolve, reject) => {
  const address = server.address();
  if (!address || typeof address === "string") return reject(new Error("listener missing"));
  const req = http.request({ host: address.address, port: address.port, path: target, method, headers: { Host: "localhost", ...headers }, timeout: 2000 }, (res) => {
    let text = "";
    res.on("data", (c) => { text += c; });
    res.on("end", () => resolve({ status: res.statusCode ?? 0, text, allow: res.headers.allow }));
  });
  req.on("timeout", () => req.destroy(new Error("request timeout")));
  req.on("error", reject); req.end();
});
const close = async (server: http.Server): Promise<void> => { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); };
const listen = async (server: http.Server): Promise<void> => { await new Promise<void>((r) => server.listen(0, "127.0.0.1", r)); };

export const check: RegressionCheck = {
  name: "http-oauth-request-boundaries",
  guards: "Malformed request targets escaped request catches, temporary admin tokens leaked, GET force ran providers, and OAuth bound wildcard/raced exchange.",
  run: async () => {
    assertIsolated();
    const out: Assertion[] = [];
    const body = await import(new URL("../../../plugins/http-bridge/http-body.ts", import.meta.url).href);
    const host = await import("../../core/net/host-guard.js");
    let calls: boolean[] = [];
    const auth = evaluate(source("plugins/http-bridge/routes-auth.ts"), {
      writeJson: json, getAuthProvider: (name: string) => name === "synthetic" ? { getUsage: async (force: boolean) => { calls.push(force); return { windows: [], measuredAt: 1 }; } } : undefined,
    });
    const bridgeSource = source("plugins/http-bridge/index.ts");
    const logs: string[] = [];
    const env: Record<string, string | undefined> = { HTTP_BRIDGE_PORT: "0" };
    const syntheticRows = new Map(["read", "write", "admin"].map((role) => [createHash("sha256").update(role).digest("hex"), { id: 1, role, expires_at: null, revoked_at: null }]));
    const tokenStore = evaluate(source("src/store/bridge-tokens.ts"), {
      createHash, process: { env }, getDb: () => ({ prepare: () => ({ get: (hash: string) => syntheticRows.get(hash) }) }),
    });
    const viewerScopes: unknown[] = [];
    const bridgeGlobals = {
      http: { ...http, createServer: (fn: http.RequestListener) => http.createServer((req, res) => {
        // Observe the OLD synchronous escape as a deterministic red, not a suite crash.
        try { fn(req, res); } catch { res.writeHead(599).end("escaped callback"); }
      }) }, process: { env }, crypto: { randomBytes: () => Buffer.from("synthetic-temporary-token") },
      console: { log() {}, warn() {}, error: (s: string) => logs.push(s) },
      ...host, writeJson: json, translate: (key: string) => key, withViewerLanguage: (lang: unknown, fn: () => unknown) => { viewerScopes.push(lang); return fn(); },
      verifyToken: tokenStore.verifyToken,
      respondToRequestFailure: body.respondToRequestFailure, portListenFailure: () => undefined,
      MCP_OAUTH_CALLBACK_PATH: "/mcp/callback", serveMcpOAuthCallback: async ({}, res: http.ServerResponse) => json(res, 200, { callback: true }),
      handleAuthUsage: auth.handleAuthUsage, handleHealth: async (ctx: any) => {
        if (ctx.url.searchParams.has("decode")) throw new URIError("bad escape");
        if (ctx.url.searchParams.has("large")) throw new body.BodyTooLargeError(1);
        json(ctx.res, 200, { ok: true });
        if (ctx.url.searchParams.has("after")) throw new TypeError("after response");
      },
    };
    const Bridge = evaluate(bridgeSource.slice(bridgeSource.indexOf("const ROLE_RANK")), bridgeGlobals).default;
    for (const missing of [undefined, "", "   "]) {
      env.HTTP_BRIDGE_TOKEN = missing;
      const b = new Bridge();
      out.push(assert("temporary token is still admin but never logged", b.resolveToken(b.ephemeralToken)?.role === "admin" && !logs.some((l) => l.includes(b.ephemeralToken)), logs.join(";")));
    }
    env.HTTP_BRIDGE_TOKEN = "explicit";
    const bridge = new Bridge();
    await bridge.ensureServer();
    const server = bridge.server as http.Server;
    try {
      console.log("  fixture bridge malformed");
      out.push(assert("bridge malformed URL reaches parser and returns 400", (await request(server, "//[")).status === 400));
      for (const [path, status] of [["/health", 200], ["/health?decode=1", 500], ["/health?large=1", 413], ["/health?after=1", 200], ["/health", 200]] as const) {
        out.push(assert(`bridge ${path} => ${status}`, (await request(server, path)).status === status));
      }
      out.push(assert("bridge Host rejected before health", (await request(server, "/health", "GET", { Host: "evil.invalid" })).status === 403));
      out.push(assert("MCP callback exception preserved", (await request(server, "/mcp/callback")).status === 200));
      viewerScopes.length = 0;
      const localised = await request(server, "/auth-usage?provider=unknown", "GET", { Authorization: "Bearer explicit", "Accept-Language": "en-US" });
      const authScope = viewerScopes.at(-1);
      const nonAuth = await request(server, "/health", "GET", { "Accept-Language": "ko-KR" });
      out.push(assert("real request viewer language is scoped only to auth routes", localised.status === 200 && authScope === "en-US" && nonAuth.status === 200 && viewerScopes.at(-1) === undefined, JSON.stringify({ authScope, viewerScopes, localised: localised.status, nonAuth: nonAuth.status })));
      for (const force of ["", "&force=0", "&force=1", "&force=0&force=1", "&force=1&force=0"]) {
        calls = [];
        const r = await request(server, "/auth-usage?provider=synthetic" + force, "GET", { Authorization: "Bearer explicit" });
        const rejected = force.includes("force=1");
        out.push(assert(`GET usage ${force}: provider calls and status`, rejected ? r.status === 405 && r.allow === "POST" && calls.length === 0 : r.status === 200 && calls.length === 1 && calls[0] === false, JSON.stringify({ r, calls })));
      }
      for (const token of ["read", "write", "admin", "explicit", "invalid"]) {
        calls = [];
        const r = await request(server, "/auth-usage?provider=synthetic&force=0", "POST", { Authorization: `Bearer ${token}` });
        const allowed = ["write", "admin", "explicit"].includes(token);
        out.push(assert(`POST ${token} role and forced provider call`, allowed ? r.status === 200 && calls.length === 1 && calls[0] === true : r.status === (token === "read" ? 403 : 401) && calls.length === 0, JSON.stringify({ r, calls })));
      }
      out.push(assert("unknown usage provider stays null", JSON.parse((await request(server, "/auth-usage?provider=unknown", "GET", { Authorization: "Bearer explicit" })).text).usage === null));
    } finally { await close(server); }

    console.log("  fixture dashboard");
    const dashboardSource = source("packages/dashboard/index.ts");
    for (const value of [undefined, "", "   ", "explicit"]) {
      let exit: number | undefined; let token: unknown;
      try {
        token = evaluate(dashboardSource.slice(dashboardSource.indexOf("const BRIDGE_TOKEN ="), dashboardSource.indexOf("const bridgeUrl =")) + "\nexports.token = TOKEN;", {
          process: { env: { HTTP_BRIDGE_TOKEN: value }, exit: (code: number) => { exit = code; throw new Error("synthetic exit"); } }, parseAllowedHosts: host.parseAllowedHosts,
        }).token;
      } catch { /* expected missing-token exit */ }
      out.push(assert("dashboard requires explicit token; no temporary sharing", value === "explicit" ? token === "explicit" && exit === undefined : exit === 1, { value, exit, token }));
    }
    let proxyAuth = "";
    const proxy = evaluate(dashboardSource.slice(dashboardSource.indexOf("const proxyJson ="), dashboardSource.indexOf("// 바이너리 프록시")) + "\nexports.proxyJson = proxyJson;", {
      TOKEN: "explicit", bridgeUrl: (p: string) => "http://synthetic" + p, viewerLanguageHeader: () => ({}),
      fetch: async (_: string, init: any) => { proxyAuth = init.headers.Authorization; return { status: 200, headers: { get: () => "application/json" }, text: async () => "{}" }; },
    });
    await proxy.proxyJson({ writeHead() {}, end() {} }, "/auth-usage", { method: "POST" });
    out.push(assert("dashboard proxy injects explicit token", proxyAuth === "Bearer explicit", proxyAuth));
    const dashboardBlock = dashboardSource.slice(dashboardSource.indexOf("const server = http.createServer"), dashboardSource.indexOf('// 포트를 못 열면')) + "\nexports.server = server;";
    let upstream: { method?: string; path: string }[] = [];
    const dash = evaluate(dashboardBlock, {
      http, PLUGIN_ASSET_PREFIX: "/plugin-asset/", DASHBOARD_PORT: 0, ALLOWED_HOSTS: new Set(), ...host,
      viewerLanguage: new AsyncLocalStorage(),
      resolvePluginAssetIn: () => { throw new URIError("synthetic decode failure"); },
      path: { join: () => "synthetic" }, appRoot: () => "synthetic", getPaths: () => ({ commonPlugins: "synthetic" }), existsSync: () => false,
      proxyJson: async (res: http.ServerResponse, path: string, init?: { method?: string }) => { upstream.push({ path, method: init?.method }); json(res, 200, { ok: true }); if (path.includes("after")) throw new Error("after"); },
    }).server as http.Server;
    await listen(dash);
    try {
      // The old async handler discards its promise. Do not crash the runner to demonstrate it.
      const bounded = dashboardBlock.includes('}).catch(') || dashboardBlock.includes('})().catch(');
      out.push(assert("dashboard callback has terminal rejection recovery", bounded));
      if (bounded) {
        out.push(assert("dashboard parser malformed =>400", (await request(dash, "//[")).status === 400));
        out.push(assert("dashboard route decode failure =>500 not 400", (await request(dash, "/plugin-asset/%ZZ")).status === 500));
      }
      console.log("  fixture dashboard usage");
      for (const query of ["&force=1", "&force=0&force=1", "&force=1&force=0"]) {
        upstream = []; const r = await request(dash, "/api/auth-usage?provider=synthetic" + query);
        out.push(assert("dashboard GET force never proxies", r.status === 405 && r.allow === "POST" && upstream.length === 0, JSON.stringify({ r, upstream })));
      }
      for (const [method, headers, status, count] of [
        ["POST", { "sec-fetch-site": "cross-site" }, 403, 0],
        ["POST", { "sec-fetch-site": "same-origin" }, 200, 1],
        ["POST", { Host: "evil.invalid" }, 403, 0],
        ["GET", {}, 200, 1], ["HEAD", {}, 404, 0], ["PUT", {}, 404, 0],
      ] as [string, Record<string, string>, number, number][]) {
        upstream = []; const r = await request(dash, "/api/auth-usage?provider=synthetic", method, headers);
        out.push(assert(`dashboard ${method} protects proxy and survives`, r.status === status && upstream.length === count && (count === 0 || (upstream[0]?.method ?? "GET") === method), JSON.stringify({ r, upstream })));
      }
      if (bounded) {
        out.push(assert("dashboard sent-response rejection recovered", (await request(dash, "/api/auth-usage?provider=after")).status === 200));
        out.push(assert("dashboard next normal request survives", (await request(dash, "/api/auth-usage")).status === 200));
      }
    } finally { await close(dash); }
    console.log("  fixture UI");
    const ui = source("packages/dashboard/js/view-plugins.js");
    const fetchBody = ui.slice(ui.indexOf('const r = await fetch(\n            "/api/auth-usage'), ui.indexOf('const d = await r.json();', ui.indexOf('const r = await fetch(\n            "/api/auth-usage')));
    for (const force of [false, true]) {
      let method = "";
      await evaluate(`exports.run = async () => { ${fetchBody} };`, { force, provider: "synthetic", fetch: async (_: string, options: any) => { method = options.method ?? "GET"; } }).run();
      out.push(assert(`UI force=${force} method`, method === (force ? "POST" : "GET"), method));
    }

    console.log("  fixture OAuth");
    const loginSource = source("src/core/llm-runtime/adapters/openai-codex-oauth-login.ts");
    let exchanges = 0;
    let release: (() => void) | undefined;
    let listeners: http.Server[] = [];
    const addresses: any[] = [];
    const makeServer = (listener?: http.RequestListener): http.Server => {
      const s = http.createServer(listener);
      const original = s.listen.bind(s);
      s.listen = ((options: any, cb: any) => {
        addresses.push(options);
        // Test port only: same dual-family binding semantics, no operational port 1455.
        return original({ ...options, port: 0 }, cb);
      }) as typeof s.listen;
      listeners.push(s); return s;
    };
    const loginGlobals = {
      createServer: makeServer,
      createAuthorizationFlow: async () => ({ state: "state", pkce: { verifier: "verifier" }, url: "https://example.invalid/authorize" }),
      exchangeAuthorizationCode: async () => { exchanges++; await new Promise<void>((r) => { release = r; }); return { expires: Date.now() + 1000 }; },
      upsertCodexTokens: async () => {},
    };
    const login = evaluate(loginSource, loginGlobals);
    if (!login.listenCodexCallback) {
      out.push(assert("OAuth has explicit dual-loopback lifecycle", false, Object.keys(login)));
    } else {
      try {
        const plan = await login.beginCodexLogin();
        out.push(assert("both explicit loopback families and ipv6Only", plan.autoCallback && addresses.length === 2 && addresses[0].host === "127.0.0.1" && addresses[1].host === "::1" && addresses[1].ipv6Only === true, JSON.stringify(addresses)));
        const live = listeners.filter((s) => s.listening);
        out.push(assert("OAuth malformed request =>400", (await request(live[0]!, "//[")).status === 400));
        out.push(assert("invalid state never consumes session", (await request(live[0]!, "/auth/callback?code=c&state=wrong")).status === 400 && exchanges === 0));
        await request(live[0]!, "/auth/callback?code=c&state=state");
        await login.finishCodexLogin("code=c&state=state");
        if (live[1]) await request(live[1], "/auth/callback?code=c&state=state");
        out.push(assert("callback + manual + second family exchange exactly once", exchanges === 1, exchanges));
        release?.(); await new Promise((r) => setTimeout(r, 20));
        out.push(assert("successful login closes both listeners", live.every((s) => !s.listening)));
        listeners = []; addresses.length = 0;
        await login.beginCodexLogin();
        const ipv6 = listeners.find((s) => (s.address() as any)?.family === "IPv6");
        if (ipv6) { await request(ipv6, "/auth/callback?code=c&state=state"); release?.(); await new Promise((r) => setTimeout(r, 20)); }
        out.push(assert("IPv6 callback completes and closes both", Boolean(ipv6) && listeners.every((s) => !s.listening)));
      } finally {
        release?.(); for (const s of listeners) await close(s);
      }
      listeners = [];
      await login.beginCodexLogin();
      await request(listeners[0]!, "/auth/callback?error=access_denied&state=state");
      out.push(assert("OAuth explicit cancellation closes both listeners", listeners.every((s) => !s.listening)));
      listeners = [];
      await login.beginCodexLogin();
      const beforeManual = exchanges;
      const manualDone = login.finishCodexLogin("code=c&state=state");
      await request(listeners[0]!, "/auth/callback?code=c&state=state");
      out.push(assert("manual-first callback race exchanges once", exchanges === beforeManual + 1, exchanges));
      release?.(); await manualDone;
      out.push(assert("manual-first completion closes both", listeners.every((s) => !s.listening)));
      // Bind result matrix: only unsupported families fallback; occupancy closes partial success.
      for (const codes of [[undefined, "EAFNOSUPPORT"], ["EADDRNOTAVAIL", undefined], [undefined, "EADDRINUSE"], ["EADDRINUSE", undefined], ["EADDRINUSE", "EADDRINUSE"], ["EAFNOSUPPORT", "EAFNOSUPPORT"]]) {
        const opened: any[] = []; let index = 0;
        const fake = evaluate(loginSource, { ...loginGlobals, createServer: () => {
          const s: any = new EventEmitter(); s.closed = false;
          s.close = () => { s.closed = true; };
          s.listen = (_: unknown, cb: () => void) => { const code = codes[index++]; queueMicrotask(() => code ? s.emit("error", Object.assign(new Error(code), { code })) : cb()); return s; };
          opened.push(s); return s;
        } });
        let ok = false; try { const binding = await fake.listenCodexCallback(() => {}); ok = true; binding.close(); } catch { /* expected errors */ }
        const expected = codes.includes(undefined) && !codes.includes("EADDRINUSE");
        out.push(assert(`loopback bind ${JSON.stringify(codes)} cleanup`, ok === expected && opened.every((s) => s.closed), { ok, expected }));
      }
    }
    // The real binder retains error ownership after listen and after close. No real socket fault needed.
    for (const phase of ["listening", "closed", "binding"] as const) {
      const opened: any[] = []; let notified = 0; let escaped = false; let failed = false;
      const fake = evaluate(loginSource, { ...loginGlobals, createServer: () => {
        const s: any = new EventEmitter(); s.closed = false;
        s.close = () => { s.closed = true; };
        s.listen = (_: unknown, cb: () => void) => {
          queueMicrotask(() => {
            if (phase === "binding" && opened.length === 2) {
              try { opened[0].emit("error", new Error("synthetic late error")); } catch { escaped = true; }
            }
            cb();
          }); return s;
        };
        opened.push(s); return s;
      } });
      let binding: any;
      try { binding = await fake.listenCodexCallback(() => {}, () => { notified++; }); } catch { failed = true; }
      if (phase !== "binding") {
        if (phase === "closed") binding?.close();
        try { opened[0].emit("error", new Error("synthetic late error")); } catch { escaped = true; }
      }
      out.push(assert(`OAuth ${phase} late error is contained and closes all`, !escaped && opened.every((s) => s.closed) && (phase !== "binding" || failed), { escaped, failed, notified }));
      binding?.close();
    }
    for (const mode of ["ipv4-busy", "ipv6-busy", "both-unavailable", "late-error", "timeout"] as const) {
      const opened: any[] = []; const timers = new Set<() => void>(); let exchanges = 0;
      const core = evaluate(loginSource, { ...loginGlobals,
        exchangeAuthorizationCode: async () => { exchanges++; return { expires: Date.now() + 1000 }; },
        setTimeout: (cb: () => void) => { timers.add(cb); return cb; }, clearTimeout: (cb: () => void) => { timers.delete(cb); },
        createServer: () => {
          const index = opened.length; const s: any = new EventEmitter(); s.closed = false;
          s.close = () => { s.closed = true; };
          s.listen = (_: unknown, cb: () => void) => {
            const code = (mode === "ipv4-busy" && index === 0) || (mode === "ipv6-busy" && index === 1) ? "EADDRINUSE" : mode === "both-unavailable" ? "EAFNOSUPPORT" : null;
            queueMicrotask(() => code ? s.emit("error", Object.assign(new Error(code), { code })) : cb()); return s;
          }; opened.push(s); return s;
        },
      });
      const plan = await core.beginCodexLogin();
      let escaped = false;
      if (mode === "late-error") { try { opened[0].emit("error", new Error("synthetic late")); } catch { escaped = true; } }
      if (mode === "timeout") for (const cb of timers) cb();
      const result = await core.finishCodexLogin("code=c&state=state");
      // Errors queued after terminal cleanup are still owned, not uncaught process errors.
      for (const s of opened) { try { s.emit("error", new Error("after cleanup")); } catch { escaped = true; } }
      out.push(assert(`dashboard ${mode} manual recovery/lifetime closes all`, !escaped && result.ok === (mode !== "timeout") && exchanges === (mode === "timeout" ? 0 : 1) && timers.size === 0 && opened.every((s) => s.closed) && plan.autoCallback === (mode === "late-error" || mode === "timeout"), { escaped, result, exchanges, timers: timers.size, plan }));
    }
    // CLI recovery/termination runs the actual main with synthetic readline, timers and exchange.
    for (const mode of ["ipv4-busy", "ipv6-busy", "both-unavailable", "late-error", "eof", "timeout", "manual-first", "pending-bind", "pending-bind-timeout", "eof-in-flight", "timeout-in-flight"] as const) {
      const opened: any[] = []; const timers = new Map<object, { cb: () => void; ms: number }>();
      let exchanges = 0; let browserOpens = 0; let closedInput = false; let outcome = "pending"; let successLogs = 0;
      let releaseExchange: (() => void) | undefined; let releaseBind: (() => void) | undefined;
      const rl = Object.assign(new EventEmitter(), { close() { closedInput = true; rl.emit("close"); } });
      const globals = { ...loginGlobals, createServer: (callback: any) => {
        const index = opened.length; const s: any = new EventEmitter(); s.closed = false; s.callback = callback;
        s.close = () => { s.closed = true; };
        s.listen = (_: unknown, cb: () => void) => {
          const code = (mode === "ipv4-busy" && index === 0) || (mode === "ipv6-busy" && index === 1) ? "EADDRINUSE" : mode === "both-unavailable" ? "EAFNOSUPPORT" : null;
          const finish = () => code ? s.emit("error", Object.assign(new Error(code), { code })) : cb();
          if ((mode === "pending-bind" || mode === "pending-bind-timeout") && index === 0) releaseBind = finish;
          else queueMicrotask(finish);
          return s;
        }; opened.push(s); return s;
      } };
      const core = evaluate(loginSource, globals);
      const cliSource = source("src/scripts/codex-auth.ts");
      const cli = evaluate(cliSource.slice(0, cliSource.indexOf("main().catch")) + "\nexports.main = main;", {
        ...globals, PORT: 1455, CALLBACK_PATH: "/auth/callback",
        console: { log: (s: string) => { if (s.includes("Got the token")) successLogs++; }, warn() {}, error() {} },
        listenCodexCallback: core.listenCodexCallback, respondToCodexCallbackFailure: core.respondToCodexCallbackFailure,
        parseRedirectInput: core.parseRedirectInput, canOpenBrowser: () => true, openInBrowser: () => { browserOpens++; },
        credentialFollowAvailable: () => false, homeEnvPath: () => "/synthetic/.env",
        createInterface: () => rl, process: { env: {}, platform: "darwin", stdin: {} },
        setTimeout: (cb: () => void, ms: number) => { const timer = {}; timers.set(timer, { cb, ms }); return timer; },
        clearTimeout: (timer: object) => { timers.delete(timer); },
        completeCodexLogin: async () => { exchanges++; await new Promise<void>((r) => { releaseExchange = r; }); return { expiresInSec: 1, clearedCooldowns: 0 }; },
      });
      const done = cli.main().then(() => { outcome = "resolved"; }, () => { outcome = "rejected"; });
      const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
      await flush();
      if (mode === "late-error") {
        let escaped = false; try { opened[0].emit("error", new Error("synthetic late")); } catch { escaped = true; }
        out.push(assert("CLI late server error never escapes", !escaped));
      }
      if (mode === "eof") rl.emit("close");
      else if (mode === "timeout" || mode === "pending-bind-timeout") {
        const ttl = [...timers.values()].find((t) => t.ms === 10 * 60 * 1000);
        out.push(assert("CLI has finite login lifetime", Boolean(ttl)));
        ttl?.cb(); releaseBind?.(); await flush();
      } else {
        rl.emit("line", "code=c&state=wrong");
        out.push(assert(`CLI ${mode} wrong state never exchanges`, exchanges === 0));
        rl.emit("line", "code=c&state=state");
        rl.emit("line", "code=c&state=state");
        if (mode === "manual-first") {
          const res: any = { writeHead() { return this; }, end() { return this; } };
          opened[0].callback({ url: "/auth/callback?code=c&state=state" }, res);
        }
        if (mode === "eof-in-flight") rl.emit("close");
        if (mode === "timeout-in-flight") [...timers.values()].find((t) => t.ms === 10 * 60 * 1000)?.cb();
        await flush(); releaseExchange?.(); await flush();
        releaseBind?.(); await flush();
      }
      await flush();
      const terminal = mode === "eof" || mode === "timeout" || mode === "pending-bind-timeout" || mode === "timeout-in-flight";
      out.push(assert(`CLI ${mode} settles, releases timers/input/listeners, exchange once`, outcome === (terminal ? "rejected" : "resolved") && exchanges === (terminal && mode !== "timeout-in-flight" ? 0 : 1) && successLogs === (terminal ? 0 : 1) && closedInput && timers.size === 0 && opened.every((s) => s.closed), { outcome, exchanges, successLogs, closedInput, timers: timers.size, closed: opened.map((s) => s.closed) }));
      if (!terminal && mode !== "pending-bind") out.push(assert(`CLI ${mode} browser still opens for manual recovery`, browserOpens === 1, browserOpens));
      // Fixture-only drain for a red candidate that does not yet own EOF/timeout.
      if (outcome === "pending") { rl.emit("line", "code=c&state=state"); await flush(); releaseExchange?.(); await done; }
    }
    // CLI entry uses the same dual listener, but owns its own callback/manual settlement.
    if (login.listenCodexCallback) {
      listeners = [];
      let completeCalls = 0;
      let finishCli: (() => void) | undefined;
      const rl = Object.assign(new EventEmitter(), { close() {} });
      const cliSource = source("src/scripts/codex-auth.ts");
      const cli = evaluate(cliSource.slice(0, cliSource.indexOf("main().catch")) + "\nexports.main = main;", {
        ...loginGlobals, PORT: 1455, CALLBACK_PATH: "/auth/callback",
        listenCodexCallback: login.listenCodexCallback, respondToCodexCallbackFailure: login.respondToCodexCallbackFailure,
        parseRedirectInput: login.parseRedirectInput, canOpenBrowser: () => false, openInBrowser: () => {},
        credentialFollowAvailable: () => false, homeEnvPath: () => "/synthetic/.env",
        createInterface: () => rl, process: { env: {}, platform: "darwin", stdin: {} },
        completeCodexLogin: async () => { completeCalls++; await new Promise<void>((r) => { finishCli = r; }); return { expires: 1 }; },
      });
      const done = cli.main();
      void done.catch(() => {}); // observed below; keep fixture setup failures inside the runner
      try {
        for (let n = 0; n < 50 && listeners.filter((s) => s.listening).length < 2; n++) await new Promise((r) => setTimeout(r, 2));
        const live = listeners.filter((s) => s.listening);
        out.push(assert("CLI malformed URL returns 400", (await request(live[0]!, "//[")).status === 400));
        out.push(assert("CLI invalid state does not settle", (await request(live[0]!, "/auth/callback?code=c&state=wrong")).status === 400));
        rl.emit("line", "code=c&state=wrong");
        await request(live[0]!, "/auth/callback?code=c&state=state");
        rl.emit("line", "code=c&state=state");
        if (live[1]) await request(live[1], "/auth/callback?code=c&state=state");
        out.push(assert("CLI callback/manual exchange exactly once", completeCalls === 1, completeCalls));
        finishCli?.(); await done;
        out.push(assert("CLI settles and closes both listeners", live.every((s) => !s.listening)));
      } finally { finishCli?.(); for (const server of listeners) await close(server); }
      // Timeout/cancel uses the existing session timer and clears listeners, no new timers/environment.
      let expire: (() => void) | undefined;
      listeners = [];
      const timed = evaluate(loginSource, { ...loginGlobals, setTimeout: (cb: () => void) => { expire = cb; return { unref() {} }; }, clearTimeout() {} });
      await timed.beginCodexLogin(); expire?.();
      out.push(assert("OAuth timeout closes both listeners", listeners.length === 2 && listeners.every((s) => !s.listening)));
    }
    // Authorization and exchange keep the provider-registered localhost redirect.
    const oauthAuth = source("src/core/llm-runtime/adapters/openai-codex-oauth-auth.ts");
    let exchangeRedirect = "";
    const authorization = evaluate(oauthAuth.slice(oauthAuth.indexOf("const CLIENT_ID"), oauthAuth.indexOf("export const refreshAccessToken")), {
      generatePkceUpstream: async () => ({ verifier: "v", challenge: "c" }), randomBytes: () => Buffer.from("synthetic"),
      fetch: async (_: string, init: any) => { exchangeRedirect = init.body.get("redirect_uri"); return { ok: true, json: async () => ({ access_token: "synthetic", refresh_token: "synthetic", expires_in: 1 }) }; },
    });
    const flow = await authorization.createAuthorizationFlow();
    await authorization.exchangeAuthorizationCode("synthetic", "v");
    out.push(assert("authorize and exchange redirect remain localhost", new URL(flow.url).searchParams.get("redirect_uri") === "http://localhost:1455/auth/callback" && exchangeRedirect === "http://localhost:1455/auth/callback", exchangeRedirect));
    // Execute the real init main + renderer with in-memory IO: no real .env or Telegram calls.
    const init = source("src/scripts/init.ts");
    for (const [exists, answer] of [[false, ""], [true, "no"], [true, ""], [true, "overwrite"], [true, "y"]] as const) {
      let generated = 0; let written = ""; let asked = 0;
      const initial = evaluate(init.slice(init.indexOf("const renderEnv ="), init.indexOf("main().catch")) + "\nexports.main = main;", {
        ENV_PATH: "/synthetic/.env", HOME_DIR: "/synthetic", existsSync: () => exists,
        ask: async () => { asked++; return answer; }, askProvider: async () => "openai",
        collectProviderConfig: async () => ({ anthropicKey: "", claudeOauthToken: "", openaiKey: "synthetic" }),
        collectTelegram: async () => ({ telegramToken: "", telegramUserIds: "" }),
        randomBytes: () => { generated++; return Buffer.from("synthetic-token"); }, mkdirSync() {},
        replacePrivateFile: async (_: string, text: string) => { written = text; }, rl: { close() {} },
        installedEnvLookup: () => () => undefined, initNextSteps: () => [], dashboardUrl: () => "http://synthetic",
        process: { env: {}, cwd: () => "/synthetic" },
      });
      await initial.main();
      const allowed = !exists || answer === "overwrite" || answer === "y";
      out.push(assert(`init existing=${exists} consent=${answer} preserves/generates`, allowed ? generated === 1 && written.includes("HTTP_BRIDGE_TOKEN=" + Buffer.from("synthetic-token").toString("hex")) && asked === (exists ? 1 : 0) : generated === 0 && written === "" && asked === 1, { generated, asked, wrote: written !== "" }));
    }
    // Health consumes identity, preserving all old payload fields and passing canonical input sources.
    const ops = source("plugins/http-bridge/routes-ops.ts");
    let health: any; let identityInput: any;
    const healthModule = evaluate(ops.slice(ops.indexOf("export const handleHealth"), ops.indexOf("export const handleLogStatus")), {
      writeJson: (_: unknown, __: number, payload: unknown) => { health = payload; }, VERSION: "test",
      getProcessIdentity: (input: unknown) => { identityInput = input; return { instanceId: "instance", bootId: "boot", startedAt: 10 }; },
      resolveHome: () => "/synthetic/home", sourceRoot: () => "/synthetic/repo", process: { env: { TIGUCLAW_RUNTIME: "source" }, uptime: () => 2 },
      getInflightTurns: () => ({ count: 1, keys: ["thread"] }), listProjectRuns: () => ["run"],
      ATTACH_MAX_FILE_BYTES: 1, ATTACH_MAX_TOTAL_BYTES: 2, ATTACH_MAX_COUNT: 3,
    });
    await healthModule.handleHealth({ res: {}, bus: { history: () => [1] }, sseClients: new Set([1]), channelHandler: null });
    out.push(assert("health identity serializes with sourceRoot input", health.instanceId === "instance" && health.bootId === "boot" && health.startedAt === 10 && identityInput?.home === "/synthetic/home" && identityInput.repoRoot === "/synthetic/repo" && identityInput.runtime === "source", { health, identityInput }));
    out.push(assert("health old fields preserved", health.ok && health.version === "test" && health.uptime_ms === 2000 && health.buffer_size === 1 && health.subscribers === 1 && health.channel_handler === false && health.active_turns === 1 && health.active_turn_threads[0] === "thread" && health.active_runs[0] === "run" && health.limits.attachment_count === 3, health));
    return out;
  },
};
