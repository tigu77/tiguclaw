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
import { getSchedule } from "../../../src/store/schedules.js";
import { loadSchedulerRetryEnabled } from "../../../src/core/settings.js";
import { dispatch } from "./dispatcher.js";
import { DEFAULT_SESSION_ID } from "../../../src/core/threadkey.js";

/**
 * 전달 실패 후 자동 재전송까지의 대기(2026-07-26). 채널 어댑터가 이미 transport 재시도를
 * 소진한 뒤라(telegram 은 ~80초) 즉시 재시도는 같은 장애를 다시 맞을 뿐이다. 5분은 일시적
 * 5xx·네트워크 단절이 걷히기엔 충분하고, 아침 브리핑류가 아직 유효한 범위.
 */
const DISPATCH_RETRY_DELAY_MS = 300_000;

export interface RunnerDeps {
  /**
   * runClaude 주입 — spike 에서 mock 가능.
   *
   * notifyDest(additive, 2026-06-24): 이 발화가 띄울 백그라운드 매니저의 완료/실패 통지
   * 목적지. 스케줄은 자기 dest(destChannel/destTarget)를 알므로 이걸 채워 주입한다 →
   * facade(defaultRunClaude)가 RegionASdkInput.notifyDest 로 forward → 매니저 발사 도구가
   * 잡에 박아 매니저가 그 dest 로 통지(텔레그램 도달). 미지정이면 매니저는 channel/threadKey
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
  /** 자동 재전송 대기(ms) 주입 — 검증에서 5분을 기다리지 않기 위함. 미지정 시 기본값. */
  retryDelayMs?: number;
  /** cwd — 데몬 부팅 시 process.cwd() 박힘. */
  cwd: string;
}

/** overlap skip 가드 — schedule id 별 in-flight 추적. 모듈 전역 (singleton 데몬). */
const inFlight = new Set<number>();

export const isInFlight = (id: number): boolean => inFlight.has(id);

/**
 * ★자동 재전송 1회 (2026-07-26) — "발화·생성은 됐는데 전달만 실패" 를 사람 개입 없이 되살린다.
 *
 * 동기(실사고): 아침 리포트 2건이 502 로 유실됐고 **8시간 동안 아무도 몰랐다**. 내용은 이미
 * 생성돼 DB 에 있었는데 전달만 실패한 상태 — 사람이 할 조치가 "다시 보내라" 하나뿐이었다.
 *
 * ★왜 이건 자동이어도 되나(자동 조치 판단 기준): 되돌릴 수 있거나, **최악이 사소하거나**.
 *  재전송은 이미 나간 메시지라 회수는 불가하지만 오판의 최대 피해가 "중복 메시지 1건" 이다.
 *  같은 기준이 파일 삭제·외부 API 쓰기엔 성립하지 않으므로 그쪽으로 확장 금지.
 *
 * 가드:
 *  - **1회만**. 재시도의 재시도 없음(무한 루프 차단 — 백엔드 장애 시 폭주 방지).
 *  - **LLM 재실행 안 함**. 실패한 건 전달이지 생성이 아니다. 이미 만든 원문을 그대로 보낸다
 *    (다시 돌리면 내용이 달라지고 비용도 든다 — "재전송" 의 의미가 아니다).
 *  - 재전송 시점에 **다음 발화가 진행 중이거나 스케줄이 삭제됐으면 취소**(철 지난 내용 방지).
 *  - `unref()` — 대기 중인 타이머가 데몬 종료를 붙잡지 않는다(재시작하면 그냥 유실 = 허용).
 *
 * 결과는 성공·실패 모두 이벤트로 알린다. 성공 시 `last_status` 가 ok 로 정정되므로
 * self-growth 자가 진단 스윕이 이 건을 **다시 보고하지 않는다**(중복 통보 0 — 스윕은 아직
 * 복구되지 않은 것만 텔레그램으로 밀어 올린다).
 */
const scheduleDispatchRetry = (
  schedule: ScheduleRow,
  text: string,
  bus: EventBus,
  deps: RunnerDeps,
): void => {
  const timer = setTimeout(() => {
    void (async () => {
      try {
        if (inFlight.has(schedule.id)) return; // 다음 발화 진행 중 — 철 지난 재전송 취소.
        const current = getSchedule(schedule.id);
        if (current === undefined) return; // 삭제됨.
        const dispatchFn = deps.dispatch ?? dispatch;
        await dispatchFn({
          scheduleId: schedule.id,
          destChannel: schedule.destChannel,
          destTarget: schedule.destTarget,
          text,
          bus,
          sessionThreadKey: DEFAULT_SESSION_ID,
        });
        deps.recordFiring(schedule.id, { ok: true });
        console.log(
          `[scheduler:${schedule.id}] '${schedule.label}' 자동 재전송 성공 (전달 복구)`,
        );
        bus.publish({
          type: "scheduler.recovered",
          ts: Date.now(),
          payload: {
            scheduleId: schedule.id,
            label: schedule.label,
            destChannel: schedule.destChannel,
            destTarget: schedule.destTarget,
          },
        });
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        console.error(
          `[scheduler:${schedule.id}] '${schedule.label}' 자동 재전송도 실패: ${reason}`,
        );
        deps.recordFiring(schedule.id, {
          ok: false,
          error: `dispatch(재전송 실패): ${reason}`,
        });
        bus.publish({
          type: "scheduler.error",
          ts: Date.now(),
          payload: {
            scheduleId: schedule.id,
            phase: "dispatch_retry",
            destChannel: schedule.destChannel,
            error: reason,
            label: schedule.label,
            destTarget: schedule.destTarget,
            // 최종 확정 실패 — 관측자가 즉시 사용자에게 알려야 할 신호.
            willRetry: false,
          },
        });
      }
    })();
  }, deps.retryDelayMs ?? DISPATCH_RETRY_DELAY_MS);
  timer.unref?.();
};

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

    // ★직송 모드 (2026-07-30 사용자 확정: "재시작알림은 LLM 안태워도 돼").
    //
    //  실측: `scheduler:3` 재시작 알림이 *"돌쇠 재시작 완료! ✅"* 12자를 답하려고 매번
    //  **입력 29,635 토큰**을 태웠다(그중 ~90%가 조립 프리픽스, 게다가 그 프리픽스는 input
    //  배열 맨 끝이라 캐시도 못 받는다). 재시작 27회/일 → **약 80만 입력토큰/일**,
    //  누적 136회 = **약 400만 토큰**을 상수 문자열 에코에 썼다.
    //
    //  ★문구를 패턴으로 추측하지 않는다("정확히 이 문구로 답하세요:" 매칭 같은 것). 그건
    //   오늘 내내 고친 "손으로 관리하는 목록" 부류다. 대신 **명시 접두**로 옵트인한다 —
    //   프롬프트가 `!say ` 로 시작하면 그 뒤를 **그대로** 보내고 LLM 을 건너뛴다.
    //   판정이 프롬프트 작성자의 의도 그 자체라 드리프트할 여지가 없다.
    const VERBATIM_PREFIX = "!say ";
    if (schedule.prompt.startsWith(VERBATIM_PREFIX)) {
      const text = schedule.prompt.slice(VERBATIM_PREFIX.length).trim();
      if (text === "") {
        deps.recordFiring(schedule.id, { ok: false, error: "직송 문구가 비어있음" });
        return;
      }
      // ★catch 필수 — 이 경로는 `void runScheduleFiring(...)` 로 불린다(index.ts:185,223).
      //  `dispatch` 가 미배달에 throw 하도록 바꾼 뒤(2026-07-31), 여기 catch 가 없어서
      //  **unhandledRejection → crash-fast → launchd respawn → 부팅마다 재발** 이 됐다.
      //  하필 라이브에 `trigger_type=reboot` + `!say` 스케줄이 있어 **부팅 크래시 루프**다.
      //  게다가 recordFiring 이 아예 안 불려 DB 에 실패 기록조차 안 남았다 — 이 수정이
      //  노린 것의 정반대. LLM 경유 경로엔 원래 catch 가 있었는데 이 갈래만 없었다.
      try {
        await (deps.dispatch ?? dispatch)({
          scheduleId: schedule.id,
          destChannel: schedule.destChannel,
          destTarget: schedule.destTarget,
          text,
          bus,
          sessionThreadKey: DEFAULT_SESSION_ID, // LLM 경유와 동일 귀속(아래 호출부와 정합).
        });
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        deps.recordFiring(schedule.id, { ok: false, error: `dispatch: ${reason}` });
        console.error(
          `[scheduler:${schedule.id}] '${schedule.label}' → ${schedule.destChannel}:${schedule.destTarget} 직송 실패(전달만 실패): ${reason}`,
        );
        // ★자동 재전송을 여기도 건다 (2026-08-01 A4e). LLM 경유 갈래는 이미 걸고 있었고
        //  이 갈래만 빠져 있었다 — **같은 전달 실패인데 프롬프트 접두사 하나로 결과가
        //  갈렸다**(LLM 경유는 5분 뒤 되살아나고 직송은 그냥 유실). 재전송이 필요한 이유는
        //  "무엇으로 문구를 만들었나" 와 무관하다. 직송은 오히려 더 안전하다 — 문구가
        //  고정이라 재전송이 원문 그대로다(LLM 재실행처럼 내용이 달라질 여지가 없다).
        const willRetry = loadSchedulerRetryEnabled(deps.cwd);
        if (willRetry) scheduleDispatchRetry(schedule, text, bus, deps);
        try {
          bus.publish({
            type: "scheduler.error",
            ts: Date.now(),
            payload: {
              scheduleId: schedule.id,
              label: schedule.label,
              error: reason,
              // 재전송을 예약했으면 이 실패는 **아직 확정이 아니다** — 관측자가 성급히
              // "유실됐다" 고 알리지 않게 한다(LLM 경유 갈래와 같은 계약).
              willRetry,
            },
          });
        } catch {
          /* 관측 실패가 스케줄러를 죽이지 않는다 */
        }
        return;
      }
      deps.recordFiring(schedule.id, { ok: true });
      console.log(
        `[scheduler:${schedule.id}] '${schedule.label}' 직송(LLM 미경유) — ${text.length}자.`,
      );
      return;
    }

    try {
      const out = await deps.runClaude({
        text: schedule.prompt,
        threadKey: `scheduler:${schedule.id}`,
        channel: "scheduler",
        cwd: deps.cwd,
        // 매니저 통지 dest 주입 — 이 발화가 띄운 매니저가 스케줄의 실제 목적지(예 telegram/
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
          label: schedule.label,
          destTarget: schedule.destTarget,
          // 생성 자체가 실패 — 자동 재전송 대상 아님(보낼 내용이 없다. LLM 재실행은
          // 내용·비용이 달라져 "재전송" 이 아니므로 범위 밖). 즉 이 실패는 즉시 확정.
          willRetry: false,
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
      // 자동 재전송 예약(설정으로 끌 수 있음). 예약했으면 이 실패는 **아직 확정이 아니다** —
      // willRetry 로 그 사실을 이벤트에 실어 관측자가 성급히 "유실됐다" 고 알리지 않게 한다.
      const willRetry = loadSchedulerRetryEnabled(deps.cwd);
      if (willRetry) scheduleDispatchRetry(schedule, resultText, bus, deps);
      bus.publish({
        type: "scheduler.error",
        ts: Date.now(),
        payload: {
          scheduleId: schedule.id,
          phase: "dispatch",
          destChannel: schedule.destChannel,
          error: reason,
          willRetry,
          // 사용자 대면 통보용 additive 필드(2026-07-26) — 대시보드가 이걸로 "무엇이/어디로
          // 실패했나"를 사람이 읽을 수 있게 렌더한다. 종전엔 실패가 로그·DB·이벤트에만 남아
          // **사용자가 유실을 몰랐다**(아침 리포트 2건 실사고). scheduleId 만으론 무의미.
          label: schedule.label,
          destTarget: schedule.destTarget,
        },
      });
    }
  } finally {
    inFlight.delete(schedule.id);
  }
};
