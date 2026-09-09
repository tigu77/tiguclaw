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
    const moves = /\.chat-head-actions\s*>\s*button/.test(nav);
    const namesOne = /getElementById\("bg-toggle"\)[\s\S]{0,400}?insertBefore/.test(nav);
    out.push(
      assert(
        "★★모바일이 채팅 상단 버튼을 **상자째** sticky 헤더로 옮긴다 — 이름을 하나 적으면 옆에 나란한 버튼이 조용히 빠지고, 그건 «스크롤로 사라지는 상자» 에 갇힌다는 뜻이다(검색이 그랬다)",
        moves && !namesOne,
        JSON.stringify({ 상자째: moves, 이름하나로: namesOne }),
      ),
    );

    // ② iOS 확대 — 모바일에서 포커스 받는 입력이 16px 이상인가.
    //    ★«검색창» 만 세지 않는다. 둘을 같이 세야 다음에 셋째가 생겨도 같은 자리를 본다.
    const zoomSafe = (id: string): boolean =>
      new RegExp(`#${id}[^{}]*\\{[^{}]*font-size:\\s*(1rem|16px)`).test(css);
    out.push(
      assert(
        "★★모바일에서 **검색 입력이 16px 이상**이다 — iOS 는 그보다 작은 입력에 포커스가 가면 화면을 확대한다(채팅 입력창은 이미 막혀 있었는데 검색창만 빠졌다)",
        zoomSafe("chat-search-input"),
        `검색=${zoomSafe("chat-search-input")} · 채팅=${zoomSafe("chat-input")}`,
      ),
    );
    out.push(
      assert(
        "★채팅 입력창의 16px 도 그대로다 — 한쪽을 고치다 다른 쪽을 잃지 않는다",
        zoomSafe("chat-input"),
        `채팅=${zoomSafe("chat-input")}`,
      ),
    );

    // ③ 낱말 접기는 «정말 좁을 때만» — 실측(320~900px 넘침 0)으로 정한 문턱이다.
    const foldsNarrowOnly =
      /@media \(max-width: 3[0-5]\d px?\)|@media \(max-width: 3[0-5]\d\px\)|@media \(max-width: 359px\)/.test(css);
    out.push(
      assert(
        "★낱말 접기가 **아주 좁은 구간에만** 걸린다 — 종전엔 375px 실측 하나를 근거로 900px 이하 전부에서 낱말이 사라졌다(폰보다 훨씬 넓은 화면에서도)",
        foldsNarrowOnly,
        foldsNarrowOnly ? "좁은 구간 전용 규칙 있음" : "★900px 전체에 걸려 있다",
      ),
    );
    return out;
  },
};
