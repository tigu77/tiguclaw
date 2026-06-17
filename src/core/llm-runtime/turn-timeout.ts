/**
 * 2층 턴(turn) 타임아웃 — 어댑터 무관 공용 헬퍼.
 *
 * 진실 소스: architect contract `_workspace/turn-timeout_architect.md`
 * (불변식 TT-I1~I7). 2층 = 인바운드 메시지 1건 처리 전체(턴)에 대한 wall-clock 백스톱.
 *
 * 1층(idle-timeout)과의 관계 (§1, TT-I2 신호 합성):
 *  - 1층 = LLM 스트림(iteration)별 *유휴* 타임아웃 (heartbeat reset, 흐르면 무한정 살림).
 *  - 2층 = 턴 전체 *wall-clock* 백스톱 (흐르든 말든 상한 초과 시 abort). 도구 먹통
 *    (브라우저 무한대기·무한 Bash)처럼 1층이 못 잡는 잔여를 막는다.
 *  - 두 타이머는 같은 AbortController 를 공유하지 *않는다*(TT-I2). 각자 독립 생성 후
 *    어댑터가 `linkAbort` 로 OR 결합 → 1층 heartbeat reset 이 2층 wall-clock 에 영향 0.
 *
 * 거는 위치: 핸들러(턴 입구) 1지점에서 `createTurnTimer`. signal 은 route→runRegionA
 * →어댑터 `input.abortSignal` 로 운반. 어댑터는 자기 1층 idle AC 와 `linkAbort` 결합.
 */

/** env 양의 정수 파싱 (양수 정수만, 아니면 fallback). idle-timeout 과 동일 정책. */
const parsePosIntEnv = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

// ── 값 상수 (architect §7) ───────────────────────────────────────────────────
// 턴은 여러 LLM 호출 + 도구 누적이라 1층(개별 90/120s)보다 충분히 커야 정상 긴 작업을
// 안 죽인다. 8분 = 사용자 비서 맥락 "이건 확실히 먹통" 보수선. 매직넘버 금지 — 상수+env.

/** 기본 턴 타임아웃 (ms). */
const DEFAULT_TURN_MS = 480_000;

// 1층 한계와의 정합 — TT-I1: turnMs 는 max(firstMs, idleMs) 보다 항상 크게.
// idle-timeout 의 *해석된* 값을 import 해 하한 가드를 계산(오설정으로 2층이 1층보다
// 작아지면 1층이 무력화되므로 방어). idle-timeout 상수도 env override 를 이미 반영했다.
import {
  LLM_FIRST_TIMEOUT_MS,
  LLM_IDLE_TIMEOUT_MS,
} from "./idle-timeout.js";

/**
 * 턴 타임아웃 하한(ms) — TT-I1 강제. max(firstMs, idleMs) + 60s 이상이어야 1층이
 * 항상 먼저 터진다(정상 스트림에서 2층 오발화 방지). env 가 이 하한보다 작으면 기본값으로 방어.
 */
const MIN_TURN_MS =
  Math.max(LLM_FIRST_TIMEOUT_MS, LLM_IDLE_TIMEOUT_MS) + 60_000;

const resolveTurnMs = (): number => {
  const v = parsePosIntEnv(process.env.TURN_TIMEOUT_MS, DEFAULT_TURN_MS);
  // 하한 가드(TT-I1) — 1층보다 작아지면 1층 무력화 → 기본값으로 방어.
  return v < MIN_TURN_MS ? DEFAULT_TURN_MS : v;
};

/** 턴 전체 wall-clock 백스톱 한계 (ms). env `TURN_TIMEOUT_MS` override. */
export const TURN_TIMEOUT_MS = resolveTurnMs();

/**
 * 턴(turn) wall-clock 타임아웃 에러.
 *
 * 핵심 불변식 (TT-I3): 이 에러의 message 는 facade `MODEL_REJECTED_PATTERNS`
 * (index.ts:60-80) 어느 정규식과도 매칭되면 안 된다 — 턴 타임아웃은 *모델 거부 아님*.
 * 매칭 시 멀쩡한 override 모델이 깨진 것으로 제거되고 무의미한 풀 폴백을 탄다. 1층
 * IdleTimeoutError 와 동일하게 "모델 거부 아님" 토큰을 박아 비매칭 보장 + 진단 가독성↑.
 */
export class TurnTimeoutError extends Error {
  /** 백스톱 한계 (ms) — 진단용. */
  readonly timeoutMs: number;

  constructor(timeoutMs: number = TURN_TIMEOUT_MS) {
    // ⚠ 이 메시지 문자열은 isModelRejected 비매칭 보장의 일부 — 변경 시 검증 동반.
    super(
      `턴 처리 시간 초과 (${timeoutMs}ms wall-clock 백스톱) — 모델 거부 아님`,
    );
    this.name = "TurnTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/** 핸들러가 턴 처리를 감싸는 핸들. */
export interface TurnTimer {
  /**
   * 턴 정상 종료/throw 시 호출 — 타이머 해제 (누수 0, TT-I5). 반드시 `finally` 에서.
   * 멱등 — 여러 번 호출해도 안전. 1층 IdleTimer 와 달리 beat() 없음(총-시간 타임아웃).
   */
  done(): void;
}

/**
 * AbortController 와 묶인 턴 타이머 생성.
 *
 * 1층 `createIdleTimer` 와 동형의 단순 헬퍼(setTimeout + AbortController + done()),
 * 단 heartbeat(beat) 없음 — 총-시간이라 reset 안 한다. 만료 시 헬퍼가
 * `ac.abort(new TurnTimeoutError(ms))` 를 직접 수행 → 어댑터가 `signal.reason` 으로
 * 명시 throw 승격. 핸들러는 ac.signal 을 route 로 운반 + `done()` 만 호출하면 된다.
 */
export const createTurnTimer = (
  ac: AbortController,
  ms: number = TURN_TIMEOUT_MS,
): TurnTimer => {
  const handle = setTimeout(() => {
    // 이미 abort 된 경우(외부 취소 등) 중복 abort 무해 — TurnTimeoutError 만 박지 않음.
    if (!ac.signal.aborted) ac.abort(new TurnTimeoutError(ms));
  }, ms);
  // 데몬 메인 루프가 타이머 때문에 살아있을 필요 없음 — unref (Node 한정, 가드).
  (handle as { unref?: () => void }).unref?.();
  return {
    done(): void {
      clearTimeout(handle);
    },
  };
};

/**
 * 여러 AbortSignal 을 OR 결합 (TT-I2 신호 합성).
 *
 * 하나라도 abort 되면 반환 AC 가 abort 되고, **그 signal 의 reason 을 보존**한다
 * (1층 IdleTimeoutError / 2층 TurnTimeoutError 구분 → 어댑터가 정확한 에러 throw).
 * 입력 signal 들은 *공유되지 않은* 독립 AC 의 signal 이어야 한다(공유 금지, TT-I2) —
 * 본 함수는 새 AC 를 만들어 link 만 한다.
 *
 * `undefined` 인자는 무시 — `abortSignal` 미지정 turn 은 idle AC 만 link → 현행
 * 1층-only 동작 그대로(회귀 0, TT-I7).
 *
 * `AbortSignal.any([...])` 미사용 이유: Node 20+ 에서만 안정. 명시 헬퍼가 reason
 * 보존·하위호환·테스트 용이.
 */
export const linkAbort = (
  ...signals: (AbortSignal | undefined)[]
): AbortController => {
  const ac = new AbortController();
  for (const s of signals) {
    if (s === undefined) continue;
    if (s.aborted) {
      // 이미 터진 signal — reason 보존하며 즉시 abort, 더 link 안 함.
      if (!ac.signal.aborted) ac.abort(s.reason);
      break;
    }
    s.addEventListener(
      "abort",
      () => {
        if (!ac.signal.aborted) ac.abort(s.reason);
      },
      { once: true },
    );
  }
  return ac;
};
