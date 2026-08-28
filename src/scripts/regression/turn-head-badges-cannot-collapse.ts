/**
 * 회귀: **턴 카드 헤더의 배지는 접히지 않는다** (2026-08-28, 정태님 모바일 실측).
 *
 * ★사고: 모바일(390px)에서 도구 카드 헤더가 세로로 흘렀다 — `↓129.3K · 2회 · 캐시 …` 가
 *  **한 글자씩** 쌓여 헤더 하나가 293px 가 됐다(실측: 비용 배지 폭 12px · 높이 277px).
 *  본문이 빈 게 아니라 **헤더가 그만큼 커진 것**이라, 화면엔 커다란 검은 상자로 보였다.
 *
 * ★뿌리는 CSS 한 줄이 아니라 **규칙이 주석에만 있었다는 것**이다. `app.css` 는 이미
 *  *"압축은 항상 유연 텍스트(thread·last)가 흡수"* 라고 적어놨는데, 그건 사람만 읽는다.
 *  나중에 추가된 `.turn-cost`(2026-07-26)가 그 규칙을 놓쳤고 **아무도 못 봤다** —
 *  데스크톱에선 자리가 남아 증상이 안 나오기 때문이다. 다음 배지도 똑같이 놓칠 것이다.
 *  그래서 주석을 **판정**으로 바꾼다([[feedback_hand_maintained_lists]]).
 *
 * 불변식 — 헤더에 들어가는 배지는 둘 중 하나여야 한다:
 *   ① **고정**(`flex:none`) — 안 줄어든다. 대부분의 배지.
 *   ② **흡수자**(`white-space:nowrap` + 잘림) — 줄어들되 한 줄을 지키고 `…` 로 끊는다.
 * 둘 다 아니면 기본값 `flex:0 1 auto` + `white-space:normal` 이라 **세로로 흐른다.**
 *
 * ★배지 목록을 손으로 적지 않는다 — 그러면 이 검사가 바로 그 드리프트의 다음 사례가 된다.
 *  `virtualization.js` 의 헤더 조립 블록에서 **실제로 붙는 클래스**를 뽑아 쓴다.
 *
 * 등급: **소스 대조**(정직하게). 진짜 레이아웃은 브라우저만 안다 —
 * 실측은 `_workspace/_turnhead_mobile_cdp.mjs` 가 하고(390px 실기), 여기서는 그 실측이
 * 확인한 **규칙이 지켜지는지**를 지킨다. 스위트에 크롬을 들이지 않기 위한 의도적 분업이다.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const DASH = path.join(REPO, "packages/dashboard");

/** 헤더 조립 블록에서 **실제로 붙는** 클래스들. 손 목록이 아니라 소스에서 뽑는다. */
const badgeClassesInHead = (src: string): string[] => {
  const from = src.indexOf('head.className = "turn-head"');
  const to = src.indexOf("el.appendChild(head)", from);
  if (from < 0 || to < 0) return [];
  const block = src.slice(from, to);
  // ★`head` 에 **실제로 붙는 것**만 본다. 블록 안 모든 className 을 긁으면 같은 범위에서
  //  만들어지는 형제(`turn-body`)까지 딸려 와 검사가 엉뚱한 것을 판정한다(첫 판이 그랬다).
  const out = new Set<string>();
  for (const a of block.matchAll(/head\.appendChild\(\s*([A-Za-z_$][\w$]*)\s*\)/g)) {
    const ident = a[1] as string;
    const decl = block.match(
      new RegExp(`\\b${ident}\\.className\\s*=\\s*"([^"]+)"`),
    );
    if (decl === null) continue;
    for (const tok of (decl[1] as string).split(/\s+/)) {
      // `"act-badge act-" + adapter` 처럼 이어붙이는 조각(`act-`)은 완전한 클래스가 아니다.
      if (tok === "" || tok.endsWith("-")) continue;
      out.add(tok);
    }
  }
  return [...out];
};

/** 그 클래스를 겨냥하는 **모든** 규칙의 선언을 합친다(`.turn-head > .ts` 같은 형태 포함). */
const declarationsFor = (css: string, cls: string): string => {
  const re = new RegExp(`(^|[\\s,>+~])\\.${cls.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`);
  let acc = "";
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = m[1] as string;
    // `.turn-cost.heavy` 처럼 상태 변형도 같은 요소다 — 선택자 단위로 본다.
    if (sel.split(",").some((s) => re.test(s))) acc += `${m[2] as string};`;
  }
  return acc.replace(/\s+/g, "");
};

const isPinned = (d: string): boolean => /flex:none|flex:00/.test(d);
const isAbsorber = (d: string): boolean =>
  /white-space:nowrap/.test(d) && /text-overflow:ellipsis|overflow:hidden/.test(d);

export const check: RegressionCheck = {
  name: "turn-head-badges-cannot-collapse",
  guards:
    "모바일에서 턴 카드 헤더의 배지가 압축돼 한 글자씩 세로로 흐르던 것(비용 배지 폭 12px·높이 277px, 헤더 293px) — 규칙이 주석에만 있어 나중에 추가된 배지가 놓쳤다",
  run: async (): Promise<Assertion[]> => {
    const css = readFileSync(path.join(DASH, "app.css"), "utf8");
    const vjs = readFileSync(path.join(DASH, "js/virtualization.js"), "utf8");
    const classes = badgeClassesInHead(vjs);

    const out: Assertion[] = [
      assert(
        "★배지를 **소스에서 찾았다**(0이면 아래가 전부 미검사다 — 헤더 조립부가 옮겨간 것)",
        classes.length >= 5,
        classes.join(", ") || "★못 찾음",
      ),
    ];

    const bad: string[] = [];
    for (const cls of classes) {
      const d = declarationsFor(css, cls);
      if (d === "") bad.push(`${cls}(규칙 없음=기본 압축)`);
      else if (!isPinned(d) && !isAbsorber(d)) bad.push(`${cls}(고정도 흡수자도 아님)`);
    }
    out.push(
      assert(
        "★★모든 헤더 배지가 **고정(flex:none)이거나 흡수자(nowrap+잘림)**다 — 둘 다 아니면 좁은 화면에서 한 글자씩 세로로 흐른다",
        bad.length === 0,
        bad.length === 0 ? `${classes.length}개 전부 통과` : `★${bad.join(" / ")}`,
      ),
    );

    // 배지가 전부 고정이면 좁은 화면에선 한 줄에 못 담긴다(실측 486px > 366px). `.turn-card`
    // 가 overflow:hidden 이라 **접지 않으면 오른쪽이 잘려 사라진다** — 같은 메타 줄인
    // `.bubble-meta` 는 처음부터 wrap 이었다(같은 규칙을 두 곳이 달리 갖고 있었다).
    const headDecl = declarationsFor(css, "turn-head");
    const bubbleDecl = declarationsFor(css, "bubble-meta");
    out.push(
      assert(
        "★★헤더가 **접힌다**(flex-wrap:wrap) — 배지가 전부 고정이라 안 접으면 잘려 사라진다(390px 실측 486>366)",
        /flex-wrap:wrap/.test(headDecl),
        /flex-wrap:wrap/.test(headDecl) ? "wrap" : "★nowrap — 오른쪽이 잘린다",
      ),
      assert(
        "★같은 메타 줄인 답변 버블 헤더와 **규칙이 같다**(두 경로가 갈리면 도구 유무로 화면이 달라진다)",
        /flex-wrap:wrap/.test(bubbleDecl),
        /flex-wrap:wrap/.test(bubbleDecl) ? "bubble-meta 도 wrap" : "★갈렸다",
      ),
    );
    return out;
  },
};
