/**
 * 회귀: **리뷰는 고치지 않는다 + 부팅 배선이 사라지지 않는다** (2026-09-08).
 *
 * 두 사고가 같은 날 났고 뿌리가 같다 — **«글로만 있고 아무도 안 세는 것»**.
 *
 * ① 정태님: *"코드 리뷰가 수정을 하면 안되는거지"*. 맞는데 그 금지가 **한 줄도 없었다** —
 *    리뷰 서브의 도구엔 `Bash` 가 있어 기술적으로 쓸 수 있다. 이번 실행은 안 썼지만
 *    그건 운이지 설계가 아니다.
 * ② 위젯 자동 편입 호출이 `src/index.ts` 에서 사라졌는데 **회귀 3,029건도 타입체크도
 *    전부 초록**이었다(실측 변이로 확인). 순수 함수는 검사하면서 **부팅 배선은 아무도
 *    안 봤다** — [[feedback_simple_composable_no_duplication]] 「부품은 검사되는데
 *    이음매는 안 검사된다」 그대로다.
 *
 * 등급: 소스 대조. ★한계를 정직하게 — 이 검사는 «금지가 적혀 있나»·«호출이 있나» 까지다.
 *  서브가 그 글을 어기는 것까진 못 막는다(도구 게이트가 아니다).
 */
import { readSourceSync } from "./_wiring.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "review-is-read-only",
  guards:
    "코드 리뷰 서브가 워킹트리를 고칠 수 있는데 금지가 어디에도 안 적혀 있던 것 + 홈 위젯 자동 편입 호출이 부팅에서 사라져도 스위트가 전부 초록이던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];

    // ── ① 리뷰는 읽기 전용 ───────────────────────────────────────────────
    const agent = readSourceSync("agents/code-review.md");
    const skill = readSourceSync("skills/code-review/SKILL.md");
    const banned = ["sed -i", "git checkout", "tee"];
    const missing = banned.filter((b) => !agent.includes(b));
    out.push(
      assert(
        "★★리뷰 서브에게 **읽기 전용**이라고 못 박혀 있다 — 도구에 `Bash` 가 있어 기술적으로는 쓸 수 있으므로, 「할 수 있는데 하지 마라」를 글로 남기지 않으면 지켜지는 게 없다",
        /읽기 전용/.test(agent) && /고치지 않는다/.test(agent),
        `읽기전용=${/읽기 전용/.test(agent)} 고치지않는다=${/고치지 않는다/.test(agent)}`,
      ),
      assert(
        "★금지를 **예시로** 준다 — 「고치지 마라」만 있으면 어디까지가 쓰기인지 모른다(`git show` 는 되고 `git checkout` 은 안 된다)",
        missing.length === 0,
        missing.length === 0 ? `금지 예시 ${banned.length}종` : `★빠진 예시: ${missing.join(", ")}`,
      ),
      assert(
        "★스킬도 «기본은 읽기 전용, 수정은 --fix 를 명시했을 때 **메인이**» 를 말한다 — 서브가 스스로 판단해 고치지 않는다",
        /읽기 전용/.test(skill) && /메인이/.test(skill),
        `스킬 읽기전용=${/읽기 전용/.test(skill)}`,
      ),
    );

    // ── ①-b 스킬 본문이 들고 있어야 할 것 셋 ─────────────────────────────
    // ★종전 그물은 **에이전트 파일만** 봤다 — 스킬에서 같은 규칙을 지워도 초록이었다
    //  (실측 변이 2/2 통과). 스킬은 서브 프롬프트로도 복사되므로 여기가 정본이다.
    const skillChecks: [string, boolean, string][] = [
      [
        "★★사람 수가 **천장 공식**으로 적혀 있다 — `min(묶음 수, 3)`. 「3명」 이라고만 적으면 천장이 **정원**으로 읽혀 매번 다 채운다(작은 변경에 3명이 뜬다)",
        /min\(겹치지 않는 파일 묶음 수, 3\)/.test(skill) && /천장이지 정원이 아니다/.test(skill),
        "천장 공식",
      ],
      [
        "★★**확인 동작을 돌린 뒤에만 보고한다**는 규칙이 있다 — 이게 이 스킬의 적대적 검증 전부다. 지우면 사람을 안 늘린 채 검증만 사라지고, 보고는 더 깨끗해 보인다(가장 나쁜 실패 방향)",
        /확인 동작을 돌리지 않은 발견은 보고하지 않는다/.test(skill),
        "확인 동작 필수",
      ],
      [
        "★스킬 본문도 금지를 **예시로** 준다 — 「고치지 마라」만 있으면 어디까지가 쓰기인지 모른다(`git show` 는 되고 `git checkout` 은 안 된다)",
        ["sed -i", "git checkout", "tee"].every((b) => skill.includes(b)),
        "금지 예시",
      ],
    ];
    for (const [name, ok, label] of skillChecks) {
      out.push(assert(name, ok, ok ? label : `★${label} 없음`));
    }

    // ── ①-b2 ★«안 고쳤다» 를 **대조로 증명**한다 — 도구는 안 박는다 ──────────
    // ★사고: 이 규칙을 `git status` 로 못 박아 뒀었다. 이건 **일반** 코드리뷰 스킬이라
    //  대상이 늘 레포도, 늘 git 도 아니다 — 못 재는 대상에선 «생략» 이 되고, 생략하면
    //  그 줄이 있던 이유가 통째로 사라진다(읽기 전용이 다시 «선언» 으로 돌아간다).
    //  ★그래서 검사하는 것은 **성질**이다: 전후를 대조한다 · 수단은 대상이 정한다.
    const proofOk =
      /리뷰 전후|전 == |전과 .{0,6}후/.test(skill) && /수단은 대상이 정한다/.test(skill);
    const toolBaked = /`git status`[^—]{0,40}로 (확인|대조)/.test(skill);
    out.push(
      assert(
        "★★읽기 전용을 **전후 대조로 증명**하되 **도구를 못 박지 않는다** — 이 스킬은 레포가 아닌 폴더에도 쓰인다. 도구를 박으면 못 재는 대상에서 증명이 통째로 생략된다",
        proofOk && !toolBaked,
        `대조 규칙=${proofOk} · 도구 하드코딩=${toolBaked}`,
      ),
    );

    // ── ①-c ★호출자와 피호출자의 «모드» 가 같은 말인가 (이음매) ───────────
    // ★사고: 분할 축을 «차원 → 파일 묶음» 으로 바꾸면서 **호출자 템플릿만** 고치고
    //  에이전트의 모드 계약을 안 고쳤다. 그러면 서브가 모르는 모드를 받아 담당 파일·
    //  출력 형식이 전부 임의 해석이 되는데, **아무 검사도 안 울었다.**
    //  (이 결함은 새 스킬로 돌린 첫 리뷰가 스스로 찾아냈다 — 그래서 그물로 옮긴다.)
    const orch = readSourceSync("skills/code-review/references/review-orchestration.md");
    const modesSent = [...orch.matchAll(/\[모드: ([^\]—]+?)(?: —[^\]]*)?\]/g)].map((m) =>
      (m[1] ?? "").trim(),
    );
    // 매니저에게 가는 모드는 에이전트 계약이 아니다(매니저는 `run_in_background`).
    const toAgent = modesSent.filter((m) => !m.includes("오케스트레이션"));
    const known = [...agent.matchAll(/\[모드: ([^\]—`]+?)(?: —[^\]]*)?\]/g)].map((m) =>
      (m[1] ?? "").trim(),
    );
    const unknown = toAgent.filter((m) => !known.includes(m));
    out.push(
      assert(
        "★★템플릿이 서브에게 보내는 **모드**를 에이전트가 전부 안다 — 갈리면 서브가 담당 파일·출력 형식을 임의로 해석하고, 그 실패는 조용하다",
        toAgent.length > 0 && unknown.length === 0,
        toAgent.length === 0
          ? "★보내는 모드를 하나도 못 뽑았다(검사가 공허하다)"
          : unknown.length === 0
            ? `보냄 ${toAgent.join("·")} — 전부 계약에 있다`
            : `★계약에 없는 모드: ${unknown.join(", ")}`,
      ),
    );

    // ── ①-d ★인용한 절이 실재하는가 + 템플릿이 도달 가능한가 ─────────────
    // ★두 사고가 같은 부류다: ①에이전트가 `§A 방법론` 을 가리키는데 그 절이 «범위» 로
    //  바뀌어 방법론이 사라졌다(1명 위임 경로가 자기 규칙 없이 돌았다) ②`invoke_skill` 은
    //  **SKILL.md 본문만** 준다 — 스킬이 템플릿 파일을 안 가리키면 팬아웃 프롬프트를
    //  즉석에서 짓게 되고, 담당 파일·출력 형식이 매번 달라진다(그 차이는 조용하다).
    const sections = new Set(
      [...skill.matchAll(/^## ([A-Z])\. /gm)].map((m) => m[1] ?? ""),
    );
    const cited = new Set(
      [...`${agent}\n${orch}`.matchAll(/§([A-Z])\b/g)].map((m) => m[1] ?? ""),
    );
    const dangling = [...cited].filter((c) => !sections.has(c));
    out.push(
      assert(
        "★★에이전트·템플릿이 인용한 스킬 절이 **전부 실재한다** — 절이 개편되면 인용은 조용히 허공을 가리키고, 그 경로는 자기 규칙 없이 돈다",
        cited.size > 0 && dangling.length === 0,
        cited.size === 0
          ? "★인용을 하나도 못 뽑았다(검사가 공허하다)"
          : dangling.length === 0
            ? `인용 §${[...cited].sort().join("·§")} 전부 실재`
            : `★없는 절 인용: §${dangling.join(", §")}`,
      ),
      assert(
        "★★스킬이 팬아웃 템플릿 파일을 **가리킨다** — `invoke_skill` 은 SKILL.md 본문만 주므로, 안 가리키면 그 파일은 런타임에 도달할 길이 없다(즉석 작성으로 떨어진다)",
        /review-orchestration\.md/.test(skill),
        /review-orchestration\.md/.test(skill) ? "참조 있음" : "★참조 0 — 템플릿이 죽은 파일",
      ),
    );

    // ── ② 부팅 배선이 실재한다 ───────────────────────────────────────────
    const boot = readSourceSync("src/index.ts");
    const wired =
      /seedDefaultHomeWidgets\(/.test(boot) && /listAvailableHomeWidgets\(\)/.test(boot);
    out.push(
      assert(
        "★★홈 위젯 자동 편입이 **부팅에서 실제로 불린다** — 이 호출이 사라져도 순수 함수 검사는 전부 초록이라, 「설치했는데 안 보인다」가 조용히 돌아온다(실측: 지우는 변이가 3,029건을 통과했다)",
        wired,
        wired ? "seedDefaultHomeWidgets ← listAvailableHomeWidgets" : "★부팅 배선 없음",
      ),
    );
    return out;
  },
};
export default check;
