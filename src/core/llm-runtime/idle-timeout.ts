/**
 * LLM 호출 유휴(idle)/첫토큰 타임아웃 — 어댑터 무관 공용 헬퍼.
 *
 * 진실 소스: `docs/decisions/2026-06-17-llm-idle-timeout.md` (architect contract
 * `_workspace/idle-timeout_architect.md`). 1층 = LLM 스트림(iteration)별 유휴 타임아웃.
 *
 * 동작(모든 어댑터 동일 = 층1 parity 하드게이트):
 *  - 마지막 스트림 이벤트 이후 `idleMs` 무수신 → abort.
 *  - 첫 이벤트까지 `firstMs` 무수신 → abort (연결 스톨 차단).
 *  - 토큰/이벤트가 *흐르는 한* (매 beat) 절대 abort 안 됨 — 총-시간 타임아웃 아님 (I-1).
 *  - abort 는 `AbortController` 경로로만 전파 — SDK/fetch 의 `signal` 이 스트림을 throw.
 *  - 타이머는 단일 `setTimeout` 을 `beat()` 마다 reset. `done()` 으로 누수 0 (I-6).
 *
 * heartbeat 호출 지점은 어댑터별 native (codex reader.read / claude for-await /
 * openai stream event) — 스트림 모양 차이라 native 가 정답 (층2). 타이머 로직은 이
 * 헬퍼 1곳뿐 — `if (adapter === …)` 분기 0.
 */

/** env 양의 정수 파싱 (양수 정수만, 아니면 fallback). 어댑터들과 동일 정책. */
const parsePosIntEnv = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

// ── 값 상수 (architect §3.5, 보수적 — 정상 느린 호출 안전 최우선) ──────────────
// 매직넘버 금지: 상수 + env override. 오설정 방어용 하한 가드(§3.5 ⚠) 적용.

/** idle 타임아웃 하한(ms) — 비상식적 저값(오설정) 무시. */
const MIN_IDLE_MS = 10_000;
/** first 타임아웃 하한(ms) — idle 보다 넉넉해야 하므로 동일 하한 이상이면 통과. */
const MIN_FIRST_MS = 10_000;

const resolveIdleMs = (): number => {
  const v = parsePosIntEnv(process.env.LLM_IDLE_TIMEOUT_MS, 90_000);
  // 하한 가드 — 환경변수가 비상식적으로 작으면 기본값으로 방어(설정 파싱 boundary).
  return v < MIN_IDLE_MS ? 90_000 : v;
};

const resolveFirstMs = (): number => {
  const v = parsePosIntEnv(process.env.LLM_FIRST_TIMEOUT_MS, 120_000);
  return v < MIN_FIRST_MS ? 120_000 : v;
};

/** 마지막 이벤트 이후 무수신 한계 (ms). env `LLM_IDLE_TIMEOUT_MS` override. */
export const LLM_IDLE_TIMEOUT_MS = resolveIdleMs();
/** 첫 이벤트까지 무수신 한계 (ms). env `LLM_FIRST_TIMEOUT_MS` override. */
export const LLM_FIRST_TIMEOUT_MS = resolveFirstMs();

export interface IdleTimeoutConfig {
  /** 마지막 이벤트 이후 무수신 한계 (ms). */
  idleMs: number;
  /** 첫 이벤트까지 무수신 한계 (ms). */
  firstMs: number;
}

/** 기본 설정 — 어댑터가 그대로 사용 (세 어댑터 동일 = 층1 parity I-2). */
export const IDLE_TIMEOUT_CONFIG: IdleTimeoutConfig = {
  idleMs: LLM_IDLE_TIMEOUT_MS,
  firstMs: LLM_FIRST_TIMEOUT_MS,
};

// ── 입력 크기 비례 first 타임아웃 (resume 없는 어댑터의 큰 재전송 가드) ─────────────
// codex 처럼 resume API 가 없어 매 턴 *전체 히스토리를 재전송* 하는 어댑터는 입력이
// 클수록 첫 토큰(TTFT)이 느리다. 고정 firstMs 면 큰 프리필이 정상인데도 오발화 →
// 본 헬퍼가 입력(payload) 크기에 비례해 first 한계만 늘린다. idle 은 불변(흐르기
// 시작하면 동일). 상한으로 무한대기 방지 — turn wall-clock 백스톱이 최종 상한.
// claude 는 SDK resume(증분)이라 호출 안 함(불필요 = parity 비대칭 아님, 결함 보정).
const FIRST_EXTRA_PER_10K_CHARS_MS = 2_000; // payload 10K자당 +2s.
const FIRST_MAX_MS = 300_000; // first 상한(5분) — 그 위는 turn 백스톱 영역.

/** payload 문자수 → 비례 확장된 first 타임아웃(ms). base 이하로는 안 줄어듦. */
export const firstTimeoutForInput = (inputChars: number): number => {
  const extra =
    Math.floor(Math.max(0, inputChars) / 10_000) * FIRST_EXTRA_PER_10K_CHARS_MS;
  return Math.min(LLM_FIRST_TIMEOUT_MS + extra, FIRST_MAX_MS);
};

/** 입력 크기 비례 first + 기본 idle 의 설정. resume 없는 어댑터(codex)가 사용. */
export const idleConfigForInput = (inputChars: number): IdleTimeoutConfig => ({
  idleMs: LLM_IDLE_TIMEOUT_MS,
  firstMs: firstTimeoutForInput(inputChars),
});

/**
 * 유휴/첫토큰 타임아웃 에러.
 *
 * 핵심 불변식 (I-3): 이 에러의 message 는 facade `MODEL_REJECTED_PATTERNS`
 * (index.ts:60-80) 어느 정규식과도 매칭되면 안 된다 — 타임아웃은 *모델 거부 아님*
 * (일시적 행). 매칭 시 멀쩡한 override 모델이 깨진 것으로 제거됨. 메시지에 "모델 거부
 * 아님" 토큰을 박아 진단 가독성↑ + 비매칭 (§4.2 교차검증: not_found/404/"model:" 0개).
 */
export class IdleTimeoutError extends Error {
  /** "idle" (이벤트 흐르다 끊김) 또는 "first" (첫 이벤트 무수신). */
  readonly reason: "idle" | "first";
  /** 무수신 한계 (ms) — 진단용. */
  readonly timeoutMs: number;

  constructor(reason: "idle" | "first", timeoutMs: number) {
    // ⚠ 이 메시지 문자열은 isModelRejected 비매칭 보장의 일부 — 변경 시 G2 테스트 동반.
    super(
      `LLM 응답 유휴 타임아웃 (${reason}, ${timeoutMs}ms 무수신) — 모델 거부 아님`,
    );
    this.name = "IdleTimeoutError";
    this.reason = reason;
    this.timeoutMs = timeoutMs;
  }
}

/** 어댑터가 스트림 소비를 감싸는 핸들. */
export interface IdleTimer {
  /**
   * 스트림 이벤트/토큰 수신마다 호출 — 타이머 리셋.
   * 첫 호출 시 first→idle 전환. `done()` 이후 호출은 no-op (안전).
   */
  beat(): void;
  /**
   * 스트림 정상 종료/throw 시 호출 — 타이머 해제 (누수 0). 반드시 `finally` 에서.
   * 멱등 — 여러 번 호출해도 안전.
   */
  done(): void;
}

/**
 * AbortController 와 묶인 idle/first 타이머 생성.
 *
 * 만료 시 헬퍼가 `ac.abort(new IdleTimeoutError(...))` 를 직접 수행 — 어댑터는
 * `signal: ac.signal` 주입 + `beat()`/`done()` 호출만 하면 된다 (단순한 쪽 택1, §3.2).
 * abort reason 으로 IdleTimeoutError 를 전달 → 어댑터가 `signal.reason` 으로 명시
 * throw 승격 가능 (claude 의 "조용한 종결" 케이스 §2.2).
 *
 * 타이머는 시작 즉시 first 한계로 무장 — 첫 `beat()` 가 오기 전 firstMs 동안 무수신이면
 * abort. 첫 `beat()` 이후로는 idleMs 한계로 매 beat reset.
 */
export const createIdleTimer = (
  ac: AbortController,
  cfg: IdleTimeoutConfig = IDLE_TIMEOUT_CONFIG,
): IdleTimer => {
  let handle: ReturnType<typeof setTimeout> | undefined;
  let sawFirst = false;
  let finished = false;

  const fire = (reason: "idle" | "first", ms: number): void => {
    if (finished) return;
    finished = true;
    // 이미 abort 된 경우(외부 취소 등) 중복 abort 무해 — IdleTimeoutError 만 박지 않음.
    if (!ac.signal.aborted) {
      ac.abort(new IdleTimeoutError(reason, ms));
    }
  };

  const arm = (reason: "idle" | "first", ms: number): void => {
    if (handle !== undefined) clearTimeout(handle);
    handle = setTimeout(() => fire(reason, ms), ms);
    // 데몬 메인 루프가 타이머 때문에 살아있을 필요 없음 — 다른 작업이 끝나면 프로세스
    // 종료를 막지 않게 unref (Node 환경 한정 메서드, 가드).
    (handle as { unref?: () => void }).unref?.();
  };

  const clear = (): void => {
    if (handle !== undefined) {
      clearTimeout(handle);
      handle = undefined;
    }
  };

  // 시작 즉시 first 한계 무장 (첫 이벤트 무수신 차단).
  arm("first", cfg.firstMs);

  return {
    beat(): void {
      if (finished) return;
      if (!sawFirst) sawFirst = true;
      // 매 이벤트 = idle 한계로 reset (단일 setTimeout reset 패턴).
      arm("idle", cfg.idleMs);
    },
    done(): void {
      finished = true;
      clear();
    },
  };
};
