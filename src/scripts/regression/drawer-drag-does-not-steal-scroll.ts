/**
 * 회귀: **드로어 제스처가 세로 스크롤을 뺏지 않는다** (2026-09-05 사용자 요청).
 *
 * 모바일 메뉴 드로어를 손가락으로 열고 닫게 하면서, 이 레포가 **한 번 당한 자리**를 다시
 * 지난다: 세션탭 pull-to-refresh 가 `touch-action` 선언을 뒤집어 스트립을 훑을 때마다
 * 새로고침이 됐고, 결국 걷어냈다(`mobile-nav.js` 주석). 터치 핸들러는 «가로로 갈 작정»이
 * 확인되기 전에 가로채면 안 된다 — 드로어 안은 세로로 긴 목록이다.
 *
 * ★그래서 지키는 것은 셋이다:
 *  ①세로가 우세한 움직임은 **절대 안 가져간다**(스크롤이 산다)
 *  ②닫혀 있을 땐 **왼쪽 가장자리**에서 시작한 오른쪽 밀기만 연다(화면 한복판 스와이프가
 *    목록·탭 제스처와 싸우지 않게)
 *  ③손을 뗄 때 **거리만 보지 않는다** — 짧고 빠른 플릭도 열려야 한다. 거리만 보면 빠른
 *    손은 매번 실패하고, 사용자는 제스처가 없는 줄 안다.
 *
 * ★등급: 판정은 순수 함수라 **여기서 실제로 돌린다**. 실제 터치 이벤트 배선(engaged 이후에만
 *  `preventDefault`)은 소스 스캔으로 본다 — 그건 브라우저가 있어야 하는 판정이다.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** `const <name> = (` 부터 짝 맞는 `}` 까지(블록 화살표 함수). */
const sliceFn = (src: string, name: string): string | null => {
  const start = src.indexOf(`const ${name} = (`);
  if (start < 0) return null;
  let depth = 0;
  let seen = false;
  for (let i = start; i < src.length; i++) {
    if (src[i] === "{") {
      depth++;
      seen = true;
    } else if (src[i] === "}") {
      depth--;
      if (seen && depth === 0) return `${src.slice(start, i + 1)};`;
    }
  }
  return null;
};

export const check: RegressionCheck = {
  name: "drawer-drag-does-not-steal-scroll",
  guards:
    "모바일 드로어 스와이프가 세로 스크롤·목록 제스처를 가로채던 부류(세션탭 pull-to-refresh 로 이미 한 번 당한 자리)",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    let src: string;
    try {
      src = readFileSync(path.join(REPO, "packages/dashboard/js/mobile-nav.js"), "utf8");
    } catch {
      return [assert("mobile-nav.js 없음(배포 레포 아님)", true, "건너뜀")];
    }

    const engageSrc = sliceFn(src, "drawerEngage");
    const settleSrc = sliceFn(src, "drawerSettle");
    out.push(
      assert(
        "★제스처 판정이 순수 함수다(핸들러 안이면 폰을 손에 들어야만 확인된다)",
        engageSrc !== null && settleSrc !== null,
        `engage=${engageSrc === null ? "★없음" : "있음"} settle=${settleSrc === null ? "★없음" : "있음"}`,
      ),
    );
    if (engageSrc === null || settleSrc === null) return out;

    const edge = /const DRAWER_EDGE_PX = (\d+)/.exec(src)?.[1] ?? "24";
    const engage = new Function(
      `const DRAWER_EDGE_PX = ${edge};${engageSrc}return drawerEngage;`,
    )() as (v: { dx: number; dy: number; startX: number; open: boolean }) => boolean;
    const settle = new Function(`${settleSrc}return drawerSettle;`)() as (v: {
      dx: number;
      elapsedMs: number;
      width: number;
      open: boolean;
    }) => boolean;

    // ── ① 세로 스크롤은 절대 안 뺏는다 ────────────────────────────────────────
    out.push(
      assert(
        "★세로가 우세하면 안 가져간다(닫힘·열림 양쪽) — 목록 스크롤이 산다",
        !engage({ dx: 6, dy: 40, startX: 2, open: false }) &&
          !engage({ dx: -6, dy: 40, startX: 120, open: true }),
        `닫힘(dx6,dy40)=${engage({ dx: 6, dy: 40, startX: 2, open: false })} · 열림(dx-6,dy40)=${engage({ dx: -6, dy: 40, startX: 120, open: true })}`,
      ),
    );
    out.push(
      assert(
        "손가락이 거의 안 움직였으면(<8px) 아무것도 안 한다(탭·흔들림)",
        !engage({ dx: 5, dy: 1, startX: 2, open: false }),
        `dx5,dy1 → ${engage({ dx: 5, dy: 1, startX: 2, open: false })}`,
      ),
    );

    // ── ② 여는 제스처는 가장자리에서만 ────────────────────────────────────────
    out.push(
      assert(
        "★닫혀 있을 땐 왼쪽 가장자리에서 시작한 오른쪽 밀기만 연다",
        engage({ dx: 30, dy: 4, startX: 5, open: false }) &&
          !engage({ dx: 30, dy: 4, startX: 200, open: false }),
        `가장자리(x5)=${engage({ dx: 30, dy: 4, startX: 5, open: false })} · 한복판(x200)=${engage({ dx: 30, dy: 4, startX: 200, open: false })} · 경계=${edge}px`,
      ),
    );
    out.push(
      assert(
        "열려 있을 땐 왼쪽으로 미는 것만 닫는다(오른쪽 밀기는 무시)",
        engage({ dx: -30, dy: 4, startX: 150, open: true }) &&
          !engage({ dx: 30, dy: 4, startX: 150, open: true }),
        `왼쪽(dx-30)=${engage({ dx: -30, dy: 4, startX: 150, open: true })} · 오른쪽(dx30)=${engage({ dx: 30, dy: 4, startX: 150, open: true })}`,
      ),
    );

    // ── ③ 놓을 때: 거리 + 플릭 ────────────────────────────────────────────────
    const W = 300;
    out.push(
      assert(
        "반 넘게 끌어냈으면 열린 채로 둔다 / 조금만 끌었으면 되돌아간다",
        settle({ dx: 160, elapsedMs: 600, width: W, open: false }) &&
          !settle({ dx: 40, elapsedMs: 600, width: W, open: false }),
        `160/${W}=${settle({ dx: 160, elapsedMs: 600, width: W, open: false })} · 40/${W}=${settle({ dx: 40, elapsedMs: 600, width: W, open: false })}`,
      ),
    );
    out.push(
      assert(
        "★짧고 빠른 플릭도 열린다(거리만 보면 빠른 손은 매번 실패한다)",
        settle({ dx: 60, elapsedMs: 90, width: W, open: false }),
        settle({ dx: 60, elapsedMs: 90, width: W, open: false })
          ? "60px/90ms → 열림"
          : "★플릭이 무시된다",
      ),
    );
    out.push(
      assert(
        "열린 상태에서 빠르게 왼쪽으로 튕기면 닫힌다",
        !settle({ dx: -60, elapsedMs: 90, width: W, open: true }),
        `-60px/90ms → 열린채=${settle({ dx: -60, elapsedMs: 90, width: W, open: true })}`,
      ),
    );

    // ── ④ 배선: 가로로 «가져간 뒤에만» 기본 동작을 막는다 ──────────────────────
    const move = src.slice(src.indexOf('document.addEventListener("touchmove"'));
    const body = move.slice(0, move.indexOf("{ passive: false }"));
    const engagedFirst = body.indexOf("track.engaged = true");
    const preventAt = body.indexOf("e.preventDefault()");
    out.push(
      assert(
        "★`preventDefault` 는 가로 판정을 통과한 뒤에만 부른다(그 전에 부르면 스크롤이 죽는다)",
        engagedFirst >= 0 && preventAt > engagedFirst,
        `engage=${engagedFirst} preventDefault=${preventAt}` +
          (engagedFirst >= 0 && preventAt > engagedFirst ? " (판정 뒤)" : " ★판정 전에 막는다"),
      ),
    );
    // ── ⑤ 드로어는 **자기 안에서 스크롤한다** ────────────────────────────────
    //  ★손가락으로 여는 것과 «열고 나서 닿는 것» 은 다른 문제다. 모바일 `#sidebar` 는
    //   `position:fixed; top:0; bottom:0` 인 오버레이인데 `overflow:visible` 이었다 —
    //   그러면 뷰포트를 넘는 부분에 **도달할 길이 없다**(실측: 520px 화면에서 마지막 항목
    //   «설정» 이 91px 밖, `scrollTop=9999` 를 넣어도 0). 사용자 신고가 바로 그거였다.
    const css = readFileSync(path.join(REPO, "packages/dashboard/app.css"), "utf8");
    const mobileSidebar = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/#sidebar \{([^}]*)\}/g)]
      .map((m) => m[1] ?? "")
      .filter((b) => /overflow/.test(b));
    const lastOverflow = mobileSidebar
      .map((b) => /overflow(?:-y)?\s*:\s*([a-z]+)/.exec(b)?.[1])
      .filter((v): v is string => v !== undefined)
      .pop();
    out.push(
      assert(
        "★드로어가 자기 안에서 스크롤한다 — 마지막 `#sidebar` overflow 선언이 `visible` 이 아니다",
        lastOverflow === "auto" || lastOverflow === "scroll",
        `overflow 선언 ${mobileSidebar.length}개 · 마지막=${lastOverflow ?? "★없음"}` +
          (lastOverflow === "visible" ? " ★뷰포트 밖 항목에 도달할 길이 없다" : ""),
      ),
    );
    out.push(
      assert(
        "드로어 끝에서 밀 때 뒤 페이지가 따라 움직이지 않는다(overscroll-behavior)",
        /#sidebar \{[^}]*overscroll-behavior\s*:\s*contain/.test(css.replace(/\/\*[\s\S]*?\*\//g, "")),
        /overscroll-behavior\s*:\s*contain/.test(css) ? "contain" : "★없음(스크롤이 뒤로 샌다)",
      ),
    );

    const dragCss = /body\.menu-dragging #sidebar \{[^}]*transition:\s*none[^}]*\}/.exec(
      readFileSync(path.join(REPO, "packages/dashboard/app.css"), "utf8"),
    )?.[0] ?? null;
    out.push(
      assert(
        "끄는 동안엔 전환 애니메이션을 끈다(손가락을 늦게 따라오면 무겁게 느껴진다)",
        dragCss !== null,
        dragCss === null ? "★menu-dragging 전환 해제 규칙 없음" : dragCss.trim(),
      ),
    );

    return out;
  },
};
export default check;
