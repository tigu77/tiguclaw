/**
 * 회귀: **파일 감시에도 스케줄과 같은 이력 정책(`keep_runs`)이 먹는다** (2026-10-19, 정태님 «A — 기본 이어감»).
 *
 * 사고(회사 PC RPG, 기제는 추정): 감시는 발화마다 같은 `file-watch:<id>` 세션에서 돌아 **자기 옛 답을 이력으로 이어받는다** —
 * 12:04 실행이 «5발 유지» 라고 답했고, 사용자가 원대화에서 «8발» 로 정정한 뒤인 12:10 실행도 «5발 유지» 를 냈다.
 * 변경마다 독립인 감시는 «매번 새로»(0) 가 맞다. 기본은 이어감(기존 감시 동작 불변) — 정책은 감시마다 고른다.
 *
 * 재는 것:
 *  ① 저장 — `add_watch`/`update_watch` 의 keep_runs 가 행에 남고 목록에 보인다 · 감시를 지우면 발화 기록도 지운다 ·
 *     발화 기록은 감시마다 최근 `KEEP_RUNS_MAX` 개 · 지워진 감시엔 적지 않는다.
 *  ② 데몬 파사드(`defaultRunClaude`, 진짜 소스) — 0 이면 **스레드 줄 안에서**(줄에 서기 전 아님) 이전 맥락을 끊고, null 이면
 *     건드리지 않는다 · 결과가 있으면 발화를 기록하고 빈 결과면 안 한다 · 실행마다 «이력 정책: …» 로그 한 줄.
 *  ③ 정책은 발화 때 새로 읽는다 — 정책을 바꾸면 감시를 다시 등록하지 않아도 다음 실행부터 바뀐다.
 *  ④ **진짜 MCP 도구**(`add_watch`·`update_watch` 핸들러) — keep_runs 가 저장 함수까지 닿는다(①은 저장 함수를 직접 부른다 — 도구에서
 *     인자를 빠뜨려도 ①은 초록이라 따로 잰다, 아스트라 10-19 보완 2) · 값 미지정·없는 id.
 *  ⑤ 경계가 이미 앞에 있어 안 바뀐 실행의 로그가 «발화가 N회 이하» 같은 원인을 **단정하지 않는다**(보완 1).
 *  ⑦ 줄에서 기다리는 사이 지워지거나 꺼진 감시는 **돌리지 않는다**(모델 호출 0) — 실행기는 기록·배달하지 않는다(적대 검토 10-19 P2 —
 *     지운 감시가 모델을 돌리고 배달까지 했다. 스케줄은 10-14 에 같은 판단으로 고쳤다).
 * 판정 자체(경계·앞으로만·요약 지움)는 스케줄과 같은 함수(`applyRunHistory`)라 `schedule-history-policy` 가 잰다.
 * 등급: **동작**(진짜 저장소·진짜 파사드 소스, 코어 runClaude 만 모의).
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { assert, assertIsolated, loadPluginModule, type Assertion, type RegressionCheck } from "./_framework.js";
import * as sessions from "../../store/sessions.js";
import * as watches from "../../store/watches.js";
import * as threadReset from "../../store/thread-reset.js";
import { KEEP_RUNS_MAX } from "../../store/trigger-runs.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
type Facade = (i: Record<string, unknown>) => Promise<{ text: string }>;

/** 진짜 `index.ts` 를 띄워 `registerWatcher` 가 받은 deps 의 runClaude(= defaultRunClaude)를 꺼낸다. 저장소·이력 모듈은 진짜. */
const loadFacade = async (opts: { reply: () => string; logs: string[]; queue: { boundaryAtEntry?: number; tk?: string }; calledAt: number[] }): Promise<{ run: Facade; stop: () => Promise<void> }> => {
  let deps: { runClaude: Facade } | undefined;
  const requireFixture = (name: string): unknown => {
    if (name.endsWith("/eventbus.js")) return { safeUnsubscribe: (fn: (() => void) | null) => { fn?.(); return null; } };
    // 모델이 불린 시각을 적고 조금 걸린다 — 발화 기록이 «시작» 시각인지(끝 시각이 아닌지) 가르려면 그 사이가 벌어져야 한다.
    if (name.endsWith("/claude.js")) return { runClaude: async () => { opts.calledAt.push(Date.now()); await new Promise((r) => setTimeout(r, 15)); return { text: opts.reply() }; } };
    // 줄에 들어선 **순간**의 경계를 적어 둔다 — 정책이 줄 밖에서 먼저 적용됐으면 여기서 이미 바뀌어 있다.
    if (name.endsWith("/external-turn.js")) return {
      runExternalTurn: (tk: string, _t: unknown, fn: () => Promise<unknown>) => {
        opts.queue.tk = tk;
        opts.queue.boundaryAtEntry = sessions.getContextBoundary("file-watch", tk);
        return fn();
      },
    };
    if (name.endsWith("/store/watches.js")) return watches;
    if (name.endsWith("/store/thread-reset.js")) return threadReset;
    if (name.endsWith("/store/sessions.js")) return sessions;
    if (name === "./watcher.js") return { registerWatcher: (_r: unknown, _b: unknown, d: typeof deps) => { deps = d; }, unregisterWatcher: () => {} };
    if (name === "./mcp.js") return { setFileWatchLifecycleHooks: () => {}, createFileWatchMcpServer: () => ({}) };
    throw new Error(`모의하지 않은 import: ${name}`);
  };
  const filename = path.join(repo, "plugins/file-watch/src/index.ts");
  const code = ts.transpileModule(fs.readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const exports: Record<string, unknown> = {};
  const log = (...a: unknown[]): void => { opts.logs.push(a.map(String).join(" ")); };
  vm.runInNewContext(code, { exports, require: requireFixture, AbortController, Date, process: { cwd: () => "/fixture" }, console: { log, warn: log, error: log } }, { filename });
  const Plugin = exports.default as new () => { startTrigger: (b: unknown, d?: unknown) => Promise<void>; stop: () => Promise<void> };
  const plugin = new Plugin();
  // ★runClaude 를 주입하지 않는다 — 데몬이 실제로 쓰는 파사드를 지나야 정책·기록 배선을 잰다.
  await plugin.startTrigger({ subscribe: () => () => {}, publish: () => {} }, { cwd: "/fixture" });
  if (deps === undefined) throw new Error("파사드를 못 꺼냈다(등록된 감시 없음)");
  return { run: deps.runClaude, stop: () => plugin.stop() };
};

export const check: RegressionCheck = {
  name: "file-watch-history-policy",
  guards: "감시가 발화마다 자기 옛 답을 이력으로 이어받아 사용자 정정 뒤에도 같은 판단을 내던 것(회사 PC 10-19) — 스케줄 keep_runs 와 같은 정책이 감시엔 없었다",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    sessions.initStore();
    // ① 저장
    const fresh = watches.addWatch({ label: "regr-fresh", path: "/fixture", prompt: "요청 파일 처리: {path}", destChannel: "cli", keepRuns: 0 });
    const cont = watches.addWatch({ label: "regr-continue", path: "/fixture", prompt: "변경 요약: {path}", destChannel: "cli" });
    const listed = watches.listWatches().filter((w) => w.id === fresh.id || w.id === cont.id).map((w) => w.keepRuns);
    for (let i = 0; i < KEEP_RUNS_MAX + 5; i++) watches.recordWatchRun(cont.id, 1_000 + i);
    const bounded = watches.watchRunTimes(cont.id, 1_000).length;
    const gone = watches.addWatch({ label: "regr-gone", path: "/fixture", prompt: "x", destChannel: "cli" });
    watches.recordWatchRun(gone.id, 5);
    watches.deleteWatch(gone.id);
    watches.recordWatchRun(gone.id, 6); // 지워진 뒤 — 적지 않는다
    const goneRuns = watches.watchRunTimes(gone.id, 10).length;

    // ② 파사드 — 매번 새로(0)
    const logs: string[] = [];
    const queue: { boundaryAtEntry?: number; tk?: string } = {};
    let reply = "처리함";
    const calledAt: number[] = [];
    const { run, stop } = await loadFacade({ reply: () => reply, logs, queue, calledAt });
    const tkF = `file-watch:${fresh.id}`;
    const turn = (id: number, tk: string) => ({ text: "t", threadKey: tk, channel: "file-watch", cwd: "/fixture", interruptDest: { channel: "cli", target: null }, triggerRun: { kind: "watch", id, event: "add", path: "/fixture/a.json" } });
    const beforeF = sessions.getContextBoundary("file-watch", tkF);
    await run(turn(fresh.id, tkF));
    const entryF = queue.boundaryAtEntry;
    const afterF = sessions.getContextBoundary("file-watch", tkF);
    const runsF = watches.watchRunTimes(fresh.id, 10).length;
    reply = "";
    await run(turn(fresh.id, tkF));
    const runsAfterEmpty = watches.watchRunTimes(fresh.id, 10).length;
    // ② 이어감(null)
    reply = "요약함";
    const tkC = `file-watch:${cont.id}`;
    const beforeC = sessions.getContextBoundary("file-watch", tkC);
    await run(turn(cont.id, tkC));
    const afterC = sessions.getContextBoundary("file-watch", tkC);
    let policyLogsBefore: string[] = [];
    // ③ 정책을 바꾸면 다시 등록하지 않아도 다음 실행부터
    watches.updateWatch(cont.id, { keepRuns: 0 });
    await run(turn(cont.id, tkC));
    policyLogsBefore = logs.filter((l) => l.includes("이력 정책:"));
    const afterUpdate = sessions.getContextBoundary("file-watch", tkC);
    // ⑤ «매번 새로» 로 끊은 뒤 «직전 2회» 로 바꾸면 계산 경계(옛 발화 시각)가 기존 경계보다 앞 — 경계는 그대로, 로그는 원인을 단정하지 않는다.
    watches.recordWatchRun(cont.id, 10); watches.recordWatchRun(cont.id, 20);
    watches.updateWatch(cont.id, { keepRuns: 2 });
    const beforeKeep = sessions.getContextBoundary("file-watch", tkC);
    logs.length = 0;
    await run(turn(cont.id, tkC));
    const keepLog = logs.find((l) => l.includes("이력 정책:")) ?? "";
    const afterKeep = sessions.getContextBoundary("file-watch", tkC);
    // ⑥ «직전 2회» 가 **발화 기록으로 실제로 자른다**(적대 검토 A1·A2) — 새 감시로 세 번: 셋째 실행이 첫 실행의 시작 직전에서 끊어야 한다.
    const n2 = watches.addWatch({ label: "regr-keep2", path: "/fixture", prompt: "{path} 를 보고 비교해", destChannel: "cli", keepRuns: 2 });
    const tkN = `file-watch:${n2.id}`;
    reply = "비교함";
    logs.length = 0;
    const calls0 = calledAt.length;
    for (let i = 0; i < 3; i++) await run(turn(n2.id, tkN));
    const n2Starts = watches.watchRunTimes(n2.id, 10).slice().reverse(); // 오래된 순
    const n2Called = calledAt.slice(calls0);
    const n2Boundary = sessions.getContextBoundary("file-watch", tkN);
    const n2Logs = logs.filter((l) => l.includes("이력 정책:"));
    // ⑦ 줄에서 기다리는 사이 지워짐·꺼짐.
    const gone2 = watches.addWatch({ label: "regr-gone2", path: "/fixture", prompt: "p", destChannel: "cli" });
    const off = watches.addWatch({ label: "regr-off", path: "/fixture", prompt: "p", destChannel: "cli" });
    watches.deleteWatch(gone2.id);
    watches.updateWatch(off.id, { enabled: false });
    const callsBeforeSkip = calledAt.length;
    const skipGone = await run(turn(gone2.id, `file-watch:${gone2.id}`)) as { text: string; skipped?: string };
    const skipOff = await run(turn(off.id, `file-watch:${off.id}`)) as { text: string; skipped?: string };
    const callsAfterSkip = calledAt.length;
    await stop();
    // ⑦ 실행기 — 건너뛴 결과는 기록·배달하지 않는다(진짜 감시 + 진짜 chokidar).
    const wmod = await loadPluginModule<{ registerWatcher: (r: Record<string, unknown>, b: unknown, d: Record<string, unknown>) => void; unregisterWatcher: (id: number) => void }>("../../../plugins/file-watch/src/watcher.ts");
    const wdir = mkdtempSync(path.join(tmpdir(), "tiguclaw-regression-watch-skip-"));
    const firings: unknown[] = []; const sent: unknown[] = []; let ran = 0;
    try {
      wmod.registerWatcher(
        { id: 990088, label: "regr-skip", path: wdir, pattern: null, recursive: false, debounceMs: 50, eventFilter: "add", prompt: "p", destChannel: "cli", destTarget: null, enabled: true,
          createdAt: 0, updatedAt: 0, lastFiredAt: null, lastPath: null, lastEvent: null, lastStatus: null, lastError: null, keepRuns: null },
        { publish: () => {}, subscribe: () => () => {}, history: () => [] },
        { cwd: wdir, recordFiring: (_id: number, r: unknown) => firings.push(r), dispatch: async (i: unknown) => { sent.push(i); },
          runClaude: async () => { ran += 1; return { text: "지운 감시의 결과", skipped: "deleted" }; } },
      );
      await new Promise((r) => setTimeout(r, 400));
      fs.writeFileSync(path.join(wdir, "a.txt"), "x");
      for (let i = 0; i < 60 && ran === 0; i++) await new Promise((r) => setTimeout(r, 50));
      await new Promise((r) => setTimeout(r, 150));
    } finally {
      wmod.unregisterWatcher(990088);
      rmSync(wdir, { recursive: true, force: true });
    }
    const policyLogs = policyLogsBefore;

    // ④ 진짜 MCP 도구 핸들러.
    type Reg = Record<string, { handler: (a: unknown, x?: unknown) => Promise<{ content: Array<{ text: string }> }> }>;
    const mcp = await loadPluginModule<{ createFileWatchMcpServer: () => { instance: unknown } }>("../../../plugins/file-watch/src/mcp.ts");
    const reg = (mcp.createFileWatchMcpServer().instance as { _registeredTools: Reg })._registeredTools;
    const call = async (name: string, args: unknown): Promise<Record<string, unknown>> => JSON.parse((await reg[name]!.handler(args, {})).content.map((c) => c.text).join("")) as Record<string, unknown>;
    const dir = mkdtempSync(path.join(tmpdir(), "tiguclaw-regression-watch-tool-"));
    let tool: Record<string, unknown> = {};
    try {
      const added = await call("add_watch", { label: "regr-tool", path: dir, prompt: "p", dest_channel: "cli", keep_runs: 0 });
      const id = added.id as number;
      const storedAdd = watches.getWatch(id)?.keepRuns;
      const listedTool = ((await call("list_watches", {})).items as Array<{ id: number; keep_runs: unknown }>).find((w) => w.id === id)?.keep_runs;
      const upN = await call("update_watch", { id, keep_runs: 3 });
      const storedN = watches.getWatch(id)?.keepRuns;
      const upNull = await call("update_watch", { id, keep_runs: null });
      const storedNull = watches.getWatch(id)?.keepRuns;
      const nothing = await call("update_watch", { id });
      const missing = await call("update_watch", { id: 999_999, keep_runs: 0 });
      const addedPlain = await call("add_watch", { label: "regr-tool-plain", path: dir, prompt: "p", dest_channel: "cli" });
      tool = { storedAdd, listedTool, upN, storedN, upNull, storedNull, nothing: nothing.error, missing: missing.error, plain: watches.getWatch(addedPlain.id as number)?.keepRuns };
      await call("delete_watch", { id }); await call("delete_watch", { id: addedPlain.id });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    return [
      assert("keep_runs 가 행에 남는다(0 · 생략=null) — 목록에도", listed[0] === 0 && listed[1] === null, listed),
      assert("발화 기록은 감시마다 최근 KEEP_RUNS_MAX 개", bounded === KEEP_RUNS_MAX, { bounded, KEEP_RUNS_MAX }),
      assert("감시를 지우면 발화 기록도 지우고, 지워진 감시엔 적지 않는다", goneRuns === 0, { goneRuns }),
      assert("★매번 새로(0) — 이전 맥락을 끊는다 · **줄에 들어선 뒤에**(줄 밖에서 먼저 끊지 않는다)",
        afterF > beforeF && entryF === beforeF, { beforeF, entryF, afterF }),
      assert("결과가 있으면 발화를 기록하고, 빈 결과면 기록하지 않는다", runsF === 1 && runsAfterEmpty === 1, { runsF, runsAfterEmpty }),
      assert("★이어감(null, 기본) — 맥락을 건드리지 않는다(기존 감시 동작 불변)", afterC === beforeC, { beforeC, afterC }),
      assert("★정책을 바꾸면 감시를 다시 등록하지 않아도 다음 실행부터 적용된다(발화 때 새로 읽는다)", afterUpdate > afterC, { afterC, afterUpdate }),
      assert("실행마다 «이력 정책: …» 로그 한 줄 — 매번 새로·이어감이 글로 갈린다",
        policyLogs.length === 4 && policyLogs[0]!.includes("매번 새로") && policyLogs[2]!.includes("이어감"), policyLogs),
      assert("★진짜 도구: add_watch keep_runs:0 저장·목록 표시 · update_watch N·null 저장과 반환 · 값 미지정·없는 id 는 거절 · 생략하면 null",
        tool.storedAdd === 0 && tool.listedTool === 0 && (tool.upN as { keep_runs?: unknown })?.keep_runs === 3 && tool.storedN === 3 &&
          (tool.upNull as { keep_runs?: unknown })?.keep_runs === null && tool.storedNull === null &&
          tool.nothing === "nothing_to_update" && tool.missing === "not_found" && tool.plain === null, tool),
      assert("★«직전 N회» 가 발화 기록으로 실제로 자른다 — 셋째 실행이 첫 실행 시작 직전에서 끊고 로그 출처는 «발화 기록» · 기록 시각은 모델 호출 **전**(시작)",
        n2Starts.length === 3 && n2Boundary === n2Starts[0]! - 1 && (n2Logs[2] ?? "").includes("출처: 발화 기록") &&
          n2Starts.every((t, i) => t <= n2Called[i]!),
        { n2Starts, n2Called, n2Boundary, log3: n2Logs[2] }),
      assert("★줄에서 기다리는 사이 지워진·꺼진 감시는 모델을 부르지 않고 건너뛴다(deleted · disabled)",
        skipGone.skipped === "deleted" && skipOff.skipped === "disabled" && callsAfterSkip === callsBeforeSkip, { skipGone, skipOff, calls: callsAfterSkip - callsBeforeSkip }),
      assert("★건너뛴 실행은 기록·배달하지 않는다(«ok» 로 남지 않는다)", ran === 1 && firings.length === 0 && sent.length === 0, { ran, firings, sent: sent.length }),
      assert("★경계가 이미 앞이라 안 바뀐 실행 — 경계는 그대로 · 로그는 원인을 단정하지 않는다(«N회 이하» 금지)",
        afterKeep === beforeKeep && keepLog.includes("변경 없음") && !keepLog.includes("이하"), { beforeKeep, afterKeep, keepLog }),
    ];
  },
};
