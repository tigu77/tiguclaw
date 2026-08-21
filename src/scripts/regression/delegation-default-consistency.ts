/**
 * 회귀: **위임 기본값을 말하는 모든 자리가 같은 것을 말한다** (2026-08-01 하네스 검토).
 *
 * 사고 형상: 위임 판정이 **네 곳**에 흩어져 있었고 서로 반대를 말했다.
 *   `_shared-sysprompt.ts`(★매 턴 3어댑터 주입) — "**기본은 substantial**(=하네스로) …
 *      **애매하면 substantial 로 간주**. 「이 정도는 내가 빨리」라는 생각이 들면 그게 오히려
 *      substantial 신호" → 기본값 = **위임**
 *   `SYSTEM.md` — "짧은 코딩·편집은 **그냥 직접 해라**(과잉 위임 금지, 위임 오버헤드가 더 크다)"
 *      / "한 파일 소편집은 쪼개지 마라(과분해 = 낭비)" → 기본값 = **직접**
 *   `skills/harness/SKILL.md` 게이트 — "독립·비중첩 3개 이상일 때만 팀" → 기본값 = **직접**
 *  가장 비싼 자리(매 턴)가 가장 무거운 기본값을 밀고 있었고, 사용자는 "하네스가 무겁고
 *  일이 더디다"로 겪었다.
 *
 * ★모델은 논리보다 표면을 읽는다. 같은 결정을 두 곳이 반대로 말하면 어느 쪽이 이길지는
 *  그때그때 달라진다 — 정합은 취향이 아니라 동작이다.
 *
 * ★★**등급: 배선 린트** (2026-08-20 적대 검토 F6 — 정직하게 적는다).
 *  여기 있던 "문구를 베끼는지가 아니라 **판정이 하나인지** 본다" 는 **거짓이었다.**
 *  실측: 레드팀이 「매니저 소환」→「소환하지 마라」, 「기본은 직접」→「직접이 아니다」,
 *  「아래로 내려가라」→「위로 올려라」, 「2명↑ 매니저」→「2명↑여도 전경에서 지휘」,
 *  「3개 이상」→「3개 이상이 아니어도」로 **의미를 뒤집은 변이 6건이 전부 초록**이었다.
 *  부분문자열 린트는 원리적으로 의미를 못 본다.
 *
 *  그래서 **이 검사가 지키는 것**은 이렇게 좁다:
 *   - 옛 반대 기본값 **문구의 부활**(정확한 형태)
 *   - **가격표의 존재**(비용 주장이 주입면에 있는가 — 표기 회피는 계속 가능)
 *   - 핵심 문장·포인터의 **부재**(조립된 프롬프트 기준, F1 이후)
 *  지키지 **못하는** 것: 의미 반전·동의어 치환·논지 훼손. 그건 사람이 본다.
 *  ★"지키지도 못하면서 지킨다고 적어둔 검사가 가장 나쁘다" — 그래서 이 문단이 있다.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { REGION_A_SYSTEM_PROMPT } from "../../core/llm-runtime/adapters/_shared-sysprompt.js";
import { discoverAgents, formatAgentIndex } from "../../core/llm-runtime/capabilities/agent-registry.js";
import { discoverSkills, formatSkillIndex } from "../../core/llm-runtime/capabilities/skill-registry.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (rel: string): string => readFileSync(path.join(REPO, rel), "utf8");

/**
 * ★**넛지는 파일이 아니라 조립된 문자열로 읽는다** (2026-08-20 적대 검토 F1).
 *
 * 종전엔 `_shared-sysprompt.ts` 를 `readFileSync` 로 읽었다. 그 파일은 배열이라 **주석
 * 한 줄**로 항목을 빼도 바이트엔 그대로 남는다 — 레드팀이 라우팅 줄을 주석 처리하자
 * 런타임 프롬프트가 6,854→6,619자로 줄고 「기본은 직접」·「매니저 소환」·「§1 이 정본」
 * **세 문구가 전부 사라졌는데 단언 셋이 모두 초록**이었다. 반대 방향도 틀렸다: 절대
 * 안 실리는 TS 주석에 "5배" 를 적으면 FAIL 이라, **이 결정의 근거를 그 파일에 적는
 * 행위 자체가 스위트를 깼다**(가짜 빨강).
 *
 * 형제 `constitution-single-source.ts` 는 이미 이 export 를 import 해서 문자열로 본다 —
 * 옳은 패턴이 옆에 있었는데 이 파일만 파일을 읽고 있었다.
 */
const nudgeText = (): string => REGION_A_SYSTEM_PROMPT;

/** 위임 기본값을 말하는 자리 — 하나라도 딴소리를 하면 그 자리가 이길 수 있다. */
const SOURCES = [
  { rel: "src/core/llm-runtime/adapters/_shared-sysprompt.ts", what: "매 턴 주입 넛지(3어댑터)" },
  { rel: "SYSTEM.md", what: "작동 헌법" },
  { rel: "skills/harness/SKILL.md", what: "하네스 스킬" },
] as const;

/**
 * 가격표를 훑을 **실제 주입면** — 파일 목록이 아니라 *조립 결과*다 (적대 검토 F3).
 *
 * ★손으로 3파일을 세던 종전 판은, 매 턴 실리는 다른 자리 넷(스킬 인덱스·에이전트 인덱스·
 *  도구 설명 둘)에 가격표를 심으면 그냥 통과했다. 파일을 더 열거하는 건 같은 병의 연장이라
 *  (`feedback_hand_maintained_lists`) **조립 함수를 부른다** — 스킬이 늘어도 자동으로 따라온다.
 */
/**
 * 능력 파일에서 **모델에게 실제로 가는 문자열**만 뽑는다 — 도구 설명(`tool(name, desc, …)`)과
 * 인자 설명(`.describe("…")`). 코드·주석은 모델이 안 본다.
 *
 * ★SDK 의 호출 모양에서 파생한다 — 어떤 문구를 볼지 목록으로 적지 않는다(새 도구가 생기면
 *  자동으로 따라온다).
 */
const modelFacingStrings = (src: string): string => {
  const parts: string[] = [];
  for (const m of src.matchAll(/\btool\(\s*"(?:[^"\\]|\\.)*",\s*"((?:[^"\\]|\\.)*)"/g)) {
    parts.push(m[1]!);
  }
  for (const m of src.matchAll(/\.describe\(\s*"((?:[^"\\]|\\.)*)"/g)) parts.push(m[1]!);
  return parts.join("\n");
};

const injectedSurfaces = async (): Promise<Array<{ what: string; text: string }>> => [
  { what: "매 턴 주입 넛지(조립본)", text: nudgeText() },
  { what: "작동 헌법", text: read("SYSTEM.md") },
  { what: "하네스 스킬", text: read("skills/harness/SKILL.md") },
  // 스킬·에이전트 인덱스 = 전 항목의 description 이 매 턴 실린다(개수 무관·자동 추종).
  { what: "스킬 인덱스(전 스킬 description)", text: formatSkillIndex(await discoverSkills(REPO)) },
  { what: "에이전트 인덱스(전 에이전트 description)", text: formatAgentIndex(await discoverAgents(REPO)) },
  // ★**도구 설명도 매 턴 실린다** (2026-08-21 적대 검토 A-F4). 바로 위 주석이 "매 턴 실리는
  //  다른 자리 넷" 이라고 **넷을 알면서 둘만** 넣어 뒀고, 그래서 `run_in_background`·
  //  `spawn_agent` 설명에 가격표를 심는 변이가 그대로 통과했다 — 검사가 자기 커버리지에
  //  대해 거짓을 말한 것이고, 다음 사람은 그 이름("주입면 어디에도")을 믿는다.
  //  ★파일 전체가 아니라 **모델에게 가는 문자열만** 뜬다(첫 시도에서 파일 전체를 넣었더니
  //   코드·주석의 "토큰 2배" 같은 말이 가격표로 잡혔다 — 검사가 우는 것과 맞는 것은 다르다).
  { what: "위임 도구 설명(run_in_background)", text: modelFacingStrings(read("src/core/llm-runtime/capabilities/worker-registry.ts")) },
  { what: "위임 도구 설명(spawn_agent)", text: modelFacingStrings(read("src/core/llm-runtime/capabilities/agent-registry.ts")) },
];

/**
 * **조건 정의**를 드는 자리 (2026-08-05 개정) — 넛지는 제외한다.
 *
 * ★왜 바꿨나: 이 검사는 원래 "공통 기준을 **세 자리에 다** 두라"고 했다. 그런데 그 수단이
 *  정확히 **헌법 두 벌** 문제를 만들었다 — 같은 판단이 여러 곳에 있으면 한쪽만 고쳐져
 *  갈린다(실제로 앱 소스·홈 밖 규칙이 그렇게 갈려 정반대 지시가 됐다,
 *  `constitution-single-source` 참조). 사고의 형상은 **모순**이었지 *부재*가 아니었다.
 *  그래서 목적(넛지가 반대 기본값을 밀지 않는다)은 그대로 두고, 수단만 바꾼다:
 *  **넛지 = 기본값 + 정본 포인터 / 조건 정의 = 헌법·하네스 스킬**.
 */
const CONDITION_SOURCES = SOURCES.filter((s) => !s.rel.endsWith("_shared-sysprompt.ts"));

/** 되살아나면 안 되는 **반대 기본값** 문구 — 옛 사고의 형상 그대로. */
const OPPOSITE = [
  /기본은 substantial/,
  /애매하면 substantial/,
  /인라인은 좁은 예외/,
];

/**
 * **매 턴 실리는 자리는 가격표가 아니라 라우팅을 말한다** (2026-08-20, 사용자 결정).
 *
 * ★1차 사고: `docs/decisions/2026-07-11-worker-model-tier.md` 가 인용한 "멀티에이전트 ≈
 *  5배(Anthropic)" 를 `df12fa8`(08-01)이 세 자리로 옮기면서 **위임 전체**의 가격표로 붙였다.
 *  실측하면 서브 1명은 메인 턴의 0.60배라 1명 위임은 1.6배인데, 모델은 "1명한테 넘길까" 를
 *  판단하는 자리에서 5배를 봤다 — 3배 부풀린 값이다. 실제로 185턴 동안 서브에이전트 스폰이
 *  0건인 구간이 두 번 있었다.
 *
 * ★그런데 **숫자를 고치는 건 절반짜리 수정이었다**(사용자 지적). 계수는 어댑터·모델이
 *  바뀌면 다시 재야 하고, 재면 또 세 자리가 갈린다. 그리고 매 턴 실리는 자리에 가격표를
 *  두면 모델은 **아끼려 든다** — 그게 애초 증상이었다. 그 자리가 말해야 할 것은 "얼마 드는가"
 *  가 아니라 **"어디로 보내는가"** 다: 작은 일은 서브에이전트를 직접, 팀 규모면 매니저를
 *  소환해 팬아웃을 맡긴다.
 *
 * ★**프롬프트 어디에도 두지 않는다** — 온디맨드 스킬도 포함이다(사용자 지적, 2차).
 *  처음엔 자리를 갈라 "매 턴 자리엔 없이 / 스킬엔 단가로" 로 했는데, 그 검사가 곧
 *  **늙을 숫자를 그 자리에 계속 있으라고 강제하는 게이트**가 된다(`feedback_hand_maintained_lists`
 *  의 형상 그대로). 게다가 단가는 스킬의 판정을 바꾸지 않는다 — 게이트는 「독립·비중첩
 *  3개 이상 + 면적」이라는 **구조** 기준이고, 계수는 그 위의 장식이다. 이유("에이전트마다
 *  컨텍스트를 새로 싣는다")는 숫자 없이 그대로 선다.
 *
 * ★실측치는 **없애는 게 아니라 결정 문서로 내린다** —
 *  `docs/decisions/2026-07-11-worker-model-tier.md` 에 창(어느 기간을 쟀나)·한계와 함께.
 *  "그때 잰 값" 의 집은 거기다. 프롬프트는 **판정**을 말하는 자리지 측정을 싣는 자리가 아니다.
 */
/**
 * 비용 주장 표기 — 적대 검토(F4)가 뚫은 것을 전부 넣었다: `5배` 말고도 `5x`·`×5`·`500%`·
 * `다섯 배`·`다섯 곱절`·`N배`·`0.6 수준`, 그리고 **`1+0.6N배`**(직전 커밋에서 지운 원문
 * 표기인데 정규식이 `배` 직전 숫자를 요구해 빠져나갔다). 토큰 절대량(`12~18만 토큰`)도
 * 가격표다 — 배수가 아니라서 안 걸리던 살아 있는 위반이 실제로 하나 있었다(F2).
 */
const COST_CLAIM =
  /(?:\d+(?:\.\d+)?\s*(?:배|곱절|%)|[Nn]\s*배|[0-9.]+\s*[x×]\b|[x×]\s*[0-9.]+|[한두세네다섯여섯일곱여덟아홉열]\s*(?:배|곱절)|\d+(?:\.\d+)?\s*수준|\d+\s*[~-]\s*\d+\s*만\s*토큰|\d+만\s*토큰)/g;
/**
 * 배수 언급이 **위임 비용**에 관한 것인지 가르는 창.
 * ★어휘를 넓혔다(F5) — `에이전트`·`팬아웃`·`병렬` 만 쓰면 빠져나갔다.
 */
const DELEGATION_CTX = /위임|서브에이전트|에이전트|매니저|팀|팬아웃|병렬/;

/** 위임 비용 주장을 ±160자 창째로 걷어온다. */
const costClaims = (src: string): string[] => {
  const out: string[] = [];
  for (const m of src.matchAll(COST_CLAIM)) {
    const i = m.index ?? 0;
    const win = src.slice(Math.max(0, i - 160), i + 160);
    if (!DELEGATION_CTX.test(win)) continue; // 위임 비용 얘기가 아니면 대상 아님
    out.push(`«${win.replace(/\s+/g, " ").trim()}»`);
  }
  return out;
};

export const check: RegressionCheck = {
  name: "delegation-default-consistency",
  guards:
    "위임 기본값이 매 턴 넛지(=위임)와 헌법·하네스 게이트(=직접)로 갈려 하네스가 과하게 무겁던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];

    // ★① 조건 정의가 **정의처(헌법·하네스 스킬)** 에 있는가. 없으면 그 자리에서 다른 기준이 쓰인다.
    const missing = CONDITION_SOURCES.filter((s) => {
      const src = read(s.rel);
      return !(src.includes("독립·비중첩") && src.includes("3개 이상"));
    });
    out.push(
      assert(
        `★위임 게이트(독립·비중첩 3개 이상)가 정의처 ${CONDITION_SOURCES.length}곳에 있다`,
        missing.length === 0,
        missing.length === 0
          ? CONDITION_SOURCES.map((s) => s.what).join(" · ")
          : `★누락: ${missing.map((s) => `${s.what}(${s.rel})`).join(" / ")}`,
      ),
    );

    // ★② 반대 기본값을 미는 옛 문구가 되살아나지 않았는가. (넛지는 조립본으로 — F1)
    const revived: string[] = [];
    for (const s of await injectedSurfaces()) {
      for (const re of OPPOSITE) if (re.test(s.text)) revived.push(`${s.what}: ${re.source}`);
    }

    // ★하네스의 **팀 갈래가 매니저로 라우팅**되는가 (2026-08-21 적대 검토 A-F3).
    //  넛지와 헌법은 "서브에이전트 2명 이상이면 매니저에게 통째로 넘겨라" 인데, 정작 팀
    //  갈래에서 **실제로 읽히는** 하네스 스킬은 비서가 전경에서 2~5명을 지휘하는 그림을
    //  그리고 매니저 위임을 한 번도 지시하지 않았다. 팀 갈래는 정의상 항상 그 조건이라,
    //  이건 세 자리 중 하나가 반대 방향을 가리키고 있었다는 뜻이다 — 사용자가 겪은 형태는
    //  헌법이 인용한 실사고 그대로다("직접을 고른 뒤 전경에서 10명을 뿌렸다").
    //
    //  ★한계(정직하게): 산문의 **의미**는 실행으로 못 잰다. 여기서 지키는 건 "팀 규모를
    //   정하는 그 자리에 매니저 라우팅이 **있는가**" 하나다. 문장을 반대로 뒤집으면서
    //   `run_in_background` 라는 단어를 남기면 이 검사는 통과한다(같은 파일 상단이 부분문자열
    //   린트의 한계를 이미 적어 뒀다). 그래도 **통째로 사라지는 것**은 막는다 — 그게 실제로
    //   일어났던 일이다.
    {
      const skill = read("skills/harness/SKILL.md");
      const start = skill.indexOf("## ② 규모");
      const next = start < 0 ? -1 : skill.indexOf("\n## ", start + 5);
      const scale = start < 0 ? "" : skill.slice(start, next < 0 ? undefined : next);
      out.push(
        assert(
          "★하네스의 팀 규모 절이 매니저 라우팅을 지시한다(팀 갈래 = 항상 '2명 이상' 조건)",
          scale.includes("run_in_background") && scale.includes("메인 턴"),
          scale === ""
            ? "★'## ② 규모' 절을 못 찾음"
            : `run_in_background=${scale.includes("run_in_background")} · 메인 턴 분기=${scale.includes("메인 턴")}`,
        ),
      );
    }
    out.push(
      assert(
        "★반대 기본값(‘기본은 substantial’·‘애매하면 substantial’)이 없다",
        revived.length === 0,
        revived.length === 0 ? "잔존 0" : `★부활: ${revived.join(" / ")}`,
      ),
    );

    // ★②-b **주입면 어디에도** 위임 가격표를 두지 않는다 — 측정은 결정 문서에.
    //  대상은 파일 목록이 아니라 **조립 결과**다(F1·F3): 넛지는 조립 문자열, 스킬은
    //  인덱스 전량. 스킬이 늘어도 목록을 고칠 일이 없다.
    const surfaces = await injectedSurfaces();
    const priced: string[] = [];
    for (const s of surfaces) {
      for (const w of costClaims(s.text)) priced.push(`${s.what} ${w}`);
    }
    out.push(
      assert(
        "★주입면 어디에도 위임 가격표가 없다(넛지 조립본·헌법·하네스·스킬 인덱스 전량)",
        priced.length === 0,
        priced.length === 0
          ? `${surfaces.map((s) => s.what).join(" · ")} — 가격표 0건`
          : `★가격표 잔존: ${priced.join(" / ")}`,
      ),
    );

    // ★②-c 넛지가 **팀 규모 → 매니저 소환** 라우팅을 말하는가. 가격표를 뺀 자리를 채우는
    //  것이 이 문장이다 — 없으면 "기본은 직접" 만 남아 팬아웃 자체가 사라진다.
    // ★파일이 아니라 **조립본**을 본다(F1) — 주석 한 줄로 빼도 파일 바이트엔 남는다.
    const nudge = nudgeText();
    out.push(
      assert(
        "★매 턴 넛지가 '팀 규모면 매니저 소환'을 말한다(전경에서 여러 명을 지휘하지 않는다)",
        /매니저\(`run_in_background`\)를 소환/.test(nudge),
        /매니저\(`run_in_background`\)를 소환/.test(nudge) ? "라우팅 문장 있음" : "★라우팅 문장 없음",
      ),
    );

    // ★③ **매 턴 실리는 자리**가 "기본은 직접"을 말하는가.
    //  여기가 실제로 행동을 정한다 — 스킬은 호출돼야 읽히지만 이건 항상 읽힌다.
    out.push(
      assert(
        "★매 턴 넛지가 기본값을 '직접'으로 말한다",
        /기본은 \*\*직접\*\*/.test(nudge),
        /기본은 \*\*직접\*\*/.test(nudge) ? "확인" : "★넛지가 기본값을 말하지 않는다",
      ),
    );
    // 애매할 때 **내려간다**(팀→1명→직접)는 방향 — 조건의 일부이므로 정본(헌법)에서 본다.
    const constitution = read("SYSTEM.md");
    out.push(
      assert(
        "애매하면 아래 갈래로 내려간다(위로 올리지 않는다) — 정본에 있다",
        /애매하면 아래 갈래로 내려가/.test(constitution),
        /애매하면 아래 갈래로 내려가/.test(constitution) ? "헌법에 있음" : "★방향 문구 없음",
      ),
    );
    // ★넛지는 조건을 재진술하는 대신 **정본을 가리켜야** 한다 — 가리키지 않으면 옮긴 규칙이
    //  미아가 되어(모델이 헌법을 안 찾는다) 넛지의 기본값만 남는다.
    out.push(
      assert(
        "★매 턴 넛지가 조건의 정본(SYSTEM.md)을 가리킨다",
        /SYSTEM\.md §1 이 정본/.test(nudge),
        /SYSTEM\.md §1 이 정본/.test(nudge) ? "정본 포인터 있음" : "★포인터 없음",
      ),
    );

    // ★④ 하네스 스킬에서 **게이트가 구축 절차보다 앞에** 있는가.
    //  뒤에 있으면 문서가 "먼저 감사/설계하라"고 시켜 게이트가 사후 적용된다(옛 Phase 0 형상).
    const skill = read("skills/harness/SKILL.md");
    // ★제목이 아니라 **게이트 본문**(갈래 표)의 위치를 본다 (적대 검토 F7).
    //  종전엔 `^##.*게이트` 제목 위치만 봐서, 앞에 껍데기 제목("## ① 게이트 — 뒤쪽을 보라")만
    //  남기고 실제 표를 구축 절차 뒤로 옮겨도 초록이었다 = 옛 Phase 0(사후 게이트) 복원.
    //  판정의 실체는 세 갈래 표이므로 그 표의 헤더 행을 기준으로 잰다.
    const gateAt = skill.search(/^\|\s*갈래\s*\|/m);
    const buildAt = Math.min(
      ...["에이전트 정의", "오케스트레이션 스킬"].map((k) => {
        const i = skill.indexOf(k, skill.indexOf("\n## "));
        return i < 0 ? Number.MAX_SAFE_INTEGER : i;
      }),
    );
    out.push(
      assert(
        "★하네스 스킬에서 게이트가 구축 내용보다 먼저 나온다(사후 적용 0)",
        gateAt > 0 && gateAt < buildAt,
        `게이트 ${gateAt}자 · 구축 ${buildAt}자`,
      ),
    );

    // ★⑤ 이력을 두 곳에 두지 않는다 — 스킬이 `## 변경 이력` 테이블을 강제하던 규칙은
    //  실제로 9개 스킬 중 0개만 지켰고(죽은 규칙), `feedback_minimal_change_docs`
    //  ("이력은 git log")와도 충돌했다.
    out.push(
      assert(
        "하네스가 스킬 본문에 변경 이력 테이블을 강제하지 않는다(이력은 git)",
        /변경 이력은 `git log`/.test(skill) && !/`## 변경 이력` 테이블\*\*에 둔다/.test(skill),
        /변경 이력은 `git log`/.test(skill) ? "git log 로 단일화" : "★이력 이중화 잔존",
      ),
    );
    return out;
  },
};
