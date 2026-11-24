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

fsm.existsSync = (p: string): boolean => (cscPresent && String(p).endsWith("csc.exe")) || existing.has(String(p));
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
  CAPTURE_CS: string;
  INDICATOR_CS: string;
};
const tick = async (n = 5): Promise<void> => { for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r)); };
const reset = (): void => {
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

console.log(`WIN_IND ${JSON.stringify(result)}`);
