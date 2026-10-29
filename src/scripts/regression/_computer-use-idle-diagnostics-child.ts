/** 유휴 조회의 실제 실행·파싱·로그 배선을 격리한다. 자식 실행은 대역이며 화면과 입력은 쓰지 않는다. */
import { createRequire, syncBuiltinESMExports } from "node:module";
import { assert, assertIsolated, loadPluginModule, type Assertion } from "./_framework.js";

assertIsolated();
const secret = "FAKE_SECRET_user_path_command_stdout_stderr";
type Failure = Error & { code?: number | string | null; killed?: boolean; signal?: string };
interface Sample {
  name: string;
  stdout: string;
  error?: Failure;
  value: number | null;
  reason?: string;
  metadata?: string;
}
const samples: Sample[] = [
  { name: "정상", stdout: '{"s":12.5}', value: 12.5 },
  { name: "마지막 줄", stdout: `${secret}\n{"s":2}\n`, value: 2 },
  { name: "영", stdout: '{"s":0}', value: 0 },
  // 기존 유효성은 유한수다. 여기서 음수 차단 기준을 새로 만들지 않는다.
  { name: "기존 음수 계약", stdout: '{"s":-1}', value: -1 },
  { name: "실행 실패", stdout: secret, error: Object.assign(new Error(secret), { code: 7, killed: false }), value: null, reason: "execution", metadata: "종료코드 7 · 강제종료 false · 시그널 false" },
  { name: "시간초과", stdout: secret, error: Object.assign(new Error(secret), { code: null, killed: true, signal: "SIGKILL" }) as Failure, value: null, reason: "timeout", metadata: "종료코드 모름 · 강제종료 true · 시그널 true" },
  { name: "문자 종료코드와 시그널 비노출", stdout: secret, error: Object.assign(new Error(secret), { code: secret, signal: secret }), value: null, reason: "execution", metadata: "종료코드 모름 · 강제종료 false · 시그널 true" },
  { name: "스크립트 오류와 정상 종료", stdout: JSON.stringify({ error: secret }), value: null, reason: "execution", metadata: "종료코드 0 · 강제종료 false · 시그널 false" },
  { name: "빈 출력", stdout: " \r\n", value: null, reason: "empty-output" },
  { name: "JSON 해석 실패", stdout: secret, value: null, reason: "json-parse" },
  { name: "숫자 누락", stdout: JSON.stringify({ other: secret }), value: null, reason: "invalid-number" },
  { name: "문자 숫자", stdout: JSON.stringify({ s: secret }), value: null, reason: "invalid-number" },
  { name: "무한수", stdout: '{"s":1e999}', value: null, reason: "invalid-number" },
  { name: "null 결과", stdout: "null", value: null, reason: "invalid-number" },
  { name: "원시값", stdout: "false", value: null, reason: "invalid-number" },
];
let sample = samples[0]!;
// 경과 값은 «조회 시작 → 자식 반환» 의 실제 시계 차이여야 한다. 직접 조회 동안만 시계를 대역으로 두고
// 자식이 반환할 때 2,000ms 를 흘린다(모양만 보면 상수 0ms 도 통과했다).
const realNow = performance.now.bind(performance);
let fakeClock: number | null = null;
performance.now = () => fakeClock ?? realNow();
const calls: Array<{ timeout?: number; killSignal?: string; windowsHide?: boolean }> = [];
const cp = createRequire(import.meta.url)("node:child_process") as { execFile: unknown };
cp.execFile = (_file: string, _args: string[], opts: typeof calls[number], cb: (err: Failure | null, stdout: string, stderr: string) => void) => {
  calls.push({ timeout: opts.timeout, killSignal: opts.killSignal, windowsHide: opts.windowsHide });
  const current = sample;
  setImmediate(() => {
    if (fakeClock !== null) fakeClock += 2000;
    cb(current.error ?? null, current.stdout, secret);
  });
  return {};
};
syncBuiltinESMExports();
const ext = import.meta.url.endsWith(".ts") ? "ts" : "js";
const win = await loadPluginModule<{ idleSeconds: (onFailure?: (diagnostic: string) => void) => Promise<number | null> }>(`../../../plugins/computer-use/src/win.${ext}`);
const control = await loadPluginModule<{ newDesktop: () => unknown; beginAction: (d: unknown, owner: string, now: number, idle: number | null) => { ok: boolean; reason?: string } }>(`../../../plugins/computer-use/src/control.${ext}`);
const index = await loadPluginModule<{ createTools: (w: unknown, host?: unknown) => Array<{ name: string; handler: (args: unknown, extra: unknown) => Promise<unknown> }> }>(`../../../plugins/computer-use/src/index.${ext}`);
const out: Assertion[] = [];
for (const s of samples) {
  sample = s;
  const logs: string[] = [];
  calls.length = 0;
  fakeClock = 100;
  const value = await win.idleSeconds((line) => logs.push(line));
  fakeClock = null;
  out.push(assert(`${s.name}: 반환 계약`, value === s.value, { value }));
  out.push(assert(`${s.name}: 8초 실행 한 번, 재시도 없음`, calls.length === 1 && calls[0]?.timeout === 8000 && calls[0]?.killSignal === "SIGKILL" && calls[0]?.windowsHide === true, calls));
  out.push(assert(`${s.name}: 실패만 한 번 기록 · 경과는 조회 시작부터 자식 반환까지`, s.reason === undefined ? logs.length === 0 : logs.length === 1 && logs[0]!.startsWith(`유휴 조회 실패 — ${s.reason} · 경과 2000ms`), logs));
  out.push(assert(`${s.name}: 원문 비노출`, !JSON.stringify(logs).includes(secret), logs));
  if (s.metadata !== undefined) out.push(assert(`${s.name}: 종료 메타데이터`, logs[0]?.includes(s.metadata) === true, logs));
  if (s.value !== null) continue;
  const begin = control.beginAction(control.newDesktop(), "검사", Date.now(), value);
  out.push(assert(`${s.name}: null은 idle-unknown 차단`, !begin.ok && begin.reason === "idle-unknown", begin));
  for (const loggerThrows of [false, true]) {
    calls.length = 0;
    const hostLines: string[] = [];
    let posts = 0;
    const tools = index.createTools({
      platform: "win32", desktop: control.newDesktop(), observe: null,
      control: {
        controlPreflight: async () => ({ ok: true }),
        idleSeconds: win.idleSeconds,
        post: async () => { posts++; throw new Error("실패 조회 뒤 입력에 도달함"); },
        frontWindow: async () => { throw new Error("실패 조회 뒤 창 조회에 도달함"); },
      },
    }, { log: (line: string) => {
      hostLines.push(line);
      if (loggerThrows && line.startsWith("유휴 조회 실패")) throw new Error("합성 로그 장애");
    }, turn: { threadKey: "검사" } });
    const tool = tools.find((t) => t.name === "do")!;
    const result = await tool.handler({ frameId: "가짜프레임", steps: [{ t: "click", x: 1, y: 1 }] }, { signal: new AbortController().signal });
    out.push(assert(`${s.name}: 호스트 배선${loggerThrows ? " 로그 장애" : ""}에도 차단`, posts === 0 && calls.length === 1 && hostLines.filter(l => l.startsWith("유휴 조회 실패")).length === 1 && hostLines.some(l => l.includes("조작 거절 — idle-unknown")), { posts, calls: calls.length, logs: hostLines, result }));
    out.push(assert(`${s.name}: 호스트·응답 비밀 비노출`, !JSON.stringify({ hostLines, result }).includes(secret), "가짜 비밀 포함 여부를 검사함"));
  }
  const withoutLogger = await win.idleSeconds();
  const throwingLogger = await win.idleSeconds(() => { throw new Error("합성 로그 장애"); });
  out.push(assert(`${s.name}: 기존 무인자와 던지는 로거에도 null`, withoutLogger === null && throwingLogger === null, { withoutLogger, throwingLogger }));
}
console.log(`IDLE_DIAGNOSTICS ${JSON.stringify(out)}`);
