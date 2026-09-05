/**
 * 회귀: **교훈에는 자리가 있다** — 자가성장 산출물이 «확인하세요» 하나로 끝나지 않는다
 * (2026-09-05 재구성 2판).
 *
 * 사고: 산출물이 네 종류인데 **말끝이 전부 같았다** — *"비서가 사용자에게 확인하세요"*.
 * 받는 쪽은 매번 «그래서 뭘 하라는 거지» 를 처음부터 생각해야 했고, 4개월간 확정 0건이었다.
 * 문제는 게이트가 빡세서가 아니라 **모양이 다른 것들에 문이 하나뿐**이었다는 것이다.
 *
 * ★이 레포엔 자리가 넷 있고 **셋은 매 턴 프롬프트를 0바이트 먹는다**(회귀·훅·스킬).
 *  그래서 «상시 규범(SELF_GROWTH.md)» 은 **기본값이 아니라 가장 비싼 선택지**다 — 그 자리는
 *  캡이 있고, 넘치면 조용히 잘린다([[project_hotpath_bound_preserve_record]]).
 *
 * ★판정을 **한 곳(`home.ts`)에 모은 것**이 이 검사의 절반이다. 자리마다 문장으로 적으면
 *  네 벌이 되고, 한쪽만 고쳐지는 날 같은 실패가 두 곳으로 간다.
 *
 * ★`hook` 분기가 **없는 것도 계약**이다 — 훅은 「특정 도구 전후」라는 자리인데 지금 신호로는
 *  그걸 판정할 근거가 없다. 근거 없는 분기는 «집행 없는 선언» 이라 만들지 않는다.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, loadPluginModule, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const PLUGIN = path.join(REPO, "plugins/self-growth/src");

type Verdict = { home: string; why: string; action: string };

export const check: RegressionCheck = {
  name: "growth-lesson-has-a-home",
  guards:
    "자가성장 산출물이 종류와 무관하게 «사용자에게 확인하세요» 하나로 끝나, 받는 쪽이 매번 자리를 처음부터 생각해야 하던 것(4개월 확정 0건)",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const { suggestHome } = await loadPluginModule<{
      suggestHome: (i: {
        kind: string;
        cause?: string;
        errorKind?: string;
        hasCause?: boolean;
      }) => Verdict;
    }>("../../../plugins/self-growth/src/home.ts");

    // ── ① 진리표 — 모양이 다르면 자리가 다르다 ────────────────────────────────
    const cases: Array<[string, Parameters<typeof suggestHome>[0], string]> = [
      ["반복 도구 시퀀스", { kind: "skill_proposal" }, "skill"],
      ["스킬 개선", { kind: "skill_improve" }, "skill"],
      [
        "코어 결함",
        { kind: "failure", cause: "core", errorKind: "type_error", hasCause: true },
        "regression",
      ],
      [
        "작업 설계",
        { kind: "failure", cause: "task_design", errorKind: "type_error", hasCause: true },
        "skill",
      ],
      [
        "설정·지침(결정적)",
        { kind: "failure", cause: "prompt_config", errorKind: "empty_response", hasCause: true },
        "directive",
      ],
      ["반복 규범", { kind: "segment" }, "directive"],
      ["표류", { kind: "drift" }, "directive"],
    ];
    const wrong = cases.filter(([, input, want]) => suggestHome(input).home !== want);
    out.push(
      assert(
        "★모양마다 자리가 다르다(같은 답이 나오면 라우팅이 아니다)",
        wrong.length === 0,
        wrong.length === 0
          ? cases.map(([n, i]) => `${n}→${suggestHome(i).home}`).join(" · ")
          : `★틀린 것: ${wrong.map(([n, i, w]) => `${n} 기대=${w} 실제=${suggestHome(i).home}`).join(" · ")}`,
      ),
    );

    // ── ② 모르면 «모른다» 로 간다 — 지어내지 않는다 ──────────────────────────
    const noCause = suggestHome({ kind: "failure", cause: "task_design", hasCause: false });
    out.push(
      assert(
        "★원인이 없으면 자리를 정하지 않는다(빈칸으로 규범을 만들지 않는다)",
        noCause.home === "ask",
        `hasCause=false → ${noCause.home}`,
      ),
    );
    const uncertain = suggestHome({ kind: "failure", cause: "uncertain", hasCause: true });
    out.push(
      assert(
        "원인 분류가 불확실하면 사람에게 간다",
        uncertain.home === "ask",
        `uncertain → ${uncertain.home}`,
      ),
    );

    // ── ③ ★바깥 사정은 규범으로 만들지 않는다 ────────────────────────────────
    //  타임아웃·한도·과부하는 우리 규칙으로 안 막힌다. 그걸 지침으로 올리면 매 턴 실리는
    //  자리에 «지킬 수 없는 규칙» 이 앉는다.
    const flaky = ["timeout", "rate_limit", "server_is_overloaded", "ETIMEDOUT", "http_503"];
    const leaked = flaky.filter(
      (k) =>
        suggestHome({ kind: "failure", cause: "prompt_config", errorKind: k, hasCause: true })
          .home === "directive",
    );
    out.push(
      assert(
        "★바깥 사정(타임아웃·한도·과부하)은 상시 규범이 되지 않는다",
        leaked.length === 0,
        leaked.length === 0 ? `${flaky.length}종 전부 ask` : `★규범으로 샌 것: ${leaked.join(", ")}`,
      ),
    );

    // ── ④ 판정이 한 곳이다 + 산출물이 실제로 그걸 싣는다 ──────────────────────
    const files = readdirSync(PLUGIN).filter((f) => f.endsWith(".ts") && f !== "home.ts");
    const carriers = files.filter((f) =>
      /homeFields\(\s*suggestHome\(/.test(readFileSync(path.join(PLUGIN, f), "utf8")),
    );
    out.push(
      assert(
        "★산출물이 자리 판정을 싣는다(본문에 suggested_home·다음 할 일)",
        carriers.length >= 3,
        `싣는 파일 ${carriers.length}개: ${carriers.join(", ")}`,
      ),
    );
    const strays = files.filter((f) => {
      const src = readFileSync(path.join(PLUGIN, f), "utf8").replace(/^\s*\/\/.*$/gm, "");
      // 자리 문구를 손으로 적은 흔적 — 판정이 두 벌이 되는 신호.
      return /suggested_action:\s*\n?\s*"/.test(src);
    });
    out.push(
      assert(
        "자리 문구를 손으로 적은 곳이 없다(판정이 두 벌이면 한쪽만 고쳐진다)",
        strays.length === 0,
        strays.length === 0 ? "손으로 적은 곳 0" : `★손으로 적은 파일: ${strays.join(", ")}`,
      ),
    );

    // ── ④' ★파생 턴은 «사용자의 작업 흐름» 이 아니다 ────────────────────────
    //  실측(2026-09-05): 스킬 제안 8건 중 **1건**이 통째로 서브에이전트 턴(`agent:`)에서
    //  만들어졌다 — «Bash→Read→Bash→Read→Bash» 는 우리가 띄운 하위 작업의 **탐색 모양**
    //  이지 사용자가 반복하는 절차가 아니다. 원인은 자가성장이 파생 접두사 **사본**을 들고
    //  있었고 거기 `agent:` 가 빠진 것. 사본을 없앴으니, 이제 **코어 목록 전체**를 막는지
    //  본다 — 새 파생 종류가 생겨도 이 검사는 저절로 그것까지 요구한다.
    const { DERIVED_THREAD_PREFIXES } = await import("../../core/threadkey.js");
    const { isAggregableThreadKey } = await loadPluginModule<{
      isAggregableThreadKey: (k: string) => boolean;
    }>("../../../plugins/self-growth/src/skills.ts");
    const leakedThreads = DERIVED_THREAD_PREFIXES.filter((p) =>
      isAggregableThreadKey(`${p}abc123`),
    );
    out.push(
      assert(
        "★파생 턴(스케줄·매니저·에이전트·엔드포인트·게이트웨이)은 제안 집계에 안 들어간다",
        leakedThreads.length === 0,
        leakedThreads.length === 0
          ? `${DERIVED_THREAD_PREFIXES.length}종 전부 제외`
          : `★새어 든 것: ${leakedThreads.join(", ")} — 우리가 만든 턴을 사용자 작업으로 읽는다`,
      ),
    );
    out.push(
      assert(
        "사람 대화는 그대로 집계된다(막기만 하고 다 막으면 자가성장이 죽는다)",
        isAggregableThreadKey("dashboard:default") && isAggregableThreadKey("tg:12345"),
        `dashboard=${isAggregableThreadKey("dashboard:default")} · telegram=${isAggregableThreadKey("tg:12345")}`,
      ),
    );

    // ── ⑤ ★교훈은 «그 순간» 에 남긴다 — 되돌아보는 의식이 아니라 ────────────
    //  처음엔 회고 스킬을 만들었다가 **뺐다**(사용자: *"교훈은 즉시 발생하는 거 아니야"*).
    //  맞다 — 주기 회고는 그 순간 알던 것을 잃고 나서 복원하는 일이고, 이 레포는 주기
    //  산출물이 무내용으로 쌓이는 걸 이미 겪었다(주간회고 6건 중 4건 읽힘 0).
    //  그리고 제안 본문이 이미 자리와 다음 할 일을 들고 있으니, 그걸 다시 설명하는 문서는
    //  **두 번째 권위**다. 남은 건 «그 순간 판단하라» 는 헌법 한 줄이고, 그게 진짜 빠져
    //  있던 조각이다(사용자가 말로 고쳐준 순간엔 이벤트가 없다).
    const constitution = readFileSync(path.join(REPO, "SYSTEM.md"), "utf8");
    const momentRule = /교훈은 그 순간에 남긴다/.test(constitution);
    out.push(
      assert(
        "★헌법이 «교훈은 그 순간에 남긴다» 고 말한다(이벤트가 없는 유일한 자리)",
        momentRule,
        momentRule ? "§1 구조를 늘리기 전에" : "★없음 — 교정받은 순간이 아무 데도 안 남는다",
      ),
    );
    const homesInRule = ["회귀", "훅", "스킬", "지침"].filter((h) =>
      new RegExp(`\\*\\*${h}\\*\\*`).test(constitution.slice(constitution.indexOf("교훈은 그 순간에 남긴다"), constitution.indexOf("교훈은 그 순간에 남긴다") + 700)),
    );
    out.push(
      assert(
        "그 규칙이 자리 넷과 «지침은 기본값이 아니다» 를 같이 말한다",
        homesInRule.length === 4 && /기본값이 아니다/.test(constitution),
        `규칙 안의 자리=${homesInRule.join("·") || "없음"}`,
      ),
    );
    out.push(
      assert(
        "★되돌아보는 «의식» 을 따로 만들지 않았다(주기 산출물이 무내용으로 쌓인 전례)",
        !readdirSync(path.join(REPO, "skills")).includes("growth-review"),
        readdirSync(path.join(REPO, "skills")).includes("growth-review")
          ? "★growth-review 스킬이 다시 생겼다"
          : "회고 스킬 없음",
      ),
    );

    return out;
  },
};
export default check;
