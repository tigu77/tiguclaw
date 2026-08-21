/**
 * model id → 컨텍스트 윈도우(입력 토큰 한도) 상수 맵. /status 개편 (contract §2.3).
 *
 * 정적 상수 (동적 조회 금지 — principle). 값은 공개 스펙 기반 보수적 추정.
 * 미지 model → undefined → /status 는 % 생략, 토큰만 표시.
 * model id 정규화: 어댑터가 보고하는 raw id 로 우선 lookup, 실패 시 prefix 매칭
 * (claude SDK 가 "claude-opus-4-7-20xxxxxx" 같은 dated id 를 보고할 수 있음).
 *
 * 불확실 명시 (정직):
 *  - gpt-5.x 윈도우(400K)는 추정. 실측 불가 → 보수값. 틀려도 graceful
 *    (토큰은 정확, %만 근사). 값 조정 시 이 상수 1곳만 수정.
 *
 * ★**"보수적으로 200K" 가 안전한 쪽이 아니었다** (2026-08-21).
 *  여기 원래 이렇게 적혀 있었다: *"1M 컨텍스트 베타를 모델 id 동일하게 쓰면 % 가 과대
 *  표시될 수 있음 (보수적으로 200K 고정)"*. 그 함정을 예견해놓고 **방향을 잘못 골랐다.**
 *  claude-5 세대는 1M 이 베타가 아니라 표준이라, 200K 로 잡으면 정상 턴이 100% 를 넘겨
 *  `/status` 가 **상시** "거의 참 — /clear 고려" 를 띄운다. 그 경보는 무해하지 않다 —
 *  사용자가 그걸 보고 `/clear` 를 눌러 **멀쩡한 맥락을 날린다.**
 *  실측(회사돌쇠, 2026-08-21): claude-opus-5 턴들이 input 241,088 / 228,306 / 213,948 을
 *  `ok=true` 로 성공. 200K 창이면 물리적으로 불가능한 값이다.
 *  ★교훈: 윈도우를 **과소** 잡는 것은 보수적이 아니다. 모르면 `undefined`(=% 생략)가
 *  보수적이고, 아는 값은 정확히 적는다.
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
  // ── Anthropic (claude) ────────────────────────────────────────────────
  // 1M 세대 — claude-5 계열과 4.6 이상. 여기서 1M 은 베타가 아니라 표준이다.
  "claude-opus-5": 1_000_000,
  "claude-sonnet-5": 1_000_000,
  "claude-opus-4-8": 1_000_000,
  "claude-opus-4-7": 1_000_000,
  "claude-opus-4-6": 1_000_000,
  "claude-sonnet-4-6": 1_000_000,
  // 200K 세대 — haiku 전 세대, 그리고 4.5 이하의 opus/sonnet.
  //  ★아래 셋은 **세대 접두 폴백**이다. 위의 구체 키(`claude-opus-4-8` 등)가
  //   같은 접두를 공유하므로, lookup 은 **가장 긴 접두**를 골라야 한다(아래 함수).
  "claude-haiku-5": 200_000,
  "claude-haiku-4": 200_000,
  "claude-opus-4": 200_000,
  "claude-sonnet-4": 200_000,
  // OpenAI / codex. gpt-5.x 계열 — 공개 추정. 불확실 → 보수값.
  "gpt-5.6": 400_000,
  "gpt-5.5": 400_000,
  "gpt-5.1": 400_000,
  "gpt-5": 400_000,
};

/**
 * raw model id 로 윈도우 회수. 정확 일치 우선, 없으면 **가장 긴 접두** 매칭,
 * 그래도 없으면 undefined(= `/status` 가 % 를 생략하고 토큰만 표시 — 안전한 실패).
 *
 * ★**가장 긴 접두**여야 한다 (2026-08-21). 종전엔 `Object.keys` 순서대로 훑어
 *  **먼저 나온** 접두를 반환했다. 그 상태에서 `claude-opus-4-8`(1M) 을 추가해도
 *  `claude-opus-4`(200K, 폴백)가 목록에서 앞이면 그쪽이 이겨 **새 값이 영영 안 쓰인다** —
 *  키를 고쳐도 동작이 안 바뀌는, 가장 알아채기 힘든 종류의 죽은 설정이다.
 *  세대 폴백과 구체 키가 같은 접두를 공유하는 이상 이건 구조적 요구다.
 */
export const lookupContextWindow = (
  model: string | null | undefined,
): number | undefined => {
  if (model === null || model === undefined || model === "") return undefined;
  if (CONTEXT_WINDOWS[model] !== undefined) return CONTEXT_WINDOWS[model];
  let best: string | undefined;
  for (const key of Object.keys(CONTEXT_WINDOWS)) {
    if (!model.startsWith(key)) continue;
    if (best === undefined || key.length > best.length) best = key;
  }
  return best === undefined ? undefined : CONTEXT_WINDOWS[best];
};

/**
 * 컨텍스트 압박 라벨. `/status` 가 쓰는 판정 — **index.ts 안이 아니라 여기 산다.**
 *
 * ★자리를 옮긴 이유: 이 판정이 인라인이던 동안 회귀가 grep 으로밖에 못 봤고, 그래서
 *  "106% 인데 「거의 참」" 이라는 거짓말이 아무에게도 안 걸렸다. 이 레포의 상수다 —
 *  **검사가 껄끄러우면 코드가 잘못 놓인 것.** 순수 함수로 빼면 변이 테스트가 된다.
 */
/**
 * **표가 틀렸으면 스스로 말하게 한다** (2026-08-21 적대 검토 B-F4).
 *
 * ★사고의 구조: 표의 한 칸이 틀리면(opus-5 를 200K 로 적었던 것) `/status` 가 상시 거짓
 *  경보를 내고 사용자가 멀쩡한 맥락을 `/clear` 로 날린다. 그걸 고쳤는데, 그물은 **사고가 난
 *  칸 하나**만 막았다 — 실측 앵커가 opus-5 뿐이라 sonnet-5 를 200K 로 바꿔도 스위트가 초록이다.
 *
 * ★앵커를 손으로 늘리는 건 답이 아니다: 새 모델이 나올 때마다 누군가 적어야 하고, 안 적으면
 *  조용히 무방비다(이 레포가 손 관리 목록으로 반복해서 당한 자리). 대신 **반증을 자동화**한다 —
 *  성공한 호출의 입력이 표의 값을 넘었다면 그 칸은 **확실히 틀렸다**(반증 불가능한 하한).
 *  그 순간 로그에 판정 수치를 실어 남긴다. 목록이 없어도 **모든 칸**이 덮이고, 조용한
 *  결함이 시끄러운 결함이 된다 — 이 레포에서 그 차이가 12일과 그날의 차이였다.
 *
 * @returns 표가 반증됐으면 그 사실을 적은 한 줄, 아니면 null(정상은 조용하다).
 */
export const contextWindowContradiction = (
  model: string,
  observedInputTokens: number,
): string | null => {
  const win = lookupContextWindow(model);
  if (win === undefined || observedInputTokens <= win) return null;
  return (
    `context-window: '${model}' 표가 틀렸습니다 — 성공한 호출의 입력 ${observedInputTokens.toLocaleString()} 토큰이 ` +
    `표의 상한 ${win.toLocaleString()} 을 넘었습니다. context-windows.ts 의 그 칸을 올리세요 ` +
    `(그때까지 /status 컨텍스트 %가 과대 보고되고 거짓 경보가 납니다).`
  );
};

export const contextPressureLabel = (pct: number): string =>
  pct > 100
    ? " ⚠️ 한도 초과로 계산됨 — 이 모델의 윈도우 값이 틀렸을 수 있습니다(`/clear` 불필요)"
    : pct >= 85
      ? " ⚠️ 거의 참 — `/clear` 고려"
      : pct >= 70
        ? " ⚠️ 여유 줄어듦"
        : "";
