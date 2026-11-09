/**
 * 사용자 정리 요청에서 단건 호출을 반복하던 schedule/watch 삭제를 실제 MCP로 검증한다.
 * 합성 행만 만든다. 모델·실제 감시·외부 전달 0. 기존 store/lifecycle 경로와 부분 실패를 관측한다.
 */
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { adaptClaudeMcpServer } from "../../core/llm-runtime/adapters/_mcp-bridge.js";
import { getDb, initStore } from "../../store/sessions.js";
import * as schedules from "../../store/schedules.js";
import * as watches from "../../store/watches.js";
import { assert, assertIsolated, loadPluginModule, type Assertion, type RegressionCheck } from "./_framework.js";

type Result = { id: number; ok: boolean; deleted?: boolean; error?: string };
type Reply = { ok: boolean; deleted?: boolean | number; error?: string; results?: Result[] };
type Fixture = {
  tool: string;
  table: "schedules" | "watches";
  runs: "schedule_runs" | "watch_runs";
  owner: "schedule_id" | "watch_id";
  server: () => McpSdkServerConfigWithInstance;
  hook: (fn?: (id: number) => void) => void;
  add: () => number;
  exists: (id: number) => boolean;
  remove: (id: number) => boolean;
  record: (id: number, ts: number) => void;
  times: (id: number, limit: number) => number[];
};

export const check: RegressionCheck = {
  name: "trigger-batch-delete",
  guards: "schedule/watch 정리 도구의 단건 왕복 반복·복수 일부만 처리·오류를 없음으로 은폐·삭제 hook 및 발화 기록 누락",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    initStore();
    const scheduler = await loadPluginModule<{
      createSchedulerMcpServer: () => McpSdkServerConfigWithInstance;
      setSchedulerLifecycleHooks: (hooks: { onScheduleDeleted?: (id: number) => void }) => void;
    }>("../../../plugins/scheduler/src/mcp.ts");
    const watcher = await loadPluginModule<{
      createFileWatchMcpServer: () => McpSdkServerConfigWithInstance;
      setFileWatchLifecycleHooks: (hooks: { onWatchDeleted?: (id: number) => void }) => void;
    }>("../../../plugins/file-watch/src/mcp.ts");
    const fixtures: Fixture[] = [
      {
        tool: "delete_schedule", table: "schedules", runs: "schedule_runs", owner: "schedule_id",
        server: scheduler.createSchedulerMcpServer,
        hook: (fn) => scheduler.setSchedulerLifecycleHooks(fn === undefined ? {} : { onScheduleDeleted: fn }),
        add: () => schedules.addSchedule({ label: "batch-fixture", cronExpr: "0 0 * * *", prompt: "synthetic only", destChannel: "cli" }).id,
        exists: (id) => schedules.getSchedule(id) !== undefined,
        remove: schedules.deleteSchedule, record: schedules.recordScheduleRun, times: schedules.scheduleRunTimes,
      },
      {
        tool: "delete_watch", table: "watches", runs: "watch_runs", owner: "watch_id",
        server: watcher.createFileWatchMcpServer,
        hook: (fn) => watcher.setFileWatchLifecycleHooks(fn === undefined ? {} : { onWatchDeleted: fn }),
        add: () => watches.addWatch({ label: "batch-fixture", path: "/synthetic-not-watched", prompt: "synthetic only", destChannel: "cli" }).id,
        exists: (id) => watches.getWatch(id) !== undefined,
        remove: watches.deleteWatch, record: watches.recordWatchRun, times: watches.watchRunTimes,
      },
    ];
    const out: Assertion[] = [];
    const db = getDb();
    for (const f of fixtures) {
      const own: number[] = [];
      const fresh = (): number => { const id = f.add(); own.push(id); f.record(id, 123); return id; };
      const calls: number[] = [];
      let failHook: number | undefined;
      const hook = (id: number): void => { calls.push(id); if (id === failHook) throw new Error("synthetic hook failure"); };
      f.hook(hook);
      const server = await adaptClaudeMcpServer(f.server(), `batch-${f.table}`);
      const rawCall = async (args: Record<string, unknown>): Promise<string> => {
        const content = await server.callTool(f.tool, args) as Array<{ text?: string }>;
        return content[0]?.text ?? "";
      };
      const call = async (args: Record<string, unknown>): Promise<Reply> => JSON.parse(await rawCall(args)) as Reply;
      const push = (name: string, ok: boolean, got: unknown): void => { out.push(assert(`${f.tool}: ${name}`, ok, got)); };
      try {
        const tools = await server.listTools();
        const schema = tools.find((t) => t.name === f.tool)?.inputSchema as { properties?: Record<string, { type?: string; maxItems?: number; items?: { maximum?: number } }> } | undefined;
        push("실제 목록 schema에 id와 상한 있는 ids를 함께 노출", schema?.properties?.id !== undefined && schema.properties.ids?.type === "array" && schema.properties.ids.maxItems === 100 && schema.properties.ids.items?.maximum === Number.MAX_SAFE_INTEGER, schema);

        const single = fresh();
        const beforeSingle = calls.length;
        const one = await call({ id: single });
        push("단건 응답 shape 유지·삭제 hook 한 번", JSON.stringify(one) === '{"ok":true,"deleted":true}' && !f.exists(single) && calls.length === beforeSingle + 1 && calls.at(-1) === single, one);
        push("단건 발화 기록 정리", f.times(single, 10).length === 0, f.times(single, 10));
        const beforeMissing = calls.length;
        const missing = await call({ id: single });
        push("단건 없음 응답·hook 재호출 없음", JSON.stringify(missing) === '{"ok":true,"deleted":false}' && calls.length === beforeMissing, missing);

        const a = fresh(), b = fresh(), untouched = fresh();
        const beforeBatch = calls.length;
        const many = await call({ ids: [b, single, a, b, a] });
        const expected = [{ id: b, ok: true, deleted: true }, { id: single, ok: true, deleted: false }, { id: a, ok: true, deleted: true }];
        push("복수 전부 처리·첫 등장 순서·건별 없음·중복 제거", many.ok === true && many.deleted === 2 && JSON.stringify(many.results) === JSON.stringify(expected) && !f.exists(a) && !f.exists(b) && f.exists(untouched), many);
        push("중복/없는 ID 제외 hook 각각 한 번·기록 정리", JSON.stringify(calls.slice(beforeBatch)) === JSON.stringify([b, a]) && f.times(a, 10).length === 0 && f.times(b, 10).length === 0 && f.times(untouched, 10).length === 1, calls.slice(beforeBatch));
        const again = await call({ ids: [b, a] });
        push("복수 재시도 멱등", again.ok && again.deleted === 0 && again.results?.every((r) => r.deleted === false) === true, again);

        const invalid: Array<[string, Record<string, unknown>]> = [
          ["선택 없음", {}], ["id와 ids 동시", { id: untouched, ids: [untouched] }],
          ["빈 배열", { ids: [] }], ["배열 아닌 값", { ids: untouched }],
          ["잘못된 후반 0", { ids: [untouched, 0] }], ["후반 음수", { ids: [untouched, -1] }],
          ["후반 소수", { ids: [untouched, 1.5] }], ["후반 문자열", { ids: [untouched, "2"] }],
          ["후반 null", { ids: [untouched, null] }], ["후반 unsafe", { ids: [untouched, Number.MAX_SAFE_INTEGER + 1] }],
          ["단건 0", { id: 0 }], ["단건 unsafe", { id: Number.MAX_SAFE_INTEGER + 1 }],
          ["101건 중복 포함 상한", { ids: Array(101).fill(untouched) }],
        ];
        for (const [name, args] of invalid) {
          const before = calls.length;
          let rejected = false, response = "";
          try {
            response = await rawCall(args);
            try { rejected = (JSON.parse(response) as Reply).ok === false; }
            catch { rejected = /error|invalid|expected|at least|at most/i.test(response); }
          } catch (e) { rejected = true; response = String(e); }
          push(`입력 거절·부작용 전 검증: ${name}`, rejected && f.exists(untouched) && f.times(untouched, 10).length === 1 && calls.length === before, response);
        }
        const hundred = fresh();
        const beforeHundred = calls.length;
        const cap = await call({ ids: Array(100).fill(hundred) });
        push("100건 허용 후 중복 제거", cap.ok && cap.deleted === 1 && cap.results?.length === 1 && calls.length === beforeHundred + 1, cap);
        const max = await call({ ids: [Number.MAX_SAFE_INTEGER] });
        push("안전 정수 최대값은 유효한 없음", max.ok && max.results?.[0]?.deleted === false && max.results[0].id === Number.MAX_SAFE_INTEGER, max);

        const first = fresh(), fail = fresh(), last = fresh();
        db.exec(`CREATE TEMP TRIGGER batch_fail_delete BEFORE DELETE ON ${f.table} WHEN OLD.id = ${fail} BEGIN SELECT RAISE(ABORT, 'synthetic store failure'); END`);
        try {
          const start = calls.length;
          const partial = await call({ ids: [first, fail, last] });
          push("중간 store 실패도 앞뒤 성공 결과 보존·후속 계속", partial.ok === false && partial.deleted === 2 && partial.results?.length === 3 && partial.results[0]?.deleted === true && partial.results[2]?.deleted === true && !f.exists(first) && f.exists(fail) && !f.exists(last), partial);
          const failure = partial.results?.[1];
          push("store 오류를 deleted:false/없음으로 은폐하지 않음", failure?.id === fail && failure.ok === false && !Object.hasOwn(failure, "deleted") && failure.error?.includes("synthetic store failure") === true && JSON.stringify(calls.slice(start)) === JSON.stringify([first, last]), failure);
        } finally { db.exec("DROP TRIGGER batch_fail_delete"); }

        const cleanupFail = fresh(), afterCleanup = fresh();
        db.exec(`CREATE TEMP TRIGGER batch_fail_cleanup BEFORE DELETE ON ${f.runs} WHEN OLD.${f.owner} = ${cleanupFail} BEGIN SELECT RAISE(ABORT, 'synthetic cleanup failure'); END`);
        try {
          const partial = await call({ ids: [cleanupFail, afterCleanup] });
          const failure = partial.results?.[0];
          push("행 삭제 뒤 발화 기록 정리 실패는 상태 미확정·뒤 항목 유지", partial.ok === false && partial.deleted === 1 && failure?.ok === false && !Object.hasOwn(failure, "deleted") && failure.error?.includes("synthetic cleanup failure") === true && !f.exists(cleanupFail) && f.times(cleanupFail, 10).length === 1 && partial.results?.[1]?.deleted === true && !f.exists(afterCleanup), partial);
        } finally { db.exec("DROP TRIGGER batch_fail_cleanup"); }

        const hookFail = fresh(), afterHook = fresh();
        failHook = hookFail;
        const partialHook = await call({ ids: [hookFail, afterHook] });
        const hookResult = partialHook.results?.[0];
        push("hook 실패도 확정 삭제 사실·오류·후속 결과 보존", partialHook.ok === false && partialHook.deleted === 2 && hookResult?.ok === false && hookResult.deleted === true && hookResult.error?.includes("synthetic hook failure") === true && partialHook.results?.[1]?.deleted === true && !f.exists(hookFail) && !f.exists(afterHook) && f.times(hookFail, 10).length === 0, partialHook);
        const oldHookFail = fresh();
        failHook = oldHookFail;
        const oldHook = await call({ id: oldHookFail });
        push("기존 단건 hook 실패 응답 shape 보존", JSON.stringify(oldHook) === '{"ok":true,"deleted":true}' && !f.exists(oldHookFail), oldHook);
      } finally {
        f.hook();
        for (const id of own) f.remove(id);
        await server.close();
      }
    }
    return out;
  },
};
