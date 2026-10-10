/**
 * 자식 프로브 — 브리지를 **이 프로세스 안에** 띄우고 낮은 등급 토큰으로 두드린다. 결과는 JSON 한 줄.
 * (부모 `bridge-role-grades.ts`. 포트를 열고 홈을 바꾸므로 자식에서만 한다.)
 *
 * 요청은 전부 **게이트에서 403 으로 끝나야 하는** 것만 보낸다 — 핸들러에 닿지 않으므로 부작용이 없다.
 * ★`/self-update` 는 보내지 않는다: 게이트가 깨진 날 이 요청이 **진짜로 코드를 갈아끼운다**(부모가 표로만 본다).
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assertIsolated } from "./_framework.js";
import { freePort } from "./_probe-helpers.js";

assertIsolated();
const home = mkdtempSync(path.join(process.env.TIGUCLAW_HOME!, "roles-"));
process.env.TIGUCLAW_HOME = home;
const port = await freePort();
process.env.HTTP_BRIDGE_PORT = String(port);
process.env.HTTP_BRIDGE_TOKEN = "regr-roles-env-admin";

const { initStore } = await import("../../store/sessions.js");
const { issueToken } = await import("../../store/bridge-tokens.js");
const { getPaths } = await import("../../core/paths.js");
initStore();
const read = issueToken("regr-read", "read").token;
const write = issueToken("regr-write", "write").token;

// 커스텀 엔드포인트 — 선언한 role 이 게이트가 되는지(admin) · 미선언은 write 기본인지.
mkdirSync(getPaths().commonEndpoints, { recursive: true });
writeFileSync(path.join(getPaths().commonEndpoints, "regr-admin-ep.md"), "---\npath: /regr-admin-ep\nmethod: POST\nrole: admin\n---\n본문\n");
writeFileSync(path.join(getPaths().commonEndpoints, "regr-default-ep.md"), "---\npath: /regr-default-ep\nmethod: POST\n---\n본문\n");

const { default: HttpBridge } = (await import(new URL("../../../plugins/http-bridge/index.ts", import.meta.url).href)) as {
  default: new () => { startChannel: (h: () => Promise<void>) => Promise<void>; stop: () => Promise<void> };
};
const bridge = new HttpBridge();
await bridge.startChannel(async () => {});

// ★**기대 등급보다 낮은 토큰만** 보낸다 — write 경로에 write 토큰을 보내면 게이트를 통과해 핸들러가 돈다
//  (`/messages` 면 진짜 턴). 그래서 admin 경로엔 read·write, write 경로엔 read 만.
const probes = JSON.parse(process.argv[2] ?? "[]") as Array<{ path: string; method: string; grade: "write" | "admin" }>;
const hit = async (p: { path: string; method: string }, token: string): Promise<{ status: number; required?: string }> => {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${p.path}`, {
      method: p.method,
      headers: { Authorization: `Bearer ${token}`, ...(p.method === "POST" ? { "Content-Type": "application/json" } : {}) },
      ...(p.method === "POST" ? { body: "{}" } : {}),
      signal: AbortSignal.timeout(5000),
    });
    const body = (await res.json().catch(() => ({}))) as { required?: string };
    return { status: res.status, ...(body.required !== undefined ? { required: body.required } : {}) };
  } catch {
    return { status: 0 };
  }
};
const rows: Array<{ path: string; method: string; grade: string; read: unknown; write?: unknown }> = [];
for (const p of probes) {
  rows.push({ ...p, read: await hit(p, read), ...(p.grade === "admin" ? { write: await hit(p, write) } : {}) });
}
// 대조군 — 두 토큰이 **유효**하다(403 이 «토큰 무효» 가 아니라 «등급 부족» 이라는 근거).
const control = { read: await hit({ path: "/channels", method: "GET" }, read), write: await hit({ path: "/channels", method: "GET" }, write) };
await bridge.stop();
process.stdout.write(`\n${JSON.stringify({ rows, control })}\n`);
process.exit(0);
