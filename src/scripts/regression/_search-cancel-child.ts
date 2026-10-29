/**
 * `search-tool-cancellation` 의 자식 — **가짜 rg** 를 하위 임시 홈의 관리 경로(`<홈>/bin/rg`)에 두고 Glob/Grep 의 취소를 잰다.
 *
 * 별도 프로세스인 이유: rg 해소(`findRipgrep(getPaths().home)`)가 홈을 보므로, 러너와 같은 프로세스에서 가짜를 두면 다른 검사의
 * Grep/Glob 이 가짜를 탄다. 러너가 이미 env 파일 차단·임시 홈·자격 env 정리를 한 env 를 상속한다(`run.ts`) — 격리를 새로 만들지 않는다.
 * 실제 rg·운영 홈·모델 호출 0. POSIX 전용(가짜가 sh 스크립트). 출력: 마지막 줄 JSON.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assertIsolated, within } from "./_framework.js";

assertIsolated();
const home = mkdtempSync(path.join(process.env.TIGUCLAW_HOME!, "search-cancel-"));
process.env.TIGUCLAW_HOME = home;

const fx = path.join(home, "fx");
const bin = path.join(home, "bin");
mkdirSync(fx);
mkdirSync(bin);
const fixtureJs = path.join(fx, "rg.cjs");
const runsLog = path.join(fx, "runs.log");
const modeFile = path.join(fx, "mode");
// 모드: hang(부분 출력 후 대기 — 스스로 20초 뒤 종료) / lines / nomatch(exit 1) / flood(10MB 상한 초과 출력).
writeFileSync(
  fixtureJs,
  `const fs = require("fs"), path = require("path");
const args = process.argv.slice(2);
if (args[0] === "--version") { process.stdout.write("ripgrep 99.0.0 (fake)\\n"); process.exit(0); }
const mode = fs.readFileSync(${JSON.stringify(modeFile)}, "utf8").trim();
fs.appendFileSync(${JSON.stringify(runsLog)}, JSON.stringify({ pid: process.pid, ppid: process.ppid, mode, files: args.includes("--files") }) + "\\n");
const files = args.includes("--files");
if (mode === "hang") { process.stdout.write(files ? "/fake/PARTIAL_MARK.txt\\n" : "/fake/a.txt:1:PARTIAL_MARK\\n"); setTimeout(() => process.exit(0), 20000); }
else if (mode === "lines") { process.stdout.write(files ? ${JSON.stringify(path.join(fx, "one.txt"))} + "\\n" + ${JSON.stringify(path.join(fx, "two.txt"))} + "\\n" : "/fake/a.txt:1:hit\\n/fake/b.txt:2:hit\\n", () => process.exit(0)); }
else if (mode === "nomatch") { process.exit(1); }
else if (mode === "flood") { const line = "/fake/" + "x".repeat(200) + "/" + "y".repeat(200) + ".txt\\n"; process.stdout.write(line.repeat(Math.ceil((11 * 1024 * 1024) / line.length)), () => process.exit(0)); }
else { process.exit(2); }
`,
);
writeFileSync(path.join(fx, "one.txt"), "1");
writeFileSync(path.join(fx, "two.txt"), "2");
const rg = path.join(bin, "rg");
// ★exec 로 셸을 node 로 **교체**한다 — 제품의 직접 자식 pid == fixture 가 기록하는 pid.
writeFileSync(rg, `#!/bin/sh\nexec "${process.execPath}" "${fixtureJs}" "$@"\n`);
chmodSync(rg, 0o755);

// ★«띄웠는가» 는 fixture 기록으로는 못 잰다 — Node 는 이미 취소된 신호로도 일단 띄운 뒤 다음 틱에 죽여, fixture 가 기록하기 전에 끝난다
//  (첫 변이 실행에서 시작 전 검사를 지워도 초록이었다). 그래서 **file-ops 를 import 하기 전에** execFile 을 감싸 rg 실행 호출을 센다.
//  file-ops 는 모듈 로드 때 `promisify(execFile)` 를 잡으므로 promisify 경로(`promisify.custom`)도 같이 감싼다.
let rgLaunches = 0;
let abortOnRgResult: AbortController | undefined;
{
  const { createRequire, syncBuiltinESMExports } = await import("node:module");
  const { promisify } = await import("node:util");
  const cp = createRequire(import.meta.url)("node:child_process") as typeof import("node:child_process");
  type AnyFn = (...a: unknown[]) => unknown;
  const orig = cp.execFile as unknown as AnyFn & { [promisify.custom]: AnyFn };
  const wrapped = function (this: unknown, ...a: unknown[]): unknown {
    if (a[0] === rg) rgLaunches += 1;
    return orig.apply(this, a);
  } as AnyFn & { [promisify.custom]?: AnyFn };
  wrapped[promisify.custom] = (...a: unknown[]): unknown => {
    if (a[0] !== rg) return orig[promisify.custom](...a);
    rgLaunches += 1;
    // rg 가 정상 결과를 낸 **직후, 핸들러가 이어지기 전에** 취소한다 — 성공 반환 직전 판정만 잡을 수 있는 창(결정적).
    const hook = abortOnRgResult;
    abortOnRgResult = undefined;
    const p = orig[promisify.custom](...a) as Promise<unknown>;
    return hook === undefined ? p : p.then((v) => (hook.abort(new Error("after-rg-result")), v));
  };
  (cp as unknown as { execFile: unknown }).execFile = wrapped;
  syncBuiltinESMExports();
}

type Run = { pid: number; ppid: number; mode: string; files: boolean };
const runs = (): Run[] =>
  existsSync(runsLog) ? readFileSync(runsLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Run) : [];
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms: number): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(20);
  }
  return cond();
};
// 검사 자체의 시한 — 제품 시한이 아니다(공용 `within`). 반환이 안 오면 매달리지 않고 «반환 안 됨» 으로 기록한다.
const settle = async <T>(ms: number, p: Promise<T>): Promise<T | "NO_RETURN"> => {
  const r = await within(ms, "search-cancel 도구 호출", p);
  return "value" in r ? r.value : "NO_RETURN";
};
const textOf = (r: unknown): string => {
  const c = Array.isArray(r) ? r : ((r as { content?: unknown[] } | undefined)?.content ?? r);
  return Array.isArray(c) ? c.map((x) => (x as { text?: string }).text ?? "").join("") : String(c);
};

const out: Record<string, unknown> = {};
try {
  const { findRipgrep } = await import("../../core/ripgrep.js");
  const resolved = findRipgrep(home);
  out.resolved = resolved === rg;
  // ★가짜가 안 골라졌으면 도구를 부르지 않는다 — 운영 rg 가 PATH 폴백으로 돌면 안 된다.
  if (resolved !== rg) throw new Error(`가짜 rg 가 선택되지 않음: ${String(resolved)}`);

  const { createFileOpsMcpServer } = await import("../../core/llm-runtime/capabilities/file-ops-mcp.js");
  const { adaptClaudeMcpServer } = await import("../../core/llm-runtime/adapters/_mcp-bridge.js");
  type Handler = (a: unknown, extra: unknown) => Promise<unknown>;
  const handlersOf = (srv: unknown): Record<string, { handler: Handler }> =>
    (srv as { instance: { _registeredTools: Record<string, { handler: Handler }> } }).instance._registeredTools;
  const argsFor = (tool: "Grep" | "Glob"): Record<string, unknown> =>
    tool === "Grep" ? { pattern: "hit", path: fx } : { pattern: "**/*.txt", cwd: fx };

  /**
   * 실행 중 취소 — `via=factory` 는 브리지 왕복(Codex/OpenAI 소비 경로), `via=request` 는 핸들러에 요청 신호만,
   * `via=both` 는 **실제 어댑터처럼 팩토리 신호가 살아 있는 채로** 요청 신호만 취소한다(«팩토리가 있으면 그것만 듣는» 합성을 잡는다).
   */
  const midCancel = async (tool: "Grep" | "Glob", via: "factory" | "request" | "both") => {
    writeFileSync(modeFile, "hang");
    const before = runs().length;
    const fac = new AbortController();
    const req = new AbortController();
    const srv = createFileOpsMcpServer(fx, "regr:search-cancel", via === "request" ? {} : { abortSignal: fac.signal });
    let p: Promise<unknown>;
    if (via === "factory") {
      const bridge = await adaptClaudeMcpServer(srv, "file-ops");
      p = bridge.callTool(tool, argsFor(tool));
    } else {
      p = handlersOf(srv)[tool]!.handler(argsFor(tool), { signal: req.signal });
    }
    const started = await until(() => runs().length > before, 5_000);
    const run = runs()[before];
    const t0 = Date.now();
    (via === "factory" ? fac : req).abort(new Error("stop"));
    const r = await settle(5_000, p);
    const ms = Date.now() - t0;
    const dead = run !== undefined ? await until(() => !alive(run.pid), 3_000) : false;
    return {
      started,
      returned: r !== "NO_RETURN",
      ms,
      text: r === "NO_RETURN" ? "NO_RETURN" : textOf(r).slice(0, 300),
      directChild: run?.ppid === process.pid,
      dead,
      pid: run?.pid,
    };
  };
  out.mid = {
    grepFactory: await midCancel("Grep", "factory"),
    globFactory: await midCancel("Glob", "factory"),
    grepRequest: await midCancel("Grep", "request"),
    globRequest: await midCancel("Glob", "request"),
    grepBoth: await midCancel("Grep", "both"),
    globBoth: await midCancel("Glob", "both"),
  };

  /** 시작 전 취소 — rg 를 띄우지 않는다. */
  const preCancel = async (tool: "Grep" | "Glob", via: "factory" | "request") => {
    writeFileSync(modeFile, "lines");
    const before = runs().length;
    const launchesBefore = rgLaunches;
    const ac = new AbortController();
    ac.abort(new Error("pre"));
    const srv = createFileOpsMcpServer(fx, "regr:search-cancel", via === "factory" ? { abortSignal: ac.signal } : {});
    const r = await settle(5_000, handlersOf(srv)[tool]!.handler(argsFor(tool), via === "request" ? { signal: ac.signal } : {}));
    await sleep(100);
    return { text: r === "NO_RETURN" ? "NO_RETURN" : textOf(r).slice(0, 300), launched: rgLaunches - launchesBefore, ran: runs().length - before };
  };
  // 감시 장치가 실제로 세는지 양성 대조 — 취소 없는 호출은 1로 세여야 한다(안 세면 «0회» 단언이 공허하다).
  {
    writeFileSync(modeFile, "nomatch");
    const b = rgLaunches;
    await handlersOf(createFileOpsMcpServer(fx, "regr:search-cancel", {})).Grep!.handler(argsFor("Grep"), {});
    out.launchCounterWorks = rgLaunches - b === 1;
  }
  out.pre = { grep: await preCancel("Grep", "factory"), glob: await preCancel("Glob", "request") };

  // rg 정상 종료 뒤 결과 조립(mtime stat) 중 취소 — stat 첫 호출에서 신호를 끊는다(시간 경합 없음).
  {
    writeFileSync(modeFile, "lines");
    const before = runs().length;
    const fsp = (await import("node:fs/promises")).default;
    const orig = fsp.stat;
    const ac = new AbortController();
    fsp.stat = (async (...a: Parameters<typeof orig>) => {
      if (!ac.signal.aborted) ac.abort(new Error("during-stat"));
      return orig.apply(fsp, a);
    }) as typeof orig;
    let r: unknown;
    try {
      const srv = createFileOpsMcpServer(fx, "regr:search-cancel", {});
      r = await settle(5_000, handlersOf(srv).Glob!.handler(argsFor("Glob"), { signal: ac.signal }));
    } finally {
      fsp.stat = orig;
    }
    out.globDuringStat = { text: r === "NO_RETURN" ? "NO_RETURN" : textOf(r).slice(0, 300), ran: runs().length - before, aborted: ac.signal.aborted };
  }

  // rg 가 정상 결과를 낸 직후·핸들러가 이어지기 전 취소(Grep) — 성공 반환 직전 판정만 잡는 창.
  {
    writeFileSync(modeFile, "lines");
    const before = runs().length;
    const ac = new AbortController();
    abortOnRgResult = ac;
    const srv = createFileOpsMcpServer(fx, "regr:search-cancel", {});
    const r = await settle(5_000, handlersOf(srv).Grep!.handler(argsFor("Grep"), { signal: ac.signal }));
    abortOnRgResult = undefined;
    out.grepAfterResult = { text: r === "NO_RETURN" ? "NO_RETURN" : textOf(r).slice(0, 300), ran: runs().length - before, aborted: ac.signal.aborted };
  }

  // 보존 — 살아 있는 신호를 쥔 채로 일반 성공·매칭 0·출력 상한(그리고 신호 없는 서버 한 번).
  const plain = async (tool: "Grep" | "Glob", mode: string, withSignal: boolean) => {
    writeFileSync(modeFile, mode);
    const ac = new AbortController();
    const srv = createFileOpsMcpServer(fx, "regr:search-cancel", withSignal ? { abortSignal: ac.signal } : {});
    const bridge = await adaptClaudeMcpServer(srv, "file-ops");
    const r = await settle(20_000, bridge.callTool(tool, argsFor(tool)));
    return r === "NO_RETURN" ? "NO_RETURN" : textOf(r);
  };
  const flood = (t: string): unknown => {
    try {
      const j = JSON.parse(t) as { truncated?: boolean; results?: unknown[] };
      return { truncated: j.truncated, n: j.results?.length };
    } catch {
      return t.slice(0, 200);
    }
  };
  out.keep = {
    grepLines: await plain("Grep", "lines", true),
    globLines: await plain("Glob", "lines", true),
    grepNoSignal: await plain("Grep", "lines", false),
    grepNomatch: await plain("Grep", "nomatch", true),
    globNomatch: await plain("Glob", "nomatch", true),
    grepFlood: flood(await plain("Grep", "flood", true)),
    globFlood: flood(await plain("Glob", "flood", true)),
  };
  out.expect = { one: path.join(fx, "one.txt"), two: path.join(fx, "two.txt") };
} catch (e) {
  out.error = e instanceof Error ? e.message : String(e);
} finally {
  // 검사가 만든 fixture 가 기록한 pid 만 회수한다(변이로 취소가 깨져도 고아를 남기지 않게).
  const leftovers = runs().map((r) => r.pid).filter(alive);
  for (const pid of leftovers) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* 이미 끝났다 */
    }
  }
  out.reaped = leftovers.length;
}
console.log(JSON.stringify(out));
process.exit(0);
