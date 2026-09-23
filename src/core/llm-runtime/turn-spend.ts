/**
 * **턴 실비용** — 한 턴이 실제로 태운 입력·캐시·출력·호출 수 (2026-09-23).
 *
 * ★계약(`RegionATurnDonePayload`)이 두 층이다: `inputTokens`·`outputTokens`·`cachedTokens`
 *  는 **마지막 호출 1회**, `*Total` 은 반복이 2회 이상일 때만 오는 **턴 합계**. 화면은
 *  «이 턴이 얼마를 썼나» 가 필요하므로 둘 중 무엇을 쓸지 매번 골라야 했고, 그 선택이
 *  대시보드·잡 합계에 **따로** 있었다(출력은 대시보드만 마지막 호출값을 써서 과소계상).
 *  이제 발행하는 자리에서 **한 번** 골라 `llm.turn_done.spend` 로 싣는다 — 소비자는
 *  읽기만 한다.
 */

/** 턴 실비용. `cached` 는 어댑터가 캐시를 보고하지 않았으면 없다(0 과 구분한다). */
export interface TurnSpend {
  input: number;
  output: number;
  cached?: number;
  /** API 호출 수 — 도구 루프 반복. 단일 호출 턴은 1. */
  requests: number;
}

interface UsageFields {
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  iterations?: number;
  inputTokensTotal?: number;
  outputTokensTotal?: number;
  cachedTokensTotal?: number;
}

const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;

/** 어댑터 usage → 턴 실비용. 입력을 보고하지 않았으면 undefined(거짓값 금지 — 0 을 만들지 않는다). */
export const turnSpend = (u: UsageFields | undefined): TurnSpend | undefined => {
  if (u === undefined) return undefined;
  const iters = num(u.iterations);
  const inTotal = num(u.inputTokensTotal);
  const loop = iters !== undefined && iters > 1 && inTotal !== undefined && inTotal > 0;
  const input = loop ? inTotal : num(u.inputTokens);
  if (input === undefined || input <= 0) return undefined;
  const cached = loop ? num(u.cachedTokensTotal) : num(u.cachedTokens);
  const output =
    (loop ? (num(u.outputTokensTotal) ?? num(u.outputTokens)) : num(u.outputTokens)) ?? 0;
  return { input, output, ...(cached !== undefined ? { cached } : {}), requests: loop ? iters : 1 };
};
