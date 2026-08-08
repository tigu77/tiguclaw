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
    const midClaimsAnalysis =
      mid !== undefined &&
      /분석/.test(mid.description) &&
      !new RegExp(`분석[^.。]*${top?.name ?? "deep"}`).test(mid.description);

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
