/**
 * 프리픽스 캐시 붕괴 판정 — **순수 함수** (2026-08-19)
 *
 * 왜 어댑터에서 뽑았나: 종전엔 이 계산이 `openai-codex-oauth.ts` 2천 줄 안에 인라인이라
 * 검사하려면 데몬을 띄워야 했고, 그래서 아무도 검사하지 않았다. 그 사이 로그가
 * **잘못된 수치**를 찍고 있었다 — 붕괴가 1건인 턴에 *턴 전체 미적중분*을 붙여서
 * `1/151 → 775,226토큰` 으로 나왔고, 읽는 쪽(나)이 그걸 붕괴 비용으로 읽어
 * 하루치를 "28.5M 손실"로 보고했다. 실측 적중률은 87~92% 였다.
 *
 * ★즉 이건 성능 코드가 아니라 **판정 코드**다. 판정은 실행해서 검사할 수 있어야 한다.
 *
 * 알려진 성질(실측 2026-08-19, 하루치 2,558 iteration):
 * - 붕괴 비율은 7.0%. 시간대별 적중률은 54~92% 로 흔들린다.
 * - ★적중률은 **턴 길이에 크게 좌우된다** — 1회차가 프리픽스 값을 치르고 2~N회차가
 *   얻어타므로, 짧은 턴은 평균이 원래 낮다(턴당 input 8.1M→91%, 0.63M→75%).
 *   그래서 "적중률이 낮다"만으로 이상을 판정하면 짧은 턴을 상시 오탐한다.
 * - 다만 턴 길이가 같은데 88.3% vs 54.4% 로 갈린 시점이 있다 — 그 잔여는 미설명이고,
 *   백엔드 축출 가설이 남는 자리다. 여기서 단정하지 않는다.
 */

/** 한 iteration 의 사용량 — 어댑터 usage 의 캐시 관련 부분만. */
export type CacheUsage = {
  readonly inputTokens: number;
  readonly cachedTokens?: number;
};

/** 붕괴 판정 임계 — 적중률이 이 % 미만이면 그 iteration 은 캐시를 못 탄 것으로 본다. */
export const CACHE_COLLAPSE_HIT_PCT = 20;

/** 적중률(%). input 이 0이면 0 (판정 불가를 붕괴로 치지 않기 위해 호출부에서 걸러진다). */
export const hitPct = (u: CacheUsage): number =>
  u.inputTokens > 0 ? ((u.cachedTokens ?? 0) / u.inputTokens) * 100 : 0;

/** 이 iteration 이 캐시를 못 탔나. input 0 은 붕괴가 아니다(잴 게 없다). */
export const isCollapse = (u: CacheUsage): boolean =>
  u.inputTokens > 0 && hitPct(u) < CACHE_COLLAPSE_HIT_PCT;

/** 턴 누적 — 어댑터가 iteration 마다 add() 하고 끝에 한 줄 찍는다. */
export type CacheTally = {
  iterations: number;
  inputTokens: number;
  cachedTokens: number;
  /** 붕괴 iteration 수. */
  collapses: number;
  /** ★**붕괴한 iteration 들만의** 미적중 합. 턴 전체 미적중분과 다르다. */
  collapseMissed: number;
};

export const newTally = (): CacheTally => ({
  iterations: 0,
  inputTokens: 0,
  cachedTokens: 0,
  collapses: 0,
  collapseMissed: 0,
});

export const addUsage = (t: CacheTally, u: CacheUsage): void => {
  const cached = u.cachedTokens ?? 0;
  t.iterations += 1;
  t.inputTokens += u.inputTokens;
  t.cachedTokens += cached;
  if (isCollapse(u)) {
    t.collapses += 1;
    t.collapseMissed += u.inputTokens - cached;
  }
};

/**
 * 턴 끝 한 줄. 붕괴가 없으면 `null`(정상은 침묵 — 매 턴 같은 warn 은 배경소음이 된다).
 *
 * ★두 수치를 **이름으로 구분**한다. 하나만 찍으면 큰 쪽이 붕괴 비용으로 읽힌다.
 */
export const describeTally = (t: CacheTally, model: string): string | null => {
  if (t.collapses === 0 || t.iterations === 0) return null;
  const turnMissed = t.inputTokens - t.cachedTokens;
  const turnHit = t.inputTokens > 0 ? Math.round((t.cachedTokens / t.inputTokens) * 100) : 0;
  return (
    `[cache-collapse] ${model} ${t.collapses}/${t.iterations} iteration 이 ` +
    `캐시를 못 탔습니다(적중<${CACHE_COLLAPSE_HIT_PCT}%) — ` +
    `붕괴분 ${t.collapseMissed.toLocaleString()}토큰. ` +
    `[참고] 이 턴 전체: 적중 ${turnHit}% · 미적중 ${turnMissed.toLocaleString()}토큰 ` +
    `(짧은 턴은 1회차가 프리픽스 값을 치르므로 적중률이 원래 낮다 — 붕괴 아님). ` +
    `우리 프리픽스(instructions·tools)는 바이트 동일이므로 백엔드 축출 쪽. ` +
    `원시 곡선: CODEX_CACHE_CURVE=1`
  );
};
