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

/** 지금까지 돈 도구가 **있고** 전부 설계상 종료 도구인가 — 정상 선택지 종료의 재료(B1·Codex 마무리 판정이 같이 쓴다). */
export const onlyTurnEndingTools = (names: readonly string[]): boolean =>
  names.length > 0 && names.every((n) => TURN_ENDING_TOOLS.has(n));

export interface TurnClosingState {
  /** 이번 iteration 이 낸 **사용자에게 보일** 텍스트("" = 없음 — 제안 태그·인용 표식뿐인 글도 없음이다, 2026-11-17). */
  readonly text: string;
  /** 지금까지의 마지막 **보일 글이 있는** 텍스트("" = 턴 전체에 보일 글이 없다). */
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
  // 설계상 종료 도구만 돌았으면 그 종료는 의도된 것이다(위 TURN_ENDING_TOOLS 주석).
  //  ★보일 글이 한 번도 없어도 마찬가지다 — 선택지만 띄운 턴은 카드가 답이다(2026-11-17). 이 판정을 무텍스트 판정보다 **먼저** 본다:
  //   거꾸로면 선택지만 띄운 정상 종료에 «빈 응답 금지» 재요청이 가고, 그 답이 제안 태그뿐이면 빈 말풍선이 나갔다(REPORT §3-2).
  if (onlyTurnEndingTools(s.toolNamesSinceText ?? [])) return false;
  if (s.finalText === "") return true; // 턴 전체에 보일 글이 없다 — 기존 빈 응답 경로.
  if (s.toolCallsSinceText === 0) return false; // 보고 후 도구 없음 = 정상 종료.
  return true; // 예고 뒤 도구만 돌고 보고 없음 = 미완결.
};

/** 한 턴의 순서 기록 한 칸 — 논리 메시지 하나의 원문 글, 또는 실행한 도구 이름(정규화된 이름). */
export type AnswerStep = { readonly text: string } | { readonly tool: string };

/**
 * **최종 답 선택 B1** (2026-11-17, `docs/decisions/2026-11-17-empty-reply-after-suggestion/REPORT.md` §5) — Claude·OpenAI 의 마감과
 *  Claude steering 확정이 부른다(Codex 는 반복마다 같은 규칙을 `needsClosingReport` 재료로 직접 든다).
 *
 * - 어댑터가 고른 답(`current` — Claude 의 성공 result·글 조각, OpenAI 의 마지막 응답)에 **보일 글이 있으면 그대로**다. 바뀌는 것은 없다.
 * - 보일 글이 없으면(제안 태그·인용 표식뿐이거나 빈 글) 이번 턴의 **보일 글이 있는 마지막 논리 메시지**를 찾는다. 그 뒤에 돈 도구가
 *   종료 도구뿐이면 그 메시지 원문 + 뒤의 원문(`current` — 태그)을 답으로 한다. 잇지 않고 **하나만** 고르므로 중간 진행·철회한 글·반복은
 *   다시 나오지 않는다. 그 뒤에 작업 도구가 돌았으면 고르지 않는다(«예고 → 작업 → 무보고» 의 예고를 답으로 올리지 않는다).
 * - 이번 턴에 보일 글이 아예 없고 돈 도구가 종료 도구뿐이면 `choiceEnd` — 선택지만 띄운 정상 종료다(저장 판단의 재료).
 * ★«선택지 뒤 짧은 실본문» 턴은 `current` 에 보일 글이 있어 그대로다 — 앞 설명을 되살리지 않는 현 정책 유지(§5 잔여).
 */
export const pickVisibleAnswer = (
  current: string,
  steps: readonly AnswerStep[],
  visible: (raw: string) => boolean,
): { text: string; choiceEnd?: true } => {
  if (visible(current)) return { text: current };
  const after: string[] = [];
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const s = steps[i]!;
    if ("tool" in s) {
      after.push(s.tool);
      continue;
    }
    if (!visible(s.text)) continue; // 태그뿐인 메시지 — 그 원문은 `current` 쪽에 있다.
    if (!after.every((n) => TURN_ENDING_TOOLS.has(n))) return { text: current };
    return { text: current.trim() === "" ? s.text : `${s.text}\n\n${current}` };
  }
  return onlyTurnEndingTools(after) ? { text: current, choiceEnd: true } : { text: current };
};

/**
 * **한 턴의 모델 호출 절대 상한** — 런어웨이 최후 방어. 우리가 루프를 소유하든(codex) SDK 가 소유하든(openai)
 * **같은 수**다 (2026-10-09 전체 적대 검토 P4).
 *
 * ★openai 어댑터는 본 턴 `run()` 에 `maxTurns` 를 안 줘서 SDK 기본 **10** 이 걸려 있었다 — 도구를 10번 넘게
 *  쓰는 평범한 작업이 `MaxTurnsExceededError` 로 죽었다(OpenRouter·Gemini·Ollama 공통, 검토 재현). codex 는
 *  같은 작업을 1,500 까지 이어 간다. 상한이 어댑터마다 다르면 «같은 일이 모델 따라 죽는다»(원칙: LLM 무관).
 * ★근거·크기(실측 최대 정당 작업 149회의 10배)는 codex 의 누적 백스톱 주석 그대로 — env 이름도 그대로 둔다
 *  (이미 그 이름으로 조정해 온 설치가 있다).
 */
export const TURN_MAX_MODEL_CALLS = ((): number => {
  const raw = process.env.CODEX_MAX_TOTAL_ITERATIONS;
  const n = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isInteger(n) && n > 0 ? n : 1_500;
})();
