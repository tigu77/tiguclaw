// Test-owned loopback only. Stub the OS opener before importing product ESM; never open a real window.
import cp from "node:child_process";
import { request } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import path from "node:path";
import { assertIsolated, loadPluginModule } from "./_framework.js";
import { freePort } from "./_probe-helpers.js";
assertIsolated();
process.env.TIGUCLAW_DISABLE_ENV_FILE = "1";
// Product headless guard stays real; this API fixture never executes an OS opener.
process.env.DISPLAY = ":synthetic-home-test";
process.env.TIGUCLAW_HOME = mkdtempSync(path.join(process.env.TIGUCLAW_HOME!, "home-route-"));
const calls: Array<{ cmd: string; args: string[] }> = [];
let fail = false;
cp.execFile = ((cmd: string, args: string[], _opts: unknown, done: (e: Error | null) => void) => {
  const child = new EventEmitter();
  calls.push({ cmd, args });
  queueMicrotask(() => {
    if (fail) child.emit("error", new Error("synthetic opener failure"));
    else { child.emit("spawn"); done(null); }
  });
  return child;
}) as unknown as typeof cp.execFile;
syncBuiltinESMExports();
const port = await freePort();
process.env.HTTP_BRIDGE_PORT = String(port);
process.env.HTTP_BRIDGE_HOST = "127.0.0.1";
process.env.HTTP_BRIDGE_TOKEN = "synthetic-home-admin";
const { initStore } = await import("../../store/sessions.js");
initStore();
const { issueToken } = await import("../../store/bridge-tokens.js");
const read = issueToken("synthetic-home-read", "read").token;
const write = issueToken("synthetic-home-write", "write").token;
// Test-only integration boundary: runtime-load the edges through the existing harness.
// A literal (including typeof import) would add plugins/packages to the rootDir=src CI program.
// The full production build includes both edges explicitly; only the consumed interface belongs here.
interface HomeTestBridge {
  startChannel(handler: () => Promise<void>): Promise<void>;
  stop(): Promise<void>;
}
const { default: HttpBridge } = await loadPluginModule<{ default: new () => HomeTestBridge }>("../../../plugins/http-bridge/index.js");
const bridge = new HttpBridge();
await bridge.startChannel(async () => {});
const hit = async (base: number, route: string, method = "GET", token = read, headers: Record<string, string> = {}) => {
  const r = await fetch(`http://127.0.0.1:${base}${route}`, {
    method, headers: { Authorization: `Bearer ${token}`, ...headers },
    ...(method === "POST" ? { body: JSON.stringify({ path: "/not-the-home", command: "forbidden" }) } : {}),
    signal: AbortSignal.timeout(5000),
  });
  return { status: r.status, body: await r.json() };
};
try {
  const noAuth = await hit(port, "/home-directory", "GET", "invalid");
  const get = await hit(port, "/home-directory?path=/not-the-home");
  const denied = await hit(port, "/open-home", "POST", read);
  const deniedCalls = calls.length;
  const opened = await hit(port, "/open-home?path=/not-the-home", "POST", write);
  fail = true;
  const failed = await hit(port, "/open-home", "POST", write);
  fail = false;
  const dashPort = await freePort();
  process.env.DASHBOARD_PORT = String(dashPort);
  process.env.DASHBOARD_HOST = "127.0.0.1";
  await loadPluginModule<unknown>("../../../packages/dashboard/index.js");
  for (let n = 0; n < 100; n++) {
    try { await hit(dashPort, "/api/home-directory"); break; }
    catch { await new Promise((r) => setTimeout(r, 50)); }
  }
  const proxyGet = await hit(dashPort, "/api/home-directory?path=/not-the-home");
  const beforeCsrf = calls.length;
  const csrf = await hit(dashPort, "/api/open-home", "POST", read, { Origin: "https://evil.invalid", "Sec-Fetch-Site": "cross-site" });
  // fetch/undici may replace Host. Use HTTP directly to exercise DNS-rebinding protection.
  const host = await new Promise<{ status: number; body: unknown }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: dashPort, path: "/api/home-directory", headers: { Host: "evil.invalid" } }, (res) => {
      let text = "";
      res.on("data", (b) => { text += String(b); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) }));
    });
    req.on("error", reject);
    req.setTimeout(5000, () => req.destroy(new Error("Host test timed out")));
    req.end();
  });
  const csrfCalls = calls.length - beforeCsrf;
  const proxyOpen = await hit(dashPort, "/api/open-home?path=/not-the-home", "POST", read, { "Sec-Fetch-Site": "same-origin" });
  process.stdout.write("\n" + JSON.stringify({ syntheticDisplay: process.env.DISPLAY, home: process.env.TIGUCLAW_HOME, noAuth, get, denied, deniedCalls, opened, failed, proxyGet, csrf, host, csrfCalls, proxyOpen, calls }) + "\n");
} finally {
  await bridge.stop();
}
process.exit(0);
