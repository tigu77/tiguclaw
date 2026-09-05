/**
 * 회귀: **`hidden` 이라고 했으면 숨는다** (2026-09-05 사용자 신고 — 폰에서 발견).
 *
 * 사고: 인증 버튼 밑에 **빈 상자**가 떠 있었다. JS 는 `panel.hidden = true` 라고 믿는데
 * 화면엔 22px 짜리 테두리가 남아 있었다(실측). 원인은 CSS 캐스케이드다 — `hidden` 의 숨김은
 * **브라우저 기본 스타일**의 `display:none` 인데, 그 요소에 `display:grid` 를 적는 순간
 * **작성자 규칙이 이긴다.**
 *
 * ★그래서 이 레포엔 `X[hidden] { display:none }` 한 줄짜리가 **열두 개** 손으로 적혀 있었다.
 *  즉 «display 를 적는 요소에 hidden 을 쓰려면 한 줄을 더 적어라» 는 **암묵의 규칙**이 있었고,
 *  그건 기억해야만 지켜진다 — 실제로 새 기능(인증 패널)에서 잊혔다. 목록을 없애고 전역
 *  한 줄로 바꿨다([[feedback_hand_maintained_lists]]).
 *
 * ★`!important` 가 여기서 정당한 이유: 규칙 **순서와 무관하게** 이겨야 한다(미디어쿼리
 *  안에서 `display` 를 다시 적는 자리가 실제로 있다). 「숨기라고 했으면 숨는다」는 예외가
 *  없는 계약이고, 예외가 없는 계약은 특이성 경쟁에 맡기지 않는다.
 *
 * ★등급: 배선 린트. 실제 픽스처 판정은 헤드리스로 했다(숨김 15개 전부 `display:none`,
 *  문제의 패널 22px → 0px).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export const check: RegressionCheck = {
  name: "hidden-means-hidden",
  guards:
    "`hidden` 을 적은 요소에 display 규칙이 있으면 그게 이겨서, JS 는 숨겼다고 믿는데 화면엔 빈 상자가 남던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    let css: string;
    try {
      css = readFileSync(path.join(REPO, "packages/dashboard/app.css"), "utf8");
    } catch {
      return [assert("app.css 없음(배포 레포 아님)", true, "건너뜀")];
    }
    const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");

    const global = /\[hidden\]\s*\{\s*display:\s*none\s*!important\s*;?\s*\}/.exec(bare);
    out.push(
      assert(
        "★전역 규칙이 있다 — `[hidden] { display:none !important }`",
        global !== null,
        global === null ? "★없음 — display 를 적는 요소마다 한 줄을 기억해야 한다" : global[0],
      ),
    );

    // 그 규칙이 **맨 앞**에 있어야 하는 건 아니다(!important 라 순서 무관) — 대신 한 곳뿐이어야
    // 한다. 두 곳이면 하나를 지울 때 다른 하나가 남아 «고쳤는데 안 고쳐진» 상태가 된다.
    const count = [...bare.matchAll(/\[hidden\]\s*\{\s*display:\s*none\s*!important/g)].length;
    out.push(
      assert(
        "그 규칙이 하나뿐이다(두 벌이면 한쪽만 고쳐진다)",
        count === 1,
        `전역 규칙 ${count}개`,
      ),
    );

    // ★한 줄짜리 사본이 다시 자라지 않게 — 전역 규칙이 있으면 이것들은 전부 죽은 코드다.
    const oneOffs = [...bare.matchAll(/[^\n,{]*\[hidden\]\s*\{\s*display:\s*none;?\s*\}/g)]
      .map((m) => m[0].trim())
      .filter((r) => !r.startsWith("[hidden]"));
    out.push(
      assert(
        "★요소별 `X[hidden]` 사본이 없다(있으면 «잊으면 깨지는» 목록이 다시 생긴 것)",
        oneOffs.length === 0,
        oneOffs.length === 0 ? "사본 0" : `★사본 ${oneOffs.length}개: ${oneOffs.slice(0, 3).join(" · ")}`,
      ),
    );

    return out;
  },
};
export default check;
