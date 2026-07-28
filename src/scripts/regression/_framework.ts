/**
 * 회귀 스위트 뼈대 (2026-07-28, 딥리뷰 H).
 *
 * ★왜 있나: 검증 하네스를 154개 만들었지만 전부 일회용(`_workspace/`)이라 **한 번 돌고
 *  다시는 안 돌았다.** 그래서 "어제 고친 게 오늘 또 깨졌는지"를 사람이 기억해야 했다.
 *  여기 올라온 것만이 매 CI·매 릴리스에서 다시 돈다.
 *
 * 승격 기준(넣기 전에 스스로 물을 것):
 *  1. **싸다** — 수 초 안에 끝난다(외부 네트워크·LLM 호출 없음).
 *  2. **결정적이다** — 같은 입력이면 같은 결과(타이밍 의존·플래키 금지).
 *  3. **격리돼 있다** — 임시 홈/사본만 건드린다. 라이브 데몬·홈·DB 를 절대 안 만진다.
 *  4. **회귀를 잡은 적이 있다** — 실제 사고에서 나온 것. "있으면 좋은 테스트"는 제외.
 * 브라우저(CDP)·라이브 데몬이 필요한 검증은 여기 넣지 않는다(별도 수동 스위트).
 */

export interface Assertion {
  /** 사람이 읽는 단언 — 실패 시 그대로 보고된다. */
  readonly name: string;
  readonly ok: boolean;
  /** 실제 관측값(실패 진단용). 통과해도 남긴다 — "왜 통과했나"가 보여야 한다. */
  readonly got: string;
}

export interface RegressionCheck {
  /** 스위트 안에서 유일한 짧은 이름. */
  readonly name: string;
  /** 이 검사가 지키는 회귀 — 무엇이 깨졌었나(사고 이력). */
  readonly guards: string;
  run: () => Promise<Assertion[]>;
}

export const assert = (name: string, ok: boolean, got: unknown): Assertion => ({
  name,
  ok,
  got: typeof got === "string" ? got : JSON.stringify(got),
});

/**
 * 검사 안에서 쓰는 시한 — **매달리지 말고 실패하라**.
 *
 * ★실측(2026-07-28): detached 를 뺀 변이 상태로 스위트를 돌렸더니 손자가 안 죽어
 *  `wait` 가 영원히 반환되지 않았고, 스위트가 **끝나지 않았다**. CI 에서 무한 대기는
 *  빨간불보다 나쁘다(원인이 안 보이고 러너 시한까지 자원을 문다). 그래서 회귀를
 *  기다리는 모든 지점은 자기 시한을 들고, 넘기면 그 사실 자체를 실패로 보고한다.
 */
export const within = async <T>(
  ms: number,
  what: string,
  p: Promise<T>,
): Promise<{ value: T } | { timedOut: string }> => {
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<{ timedOut: string }>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: `${what} 이(가) ${ms}ms 안에 안 끝남` }), ms);
  });
  try {
    const r = await Promise.race([p.then((value) => ({ value })), guard]);
    return r;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};
