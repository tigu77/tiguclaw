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
import { readFile } from "node:fs/promises";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

/**
 * 옛 이름 — **런타임에 조립한다.** 리터럴로 두면 이 파일 자신이 그 단어를 담게 되고,
 * 그러면 `manager-naming-is-one-word` 가 자기를 감시하는 검사를 잡는다(2026-08-29에
 * 일괄 치환이 실제로 이 문장을 `'매니저' 가 아니라 '매니저'` 로 만들었다).
 */
const OLD = ["\uc6cc", "\ucee4"].join("");

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
    // ★완화가 붙은 **그 줄**만 본다 (2026-08-08 적대 검토). 종전엔 `"강제"` 부분 문자열로
    //  첫 줄을 찾았는데, SYSTEM.md 엔 "강제" 가 세 곳(위임 완화·파괴적 행위·규칙 강제)에
    //  있어 **문단 순서에 의존**했다. 검토자가 완화 문구를 *제거*(= 더 안전한 상태)하자
    //  엉뚱한 문단을 집어 FAIL 했다 — 개선을 처벌하는 가짜 빨강.
    //  대상은 "시간 판단으로 오래 걸리면 매니저" 를 말하는 줄, 즉 그 도구를 든 줄이다.
    const softIdx = lines.findIndex(
      (l) => l.includes("run_in_background") && l.includes("강제"),
    );
    const soft = softIdx === -1 ? "" : lines[softIdx]!;

    const out: Assertion[] = [
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
        "★두 숫자(팀 3 · 팬아웃 2)가 **다른 축**임을 명시한다 — 안 하면 새 규칙이 3+ 에서만 사는 것처럼 읽힌다",
        // 검토자 지적: §갈래의 "3개 이상"과 이 규칙의 "2명 이상"이 나란히 있으면, 정확히
        // 2갈래인 작업에서 앞 규칙이 "내려가라" 하므로 이 규칙이 **잡는 창이 없어 보인다**.
        // 실제로는 다른 것을 센다(누가 하나 / 어디서 하나) — 그걸 문장으로 말해야 한다.
        rule.includes("다른 것을 센다"),
        rule.includes("다른 것을 센다") ? "축 구분 명시" : "★숫자만 있고 구분 없음",
      ),
      assert(
        "★쪼개기 문단의 팬아웃도 같은 판정을 받는다(조건절로 빠져나갈 창 0)",
        // 종전 문구 "규모가 커 위임했으면 그 팬아웃도 매니저 안에서" 는 조건절이라
        // "위임 안 했으면 전경 팬아웃해도 된다" 로 읽혔다 — 22행이 금지하는 바로 그것.
        !sys.includes("규모가 커 위임했으면 그 팬아웃도"),
        sys.includes("위 판정을 그대로 받는다") ? "무조건" : "★조건절 잔존",
      ),
      assert(
        "메인 턴에만 적용된다고 밝힌다(매니저 안에서는 그대로 팬아웃 — 자기 금지 방지)",
        rule.includes("메인 턴"),
        rule.includes("메인 턴") ? "범위 명시" : "★범위 없음",
      ),
      assert(
        `★모델 대면 문장이 '${OLD}' 가 아니라 '매니저' 를 쓴다(2026-07-29 개명 — 도구명은 예외)`,
        // 도구 이름(run_in_background·list_workers)은 식별자라 그대로 둔다. 산문만 본다.
        !sys.replace(/`[^`]*`/g, "").includes(OLD),
        `산문 '${OLD}' ${String(sys.replace(/`[^`]*`/g, "").split(OLD).length - 1)}건`,
      ),
    ];

    // ── ★배포 스킬도 이 규칙을 지킨다 (2026-08-24 지침 검토) ─────────────────────
    //  이 검사는 `SYSTEM.md` **한 파일만** 읽고 있었다. 그래서 `skills/code-review` 가
    //  "오케스트레이션은 **메인 턴이 직접** 수행한다"(= 전경 팬아웃)를 시키고 있어도
    //  초록이었다 — 그 스킬은 규칙이 태어난 사고(2026-08-08, 전경 10명 팬아웃으로 대화가
    //  8분 37초 멈춘 것) **이전**에 쓰였고, 규칙이 생긴 뒤 아무도 대조하지 않았다.
    //  ★헌법이 금지한 것을 **배포되는 글이 시키면** 사용자는 그 글을 따른다.
    //   규칙이 사는 파일만 지키는 게이트는 규칙을 지키는 게 아니다.
    const { readdir } = await import("node:fs/promises");
    const offenders: string[] = [];
    for (const root of ["../../../skills", "../../../agents"]) {
      let entries: string[] = [];
      try {
        entries = (await readdir(new URL(root, import.meta.url), {
          recursive: true,
        })) as string[];
      } catch {
        continue; // 없으면 대상 아님(배포 레포 차이).
      }
      for (const rel of entries) {
        if (!rel.endsWith(".md")) continue;
        let body = "";
        try {
          body = await readFile(new URL(`${root}/${rel}`, import.meta.url), "utf8");
        } catch {
          continue;
        }
        for (const line of body.split("\n")) {
          if (!/메인\s*(턴)?\s*이\s*직접/.test(line)) continue;
          if (!/팬아웃|spawn|서브에이전트/.test(line)) continue;
          // 금지를 **설명**하는 줄은 제외(과거형·전환 문구).
          // solo(팬아웃 0)는 규칙 대상이 아니고, 과거형·전환 서술은 지시가 아니다.
          if (/팬아웃\s*0|solo/i.test(line)) continue;
          if (/였|종전|금지|넘긴|넘겨|안 된다|매니저/.test(line)) continue;
          offenders.push(`${root.split("/").pop()}/${rel}`);
        }
      }
    }
    out.push(
      assert(
        "★배포 스킬·에이전트가 전경 팬아웃을 시키지 않는다(헌법과 반대로 말하지 않는다)",
        offenders.length === 0,
        offenders.length === 0
          ? "skills/·agents/ 전수 — 위반 0"
          : `★${[...new Set(offenders)].join(" / ")}`,
      ),
    );
    return out;
  },
};
