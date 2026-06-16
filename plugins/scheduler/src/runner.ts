/**
 * scheduler runner — cron tick 콜백.
 *
 * 흐름 (contract §3·§4·§6):
 *   1) inFlight 가드 (overlap skip — recordFiring 호출 안 함, last_* 무변)
 *   2) virtual prompt: runClaude({ text, threadKey: scheduler:<id>, channel: "scheduler", cwd })
 *   3) recordFiring(id, {ok:true}) + EventBus publish "scheduler.fired"
 *   4) dispatcher 호출 → destination push
 *   5) throw 시 recordFiring(id, {ok:false, error}) + EventBus publish "scheduler.error"
 */
import type { EventBus } from "../../../src/core/eventbus.js";
import type { ScheduleRow } from "../../../src/store/schedules.js";
import { dispatch } from "./dispatcher.js";

export interface RunnerDeps {
  /** runClaude 주입 — spike 에서 mock 가능. */
  runClaude: (input: {
    text: string;
    threadKey: string;
    channel: string;
    cwd: string;
  }) => Promise<{ text: string }>;
  /** recordFiring 주입 — spike 에서 mock 가능. */
  recordFiring: (id: number, result: { ok: boolean; error?: string }) => void;
  /** dispatcher 주입 — spike 에서 mock 가능. */
  dispatch?: typeof dispatch;
  /** cwd — 데몬 부팅 시 process.cwd() 박힘. */
  cwd: string;
}

/** overlap skip 가드 — schedule id 별 in-flight 추적. 모듈 전역 (singleton 데몬). */
const inFlight = new Set<number>();

export const isInFlight = (id: number): boolean => inFlight.has(id);

export const runScheduleFiring = async (
  schedule: ScheduleRow,
  bus: EventBus,
  deps: RunnerDeps,
): Promise<void> => {
  if (inFlight.has(schedule.id)) {
    // contract §6 overlap = skip. recordFiring 호출 안 함, last_* 무변.
    console.log(
      `[scheduler:${schedule.id}] overlap skip (previous firing still in flight)`,
    );
    return;
  }
  inFlight.add(schedule.id);
  try {
    let resultText: string;
    try {
      const out = await deps.runClaude({
        text: schedule.prompt,
        threadKey: `scheduler:${schedule.id}`,
        channel: "scheduler",
        cwd: deps.cwd,
      });
      resultText = out.text;
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      deps.recordFiring(schedule.id, { ok: false, error: `runClaude: ${reason}` });
      bus.publish({
        type: "scheduler.error",
        ts: Date.now(),
        payload: {
          scheduleId: schedule.id,
          phase: "runClaude",
          error: reason,
        },
      });
      return;
    }

    // runClaude 성공. dispatch 시도 — 실패 시 last_status=error (영역 A 결과는 손실 0).
    const dispatchFn = deps.dispatch ?? dispatch;
    try {
      await dispatchFn({
        scheduleId: schedule.id,
        destChannel: schedule.destChannel,
        destTarget: schedule.destTarget,
        text: resultText,
        bus,
      });
      deps.recordFiring(schedule.id, { ok: true });
      bus.publish({
        type: "scheduler.fired",
        ts: Date.now(),
        payload: {
          scheduleId: schedule.id,
          destChannel: schedule.destChannel,
          destTarget: schedule.destTarget,
          ok: true,
        },
      });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      deps.recordFiring(schedule.id, {
        ok: false,
        error: `dispatch: ${reason}`,
      });
      bus.publish({
        type: "scheduler.error",
        ts: Date.now(),
        payload: {
          scheduleId: schedule.id,
          phase: "dispatch",
          destChannel: schedule.destChannel,
          error: reason,
        },
      });
    }
  } finally {
    inFlight.delete(schedule.id);
  }
};
