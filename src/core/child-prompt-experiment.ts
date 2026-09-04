// src/core/child-prompt-experiment.ts
/**
 * **자식 프롬프트 절제 — 측정 전용 게이트** (2026-09-04). 기본은 꺼져 있다(`full`).
 *
 * ★**남은 질문 하나를 재는 도구**다. 헌법 쪽은 이미 답이 났다(`constitution-scope.ts` —
 *  역할별로 갈라 상시 적용). 안 정해진 건 **스킬 인덱스**다:
 *
 * ```
 *   자식이 매 호출 받는 것 (2026-09-04 실측, 벤치와 같은 throwaway 홈)
 *     SYSTEM.md        28,661B  43%  → 역할 범위로 갈랐다(에이전트 −22.6%)
 *     어댑터 sysprompt  14,386B  21%  → 안 건드린다(도구 사용법·출력 규약)
 *     skillIndex       12,539B  19%  → ★**여기가 미결이다**
 *     도구 스키마       11,652B  17%  → 안 건드린다(잘못 고른 도구 하나가 29.9초)
 * ```
 *  스킬 목록을 빼도 자식은 스킬을 **쓸 수 있다**(`invoke_skill` 은 `skills: "subagent"` 라
 *  그대로 등록된다) — 목록을 미리 안 받을 뿐이다. 그래서 «능력을 뺏는가» 가 아니라
 *  «미리 알려줄 값이 있는가» 라는 질문이고, 그건 재야 안다.
 *
 * ★**왜 지표를 비용으로 잡나.** 2026-09-03 에 같은 종류의 실험을 하고 «값이 없다»(−8%) 며
 *  걷었는데, 그 −8%는 **실입력**(입력 − 캐시적중)이었다. 실입력은 정의상 캐시 읽기분을
 *  빼는데 **자식 입력 비용의 50%가 바로 그 캐시 읽기분**이다(실측: 캐시읽기 $0.0463 /
 *  새로태움 $0.0324 / 출력 $0.0138). 절감이 일어나는 쪽을 안 보는 자로 잰 것이다.
 *  비용으로 다시 재니 같은 축에서 **−37.6%**(대조군 드리프트 −10.3%)였다.
 *
 * ★**시간 축은 다시 재지 마라.** 프롬프트 크기 ↛ 벽시계는 세 번 재서 세 번 다 확인됐다.
 *
 * ★**요약본을 만들지 않는다.** 첫 판엔 여기에 «자식용 헌장»(헌법 축약본) 상수가 있었는데
 *  지웠다 — 헌법이 두 벌이 되면 갈리고, 이 레포엔 그렇게 갈려 **정반대 지시를 준** 사고와
 *  그걸 막는 `constitution-single-source` 회귀가 있다. 역할별로 나눌 일이면
 *  `constitution-scope.ts` 처럼 **원본에 범위를 표시**하는 게 맞다(정본은 계속 하나).
 */

/** 실험 조건. `full` = 종전 그대로(기본). */
export type ChildPromptVariant = "full" | "no-skill-index";

/**
 * 지금 걸린 조건. env 를 **읽을 때마다** 본다 — 벤치가 한 프로세스에서 조건을 바꿔가며
 * 돌 수 있어야 하고, 모듈 로드 시점에 얼려두면 그게 안 된다.
 */
export const childPromptVariant = (): ChildPromptVariant =>
  process.env.CHILD_PROMPT_VARIANT === "no-skill-index" ? "no-skill-index" : "full";

/** 이 역할이 «자식»(서브에이전트·매니저)인가. */
export const isChildRole = (input: {
  subagentDepth?: number;
  workerDepth?: number;
}): boolean => (input.subagentDepth ?? 0) > 0 || (input.workerDepth ?? 0) > 0;

/**
 * 자식 슬롯 절제 — 덮어쓸 값만 돌려준다(`undefined` = 그대로 둬라).
 * 기본 `full` 이면 `{}` 라 조립은 **바이트 단위로 종전과 같다.**
 */
export const childPromptOverrides = (
  roleSource: { subagentDepth?: number; workerDepth?: number },
): { skillIndex?: string } =>
  childPromptVariant() === "no-skill-index" && isChildRole(roleSource)
    ? { skillIndex: "" }
    : {};
