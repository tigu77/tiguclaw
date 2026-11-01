/**
 * 회귀: **메인 메뉴 접기(아이콘 레일)** — 넓은 화면에서만, 이름은 화면에서만 감추고, 상태는 사용자 토글만 바꾼다 (2026-11-01).
 *
 * 설계: docs/decisions/2026-10-31-main-menu-collapse-design.md (§2·§6). 실제 픽셀(64px·툴팁 위치·짧은 높이·스크롤바)은
 *  헤드리스 Chrome 으로 쟀다(같은 문서 구현 기록) — 노드에선 CSS 캐스케이드를 계산할 수 없으니 여기선 그 판정의 **재료**를 지킨다.
 *
 * 지키는 것:
 *  ① 메뉴 버튼마다 비어 있지 않은 아이콘(`.ic`)과 이름(`.label`)이 있다 — 레일엔 아이콘만 남으므로 아이콘이 빠지면 빈 칸이 된다.
 *     판정은 `index.html` 에서 파생한다(이름 열거 없음 — 새 메뉴도 자동 대상).
 *  ② 레일 규칙(`body.nav-rail …`)과 토글 보이기는 **전부** `@media (min-width: 901px)` 안이다 — 밖에 새면 모바일 드로어가 레일이 된다.
 *     토글의 기본 숨김은 미디어 밖 최상위다(켜는 쪽만 넓은 화면).
 *  ③ 레일에서 이름(`.label`·`.hint`)은 `display:none`/`visibility:hidden` 이 아니라 **화면에서만** 감춘다 — 접근 이름이 펼침과 같아야 한다.
 *  ④ 진짜 `nav-rail.js` 를 미니 DOM 에서: 처음은 펼침 · 토글이 클래스·저장값·`aria-expanded`·이름을 함께 바꾼다 ·
 *     저장값 «1» 로 부팅하면 레일 · 저장소가 막혀도 펼침으로 뜨고 토글은 그 화면에서 동작한다.
 *  ⑤ 페이지에 실린다 — `index.html`·`_manifest.json` 둘 다, `side-panels.js` 뒤(토글 직후 `sidePanels.enforce()` 를 부른다).
 *
 * 등급: ①②③⑤ 소스·자산 게이트 · ④ 동작(미니 DOM).
 */
import { readFileSync } from "node:fs";
import { assert, i18nForContext, type Assertion, type RegressionCheck } from "./_framework.js";
import { bootDashboard, dashSource, dispatch, jsonResponse, makeClock, makeEvent } from "./_mini-dom.js";

const DASH = "packages/dashboard";

/** `@media (min-width: 901px)` 블록 본문들과, 그 블록들을 걷어낸 나머지 — 중괄호 짝으로 자른다. */
const splitDesktopMedia = (css: string): { inside: string; outside: string } => {
  let inside = "";
  let outside = "";
  let i = 0;
  const re = /@media\s*\(\s*min-width\s*:\s*901px\s*\)\s*\{/g;
  for (let m = re.exec(css); m !== null; m = re.exec(css)) {
    outside += css.slice(i, m.index);
    let depth = 1;
    let j = m.index + m[0].length;
    for (; j < css.length && depth > 0; j++) {
      if (css[j] === "{") depth++;
      else if (css[j] === "}") depth--;
    }
    inside += css.slice(m.index + m[0].length, j - 1) + "\n";
    i = j;
    re.lastIndex = j;
  }
  outside += css.slice(i);
  return { inside, outside };
};

const rules = (css: string): Array<{ selector: string; body: string }> =>
  [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: (m[1] ?? "").trim(), body: m[2] ?? "" }));

export const check: RegressionCheck = {
  name: "dashboard-nav-rail",
  guards: "메인 메뉴 아이콘 레일 — 아이콘 빠진 메뉴(빈 칸) · 레일 규칙이 모바일로 샘 · 이름을 접근 트리에서까지 지움 · 토글이 상태/이름/저장을 따로 바꿈",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const html = readFileSync(`${DASH}/index.html`, "utf8").replace(/<!--[\s\S]*?-->/g, "");
    const css = readFileSync(`${DASH}/app.css`, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

    // ① 메뉴 버튼마다 아이콘·이름
    const aside = /<aside id="sidebar"[\s\S]*?<\/aside>/.exec(html)?.[0] ?? "";
    const buttons = [...aside.matchAll(/<button class="nav-button[^"]*"[^>]*>([\s\S]*?)<\/button>/g)].map((m) => m[1]!);
    const text = (inner: string, cls: string): string =>
      (new RegExp(`<span class="${cls}"[^>]*>([^<]*)</span>`).exec(inner)?.[1] ?? "").trim();
    const bad = buttons
      .map((b, i) => ({ i, ic: text(b, "ic"), label: text(b, "label") }))
      .filter((b) => b.ic === "" || b.label === "");
    // 메뉴마다 갈 화면이 다르다 — 레일에선 이름이 안 보여 같은 화면으로 가는 아이콘 둘을 구분할 길이 없다(재확인 사냥 N7: 설정 → 홈).
    const views = [...aside.matchAll(/<button class="nav-button[^"]*" data-view="([^"]+)"/g)].map((m) => m[1]!);
    const dupViews = views.filter((v, i) => views.indexOf(v) !== i);
    out.push(
      assert(
        "★① 사이드바 메뉴 버튼마다 비어 있지 않은 아이콘(.ic)과 이름(.label)이 있다(index.html 에서 뽑은 전부)",
        buttons.length >= 8 && bad.length === 0 && views.length === buttons.length && dupViews.length === 0,
        bad.length === 0 && dupViews.length === 0
          ? `${buttons.length}개 모두 아이콘·이름 있음 · 화면 ${views.length}개 서로 다름`
          : `★빈 칸: ${bad.map((b) => `#${b.i}(ic=${b.ic || "∅"},label=${b.label || "∅"})`).join(", ")} · 같은 화면: ${dupViews.join(", ")}`,
      ),
    );

    // ② 레일 규칙은 데스크톱 미디어 안
    const { inside, outside } = splitDesktopMedia(css);
    const insideRail = rules(inside).filter((r) => /\.nav-rail\b/.test(r.selector));
    const leaked = rules(outside).filter((r) => /body\.nav-rail\b/.test(r.selector)).map((r) => r.selector);
    out.push(
      assert(
        "★② 레일 규칙(body.nav-rail …)은 전부 `@media (min-width: 901px)` 안이다 — 밖에 새면 모바일 드로어가 레일이 된다",
        insideRail.length >= 3 && leaked.length === 0,
        leaked.length === 0 ? `미디어 안 ${insideRail.length}규칙 · 밖 0` : `★밖에 샘: ${leaked.join(" | ")}`,
      ),
    );
    const toggleShownOutside = rules(outside).filter(
      (r) => r.selector.split(",").some((s) => /#nav-rail-toggle$/.test(s.trim())) && /display\s*:\s*(?!none)/.test(r.body),
    );
    const toggleHiddenBase = rules(outside).some((r) => r.selector === "#nav-rail-toggle" && /display\s*:\s*none/.test(r.body));
    const toggleShownInside = rules(inside).some((r) => r.selector === "#nav-rail-toggle" && /display\s*:\s*inline-flex/.test(r.body));
    out.push(
      assert(
        "② 토글은 기본 숨김(미디어 밖) · 넓은 화면에서만 보인다(미디어 안)",
        toggleHiddenBase && toggleShownInside && toggleShownOutside.length === 0,
        { toggleHiddenBase, toggleShownInside, shownOutside: toggleShownOutside.map((r) => r.selector) },
      ),
    );

    // ③ 이름은 화면에서만 감춘다
    const nameRules = insideRail.filter((r) => /\.nav-button\s+\.(label|hint)\b/.test(r.selector));
    const covers = (cls: string): boolean => nameRules.some((r) => new RegExp(`\\.nav-button\\s+\\.${cls}\\b`).test(r.selector));
    const visuallyHidden = nameRules.every((r) => /clip-path\s*:\s*inset\(50%\)/.test(r.body) && !/display\s*:\s*none|visibility\s*:\s*hidden/.test(r.body));
    const removedAnywhere = rules(inside + outside).filter(
      (r) => /\.nav-rail\b[^,]*\.nav-button[^,]*\.(label|hint)\b/.test(r.selector) && /display\s*:\s*none|visibility\s*:\s*hidden/.test(r.body),
    );
    out.push(
      assert(
        "★③ 레일에서 .label·.hint 는 화면에서만 감춘다(clip) — display:none·visibility:hidden 이면 접근 이름이 바뀐다",
        covers("label") && covers("hint") && visuallyHidden && removedAnywhere.length === 0,
        { label: covers("label"), hint: covers("hint"), visuallyHidden, removed: removedAnywhere.map((r) => r.selector) },
      ),
    );

    // ④ 진짜 nav-rail.js — 토글·저장·이름·부팅 복원·저장 실패
    const sidebarHtml = /<aside id="sidebar"[\s\S]*?<\/aside>/.exec(readFileSync(`${DASH}/index.html`, "utf8"))?.[0] ?? "";
    const boot = (storage?: unknown) =>
      bootDashboard({
        clock: makeClock(), i18n: i18nForContext, upTo: "update-chip.js", html: sidebarHtml,
        fetch: async () => jsonResponse({}, 404),
        ...(storage === undefined ? {} : { extra: { localStorage: storage } }),
      });
    const state = (d: ReturnType<typeof boot>, store: { getItem: (k: string) => string | null }) => {
      const t = d.document.getElementById("nav-rail-toggle");
      let saved: string | null = null;
      try { saved = store.getItem("dash.navRail.v1"); } catch { saved = "(throws)"; }
      return {
        rail: d.document.body.classList.contains("nav-rail"),
        expanded: t?.getAttribute("aria-expanded") ?? null,
        label: t?.getAttribute("aria-label") ?? null,
        title: (t as unknown as { title?: string } | null)?.title ?? null,
        glyph: t?.querySelector(".nrt-glyph")?.textContent ?? null,
        saved,
      };
    };
    const mem = (init?: string) => {
      const m = new Map<string, string>(init === undefined ? [] : [["dash.navRail.v1", init]]);
      return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, String(v)), removeItem: (k: string) => void m.delete(k) };
    };
    const ko = (k: string): string => i18nForContext(k);
    const s1 = mem();
    const d1 = boot(s1);
    const p0 = state(d1, s1);
    d1.document.getElementById("nav-rail-toggle")?.click();
    const p1 = state(d1, s1);
    d1.document.getElementById("nav-rail-toggle")?.click();
    const p2 = state(d1, s1);
    out.push(
      assert(
        "★④ 처음은 펼침 · 토글 한 번 = 레일+저장«1»+aria-expanded=false+이름«펼치기» · 다시 = 펼침+저장«0»",
        !p0.rail && p0.expanded === "true" && p0.label === ko("nav.rail.collapse") && p0.saved === null &&
          p1.rail && p1.saved === "1" && p1.expanded === "false" && p1.label === ko("nav.rail.expand") && p1.title === p1.label && p1.glyph === "›" &&
          !p2.rail && p2.saved === "0" && p2.expanded === "true" && p2.label === ko("nav.rail.collapse") && p2.glyph === "‹" &&
          ko("nav.rail.collapse") !== "nav.rail.collapse",
        { p0, p1, p2 },
      ),
    );
    const s2 = mem("1");
    const d2 = boot(s2);
    const q = state(d2, s2);
    out.push(
      assert("④ 저장값 «1» 로 부팅하면 레일로 뜨고 토글이 그 상태를 말한다", q.rail && q.expanded === "false" && q.label === ko("nav.rail.expand"), q),
    );
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => {} };
    let bootErr = "";
    let r0 = { rail: true, expanded: "" as string | null }, r1 = { rail: false, expanded: "" as string | null };
    try {
      const d3 = boot(broken);
      r0 = state(d3, broken);
      d3.document.getElementById("nav-rail-toggle")?.click();
      r1 = state(d3, broken);
    } catch (e) {
      bootErr = String(e);
    }
    out.push(
      assert(
        "④ 저장소가 막혀도(프라이빗) 펼침으로 뜨고, 토글은 그 화면에서 동작한다",
        bootErr === "" && !r0.rail && r0.expanded === "true" && r1.rail && r1.expanded === "false",
        bootErr || { r0, r1 },
      ),
    );

    // ⑥ 레일의 실제 모양 — 값으로(«규칙이 있다» 가 아니라 «그 값이다»). 2026-11-01 독립 변이 사냥 구멍 D2·C1·C3·C4·C5·C9·C10.
    const ruleIn = (scope: string, sel: string): string =>
      rules(scope).filter((r) => r.selector.split(",").map((s) => s.trim()).includes(sel)).map((r) => r.body).join(";");
    const decl = (body: string, prop: string): string => (new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(body)?.[1] ?? "").trim();
    const sidebarPadTop = /^(\d+)px/.exec(decl(ruleIn(outside, "#sidebar"), "padding"))?.[1];
    const shape = {
      railCols: decl(ruleIn(inside, "body.nav-rail main"), "grid-template-columns"),
      brandPos: decl(ruleIn(inside, ".nav-brand"), "position"),
      brandTop: decl(ruleIn(inside, ".nav-brand"), "top"),
      sidebarPadTop,
      scrollPad: decl(ruleIn(inside, "#sidebar"), "scroll-padding-top"),
      brandTextHidden: decl(ruleIn(inside, "body.nav-rail .nav-brand > .nav-kicker"), "display") === "none" && decl(ruleIn(inside, "body.nav-rail .nav-brand > .nav-title"), "display") === "none",
      btnCenter: decl(ruleIn(inside, "body.nav-rail .nav-button"), "justify-content") === "center" && decl(ruleIn(inside, "body.nav-rail .nav-button"), "padding-inline") === "0",
      tipDisplay: rules(css).filter((r) => /\.nav-rail-tip\b/.test(r.selector)).map((r) => decl(r.body, "display")).filter((v) => v !== ""),
      // 현재 화면 강조 — 레일에서도 이 규칙 하나가 보여 준다(재확인 사냥 N3). 배경·테두리가 투명하면 강조가 없다.
      activeBg: decl(ruleIn(outside, ".nav-button.active"), "background"),
      activeBorder: decl(ruleIn(outside, ".nav-button.active"), "border-color"),
      // 레일에서 아이콘·버튼을 가리는 규칙이 없다(재확인 사냥 N8 — 투명). 이름(.label·.hint)과 브랜드 글자만 숨긴다.
      railHides: rules(inside).filter((r) => /body\.nav-rail\b/.test(r.selector) && /\.nav-button|\.ic\b|#nav-rail-toggle/.test(r.selector) && !/\.(label|hint)\b/.test(r.selector) &&
        /(?:^|;)\s*(opacity\s*:\s*0(?:\.0*)?\s*(?:;|$)|visibility\s*:\s*hidden|display\s*:\s*none)/.test(r.body)).map((r) => r.selector),
      activeOverridden: rules(css).filter((r) => /body\.nav-rail\b/.test(r.selector) && /\.active\b/.test(r.selector)).map((r) => r.selector),
    };
    out.push(
      assert(
        "★⑥ 레일 모양 — 열 64px · 머리줄 sticky(top = −사이드바 위 패딩) · 스크롤 여백 = 머리줄 높이 변수 · 브랜드 글자 숨김 · 아이콘 가운데 · 말풍선은 display 를 안 적는다(hidden 이 이긴다) · 현재 화면 강조(배경·테두리 강조색)를 레일이 덮지 않고 아이콘·버튼을 가리지 않는다",
        shape.railCols === "64px minmax(0,1fr)" && shape.brandPos === "sticky" && sidebarPadTop !== undefined && shape.brandTop === `-${sidebarPadTop}px` &&
          /var\(--nav-brand-h/.test(shape.scrollPad) && shape.brandTextHidden && shape.btnCenter && shape.tipDisplay.length === 0 &&
          /accent/.test(shape.activeBg) && !/transparent/.test(shape.activeBg) && /accent/.test(shape.activeBorder) && !/transparent/.test(shape.activeBorder) &&
          shape.railHides.length === 0 && shape.activeOverridden.length === 0,
        shape,
      ),
    );

    // ⑦ 데스크톱 경계는 CSS·JS 가 같은 수 — CSS `min-width:N+1` ↔ JS `max-width:N`(구멍 B1·B7). 두 자리에 적힌 같은 판단이 갈리면 말풍선이 서랍에 뜨거나 안 뜬다.
    const navJs = readFileSync(`${DASH}/js/nav-rail.js`, "utf8");
    const jsMax = [...navJs.matchAll(/matchMedia\("\(max-width:\s*(\d+)px\)"\)/g)].map((m) => Number(m[1]));
    const cssMin = [...css.matchAll(/@media\s*\(\s*min-width\s*:\s*(\d+)px\s*\)\s*\{/g)].map((m) => Number(m[1]));
    out.push(
      assert(
        "★⑦ 데스크톱 경계 — nav-rail.js 의 좁은 화면 문턱 + 1 = 레일 CSS 미디어의 시작(900 ↔ 901)",
        jsMax.length >= 1 && jsMax.every((n) => cssMin.includes(n + 1)) && cssMin.includes(901),
        { jsMax, cssMin: [...new Set(cssMin)] },
      ),
    );

    // ⑧ 토글 이름의 뜻 — 기대값을 같은 카탈로그에서 읽으면 맞바꿔도 못 잡는다(구멍 L1·L3). 언어별 뜻을 따로 본다.
    const locs = Object.fromEntries(["ko", "en"].map((l) => [l, JSON.parse(readFileSync(`locales/${l}.json`, "utf8")) as Record<string, string>]));
    const kc = locs.ko!["nav.rail.collapse"] ?? "", ke = locs.ko!["nav.rail.expand"] ?? "", ec = locs.en!["nav.rail.collapse"] ?? "", ee = locs.en!["nav.rail.expand"] ?? "";
    out.push(
      assert(
        "★⑧ 토글 이름 — ko «접기/펼치기» · en «Collapse/Expand» 가 제자리에(맞바꿈·번역 누락이면 빨강)",
        kc.includes("접") && !kc.includes("펼") && ke.includes("펼") && !ke.includes("접") &&
          /collapse/i.test(ec) && !/expand/i.test(ec) && /expand/i.test(ee) && !/collapse/i.test(ee) && !/[가-힣]/.test(ec + ee),
        { kc, ke, ec, ee },
      ),
    );

    // ⑨ 말풍선·패널 판정 동작 — 진짜 nav-rail.js 를 미니 DOM 에서 이벤트로(구멍 A1~A13·B5). 미디어(좁은 화면·hover)는 검사가 쥔다.
    {
      let narrow = false;
      let hover = true;
      const mq: Array<() => void> = [];
      const t = bootDashboard({ clock: makeClock(), i18n: i18nForContext, upTo: "nav-rail.js", html: sidebarHtml, fetch: async () => jsonResponse({}, 404) });
      t.window.matchMedia = (q: string) => ({
        get matches() { return /max-width:\s*900px/.test(q) ? narrow : /hover:\s*hover/.test(q) ? hover : false; },
        addEventListener: (_k: string, f: () => void) => { if (/max-width/.test(q)) mq.push(f); },
        removeEventListener() {},
      });
      t.run(`globalThis.__enforced = 0; sidePanels.enforce = () => { globalThis.__enforced += 1; }; true`);
      t.run(dashSource("nav-rail.js"), "nav-rail.js");
      const doc = t.document;
      const q = (s: string) => doc.querySelector(s) as unknown as { rect: Record<string, number>; matches: (s: string) => boolean; dispatchEvent: (e: unknown) => boolean; hidden: boolean; textContent: string; style: Record<string, string> } | null;
      const box = (l: number, top: number, w: number, h: number) => ({ left: l, top, width: w, height: h, right: l + w, bottom: top + h });
      const sb = q("#sidebar")!, brand = q(".nav-brand")!, plug = q('#sidebar .nav-button[data-view="plugins"]')!, home = q('#sidebar .nav-button[data-view="overview"]')!;
      sb.rect = box(12, 76, 64, 800); brand.rect = box(23, 77, 42, 63); plug.rect = box(23, 400, 42, 44); home.rect = box(23, 150, 42, 44);
      let focusVisible = true;
      for (const b of [plug, home]) { const orig = b.matches.bind(b); b.matches = (s: string) => (s === ":focus-visible" ? focusVisible : orig(s)); }
      const tip = () => q(".nav-rail-tip")!;
      const fire = (el: { dispatchEvent: (e: unknown) => boolean }, type: string, init: Record<string, unknown> = {}) => el.dispatchEvent(makeEvent(type, { bubbles: true, ...init }));
      const state = () => ({ hidden: tip().hidden, text: tip().textContent, left: tip().style.left, top: tip().style.top });
      const toggle = () => (doc.getElementById("nav-rail-toggle") as unknown as { click: () => void }).click();
      const s: Record<string, unknown> = {};
      const enf0 = Number(t.run("globalThis.__enforced"));
      toggle(); // 레일로
      s.enforceOnCollapse = Number(t.run("globalThis.__enforced")) - enf0;
      fire(plug, "pointerover", { pointerType: "mouse", relatedTarget: sb }); s.hover = state();
      fire(plug, "pointerout", { pointerType: "mouse", relatedTarget: sb }); s.leave = state();
      fire(plug, "pointerover", { pointerType: "mouse", relatedTarget: sb }); fire(plug, "click"); s.click = state();
      fire(plug, "pointerover", { pointerType: "touch", relatedTarget: sb }); s.touch = state();
      hover = false; fire(home, "pointerover", { pointerType: "mouse", relatedTarget: sb }); s.noHover = state(); hover = true;
      focusVisible = false; fire(home, "focusin"); s.mouseFocus = state(); focusVisible = true;
      fire(home, "focusin"); s.focus = state();
      dispatch(doc as never, makeEvent("keydown", { bubbles: true, key: "Escape" })); s.esc = state();
      fire(home, "focusin"); home.rect = box(23, 300, 42, 44); fire(sb, "scroll", { bubbles: false }); s.scrollMove = state();
      home.rect = box(23, 100, 42, 44); fire(sb, "scroll", { bubbles: false }); s.scrollUnder = state();
      home.rect = box(23, 300, 42, 44); fire(home, "focusin"); home.rect = box(23, 900, 42, 44); fire(sb, "scroll", { bubbles: false }); s.scrollBelow = state();
      home.rect = box(23, 300, 42, 44); fire(home, "focusin"); fire(home, "focusout"); s.blur = state();
      fire(home, "focusin"); const enf1 = Number(t.run("globalThis.__enforced")); toggle(); s.expand = state(); s.enforceOnExpand = Number(t.run("globalThis.__enforced")) - enf1;
      fire(home, "focusin"); s.expandedFocus = state();
      toggle(); fire(home, "focusin"); narrow = true; for (const f of mq) f(); s.narrowed = state();
      fire(home, "focusin"); s.narrowFocus = state(); narrow = false;
      const vis = (x: unknown) => (x as { hidden: boolean }).hidden === false;
      const hid = (x: unknown) => (x as { hidden: boolean }).hidden === true;
      out.push(
        assert(
          "★⑨ 말풍선 — hover·Tab(포커스 링)에 «이름 · 힌트» 로 버튼 오른쪽 +8·세로 가운데 · 떠남·클릭·Esc·포커스 이탈·펼침·좁아짐·머리줄 밑/아래로 가려짐에 닫힘 · 스크롤은 옮김 · 터치·hover 없는 기기·마우스 포커스·펼침 상태·좁은 화면엔 안 뜸",
          vis(s.hover) && (s.hover as { text: string }).text === `${i18nForContext("nav.plugins")} · 0` && (s.hover as { left: string }).left === "73px" && (s.hover as { top: string }).top === "422px" &&
            hid(s.leave) && hid(s.click) && hid(s.touch) && hid(s.noHover) && hid(s.mouseFocus) &&
            vis(s.focus) && hid(s.esc) && vis(s.scrollMove) && (s.scrollMove as { top: string }).top === "322px" && hid(s.scrollUnder) && hid(s.scrollBelow) && hid(s.blur) &&
            hid(s.expand) && hid(s.expandedFocus) && hid(s.narrowed) && hid(s.narrowFocus),
          s,
        ),
      );
      out.push(
        assert(
          "★⑨ 접고 펼칠 때마다 패널 공간을 다시 판정한다(`sidePanels.enforce`) — 펼쳐 본문이 좁아지면 기존 규칙으로 패널 하나가 닫히는 자리",
          s.enforceOnCollapse === 1 && s.enforceOnExpand === 1,
          { onCollapse: s.enforceOnCollapse, onExpand: s.enforceOnExpand },
        ),
      );
    }

    // ⑤ 실린다 — side-panels.js 뒤
    const manifest = JSON.parse(readFileSync(`${DASH}/js/_manifest.json`, "utf8")) as string[];
    const order = [...html.matchAll(/src="\/js\/([\w-]+\.js)"/g)].map((m) => m[1]!);
    out.push(
      assert(
        "⑤ nav-rail.js 가 index.html·_manifest.json 둘 다에 실리고 side-panels.js 뒤다",
        order.indexOf("nav-rail.js") > order.indexOf("side-panels.js") && order.indexOf("side-panels.js") >= 0 &&
          manifest.indexOf("nav-rail.js") > manifest.indexOf("side-panels.js") && manifest.indexOf("side-panels.js") >= 0,
        { html: order.indexOf("nav-rail.js"), manifest: manifest.indexOf("nav-rail.js") },
      ),
    );
    return out;
  },
};
