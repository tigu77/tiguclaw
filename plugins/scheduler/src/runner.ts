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
import type { WorkerNotifyDest } from "../../../src/core/worker-jobs.js";
import type { ScheduleRow } from "../../../src/store/schedules.js";
import { dispatch } from "./dispatcher.js";
import { DEFAULT_SESSION_ID } from "../../../src/core/threadkey.js";

export interface RunnerDeps {
  /**
   * runClaude 주입 — spike 에서 mock 가능.
   *
   * notifyDest(additive, 2026-06-24): 이 발화가 띄울 백그라운드 워커의 완료/실패 통지
   * 목적지. 스케줄은 자기 dest(destChannel/destTarget)를 알므로 이걸 채워 주입한다 →
   * facade(defaultRunClaude)가 RegionASdkInput.notifyDest 로 forward → 워커 발사 도구가
   * 잡에 박아 워커가 그 dest 로 통지(텔레그램 도달). 미지정이면 워커는 channel/threadKey
   * 폴백(이 경로엔 channel="scheduler" 라 폴백은 통지 미도달 = 본 버그). 단방향: scheduler
   * 가 *값을 채우는* 쪽, 코어는 generic 좌표만 본다.
   */
  runClaude: (input: {
    text: string;
    threadKey: string;
    channel: string;
    cwd: string;
    notifyDest?: WorkerNotifyDest;
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
        // 워커 통지 dest 주입 — 이 발화가 띄운 워커가 스케줄의 실제 목적지(예 telegram/
        // chatId)로 완료/실패를 통지하게 한다. channel="scheduler" 는 reacquireReply 가
        // 모르는 채널이라(폴백 시 통지 미도달) generic dest 를 데이터로 흘려보낸다.
        notifyDest: {
          channel: schedule.destChannel,
          target: schedule.destTarget,
        },
      });
      resultText = out.text;
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      // 영구 로그에 스케줄 맥락과 함께 남긴다(EventBus·DB last_error 외 사후 grep 용).
      console.error(
        `[scheduler:${schedule.id}] '${schedule.label}' runClaude FAILED: ${reason}`,
      );
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
        // 세션 귀속 = 기본 세션(dashboard:default). 스케줄엔 아직 세션 지정 필드가 없다
        // (옵션 B 확장점: 생기면 `schedule.sessionId ?? DEFAULT_SESSION_ID`). 배달은
        // destChannel/destTarget(telegram 등) 그대로 — 세션과 채널 분리.
        sessionThreadKey: DEFAULT_SESSION_ID,
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
      // 발화·생성은 됐으나 전달 실패(예: telegram transport 재시도 소진). 영역 A 결과는
      // transcripts 에 보존됨. 영구 로그에 스케줄+목적지 맥락을 남겨 사후 grep 가능하게.
      console.error(
        `[scheduler:${schedule.id}] '${schedule.label}' → ${schedule.destChannel}:${schedule.destTarget} DISPATCH FAILED (내용 생성됨·전달 실패): ${reason}`,
      );
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
