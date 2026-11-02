/**
 * 자식 프로브 — `notify-owner-setting` 의 저장·조회 사슬(2026-11-02, 설계 docs/decisions/2026-11-02-notify-owner-setting.md).
 * 브리지를 **이 프로세스 안에** 띄우고 진짜 HTTP 로 두드린 뒤, 같은 프로세스의 **런타임 관문**(`createNotifyOwnerMcpServer`)이 그 값을 따르는지 본다 —
 * 화면이 쓴 값과 작업자 턴이 읽는 값이 갈리지 않는가(같은 읽기 함수·같은 cwd 기본). 홈·cwd·포트를 바꾸므로 자식에서만 한다. 결과는 JSON 한 줄.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { assertIsolated } from "./_framework.js";
import { freePort } from "./_probe-helpers.js";

assertIsolated();
const base = process.env.TIGUCLAW_HOME!;
const home = mkdtempSync(path.join(base, "notify-owner-setting-"));
process.env.TIGUCLAW_HOME = home;
const port = await freePort();
process.env.HTTP_BRIDGE_PORT = String(port);
process.env.HTTP_BRIDGE_TOKEN = "regr-notify-owner-admin";

const { initStore } = await import("../../store/sessions.js");
const { issueToken } = await import("../../store/bridge-tokens.js");
const { getPaths } = await import("../../core/paths.js");
initStore();
const readTok = issueToken("regr-no-read", "read").token;
const writeTok = issueToken("regr-no-write", "write").token;
const settings = getPaths().settings;
const wj = await import("../../core/worker-jobs.js");
const { createNotifyOwnerMcpServer } = await import("../../core/llm-runtime/capabilities/notify-owner-mcp.js");
const W = wj.registerJob({ label: "설정작업자", task: "t", threadKey: "dashboard:regr-no-setting", channel: "cli", channelUserId: "u", kind: "worker" } as never);
/** 런타임 관문 — 도는 매니저 턴에 도구가 생기나(작업자 턴이 읽는 값). */
const runtimeOn = (): boolean => createNotifyOwnerMcpServer({ threadKey: `worker:${W}` }) !== undefined;

// 프로젝트 레이어가 없는 cwd 에서 시작한다(레포 cwd 엔 `.tiguclaw/settings.json` 이 있을 수 있다).
const plain = mkdtempSync(path.join(base, "no-plain-"));
process.chdir(plain);

const { default: HttpBridge } = (await import(new URL("../../../plugins/http-bridge/index.ts", import.meta.url).href)) as {
  default: new () => { startChannel: (h: () => Promise<void>) => Promise<void>; stop: () => Promise<void> };
};
const bridge = new HttpBridge();
await bridge.startChannel(async () => {});

const call = async (method: "GET" | "POST", p: string, token: string, body?: string): Promise<{ status: number; body: unknown }> => {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(method === "POST" ? { "Content-Type": "application/json" } : {}) },
      ...(method === "POST" ? { body: body ?? "{}" } : {}),
      signal: AbortSignal.timeout(5000),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  } catch (e) {
    return { status: 0, body: String(e) };
  }
};
const get = () => call("GET", "/notify-owner", readTok);
const post = (body: string, token = writeTok) => call("POST", "/set-notify-owner", token, body);
const file = (): string | null => (existsSync(settings) ? readFileSync(settings, "utf8") : null);
/** 이 줄이 바꿔도 되는 유일한 값(`jobs.notifyOwner.enabled`)을 뺀 나머지 — 쓰기 전후가 **바이트 단위로 같아야** 한다(다른 설정·형제 키·다른 블록 불변 — 독립 변이 사냥 B1~B3). */
const othersOf = (text: string | null): string => {
  const j = JSON.parse(text ?? "{}") as Record<string, any>;
  if (j.jobs?.notifyOwner !== undefined) {
    delete j.jobs.notifyOwner.enabled;
    if (Object.keys(j.jobs.notifyOwner).length === 0) delete j.jobs.notifyOwner;
  }
  return JSON.stringify(j);
};

const out: Record<string, unknown> = {};

// ① 키 없는 기존 홈 — 조회는 «꺼짐» · 런타임도 꺼짐 · 파일을 건드리지 않는다. 같은 `jobs` 블록의 진행 알림 설정이 있어도 섞이지 않는다.
writeFileSync(settings, JSON.stringify({ theme: "regr-keep", limitResume: { enabled: false, regrExtra: 9 }, jobs: { progressNotice: { enabled: true, intervalMinutes: 30 } } }, null, 2));
const before = file();
out.missingGet = await get();
out.missingRuntime = runtimeOn();
out.missingUntouched = file() === before;

// ② 잘못된 본문 400 · read 토큰 쓰기 403 — 둘 다 파일 불변.
out.badBody = await post(JSON.stringify({ enabled: "yes" }));
out.readTokenPost = await post(JSON.stringify({ enabled: true }), readTok);
out.rejectUntouched = file() === before;

// ③ 켜기 → `jobs.notifyOwner.enabled` 만 더해짐(진행 알림·다른 설정 보존) · 조회·런타임 켜짐(재시작 없이) · 끄기 → 둘 다 꺼짐.
out.on = await post(JSON.stringify({ enabled: true }));
out.afterOnOthersSame = othersOf(file()) === othersOf(before);
out.afterOnFile = JSON.parse(file() ?? "{}");
out.afterOnGet = await get();
out.afterOnRuntime = runtimeOn();
out.off = await post(JSON.stringify({ enabled: false }));
out.afterOffOthersSame = othersOf(file()) === othersOf(before);
out.afterOffFile = JSON.parse(file() ?? "{}");
out.afterOffGet = await get();
out.afterOffRuntime = runtimeOn();

// ④ 같은 블록의 다른 키 보존 · 불리언이 아닌 값은 꺼짐으로 읽는다(오타로 켜지지 않는다).
writeFileSync(settings, JSON.stringify({ jobs: { notifyOwner: { regrExtra: 7, enabled: "true" } } }, null, 2));
out.nonBoolGet = await get();
out.nonBoolRuntime = runtimeOn();
out.blockKeep = await post(JSON.stringify({ enabled: true }));
out.blockKeepFile = JSON.parse(file() ?? "{}");
out.blockKeepOff = await post(JSON.stringify({ enabled: false }));
out.blockKeepOffFile = JSON.parse(file() ?? "{}");

// ⑤ 깨진 파일 위에 쓰지 않는다.
writeFileSync(settings, "{ broken json");
out.broken = await post(JSON.stringify({ enabled: true }));
out.brokenUntouched = file() === "{ broken json";
// 최상위가 객체가 아닌 파일(배열)도 깨진 것으로 본다 — 덮어쓰지 않는다(재사냥 J).
writeFileSync(settings, "[1,2,3]");
out.arrayRoot = await post(JSON.stringify({ enabled: true }));
out.arrayRootUntouched = file() === "[1,2,3]";

// ⑥ 프로젝트 레이어 대조 — 프로젝트 `.tiguclaw` 가 true 로 덮는다 → 홈에 false 를 써도 유효값·런타임은 true · 프로젝트 파일 불변.
writeFileSync(settings, JSON.stringify({ theme: "regr-keep" }, null, 2));
const proj = mkdtempSync(path.join(base, "no-proj-"));
mkdirSync(path.join(proj, ".tiguclaw"), { recursive: true });
const projFile = path.join(proj, ".tiguclaw", "settings.json");
const projText = JSON.stringify({ jobs: { notifyOwner: { enabled: true } } });
writeFileSync(projFile, projText);
process.chdir(proj);
out.layerPost = await post(JSON.stringify({ enabled: false }));
out.layerGet = await get();
out.layerRuntime = runtimeOn();
out.layerHomeFile = JSON.parse(file() ?? "{}");
out.layerProjUntouched = readFileSync(projFile, "utf8") === projText;

// ⑦ 반대 방향 — 홈이 켜 두고 프로젝트(.tiguclaw)가 **명시적으로 끄면** 꺼짐(뒤 레이어가 이긴다 — «어느 레이어든 true 면 켬» 이 아니다, 재사냥 F).
writeFileSync(settings, JSON.stringify({ jobs: { notifyOwner: { enabled: true } } }, null, 2));
const proj2 = mkdtempSync(path.join(base, "no-proj2-"));
mkdirSync(path.join(proj2, ".tiguclaw"), { recursive: true });
writeFileSync(path.join(proj2, ".tiguclaw", "settings.json"), JSON.stringify({ jobs: { notifyOwner: { enabled: false } } }));
process.chdir(proj2);
out.layerOffGet = await get();
out.layerOffRuntime = runtimeOn();

process.chdir(plain);
await bridge.stop();
process.stdout.write(`\n${JSON.stringify(out)}\n`);
process.exit(0);
