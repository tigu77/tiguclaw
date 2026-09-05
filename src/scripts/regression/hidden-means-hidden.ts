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
import { readdirSync, readFileSync } from "node:fs";
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

    // ── ★반대 방향: «보여야 할 것이 보이나» (2026-09-05 적대 검토 P1) ──────────
    //  이 검사는 여태 «숨기라고 했으면 숨나» 한쪽만 봤다. 그런데 전역 규칙이 실제로 낸
    //  사고는 **거울상**이었다: `hidden` 을 「숨김」이 아니라 「기본은 꺼짐, CSS 가 켠다」로
    //  쓰던 요소(`#wb-detail-back`)가 있었고, `!important` 가 그 켜기를 이겨 **폰에서
    //  목록으로 돌아가는 버튼이 통째로 사라졌다**(빈 46px 띠만 남음). 스위트 2,903건이
    //  초록인 채로 살아 있었고, 헤드리스 CDP 로 재서야 드러났다(0×0 → 고친 뒤 59×34).
    //
    //  ★판정은 **세 조건의 곱**이다. 첫 판에서 앞의 둘만 보고 오탐 3건을 냈다:
    //   ① HTML 에 **불리언 `hidden`** 이 있다 — `aria-hidden="true"` 를 세면 안 된다
    //     (`#cs-panel`·`#bg-panel` 이 그것 때문에 걸렸다. 둘은 aria 만 쓴다).
    //   ② CSS 가 그 id 를 `display:<none 아닌 것>` 으로 켠다.
    //   ③ **JS 가 그 속성을 안 뗀다** — 떼면 정상 용법이다(`#chat-ghost-accept` 는
    //     `acceptBtn.hidden = false` 로 뗀다. id 문자열 옆에 `hidden` 이 없어서 첫 판이
    //     못 봤다 — **변수를 거쳐** 만지기 때문이다. 그래서 변수를 풀어서 본다).
    const html = readFileSync(path.join(REPO, "packages/dashboard/index.html"), "utf8");
    const js = readdirSync(path.join(REPO, "packages/dashboard/js"))
      .filter((f) => f.endsWith(".js"))
      .map((f) => readFileSync(path.join(REPO, "packages/dashboard/js", f), "utf8"))
      .join("\n");

    /** 그 id 를 잡은 변수를 찾아, 그 변수가 `hidden` 을 만지나. */
    const jsTogglesHidden = (id: string): boolean => {
      const bind = new RegExp(
        `(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*document\\.getElementById\\(["'\`]${id}["'\`]\\)`,
      ).exec(js);
      const v = bind?.[1];
      if (v === undefined) return /getElementById\(["'`]/.test(js) ? false : true;
      return new RegExp(`\\b${v}\\.hidden\\s*=|\\b${v}\\.removeAttribute\\(["'\`]hidden`).test(js);
    };

    // ① 불리언 `hidden` 을 단 id — `aria-hidden` 은 제외(앞에 `-` 나 글자가 붙지 않은 것만).
    const boolHidden = [...html.matchAll(/<[^>]*\bid="([\w-]+)"[^>]*>/g)]
      .filter((m) => /(?:^|\s)hidden(?=[\s/>=])/.test(m[0]))
      .map((m) => m[1] ?? "");
    // ② CSS 가 켜는 id
    const turnedOn = new Set(
      [...bare.matchAll(/#([A-Za-z][\w-]*)[^{}]*\{[^{}]*display:\s*(?!none)([a-z-]+)/g)].map(
        (m) => m[1] ?? "",
      ),
    );
    // ③ JS 가 안 떼는 것만 남는다
    const conflicted = boolHidden.filter((id) => turnedOn.has(id) && !jsTogglesHidden(id));
    out.push(
      assert(
        "★★CSS 로 켜는 요소에 `hidden` 속성을 달고 **JS 가 떼지도 않으면** 안 된다 — 전역 규칙이 이겨서 영영 안 보인다",
        conflicted.length === 0,
        conflicted.length === 0
          ? `불리언 hidden ${boolHidden.length}개 · CSS 가 켜는 id ${turnedOn.size}개 · 싸우는 것 0`
          : `★싸우는 요소: ${conflicted.map((i) => "#" + i).join(", ")} — CSS 로 켜는데 속성으로 숨겼고 JS 도 안 뗀다`,
      ),
    );

    return out;
  },
};
export default check;
