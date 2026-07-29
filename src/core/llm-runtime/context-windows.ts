/**
 * model id → 컨텍스트 윈도우(입력 토큰 한도) 상수 맵. /status 개편 (contract §2.3).
 *
 * 정적 상수 (동적 조회 금지 — principle). 값은 공개 스펙 기반 보수적 추정.
 * 미지 model → undefined → /status 는 % 생략, 토큰만 표시.
 * model id 정규화: 어댑터가 보고하는 raw id 로 우선 lookup, 실패 시 prefix 매칭
 * (claude SDK 가 "claude-opus-4-7-20xxxxxx" 같은 dated id 를 보고할 수 있음).
 *
 * 불확실 명시 (정직):
 *  - claude-* = 200K 는 표준 윈도우. 1M 컨텍스트 베타를 모델 id 동일하게 쓰면
 *    % 가 과대 표시될 수 있음 (보수적으로 200K 고정).
 *  - gpt-5.x 윈도우(400K)는 추정. 실측 불가 → 보수값. 틀려도 graceful
 *    (토큰은 정확, %만 근사). 값 조정 시 이 상수 1곳만 수정.
 *
 * 어댑터 무관 상수 — types.ts(타입 전용)·index.ts(facade 전용) 와 분리.
 */
/**
 * ★손으로 관리하는 목록이라 드리프트했다 (2026-07-30 검토 실측).
 *
 *  실사용(`llm.turn_done` 358턴): gpt-5.6-sol 119 · gpt-5.5 102 · **claude-opus-5 84** ·
 *  **claude-sonnet-5 36** · gpt-5.6-terra 17. 그런데 표의 `claude-opus-4-7`·
 *  `claude-sonnet-4-6`·`claude-haiku-4-5` 는 **각 0턴**이었다. `claude-*-5` 는 접두 매칭도
 *  실패 → `lookupContextWindow`=undefined → `/status` 가 "(윈도우 미상)" 만 찍고
 *  **70%/85% "거의 참" 경고가 claude 백엔드에선 한 번도 안 떴다**(그 120턴 내내).
 *  `gpt-5.6-*` 는 맨 아래 `gpt-5` 엔트리에 **우연히** 접두로 걸려 살아남았을 뿐이다.
 *
 *  키는 **세대 접두**로 둔다(`claude-opus-5` 가 `claude-opus-5-20260xx` 까지 흡수).
 *  회귀 `context-window-coverage` 가 "settings.json 풀의 모든 모델이 해석되는가"를 지킨다.
 */
export const CONTEXT_WINDOWS: Record<string, number> = {
  // Anthropic (claude). 표준 윈도우 200K.
  "claude-opus-5": 200_000,
  "claude-sonnet-5": 200_000,
  "claude-haiku-5": 200_000,
  "claude-opus-4": 200_000,
  "claude-sonnet-4": 200_000,
  "claude-haiku-4": 200_000,
  // OpenAI / codex. gpt-5.x 계열 — 공개 추정. 불확실 → 보수값.
  "gpt-5.6": 400_000,
  "gpt-5.5": 400_000,
  "gpt-5.1": 400_000,
  "gpt-5": 400_000,
};

/**
 * raw model id 로 윈도우 회수. 정확 일치 우선, 없으면 prefix(앞 토큰) 매칭,
 * 그래도 없으면 undefined.
 */
export const lookupContextWindow = (
  model: string | null | undefined,
): number | undefined => {
  if (model === null || model === undefined || model === "") return undefined;
  if (CONTEXT_WINDOWS[model] !== undefined) return CONTEXT_WINDOWS[model];
  for (const key of Object.keys(CONTEXT_WINDOWS)) {
    if (model.startsWith(key)) return CONTEXT_WINDOWS[key];
  }
  return undefined;
};
