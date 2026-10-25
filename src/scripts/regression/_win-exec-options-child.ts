/**
 * Windows 조작 실행부가 **자식에게 실제로 넘기는 옵션**을 본다 — 입력 0, 어느 OS 에서든(2026-10-23).
 * `execFile` 을 가짜로 바꿔(별도 프로세스라 다른 검사와 안 섞인다) 제품 `post`·`selfCheck` 를 부르고, 넘어간 시한·`TIGUCLAW_DRY`·이벤트를 낸다.
 * ★부모 환경에 `TIGUCLAW_DRY=1` 을 일부러 켜 둔다 — 자식은 부모 환경을 물려받으므로, 그게 실제 조작을 빈 연습으로 바꾸면 안 된다.
 */
import { createRequire, syncBuiltinESMExports } from "node:module";

process.env.TIGUCLAW_DRY = "1";
const cp = createRequire(import.meta.url)("node:child_process") as { execFile: unknown };
const seen: Array<{ timeout: unknown; dry: unknown; events: unknown }> = [];
cp.execFile = (_file: string, _args: string[], opts: { timeout?: number; env?: Record<string, string> }, cb: (e: null, so: string, se: string) => void) => {
  seen.push({ timeout: opts.timeout, dry: opts.env?.TIGUCLAW_DRY, events: opts.env?.TIGUCLAW_EVENTS });
  setImmediate(() => cb(null, '{"s":1,"fired":0,"stopped":{"i":0}}\n', ""));
  return {};
};
syncBuiltinESMExports();

// 지정자를 계산한다 — 리터럴이면 `npm run build`(rootDir=src)가 plugins 를 끌어들여 깨진다(`_framework.ts` `loadPluginModule`).
const win = await import(new URL("../../../plugins/computer-use/src/win.ts", import.meta.url).href) as {
  post: (e: unknown[]) => Promise<unknown>;
  selfCheck: () => Promise<unknown>;
};
const postEvents = [{ t: "wait", ms: 5000 }, { t: "keydown", key: "a" }, { t: "keyup", key: "a" }];
await win.post(postEvents);
const postRuns = seen.splice(0);
await win.selfCheck();
const checkRuns = seen.splice(0);
console.log(`WIN_EXEC ${JSON.stringify({ postRuns, checkRuns })}`);
