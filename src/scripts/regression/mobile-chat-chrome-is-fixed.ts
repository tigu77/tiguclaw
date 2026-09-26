/**
 * 회귀: **모바일 채팅의 헤더·세션 탭은 fixed 다** — iOS 바운스에 끌려가지 않게 (2026-09-25).
 *
 * ★사고(정태님, iPhone): 채팅 맨 아래에서 더 끌어올리면 위쪽이 흐린 띠로 덮이고 아래가 비었다 —
 *  손을 떼면 돌아온다. iOS 는 끝을 넘겨 끌면 페이지 내용을 통째로 끌고 가는데 **sticky 는 같이
 *  끌리고 fixed 는 남는다**(입력창이 그대로였던 것이 증거). 반투명·블러 헤더가 상태 표시줄 밑으로
 *  밀려 흐린 띠가 됐다. 바운스를 끄는 건 증상을 가리는 것이라(당겨서 새로고침도 잃는다) 고정으로 푼다.
 *
 * 지키는 것: ① 헤더·세션 탭이 fixed ② fixed 로 빠진 자리를 비운다(헤더 46px · 탭 실측 높이)
 *  ③ 탭 높이를 JS 가 실측해 넣는다 ④ 바운스를 끄는 우회로 되돌아가지 않았다
 *  ⑤ (2026-09-26) **바운스 중엔 탭 목록이 스크롤 컨테이너가 아니다** — iOS 18 Safari 는 fixed 안의 스크롤
 *     컨테이너를 바운스 중에 안 그렸다(탭 버튼만 사라짐). iOS 18.5 시뮬레이터에서 재현·확인: 합성 레이어·
 *     바깥 상자 분리로는 안 풀렸고, 스크롤 컨테이너가 아니면 보였다. 떼어낸 실제 핸들러로 전이를 본다.
 *
 * 등급: 소스 값 대조 — iOS 바운스는 헤드리스 Chrome 이 재현하지 못한다. 배치(순서·겹침)는
 *  `_workspace/_chat_date_pill_cdp.mjs` 계열 헤드리스 캡처로 확인했다.
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const read = (rel: string) => readFileSync(new URL(`../../../packages/dashboard/${rel}`, import.meta.url), "utf8");

export const check: RegressionCheck = {
  name: "mobile-chat-chrome-is-fixed",
  guards:
    "iPhone 에서 채팅 끝을 넘겨 끌면 sticky 헤더·세션 탭이 바운스에 끌려 상태 표시줄 밑으로 들어가 흐린 띠가 되고 아래가 비던 것",
  run: async (): Promise<Assertion[]> => {
    const css = read("app.css").replace(/\/\*[\s\S]*?\*\//g, "");
    const nav = read("js/mobile-nav.js").replace(/^\s*\/\/.*$/gm, "");
    const at = css.indexOf("@media (max-width: 900px)");
    const mobile = at < 0 ? "" : css.slice(at);
    const rule = (sel: string) => new RegExp(`${sel.replace(/[[\]"#*.]/g, (c) => "\\" + c)}\\s*\\{([^}]*)\\}`).exec(mobile)?.[1] ?? "";
    const header = rule('body[data-tab="chat"] header');
    const tabs = rule('body[data-tab="chat"] #session-tabs');
    const bar = rule('body[data-tab="chat"] .session-tabs-bar');
    const body = rule('body[data-tab="chat"]');
    const rightRule = /body\[data-tab="chat"\] #right\s*\{[^}]*padding-top:[^;}]*/.exec(mobile)?.[0] ?? "";
    const rightTop = /padding-top:\s*var\(--tabs-inset/.test(rightRule);
    const setter = /setProperty\(\s*"--tabs-inset"[^;]*/.exec(nav)?.[0] ?? "";
    const observed = /observe\(insetTabs\)/.test(nav);
    const bounceOff = /overscroll-behavior(-y)?:\s*none[^;}]*/.exec(mobile.replace(/\.overlay-panel[^}]*\}/g, ""))?.[0] ?? "";
    // 날짜 알약 — 모바일은 탭 아래 fixed(스크롤·바운스에 안 끌리게), 모든 폭에서 배경막(18) 아래(싱크 레드팀 G).
    const pill = rule('body[data-tab="chat"] .chat-date');
    const baseZ = Number(/\.chat-date\s*\{[^}]*z-index:\s*(\d+)/.exec(css)?.[1] ?? NaN);
    const backdropZ = Number(/#bg-backdrop\s*\{[^}]*z-index:\s*(\d+)/.exec(css)?.[1] ?? NaN);
    const html = read("index.html");
    const pillEl = /<div id="chat-date"[^>]*hidden/.test(html);
    const wrapped = /<div id="session-tabs-bar"[^>]*><div id="session-tabs"/.exec(html)?.[0] ?? "";
    // ⑤ 바운스 동결 — mobile-nav.js 의 실제 블록을 스텁 위에서 돌린다.
    const navRaw = read("js/mobile-nav.js");
    const freezeSrc = /const tabsStrip = document\.getElementById\("session-tabs"\);[\s\S]*?\n {6}\}\n/.exec(navRaw)?.[0] ?? "";
    const frozenRule = rule('body[data-tab="chat"] #session-tabs.bounce-frozen');
    const frozenKids = rule('body[data-tab="chat"] #session-tabs.bounce-frozen > *');
    const drive = () => {
      const cls = new Set<string>(); const props: Record<string, string> = {}; const on: Record<string, () => void> = {};
      const strip = {
        scrollLeft: 140,
        classList: { add: (c: string) => cls.add(c), remove: (c: string) => cls.delete(c) },
        style: { setProperty: (k: string, v: string) => { props[k] = v; }, getPropertyValue: (k: string) => props[k] ?? "" },
        addEventListener: (t: string, f: () => void) => { on["strip:" + t] = f; },
      };
      const se = { scrollHeight: 3000, clientHeight: 800 };
      const win = { scrollY: 2200, matchMedia: () => ({ matches: true }), addEventListener: (t: string, f: () => void) => { on["win:" + t] = f; } };
      const ctx = vm.createContext({
        window: win,
        document: { getElementById: () => strip, scrollingElement: se, documentElement: se, body: { getAttribute: () => "chat" } },
      });
      if (freezeSrc !== "") vm.runInContext(freezeSrc, ctx);
      const scroll = (y: number) => { win.scrollY = y; on["win:scroll"]?.(); };
      const steps: string[] = [];
      scroll(2150); steps.push(`범위안:${cls.has("bounce-frozen")}`);
      scroll(2290); steps.push(`바닥넘김:${cls.has("bounce-frozen")}/x=${props["--tabs-x"]}`);
      strip.scrollLeft = 0; // clip 동안 위치가 날아가도
      scroll(2200); steps.push(`복귀:${cls.has("bounce-frozen")}/sl=${strip.scrollLeft}`);
      scroll(-40); steps.push(`위넘김:${cls.has("bounce-frozen")}`);
      on["strip:touchstart"]?.(); steps.push(`탭터치:${cls.has("bounce-frozen")}`);
      return steps.join(" ");
    };
    const trace = drive();
    return [
      assert("⑤ 동결 블록을 떼어냈다(없으면 아래는 공짜 초록)", freezeSrc !== "", `${freezeSrc.length}자`),
      assert("★⑤ 바운스 동안만 동결되고, 돌아오면 넘겨 둔 위치로 복원 · 위쪽 바운스도 · 탭을 만지면 풀린다",
        trace === "범위안:false 바닥넘김:true/x=140px 복귀:false/sl=140 위넘김:true 탭터치:false", trace),
      assert("⑤ 동결 중엔 스크롤 컨테이너가 아니다(clip) + 위치는 자식 translate",
        /overflow:\s*clip/.test(frozenRule) && /translateX\(calc\(-1 \* var\(--tabs-x/.test(frozenKids), `${frozenRule.trim()} | ${frozenKids.trim()}`),
      assert("마크업에서 바깥 상자가 탭 목록을 감싼다", wrapped !== "", wrapped || "★감싸지 않음"),
      assert("날짜 알약 요소가 있고 처음엔 숨어 있다", pillEl, pillEl ? "id=chat-date hidden" : "★없음"),
      assert("모바일 날짜 알약은 fixed 로 탭 아래(46px + 탭 실측)", /position:\s*fixed/.test(pill) && /top:\s*calc\(46px \+ var\(--tabs-inset/.test(pill), pill.trim() || "★규칙 없음"),
      assert("날짜 알약은 배경막보다 아래(드로어를 열면 같이 가려진다)", Number.isFinite(baseZ) && Number.isFinite(backdropZ) && baseZ < backdropZ, `알약 z=${baseZ} · 배경막 z=${backdropZ}`),
      assert("① 헤더가 fixed", /position:\s*fixed/.test(header) && /top:\s*0/.test(header), header.trim() || "★규칙 없음"),
      assert("① 세션 탭의 **바깥 상자**가 fixed(헤더 46px 아래)", /position:\s*fixed/.test(bar) && /top:\s*46px/.test(bar), bar.trim() || "★규칙 없음"),
      assert("탭 목록(가로 스크롤 컨테이너)은 fixed 가 아니다 — 고정은 바깥 상자가 맡는다", !/position:\s*fixed/.test(tabs), tabs.trim() || "(규칙 없음)"),
      assert("② 헤더 자리(46px)를 body 위쪽에 비운다", /padding-top:\s*46px/.test(body), body.trim() || "★규칙 없음"),
      assert("② 탭 자리를 #right 위쪽에 실측 높이로 비운다", rightTop, rightRule.trim() || "★규칙 없음"),
      assert("③ 탭 높이를 실측해 --tabs-inset 에 넣는다", setter !== "" && observed, `설정=${setter || "★없음"} · 관찰=${observed}`),
      assert("④ 바운스를 끄는 우회가 없다(당겨서 새로고침을 잃는다)", bounceOff === "", bounceOff || "없음"),
    ];
  },
};
