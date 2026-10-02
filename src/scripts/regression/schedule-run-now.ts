/**
 * 회귀: **스케줄을 지금 한 번 실행한다 — 정해진 시각과 같은 길로** (2026-10-02).
 *
 * 정태님: *"스케쥴을 즉시 실행은 안되나?"* — 고친 스케줄 동작을 다음 정해진 시각(내일 아침)까지 기다려야만 볼 수 있었다.
 * `run_schedule` 은 별도 실행 경로를 만들지 않고 cron 과 같은 runScheduleFiring 을 탄다. 여기선 **실제 플러그인**을 격리
 * 실행해 MCP 로 넘기는 훅을 가로채 부른다(DB·LLM·전송만 모의 — trigger-interrupt-destination 과 같은 틀).
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { fileURLToPath } from "node:url";
import * as inflight from "../../core/inflight-turns.js";
import { assert, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

type Hooks = { onScheduleRunNow?: (row: unknown) => string };

export const check: RegressionCheck = {
  name: "schedule-run-now",
  guards: "스케줄을 고친 뒤 다음 정해진 시각까지 기다려야만 확인할 수 있던 것 — 지금 실행이 cron 과 같은 길(겹침 방지·목적지)을 타는가",
  async run(): Promise<Assertion[]> {
    assertIsolated();
    const id = 990001;
    const row = { id, label: "회귀-지금실행", enabled: true, triggerType: "cron", cronExpr: "10 8 * * *", timezone: "Asia/Seoul", prompt: "회귀-지금실행 지시", destChannel: "telegram", destTarget: "fixture-dest" };
    let hooks: Hooks = {};
    const inputs: Array<{ text?: string; threadKey?: string; channel?: string; scheduleRun?: number }> = [];
    let finish: (() => void) | undefined;
    const records: unknown[] = [];
    const cache = new Map<string, unknown>();
    const bus = { subscribe: () => () => {}, publish: () => {} };
    const model = (input: { text?: string; threadKey?: string; channel?: string; scheduleRun?: number; abortSignal: AbortSignal }) => {
      inputs.push(input);
      return new Promise((resolve) => { finish = () => resolve({ text: "회귀 결과" }); });
    };
    const store = { listSchedules: () => [], getSchedule: () => row, updateSchedule: () => {}, recordFiring: (_id: number, v: unknown) => records.push(v) };
    const load = (filename: string): Record<string, unknown> => {
      if (cache.has(filename)) return cache.get(filename) as Record<string, unknown>;
      const exports = {};
      cache.set(filename, exports);
      const requireFixture = (name: string): unknown => {
        if (name === "node:path") return path;
        if (name === "croner") return { Cron: class { stop() {} } };
        if (name.endsWith("/eventbus.js")) return { safeUnsubscribe: (fn: (() => void) | undefined) => fn?.() };
        if (name.endsWith("/schedules.js")) return store;
        if (name.endsWith("/claude.js")) return { runClaude: model };
        if (name.endsWith("/inflight-turns.js")) return inflight;
        if (name.endsWith("/settings.js")) return { loadSchedulerRetryEnabled: () => false };
        if (name.endsWith("/threadkey.js")) return { DEFAULT_SESSION_ID: "dashboard:default" };
        if (name.endsWith("/store/sessions.js")) return { canonicalSessionChannel: (_tk: string, ch: string) => ch };
        if (name.endsWith("/thread-reset.js")) return { applyScheduleHistory: () => null };
        if (name.endsWith("/core/outbound.js")) return { optionsPresenterFor: () => undefined, attachmentSenderFor: () => undefined };
        if (name === "./dispatcher.js") return { dispatch: async () => {} };
        // ★MCP 가 받는 훅을 가로챈다 — run_schedule 핸들러가 부르는 바로 그것.
        if (name === "./mcp.js") return { setSchedulerLifecycleHooks: (h: Hooks) => { hooks = h; }, createSchedulerMcpServer: () => ({}) };
        if (name === "./runner.js") return load(path.resolve(path.dirname(filename), "runner.ts"));
        throw new Error(`모의하지 않은 import: ${name}`);
      };
      const code = ts.transpileModule(fs.readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
      vm.runInNewContext(code, { exports, require: requireFixture, AbortController, process: { cwd: () => "/fixture" }, console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout }, { filename });
      return exports;
    };
    const Plugin = load(path.join(repo, "plugins/scheduler/src/index.ts")).default as new () => { startTrigger: (b: unknown, d?: unknown) => Promise<void>; stop: () => Promise<void> };
    const plugin = new Plugin();
    const out: Assertion[] = [];
    try {
      const before = hooks.onScheduleRunNow === undefined ? "(훅 없음)" : hooks.onScheduleRunNow(row);
      // ★runClaude 를 주입하지 않는다 — 데몬이 실제로 쓰는 파사드(defaultRunClaude)를 지나 코어 runClaude(모의)에 닿는 값을 잰다.
      //  주입하면 파사드가 통째로 갈려, 파사드가 필드를 떨어뜨려도 초록이었다(재검토 2026-10-02 — scheduleRun 이 그렇게 빠졌다).
      await plugin.startTrigger(bus, { recordFiring: (_id: number, v: unknown) => records.push(v), cwd: "/fixture" });
      const first = hooks.onScheduleRunNow?.(row);
      await new Promise<void>((r) => setImmediate(r));
      const ran = inputs[0];
      const second = hooks.onScheduleRunNow?.(row);
      const runsAfterSecond = inputs.length;
      finish?.();
      await new Promise<void>((r) => setTimeout(r, 20));
      const third = hooks.onScheduleRunNow?.(row);
      await new Promise<void>((r) => setImmediate(r));
      finish?.();
      await new Promise<void>((r) => setTimeout(r, 20));
      out.push(
        assert("실행기가 뜨기 전엔 훅이 없다(«지금 실행» 이 거짓 성공하지 않는다)", before === "(훅 없음)", before),
        assert("★지금 실행이 그 스케줄 지시문으로 scheduler:<id> 실행을 연다(cron 과 같은 길)", first === "started" && ran?.text === row.prompt && ran?.threadKey === `scheduler:${id}` && ran?.channel === "scheduler", { first, ran: ran && { text: ran.text, threadKey: ran.threadKey, channel: ran.channel } }),
        // ★발화 턴임을 입력에 싣는다 — 대화 컨텍스트의 «정기 스케줄 실행» 표식이 이 값으로만 붙는다(같은 세션의 완료 턴과 가른다).
        assert("★발화 턴은 scheduleRun=<id> 를 싣는다", ran?.scheduleRun === id, { scheduleRun: ran?.scheduleRun }),
        assert("★실행 중에 다시 부르면 겹쳐 돌리지 않는다(busy)", second === "busy" && runsAfterSecond === 1, { second, runs: runsAfterSecond }),
        assert("끝난 뒤엔 다시 실행할 수 있고, 실행마다 발화 기록이 남는다", third === "started" && inputs.length === 2 && records.length === 2, { third, runs: inputs.length, records: records.length }),
      );
    } finally {
      finish?.();
      await plugin.stop();
    }
    return out;
  },
};
