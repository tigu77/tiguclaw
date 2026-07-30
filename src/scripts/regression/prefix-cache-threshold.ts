/**
 * 회귀: **캐시 식음 판정 임계가 실측 경계를 지킨다** (2026-07-30).
 *
 * 사고: 처음엔 임계를 "적중률 10% 미만" 으로 **직감으로** 뒀다. 그런데 이 작업 자체를
 * 촉발한 조건 — 단일턴 적중률 11.7% — 이 그 임계를 넘어 **침묵**한다. 원래 사고를 못 잡는
 * 그물을 "이제 잡힌다"며 넣을 뻔했다. 라이브 표본으로 다시 잡았다:
 *
 *   배포 전 codex `cachedTokens` 분포 — 0:13턴 / 1~3,999:48턴 / 4,000~9,999:8턴 /
 *   10,000~19,999:31턴 / 20,000+:46턴.  **정확히 3,456 인 턴 48개** = 사고의 지문
 *   (sysprompt 19,385B 만 적중, 조립 프리픽스는 캐시 밖).
 *   정상 상태 = sysprompt + 안정 스캐폴딩 49,468B ≈ 8,800 토큰 이상 적중.
 *
 * 비율이 아니라 **절대 바닥**으로 봐야 하는 이유: 비율은 다중 iteration 턴의 턴-내
 * 재사용이 분자를 부풀려 두 모집단(단일 11.7% vs 다중 49~62%)이 섞인다.
 *
 * 이 검사는 그 경계를 **실측 수치로 못박는다** — 누가 상수를 만지면 아래 표가 깨진다.
 */
import { isPrefixCacheCold } from "../../core/llm-runtime/index.js";
import { sourceHas } from "./_wiring.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

/** [설명, inputTokens, cachedTokens, 식었다고 봐야 하나] — 전부 라이브 실측에서 온 값. */
const CASES: Array<[string, number, number, boolean]> = [
  ["★사고의 지문 — sysprompt 만 적중(3,456)", 29_635, 3_456, true],
  ["완전 콜드(0)", 33_239, 0, true],
  ["정상 — 안정 스캐폴딩까지 적중(≈8,800)", 33_239, 8_800, false],
  ["정상 — 히스토리까지 적중", 101_642, 98_688, false],
  ["경계 바로 아래", 20_000, 5_999, true],
  ["경계 바로 위", 20_000, 6_000, false],
  // 소형 턴은 캐시 최소단위(1,024) 근처라 원래 못 탄다 — 오탐 0.
  ["소형 턴은 판정 안 함", 500, 0, false],
  // 미보고 어댑터(예전 openai)는 조용히 넘어간다 — 거짓 경보 0.
  ["cachedTokens 미보고면 판정 안 함", 50_000, Number.NaN, false],
];

export const check: RegressionCheck = {
  name: "prefix-cache-threshold",
  guards:
    "캐시 식음 판정 임계가 정작 원래 사고(단일턴 11.7%·cached 3,456)를 못 잡던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const wrong: string[] = [];
    for (const [label, inputTokens, cachedTokens, expected] of CASES) {
      const got = isPrefixCacheCold({
        inputTokens,
        cachedTokens: Number.isNaN(cachedTokens) ? undefined : cachedTokens,
      });
      if (got !== expected) wrong.push(`${label}(기대 ${expected}, 실제 ${got})`);
    }
    out.push(
      assert(
        "★실측 경계표 — 사고의 지문은 잡고 정상은 안 운다",
        wrong.length === 0,
        wrong.length === 0 ? `${CASES.length}건 전부 일치` : wrong.join(" / "),
      ),
    );
    // ★비율 판정으로 되돌아가는 것 자체를 막는다 — 그게 원래 실수였다.
    //  (적중률 11.7% 는 10% 임계를 넘어 침묵했다.)
    out.push(
      assert(
        "★비율(11.7%)로는 못 잡던 케이스를 절대 바닥으로는 잡는다",
        isPrefixCacheCold({ inputTokens: 29_635, cachedTokens: 3_456 }) &&
          3_456 / 29_635 > 0.1,
        `비율 ${((3456 / 29635) * 100).toFixed(1)}% (>10% 라 옛 임계는 침묵) / 절대 바닥으론 식음`,
      ),
    );
    // 배선 — 판정이 실제로 호출되고, 콜드 오탐 방지 카운터가 붙어 있다.
    const w = await sourceHas("../../core/llm-runtime/index.ts", [
      /warnIfPrefixCacheCold\(spec, input, output\);/,
      /isPrefixCacheCold\(\{ inputTokens, cachedTokens: cached \}\)/,
      /streak < PREFIX_CACHE_COLD_STREAK/,
      // 턴-내 재사용이 섞이는 Total 을 쓰면 신호가 죽는다 — 호출 단위 값이어야 한다.
      /const inputTokens = output\.usage\?\.inputTokens;/,
    ]);
    out.push(
      assert(
        "★판정이 호출되고, 연속 카운터 + 호출 단위 값을 쓴다",
        w.ok,
        w.ok ? "4개 배선 확인" : `누락 ${w.missing.join(" ")}`,
      ),
    );

    // ★성공도 로그에 남는다 — 없으면 **원격 인스턴스**(회사돌쇠·회사PC·윈도우)에서 개선
    //  여부를 영영 확인 못 한다(실제로 로그 284줄에 usage 0건이라 못 쟀다). 경고는
    //  "나쁠 때만" 이므로 정상 구간을 증명할 수단이 따로 있어야 한다.
    const r = await sourceHas("../../core/llm-runtime/index.ts", [
      /accumulatePrefixCacheRollup\(spec, output\);/,
      /적중률 \$\{overall\}%/,
      // 롤업 분모는 **턴 합계**(Total 우선) — 하네스가 실제로 태운 총량이 알고 싶은 값.
      /output\.usage\?\.inputTokensTotal \?\? output\.usage\?\.inputTokens/,
    ]);
    out.push(
      assert(
        "★정상 구간도 주기 롤업으로 로그에 남는다(원격 인스턴스 측정 가능)",
        r.ok,
        r.ok ? "3개 배선 확인" : `누락 ${r.missing.join(" ")}`,
      ),
    );
    return out;
  },
};
