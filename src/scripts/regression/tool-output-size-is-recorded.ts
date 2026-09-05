/**
 * 회귀: **도구가 컨텍스트에 얼마나 얹었는지 잰다** (2026-09-05).
 *
 * 왜 필요했나 — 실사용 41일 실측에서 비용의 **58%가 정가 input** 이었고, 그중
 * **86~91%가 «턴이 진행되며 쌓이는 내용»** 이었다(콜드 프리픽스는 9~14%뿐).
 * 즉 돈을 쥔 손잡이는 프리픽스 크기가 아니라 **도구가 돌려주는 양**이다. 그런데
 * 그걸 재는 자리가 없었다 — `output.text` 는 프리뷰(40줄·4,000자 캡)라 큰 결과가
 * 전부 4,000 에서 평평해지고, `detail` 은 160자 컷이다.
 *
 * ★그래서 **캡을 적용하기 전에** 원본 길이를 잰다. 캡 뒤에 재면 «어느 도구가 큰가» 라는
 *  질문 자체가 사라진다 — 이 레포가 여러 번 겪은 «측정이 답을 미리 지워버리는» 부류다.
 *
 * ★자리는 공유 빌더 하나다(`_activity-output.ts`) — 세 어댑터가 전부 지나므로 어댑터
 *  변경 0으로 LLM 무관이 성립한다([[feedback_every_feature_llm_agnostic]]).
 *
 * ★문자 수이지 토큰이 아니다. 토큰은 어댑터·모델마다 다르고 여기선 알 수 없다 —
 *  「잰 것」과 「환산한 것」을 섞지 않으려고 원시값만 남긴다.
 *
 * ★한계(정직하게): 결과를 든 활동(`phase:"end"`) 중 **94%**만 덮는다. 나머지 6%는
 *  `OUTPUT_EXCLUDED_TOOLS`(Edit·Write 등 — diff 로 따로 렌더)라 `output` 자체가 없다.
 *  그 도구들의 결과는 짧은 확인 문구라 지금은 덮지 않는다.
 */
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";
import { buildActivityOutput } from "../../core/llm-runtime/adapters/_activity-output.js";

export const check: RegressionCheck = {
  name: "tool-output-size-is-recorded",
  guards:
    "도구 결과가 프리뷰 캡(4,000자)에서 평평해져 «어느 도구가 컨텍스트를 얼마나 먹나» 를 사후에 물을 수 없던 것 — 비용의 절반 이상이 그 축인데 재는 자리가 없었다",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const big = Array.from({ length: 500 }, (_, i) => `line ${i} ${"x".repeat(50)}`).join("\n");

    // ── ① 캡을 넘는 결과에서도 **원본 크기**가 남는다 ─────────────────────────
    const o = buildActivityOutput("Bash", big);
    out.push(
      assert(
        "★★프리뷰가 캡에서 잘려도 원본 크기가 남는다 — 캡 뒤에 재면 큰 결과가 전부 같은 값으로 평평해진다",
        o?.fullChars === big.length && o?.truncated === true,
        o === undefined
          ? "★output 자체가 없다"
          : `원본 ${big.length} · 프리뷰 ${o.text.length} · fullChars ${o.fullChars ?? "없음"}`,
      ),
    );
    out.push(
      assert(
        "프리뷰는 여전히 캡을 지킨다(크기를 재느라 본문을 통째로 싣지 않는다)",
        (o?.text.length ?? 0) < big.length / 2,
        `프리뷰 ${o?.text.length ?? 0}자 / 원본 ${big.length}자`,
      ),
    );

    // ── ② 작은 결과도 정확하다(캡 미만이면 프리뷰 == 원본) ────────────────────
    const small = buildActivityOutput("Bash", "ok");
    out.push(
      assert(
        "작은 결과의 크기가 정확하다",
        small?.fullChars === 2,
        `fullChars=${small?.fullChars ?? "없음"} (기대 2)`,
      ),
    );

    // ── ③ ★캡 전에 잰다 — 서로 다른 큰 결과가 **다른 값**을 낸다 ──────────────
    //  이게 이 검사의 핵심이다. 캡 뒤에 재면 둘 다 4,000 근처로 같아진다.
    const bigger = big + "\n" + big;
    const a = buildActivityOutput("Read", big);
    const b = buildActivityOutput("Read", bigger);
    const distinct = a?.fullChars !== b?.fullChars && (b?.fullChars ?? 0) > (a?.fullChars ?? 0);
    out.push(
      assert(
        "★★크기가 다른 두 결과가 **다른 값**으로 기록된다(캡 뒤에 재면 둘 다 같아진다)",
        distinct,
        `${a?.fullChars ?? "없음"} vs ${b?.fullChars ?? "없음"} · 프리뷰는 ${a?.text.length} vs ${b?.text.length}`,
      ),
    );

    // ── ④ 빈 결과는 여전히 아무것도 안 만든다 ────────────────────────────────
    const empty = buildActivityOutput("Bash", "");
    const nul = buildActivityOutput("Bash", undefined);
    out.push(
      assert(
        "빈 결과는 output 을 만들지 않는다(0 을 박아 «잰 것»처럼 보이게 하지 않는다)",
        empty === undefined && nul === undefined,
        `빈문자열→${empty === undefined ? "undefined" : JSON.stringify(empty)} · undefined→${nul === undefined ? "undefined" : JSON.stringify(nul)}`,
      ),
    );

    return out;
  },
};
export default check;
