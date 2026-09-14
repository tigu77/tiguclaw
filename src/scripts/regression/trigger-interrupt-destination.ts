/** 실제 플러그인 시작→발화→기본 실행→중단 통지 경로. 시계/파일감시/DB/LLM/전송만 모의한다. */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { fileURLToPath } from "node:url";
import * as inflight from "../../core/inflight-turns.js";
import { assert, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export const check: RegressionCheck = {
  name: "trigger-interrupt-destination",
  guards: "스케줄·파일감시의 재시작 중단 통지가 내부 트리거 채널로 보내져 실제 목적지에 도달하지 않던 것",
  async run(): Promise<Assertion[]> {
    assertIsolated();
    const out: Assertion[] = [];
    let id = 980000;
    for (const kind of ["scheduler", "file-watch"]) {
      for (const mode of ["interrupt", "interrupt-null", "undelivered", "complete", "error"]) {
        const key = `${kind}:${++id}`;
        const dest = { channel: mode === "interrupt-null" ? "http-bridge" : "telegram", target: mode === "interrupt-null" ? null : `fixture-${id}` };
        const row = { id, label: "fixture", enabled: true, triggerType: "cron", cronExpr: "* * * * *", timezone: "UTC", prompt: "fixture {path}", path: "/fixture", recursive: false, debounceMs: 1, eventFilter: "all", pattern: null, destChannel: dest.channel, destTarget: dest.target };
        const cache = new Map<string, any>();
        let fire: (() => void) | undefined;
        let modelInput: any;
        let finish: (() => void) | undefined;
        const records: any[] = [];
        const dispatches: any[] = [];
        const events: any[] = [];
        const bus = { subscribe: () => () => {}, publish: (e: any) => events.push(e) };
        const model = (input: any) => {
          modelInput = input;
          return new Promise((resolve, reject) => {
            finish = () => mode === "error" ? reject(new Error("fixture failure")) : resolve({ text: "fixture result" });
            input.abortSignal.addEventListener("abort", () => reject(new Error("fixture abort")), { once: true });
          });
        };
        const store = { listSchedules: () => [row], listWatches: () => [row], getSchedule: () => row, getWatch: () => row, updateSchedule: () => {}, updateWatch: () => {}, recordFiring: (_id: number, value: any) => records.push(value) };
        const load = (filename: string): any => {
          if (cache.has(filename)) return cache.get(filename);
          const exports = {};
          cache.set(filename, exports);
          const requireFixture = (name: string): any => {
            if (name === "node:path") return path;
            if (name === "croner") return { Cron: class { constructor(_expr: unknown, _opts: unknown, cb: () => void) { fire = cb; } stop() {} } };
            if (name === "chokidar") return { watch: () => {
              const watcher = { on: (event: string, cb: (...args: string[]) => void) => { if (event === "all") fire = () => cb("change", "/fixture/file.txt"); return watcher; }, close: async () => {} };
              return watcher;
            } };
            if (name.endsWith("/eventbus.js")) return { safeUnsubscribe: (fn: any) => fn?.() };
            if (name.endsWith("/schedules.js") || name.endsWith("/watches.js")) return store;
            if (name.endsWith("/claude.js")) return { runClaude: model };
            if (name.endsWith("/inflight-turns.js")) return inflight;
            if (name.endsWith("/settings.js")) return { loadSchedulerRetryEnabled: () => false };
            if (name.endsWith("/threadkey.js")) return { DEFAULT_SESSION_ID: "dashboard:default" };
            if (name === "./dispatcher.js") return { dispatch: async (value: any) => { dispatches.push(value); } };
            if (name === "./mcp.js") return { setSchedulerLifecycleHooks: () => {}, setFileWatchLifecycleHooks: () => {} };
            if (name === "./runner.js" || name === "./watcher.js") return load(path.resolve(path.dirname(filename), name.replace(/\.js$/, ".ts")));
            throw new Error(`모의하지 않은 import: ${name}`);
          };
          const code = ts.transpileModule(fs.readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
          vm.runInNewContext(code, { exports, require: requireFixture, AbortController, process: { cwd: () => "/fixture" }, console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout }, { filename });
          return exports;
        };
        const Plugin = load(path.join(repo, "plugins", kind, "src/index.ts")).default;
        const plugin = new Plugin();
        try {
          // runClaude 주입을 하지 않아 실제 플러그인의 기본 실행 배선을 거친다.
          await plugin.startTrigger(bus, { cwd: "/fixture" });
          if (!fire) throw new Error(`${kind} 발화 콜백 미등록`);
          fire();
          const entry = inflight.listExternalTurns().find(([k]) => k === key)?.[1];
          out.push(assert(`${kind}/${mode}: 실제 기본 실행과 레지스트리 연결`, !!entry && modelInput?.channel === kind && modelInput?.threadKey === key && modelInput?.abortSignal === entry.ac.signal, { entry: !!entry, channel: modelInput?.channel }));
          if (!entry) continue;
          out.push(assert(`${kind}/${mode}: 중단 목적지는 설정값`, entry.channel === kind && entry.notifyDest?.channel === dest.channel && entry.notifyDest?.target === dest.target, { channel: entry.channel, notifyDest: entry.notifyDest }));
          if (mode === "complete" || mode === "error") {
            finish?.();
          } else {
            const sent: any[] = [];
            const errors: string[] = [];
            const count = await inflight.notifyInterruptedTurns([entry], async (value) => {
              sent.push(value);
              return { delivered: mode !== "undelivered" && value.channel === dest.channel && value.target === dest.target, reason: "fixture undelivered" };
            }, (_channel, reason) => errors.push(reason));
            out.push(assert(`${kind}/${mode}: 전송 좌표·성공 집계·취소`, sent.length === 1 && sent[0].channel === dest.channel && sent[0].target === dest.target && count === (mode === "undelivered" ? 0 : 1) && entry.ac.signal.aborted && errors.length === (mode === "undelivered" ? 1 : 0), { sent, count, errors }));
          }
          await new Promise<void>((resolve) => setImmediate(resolve));
          out.push(assert(`${kind}/${mode}: 완료·실패·취소 뒤 등록 해제와 발화 기록`, !inflight.listExternalTurns().some(([k]) => k === key) && records.length === 1 && records[0].ok === (mode === "complete"), records));
          out.push(assert(`${kind}/${mode}: 정상 결과 전송 정책 보존`, dispatches.length === (kind === "scheduler" && mode === "complete" ? 1 : 0), dispatches));
        } finally {
          modelInput?.abortSignal && inflight.listExternalTurns().find(([k]) => k === key)?.[1].ac.abort();
          finish?.();
          await new Promise<void>((resolve) => setImmediate(resolve));
          inflight.unregisterExternalTurn(key);
          await plugin.stop();
        }
      }
    }
    return out;
  },
};
