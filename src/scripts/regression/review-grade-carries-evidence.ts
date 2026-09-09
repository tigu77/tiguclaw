/**
 * 회귀: **code-review 스킬에서 «등급을 붙이는 자리» 가 근거를 같이 요구한다** (2026-09-09).
 *
 * 사고(실사용 1회, Unity·C#·SVN 게임 프로젝트): 리뷰가 13건을 냈고 그중 `[결함]` 4건이
 * **4/4 전부 결함이 아니었다.** 관찰은 하나도 안 틀렸다 — grep 으로 «그 줄이 저렇게
 * 돼 있다» 를 확인한 것은 전부 참이었다. **틀린 것은 등급뿐**이고, 넷 다 «그 관찰에서
 * 유저까지 가는 길을 한 번도 안 걸어본 것» 이었다(그 미션 행이 테이블에 없었고, 두 행은
 * 서로 다른 EventId 였고, 마이그레이션 경로엔 파일이 남아 있었다).
 *
 * ★뿌리는 **이음매**다. 스킬은 §D 에서 «결함 = 사용자에게 닿는다» 로 등급을 정의하면서,
 *  확인 동작 예시는 «grep 한 줄 / 파일 한 곳 읽기» 뿐이었다 — **등급이 요구하는 성질을
 *  확인 동작이 한 번도 안 잰다.** 도달을 요구하는 문장은 §C(볼 때 이렇게 봐라)에 있었다.
 *  알고 있는 것과 걸리는 것은 다르다.
 *
 * ★그리고 §E 가 **자기와 모순**이었다: «집계 숫자(기각 N)는 안 적는다» 와 «기각된 것은
 *  수만 적는다» 가 4행 간격으로 있었다. 두 문장이 서로를 무력화하면 어느 쪽을 따랐든
 *  위반이 되고, 그러면 그 옆의 규칙들도 같은 무게를 잃는다.
 *
 * ★**문법으로 판정하지 않는다.** 후보 중엔 «닿는 경로 문장에 "면·되면·오면" 이 없을 것»
 *  이 있었는데, 그러면 «유저가 앱을 강제 종료하**면** 진행이 사라진다»(진짜 결함)가
 *  강등되고 «그 미션을 받을 **때** 안 오른다»(안 닿음)는 통과한다. 조건 표현은 얼마든지
 *  늘어난다 — 손 목록이다. 판별자는 **오늘 실재하는 것을 이름으로 대는가** 다.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SKILL = path.join(REPO, "skills", "code-review", "SKILL.md");

/** 절 하나만 떼어 본다 — 다른 절의 같은 낱말에 걸리지 않게. */
const section = (text: string, letter: string): string => {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`## ${letter}.`));
  if (start < 0) return "";
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^## [A-Z]\./.test(l));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
};

export const check: RegressionCheck = {
  name: "review-grade-carries-evidence",
  guards:
    "리뷰가 «결함» 4건을 냈는데 4/4 가 결함이 아니던 것 — 등급은 §D 에서 붙는데 그 등급이 " +
    "요구하는 도달 검사는 §C 에 있어, 관찰을 확인한 것이 등급을 확인한 것처럼 읽혔다",
  async run(): Promise<Assertion[]> {
    const md = readFileSync(SKILL, "utf8");
    const d = section(md, "D");
    const e = section(md, "E");
    const out: Assertion[] = [];

    // ── ① 등급을 정의하는 절이 등급마다 근거를 요구한다 ──────────────────
    out.push(
      assert(
        "★★§D(등급을 붙이는 자리)가 **결함에 «닿는 경로»를 요구한다** — 등급의 정의만 있고 근거 요구가 다른 절에 있으면, 관찰을 확인한 것이 등급을 확인한 것으로 읽힌다(실사용 4/4 오판)",
        /닿는 경로/.test(d),
        `§D ${d.split("\n").length}행 중 «닿는 경로» ${(d.match(/닿는 경로/g) ?? []).length}회`,
      ),
    );
    out.push(
      assert(
        "★§D 의 «닿는 경로» 가 **오늘 실재하는 것을 이름으로** 대라고 한다 — «닿는다» 만 적으면 시점이 없어 «데이터가 그렇게 들어오면» 까지 결함이 된다",
        /오늘/.test(d) && /실재/.test(d) && /이름으로/.test(d),
        JSON.stringify({ 오늘: /오늘/.test(d), 실재: /실재/.test(d), 이름으로: /이름으로/.test(d) }),
      ),
    );
    out.push(
      assert(
        "★그물 등급도 자기 근거(되돌리면 빨개질 **검사 이름**)를 §D 에서 요구한다 — 결함만 문을 달면 등급이 그쪽으로 몰린다",
        /검사 이름/.test(d),
        `§D 에 «검사 이름» ${(d.match(/검사 이름/g) ?? []).length}회`,
      ),
    );

    // ── ② §E 가 자기와 모순되지 않는다 ──────────────────────────────────
    //  ★«기각» 을 **세라고** 시키는 문장과 **세지 말라고** 하는 문장이 함께 있으면 안 된다.
    // ★**부정어가 든 줄은 지시가 아니다.** 첫 판이 금지 문장 자체(«집계 숫자(제기 N·기각
    //  N)는 **안 적는다**»)를 «세라는 지시» 로 세어 상시 빨강이었다 — 옳은 경고를 위반으로
    //  세는 게이트는 그 경고를 지우게 만든다. 줄 단위로 보고 부정어를 먼저 걷어낸다.
    const eLines = e.split("\n").filter((l) => l.includes("기각"));
    const denies = (l: string): boolean => /안 적|적지 않|쓰지 마|금지/.test(l);
    const tellsToCount = eLines.some((l) => !denies(l) && /수만 적|개수를 적|수를 적/.test(l));
    const tellsNotTo = eLines.some((l) => /집계 숫자/.test(l) && denies(l));
    out.push(
      assert(
        "★★§E 에 기각 집계 지시가 **두 벌이 아니다** — «집계 숫자는 안 적는다» 와 «기각된 것은 수만 적는다» 가 4행 간격으로 있어 어느 쪽을 따랐든 위반이었다",
        tellsNotTo && !tellsToCount,
        JSON.stringify({ 금지문: tellsNotTo, 세라는문장: tellsToCount }),
      ),
    );

    // ── ③ 계약(축2) 산출물이 발견 유무와 무관하게 필수다 ─────────────────
    const req = e.slice(0, e.indexOf("```", e.indexOf("```") + 3));
    out.push(
      assert(
        "★★보고 필수 줄에 **계약 변경 심볼 수·호출부 수**가 있다 — 다섯 축 중 혼자만 산출물이 숫자라 밖에서 검증되는데, 종전엔 «발견 0건일 때만» 축을 닫게 해 발견이 있으면 면제됐다",
        /계약:/.test(req) && /호출부/.test(req),
        req.split("\n").filter((l) => /:/.test(l) && !l.startsWith("★")).join(" / ").slice(0, 160),
      ),
    );
    return out;
  },
};
