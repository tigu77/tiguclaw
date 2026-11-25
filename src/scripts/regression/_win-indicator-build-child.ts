/**
 * Windows **표시 도우미 기동·컴파일 경로**를 어느 OS 에서든 본다 — 입력 0 · 디스크 쓰기·삭제·이동 0 (2026-11-24, ⑤ Windows 확대 설계 §5 W4).
 *
 * `child_process.execFile`(csc·캡처 exe)·`spawn`(도우미) 과 `fs`(`existsSync`·`promises.mkdir/writeFile/rename/readdir/rm/stat`)를
 * **가짜로** 바꾸고(별도 프로세스라 다른 검사와 안 섞인다) 제품 `win.startIndicator`·`win.preflight` 를 부른다. 가짜는 호출만 기록한다.
 * ★컴파일러 응답을 붙잡을 수 있어 «컴파일 중 `stop()`» 경합을 순서대로 강제한다(실 csc 로는 결정적이지 않다).
 */
import { EventEmitter } from "node:events";
import { createRequire, syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";

const req = createRequire(import.meta.url);
const cp = req("node:child_process") as Record<string, unknown>;
const fsm = req("node:fs") as Record<string, unknown> & { promises: Record<string, unknown> };

process.env.LOCALAPPDATA = "/가짜-로컬";
process.env.SystemRoot = "C:\\Windows";
let cscPresent = true;
const existing = new Set<string>();
const writes: Array<{ p: string; data: string }> = [];
const renames: Array<[string, string]> = [];
const removals: string[] = [];
let readdirList: string[] = [];
type Compile = { args: string[]; cb: (e: unknown, so: string, se: string) => void };
const compiles: Compile[] = [];
const spawns: Array<{ file: string; args: string[]; opts: { stdio?: unknown; windowsHide?: unknown; env?: Record<string, string> } }> = [];

// ★레포 안 경로는 진짜로 답한다 — 로더(tsx)가 같은 `existsSync` 로 `./x.js`→`x.ts` 를 해석하는 판(Node 22.23·24 의 동기 훅)이
//  있어, 통째로 가짜면 `win.ts` 의 import 가 `observe.js` 를 못 찾는다(공개 CI 2026-11-24 실측). 제품이 보는 경로(csc·임시 exe)는 레포 밖이다.
const realExists = fsm.existsSync as (p: unknown) => boolean;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..") + path.sep;
const pathOf = (p: unknown): string => (p instanceof URL ? fileURLToPath(p) : String(p).startsWith("file:") ? fileURLToPath(String(p)) : String(p));
fsm.existsSync = (p: unknown): boolean => {
  const at = pathOf(p);
  return at.startsWith(repoRoot) ? realExists(at) : (cscPresent && String(p).endsWith("csc.exe")) || existing.has(String(p));
};
fsm.promises.mkdir = async (): Promise<void> => {};
fsm.promises.writeFile = async (p: string, data: string): Promise<void> => { writes.push({ p: String(p), data: String(data) }); };
fsm.promises.rename = async (a: string, b: string): Promise<void> => { renames.push([String(a), String(b)]); existing.add(String(b)); };
fsm.promises.readdir = async (): Promise<string[]> => [...readdirList];
fsm.promises.rm = async (p: string): Promise<void> => { removals.push(String(p)); };
fsm.promises.stat = async (): Promise<{ size: number }> => ({ size: 1 });
cp.execFile = (file: string, args: string[], _opts: unknown, cb: (e: unknown, so: string, se: string) => void): unknown => {
  if (String(file).endsWith("csc.exe")) compiles.push({ args: [...args], cb });
  else setImmediate(() => cb(null, '{"screens":[{"x":0,"y":0,"w":10,"h":10}],"w":1,"h":1,"dpi":"v2"}\n', ""));
  return { kill: () => {}, on: () => {} };
};
cp.spawn = (file: string, args: string[], opts: { stdio?: unknown; windowsHide?: unknown; env?: Record<string, string> }): unknown => {
  spawns.push({ file: String(file), args: [...args], opts });
  const c = new EventEmitter() as EventEmitter & { stdout: PassThrough; kill: () => void };
  c.stdout = new PassThrough();
  c.kill = () => {};
  return c;
};
syncBuiltinESMExports();

const win = (await import(new URL("../../../plugins/computer-use/src/win.ts", import.meta.url).href)) as {
  startIndicator: (o: { label: string; onEsc: () => void; onGone: (w: string) => void }) => { stop(): void };
  preflight: () => Promise<{ ok: boolean; detail?: string }>;
  indicatorSelfCheck: () => Promise<{ ok: boolean; detail?: string }>;
  COMPILE_RETRY_FIRST_MS: number;
  CAPTURE_CS: string;
  INDICATOR_CS: string;
};
const tick = async (n = 5): Promise<void> => { for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r)); };
// 시계 — 장면마다 한 시간씩 민다(앞 장면의 실패 간격이 다음 장면에 남지 않게 · 간격 자체는 (g) 가 본다).
const realNow = Date.now;
const realPerf = performance.now.bind(performance);
let clockMs = 0;
Date.now = (): number => realNow() + clockMs;
void realPerf;
performance.now = (): number => 1_000_000 + clockMs; // 재시도 간격은 단조 시계로 잰다(제품) — 실제 경과를 섞지 않아 경계(1ms 전·정각)를 정확히 본다
const reset = (): void => {
  clockMs += 3_600_000;
  existing.clear(); writes.length = 0; renames.length = 0; removals.length = 0; compiles.length = 0; spawns.length = 0; readdirList = []; cscPresent = true;
};
const outName = (args: string[]): string => path.basename((args.find((a) => a.startsWith("/out:")) ?? "").slice(5));
const result: Record<string, unknown> = {};

// (a) 경합 — 컴파일을 붙잡은 채 start → stop → 컴파일 성공을 놓아도 띄우지 않는다 / 대조군은 띄운다
{
  reset();
  const gone: string[] = [];
  const h = win.startIndicator({ label: "L", onEsc: () => {}, onGone: (w) => gone.push(w) });
  await tick();
  const compiling = compiles.length;
  h.stop();
  compiles[0]?.cb(null, "", "");
  await tick(10);
  result.race = { compiling, spawns: spawns.length, gone };
  reset();
  const gone2: string[] = [];
  win.startIndicator({ label: "표시 문구", onEsc: () => {}, onGone: (w) => gone2.push(w) });
  await tick();
  compiles[0]?.cb(null, "", "");
  await tick(10);
  const s = spawns[0];
  result.control = {
    spawns: spawns.length,
    gone: gone2,
    exe: s === undefined ? "" : path.basename(s.file),
    stdin: Array.isArray(s?.opts.stdio) ? (s.opts.stdio as unknown[])[0] : null,
    windowsHide: s?.opts.windowsHide,
    dry: s?.opts.env?.TIGUCLAW_DRY,
    label: s?.opts.env?.TIGUCLAW_INDICATOR_LABEL,
  };
}

// (c) 두 종류 동시 컴파일 · 같은 종류 겹친 요청 · 종류별 정리
{
  reset();
  readdirList = ["tiguclaw-capture-aaaaaaaaaaaa.exe", "tiguclaw-indicator-bbbbbbbbbbbb.exe", "다른파일.exe"];
  const cap = win.preflight();
  win.startIndicator({ label: "1", onEsc: () => {}, onGone: () => {} });
  win.startIndicator({ label: "2", onEsc: () => {}, onGone: () => {} });
  await tick();
  const pairs = compiles.map((c) => {
    const src = c.args[c.args.length - 1] ?? "";
    return {
      target: c.args.find((a) => a.startsWith("/target:")),
      out: outName(c.args),
      srcIsCapture: writes.find((w) => w.p === src)?.data === win.CAPTURE_CS,
      srcIsIndicator: writes.find((w) => w.p === src)?.data === win.INDICATOR_CS,
    };
  });
  // ★하나씩 끝낸다 — 각 빌드가 끝난 직후의 삭제 요청을 **그 빌드의** 접두사와 대조한다(합집합으로는 접두사가 뒤바뀐 호출을 못 가른다).
  const stale = (): string[] => removals.splice(0).map((p) => path.basename(p)).filter((n) => /^tiguclaw-.*\.exe$/.test(n));
  const order = compiles.map((c) => (c.args.find((a) => a.startsWith("/out:")) ?? "").includes("capture-") ? "capture" : "indicator");
  const removedBy: Record<string, string[]> = {};
  for (let i = 0; i < compiles.length; i += 1) {
    compiles[i]!.cb(null, "", "");
    await tick(10);
    removedBy[order[i]!] = stale();
  }
  await cap;
  await tick(10);
  result.pairs = { compiles: pairs, renamed: renames.map(([a, b]) => [path.basename(a), path.basename(b)]), removedBy, spawns: spawns.length };
}

// (d) 도우미 컴파일 실패 — 사유가 «표시 도우미» 이고 캡처 문구가 아니다(일반 실패 · 백신 모양)
{
  const fail = async (so: string): Promise<string[]> => {
    reset();
    const gone: string[] = [];
    win.startIndicator({ label: "x", onEsc: () => {}, onGone: (w) => gone.push(w) });
    await tick();
    compiles[0]?.cb(Object.assign(new Error("csc 종료 1"), { code: 1 }), so, "");
    await tick(10);
    return gone;
  };
  result.indicatorFail = { plain: await fail("x.cs(1,1): error CS1002: ; expected"), virus: await fail("error CS0016: Could not write to output file — Operation did not complete successfully because the file contains a virus") };
}

// (e) 캡처 제품 사슬 — 컴파일러 없음·백신 모양·일반 컴파일 오류의 실제 detail(종전 판정 그대로)
{
  reset();
  cscPresent = false;
  const p = await win.preflight();
  const capFail = async (so: string): Promise<{ ok: boolean; detail?: string }> => {
    reset();
    const pv = win.preflight();
    await tick();
    compiles[0]?.cb(Object.assign(new Error("csc 종료 1"), { code: 1 }), so, "");
    return pv;
  };
  const v = await capFail("error CS0016: Could not write — the file contains a virus");
  const plain = await capFail("x.cs(1,1): error CS1002: ; expected");
  result.capture = { missing: p, virus: v, plain };
}

// (f) 도우미 — 컴파일러 없음 사유(«표시 도우미» 단계·대상, 캡처 문구 아님)
{
  reset();
  cscPresent = false;
  const gone: string[] = [];
  win.startIndicator({ label: "x", onEsc: () => {}, onGone: (w) => gone.push(w) });
  await tick(10);
  result.indicatorMissing = { gone, spawns: spawns.length };
}

// (g) 반복 실패 — 실패 뒤 간격(1분·2분…최대 30분) 안에는 표시를 다시 띄워도 컴파일 0(**직전** 실패 원문 그대로, 안내가 앞), 간격이 끝나는 순간 다시 ·
//  진단은 간격 무시 · 성공·exe 등장 뒤엔 연속 실패 수가 지워진다(다음 실패의 간격은 다시 1분) · 시스템 시계를 되돌려도 간격이 늘지 않는다
//  ★새 모듈 인스턴스로 — 연속 실패 수는 성공 전까지 이어지므로(제품 의도) 앞 장면의 실패가 남지 않게.
{
  const fresh = async (tag: string): Promise<typeof win> => (await import(new URL(`../../../plugins/computer-use/src/win.ts?${tag}`, import.meta.url).href)) as typeof win;
  const winG = await fresh("backoff");
  reset();
  const gone: string[] = [];
  const start = (w: typeof win = winG): void => { w.startIndicator({ label: "x", onEsc: () => {}, onGone: (x) => gone.push(x) }); };
  let failNo = 0;
  const failLast = (long = false): void => {
    failNo += 1;
    compiles[compiles.length - 1]?.cb(Object.assign(new Error("csc 종료 1"), { code: 1 }), `x.cs(1,1): error CS100${failNo}: 실패-${failNo}${long ? " " + "긴 오류 ".repeat(80) : ""}`, "");
  };
  const n = (): number => compiles.length;
  const steps: Record<string, number> = {};
  start(); await tick(); steps.c1 = n(); failLast(); await tick(10);                                  // 실패 1 → 간격 1분
  clockMs += 59_999; start(); await tick(10); steps.at59 = n();                                       // 1분 1ms 전 — 0
  const realNowBefore = Date.now; Date.now = (): number => realNowBefore() - 3_600_000;             // 시스템 시계를 한 시간 되돌린다
  clockMs += 1; start(); await tick(); steps.at60 = n(); failLast(true); await tick(10);            // 1분 정각 — 다시(실패 2, 긴 오류) → 간격 2분
  Date.now = realNowBefore;
  clockMs += 119_999; start(); await tick(10); steps.at119 = n();                                     // 2분 1ms 전 — 0
  clockMs += 1; start(); await tick(); steps.at120 = n(); failLast(); await tick(10);                // 2분 정각 — 다시(실패 3 → 4분)
  for (const w of [240_000, 480_000, 960_000]) { clockMs += w; start(); await tick(); failLast(); await tick(10); } // 실패 4·5·6 → 8·16·30(상한)분
  steps.before6 = n();
  clockMs += 30 * 60_000 - 1; start(); await tick(10); steps.cap29 = n();                             // 상한 30분 1ms 전 — 0
  clockMs += 1; start(); await tick(); steps.cap30 = n(); failLast(); await tick(10);                // 30분 정각 — 다시(상한이 30분)
  const lastGone = gone[gone.length - 1] ?? "";
  // 진단은 간격 무시 → 성공 → **다른 호출 없이** exe 를 없애고 다시 실패하면 간격은 다시 1분(진단 성공이 연속 실패 수를 지웠다)
  const sc = winG.indicatorSelfCheck(); await tick(); steps.diag = n();
  compiles[compiles.length - 1]?.cb(null, "", ""); await tick(10);
  const scr = await sc;
  existing.clear();
  start(); await tick(); steps.reAfterOk = n(); failLast(); await tick(10);
  clockMs += 60_000; start(); await tick(); steps.oneMinAgain = n(); failLast(); await tick(10);
  // 성공한 뒤 띄움 — 컴파일 성공이면 그대로 띄운다
  clockMs += 120_000; start(); await tick(); steps.okCompile = n(); compiles[compiles.length - 1]?.cb(null, "", ""); await tick(10);
  const spawnsOk = spawns.length;
  steps.afterOk = n();
  result.backoff = { steps, gone, spawnsOk, selfCheck: scr.ok, first: winG.COMPILE_RETRY_FIRST_MS, lastGone };
  // exe 가 간격 중에 생기면(다른 프로세스·사람이 만듦) 바로 쓰고, 그 뒤 다시 실패하면 간격은 1분부터
  const winR = await fresh("recover");
  reset();
  const gone2: string[] = [];
  winR.startIndicator({ label: "y", onEsc: () => {}, onGone: (w) => gone2.push(w) }); await tick(); failLast(); await tick(10);
  const exeName = String(result.control && (result.control as { exe: string }).exe);
  existing.add(path.join("/가짜-로컬", "tiguclaw", exeName));
  clockMs += 10_000;
  winR.startIndicator({ label: "y", onEsc: () => {}, onGone: (w) => gone2.push(w) }); await tick(10);
  const recCompiles = compiles.length, recSpawns = spawns.length;
  existing.clear();
  winR.startIndicator({ label: "y", onEsc: () => {}, onGone: (w) => gone2.push(w) }); await tick(); failLast(); await tick(10);
  clockMs += 61_000; winR.startIndicator({ label: "y", onEsc: () => {}, onGone: (w) => gone2.push(w) }); await tick();
  result.backoffRecover = { compiles: recCompiles, spawns: recSpawns, afterReset: compiles.length, gone: gone2 };
  // 캡처에는 간격이 없다 — 실패 직후(시계 그대로) 다시 부르면 바로 다시 컴파일한다
  reset();
  const pv = winG.preflight(); await tick(); failLast(); await pv;
  const capFirst = compiles.length;
  const pv2 = winG.preflight(); await tick(); const capSecond = compiles.length; compiles[compiles.length - 1]?.cb(null, "", ""); await pv2;
  result.captureNoBackoff = { capFirst, capSecond };
}

console.log(`WIN_IND ${JSON.stringify(result)}`);
