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
    // 옛 형태 재도입 감시용 — 주석은 벗긴다(설명하는 글이 판정을 흔들면 안 된다).
    const { readFile } = await import("node:fs/promises");
    const { stripComments } = await import("./_wiring.js");
    const claudeCode = stripComments(
      await readFile(
        new URL("../../core/llm-runtime/adapters/claude-agent-sdk.ts", import.meta.url),
        "utf8",
      ),
    );
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
        // ★2026-08-16: 합계를 **비워두지 않는다**. 종전엔 `usageEntry` 가 없으면 `*Total`
        //  을 통째로 생략했는데, 게이트웨이 턴은 그게 비는 경우가 있어 24시간 200턴 중
        //  **172턴**이 합계 없이 기록됐고 세는 쪽이 **0으로** 읽었다. 사용량을 물었을 때
        //  답이 틀리는데 에러도 로그도 없다("조용한" 부류). 한 번 호출로 끝난 턴은
        //  **호출값이 곧 턴 합계**다 — 이 어댑터의 함수콜 경로가 이미 같은 판단을 쓴다.
        /const inTot = haveCum \? cumInput : perCall\?\.input;/,
        /inputTokensTotal: inTot,/,
        // 단발 호출 턴은 iterations=1 로 정직하게(2 로 지어내지 않는다).
        /iterations: haveCum[\s\S]{0,200}?: 1,/,
        // ★출력량의 최종값은 `message_delta` 에서 온다 (2026-08-05, SDK 0.3 부작용).
        //  0.3 부터 `assistant` 메시지 usage 는 **message_start 스냅샷**이라
        //  `output_tokens: 1` 플레이스홀더다. 그걸 쓰면 **모든 턴의 outputTokens 가 1 로
        //  붕괴**한다(실측: 라이브 turn_done=1·벤치 중앙값 1, 업그레이드 전 같은 태스크는
        //  1,221). 타입 이름이 그대로라 타입체크·회귀·한 턴 성공이 전부 통과했다 —
        //  잡은 건 벤치 A/B 뿐이었다. 배선을 여기 박아 다음 업그레이드에 다시 안 흘리게.
        /=== "message_delta"/,
        /output: u\.output_tokens,/,
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
        "★합계를 비워두지 않는다(집계가 조용히 0이 되던 것 — 24h 172턴)",
        !/\.\.\.\(usageEntry !== undefined && cumInput > 0\s*\?\s*\{/.test(claudeCode),
        "옛 조건(합계 통째 생략) 0곳",
      ),
      assert(
        "★캐시 적중률 판정이 어댑터 무관 한 곳에서 실제로 호출된다",
        runtime.ok,
        runtime.ok ? "정의+호출 확인" : `누락 ${runtime.missing.join(" ")}`,
      ),
    ];
  },
};
