/**
 * OpenAI Codex backend — 도구 반복 루프의 **판정만**. 상태·IO 0, 순수 산술.
 *
 * ★왜 뺐나 (2026-09-01). 이 판정 다섯이 `runOpenAiCodex` 안에 인라인으로 있어서, 그것을
 *  지키는 회귀가 **소스 문자열밖에 못 봤다.** 적대 검토가 한 줄짜리 변이로 차례로 뚫었고
 *  **전부 스위트 초록**이었다:
 *
 *  | 변이 | 무엇이 죽나 |
 *  |---|---|
 *  | `while (iteration < iterationBase + HARD)` → `< HARD` | 이어가기 사망 + 마무리 없이 빈 답 |
 *  | `if (iteration === iterationBase + HARD-1)` → `=== HARD-1` | ★**무한 루프** — `iteration` 이 창 끝에 고정돼 누적 백스톱도 원리적으로 안 걸린다 |
 *  | 백스톱 상한 → `MAX_SAFE_INTEGER` | 백스톱 무력화. 단언은 "누적 상한 + break" 라고 초록 |
 *  | `totalIterations = iteration` → `= 0` | 같음. 게다가 로그가 `누적=0/1500` 으로 거짓말 |
 *  | dedup 가드(`lastCheckpointIteration !== iteration`) 삭제 | 이어간 자리에서 nudge 가 두 번 |
 *
 *  ★공통 원인은 «부품은 검사되는데 이음매는 안 검사된다» 가 아니라 **판정을 실행할 수가
 *  없었다** 는 것이다. 검사가 껄끄러우면 코드가 잘못 놓인 것이다 —
 *  [[feedback_simple_composable_no_duplication]]. 여기로 옮기면 회귀가 루프를 **돌려보고**
 *  «이어간 자리에서 nudge 0개» · «백스톱이 정확히 N 에서 끊는다» 를 셀 수 있다.
 *
 * ★**창(window) 이 이 모듈의 유일한 개념이다.** 한도에 닿으면 `iteration` 을 0 으로
 *  되돌리지 *않고* 창의 시작점(`base`)을 옮긴다. 0 으로 되돌리면 iteration 0 전용 입력 상한
 *  가드가 다시 켜지고, 그게 throw 하면 폴백이 턴을 처음부터 재실행해 **부작용이 중복**된다.
 */

/** 이 창이 아직 안 끝났나 — 루프 조건. */
export const withinWindow = (iteration: number, base: number, hard: number): boolean =>
  iteration < base + hard;

/** 창의 마지막 자리인가 — 다음 턴을 `tools:[]` 로 강제 마무리시킬 지점. */
export const isWindowEnd = (iteration: number, base: number, hard: number): boolean =>
  iteration === base + hard - 1;

/**
 * 진행 nudge 를 낼 자리인가(창 안에서 `every` 의 배수).
 *
 * ★`lastCheckpoint` 가 짝이다. 이어가기가 창을 옮기면 `(iteration - base) % every === 0` 이
 *  **그 자리에서 즉시 참**이 되는데, 방금 «이어서 계속» 을 넣었으므로 한 번 더 붙으면 안 된다.
 *  그래서 이어갈 때 `lastCheckpoint = iteration` 을 찍는다(`-1` 로 리셋하면 중복된다).
 */
export const isCheckpointDue = (
  iteration: number,
  base: number,
  every: number,
  lastCheckpoint: number,
): boolean =>
  iteration > 0 && (iteration - base) % every === 0 && lastCheckpoint !== iteration;

/** 누적 백스톱 — 이어가기 횟수에 제한을 안 뒀으므로 런어웨이는 여기서만 멈춘다. */
export const shouldStopContinuing = (totalIterations: number, max: number): boolean =>
  totalIterations >= max;

/**
 * 로그의 반복 라벨. 분수는 **창 안 위치**를 말하고, 이어간 경우에만 누적을 덧붙인다.
 *
 * ★분자·분모가 같은 좌표계여야 한다. 창을 옮기면서 분자만 절대값이 됐던 적이 있고,
 *  실제 로그가 `iter=1639/150` 을 찍었다 — 분자가 분모를 열 배 넘으니 원격에서 그 줄만
 *  보는 사람은 계산이 깨졌다고 읽는다.
 */
export const iterLabel = (iteration: number, base: number, hard: number): string =>
  `${iteration - base}/${hard}` + (base > 0 ? ` 누적=${iteration}` : "");

/**
 * 한도에 닿았을 때 **무엇을 하라고 말할지** — 그 스레드가 이어가느냐로 갈린다.
 *
 * ★수치는 고쳤는데 **처방이 낡아 있었다** (2026-09-01, 3라운드 F-5). 배경 스레드는 이
 *  직후 자동으로 이어가므로 **잘리지 않는데**, 로그는 여전히 *"CODEX_MAX_TOOL_ITERATIONS_HARD
 *  를 올리세요(기본 150)"* 라고 말했다. 누적 1,639회를 돌고 있는 턴에게 150짜리 손잡이를
 *  가리키는 셈이고, 실제 손잡이는 `CODEX_MAX_TOTAL_ITERATIONS` 다. 로그가 1차 진단면이면
 *  틀린 처방은 틀린 수치와 같은 무게다.
 */
export const capAdvice = (background: boolean, windowCap: number, totalCap: number): string =>
  background
    ? `배경 작업이라 마무리 후 **자동으로 이어갑니다**(잘리지 않습니다) — 정말 멈춰야 하면 누적 상한 CODEX_MAX_TOTAL_ITERATIONS 를 보세요(기본 ${String(totalCap)}).`
    : `정당하게 긴 작업이면 CODEX_MAX_TOOL_ITERATIONS_HARD 를 올리세요(기본 ${String(windowCap)}).`;

/**
 * 이 마무리 턴 **뒤에 이어서 계속 도는가** — 배경 스레드 + 누적 백스톱 미도달.
 *
 * ★판정을 여기 한 곳에 두는 이유: 소비처가 **둘**이다 — ①모델에게 무엇을 시킬지
 *  (`capFlushPrompt`) ②실제로 이어갈지. 두 곳에서 따로 판단하면 갈리고, 갈리면
 *  **모델에게 «최종 요약» 을 시켜놓고 계속 돌리는** 바로 그 상태가 된다.
 */
export const willAutoContinue = (
  background: boolean,
  totalIterations: number,
  totalCap: number,
): boolean => background && !shouldStopContinuing(totalIterations, totalCap);

/**
 * 도구 한도 마무리 턴에 **모델에게 시키는 말** — 이어가느냐로 갈린다.
 *
 * ★사고(2026-09-01). 한 문구를 두 상황에 같이 썼다: *"지금까지의 결과로 위 질문에 답하는
 *  형식의 **최종 요약** 텍스트를 작성하세요"*. 배경 작업은 그 답을 받은 뒤 **자동으로
 *  이어가는데**, 시킨 말이 «최종» 이라 모델은 **완료 문장을 쓴다.** 그리고 바로 다음
 *  턴에 우리가 *"방금 **중간 정리**를 마쳤습니다"* 라고 말한다 — 두 문구가 서로 어긋나
 *  있었고, 사용자 눈엔 **«완료» 라고 해놓고 한 시간 반을 더 도는 것**으로 보인다.
 *  (라이브 `worker:4bb5d813`: 14:21 완료 문장 뒤 15:53 까지 새 수정·새 위임.)
 *
 * ★고칠 자리는 이어가기가 아니다 — 이어가기는 *"한도에 걸린 작업은 멈춘 것이 아니라
 *  잘린 것"* 이라는 **의도된 결정**이다. 틀린 것은 **그때 뭐라고 시키느냐** 였다.
 */
export type CapFlushKind = "checkpoint" | "final";

/**
 * **«이번이 끝인가» 를 말하는 문장** — 상태마다 딱 하나. 이 파일에서 그 말을 하는 자리는
 * 여기뿐이다.
 *
 * ★왜 표로 뺐나 (2026-09-01, 두 번째 정정). 처음엔 `kind` 만 꺼내고 **지시문 전체는 두
 *  분기가 각자 손으로 썼다.** 그러면 «kind 는 checkpoint 인데 본문은 최종이라고 말하는»
 *  모순이 성립하고, 나는 그 틈을 **«최종» 이라는 낱말을 grep 하는 검사**로 막았다.
 *  그게 땜빵이다 — 검사가 산문의 의미를 판정하는 척하면 문구를 다듬을 때마다 빨개져
 *  결국 아무도 안 본다.
 * ★표로 빼면 그 모순이 **국소 편집으로는 안 만들어진다**: 조립부가 `kind` 로 조회하므로
 *  (아래 `FLUSH_FINALITY[kind]`) 분기가 자기 상태와 다른 문장을 집을 수가 없다.
 *  남는 위험은 «checkpoint 칸에 끝났다는 말을 써 넣는 것» 하나인데, 그건 두 문장이
 *  **이름표를 달고 나란히** 있으니 눈에 보인다 — 검사가 아니라 리뷰가 볼 일이다.
 */
export const FLUSH_FINALITY: Readonly<Record<CapFlushKind, string>> = {
  checkpoint:
    `여기서 끝내는 게 아니라 **이어서 계속할 것**입니다. 지금까지 한 일과 다음에 할 일을 ` +
    `**중간 점검** 형식으로 정리하세요. ★**완료라고 쓰지 마세요** — 아직 안 끝났습니다.`,
  final: `지금까지의 결과로 위 질문에 답하는 형식의 **최종 요약** 텍스트를 작성하세요.`,
};

export const capFlushPrompt = (o: {
  willContinue: boolean;
  userTextEcho: string;
  ranListMsg: string;
}): { kind: CapFlushKind; text: string } => {
  // ★`kind` 와 조회 키가 **같은 변수**다 — 둘로 나누면 다시 갈릴 수 있다.
  const kind: CapFlushKind = o.willContinue ? "checkpoint" : "final";
  return {
    kind,
    text:
      `도구 호출 한도에 도달했습니다. ${o.userTextEcho}${o.ranListMsg} ` +
      `${FLUSH_FINALITY[kind]} 추가 도구 사용 없이 정리만.`,
  };
};
