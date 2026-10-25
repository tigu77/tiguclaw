/**
 * **시작 중인 턴** — `UserPromptSubmit` 훅을 기다리는 동안에도 `/stop` 이 그 턴에 닿게 한다 (2026-10-23, 설계
 * docs/decisions/2026-10-22-limit-auto-resume-design.md §3.10 «재개 턴이 … 등록되기 전에 `/stop`»).
 *
 * ★틈: 핸들러는 훅(임의 셸 — 최대 수십 초)을 기다린 **뒤에야** 턴을 «진행 중» 으로 등록한다. 그 사이 `/stop` 은 «진행 중 없음» 으로 답하고
 *  턴은 그대로 모델을 부른다 — 사람 메시지·완료 재주입·트리거 턴 모두. 표시는 **훅 직전**에 걸고 훅이 끝나면 지운다
 *  (그 뒤 등록까지는 await 가 없어 `/stop` 이 끼어들 틈이 없다). 슬래시 처리 단계는 범위 밖이라 표시하지 않는다(실행형 `run:` 의 셸 시작이
 *  «멈춤» 을 알린 뒤 시작되는 새 경로가 생긴다 — 설계 §3.10).
 * ★표시·해제·판정을 **한 함수**(`awaitWhileStarting`)로 묶는다 — 출구마다 지우게 두면 하나를 빠뜨려 다음 `/stop` 이 엉뚱한 턴을 멈춘다.
 */

interface StartingMark {
  stopRequested: boolean;
}

/** threadKey → 시작 중 표시. 스레드는 직렬 줄이라 한 스레드에 하나뿐이다. */
const starting = new Map<string, StartingMark>();

/**
 * `wait` 을 기다리는 동안 그 스레드를 «시작 중» 으로 표시한다. 끝나면(던져도) 표시를 지우고, 그동안 `/stop` 이 왔는지 함께 돌려준다.
 * 호출자는 `stopped` 를 그 구간 출구의 **어떤 판정보다 먼저** 본다(훅 차단 안내보다도 — 사용자가 먼저 멈췄다).
 */
export const awaitWhileStarting = async <T>(threadKey: string, wait: () => Promise<T>): Promise<{ value: T; stopped: boolean }> => {
  const mark: StartingMark = { stopRequested: false };
  starting.set(threadKey, mark);
  try {
    const value = await wait();
    return { value, stopped: mark.stopRequested };
  } finally {
    if (starting.get(threadKey) === mark) starting.delete(threadKey);
  }
};

/** `/stop` 이 부른다 — 이 스레드에 시작 중인 턴이 있으면 멈춤을 요청하고 true. */
export const requestStopStarting = (threadKey: string): boolean => {
  const mark = starting.get(threadKey);
  if (mark === undefined) return false;
  mark.stopRequested = true;
  return true;
};

/** 검사·관측용 — 지금 시작 중 표시가 있나. */
export const isStarting = (threadKey: string): boolean => starting.has(threadKey);
