/**
 * **AGENT.md 의 이름은 산문으로 적혀 있어도 읽힌다** (2026-09-23).
 *
 * 사고(2026-07-08, 회사 인스턴스): AGENT.md 에 「당신의 이름은 회사비서입니다」라고
 * 적었는데 파서가 **구조화 필드만** 봐서 못 읽었고, 대시보드가 `tiguclaw` 로 폴백했다.
 * 그래서 파서에 **산문 분기**를 일부러 넣었다 — sysprompt 가 그 형식을 유도했으니까.
 *
 * ★**그 분기에 그물이 0건이었다** (실측: `getAssistantName` 을 부르는 회귀 0개,
 *  「당신의 이름은」을 단언하는 회귀 0개). 지워도 아무도 안 울었다.
 *
 * ★그리고 2026-09-22 에 헌법이 *"산문만으로 대신하지 마세요"* 로 바뀌면서, 그 문장이
 *  **그 분기를 지울 근거**가 될 뻔했다(적대 검토가 잡았다). 다음 판은 반대로 *"산문으로
 *  적혀 있어도 읽힌다"* 였는데 **실측 11개 중 3개만 읽혀** 이번엔 넓어서 걸렸다.
 *  ★결론: **헌법은 파서의 폭을 말하지 않는다.** 이제 sysprompt 는 정체성만 선언하고,
 *  「`이름: X` 한 줄 필드로 쓰라」는 *쓰는 순간*의 지시로 AGENT.md 절에 산다.
 *  파서가 실제로 무엇을 읽는지는 **문장이 아니라 여기가** 못 박는다.
 *
 * 등급: **동작 검사** — 임시 홈에 AGENT.md 를 써서 제품 함수 `getAssistantName()` 을 부른다.
 */
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { assert, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";

/**
 * ★홈을 바꾸지 않는다 — `getPaths()` 는 첫 호출에 경로를 **캐시**해서 `TIGUCLAW_HOME` 을
 *  나중에 바꿔도 안 듣는다(실측: 전부 `tiguclaw` 폴백이 나왔다). 대신 `readAgent()` 가
 *  **매 호출 파일을 읽는다**는 성질을 쓴다 — 러너의 격리 홈 안 `AGENT.md` 내용만 갈아끼우고
 *  끝나면 원상복구한다.
 */
const withAgentMd = async (body: string): Promise<string> => {
  const { getPaths } = await import("../../core/paths.js");
  const { getAssistantName } = await import("../../core/identity.js");
  const p = getPaths().agentMd;
  const had = existsSync(p);
  const prev = had ? readFileSync(p, "utf8") : undefined;
  try {
    writeFileSync(p, body);
    return getAssistantName();
  } finally {
    if (prev === undefined) { try { unlinkSync(p); } catch { /* 없으면 그만 */ } }
    else writeFileSync(p, prev);
  }
};

export const check: RegressionCheck = {
  name: "agent-name-reads-prose-too",
  guards:
    "AGENT.md 에 산문으로 적은 이름을 파서가 못 읽어 대시보드가 tiguclaw 로 폴백하던 것(2026-07-08 회사 인스턴스) · 그 분기를 지워도 아무도 안 울던 것",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const prose = await withAgentMd("# 인격\n\n당신의 이름은 회사비서입니다.\n");
    const field = await withAgentMd("# 인격\n\n이름: 모모\n");
    const dashField = await withAgentMd("# 인격\n\n- **이름**: 돌쇠\n");
    // ★파서는 `이름[은이]` 둘을 본다 — 한쪽만 재면 나머지를 좁혀도 안 걸린다(적대 검토 발견 4b).
    const prose2 = await withAgentMd("# 인격\n\n제 이름이 돌쇠입니다.\n");
    // ★줄머리 앵커가 하는 일 — 줄 가운데 `이름:` 은 **사용자 이름**이지 비서 이름이 아니다.
    //  앵커를 빼면 여기서 「정태님 으로 부른다」가 라벨이 된다(적대 검토 발견 4a).
    const midLine = await withAgentMd(
      "# 인격\n\n- 사용자 이름: 정태님 으로 부른다\n\n당신의 이름은 회사비서입니다.\n",
    );
    const english = await withAgentMd("# Persona\n\nname: Aster\n");
    const neither = await withAgentMd("# 인격\n\n아무 지정도 없습니다.\n");
    const both = await withAgentMd("# 인격\n\n이름: 필드쪽\n\n당신의 이름은 산문쪽입니다.\n");
    // ★긴 문장은 이름이 아니다 — 40자 캡이 그걸 막는다(파서 주석: «이름 아닌 긴 문장 방지»).
    //  ★첫 판은 «…이름이라기보다…» 를 썼는데 정규식이 **비탐욕**이라 `이라` 에서 끊겨
    //   14자 이름이 나왔다. 파서가 틀린 게 아니라 **내 입력이 캡을 안 건드렸다** — 종결어가
    //   40자 뒤에 오는 문장이어야 그 가드를 잰다.
    const longish = await withAgentMd(
      "# 인격\n\n이름은 가나다라마바사아자차카타파하가나다라마바사아자차카타파하가나다라마바사아자차카타파하입니다\n",
    );
    const emptyish = await withAgentMd("# 인격\n\n이름: \n");
    return [
      assert(
        "★★**산문으로 적은 이름을 읽는다** — 2026-07-08 실사고가 정확히 이 경우다",
        prose === "회사비서",
        `산문 → ${prose}`,
      ),
      assert(
        "구조화 필드도 읽는다(`이름:` · `- **이름**:`)",
        field === "모모" && dashField === "돌쇠",
        `이름: → ${field} · - **이름**: → ${dashField}`,
      ),
      assert(
        "★★**좁힘 방향** — `이름이 X` 도 읽는다(`이름[은이]` 를 한쪽으로 좁히면 여기가 빨개진다)",
        prose2 === "돌쇠",
        `제 이름이 돌쇠입니다 → ${prose2}`,
      ),
      assert(
        "★★**줄 가운데 `이름:` 은 비서 이름이 아니다** — 필드 정규식의 줄머리 앵커가 지키는 성질",
        midLine === "회사비서",
        `「- 사용자 이름: 정태님 …」 + 산문 → ${midLine}`,
      ),
      assert(
        "★영문 `name:` 도 읽는다 — 헌법이 형식을 열거할 때 빠뜨린 자리다",
        english === "Aster",
        `name: → ${english}`,
      ),
      assert(
        "둘 다 있으면 **필드가 이긴다**(우선순위가 뒤집히지 않는다)",
        both === "필드쪽",
        `필드+산문 → ${both}`,
      ),
      assert(
        "★★**넓힘 방향** — 40자 넘는 문장은 이름이 아니다(캡을 풀면 화면이 문장으로 찬다)",
        longish === "tiguclaw",
        `긴 문장 → ${longish}`,
      ),
      assert(
        "★빈 값도 이름이 아니다 — 빈 라벨을 만들지 않는다",
        emptyish === "tiguclaw",
        `빈 필드 → ${emptyish}`,
      ),
      assert(
        "★둘 다 없으면 중립 기본 — 지어내지 않는다",
        neither === "tiguclaw",
        `지정 없음 → ${neither}`,
      ),
    ];
  },
};
