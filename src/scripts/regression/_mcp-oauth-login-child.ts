/**
 * `mcp-oauth-login-flow` 의 자식 — **브리지를 이 프로세스에 띄우고** 원격 MCP OAuth 로그인 2묶음(시작 도구 · 루프백 콜백 · `/mcp_login` 붙여넣기)을
 * 실제로 돌린다. 포트를 열고 홈을 바꾸므로 자식에서만 한다(`_bridge-roles-child` 와 같은 이유). 결과는 JSON 한 줄.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assertIsolated } from "./_framework.js";
import { freePort } from "./_probe-helpers.js";
import { startFakeOAuthMcp } from "./_fake-oauth-server.js";

assertIsolated();
const home = mkdtempSync(path.join(process.env.TIGUCLAW_HOME!, "mcp-login-"));
process.env.TIGUCLAW_HOME = home;
const port = await freePort();
process.env.HTTP_BRIDGE_PORT = String(port);
process.env.HTTP_BRIDGE_TOKEN = "regr-mcp-login-admin";

const logs: string[] = [];
for (const m of ["log", "warn", "error"] as const) {
  const orig = console[m].bind(console);
  console[m] = (...a: unknown[]) => {
    logs.push(a.map(String).join(" "));
    void orig;
  };
}

const { initStore } = await import("../../store/sessions.js");
initStore();
const fake = await startFakeOAuthMcp();
writeFileSync(path.join(home, "mcp.json"), JSON.stringify({ mcpServers: { notionish: { type: "http", url: fake.url } } }));

const { default: HttpBridge } = (await import(new URL("../../../plugins/http-bridge/index.ts", import.meta.url).href)) as {
  default: new () => { startChannel: (h: () => Promise<void>) => Promise<void>; stop: () => Promise<void> };
};
const bridge = new HttpBridge();
await bridge.startChannel(async () => {});
const { createMcpAdminMcpServer } = await import("../../core/llm-runtime/capabilities/mcp-admin-mcp.js");
const oauth = await import("../../core/mcp-oauth.js");
const reg = (createMcpAdminMcpServer(home).instance as unknown as { _registeredTools: Record<string, { handler: (a: unknown, x?: unknown) => Promise<{ content: Array<{ text: string }> }> }> })._registeredTools;
const toolText = async (name: string, args: unknown): Promise<string> => (await reg[name]!.handler(args, {})).content.map((c) => c.text).join("");
const linkIn = (t: string): string => t.match(/https?:\/\/\S+\/authorize\?\S+/)?.[0] ?? "";
const follow = async (u: string): Promise<string> => (await fetch(u, { redirect: "manual" })).headers.get("location") ?? "";
const key = { file: path.join(home, "mcp.json"), name: "notionish", url: fake.url };

// ① 시작 도구 → 링크 → 인가 서버가 루프백 콜백으로 보냄 → 브리지가 **토큰 없이** 받아 완료
const t1 = await toolText("login_mcp_server", { name: "notionish" });
const cb1 = await follow(linkIn(t1));
const r1 = await fetch(cb1);
const body1 = await r1.text();
const status1 = await oauth.mcpOAuthStatus(key);
// 같은 콜백 다시 — 거절, 응답에 code 를 되비추지 않는다
const r1b = await fetch(cb1);
const body1b = await r1b.text();
const cbHeaders = { cache: r1.headers.get("cache-control"), referrer: r1.headers.get("referrer-policy") };
// 남의 Host — 인증 면제 경로여도 Host 검사가 먼저
// ★fetch 는 Host 를 바꿔 보내지 않는다 — node:http 로 직접 싣는다.
const { request } = await import("node:http");
const evil = await new Promise<{ status: number }>((resolve) => {
  const u = new URL(cb1);
  const req = request({ host: "127.0.0.1", port, path: `${u.pathname}${u.search}`, method: "GET", headers: { Host: "evil.example" } }, (res) => {
    res.resume();
    resolve({ status: res.statusCode ?? 0 });
  });
  req.on("error", () => resolve({ status: 0 }));
  req.end();
});
const listed = await toolText("list_mcp_servers", {});

// ② 붙여넣기(`/mcp_login`) — 다른 기기에서 로그인한 경우
await oauth.forgetMcpOAuth(key.file, "notionish");
const t2 = await toolText("login_mcp_server", { name: "notionish" });
const cb2 = await follow(linkIn(t2));
const bad = await oauth.runMcpLoginCommand("/mcp_login https://example.com/elsewhere?code=x&state=y");
const pasted = await oauth.runMcpLoginCommand(`/mcp_login ${cb2}`);
const status2 = await oauth.mcpOAuthStatus(key);
const pastedAgain = await oauth.runMcpLoginCommand(`/mcp_login ${cb2}`);

// 기대 문구는 같은 번역 함수로 — 러너 언어와 무관하게.
const { translate } = await import("../../core/i18n.js");
const pastedOk = pasted === translate("srv.mcpLogin.done", { name: "notionish" });
const badIsUsage = bad === translate("srv.mcpLogin.usage");
const againRefused = pastedAgain === translate("srv.mcpLogin.failed", { reason: oauth.mcpLoginReasonText("unknown-or-used") });
await bridge.stop();
await fake.close();
const secrets = fake.as.issued.concat([new URL(cb1).searchParams.get("state") ?? "-", new URL(cb2).searchParams.get("state") ?? "-"]).filter((x) => x.length > 8);
const leakedLogs = secrets.filter((sec) => logs.some((l) => l.includes(sec))).length;
const leakedBodies = secrets.filter((sec) => [body1, body1b, pasted, bad, pastedAgain].some((b) => b.includes(sec))).length;
process.stdout.write(`\n${JSON.stringify({
  toolGaveLink: linkIn(t1) !== "", callbackToBridge: cb1.startsWith(`http://127.0.0.1:${port}${oauth.MCP_OAUTH_CALLBACK_PATH}?`),
  r1: r1.status, status1, r1b: r1b.status, cbHeaders, evil: evil.status, listedAuthorized: listed.includes("로그인됨"),
  pastedOk, badIsUsage, againRefused, status2, leakedLogs, leakedBodies,
})}\n`);
process.exit(0);
