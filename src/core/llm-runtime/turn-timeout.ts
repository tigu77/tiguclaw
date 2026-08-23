/**
 * 턴 경계 헬퍼 — **abort 신호 합성**과 그 사유 타입.
 *
 * ★2층 턴 wall-clock 은 **폐기됐다**(2026-06-23). 정상적으로 긴 작업을 시계로 잘랐기
 *  때문이다 — 상한에 걸린 작업은 "멈춘 것" 이 아니라 "돌고 있었는데 잘린 것" 이라
 *  되돌릴 수 없다. 잡(매니저·서브에이전트)의 시계도 같은 이유로 2026-08-22 에 kill 에서
 *  **점검**(`JOB_CHECKIN_INTERVAL_MS`)으로 뒤집혔다.
 *
 * ★2026-08-23: 그때 함께 죽은 코드(`createTurnTimer`·`TURN_TIMEOUT_MS`·하한 가드)를
 *  걷어냈다. 프로덕션 소비처가 0인데 **고정 시계 방식의 본보기**로 남아 있었다 — 다음
 *  사람이 그걸 참고하면 폐기한 설계가 되살아난다. 시간 기반 이상 점검은 고정 시계가
 *  아니라 **마지막 활동**을 기준으로 잡는다(사용자 원칙, 2026-08-23).
 *
 * 여기 남은 것:
 *  - `TurnTimeoutError` — abort 사유 타입. 어댑터가 `signal.reason` 으로 식별해 "모델
 *    거부 아님" 으로 분류한다(facade `MODEL_REJECTED_PATTERNS` 비매칭 보장, TT-I3).
 *  - `linkAbort` — 여러 AbortSignal 을 OR 결합하며 **reason 을 보존**한다. 1층 idle 과
 *    잡 취소·잡 상한을 한 signal 로 묶는 자리.
 */


/**
 * 턴(turn) wall-clock 타임아웃 에러.
 *
 * 핵심 불변식 (TT-I3): 이 에러의 message 는 facade `MODEL_REJECTED_PATTERNS`
 * (index.ts:60-80) 어느 정규식과도 매칭되면 안 된다 — 턴 타임아웃은 *모델 거부 아님*.
 * 매칭 시 멀쩡한 override 모델이 깨진 것으로 제거되고 무의미한 풀 폴백을 탄다. 1층
 * IdleTimeoutError 와 동일하게 "모델 거부 아님" 토큰을 박아 비매칭 보장 + 진단 가독성↑.
 */
export class TurnTimeoutError extends Error {
  /** 백스톱 한계 (ms) — 진단용. 던지는 쪽이 자기 한계를 실어 보낸다. */
  readonly timeoutMs: number | undefined;

  constructor(timeoutMs?: number) {
    // ⚠ 이 메시지 문자열은 isModelRejected 비매칭 보장의 일부 — 변경 시 검증 동반.
    super(
      `턴 처리 시간 초과 (${timeoutMs ?? "미지정"}ms wall-clock 백스톱) — 모델 거부 아님`,
    );
    this.name = "TurnTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

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
