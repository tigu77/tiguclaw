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
import type { TriggerRun } from "../../../src/core/llm-runtime/types.js";
import type { ScheduleRow } from "../../../src/store/schedules.js";
import { deleteSchedule, getSchedule, isTimer, recordScheduleRun, scheduleRunTimes, updateSchedule } from "../../../src/store/schedules.js";
import { loadSchedulerRetryEnabled } from "../../../src/core/settings.js";
import { dispatch } from "./dispatcher.js";
import { canonicalSessionChannel } from "../../../src/store/sessions.js";
import { applyRunHistory } from "../../../src/store/thread-reset.js";
import { enqueueThreadTurn } from "../../../src/core/worker-jobs.js";
import { isUserCancelled } from "../../../src/core/steering.js";
import { translate } from "../../../src/core/i18n.js";

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
    triggerRun?: TriggerRun;
    /** 만든 대화 — 있으면 파사드가 그 대화의 줄에 넣는다(`runTriggerInSession`, 감시와 같은 문). null·없음 = 전용 세션. */
    originThreadKey?: string | null;
    /**
     * 실행기가 발화마다 만든 칸 — 파사드가 차례에서 **실제로 쓴 행의 `runAt`** 을 적는다(2026-10-23 §3.9-b). 정산하는 모든 자리가 이 칸을 읽는다
     *  (반환값에 실으면 핸들러가 던질 때 사라진다). 비면 발화 시점 값.
     */
    slot?: { firedRunAt: number | null; turnRunAt?: number | null };
  }) => Promise<{
    text: string;
    /** 만든 대화 실행이 차례에서 건너뛰었다 — 지워짐·꺼짐·처리 자리 바뀜·대화 없음·예정 시각이 미래로 바뀜. */
    skipped?: "deleted" | "disabled" | "moved" | "origin-gone" | "not-run" | "rescheduled";
    /** 만든 대화에서 처리됐다 — 답은 이미 목적지로 나갔다(여기서 다시 보내지 않는다). */
    inOrigin?: { replied: number; failed?: string; dest?: { channel: string; target: string | null } };
  }>;
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
/** 줄에서 기다리는 사이 스케줄이 꺼지거나 지워졌다 — 발화하지 않는다. */
const SKIPPED_IN_QUEUE = Symbol("skipped-in-queue");
/** 줄에서 기다리는 사이 처리 자리가 바뀌었다(`move_here`) — 이 줄에선 안 돌리고 새 자리에서 다시 한 번. */
const MOVED_IN_QUEUE = Symbol("moved-in-queue");

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
        // ★★**발송 직전에 최신 상태를 본다** (2026-09-14, 외부 검토). 종전엔 최신 행을
        //  조회해놓고 **존재 여부만** 보고, 실제 발송은 타이머 closure 의 **옛 스냅샷**으로
        //  했다 — 그래서 5분 사이에 사용자가 스케줄을 **끄거나 목적지를 바꿔도** 옛 주소로
        //  다시 나갔다. 조회한 값을 안 쓰는 코드는 «확인했다» 처럼 보여서 더 나쁘다.
        const current = getSchedule(schedule.id);
        if (current === undefined) {
          console.log(`[scheduler:${schedule.id}] '${schedule.label}' 자동 재전송 취소 — 스케줄이 삭제됨`);
          return;
        }
        // ★타이머는 실패하면 실행기가 **꺼 둔 채 남긴다**(아래 runScheduleFiring finally) — 그 «꺼짐» 은 사용자의 뜻이 아니라 재전송을 기다리는 표식이다.
        //  종전엔 실행기가 행을 지워 «스케줄이 삭제됨» 으로 재전송이 스스로 취소됐다(적대 검토 10-20 #1 — willRetry:true 를 알리고 아무것도 안 보냄).
        if (!current.enabled && !isTimer(current)) {
          console.log(`[scheduler:${schedule.id}] '${current.label}' 자동 재전송 취소 — 스케줄이 비활성화됨`);
          return;
        }
        // ★**목적지가 바뀌었으면 대기 중 발송을 취소한다**(정태님 확정 2026-09-14).
        //  옛 목적지 재전송은 금지이고, 새 목적지는 **다음 정기 실행부터** 쓴다 — 이 원문은
        //  옛 수신자를 향해 만들어진 것이라 새 수신자에게 보낼 근거가 없다.
        //  ★원문은 지우지 않는다(발송 취소와 기록 삭제는 별개다).
        if (
          current.destChannel !== schedule.destChannel ||
          current.destTarget !== schedule.destTarget
        ) {
          console.log(
            `[scheduler:${schedule.id}] '${current.label}' 자동 재전송 취소 — 목적지가 바뀌었다` +
              ` (${schedule.destChannel}/${schedule.destTarget ?? "—"} → ${current.destChannel}/${current.destTarget ?? "—"}).` +
              ` 새 목적지는 다음 정기 실행부터 쓴다.`,
          );
          return;
        }
        const dispatchFn = deps.dispatch ?? dispatch;
        await dispatchFn({
          scheduleId: schedule.id,
          // 최신 행의 값을 쓴다 — 위에서 같음을 확인했으므로 값은 같고, **읽은 것을 쓴다**는
          // 사실이 코드에 남는다(스냅샷을 다시 집으면 같은 병이 조용히 돌아온다).
          destChannel: current.destChannel,
          destTarget: current.destTarget,
          text,
          bus,
        });
        deps.recordFiring(schedule.id, { ok: true });
        console.log(
          `[scheduler:${schedule.id}] '${schedule.label}' 자동 재전송 성공 (전달 복구)`,
        );
        // 되살렸다 — 타이머는 이제 끝났다(실패라 남겨 두었던 행을 지운다).
        if (isTimer(current) && deleteSchedule(schedule.id)) console.log(`[scheduler:${schedule.id}] 타이머 '${schedule.label}' 재전송으로 끝남 — 지웠다`);
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
          error: `dispatch (retry failed): ${reason}`,
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
  /** `lateFrom` = 데몬이 꺼져 있어 놓친 원래 시각(보충 실행) — 맥락 줄이 «늦게 실행» 을 싣는다. `refired` = 옮겨져 다시 도는 한 번(두 번째 «옮겨짐» 이면 멈춘다). */
  opts?: { lateFrom?: number; refired?: true },
): Promise<void> => {
  if (inFlight.has(schedule.id)) {
    // contract §6 overlap = 합침. 앞 실행이 아직 줄에 있거나 도는 중이라 이번 시각은 그 실행이 맡는다 — 실패가 아니다(last_* 무변).
    console.log(
      `[scheduler:${schedule.id}] 합침 — 앞 실행이 아직 줄에 있거나 도는 중이라 이번 시각은 그 실행이 맡는다`,
    );
    return;
  }
  inFlight.add(schedule.id);
  // ★한 번 타이머는 울린 뒤 지운다(성공·실패 모두 — 설계 §2.3). 예외: 처리 자리가 바뀌어 새 자리에서 다시 도는 경우.
  const once = isTimer(schedule);
  let refire = false;
  // ★타이머의 끝 — 기록한 결과가 정한다(2026-10-20 적대 검토 #2·#8). 성공 = 지운다 · 실패 = **꺼 둔 채 남긴다**(자가 진단이 last_status 로 알리고,
  //  사용자가 패널·`/schedule` 에서 지운다 — 지우면 실패가 아무 데도 안 남았다) · 기록 없음(꺼짐·지워짐·종료 중이라 안 돎) = 그대로 둔다.
  let settle: "done" | "failed" | null = null;
  const record = (r: { ok: boolean; error?: string }): void => {
    deps.recordFiring(schedule.id, r);
    settle = r.ok ? "done" : "failed";
  };
  // ★타이머가 **실행 도중 바뀌었나** (2026-10-23 한도 자동 이어가기 §3.9-b) — 지워졌거나 `runAt` 이 이 실행이 쓴 값과 다르면 그 행은 바꾼 쪽 몫이다.
  //  기준값 = 차례에서 실제로 쓴 `runAt`(파사드가 칸에 적는다), 턴이 안 돌았으면 발화 시점 값. 실행기는 «이게 무슨 타이머인가» 를 모른다.
  const firedRunAt = schedule.runAt;
  const slot: { firedRunAt: number | null; turnRunAt?: number | null } = { firedRunAt };
  const changedDuringRun = (): boolean => {
    if (!once) return false;
    const cur = getSchedule(schedule.id);
    if (cur === undefined) return true;
    return cur.runAt !== (slot.turnRunAt !== undefined ? slot.turnRunAt : firedRunAt);
  };
  const triggerRun: TriggerRun = {
    kind: "schedule",
    id: schedule.id,
    ...(once ? { once: true as const } : {}),
    ...(opts?.lateFrom !== undefined ? { lateFrom: opts.lateFrom } : {}),
  };
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
        record({ ok: false, error: "The text to send after !say is empty" });
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
        });
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        record({ ok: false, error: `dispatch: ${reason}` });
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
      record({ ok: true });
      console.log(
        `[scheduler:${schedule.id}] '${schedule.label}' 직송(LLM 미경유) — ${text.length}자.`,
      );
      return;
    }

    // ★만든 대화에서 처리한다 (2026-10-20) — 감시와 같은 문(`runTriggerInSession`, 파사드가 부른다). 줄·차례 확인·답 배달은 그쪽이 하고,
    //  이력 정책은 쓰지 않는다(사람 대화를 스케줄이 잘라 낼 수 없다 — 도구가 같이 못 주게 막는다).
    const fresh = getSchedule(schedule.id) ?? schedule;
    if (fresh.originThreadKey !== null) {
      const origin = fresh.originThreadKey;
      const tag = `[scheduler:${schedule.id}] '${fresh.label}'`;
      try {
        const out = await deps.runClaude({
          text: fresh.prompt,
          threadKey: origin,
          channel: "scheduler",
          cwd: deps.cwd,
          triggerRun,
          notifyDest: { channel: fresh.destChannel, target: fresh.destTarget },
          originThreadKey: origin,
          slot,
        });
        if (out.skipped === "moved") {
          refire = true;
          console.log(`${tag} 차례를 기다리는 사이 처리 자리가 바뀜 — 새 자리에서 다시 한 번`);
          return;
        }
        if (out.skipped === "origin-gone") {
          const error = translate("srv.schedule.originGone", { origin });
          console.error(`${tag} ${error}`);
          record({ ok: false, error });
          bus.publish({ type: "scheduler.error", ts: Date.now(), payload: { scheduleId: schedule.id, phase: "origin", error, label: fresh.label, destTarget: fresh.destTarget, willRetry: false } });
          return;
        }
        if (out.skipped === "not-run") {
          // 데몬 종료 중이라 차례가 안 왔다 — 실행도 실패도 아니다. 기록하지 않는다(타이머는 남아 다음 부팅에 늦게 운다).
          console.log(`${tag} 차례가 오기 전에 끝남(데몬 종료 중) — 기록하지 않음`);
          return;
        }
        if (out.skipped === "rescheduled") {
          // 기록하지 않는다(«안 돎» — 지워짐·꺼짐과 같은 갈래). 새 시각에 다시 거는 것은 아래 finally(«실행 도중 바뀜»)가 한다.
          console.log(`${tag} 줄에서 기다리는 사이 예정 시각이 뒤로 밀림 — 이번 차례엔 돌지 않고 새 시각에 다시 건다`);
          return;
        }
        if (out.skipped !== undefined) {
          console.log(`${tag} 줄에서 기다리는 사이 ${out.skipped === "deleted" ? "지워짐" : "꺼짐"} — 발화하지 않음`);
          return;
        }
        // 실행 도중 바뀐 타이머는 정산하지 않는다 — 실패 기록·`scheduler.error`·성공 기록·`scheduler.fired` 전부(§3.9-b). 다시 걸기는 finally.
        if (changedDuringRun()) {
          console.log(`${tag} 실행 도중 타이머가 바뀌거나 지워짐 — 결과를 정산하지 않는다(바꾼 쪽 몫)`);
          return;
        }
        // 기록·로그의 목적지 = 그 실행이 **실제로 쓴** 값(차례에서 확정) — 넣기 전 스냅샷(`fresh`)은 그새 바뀌었을 수 있다(아스트라 재검토 10-20).
        const used = out.inOrigin?.dest ?? { channel: fresh.destChannel, target: fresh.destTarget };
        const failed = out.inOrigin?.failed;
        if (failed !== undefined) {
          console.error(`${tag} 만든 대화(${origin})에서 실패: ${failed.slice(0, 200)}`);
          record({ ok: false, error: `runClaude: ${failed.slice(0, 500)}` });
          bus.publish({ type: "scheduler.error", ts: Date.now(), payload: { scheduleId: schedule.id, phase: "runClaude", error: failed.slice(0, 500), label: fresh.label, destChannel: used.channel, destTarget: used.target, willRetry: false } });
          return;
        }
        console.log(`${tag} 만든 대화(${origin})에서 처리 · 답 ${out.inOrigin?.replied ?? 0}자 → ${used.channel}:${used.target ?? "-"}`);
        record({ ok: true });
        bus.publish({ type: "scheduler.fired", ts: Date.now(), payload: { scheduleId: schedule.id, destChannel: used.channel, destTarget: used.target, ok: true } });
      } catch (e) {
        if (changedDuringRun()) {
          console.log(`${tag} 실행 도중 타이머가 바뀌거나 지워짐 — 결과를 정산하지 않는다(바꾼 쪽 몫)`);
          return;
        }
        if (isUserCancelled(e)) {
          console.log(`${tag} 사용자 중지(/stop) — 실패로 기록하지 않음`);
          settle = "done"; // 멈춘 타이머는 끝난 것이다(남기면 다음 부팅에 다시 운다)
          return;
        }
        // 답 배달 실패도 여기로 온다(`runTriggerInSession` 이 던진다) — 그 대화엔 이미 답이 남았고, 자동 재전송은 하지 않는다(답은 대화 턴이 낸 것).
        const reason = e instanceof Error ? e.message : String(e);
        console.error(`${tag} 만든 대화(${origin}) 실행 실패: ${reason}`);
        record({ ok: false, error: `origin: ${reason}` });
        bus.publish({ type: "scheduler.error", ts: Date.now(), payload: { scheduleId: schedule.id, phase: "origin", error: reason, label: fresh.label, destTarget: fresh.destTarget, willRetry: false } });
      }
      return;
    }

    // ★이력 정책·발화 시각·모델 실행을 **스레드 줄 안에서 한 번에** 한다 (2026-10-14 적대 검토 P3).
    //  줄은 같은 스레드의 앞 턴(완료 재주입·선택지 답)이 끝날 때까지 기다리게 한다(`external-turn.ts` — 동시에 돌던 사고).
    //  그런데 정책을 줄 **밖**에서 먼저 적용하면, 앞 턴이 끝나며 이어가기(세션 해시)를 되살려 «매번 새로» 가 사라지고
    //  발화 시각도 «줄에 선 시각» 이 된다 — 실측 재현. `/clear` 가 줄 안에 있는 것과 같은 이유다.
    //  ★줄은 여기서 **한 번만** 선다 — 기본 실행기(`index.ts`)는 진행 중 등록만 한다(같은 스레드에 두 번 서면 교착).
    // ★이력 정책 (2026-09-26) — 발화 **직전**에 적용한다. 기본(null)은 종전대로 이어간다.
    //  매일 도는 스케줄이 이력을 계속 들고 가 첫 요청이 18만→29만 토큰으로 불었고, 하루 간격이라
    //  캐시도 못 탔다. 정책을 못 적용해도 발화는 한다(이력이 길 뿐 결과는 나간다).
    const applyHistory = (): void => {
      const tk = `scheduler:${schedule.id}`;
      try {
        const applied = applyRunHistory(
          canonicalSessionChannel(tk, "scheduler"),
          tk,
          schedule.prompt,
          // 발화 때 새로 읽는다 — cron 콜백은 등록 시점의 행을 붙잡고 있어, 도구를 안 거친 변경이
          //  재시작 전까지 안 보였다(설정=데이터는 매번 새로 읽는다).
          (getSchedule(schedule.id) ?? schedule).keepRuns,
          Date.now(),
          (limit) => scheduleRunTimes(schedule.id, limit),
        );
        if (applied !== null) {
          console.log(
            `[scheduler:${schedule.id}] 이력 정책 적용 — ` +
              (applied.source === "fresh"
                ? `매번 새로 — 경계 ${new Date(applied.boundary).toISOString()} 이전을 끊음`
                : `직전 ${applied.kept}회만 남기고 경계 ${new Date(applied.boundary).toISOString()} 이전을 끊음` +
                  ` (발화 시각 출처: ${applied.source === "log" ? "발화 기록" : "프롬프트 일치 — 기록이 아직 모자람"})`),
          );
        }
      } catch (e) {
        console.warn(
          `[scheduler:${schedule.id}] 이력 정책 적용 실패 — 이어서 발화합니다: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    };
    let firedAt = Date.now();
    try {
      const out = await enqueueThreadTurn(`scheduler:${schedule.id}`, async () => {
        // ★줄에서 기다리는 사이 스케줄이 꺼지거나 지워지거나 목적지가 바뀔 수 있다 (2026-10-14 재검토 P2) — **줄 안에서 최신
        //  행을 다시 읽는다**. 옛 행으로 돌면 끈 스케줄이 돌고, 바꾼 목적지가 아니라 옛 목적지로 간다(재전송의 09-14 규칙과 같은 병).
        const latest = getSchedule(schedule.id);
        if (latest === undefined || latest.enabled === false) return SKIPPED_IN_QUEUE;
        // 그새 «이 대화로 옮겨 줘» 를 받았다 — 이 전용 세션에서 돌리지 않고 새 자리에서 다시 한 번.
        if (latest.originThreadKey !== null) return MOVED_IN_QUEUE;
        Object.assign(schedule, { destChannel: latest.destChannel, destTarget: latest.destTarget, label: latest.label, prompt: latest.prompt });
        applyHistory();
        // 발화 시작 시각 — 대화가 남으면 발화 기록에 이 시각으로 적는다(«직전 N회» 경계가 이 실행을 통째로 품게).
        firedAt = Date.now();
        return deps.runClaude({
          text: schedule.prompt,
          threadKey: `scheduler:${schedule.id}`,
          channel: "scheduler",
          cwd: deps.cwd,
          // 이 턴이 스케줄 발화 **그 자체**임을 싣는다 — 같은 세션의 완료 턴·선택지 답과 가르는 유일한 자리다.
          triggerRun,
          // 매니저 통지 dest 주입 — 이 발화가 띄운 매니저가 스케줄의 실제 목적지(예 telegram/
          // chatId)로 완료/실패를 통지하게 한다. channel="scheduler" 는 reacquireReply 가
          // 모르는 채널이라(폴백 시 통지 미도달) generic dest 를 데이터로 흘려보낸다.
          notifyDest: {
            channel: schedule.destChannel,
            target: schedule.destTarget,
          },
        });
      });
      if (out === MOVED_IN_QUEUE) {
        refire = true;
        console.log(`[scheduler:${schedule.id}] '${schedule.label}' 줄에서 기다리는 사이 처리 자리가 바뀜 — 새 자리에서 다시 한 번`);
        return;
      }
      if (out === SKIPPED_IN_QUEUE) {
        console.log(`[scheduler:${schedule.id}] '${schedule.label}' 줄에서 기다리는 사이 꺼지거나 지워짐 — 발화하지 않음`);
        return;
      }
      resultText = out.text;
      // ★대화가 남은 발화만 적는다 — 실패한 발화까지 세면 실제로 남는 대화가 N회보다 적어진다. 전달(dispatch) 실패와는
      //  무관하다(대화는 이미 남았다). 한계: Claude 는 실패한 발화도 SDK 기록에 남아 다음 턴에 색인될 수 있다 — 그때 창이
      //  N회보다 **커질** 뿐 줄지는 않는다(적대 검토 2026-09-28). 기록 실패가 발화·전달을 막지 않는다(다음은 프롬프트 일치로).
      if (resultText !== "") {
        try { recordScheduleRun(schedule.id, firedAt); } catch (e) {
          console.warn(`[scheduler:${schedule.id}] 발화 기록 실패 — 이력 정책은 프롬프트 일치로 대신합니다: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    } catch (e) {
      // ★사용자가 `/stop` 으로 멈춘 건 실패가 아니다 (2026-10-14 재검토 P2) — 런타임·핸들러가 지키는 규칙을 실행기도 지킨다.
      //  종전엔 «스케줄 실패» 로 기록돼 자가 진단이 «스케줄 '아침 뉴스' 실패 — user cancelled» 를 사용자에게 다시 보냈다.
      //  기록(last_*)은 건드리지 않는다 — 겹침 건너뛰기와 같다(«이번엔 안 돌았다» 지 실패가 아니다).
      if (isUserCancelled(e)) {
        console.log(`[scheduler:${schedule.id}] '${schedule.label}' 사용자 중지(/stop) — 실패로 기록하지 않음`);
        settle = "done"; // 멈춘 타이머는 끝난 것이다
        return;
      }
      const reason = e instanceof Error ? e.message : String(e);
      // 영구 로그에 스케줄 맥락과 함께 남긴다(EventBus·DB last_error 외 사후 grep 용).
      console.error(
        `[scheduler:${schedule.id}] '${schedule.label}' runClaude FAILED: ${reason}`,
      );
      record({ ok: false, error: `runClaude: ${reason}` });
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
        // 표시 세션은 dispatcher 가 목적지에서 정한다(`sessionOfDestination` — 대시보드 대화 목적지면 그 대화, 아니면 기본 세션).
      });
      record({ ok: true });
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
      record({
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
    // ★다시 도는 건 **한 번만** — 두 갈래의 판정이 어긋나면(한쪽은 «옮겨짐», 다른 쪽은 그 자리를 안 받음) 끝없이 돈다(변이 실측: 무한 재발화).
    if (refire && opts?.refired !== true) {
      const moved = getSchedule(schedule.id);
      if (moved !== undefined && moved.enabled) void runScheduleFiring(moved, bus, deps, { ...opts, refired: true });
    } else if (refire) {
      console.error(`[scheduler:${schedule.id}] '${schedule.label}' 옮긴 자리에서도 «옮겨짐» — 다시 돌지 않는다(이번 실행은 건너뜀)`);
      if (once) {
        try {
          deps.recordFiring(schedule.id, { ok: false, error: translate("srv.schedule.movedAgain") });
          updateSchedule(schedule.id, { enabled: false });
        } catch { /* 다음 부팅에 다시 본다 */ }
      }
    } else if (once && changedDuringRun()) {
      // ★실행 도중 바뀐 타이머 — 지우지도 끄지도 않는다. 남아 있고 켜져 있으면 **다시 건다**: 실행 중에 새 시각이 와 «합침» 으로 건너뛰어졌어도 잃지 않는다.
      const cur = getSchedule(schedule.id);
      console.log(`[scheduler:${schedule.id}] 타이머 '${schedule.label}' 실행 도중 ${cur === undefined ? "지워짐" : "바뀜"} — 정산하지 않음${cur !== undefined && cur.enabled ? " · 새 시각에 다시 건다" : ""}`);
      if (cur !== undefined && cur.enabled) {
        try { bus.publish({ type: "scheduler.toggle", ts: Date.now(), payload: { id: schedule.id, action: "enable" } }); } catch { /* 다음 부팅에 다시 걸린다 */ }
      }
    } else if (once && settle !== null) {
      // 지우기·끄기 실패가 실행 결과를 바꾸지 않는다.
      try {
        if (settle === "done") {
          if (deleteSchedule(schedule.id)) console.log(`[scheduler:${schedule.id}] 타이머 '${schedule.label}' 울림 — 지웠다`);
        } else {
          updateSchedule(schedule.id, { enabled: false });
          console.warn(`[scheduler:${schedule.id}] 타이머 '${schedule.label}' 실패 — 꺼 둔 채 남긴다(자가 진단이 알린다 · 패널·/schedule 에서 지운다)`);
        }
      } catch (e) {
        console.warn(`[scheduler:${schedule.id}] 타이머를 정리하지 못했다: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
};
