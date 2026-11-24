/**
 * Windows 조작 실행부가 **자식에게 실제로 넘기는 옵션**을 본다 — 입력 0, 어느 OS 에서든(2026-10-23).
 * `execFile` 을 가짜로 바꿔(별도 프로세스라 다른 검사와 안 섞인다) 제품 `post`·`selfCheck` 를 부르고, 넘어간 시한·`TIGUCLAW_DRY`·이벤트를 낸다.
 * ★부모 환경에 `TIGUCLAW_DRY=1` 을 일부러 켜 둔다 — 자식은 부모 환경을 물려받으므로, 그게 실제 조작을 빈 연습으로 바꾸면 안 된다.
 */
import { createRequire, syncBuiltinESMExports } from "node:module";

process.env.TIGUCLAW_DRY = "1";
const cp = createRequire(import.meta.url)("node:child_process") as { execFile: unknown };
// ★부모 환경에 멈춤 요청 파일 이름도 켜 둔다(2026-11-24, ⑤ Windows) — 자식이 그것을 물려받아 엉뚱한 파일에 멈추면 안 된다.
process.env.TIGUCLAW_STOP_FILE = "부모-환경-값";
const seen: Array<{ timeout: unknown; dry: unknown; events: unknown; stopFile: unknown }> = [];
// 자식에 넘긴 PowerShell 인자 전체 — 실행 정책을 넘기지 않고 상속하는지 본다(2026-11-24).
const argvs: string[][] = [];
// ★정책 거절 모양(종료 1 + CLIXML 의 `PSSecurityException`)을 돌려주는 구간 — 거절 뒤 다른 방식으로 다시 띄우지 않는지 센다.
let refuse = false;
const REFUSAL = '#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><S S="Error">File C:\\x.ps1 cannot be loaded because running scripts is disabled on this system. For more information, see about_Execution_Policies._x000D__x000A_</S><S S="Error">    + CategoryInfo          : SecurityError: (:) [], PSSecurityException_x000D__x000A_</S><S S="Error">    + FullyQualifiedErrorId : UnauthorizedAccess_x000D__x000A_</S></Objs>';
cp.execFile = (_file: string, _args: string[], opts: { timeout?: number; env?: Record<string, string> }, cb: (e: (Error & { code?: number }) | null, so: string, se: string) => void) => {
  argvs.push([..._args]);
  seen.push({ timeout: opts.timeout, dry: opts.env?.TIGUCLAW_DRY, events: opts.env?.TIGUCLAW_EVENTS, stopFile: opts.env?.TIGUCLAW_STOP_FILE });
  if (refuse) setImmediate(() => cb(Object.assign(new Error("Command failed"), { code: 1 }), "", REFUSAL));
  else setImmediate(() => cb(null, '{"s":1,"fired":0,"stopped":{"i":0}}\n', ""));
  return {};
};
syncBuiltinESMExports();

// 지정자를 계산한다 — 리터럴이면 `npm run build`(rootDir=src)가 plugins 를 끌어들여 깨진다(`_framework.ts` `loadPluginModule`).
const win = await import(new URL("../../../plugins/computer-use/src/win.ts", import.meta.url).href) as {
  post: (e: unknown[], signal?: AbortSignal, opts?: { stopFile?: string; dry?: boolean }) => Promise<unknown>;
  selfCheck: () => Promise<unknown>;
  controlInvocation: (events: unknown[], dry: boolean, stopFile?: string) => { args: string[] };
  frontWindow: () => Promise<string | null>;
};
const postEvents = [{ t: "wait", ms: 5000 }, { t: "keydown", key: "a" }, { t: "keyup", key: "a" }];
await win.post(postEvents);
const postRuns = seen.splice(0);
await win.selfCheck();
const checkRuns = seen.splice(0);
// ⑤ Windows: 본 발사(멈춤 파일) · 빈 연습 · 해제 꼴(인자 없음)이 자식에 넘기는 `TIGUCLAW_STOP_FILE`·`TIGUCLAW_DRY`.
await win.post(postEvents, undefined, { stopFile: "S:\\멈춤-요청" });
await win.post(postEvents, undefined, { dry: true });
await win.post([{ t: "keyup", key: "shift" }]);
const stopRuns = seen.splice(0);
await win.frontWindow();
const frontRuns = seen.splice(0);
argvs.push([...win.controlInvocation([], true).args]);
// 정책 거절: 본 발사 한 번 → 자식 호출 수·결과·사유.
const before = argvs.length;
refuse = true;
const refused = await win.post(postEvents);
refuse = false;
const refusal = { calls: argvs.length - before, result: refused };
seen.splice(0);
console.log(`WIN_EXEC ${JSON.stringify({ postRuns, checkRuns, stopRuns, frontRuns, argvs, refusal })}`);
