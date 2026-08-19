/**
 * 캐시 붕괴 회계 — **붕괴분과 턴 전체 미적중분을 섞지 않는가** (2026-08-19)
 *
 * 잡은 회귀: 로그가 붕괴 1건인 턴에 *턴 전체* 미적중분을 붙여 찍었다
 * (`1/151 iteration … 정가 지불 775,226토큰`). 그 77만은 대부분 정상 적중률(≈90%)의
 * 잔여분인데 이름이 "정가 지불" 하나뿐이라 붕괴 비용으로 읽혔고, 실제로 하루치 로그를
 * **"28.5M 토큰 손실"** 로 사용자에게 보고하는 오독이 일어났다(실측 적중률 87~92%).
 *
 * 등급: **동작 검사** — 판정 함수를 직접 실행한다(소스 grep 아님). 종전엔 이 계산이
 * `openai-codex-oauth.ts` 2천 줄 안에 인라인이라 검사하려면 데몬을 띄워야 했다.
 * 그래서 검사가 없었고, 그동안 로그는 틀린 수치를 찍고 있었다.
 */
import {
  CACHE_COLLAPSE_HIT_PCT,
  addUsage,
  describeTally,
  isCollapse,
  newTally,
} from "../../core/llm-runtime/cache-collapse.js";
import type { Assertion, RegressionCheck } from "./_framework.js";
import { assert } from "./_framework.js";

export const check: RegressionCheck = {
  name: "cache-collapse-accounting",
  guards:
    "붕괴분에 턴 전체 미적중분을 붙여 찍어 정상 적중률의 잔여분까지 손실로 오독시킨 것 (2026-08-19)",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];

    // ── 실제로 로그에 찍혔던 모양: 151 iteration 중 1번만 붕괴 ────────────────
    //  붕괴 1회:   input 200,000 / cached 0        → 붕괴분 200,000
    //  정상 150회: input 200,000 / cached 180,000  → 각 20,000 미적중(적중 90%)
    //  턴 전체 미적중 = 200,000 + 150×20,000 = 3,200,000 ← 붕괴 비용이 **아니다**
    //
    // ★붕괴를 **중간(76회차)** 에 둔다 — 1회차에 두면 그 시점의 *누계*와 *개별값*이
    //  우연히 같아져서, 누계를 붕괴분으로 쓰는 버그가 통과한다(실제로 변이 검사에서
    //  생존했다). 실측 로그의 `1/151` 도 붕괴가 첫 회차라는 보장이 없다.
    const t = newTally();
    for (let i = 0; i < 151; i += 1) {
      if (i === 75) addUsage(t, { inputTokens: 200_000, cachedTokens: 0 });
      else addUsage(t, { inputTokens: 200_000, cachedTokens: 180_000 });
    }

    out.push(
      assert("붕괴 iteration 은 1건(적중 90% 인 150건은 붕괴 아님)", t.collapses === 1, t.collapses),
      assert("iteration 총계 151", t.iterations === 151, t.iterations),
      assert(
        "붕괴분 = 그 iteration 의 미적중분(200,000). 턴 합계(3,200,000)가 아니다",
        t.collapseMissed === 200_000,
        t.collapseMissed,
      ),
      assert(
        "턴 전체 미적중분은 따로 3,200,000 으로 남는다(버리는 게 아니라 분리)",
        t.inputTokens - t.cachedTokens === 3_200_000,
        t.inputTokens - t.cachedTokens,
      ),
    );

    // ── 로그 한 줄이 두 수치를 **이름으로 구분**해 싣는가 ──────────────────────
    //  숫자만 두 개 찍는 건 소용없다 — 어느 쪽이 무엇인지가 오독의 원인이었다.
    const line = describeTally(t, "gpt-5.6-terra");
    out.push(assert("붕괴가 있으면 한 줄을 낸다", line !== null, line === null ? "null" : "있음"));
    if (line !== null) {
      out.push(
        assert("붕괴분을 '붕괴분' 이라 이름 붙여 싣는다", line.includes("붕괴분 200,000토큰"), line),
        assert(
          "턴 전체 미적중분은 '[참고]' 로 구분해 싣는다",
          line.includes("[참고]") && line.includes("3,200,000토큰"),
          line,
        ),
        // 27,000,000 / 30,200,000 = 89% — 실측 하루치(87~92%)와 같은 자리다. 즉 이 픽스처는
        // "정상인데 붕괴 1건 있는 턴" 이고, 그런 턴이 손실로 읽혔던 게 원래 결함이다.
        assert(
          "턴 전체 적중률(89%)을 실어 '나쁜 턴' 오독을 막는다",
          line.includes("적중 89%"),
          line,
        ),
        assert(
          "★붕괴분 자리에 턴 합계가 오지 않는다(이게 원래 결함)",
          !line.includes("붕괴분 3,200,000"),
          line,
        ),
      );
    }

    // ── 부분 적중 붕괴 — 붕괴분에서 적중분을 빼는가 ────────────────────────────
    //  실측 곡선의 붕괴 회차는 cached 가 0 이 아니라 **정확히 3,456**(맨 앞 조각만 걸림)
    //  이었다. cached=0 인 픽스처만 쓰면 `input - cached` 를 `input` 으로 바꿔도 값이
    //  같아 통과한다(실제로 변이 검사에서 생존했다).
    const partial = newTally();
    addUsage(partial, { inputTokens: 100_000, cachedTokens: 3_456 });
    out.push(
      assert(
        "적중 3.4% 는 붕괴이고, 붕괴분은 적중분을 뺀 96,544",
        partial.collapses === 1 && partial.collapseMissed === 96_544,
        `collapses=${partial.collapses} missed=${partial.collapseMissed}`,
      ),
    );

    // ── 정상 턴은 침묵 (매 턴 warn = 배경소음이 되어 12일 묻힌 전례) ──────────
    const ok = newTally();
    addUsage(ok, { inputTokens: 100_000, cachedTokens: 95_000 });
    out.push(assert("붕괴 0건이면 한 줄도 안 낸다", describeTally(ok, "m") === null, "null"));

    // ── 임계 경계 ─────────────────────────────────────────────────────────────
    out.push(
      assert(
        `적중 ${CACHE_COLLAPSE_HIT_PCT}% 미만만 붕괴(경계 포함 여부 고정)`,
        isCollapse({ inputTokens: 100, cachedTokens: 19 }) &&
          !isCollapse({ inputTokens: 100, cachedTokens: 20 }),
        "19%=붕괴 · 20%=정상",
      ),
      // input 0 을 붕괴로 세면 빈 iteration 이 통계를 오염시킨다(잴 게 없는 것 ≠ 못 탄 것).
      assert("input 0 은 붕괴가 아니다", !isCollapse({ inputTokens: 0 }), "false"),
    );
    const empty = newTally();
    addUsage(empty, { inputTokens: 0 });
    out.push(
      assert("input 0 iteration 은 붕괴 카운트를 안 올린다", empty.collapses === 0, empty.collapses),
    );

    // ── cachedTokens 미보고 = 적중 0 (undefined 를 조용히 통과시키지 않는다) ──
    const noneReported = newTally();
    addUsage(noneReported, { inputTokens: 50_000 });
    out.push(
      assert(
        "cachedTokens 미보고 = 적중 0 → 붕괴 + 미적중 전액",
        noneReported.collapses === 1 && noneReported.collapseMissed === 50_000,
        `collapses=${noneReported.collapses} missed=${noneReported.collapseMissed}`,
      ),
    );

    return out;
  },
};
