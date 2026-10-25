/**
 * 자식 프로브 — `limit-resume-has-a-place` 의 저장·조회 사슬. 브리지를 **이 프로세스 안에** 띄우고 진짜 HTTP 로 두드린다.
 * 홈·cwd(프로젝트 레이어)를 바꾸고 포트를 여므로 자식에서만 한다. 결과는 JSON 한 줄.
 *
 * ★프로젝트 레이어 대조(설계 GPT R1): 프로젝트가 덮고 있으면 «쓴 값» 과 «유효값» 이 다르다 — 요청값을 그대로 돌려주는 잘못된 구현은
 *  프로젝트 덮어쓰기가 없을 땐 정상 구현과 똑같이 보인다. 그래서 둘을 반대로 고정한 사례를 둔다.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { assertIsolated } from "./_framework.js";
import { freePort } from "./_probe-helpers.js";

assertIsolated();
const base = process.env.TIGUCLAW_HOME!;
const home = mkdtempSync(path.join(base, "limit-resume-setting-"));
process.env.TIGUCLAW_HOME = home;
const port = await freePort();
process.env.HTTP_BRIDGE_PORT = String(port);
process.env.HTTP_BRIDGE_TOKEN = "regr-limit-resume-admin";

const { initStore } = await import("../../store/sessions.js");
const { issueToken } = await import("../../store/bridge-tokens.js");
const { getPaths } = await import("../../core/paths.js");
initStore();
const readTok = issueToken("regr-lr-read", "read").token;
const writeTok = issueToken("regr-lr-write", "write").token;
const settings = getPaths().settings;

// 프로젝트 레이어가 없는 cwd 에서 시작한다(레포 cwd 엔 `.tiguclaw/settings.json` 이 있을 수 있다).
const plain = mkdtempSync(path.join(base, "lr-plain-"));
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
const get = () => call("GET", "/limit-resume", readTok);
const post = (body: string) => call("POST", "/set-limit-resume", writeTok, body);
const file = (): string | null => (existsSync(settings) ? readFileSync(settings, "utf8") : null);

const out: Record<string, unknown> = {};

// ① 키 없는 기존 홈 — 조회는 «꺼짐» 이고 파일을 건드리지 않는다.
writeFileSync(settings, JSON.stringify({ theme: "regr-keep", models: { default: "keep" } }, null, 2));
const before = file();
out.missingGet = await get();
out.missingUntouched = file() === before;

// ② 잘못된 본문 — 400 · 파일 불변.
out.badBody = await post(JSON.stringify({ enabled: "yes" }));
out.badBodyUntouched = file() === before;

// ③ 켜기 → 다른 설정 보존 · 끄기.
out.on = await post(JSON.stringify({ enabled: true }));
out.afterOnFile = JSON.parse(file() ?? "{}");
out.afterOnGet = await get();
out.off = await post(JSON.stringify({ enabled: false }));
out.afterOffFile = JSON.parse(file() ?? "{}");
out.afterOffGet = await get();

// ④ 같은 블록의 다른 키 보존.
writeFileSync(settings, JSON.stringify({ limitResume: { regrExtra: 7 } }, null, 2));
out.blockKeep = await post(JSON.stringify({ enabled: true }));
out.blockKeepFile = JSON.parse(file() ?? "{}");

// ⑤ 깨진 파일 위에 쓰지 않는다.
writeFileSync(settings, "{ broken json");
out.broken = await post(JSON.stringify({ enabled: true }));
out.brokenUntouched = file() === "{ broken json";

// ⑥ 프로젝트 레이어 대조 — 프로젝트 `.tiguclaw` 가 true 로 덮는다 → 홈에 false 를 써도 유효값은 true.
writeFileSync(settings, JSON.stringify({ theme: "regr-keep" }, null, 2));
const proj = mkdtempSync(path.join(base, "lr-proj-"));
mkdirSync(path.join(proj, ".tiguclaw"), { recursive: true });
const projFile = path.join(proj, ".tiguclaw", "settings.json");
const projText = JSON.stringify({ limitResume: { enabled: true } });
writeFileSync(projFile, projText);
process.chdir(proj);
out.layerPost = await post(JSON.stringify({ enabled: false }));
out.layerGet = await get();
out.layerHomeFile = JSON.parse(file() ?? "{}");
out.layerProjUntouched = readFileSync(projFile, "utf8") === projText;

// ⑦ 레거시 flat `<cwd>/settings.json` 이 `.tiguclaw` 를 덮는다(읽기 순서 홈 → .tiguclaw → 레거시).
const legacyFile = path.join(proj, "settings.json");
writeFileSync(legacyFile, JSON.stringify({ limitResume: { enabled: false } }));
out.legacyGet = await get();
out.legacyPost = await post(JSON.stringify({ enabled: true })); // 홈엔 true 를 쓰지만 레거시가 false 로 덮는다
out.legacyHomeFile = JSON.parse(file() ?? "{}");

process.chdir(plain);
await bridge.stop();
process.stdout.write(`\n${JSON.stringify(out)}\n`);
process.exit(0);
