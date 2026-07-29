/**
 * 턴 종료 판정 — **모델이 정말 끝낸 건가, 그냥 사라진 건가** (2026-07-29).
 *
 * 우리가 루프를 소유하는 어댑터(codex)는 "도구 호출 0" 응답을 받으면 턴을 끝낸다. 문제는
 * 그 응답이 두 가지를 뜻할 수 있다는 것이다:
 *   (a) 할 일을 다 하고 마무리 보고까지 낸 정상 종료
 *   (b) **예고만 하고 사라진 미완결** — "확인하겠습니다" 를 뱉고 읽기 도구 몇 개 부른 뒤
 *       다음 응답을 통째로 비워 끝내는, gpt 계열의 알려진 조기 종료 성향
 *
 * 종전 판정은 `finalText === ""`(누적 텍스트가 아예 없나) 만 봤다. 그래서 (b) 는 예고문
 * 한 줄 덕에 **정상 종료로 위장**됐고, 사용자에게는 "하겠습니다" 만 남고 작업도 결과도
 * 없었다. 실측 2026-07-29: dev 14:07:10 예고 + Read×3·project_capabilities×2 → 14:07:12
 * turn_done(2초). 회사 인스턴스 동일 패턴으로 사용자 신고 2회.
 *
 * 가르는 신호는 **마지막 텍스트 이후 도구가 돌았는가** 다. 돌았는데 그 뒤로 아무 텍스트도
 * 없으면, 모델은 자기가 한 일을 보고하지 않고 끝낸 것이다 — (b).
 */

/**
 * **설계상 턴을 끝내는 도구** — 이걸 부른 뒤 텍스트 없이 끝나는 건 정상이다.
 *
 * `prompt_options` 는 도구 설명·반환문 둘 다 "답을 받아야 하면 이 호출 뒤 **턴을 마치세요**"
 * 라고 지시한다(`prompt-options-mcp.ts`). 그런데 아래 판정은 "도구는 돌았는데 보고가 없다"
 * 를 미완결로 보므로, 도구가 끝내라 하고 루프가 끝내지 말라 하는 **정면충돌**이 된다
 * (실측: 그 턴마다 nudge 2회 + 강제 flush 1회 = 최대 3왕복 낭비 + 선택지 카드 밑에 군더더기).
 */
const TURN_ENDING_TOOLS = new Set(["prompt_options"]);

export interface TurnClosingState {
  /** 이번 iteration 이 낸 텍스트("" = 없음). */
  readonly text: string;
  /** 지금까지의 마지막 non-empty 텍스트("" = 턴 전체가 무텍스트). */
  readonly finalText: string;
  /** 그 마지막 텍스트 **이후** 실행한 도구 수. 텍스트가 나올 때마다 0 으로 리셋된다. */
  readonly toolCallsSinceText: number;
  /** 마지막 텍스트 이후 실행한 도구 **이름들**(설계상 종료 도구 판별용). */
  readonly toolNamesSinceText?: readonly string[];
}

/**
 * 도구 호출 0 으로 끝나려는 순간, **마무리 보고를 한 번 더 요구해야 하는가**.
 *
 * true 면 호출부가 nudge 를 넣고 루프를 계속한다(재시도 횟수는 호출부의 cap 이 관리 —
 * 여기서는 상태를 안 들고 순수 판정만 한다).
 */
export const needsClosingReport = (s: TurnClosingState): boolean => {
  if (s.text !== "") return false; // 이번에 보고했다 — 끝내도 된다.
  if (s.finalText === "") return true; // 턴 전체가 무텍스트 — 기존 빈 응답 경로.
  if (s.toolCallsSinceText === 0) return false; // 보고 후 도구 없음 = 정상 종료.
  // 설계상 종료 도구만 돌았으면 그 종료는 의도된 것이다(위 TURN_ENDING_TOOLS 주석).
  const names = s.toolNamesSinceText ?? [];
  if (names.length > 0 && names.every((n) => TURN_ENDING_TOOLS.has(n))) return false;
  return true; // 예고 뒤 도구만 돌고 보고 없음 = 미완결.
};
