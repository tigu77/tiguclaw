/**
 * 회귀: **모바일 채팅 상단 버튼이 손에 닿는다** (2026-09-09 정태님: *"모바일 채팅에서
 * 검색이 안보여"*).
 *
 * 사고: 모바일에서 `#stream-bar`(채팅 제목 줄)는 **페이지 스크롤로 사라지는** 상자다.
 * 검색 버튼이 그 안에 있어서, 대화가 한 화면을 넘으면 맨 위까지 되돌아가야만 나왔다 —
 * 긴 대화에선 사실상 없는 기능이다.
 *
 * ★**같은 문제가 이미 한 번 고쳐져 있었다.** `mobile-nav.js` 주석이 그대로 말한다:
 *  *"백그라운드 버튼을 sticky 헤더로 이동(원래 #stream-bar 안이라 페이지스크롤로 사라져
 *  접근 불가였다)"*. 그런데 **바로 옆에 나란히 있던 검색 버튼**은 안 옮겼다 — 같은 상자에
 *  있으니 같은 운명인데, 옮길 대상을 **이름 하나로** 적었기 때문이다.
 *  그래서 여기서 세는 것은 «검색이 옮겨졌나» 가 아니라 **«이름을 열거하지 않나»** 다 —
 *  셋째 버튼이 생겨도 저절로 따라와야 한다([[feedback_hand_maintained_lists]]).
 *
 * ★그리고 iOS 는 **16px 미만 입력**에 포커스가 가면 화면을 확대한다(정태님: *"모바일에서
 *  검색 누르면 지금 확대되는거 같은데 확대는 필요없어"*). 채팅 입력창은 `1rem` 으로 이미
 *  막아뒀는데 **검색창만 빠져 있었다** — 같은 병인데 한 곳만 고친 것이라, 여기서 둘을
 *  같이 센다(하나만 고치면 다시 갈린다).
 */
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";
import { readSourceSync, stripComments } from "./_wiring.js";

export const check: RegressionCheck = {
  name: "mobile-chat-actions-reachable",
  guards:
    "모바일에서 채팅 검색 버튼이 스크롤로 사라져 못 쓰던 것 + 검색창 포커스에 iOS 가 " +
    "화면을 확대하던 것(채팅 입력창은 막혀 있었는데 검색창만 빠졌다)",
  async run(): Promise<Assertion[]> {
    const nav = stripComments(readSourceSync("packages/dashboard/js/mobile-nav.js"));
    const css = stripComments(readSourceSync("packages/dashboard/app.css"));
    const out: Assertion[] = [];

    // ① 옮기는 대상이 «그 상자 안의 버튼 전부» 인가 — 이름을 적으면 옆이 빠진다.
    const box = /\.chat-head-actions/.test(nav);
    const allButtons = /querySelectorAll\(\s*["'](?:\.chat-head-actions\s*>\s*button|:scope\s*>\s*button)["']/.test(nav);
    const namesOne = /querySelectorAll\([^)]*button#|getElementById\("(bg-toggle|chat-search-btn)"\)[\s\S]{0,300}?(insertBefore|appendChild)/.test(nav);
    out.push(
      assert(
        "★★모바일이 채팅 상단 버튼을 **상자째** sticky 헤더로 옮긴다 — 이름을 하나 적으면 옆에 나란한 버튼이 조용히 빠지고, 그건 «스크롤로 사라지는 상자» 에 갇힌다는 뜻이다(검색이 그랬다)",
        box && allButtons && !namesOne,
        JSON.stringify({ 상자: box, 버튼전부: allButtons, 이름하나로: namesOne }),
      ),
    );
    // ★**옮기는 코드가 실제로 있나** (적대 검토 B4: 셀렉터만 두고 이동을 지워도 초록이었다).
    out.push(
      assert(
        "★모아둔 버튼을 실제로 헤더에 **넣는다** — 셀렉터만 남기고 이동을 지우면 «상자째» 는 참인데 아무 버튼도 안 옮겨진다",
        /mnHeader\.(insertBefore|appendChild)\(/.test(nav),
        /mnHeader\.(insertBefore|appendChild)\(/.test(nav) ? "헤더 삽입 있음" : "★삽입 없음",
      ),
    );
    // ★**폭이 바뀌면 다시 판정하나** (적대 검토 P3: 로드 1회 판정이라 창을 좁히면 원래
    //  버그가 그대로 돌아왔다 — 폰 회전도 900px 경계를 넘는다).
    // ★**블록 안을 본다 — 문자열 존재가 아니라** (2026-09-09, 코드 리뷰).
    //  첫 판은 `@media (max-width: 359px)` 가 파일 어딘가 있기만 하면 초록이었다. 그래서
    //  ①900px 블록에 낱말 접기를 도로 넣어도 ②359px 블록 본문을 통째로 비워도 통과했다 —
    //  ①이 정확히 이 검사가 막겠다고 적은 회귀다(«375px 실측 하나로 900px 이하 전부에서
    //  낱말이 사라졌다»). 더구나 정규식 세 갈래 중 둘은 어떤 CSS 에도 안 맞는 죽은 갈래였다.
    // ★**같은 조건의 블록이 여럿이다** — 첫 것만 보면 안 된다(실측: 900px 블록이 파일에
    //  여러 벌 있고, 낱말 접기는 그중 뒤쪽에 있다. 첫 판이 그래서 변이를 놓쳤다).
    const blockBodies = (cond: RegExp): string => {
      const found: string[] = [];
      for (const m of css.matchAll(new RegExp(cond.source, "g"))) {
        // 중첩 `@media` 를 세며 짝 맞는 `}` 까지 — 얕게 자르면 옆 블록을 본다.
        let depth = 0;
        for (let k = m.index; k < css.length; k += 1) {
          if (css[k] === "{") depth += 1;
          else if (css[k] === "}") {
            depth -= 1;
            if (depth === 0) { found.push(css.slice(m.index, k)); break; }
          }
        }
      }
      return found.join("\n");
    };
    const wide = blockBodies(/@media \(max-width:\s*900px\)/);
    const narrow = blockBodies(/@media \(max-width:\s*3[0-5]\d px\)|@media \(max-width:\s*3[0-5]\dpx\)/);
    const foldRe = /(\.bg-word|\.cs-word)[^{}]*\{[^{}]*display:\s*none/;
    // 900px 블록에서 좁은 블록을 빼야 «넓은 구간» 만 남는다(중첩이라 문자열이 포함된다).
    const wideOnly = narrow === "" ? wide : wide.split(narrow).join("");
    out.push(
      assert(
        "★★낱말 접기가 **좁은 구간 안에만** 있다 — 900px 블록에 있으면 폰보다 훨씬 넓은 화면에서도 «백그라운드»·«검색» 글자가 사라진다(375px 실측 하나를 900px 전체에 적용했던 그 회귀)",
        narrow !== "" && foldRe.test(narrow) && !foldRe.test(wideOnly),
        JSON.stringify({
          좁은블록: narrow !== "",
          좁은블록에접기: foldRe.test(narrow),
          넓은구간에접기: foldRe.test(wideOnly),
        }),
      ),
    );
    return out;
  },
};
