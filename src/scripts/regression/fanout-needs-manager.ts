/**
 * 회귀: **팬아웃 판정이 헌법에 있고, 옆 문장이 그걸 무력화하지 않는다** (2026-08-08).
 *
 * 사고: "충분히 티구클로를 분석해봐" 한 마디에 메인 턴이 서브에이전트 10명을 **전경에서**
 * 뿌려 대화가 **8분 37초** 멈췄다(매니저 실행 0건). 규칙이 없어서가 아니었다 — 있었는데
 * **두 질문이 한 축에 뭉쳐** 있었다:
 *   §위임과 규모 = **누가** 하나(직접/1명/팀) · 46행 = **어디서** 하나(전경/백그라운드)
 * "분석" 은 §21 의 ①직접(조회·감사)과 46행의 "긴 조사" **양쪽에 걸린다.** 직접을 고르는
 * 순간 46행의 질문은 아예 안 물어지고, 그러고도 일이 크니 **전경에서 팬아웃**한다.
 *
 * 그래서 **셀 수 있는 판정**을 넣었다(사용자 제안): 서브에이전트 2명 이상 = 지휘가 필요한
 * 순간. 근거는 감이 아니라 실측 — 서브에이전트 181건 중앙값 **107초**, 78%가 1분 이상이라
 * **1명만 띄워도 대화가 2분 가까이 멈춘다**. 2는 빡빡한 게 아니라 느슨한 편이다.
 *
 * ★이 검사의 핵심은 두 번째 단언이다. 46행엔 "강제 규칙은 아니다" 가 있었는데, 새 판정
 * 바로 옆에서 그 문장이 읽히면 **새 규칙까지 같이 무력화된다** — 한 문단 안 모순이 중복
 * 발주 사고를 냈던 그 기제다(2026-07-27). 그래서 그 완화는 *시간* 판단으로 한정하고
 * 개수 판정의 정본이 어디인지 명시했다.
 */
import { readFile } from "node:fs/promises";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "fanout-needs-manager",
  guards:
    "서브에이전트 2명 이상이면 매니저 — 판정이 헌법에 있고 옆 문장이 무력화하지 않는다",
  run: async (): Promise<Assertion[]> => {
    const sys = await readFile(new URL("../../../SYSTEM.md", import.meta.url), "utf8");
    const lines = sys.split("\n");

    const ruleIdx = lines.findIndex(
      (l) => l.includes("2명 이상") && l.includes("매니저"),
    );
    const rule = ruleIdx === -1 ? "" : lines[ruleIdx]!;
    // 완화 문구가 있는 줄 — 있으면 그 줄이 개수 판정을 건드리지 않는지 본다.
    const softIdx = lines.findIndex((l) => l.includes("강제"));
    const soft = softIdx === -1 ? "" : lines[softIdx]!;

    return [
      assert(
        "★팬아웃 판정이 헌법에 있다(서브에이전트 2명 이상 → 매니저)",
        ruleIdx !== -1,
        ruleIdx === -1 ? "★없음" : `${ruleIdx + 1}행`,
      ),
      assert(
        "★완화 문구가 개수 판정까지 풀어주지 않는다(옆 문장이 옆 규칙을 죽이지 않게)",
        // 완화가 아예 없거나(=풀어줄 게 없다), 있다면 **시간 판단 한정**임을 명시해야 한다.
        soft === "" || (soft.includes("시간") && soft.includes("개수 판정")),
        soft === "" ? "완화 문구 없음" : `${softIdx + 1}행: 한정 명시=${soft.includes("개수 판정")}`,
      ),
      assert(
        "판정이 **전경/백그라운드**를 규모와 다른 축으로 세운다(둘이 뭉치면 안 물어진다)",
        rule.includes("다른 축"),
        rule.includes("다른 축") ? "축 분리 명시" : "★축 분리 없음",
      ),
      assert(
        "메인 턴에만 적용된다고 밝힌다(매니저 안에서는 그대로 팬아웃 — 자기 금지 방지)",
        rule.includes("메인 턴"),
        rule.includes("메인 턴") ? "범위 명시" : "★범위 없음",
      ),
      assert(
        "★모델 대면 문장이 '워커' 가 아니라 '매니저' 를 쓴다(2026-07-29 개명 — 도구명은 예외)",
        // 도구 이름(run_in_background·list_workers)은 식별자라 그대로 둔다. 산문만 본다.
        !sys.replace(/`[^`]*`/g, "").includes("워커"),
        `산문 '워커' ${sys.replace(/`[^`]*`/g, "").split("워커").length - 1}건`,
      ),
    ];
  },
};
