/**
 * 회귀: **파일 감시의 발화 턴이면 대화 컨텍스트가 그 사실을 말한다 — 사실만** (2026-10-19, 회사 PC RPG 사건 · 아스트라 회신 Q2).
 *
 * 사고: 결정 페이지 감시(`answers.json`)가 작업자 기록·복구로 두 번 돌았고, 두 번 다 «사용자가 다시 제출했다» 로 읽고 사용자가
 * 정정한 결정을 뒤집어 보고했다. 감시 프롬프트가 «마스터가 제출했습니다» 로 단정하고 있었고, 모델은 이 턴이 «파일이 바뀌어서
 * 시작된 실행» 이라는 것도, 등록한 대화의 이력이 여기 없다는 것도 몰랐다. 저장된 지시는 비서가 쓴 글이라 하네스가 고치지 않는다 —
 * 대신 **실행의 원인과 관측 범위**를 따로 싣는다(정기 스케줄의 `triggerRun` 과 같은 자리).
 *
 * 재는 것:
 *  ① 대화 컨텍스트 — 감시 발화면 «파일 감시(#id)의 실행 · 이벤트 · 경로 · 누가 바꿨는지 모른다 · 등록 대화 이력 없음» 을 말한다.
 *     같은 세션의 다른 턴(표식 없음)엔 안 붙는다. ★«지시문은 그 감시의 지시다» 는 **안 붙는다**(헌법 ④ 면제는 정기 스케줄만).
 *  ② 진짜 `registerWatcher` + 진짜 chokidar — 발화가 `triggerRun: {watch, id, event, path}` 를 싣고, 모델 입력 글은 저장된 지시
 *     그대로다(안내를 지시문에 섞지 않는다).
 *  ③ 데몬이 실제로 쓰는 파사드(`defaultRunClaude`)가 그 값을 코어까지 넘긴다 — 필드를 골라 넘기면 여기서 조용히 떨어진다
 *     (스케줄러 파사드가 2026-10-02 에 그렇게 발화 표식을 잃었다).
 * 등급: **동작**(①순수 함수 · ②진짜 fs·chokidar · ③진짜 파사드 소스, 코어 runClaude 만 모의).
 */
import fs from "node:fs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { formatConversationContext } from "../../core/prompt-assembly.js";
import { assert, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
type Captured = { text: string; threadKey: string; triggerRun?: { kind: string; id: number; event?: string; path?: string }; notifyDest?: { channel: string; target: string | null }; interruptDest?: unknown };
type WatcherMod = {
  registerWatcher: (row: Record<string, unknown>, bus: unknown, deps: Record<string, unknown>) => void;
  unregisterWatcher: (id: number) => void;
};
// ★src 밖은 계산된 지정자로 — 리터럴이면 `npm run build`(rootDir=src)가 TS6059 로 죽는다.
const loadWatcher = async (): Promise<WatcherMod> =>
  (await import(new URL("../../../plugins/file-watch/src/watcher.ts", import.meta.url).href)) as WatcherMod;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** ③ 파사드 — `index.ts` 를 모의 import 로 띄워 `registerWatcher` 가 받은 deps 의 `runClaude`(= defaultRunClaude)를 직접 부른다. */
const facadeForwards = async (): Promise<Captured | undefined> => {
  let deps: { runClaude: (i: Record<string, unknown>) => Promise<{ text: string }> } | undefined;
  let core: Captured | undefined;
  const row = { id: 77, label: "regr", path: "/fixture", pattern: null, recursive: false, debounceMs: 0, eventFilter: "add", prompt: "p", destChannel: "cli", destTarget: null, enabled: true, keepRuns: null };
  const requireFixture = (name: string): unknown => {
    if (name.endsWith("/eventbus.js")) return { safeUnsubscribe: (fn: (() => void) | null) => { fn?.(); return null; } };
    if (name.endsWith("/claude.js")) return { runClaude: async (i: Captured) => { core = i; return { text: "" }; } };
    if (name.endsWith("/external-turn.js")) return { runExternalTurn: (_tk: string, _t: unknown, fn: () => Promise<unknown>) => fn() };
    if (name.endsWith("/watches.js")) return { getWatch: () => row, listWatches: () => [row], recordFiring: () => {}, updateWatch: () => {}, recordWatchRun: () => {}, watchRunTimes: () => [] };
    // 이력 정책은 `file-watch-history-policy` 가 진짜 저장소로 잰다 — 여기선 이어감(null)이라 부르지 않는다.
    if (name.endsWith("/thread-reset.js")) return { applyRunHistory: () => null };
    if (name.endsWith("/sessions.js")) return { canonicalSessionChannel: (_tk: string, ch: string) => ch, getSessionChannelMeta: () => null, isConversationLive: () => false, SESSION_STORAGE_CHANNEL: "http-bridge" };
    // 만든 대화에서 처리하는 갈래(2026-10-20)의 import — 이 검사는 전용 세션 갈래만 돈다(그 갈래는 `file-watch-runs-in-origin`).
    if (name.endsWith("/threadkey.js")) return { DEFAULT_SESSION_ID: "dashboard:default" };
    if (name.endsWith("/trigger-in-session.js")) return { runTriggerInSession: async () => { throw new Error("이 검사는 전용 세션 갈래만 돈다"); } };
    if (name.endsWith("/worker-jobs.js")) return { mainMessageHandler: () => undefined };
    if (name.endsWith("/outbound.js")) return { attachmentSenderFor: () => undefined, deliverOutbound: async () => ({ delivered: true }), optionsPresenterFor: () => undefined };
    if (name === "./watcher.js") return { registerWatcher: (_r: unknown, _b: unknown, d: typeof deps) => { deps = d; }, unregisterWatcher: () => {} };
    if (name === "./mcp.js") return { setFileWatchLifecycleHooks: () => {}, createFileWatchMcpServer: () => ({}) };
    throw new Error(`모의하지 않은 import: ${name}`);
  };
  const filename = path.join(repo, "plugins/file-watch/src/index.ts");
  const code = ts.transpileModule(fs.readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const exports: Record<string, unknown> = {};
  vm.runInNewContext(code, { exports, require: requireFixture, AbortController, process: { cwd: () => "/fixture" }, console: { log() {}, warn() {}, error() {} } }, { filename });
  const Plugin = exports.default as new () => { startTrigger: (b: unknown, d?: unknown) => Promise<void>; stop: () => Promise<void> };
  const plugin = new Plugin();
  // ★runClaude 를 주입하지 않는다 — 주입하면 파사드가 통째로 갈려, 파사드가 필드를 떨어뜨려도 초록이 된다.
  await plugin.startTrigger({ subscribe: () => () => {}, publish: () => {} }, { cwd: "/fixture" });
  await deps?.runClaude({
    text: "p", threadKey: "file-watch:77", channel: "file-watch", cwd: "/fixture",
    notifyDest: { channel: "telegram", target: "fixture-chat" },
    triggerRun: { kind: "watch", id: 77, event: "change", path: "/fixture/a.json" },
  });
  await plugin.stop();
  return core;
};

export const check: RegressionCheck = {
  name: "file-watch-run-is-named",
  guards: "파일 감시 실행인데 모델이 «파일이 바뀌어서 시작됐다 · 누가 바꿨는지 모른다 · 등록 대화 이력이 없다» 를 몰라 작업자 기록을 사용자 재제출로 읽던 것(회사 PC 10-19) + 그 표식이 파사드에서 떨어지는 것",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const one = formatConversationContext({ channel: "file-watch", threadKey: "file-watch:1", triggerRun: { kind: "watch", id: 1, event: "change", path: "/w/docs/answers.json" } });
    const many = formatConversationContext({ channel: "file-watch", threadKey: "file-watch:1", triggerRun: { kind: "watch", id: 1, event: "add,change", path: "/w/a.txt\n/w/b.txt" } });
    const sameThread = formatConversationContext({ channel: "file-watch", threadKey: "file-watch:1" });

    // ② 진짜 감시 + 진짜 chokidar.
    const mod = await loadWatcher();
    const dir = mkdtempSync(path.join(tmpdir(), "tiguclaw-regression-watch-named-"));
    const seen: Captured[] = [];
    const id = 990077;
    const stored = "바뀐 파일을 확인해: {path} ({event})";
    try {
      mod.registerWatcher(
        {
          id, label: `regr-${id}`, path: dir, pattern: null, recursive: false, debounceMs: 50, eventFilter: "add",
          prompt: stored, destChannel: "telegram", destTarget: "fixture-chat", enabled: true,
          createdAt: 0, updatedAt: 0, lastFiredAt: null, lastPath: null, lastEvent: null, lastStatus: null, lastError: null,
        },
        { publish: () => {}, subscribe: () => () => {}, history: () => [] },
        { cwd: dir, recordFiring: () => {}, runClaude: async (i: Captured) => { seen.push(i); return { text: "" }; } },
      );
      await sleep(400); // chokidar 준비
      writeFileSync(path.join(dir, "answers.json"), "{}");
      for (let i = 0; i < 80 && seen.length === 0; i++) await sleep(50);
    } finally {
      mod.unregisterWatcher(id);
      rmSync(dir, { recursive: true, force: true });
    }
    const fired = seen[0];
    const file = path.join(dir, "answers.json");
    const core = await facadeForwards();

    return [
      assert("★감시 발화면 «파일 감시(#id)의 실행» · 이벤트 · 경로 · «누가·왜 바꿨는지 알 수 없다» · «등록 대화 이력 없음» 을 말한다",
        one.includes("파일 감시(#1)의 실행") && one.includes("`change`") && one.includes("/w/docs/answers.json") && one.includes("알 수 없다") && one.includes("이력은 여기 없다") && one.includes("앞선 기록은 이 감시의 이전 실행이다"), one),
      assert("여러 경로를 합친 발화는 경로를 줄마다 나눠 싣는다", many.includes("  - /w/a.txt") && many.includes("  - /w/b.txt"), many),
      assert("같은 감시 세션이라도 표식이 없는 턴(매니저 완료·선택지 답)엔 붙지 않는다", !sameThread.includes("파일 감시"), sameThread),
      assert("★헌법 ④ 면제 문구(«지시문은 그 …의 지시다»)는 감시에 붙지 않는다", !one.includes("지시문은"), one),
      assert("★진짜 감시 발화가 triggerRun {watch, id, event, path} 를 싣는다", fired?.triggerRun?.kind === "watch" && fired.triggerRun.id === id && fired.triggerRun.event === "add" && fired.triggerRun.path === file, fired?.triggerRun),
      assert("모델 입력 글은 저장된 지시 그대로다(안내를 지시문에 섞지 않는다 — 치환만)", fired?.text === `바뀐 파일을 확인해: ${file} (add)`, fired?.text),
      // ★2026-10-20 회사돌쇠: 사람 도달 좌표를 파사드가 빼고 넘겨, 감시가 띄운 매니저의 완료 보고가 내부 채널 `file-watch` 로 가 미배달됐다.
      assert("★★진짜 감시 발화가 **감시의 배달 목적지**를 `notifyDest` 로 싣는다(스케줄과 같은 필드) — 매니저 완료 보고·쿨다운 알림이 읽는다",
        JSON.stringify(fired?.notifyDest) === JSON.stringify({ channel: "telegram", target: "fixture-chat" }), fired?.notifyDest),
      assert("★데몬 파사드가 triggerRun 과 **notifyDest 를 코어까지** 넘긴다(옛 이름 interruptDest 는 없다)",
        core?.triggerRun?.kind === "watch" && core.triggerRun.id === 77 && core.threadKey === "file-watch:77" &&
          JSON.stringify(core.notifyDest) === JSON.stringify({ channel: "telegram", target: "fixture-chat" }) && core.interruptDest === undefined, core),
    ];
  },
};
