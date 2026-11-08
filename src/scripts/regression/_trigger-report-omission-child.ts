/** trigger-report-omission의 완전 격리 자식. 운영 홈/DB/모델/외부 발송/cleanup 없음. */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import vm from "node:vm";
import ts from "typescript";
import { fileURLToPath } from "node:url";
import { assert, assertIsolated, loadPluginModule, type Assertion } from "./_framework.js";

assertIsolated();
process.env.TIGUCLAW_HOME = mkdtempSync(path.join(process.env.TIGUCLAW_HOME!, "trigger-report-"));
process.chdir(process.env.TIGUCLAW_HOME);
const { getPaths } = await import("../../core/paths.js");
mkdirSync(getPaths().data, { recursive: true });
// 옛 cron/reboot 표와 기존 행: migration은 자동 opt-in·상태 손실 없이 보존한다.
const db = new Database(path.join(getPaths().data, "tiguclaw.db"));
db.exec(`CREATE TABLE schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL, cron_expr TEXT NOT NULL, timezone TEXT NOT NULL,
  prompt TEXT NOT NULL, dest_channel TEXT NOT NULL, dest_target TEXT, enabled INTEGER NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_fired_at INTEGER, last_status TEXT, last_error TEXT,
  trigger_type TEXT NOT NULL DEFAULT 'cron' CHECK(trigger_type IN ('cron','reboot'))
);
INSERT INTO schedules VALUES(901, 'legacy', '* * * * *', 'Asia/Seoul', 'old prompt', 'http-bridge', 'dashboard:legacy', 0, 101, 102, 103, 'error', 'old error', 'cron');
CREATE TABLE watches (
  id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL, path TEXT NOT NULL, pattern TEXT, recursive INTEGER NOT NULL DEFAULT 1,
  debounce_ms INTEGER NOT NULL DEFAULT 500, event_filter TEXT NOT NULL DEFAULT 'all', prompt TEXT NOT NULL, dest_channel TEXT NOT NULL, dest_target TEXT,
  enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  last_fired_at INTEGER, last_path TEXT, last_event TEXT, last_status TEXT, last_error TEXT
);
INSERT INTO watches VALUES(902, 'legacy watch', '/fixture', NULL, 1, 500, 'all', 'old watch', 'http-bridge', NULL, 0, 201, 202, 203, '/old', 'change', 'ok', NULL);`);
db.close();
const { initStore, getDb, closeStore, saveSession } = await import("../../store/sessions.js");
const schedules = await import("../../store/schedules.js");
const watches = await import("../../store/watches.js");
initStore();
const checks: Assertion[] = [];
const oldS = schedules.getSchedule(901), oldW = watches.getWatch(902);
checks.push(assert("기존 schedules·watches migration: 기본 deliver·기존 상태/시각 보존", oldS?.reportDefault === "deliver" && oldS.enabled === false && oldS.lastFiredAt === 103 && oldS.lastError === "old error" && oldW?.reportDefault === "deliver" && oldW.lastPath === "/old" && oldW.updatedAt === 202, { oldS, oldW }));
const newS = () => schedules.addSchedule({ label: "report check", cronExpr: "* * * * *", prompt: "상태 확인", destChannel: "http-bridge", destTarget: "dashboard:report" });
const s = newS();
const watchPath = mkdtempSync(path.join(process.env.TIGUCLAW_HOME, "files-"));
const w = watches.addWatch({ label: "report watch", path: watchPath, prompt: "파일 확인 {path}", destChannel: "http-bridge" });
schedules.updateSchedule(s.id, { reportDefault: "omit" }); watches.updateWatch(w.id, { reportDefault: "omit" });
schedules.updateSchedule(s.id, { label: "renamed" }); watches.updateWatch(w.id, { label: "renamed" });
checks.push(assert("신규 기본 deliver·opt-in omit·무관한 patch는 정책 유지", s.reportDefault === "deliver" && w.reportDefault === "deliver" && schedules.getSchedule(s.id)?.reportDefault === "omit" && watches.getWatch(w.id)?.reportDefault === "omit", { s, w }));
getDb().prepare("UPDATE schedules SET report_default='future' WHERE id=?").run(s.id);
getDb().prepare("UPDATE watches SET report_default='future' WHERE id=?").run(w.id);
checks.push(assert("미인식 저장값은 fail-open deliver", schedules.getSchedule(s.id)?.reportDefault === "deliver" && watches.getWatch(w.id)?.reportDefault === "deliver", { s: schedules.getSchedule(s.id), w: watches.getWatch(w.id) }));

const { createEventBus, getEventBus } = await import("../../core/eventbus.js");
const { finishTurnOutput, finishTriggerOutput } = await import("../../core/entry/reply-command.js");
const { startEventPersistence } = await import("../../core/event-persist.js");
const bus = createEventBus(); startEventPersistence(bus);
let delivered = 0, callbacks = 0;
for (const c of [
  { label: "기존 허용없음은 반환 증명만으로 생략 금지", allow: false, proof: true, appended: "", omit: false },
  { label: "허용돼도 증명없음은 기본 전달(오류·질문·불확실 포함)", allow: true, proof: false, appended: "", omit: false },
  { label: "Stop 훅 뒤 추가 문구가 있으면 증명있어도 전달", allow: true, proof: true, appended: "승인 질문", omit: false },
  { label: "허용+증명+추가없음만 생략", allow: true, proof: true, appended: "", omit: true },
]) {
  const before = delivered, beforeCb = callbacks;
  const fate = await finishTurnOutput({
    msg: { channel: "http-bridge", threadKey: "dashboard:report", triggerRun: { kind: "schedule" }, ...(c.allow ? { reportDefault: "omit" as const } : {}), onReportOmitted: () => { callbacks++; } },
    out: c.proof ? { reportOmitted: true } : {}, appended: c.appended, bus,
    deliver: async () => { delivered++; },
  });
  checks.push(assert(c.label, fate === (c.omit ? "omitted" : "delivered") && delivered - before === (c.omit ? 0 : 1) && callbacks - beforeCb === (c.omit ? 1 : 0), { fate, delivered, callbacks }));
}
const marker = bus.history({ types: ["channel.message.out"] }).at(-1)?.payload;
const persisted = getDb().prepare("SELECT data FROM chat_log WHERE thread_key=? ORDER BY id DESC LIMIT 1").get("dashboard:report") as { data: string } | undefined;
checks.push(assert("트리거 완료는 내부 recordOnly 이벤트와 동일 영속 표식·unread false", marker?.recordOnly === true && marker.audience === "internal" && marker.notice === true && marker.unread === false && JSON.parse(persisted?.data ?? "{}").recordOnly === true, { marker, persisted }));
await finishTurnOutput({ msg: { reportDefault: "omit", channel: "http-bridge", threadKey: "dashboard:worker" }, out: { reportOmitted: true }, appended: "", bus, deliver: async () => { delivered++; } });
checks.push(assert("기존 worker 내부 상태 줄에는 recordOnly를 붙이지 않음", bus.history({ types: ["channel.message.out"] }).at(-1)?.payload.recordOnly === undefined, bus.history({ types: ["channel.message.out"] }).at(-1)));
let threw = false;
try { await finishTriggerOutput({ channel: "scheduler", threadKey: "scheduler:failed", kind: "schedule", bus, out: {}, reportDefault: "omit", deliver: async () => { throw new Error("transport failed"); } }); } catch { threw = true; }
checks.push(assert("전달 실패를 생략 성공으로 바꾸지 않음", threw, { threw }));

// MCP 실제 handler와 schema. 등록 목적지는 실제 네트워크가 없는 가짜 adapter다.
const { registerChannelOutbound } = await import("../../core/channel-outbound.js");
let sends = 0;
registerChannelOutbound("report-test", { deliver: async () => { sends++; return { messageIds: [1] }; }, defaultOutboundTarget: async () => "test" } as never);
type Tool = { handler: (a: unknown, e: unknown) => Promise<{ content: { text: string }[] }>; inputSchema: { safeParse: (x: unknown) => { success: boolean } } };
type Tools = Record<string, Tool>;
const smcp = await loadPluginModule<{ createSchedulerMcpServer: (h?: unknown) => { instance: unknown } }>("../../../plugins/scheduler/src/mcp.js");
const wmcp = await loadPluginModule<{ createFileWatchMcpServer: (h?: unknown) => { instance: unknown } }>("../../../plugins/file-watch/src/mcp.js");
const tools = (instance: unknown) => (instance as { _registeredTools: Tools })._registeredTools;
const st = tools(smcp.createSchedulerMcpServer({ turnSession: () => null }).instance);
const wt = tools(wmcp.createFileWatchMcpServer({ turnSession: () => null }).instance);
const call = async (t: Tools, name: string, args: unknown): Promise<Record<string, unknown>> => JSON.parse((await t[name]!.handler(args, {})).content[0]!.text) as Record<string, unknown>;
const args = { label: "mcp check", prompt: "확인", dest_channel: "report-test", cron_expr: "* * * * *" };
const a = await call(st, "add_schedule", args);
const b = await call(st, "add_schedule", { ...args, report_default: "omit" });
const verbatim = await call(st, "add_schedule", { ...args, prompt: "!say 요청 알림", report_default: "omit" });
const v = await call(st, "update_schedule", { id: b.id, prompt: "!say 요청 알림" });
const wa = await call(wt, "add_watch", { ...args, path: watchPath });
await call(wt, "update_watch", { id: wa.id, report_default: "omit" });
const sl = (await call(st, "list_schedules", {})).items as Record<string, unknown>[];
const wl = (await call(wt, "list_watches", {})).items as Record<string, unknown>[];
checks.push(assert("제품 도구 add 기본 deliver·add/update/list 정책 왕복·!say+omit 거절", a.report_default === "deliver" && b.report_default === "omit" && verbatim.error === "verbatim_requires_delivery" && v.error === "verbatim_requires_delivery" && sl.find((x) => x.id === b.id)?.report_default === "omit" && wl.find((x) => x.id === wa.id)?.report_default === "omit", { a, b, verbatim, v, wa, wl }));

// 전용 scheduler: 진짜 queue·저장·정산, 모델과 배달만 대역. 원문은 지우지 않는다.
const { runScheduleFiring } = await loadPluginModule<{ runScheduleFiring: (r: unknown, b: unknown, d: unknown) => Promise<void> }>("../../../plugins/scheduler/src/runner.js");
let dispatches = 0; const inputs: Record<string, unknown>[] = [];
const sbus = createEventBus();
for (const c of [
  { label: "기본 deliver는 반환 증명있어도 전달", policy: "deliver", proof: true, text: "최종 결과", omitted: false },
  { label: "명시 omit도 증명없으면 전달", policy: "omit", proof: false, text: "중요 변화", omitted: false },
  { label: "선택 확인 omit+증명은 배달없이 성공", policy: "omit", proof: true, text: "확인 원문", omitted: true },
  { label: "빈 본문 생략도 실행 이력 경계 보존", policy: "omit", proof: true, text: "", omitted: true },
] as const) {
  const row = schedules.updateSchedule(newS().id, { reportDefault: c.policy })!;
  let records = 0, ok = false;
  const before = dispatches;
  await runScheduleFiring(row, sbus, { cwd: process.cwd(), runClaude: async (i: Record<string, unknown>) => { inputs.push(i); return { text: c.text, ...(c.proof ? { reportOmitted: true } : {}), usage: { inputTokens: 9 } }; }, dispatch: async (i: { text: string }) => { if (i.text !== c.text) throw new Error("원문 변경됨"); dispatches++; }, recordFiring: (id: number, r: { ok: boolean }) => { records++; ok = r.ok; schedules.recordFiring(id, r); } });
  checks.push(assert(c.label, dispatches - before === (c.omitted ? 0 : 1) && records === 1 && ok && (inputs.at(-1)?.reportOmittable === true) === (c.policy === "omit") && schedules.scheduleRunTimes(row.id, 10).length === 1, { records, ok, dispatchDelta: dispatches - before, input: inputs.at(-1), history: schedules.scheduleRunTimes(row.id, 10) }));
}
const once = schedules.addSchedule({ label: "once omit", cronExpr: "", prompt: "확인", destChannel: "report-test", triggerType: "once", runAt: Date.now() - 1, reportDefault: "omit" });
let onceHistoryAtRecord = 0;
await runScheduleFiring(once, sbus, { cwd: process.cwd(), runClaude: async () => ({ text: "원문", reportOmitted: true }), dispatch: async () => { throw new Error("생략을 배달함"); }, recordFiring: (id: number, r: { ok: boolean }) => { onceHistoryAtRecord = schedules.scheduleRunTimes(id, 10).length; schedules.recordFiring(id, r); } });
checks.push(assert("생략 성공 once는 기존 성공 정산으로 종료", schedules.getSchedule(once.id) === undefined && onceHistoryAtRecord === 1, { row: schedules.getSchedule(once.id), onceHistoryAtRecord }));

// 실제 직송 계약은 저장층 opt-in 값과 무관하게 항상 원문을 전송한다.
const say = schedules.addSchedule({ label: "verbatim", cronExpr: "* * * * *", prompt: "!say 요청 알림", destChannel: "report-test", reportDefault: "omit" });
let sayCalls = 0, sayModels = 0;
await runScheduleFiring(say, sbus, { cwd: process.cwd(), runClaude: async () => { sayModels++; return { text: "금지" }; }, dispatch: async (i: { text: string }) => { if (i.text === "요청 알림") sayCalls++; }, recordFiring: schedules.recordFiring });
checks.push(assert("직송 !say는 모델0·요청 원문 전달 유지", sayCalls === 1 && sayModels === 0, { sayCalls, sayModels }));
const failedOnce = schedules.addSchedule({ label: "failed once", cronExpr: "", prompt: "확인", destChannel: "report-test", triggerType: "once", runAt: Date.now() - 1, reportDefault: "omit" });
await runScheduleFiring(failedOnce, sbus, { cwd: process.cwd(), runClaude: async () => { throw new Error("known runtime failure"); }, dispatch: async () => { throw new Error("호출되면 안 됨"); }, recordFiring: schedules.recordFiring });
checks.push(assert("실행 오류 once는 생략 성공이 아니라 꺼진 실패 행 유지", schedules.getSchedule(failedOnce.id)?.enabled === false && schedules.getSchedule(failedOnce.id)?.lastStatus === "error" && sbus.history({ types: ["scheduler.error"] }).some((e) => e.payload.scheduleId === failedOnce.id), schedules.getSchedule(failedOnce.id)));
const { enqueueThreadTurn } = await import("../../core/worker-jobs.js");
const queued = schedules.updateSchedule(newS().id, { reportDefault: "omit" })!;
let release!: () => void;
const blocked = enqueueThreadTurn(`scheduler:${queued.id}`, () => new Promise<void>((r) => { release = r; }));
await new Promise((r) => setTimeout(r, 10));
let queuedAllow: unknown, queuedSent = 0;
const qrun = runScheduleFiring(queued, sbus, { cwd: process.cwd(), runClaude: async (i: Record<string, unknown>) => { queuedAllow = i.reportOmittable; schedules.updateSchedule(queued.id, { reportDefault: "omit" }); return { text: "최신 결과", reportOmitted: true }; }, dispatch: async () => { queuedSent++; }, recordFiring: schedules.recordFiring });
schedules.updateSchedule(queued.id, { reportDefault: "deliver" });
release(); await blocked; await qrun;
checks.push(assert("실제 scheduler queue에서 최신 deliver·실행중 정책 변경은 다음 실행", queuedAllow === undefined && queuedSent === 1, { queuedAllow, queuedSent }));
checks.push(assert("MCP enum은 잘못된 값 거절(기본 deliver 강제 승격 없음)", !st.add_schedule!.inputSchema.safeParse({ ...args, report_default: "invalid" }).success && !wt.update_watch!.inputSchema.safeParse({ id: wa.id, report_default: "invalid" }).success, "invalid rejected"));

// 원래 대화: 실제 공통 trigger callback은 허용이 아니라 게이트 결과 관측이다.
const { runTriggerInSession } = await import("../../core/trigger-in-session.js");
const { __setMainHandlerForTest } = await import("../../core/worker-jobs.js");
saveSession({ threadKey: "dashboard:origin-report", claudeSessionId: "fixture-session", channel: "http-bridge", model: null, systemPromptHash: null });
let latest: "deliver" | "omit" = "omit";
let beforePolicy: "deliver" | "omit" = "deliver";
let seenPolicy: unknown;
__setMainHandlerForTest(async (m) => {
  latest = beforePolicy; // 차례를 기다리는 동안 정책 변경
  const skip = m.beforeTurn?.(); if (skip) return;
  seenPolicy = m.reportDefault;
  await finishTurnOutput({ msg: m, out: { reportOmitted: true }, appended: "", bus: getEventBus(), deliver: async () => { await m.reply("원래 대화 결과"); } });
});
const origin = async () => runTriggerInSession({ origin: "dashboard:origin-report", marker: "스케줄 #999 실행", triggerRun: { kind: "schedule", id: 999 }, label: "report-regression", turnOrigin: "schedule", atTurn: () => ({ text: "최신 확인", ...(latest === "omit" ? { reportDefault: "omit" } : {}), dest: { channel: "report-test", target: "test" } }) });
const normal = await origin();
latest = "deliver"; beforePolicy = "omit";
const omitted = await origin();
checks.push(assert("원래 대화 정책을 실제 차례에서 제거/설정·콜백으로만 생략 회송·중복발송 없음", ! ("skipped" in normal) && normal.replied > 0 && normal.reportOmitted === undefined && !("skipped" in omitted) && omitted.replied === 0 && omitted.reportOmitted === true && seenPolicy === "omit" && sends === 1, { normal, omitted, sends, seenPolicy }));
__setMainHandlerForTest(async (m) => { m.beforeTurn?.(); });
const silent = await origin();
checks.push(assert("replied:0만으로 생략을 추론하지 않음", !("skipped" in silent) && silent.replied === 0 && silent.reportOmitted === undefined, silent));

// 실제 watch 파사드: 전용 세션의 실행 차례 정책/증명/빈 본문 이력 경계를 모델 경계에서 관측한다.
{
  const filename = fileURLToPath(new URL("../../../plugins/file-watch/src/index.ts", import.meta.url));
  let row = { ...watches.getWatch(w.id)!, originThreadKey: null, keepRuns: null, reportDefault: "deliver" };
  let captured!: { runClaude: (i: unknown) => Promise<Record<string, unknown>> };
  let atQueue = "omit", raw = "", proof = true, historyCount = 0;
  let input: Record<string, unknown> = {};
  const request = (name: string): unknown => {
    if (name.endsWith("/eventbus.js")) return { safeUnsubscribe: (f: (() => void) | null) => { f?.(); return null; } };
    if (name.endsWith("/claude.js")) return { runClaude: async (i: Record<string, unknown>) => { input = i; row.reportDefault = "deliver"; return { text: raw, ...(proof ? { reportOmitted: true } : {}) }; } };
    if (name.endsWith("/external-turn.js")) return { runExternalTurn: (_k: string, _t: unknown, f: () => unknown) => { row.reportDefault = atQueue; return f(); } };
    if (name.endsWith("/watches.js")) return { getWatch: () => row, listWatches: () => [row], recordFiring: () => {}, recordWatchRun: () => { historyCount++; }, updateWatch: () => {}, watchRunTimes: () => [] };
    if (name.endsWith("/thread-reset.js")) return { applyRunHistory: () => null };
    if (name.endsWith("/sessions.js")) return { canonicalSessionChannel: (_k: string, c: string) => c };
    if (name.endsWith("/trigger-in-session.js")) return { runTriggerInSession: async () => { throw new Error("전용 세션 검사"); } };
    if (name === "./mcp.js") return { setFileWatchLifecycleHooks: () => {}, createFileWatchMcpServer: () => ({}) };
    if (name === "./watcher.js") return { registerWatcher: (_r: unknown, _b: unknown, d: typeof captured) => { captured = d; }, unregisterWatcher: () => {}, substitutePrompt: (p: string) => p };
    throw new Error(`모의하지 않은 import: ${name}`);
  };
  const exports: Record<string, unknown> = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports, require: request, AbortController, Date, process: { cwd: () => process.cwd() }, console: { log() {}, warn() {}, error() {} } }, { filename });
  const Plugin = exports.default as new () => { startTrigger: (b: unknown, d: unknown) => Promise<void>; stop: () => Promise<void> };
  const plugin = new Plugin();
  await plugin.startTrigger(createEventBus(), { cwd: process.cwd() });
  const fire = () => captured.runClaude({ text: "확인", threadKey: `file-watch:${w.id}`, channel: "file-watch", originThreadKey: null, notifyDest: { channel: "report-test", target: null }, triggerRun: { kind: "watch", id: w.id, path: watchPath, event: "add" } });
  const quiet = await fire();
  checks.push(assert("watch 실제 파사드는 차례의 omit를 모델로·사용한 정책을 결과로 회송·빈 생략 이력 1", input.reportOmittable === true && quiet.reportDefault === "omit" && quiet.reportOmitted === true && quiet.text === "" && historyCount === 1, { input, quiet, historyCount }));
  row.reportDefault = "omit"; atQueue = "deliver"; raw = "최종 결과";
  const deliver = await fire();
  checks.push(assert("watch 실제 파사드는 차례의 deliver로 허용 제거·증명만 있어도 전달 계약", input.reportOmittable === undefined && deliver.reportDefault === undefined && deliver.text === raw && historyCount === 2, { input, deliver, historyCount }));
  atQueue = "omit"; raw = ""; proof = false;
  await fire();
  checks.push(assert("watch 빈 본문/증명없음은 완료 이력으로 추가하지 않음", historyCount === 2, { historyCount }));
  await plugin.stop();
}

// 전용 watch: 실제 chokidar add 한 번. 원문/이벤트를 그대로 두고 배달만 마감한다.
const watcher = await loadPluginModule<{ registerWatcher: (r: unknown, b: unknown, d: unknown) => void; unregisterWatcher: (id: number) => void }>("../../../plugins/file-watch/src/watcher.js");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
for (const c of [{ policy: "omit", proof: true, omitted: true }, { policy: undefined, proof: true, omitted: false }, { policy: "omit", proof: false, omitted: false }] as const) {
  const dir = mkdtempSync(path.join(watchPath, "case-"));
  const row = watches.addWatch({ label: "watch omit", path: dir, recursive: false, debounceMs: 20, eventFilter: "add", prompt: "확인", destChannel: "report-test", reportDefault: "omit" });
  const wb = createEventBus(); let sent = 0, done = 0;
  watcher.registerWatcher(row, wb, { cwd: process.cwd(), runClaude: async () => ({ text: "원문", reportDefault: c.policy, ...(c.proof ? { reportOmitted: true } : {}) }), dispatch: async () => { sent++; }, recordFiring: (id: number, r: { ok: boolean }) => { if (r.ok) done++; watches.recordFiring(id, r); } });
  try {
    await sleep(250); writeFileSync(path.join(dir, "created.txt"), "test");
    for (let n = 0; n < 100 && done === 0; n++) await sleep(25);
    const fired = wb.history({ types: ["file-watch.fired"] }).at(-1)?.payload;
    checks.push(assert(`실제 감시: 사용 정책 ${c.policy ?? "미제공"}·증명 ${c.proof} → ${c.omitted ? "기록만" : "전달"}`, done === 1 && sent === (c.omitted ? 0 : 1) && (fired?.reportOmitted === true) === c.omitted, { done, sent, fired }));
  } finally { watcher.unregisterWatcher(row.id); }
}
__setMainHandlerForTest(undefined);
closeStore();
console.log(JSON.stringify(checks));
process.exit(checks.every((a) => a.ok) ? 0 : 1);
