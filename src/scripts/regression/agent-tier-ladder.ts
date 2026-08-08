/**
 * 회귀: **티어 사다리에 올라가는 화살표가 있다** (2026-08-08).
 *
 * 사고: "충분히 분석해봐" 라는 **고난도 탐색**을 `general`(mid) 6명이 맡았다. 발견 실패도
 * 판단력 부족도 아니었다 — **설명이 그렇게 유도했다.**
 *
 *   quick   난이도로 자기를 규정("작고 명확")        위로 보내는 말 ✗
 *   general ★**모양**으로 자기를 규정("명세 없이")    위로 보내는 말 ✗
 *   deep    난이도로 자기를 규정("틀리면 비싼")       아래로만 밀어냄 ✓
 *
 * 두 가지가 겹쳤다. ①사다리에 **내려가는 화살표만** 있어서 불확실한 일이 전부 가운데
 * 고인다. ②`general` 만 선택 기준의 **축이 달랐다**(난이도 vs 명세 유무) — 축이 다르면
 * 경쟁이 성립하지 않아 "분석이면서 명세 없는" 일에 둘 다 해당되고 모델은 아무거나 고를 수
 * 있다. 실제로 모델 프로파일은 `high = 고난도(설계·분석)` 라고 **명시**돼 있는데도 mid 가
 * 분석을 가져갔다.
 *
 * ★이 검사는 **이름 목록을 새로 만들지 않는다.** 티어 순서를 `model:` frontmatter(low<mid
 * <high)에서 **뽑아** 정렬하고, "최상위가 아닌 티어는 자기보다 위를 가리켜야 한다" 는
 * 판정만 한다. 티어 에이전트가 늘거나 이름이 바뀌어도 따라온다.
 *
 * ★적대 검토가 "`explore` 가 멤버에서 빠졌다" 를 결함으로 지적했다(2026-08-08). **판단이
 *  갈렸고, 여기 남긴다**: `explore` 는 티어를 갖되 **역할로 선택**된다(무엇을 맡나) — 난이도
 *  칸(quick↔general↔deep) 사이에 끼지 않으므로 사다리 멤버가 아니다. 그래서 멤버 판정은
 *  설명이 스스로 밝힌 "범용" 그대로 둔다.
 *  ★한 번 "역할형도 이웃을 가리켜야 한다" 단언을 넣어봤다가 **물렸다** — `code-review`·
 *   `skill-eval-*` 처럼 스킬이 이름으로 부르는 에이전트까지 화살표를 요구하게 되는데,
 *   그런 사고는 없었다. **근거 없는 규칙은 만들지 않는다.**

 * ─────────────────────────────────────────────────────────────────────────────
 * ★등급: **배선 린트** (2026-08-08 레드팀 결과 표시)
 *  이 파일의 단언 상당수는 **소스를 훑는다** — 코드가 그렇게 *쓰여 있는지*는 보지만
 *  그렇게 *동작하는지*는 못 본다. `if (false)`·env 게이트·조건 강화·동의어 치환으로
 *  전부 우회된다(레드팀이 13개 변이로 실증했고 7개를 동시에 넣어도 전 스위트 초록이었다).
 *  ★그러니 **우연한 드리프트는 잡지만 적은 못 막는다.** 행동을 지켜야 하는 축은 판정을
 *   순수 함수로 뽑아 **실행**해야 한다(`swallowed-failure.ts` 가 그 예).
 *  등급을 적어 두는 이유: 지키지도 못하면서 지킨다고 적어둔 검사가 가장 나쁘다 —
 *  다음 사람이 "여긴 그물이 있다" 고 믿고 지나간다.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

/** 낮을수록 값싼 티어. 여기 없는 model 값(opus/sonnet 등 역할형)은 사다리 대상이 아니다. */
const TIER_RANK: Record<string, number> = { low: 0, mid: 1, high: 2 };

type TierAgent = { name: string; rank: number; description: string };

const readTierAgents = async (dir: string): Promise<TierAgent[]> => {
  const out: TierAgent[] = [];
  for (const f of await readdir(dir)) {
    if (!f.endsWith(".md")) continue;
    const raw = await readFile(path.join(dir, f), "utf8");
    const model = /^model:\s*(\S+)\s*$/m.exec(raw)?.[1];
    const description = /^description:\s*(.+)$/m.exec(raw)?.[1] ?? "";
    // ★사다리 멤버 판정 = **범용**(any-task) 인가. 역할형(code-review·skill-eval-*)도 티어
    //  model 값을 쓰지만 사다리가 아니다 — 그것들은 "무엇을 맡나"로 뽑히지 "얼마나 어렵나"로
    //  뽑히지 않는다. 이름을 열거하는 대신 설명이 스스로 밝힌 성질로 가른다.
    if (model === undefined || !(model in TIER_RANK)) continue;
    // ★사다리 멤버 = **난이도로 뽑히는** 에이전트다. 그건 설명이 스스로 "범용" 이라고
    //  밝힌다 — 역할형(code-review·explore·skill-eval-*)은 *무엇을 맡나*로 뽑히지
    //  *얼마나 어렵나*로 뽑히지 않는다.
    //  ★검토자는 `explore` 가 빠진 걸 결함으로 봤지만, 판단이 갈린다: explore 는 티어를
    //   갖되 **역할로 선택**되므로 사다리의 칸이 아니다(quick↔general↔deep 사이에 끼지
    //   않는다). 대신 "역할형도 옆으로 넘길 말을 갖는가" 를 아래에서 따로 본다 —
    //   그게 그 지적의 실질이다(explore 의 화살표가 아무 검사도 안 받고 있었다).
    if (!description.includes("범용")) continue;
    out.push({ name: f.replace(/\.md$/, ""), rank: TIER_RANK[model]!, description });
  }
  return out.sort((a, b) => a.rank - b.rank);
};

export const check: RegressionCheck = {
  name: "agent-tier-ladder",
  guards:
    "티어 범용 에이전트 설명이 상위 티어를 가리킨다 — 불확실한 일이 중간 티어에 고이지 않게",
  run: async (): Promise<Assertion[]> => {
    const dir = new URL("../../../agents", import.meta.url).pathname;
    const tiers = await readTierAgents(dir);
    const top = tiers[tiers.length - 1];

    const missingUp = tiers
      .filter((a) => a !== top)
      .filter((a) => !tiers.some((h) => h.rank > a.rank && a.description.includes(h.name)))
      .map((a) => a.name);

    // ★"분석" 이 어느 티어에 귀속되는가 — 사고의 핵심. 최상위가 그 말을 갖고 있어야 하고,
    //  중간 티어는 그 말을 자기 것으로 주장하면 안 된다(주장하면 다시 가운데로 고인다).
    const mid = tiers.find((a) => a.rank === TIER_RANK.mid);
    // ★절 단위로 본다 (2026-08-08 적대 검토). 종전엔 `분석[^.。]*deep` 하나만 맞으면
    //  통과라, "분석은 여기서 한다. 아주 어려운 분석만 deep 으로." 처럼 **뒤에 한 번**
    //  언급하는 것으로 앞의 소유 주장을 덮을 수 있었다(검토자 변이가 그대로 통과).
    //  이제 '분석' 이 든 **모든 절**이 상위 티어를 가리켜야 한다.
    const midClauses = (mid?.description ?? "")
      .split(/[.。\n]/)
      .filter((c) => c.includes("분석"));
    const midClaimsAnalysis =
      mid !== undefined &&
      midClauses.length > 0 &&
      midClauses.some((c) => !c.includes(top?.name ?? "deep"));

    return [
      assert(
        "티어가 3단 이상 발견된다(사다리 자체가 존재)",
        tiers.length >= 3,
        tiers.map((t) => `${t.name}(${t.rank})`).join(" < ") || "없음",
      ),
      assert(
        "★최상위가 아닌 티어는 **자기보다 위 티어를 가리킨다**(올라가는 화살표)",
        missingUp.length === 0,
        missingUp.length === 0 ? "전부 있음" : `없음: ${missingUp.join(",")}`,
      ),
      assert(
        "★최상위 티어가 '분석'을 자기 몫으로 명시한다",
        top !== undefined && /분석/.test(top.description),
        top === undefined ? "최상위 없음" : `${top.name}: ${/분석/.test(top.description)}`,
      ),
      assert(
        "★중간 티어가 '분석'을 자기 것으로 주장하지 않는다(위로 넘길 때만 언급)",
        !midClaimsAnalysis,
        mid === undefined ? "중간 없음" : `${mid.name}`,
      ),
    ];
  },
};
