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

/**
 * `setTimeout` 상한 — 넘으면 32비트로 접혀 **1ms 에 즉시 발화**한다(즉, "아주 긴 대기" 로
 * 설정한 값이 "대기 없음" 이 된다). 잡 타이머 세 곳에서 같은 함정을 닫았는데(2026-08-23)
 * env 경로만 열려 있었다. `IDLE_DISABLED_MS` 를 일부러 2^31-1 밑에 잡아둔 것이 이 자리가
 * 함정을 안다는 증거다.
 *
 * ★도달 범위는 좁다 — 정직하게 적는다(2026-08-23 3라운드 ⑦: 처음엔 "모든 턴이 1ms 에
 *  죽는다" 고 썼는데 **틀렸다**). 세 어댑터는 턴 타이머를 `idleConfigExempt(...)` 로 감싸
 *  env 값이 거기까지 안 간다. 실제 도달처는 `openai-codex-oauth-history.ts` 의
 *  `createIdleTimer(ac)`(기본 cfg) 하나 — codex 히스토리 압축 요약 호출이다. 그래서
 *  오설정 시 증상은 "모든 턴 사망" 이 아니라 **압축 영구 실패**(조용하다)다.
 */
const MAX_TIMER_MS = 2_147_483_647;

const resolveIdleMs = (): number => {
  const v = parsePosIntEnv(process.env.LLM_IDLE_TIMEOUT_MS, 90_000);
  // 하한 가드 — 환경변수가 비상식적으로 작으면 기본값으로 방어(설정 파싱 boundary).
  if (v < MIN_IDLE_MS) return 90_000;
  return Math.min(v, MAX_TIMER_MS); // 상한 — 32비트 접힘 = 즉시 발화 방지.
};

const resolveFirstMs = (): number => {
  const v = parsePosIntEnv(process.env.LLM_FIRST_TIMEOUT_MS, 120_000);
  if (v < MIN_FIRST_MS) return 120_000;
  return Math.min(v, MAX_TIMER_MS);
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

// 입력 크기 비례 first 타임아웃(idleConfigForInput/firstTimeoutForInput)은 전 턴
// idle/first 면제(아래, 2026-06-24) 도입으로 제거됨 — codex 의 큰 프리필 느린 TTFT 도
// 더는 컷되지 않으니 비례 확장이 무의미. 입력-비례 가드의 역할은 면제가 통째로 흡수했다.

// ── 전 턴 idle/first 면제 (메인·서브에이전트·매니저 동형) ─────────────────────────
// 1층 idle/first 타임아웃은 본래 *인터랙티브* 턴 가정의 산물이었다(사용자 대기 →
// 90s 무이벤트면 끊는 게 옳다는 발상). 그러나 실측(라이브 대화, 2026-06-24)에서
// 메인 비서 턴이 100s~170s 짜리 *정상 Bash* 실행 중 idle(90s) 연속 오발화로
// 응답을 유실했다. idle heartbeat 는 SDK 메시지 도착마다 beat() 인데, 긴 Bash(도구
// 실행) 동안 SDK 메시지가 0이라 흐르는 작업인데도 90s 에 컷된다 — false-kill.
//
// 사용자 확정 결정(A안): 메인(workerDepth 0)·서브에이전트도 매니저와 동형으로 idle/first
// 면제. 따라서 1층 idle/first 는 *어떤 비서 턴도* 끊지 않는다. 매니저가 이미 면제였고
// (예: 712개 API 단일 Bash), 그 논리는 메인/서브에이전트에도 그대로 성립한다 —
// "진행 중 작업을 임의 시간으로 컷하지 않는다"는 사용자 원칙.
//
// 회복 경로는 그대로 보존: 진짜 API 먹통은 /restart 아웃오브밴드·cancel_worker·외부
// turn signal(linkAbort) 로 수동 회복하고, 매니저는 2층 WORKER_TIMEOUT_MS(30분 wall-clock,
// abortSignal 경로)가 hung 백스톱을 별도로 건다. 면제는 1층(idle/first)만이다.
//
// 왜 #2(어댑터별 특수분기 금지)에 안 걸리나: 이 함수는 입력 속성(workerDepth)·어댑터
// 종류와 무관하게 *동일한 면제 cfg* 를 반환한다 — 세 어댑터가 동일 헬퍼를 동일하게
// 호출 → LLM-agnostic·parity 유지. 분기 자체가 사라져 비대칭 여지도 0이다.
//
// 구현 선택(옵션1): createIdleTimer 기계는 그대로 두고(2층 linkAbort 가 idleAc 를
// 구조적으로 필요로 함), 단일 초크포인트인 이 함수가 *항상* 사실상-무제한 cfg 를
// 반환한다. 타이머는 ~24.8일에 무장되어 어떤 실제 턴에서도 발화하지 않는다(비활성).
// base/LLM_*_TIMEOUT_MS 상수는 2층 MIN_TURN_MS 하한 가드 계산에 쓰이므로 유지하되,
// 라이브 턴에는 더 이상 도달하지 않는다.

/** idle/first 면제용 사실상-무제한 한계(ms). setTimeout 32-bit 상한 미만으로 안전(~24.8일). */
const IDLE_DISABLED_MS = 2_147_400_000;

/**
 * 전 턴 idle/first 면제 설정.
 *
 * 메인(workerDepth 0)·서브에이전트·매니저 모두 동일하게 idle/first 사실상 무제한(비활성).
 * workerDepth/base 는 시그니처 호환을 위해 받지만 면제 결과는 동일 — 어떤 비서 작업도
 * 1층 idle/first 로 끊기지 않는다. hung 회복은 매니저 2층 WORKER_TIMEOUT_MS 와
 * /restart·cancel·외부 turn signal 이 담당한다.
 *
 * 세 어댑터가 createIdleTimer 직전 이 함수로 cfg 를 감싼다 → 단일 정책·parity.
 */
export const idleConfigExempt = (
  _workerDepth?: number | undefined,
  _base: IdleTimeoutConfig = IDLE_TIMEOUT_CONFIG,
): IdleTimeoutConfig => ({
  idleMs: IDLE_DISABLED_MS,
  firstMs: IDLE_DISABLED_MS,
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
