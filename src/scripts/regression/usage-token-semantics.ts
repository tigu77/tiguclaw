/**
 * 회귀: **`inputTokens`=마지막 호출 1회 / `*Total`=턴 합계** — 세 어댑터 공통 (2026-07-30).
 *
 * 사고는 **두 겹**이었고 둘 다 라이브 DB 실측으로 드러났다.
 *
 * ①의미 역전: OpenAI `input_tokens` 는 캐시 적중을 *포함*하는데 Anthropic 은 캐시 읽기를
 *  *제외*한 증분만 준다. 실측 `inputTokens=8, cachedTokens=390,392` → `/status` 컨텍스트
 *  경고가 claude 에선 늘 ~0% 라 70%/85% 알림이 한 번도 안 떴다.
 *
 * ②축 혼동(①을 고치다 들어옴): `result.modelUsage[model]` 은 마지막 호출값이 아니라
 *  **턴 안 모든 호출의 누적합**이다. 실측 한 턴 `cachedTokens=10,182,800` = 200K 창의
 *  **50.9배**(단일 호출로는 물리적으로 불가능). 그대로 inputTokens 에 넣으면 /status 가
 *  "컨텍스트 ~3293%" 를 띄우고 85% 경고가 상시 울린다 — 방향만 반대인 같은 실패.
 *
 * 계약(types.ts §usage)은 원래부터 두 축을 나눠 뒀다: `inputTokens`="얼마나 찼나"(마지막
 * 호출), `*Total`="진짜 비용"(턴 합계). codex 는 지켰고 claude 만 안 지켰다. 그래서
 * 호출 단위 값은 assistant 메시지 usage 에서 잡고, 누적은 Total 로 보낸다.
 *
 * 배선을 검사한다(SDK 응답 없이는 재현 불가). 배포본엔 `.ts` 가 없어 읽기 실패는 통과.
 */
import { sourceHas } from "./_wiring.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "usage-token-semantics",
  guards:
    "claude 가 inputTokens 에 턴 누적합을 실어 /status 컨텍스트 %가 0% 또는 3293% 로 틀리던 것(두 방향 모두)",
  run: async (): Promise<Assertion[]> => {
    const claude = await sourceHas(
      "../../core/llm-runtime/adapters/claude-agent-sdk.ts",
      [
        // 호출 단위 usage 를 assistant 메시지에서 잡고 — 캐시 읽기+생성을 더한 "실제 입력"
        /let lastCallUsage:/,
        /u\.input_tokens \+\n\s*\(u\.cache_read_input_tokens \?\? 0\) \+\n\s*\(u\.cache_creation_input_tokens \?\? 0\)/,
        // ★서브에이전트 내부 호출은 부모 컨텍스트가 아니다 — parent 게이트가 있어야 한다.
        /if \(typeof parentToolUseId !== "string"\) \{/,
        // inputTokens 는 **호출 단위**, Total 은 누적 — 두 축을 섞지 않는다.
        /inputTokens: perCall\?\.input \?\? cumInput,/,
        /inputTokensTotal: cumInput,/,
      ],
    );
    const runtime = await sourceHas("../../core/llm-runtime/index.ts", [
      /const warnIfPrefixCacheCold = \(/,
      /warnIfPrefixCacheCold\(spec, input, output\);/,
    ]);
    return [
      assert(
        "★claude 가 호출 단위(inputTokens)와 턴 합계(*Total)를 분리해 싣는다",
        claude.ok,
        claude.ok ? "5개 배선 확인" : `누락 ${claude.missing.join(" ")}`,
      ),
      assert(
        "★캐시 적중률 판정이 어댑터 무관 한 곳에서 실제로 호출된다",
        runtime.ok,
        runtime.ok ? "정의+호출 확인" : `누락 ${runtime.missing.join(" ")}`,
      ),
    ];
  },
};
