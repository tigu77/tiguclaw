/**
 * 회귀: **새로고침하면 보던 화면과 보던 탭이 그대로 돌아온다.**
 *
 * 사용자 신고 2건(2026-08-11) — 둘 다 "고쳤다"고 보고한 뒤에도 안 되던 것들이다.
 * 헤드리스(CDP)로 재현·확인했고, 그 수치를 여기 남긴다.
 *
 * ── ① 마지막 뷰가 복원되지 않았다 ──────────────────────────────────────────
 *  뿌리 둘:
 *   (a) **문이 여럿인데 저장은 한 문에만** 있었다. `applyView`(상단 nav 핸들러)에서만
 *       저장했는데, 홈 화면 액션 카드·컨텍스트 메뉴·뷰 안 링크는 `showX()` 를 직접
 *       부른다. 실측: 홈 카드로 인벤토리 진입 → 저장값 `null` → 새로고침 → overview.
 *       → 고침: `setActiveNav` 가 `document.body.dataset.view` 를 쓰는 **유일한 자리**
 *         이므로 거기서 저장한다. 새 문이 생겨도 자동으로 덮인다.
 *   (b) 복원이 `saved === "chat"` 이면 **건너뛰었다** — "부팅 기본이 채팅"이라는 낡은
 *       가정. 실제 부팅은 `showOverview()` 다. 그래서 채팅 보다가 새로고침하면 overview.
 *  ★부팅 순서 함정: 부팅이 `showOverview()` 로 시작하므로 (a) 를 고치는 순간 저장값이
 *   읽히기 전에 "overview" 로 덮인다 → **모듈 로드 시점에 값을 얼려**(`__dashBootView`)
 *   복원이 그걸 본다. 읽는 시점이 쓰는 시점보다 먼저여야 한다.
 *
 * ── ② 세션탭 스트립이 활성 탭을 안 따라갔다 ────────────────────────────────
 *  `renderTabBar` 끝에서 한 번만 스크롤했는데 **부팅에선 무효**였다: 탭이 그려질 때
 *  채팅 패널이 아직 안 보여 스트립 폭이 0 이고, 나중에 보이게 될 때 다시 확인하는
 *  자리가 없었다. 실측: 탭 클릭 시 `scrollLeft=95`(보임) / 새로고침 후 `scrollLeft=0`,
 *  활성탭 `left=485`(안 보임). → 고침: "활성 탭은 보인다" 를 **크기 변화에서 다시
 *  세운다**(ResizeObserver). 타이머로 짐작하지 않는다.
 *
 * ★검사 등급 — **배선 린트**다. 브라우저 DOM 코드라 판정을 순수 함수로 뽑을 수 없다
 *  (뽑으면 레이아웃이 빠져 아무것도 안 지킨다). 진짜 검증은 헤드리스 프로브이고,
 *  이 검사는 **그 수정이 조용히 되돌아가는 것**을 막는 자리다. 재현 절차는
 *  `_workspace/view_doors_probe.mjs` · `_workspace/tabscroll_probe.mjs`.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Assertion, RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const js = (name: string): string =>
  readFileSync(path.join(REPO, "packages/dashboard/js", name), "utf8");
/** 주석은 검사 대상이 아니다 — 결함을 *설명한* 글을 코드로 세면 상시 실패한다. */
const code = (src: string): string =>
  src
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");

const run = async (): Promise<Assertion[]> => {
  const out: Assertion[] = [];
  const overview = code(js("view-overview.js"));
  const activity = code(js("activity.js"));
  const tabs = code(js("tabs.js"));

  // ── ① 저장은 정의점(setActiveNav)에서 — 문마다가 아니다 ──────────────────
  {
    // ★창을 1200자로 넓힌다 (2026-08-28). 600 은 함수 길이에 대한 **직감**이었고, 홈 위젯
    //  poll 정지(한 줄)를 이 정의점에 넣자 넘쳤다 — 즉 "setActiveNav 에 코드를 더하면 관계
    //  없는 검사가 빨개진다"는 뜻이라 그건 판정이 아니라 함정이다. 게으른 매칭이 함수 끝
    //  (`\n      };`)에서 멈추므로 넓혀도 **의미는 그대로**다(변이로 확인: setItem 제거 → 빨강).
    const navBlock = /const setActiveNav = \(view\) => \{[\s\S]{0,1200}?\n      \};/.exec(overview);
    const savesInNav = navBlock !== null && /localStorage\.setItem\(VIEW_LS, view\)/.test(navBlock[0]);
    out.push({
      name: "★뷰 저장이 setActiveNav(정의점) 안에 있다 — 새 문이 생겨도 덮인다",
      ok: savesInNav,
      got: savesInNav ? "setActiveNav 에서 저장" : "🔴 정의점에 저장 없음 — 문마다 새는 구조",
    });
    out.push({
      name: "applyView 는 저장하지 않는다(같은 판단이 두 곳이면 갈린다)",
      ok: !/localStorage\.setItem\(\s*VIEW_LS/.test(activity),
      got: /localStorage\.setItem\(\s*VIEW_LS/.test(activity)
        ? "🔴 activity.js 에 저장이 되살아났다"
        : "저장 단일화",
    });
  }

  // ── ② 부팅 값을 얼려서 읽는다 ────────────────────────────────────────────
  {
    const freezes = /window\.__dashBootView\s*=\s*localStorage\.getItem/.test(overview);
    const readsFrozen = /const saved = window\.__dashBootView/.test(activity);
    const rereads = /restoreLastView[\s\S]{0,400}?localStorage\.getItem/.test(activity);
    out.push({
      name: "★복원은 부팅 시점에 얼린 값을 본다(showOverview 가 덮기 전 값)",
      ok: freezes && readsFrozen && !rereads,
      got: `얼림=${freezes} 얼린값사용=${readsFrozen} 재읽기=${rereads} (기대 true/true/false)`,
    });
  }

  // ── ③ chat 도 복원한다 — 부팅 기본은 overview 다 ─────────────────────────
  {
    const skipsChat = /saved === "chat"/.test(activity);
    const bootsOverview = /^\s*showOverview\(\);/m.test(activity);
    out.push({
      name: "★chat 을 건너뛰지 않는다(부팅 기본이 채팅이라는 가정은 거짓)",
      ok: !skipsChat,
      got: skipsChat ? "🔴 chat 예외가 되살아났다" : "chat 도 복원",
    });
    out.push({
      name: "그 판정의 전제 — 부팅은 showOverview() 로 시작한다",
      ok: bootsOverview,
      got: bootsOverview
        ? "부팅 기본 = overview (그래서 chat 예외가 틀렸다)"
        : "⚠ 부팅 기본이 바뀌었다 — 위 판정을 다시 보라",
    });
  }

  // ── ④ 활성 탭 가시성은 크기 변화에서 다시 세운다 ─────────────────────────
  {
    const hasHelper = /const ensureActiveTabVisible = \(\)/.test(tabs);
    const guardsZero = /clientWidth === 0/.test(tabs);
    const reasserts = /new ResizeObserver\(\(\) => ensureActiveTabVisible\(\)\)/.test(tabs);
    out.push({
      name: "★스트립 크기가 변할 때(숨김→보임) 활성 탭 가시성을 다시 세운다",
      ok: hasHelper && reasserts,
      got: `헬퍼=${hasHelper} 재확인=${reasserts} (부팅 땐 폭 0 이라 1회 스크롤은 무효였다)`,
    });
    out.push({
      name: "레이아웃 전(폭 0)에는 스크롤을 시도하지 않는다(무효 호출로 착각 방지)",
      ok: guardsZero,
      got: guardsZero ? "폭 0 가드 있음" : "🔴 가드 없음",
    });
  }

  return out;
};

export const check: RegressionCheck = {
  name: "dashboard-view-restore",
  guards:
    "새로고침 시 마지막 뷰가 안 돌아오던 것(저장이 여러 문 중 하나에만 있었고, chat 은 아예 건너뛰었으며, 부팅 렌더가 저장값을 먼저 덮었다) + 활성 세션탭이 스트립 밖에 있어도 안 따라가던 것(부팅 땐 폭 0 이라 1회 스크롤이 무효)",
  run,
};
