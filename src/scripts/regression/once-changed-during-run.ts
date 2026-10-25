/**
 * 회귀: **타이머가 실행 도중 바뀌면 실행기가 정산하지 않는다 · 줄에서 미뤄지면 옛 차례로 돌지 않는다** (2026-10-23 — 설계
 * docs/decisions/2026-10-22-limit-auto-resume-design.md §3.9 · §7 R6′·R3′ⓑⓒ).
 *
 * 한도 자동 이어가기는 재개 턴이 다시 한도에 걸리면 **바로 그 턴 안에서** 같은 타이머를 새 시각으로 다시 건다. 실행기는 턴이 끝난 **뒤** 정산하므로
 * 규칙이 없으면 ①실패 정산이 다시 건 행을 끄고 «타이머 실패» 를 한 번 더 알리고 ②성공 정산이 다시 건 행을 지운다. 실행기는 «재개 타이머» 를 모른다 — 일반 규칙 둘:
 *  (a) 차례 재확인에 «예정 시각이 미래로 바뀜» → 돌지 않고 새 시각에 다시 건다
 *  (b) 정산 전에 «실행 도중 지워졌거나 `runAt` 이 이 실행이 쓴 값과 다름» → 기록·이벤트·삭제·끄기 전부 생략, 남아 있으면 다시 건다
 *      기준값 = **차례에서 실제로 쓴 `runAt`**(발화 시점 값이 아니다 — 줄에서 합쳐진 뒤 차례가 온 실행은 정상 정산한다)
 *
 * 등급: **동작** — 진짜 스케줄러 플러그인·실행기·`runTriggerInSession` 을 돌리고 메인 핸들러만 가짜로 갈아 끼운다. 모델 호출 0.
 */
import type { IncomingMessage } from "../../channels/types.js";
import { registerChannelOutbound } from "../../core/channel-outbound.js";
import { mainMessageHandler, __setMainHandlerForTest } from "../../core/worker-jobs.js";
import { initStore, saveSession } from "../../store/sessions.js";
import { addSchedule, deleteSchedule, getSchedule, recordFiring, updateSchedule } from "../../store/schedules.js";
import { assert, assertIsolated, loadPluginModule, type Assertion, type RegressionCheck } from "./_framework.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 4000): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(20);
  }
  return cond();
};
type Plugin = { startTrigger: (b: unknown, d?: unknown) => Promise<void>; stop: () => Promise<void> };
type Ev = { type: string; payload?: Record<string, unknown> };

export const check: RegressionCheck = {
  name: "once-changed-during-run",
  guards:
    "재개 턴이 실행 중에 같은 타이머를 새 시각으로 다시 걸면, 턴이 끝난 뒤 실행기의 정산이 그 행을 끄거나 지우고 «타이머 실패» 를 또 알리던 것 · 줄에서 미뤄진 발화가 옛 차례로 돌던 것",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    initStore();
    const out: Assertion[] = [];
    const made: number[] = [];
    const prevHandler = mainMessageHandler();
    const A = "dashboard:regr-ocd";
    saveSession({ channel: "http-bridge", threadKey: A, claudeSessionId: "regr-ocd", model: null, systemPromptHash: null } as never);
    registerChannelOutbound("regr-ocd", { deliver: async () => ({ messageIds: [1] }), defaultOutboundTarget: async () => "c" } as never);
    const subs: Array<(e: Ev) => void> = [];
    const published: Ev[] = [];
    const bus = { publish: (e: Ev) => { published.push(e); for (const s of subs) s(e); }, subscribe: (fn: (e: Ev) => void) => { subs.push(fn); return () => {}; } };
    const records = new Map<number, Array<{ ok: boolean }>>();
    const rec = (id: number, v: { ok: boolean; error?: string }): void => { records.set(id, [...(records.get(id) ?? []), { ok: v.ok }]); recordFiring(id, v); };
    const errorsOf = (id: number): number => published.filter((e) => e.type === "scheduler.error" && e.payload?.scheduleId === id).length;
    const firedOf = (id: number): number => published.filter((e) => e.type === "scheduler.fired" && e.payload?.scheduleId === id).length;
    const timer = (label: string, inMs: number): number => {
      const r = addSchedule({ label, cronExpr: "", prompt: `${label} 지시`, destChannel: "regr-ocd", destTarget: "c", triggerType: "once", runAt: Date.now() + inMs, originThreadKey: A });
      made.push(r.id);
      bus.publish({ type: "scheduler.toggle", payload: { id: r.id, action: "enable" } }); // 도구 경로와 같은 걸기
      return r.id;
    };
    /** 그 타이머의 n번째 차례에서 할 일. 없으면 정상 답. */
    const plans = new Map<number, Array<(m: IncomingMessage) => Promise<void>>>();
    const calls = new Map<number, number>();
    const ran = new Map<number, number>(); // beforeTurn 이 null 을 준(=실제로 돈) 횟수
    const rearm = (id: number, runAt: number): void => {
      updateSchedule(id, { runAt, enabled: true });
      bus.publish({ type: "scheduler.toggle", payload: { id, action: "enable" } });
    };
    const go = (m: IncomingMessage): boolean => {
      const ok = m.beforeTurn?.() === null;
      const id = (m.triggerRun as { id: number }).id;
      if (ok) ran.set(id, (ran.get(id) ?? 0) + 1);
      return ok;
    };
    __setMainHandlerForTest(async (m) => {
      const id = (m.triggerRun as { id?: number } | undefined)?.id;
      if (id === undefined) return;
      const n = calls.get(id) ?? 0;
      calls.set(id, n + 1);
      const plan = plans.get(id)?.[n];
      if (plan !== undefined) return plan(m);
      if (go(m)) await m.reply("답");
    });
    const p = new (await loadPluginModule<{ default: new () => Plugin }>("../../../plugins/scheduler/src/index.ts")).default();

    try {
      await p.startTrigger(bus, { cwd: process.cwd(), recordFiring: rec, dispatch: async () => {} });

      // ① 실행 도중 새 시각으로 다시 걸고 **실패** → 정산 0(기록·error 0) · 행 켜진 채 남아 새 시각에 다시 울린다 → 그때 성공하면 한 번만 정산하고 지운다.
      const rearmFail = timer("regr-ocd-재무장-실패", 150);
      plans.set(rearmFail, [async (m) => {
        if (!go(m)) return;
        rearm(rearmFail, Date.now() + 400);
        await m.reply("한도로 실패", { turnFailed: true });
      }]);
      // ② 실행 도중 다시 걸고 **성공** → 지우지 않는다(정산 0) · 새 시각에 다시 운다.
      const rearmOk = timer("regr-ocd-재무장-성공", 150);
      plans.set(rearmOk, [async (m) => {
        if (!go(m)) return;
        rearm(rearmOk, Date.now() + 400);
        await m.reply("답");
      }]);
      // ③ 실행 도중 사용자가 지움 + 실패 → 기록 0 · error 0.
      const deletedMid = timer("regr-ocd-도중삭제", 150);
      plans.set(deletedMid, [async (m) => {
        if (!go(m)) return;
        deleteSchedule(deletedMid);
        await m.reply("실패", { turnFailed: true });
      }]);
      // ④ 안 바뀐 타이머의 실패 → 현행(실패 기록·끔·error 1) · ⑤ 안 바뀐 성공 → 지움.
      const plainFail = timer("regr-ocd-보통실패", 150);
      plans.set(plainFail, [async (m) => { if (go(m)) await m.reply("실패", { turnFailed: true }); }]);
      const plainOk = timer("regr-ocd-보통성공", 150);
      // ⑥(a) 줄에서 기다리는 사이 예정 시각이 미래로 → 옛 차례로 안 돈다 · 새 시각에 한 번.
      const deferred = timer("regr-ocd-미뤄짐", 150);
      let deferredAt = 0;
      plans.set(deferred, [async (m) => {
        deferredAt = Date.now() + 500;
        updateSchedule(deferred, { runAt: deferredAt });
        go(m);
      }]);
      // ⑦ 실행 중에 새 시각이 와서 «합침» 으로 건너뛰어져도 잃지 않는다 — 끝나고 다시 걸려 한 번 더 돈다.
      const lateCome = timer("regr-ocd-실행중도래", 150);
      plans.set(lateCome, [async (m) => {
        if (!go(m)) return;
        rearm(lateCome, Date.now() + 40);
        await sleep(300); // 그 사이 시각이 와 실행기가 «합침» 으로 건너뛴다
        await m.reply("답");
      }]);
      // ⑧ⓑ 줄에서 합쳐지고 그 시각이 이미 지난 뒤 차례 — 합친 목록으로 **한 번** 돌고 정상 정산(지움) · 추가 발화 0.
      const mergedPast = timer("regr-ocd-합침뒤차례", 150);
      plans.set(mergedPast, [async (m) => {
        updateSchedule(mergedPast, { runAt: Date.now() - 5 }); // 차례 전에 합쳐졌고 그 시각도 지났다
        if (go(m)) await m.reply("답");
      }]);
      // ⑨ⓒ 같은 상황에서 차례 확정 뒤 핸들러가 던진다(배달 실패) → 기준은 차례의 runAt — «실행 도중 바뀜» 아님 · 실패로 정산 · 재무장 0.
      const mergedThrow = timer("regr-ocd-합침뒤던짐", 150);
      plans.set(mergedThrow, [async (m) => {
        updateSchedule(mergedThrow, { runAt: Date.now() - 5 });
        go(m);
        throw new Error("배달 실패(합성)");
      }]);

      // ⑩ 차례 확정 **뒤** 다시 걸고 핸들러가 던진다(배달 실패) → 예외 정산도 생략(기록·error 0) · 남은 행은 다시 걸려 새 시각에 운다.
      const rearmThrow = timer("regr-ocd-재무장-던짐", 150);
      plans.set(rearmThrow, [async (m) => {
        if (!go(m)) return;
        rearm(rearmThrow, Date.now() + 400);
        throw new Error("배달 실패(합성)");
      }]);
      // ⑪ 차례 확정 뒤 지우고 던진다 → 기록 0 · error 0 · 되살리지 않는다.
      const deleteThrow = timer("regr-ocd-삭제-던짐", 150);
      plans.set(deleteThrow, [async (m) => {
        if (!go(m)) return;
        deleteSchedule(deleteThrow);
        throw new Error("배달 실패(합성)");
      }]);
      // ⑫ 미래 타이머의 «지금 실행»(run_schedule) — 시각이 그대로면 미뤄진 게 아니다 → 지금 돈다(GPT 검토 R1).
      const future = timer("regr-ocd-미래-지금실행", 60_000);
      const mcp = await loadPluginModule<{ createSchedulerMcpServer: (h?: unknown) => { instance: unknown } }>("../../../plugins/scheduler/src/mcp.js");
      type Tools = Record<string, { handler: (a: unknown, e: unknown) => Promise<{ content: { text: string }[] }> }>;
      const tools = (mcp.createSchedulerMcpServer({ turnSession: () => A }).instance as { _registeredTools: Tools })._registeredTools;
      const runNow = JSON.parse((await tools["run_schedule"]!.handler({ id: future }, {})).content[0]!.text) as { ok?: boolean; started?: boolean };

      await until(() =>
        getSchedule(rearmThrow) === undefined && getSchedule(deleteThrow) === undefined && getSchedule(future) === undefined &&
        getSchedule(rearmFail) === undefined && getSchedule(rearmOk) === undefined && getSchedule(deferred) === undefined &&
        (calls.get(lateCome) ?? 0) >= 2 && getSchedule(lateCome) === undefined && getSchedule(plainOk) === undefined &&
        getSchedule(mergedPast) === undefined && (records.get(plainFail)?.length ?? 0) > 0 && (records.get(mergedThrow)?.length ?? 0) > 0, 5000);
      await sleep(600); // 추가 발화가 없는지 본다

      const s = (id: number): string => JSON.stringify({ calls: calls.get(id) ?? 0, ran: ran.get(id) ?? 0, rec: records.get(id) ?? [], err: errorsOf(id), fired: firedOf(id), row: getSchedule(id) === undefined ? null : { en: getSchedule(id)!.enabled } });
      out.push(
        assert("①★실행 도중 다시 건 뒤 실패 → 그 실행은 정산 0(기록·error) · 새 시각에 다시 울려 성공 → 그때 한 번 정산하고 지움",
          (calls.get(rearmFail) ?? 0) === 2 && JSON.stringify(records.get(rearmFail)) === JSON.stringify([{ ok: true }]) && errorsOf(rearmFail) === 0 && getSchedule(rearmFail) === undefined, s(rearmFail)),
        assert("②★실행 도중 다시 건 뒤 성공 → 그 실행은 지우지 않고(정산 0) 새 시각에 다시 운다",
          (calls.get(rearmOk) ?? 0) === 2 && (records.get(rearmOk)?.length ?? 0) === 1 && firedOf(rearmOk) === 1 && getSchedule(rearmOk) === undefined, s(rearmOk)),
        assert("③ 실행 도중 사용자가 지운 타이머의 실패 → 기록 0 · «타이머 실패» 이벤트 0",
          (records.get(deletedMid)?.length ?? 0) === 0 && errorsOf(deletedMid) === 0 && getSchedule(deletedMid) === undefined, s(deletedMid)),
        assert("④ 안 바뀐 타이머의 실패는 현행 그대로 — 실패 기록 · 꺼 둔 채 남김 · error 1",
          JSON.stringify(records.get(plainFail)) === JSON.stringify([{ ok: false }]) && errorsOf(plainFail) === 1 && getSchedule(plainFail)?.enabled === false, s(plainFail)),
        assert("⑤ 안 바뀐 타이머의 성공은 현행 그대로 — 지운다", (records.get(plainOk)?.length ?? 0) === 1 && getSchedule(plainOk) === undefined, s(plainOk)),
        assert("⑥★(a) 줄에서 기다리는 사이 예정 시각이 미래로 바뀌면 옛 차례로 **안 돈다** · 새 시각에 정확히 한 번",
          (calls.get(deferred) ?? 0) === 2 && (ran.get(deferred) ?? 0) === 1 && (records.get(deferred)?.length ?? 0) === 1 && getSchedule(deferred) === undefined, s(deferred)),
        assert("⑦★실행 중에 새 시각이 와 «합침» 으로 건너뛰어져도 잃지 않는다 — 끝나고 다시 걸려 한 번 더 돈다",
          (calls.get(lateCome) ?? 0) === 2 && getSchedule(lateCome) === undefined, s(lateCome)),
        assert("⑧★ⓑ 줄에서 합쳐진 시각이 이미 지난 뒤 차례 → 합친 목록으로 **정확히 한 번** 돌고 정상 정산(기준 = 차례의 runAt)",
          (calls.get(mergedPast) ?? 0) === 1 && JSON.stringify(records.get(mergedPast)) === JSON.stringify([{ ok: true }]) && getSchedule(mergedPast) === undefined, s(mergedPast)),
        assert("⑨★ⓒ 같은 상황에서 차례 확정 뒤 핸들러가 던지면 «실행 도중 바뀜» 이 아니다 — 실패로 정산 · 재무장 0(한 번만 돎)",
          (calls.get(mergedThrow) ?? 0) === 1 && JSON.stringify(records.get(mergedThrow)) === JSON.stringify([{ ok: false }]) && getSchedule(mergedThrow)?.enabled === false, s(mergedThrow)),
        assert("⑩★차례 확정 뒤 다시 걸고 **던지면** 예외 정산도 생략(기록 0·error 0) · 다시 걸려 새 시각에 한 번 더 돈다",
          (calls.get(rearmThrow) ?? 0) === 2 && JSON.stringify(records.get(rearmThrow)) === JSON.stringify([{ ok: true }]) && errorsOf(rearmThrow) === 0 && getSchedule(rearmThrow) === undefined, s(rearmThrow)),
        assert("⑪ 차례 확정 뒤 지우고 던지면 기록 0 · error 0 · 되살리지 않는다(한 번만 돎)",
          (calls.get(deleteThrow) ?? 0) === 1 && (records.get(deleteThrow)?.length ?? 0) === 0 && errorsOf(deleteThrow) === 0 && getSchedule(deleteThrow) === undefined, s(deleteThrow)),
        assert("⑫★미래 타이머의 «지금 실행»(run_schedule)은 «미뤄짐» 이 아니다 — 지금 한 번 돌고 끝나면 지운다",
          runNow.started === true && (ran.get(future) ?? 0) === 1 && (records.get(future)?.length ?? 0) === 1 && getSchedule(future) === undefined, `${s(future)} · 응답 ${JSON.stringify(runNow)}`),
      );
    } finally {
      await p.stop();
      __setMainHandlerForTest(prevHandler);
      for (const id of made) { try { deleteSchedule(id); } catch { /* 이미 지워졌다 */ } }
    }
    return out;
  },
};
