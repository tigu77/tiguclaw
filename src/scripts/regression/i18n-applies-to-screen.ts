/**
 * 회귀: **브라우저 쪽 i18n 이 실제로 화면을 바꾼다** (2026-08-25 적대 검토 F3).
 *
 * ★왜 새로 만드나: 이 기능에는 **동작 검사가 하나도 없었다.** 레드팀이 변이 8종을 전부
 *  통과시켰고, 그중 둘은 ①번 커밋 결과물을 통째로 무효화하는 것이었다:
 *   - `applyI18n()` **호출 삭제** → 정적 마크업 49본문 + 42속성 전부 번역 사망
 *   - `pair.slice(eq + 1)` → `pair.slice(eq)` (off-by-one) → 속성 42자리 전부 사망
 *  그런데 회귀 1784건이 초록이었다. 기존 그물은 `i18n-keys-complete`(키가 카탈로그에
 *  있나 — **문자열 대조**)와 `i18n-user-extensible`(**코어만** 자식 프로세스로 실행)뿐이라,
 *  브라우저의 `i18n()`·`applyI18n()` 은 **아무도 실행하지 않았다.**
 *
 * ★`_framework.JS_I18N_STUB` 이 그 공백을 구조화한다 — 실행 기반 검사 7개는 `i18n` 을
 *  항등함수로 스텁하므로, **`i18n()` 이 값을 바꾸는 데서 오는 결함은 원리적으로 안 보인다.**
 *  그 스텁을 없앨 순 없다(그 검사들의 관심사가 아니다). 대신 **여기가** 진짜로 돌린다.
 *
 * ★등급: **행동 게이트** — `util.js` 의 정의를 떼어 vm 에서 돌리고, `index.html` 의 진짜
 *  마크업으로 만든 가짜 DOM 에 적용해 **결과 문자열을 본다**. 헤드리스 브라우저는 안 띄운다
 *  (그건 손으로 부르는 자리가 되고, 손으로 부르는 게이트는 안 돈다).
 */
import { readdir, readFile } from "node:fs/promises";
import vm from "node:vm";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const readRel = (rel: string): Promise<string> => readFile(new URL(rel, import.meta.url), "utf8");

interface FakeEl {
  dataset: { i18n?: string; i18nAttrs?: string };
  textContent: string;
  attrs: Record<string, string>;
  setAttribute: (k: string, v: string) => void;
}

/** `index.html` 의 진짜 마크업에서 번역 대상 요소를 뽑아 가짜 DOM 을 만든다. */
const fakeDomFrom = (html: string): { els: FakeEl[]; doc: unknown } => {
  const els: FakeEl[] = [];
  for (const m of html.matchAll(/<[a-zA-Z][^<>]*data-i18n[^<>]*>/g)) {
    const tag = m[0];
    const text = /\sdata-i18n="([^"]+)"/.exec(tag)?.[1];
    const attrs = /\sdata-i18n-attrs="([^"]+)"/.exec(tag)?.[1];
    const el: FakeEl = {
      dataset: {
        ...(text !== undefined ? { i18n: text } : {}),
        ...(attrs !== undefined ? { i18nAttrs: attrs } : {}),
      },
      textContent: "원본",
      attrs: {},
      setAttribute(k: string, v: string) {
        this.attrs[k] = v;
      },
    };
    els.push(el);
  }
  const doc = {
    querySelectorAll: (sel: string): FakeEl[] =>
      sel === "[data-i18n]"
        ? els.filter((e) => e.dataset.i18n !== undefined)
        : els.filter((e) => e.dataset.i18nAttrs !== undefined),
  };
  return { els, doc };
};

/** `util.js` 에서 `i18n`·`applyI18n` 정의만 떼어낸다. */
const sliceDefs = (src: string): string => {
  const from = src.indexOf("      const i18n = (key, params) => {");
  const to = src.indexOf("      const fmtElapsed =");
  if (from < 0 || to < 0) throw new Error("i18n/applyI18n 정의를 못 찾음 — 구조가 바뀌었나");
  return src.slice(from, to);
};

const run = async (): Promise<Assertion[]> => {
  const out: Assertion[] = [];
  const util = await readRel("../../../packages/dashboard/js/util.js");
  const html = await readRel("../../../packages/dashboard/index.html");

  // ── ① ★`applyI18n()` 이 **불린다** — 정의만 있고 안 부르면 아무 일도 안 일어난다 ──────
  //  (호출 자체는 DOM 준비 시점에 달려 있어 vm 으로 못 본다. 여기만 소스를 본다 —
  //   그리고 그 사실을 헤더가 아니라 이 단언 이름에 적는다.)
  const called = /^\s*applyI18n\(\);\s*$/m.test(util);
  out.push(
    assert(
      "★util.js 가 로드 끝에서 applyI18n() 을 실제로 부른다(안 부르면 마크업 91자리가 전부 죽는다)",
      called,
      called ? "호출 있음" : "★호출 없음 — 정의만 있고 아무도 안 부른다",
    ),
  );

  const { els, doc } = fakeDomFrom(html);
  const ctx: Record<string, unknown> = {
    window: { __TIGU_I18N__: { locale: "xx", strings: {} } },
    document: doc,
  };
  vm.createContext(ctx);
  vm.runInContext(`${sliceDefs(util)}\nthis.__t = i18n;\nthis.__apply = applyI18n;`, ctx);
  const t = ctx.__t as (k: string, p?: Record<string, string | number>) => string;
  const apply = ctx.__apply as () => void;

  out.push(
    assert(
      "★마크업에서 번역 대상 요소를 실제로 걷었다(0이면 이 검사가 통째로 공허하다)",
      els.length > 20,
      `${els.length}개 요소`,
    ),
  );

  // ── ② 카탈로그를 넣고 **적용**한다 — 본문·속성 둘 다 ────────────────────────────
  // ★같은 키가 본문과 속성 양쪽에 쓰인다(`nav.models` 등 6개) — 접두를 나누면 픽스처가
  //  자기 자신과 충돌한다. 첫 판에 그걸로 6건이 빨갰다(제품이 아니라 검사의 결함이었다).
  const strings: Record<string, string> = {};
  for (const el of els) {
    if (el.dataset.i18n !== undefined) strings[el.dataset.i18n] = `V:${el.dataset.i18n}`;
    for (const pair of (el.dataset.i18nAttrs ?? "").split(";")) {
      const eq = pair.indexOf("=");
      if (eq >= 0) strings[pair.slice(eq + 1).trim()] = `V:${pair.slice(eq + 1).trim()}`;
    }
  }
  (ctx.window as { __TIGU_I18N__: { strings: Record<string, string> } }).__TIGU_I18N__.strings =
    strings;
  apply();

  const textEls = els.filter((e) => e.dataset.i18n !== undefined);
  const badText = textEls.filter((e) => e.textContent !== `V:${e.dataset.i18n}`);
  out.push(
    assert(
      "★본문이 전부 카탈로그 값으로 바뀐다",
      badText.length === 0 && textEls.length > 0,
      badText.length === 0
        ? `${textEls.length}개 적용`
        : `★안 바뀐 ${badText.length}개 (예: ${String(badText[0]?.dataset.i18n)})`,
    ),
  );

  // ★속성은 **이름과 값이 둘 다** 맞아야 한다 — off-by-one 이면 값이 안 붙고, 이름을
  //  잘못 자르면 `titel` 같은 쓰레기 속성이 생긴다(레드팀 C7·D1).
  const attrEls = els.filter((e) => e.dataset.i18nAttrs !== undefined);
  const attrProblems: string[] = [];
  for (const el of attrEls) {
    for (const pair of el.dataset.i18nAttrs!.split(";")) {
      const eq = pair.indexOf("=");
      if (eq < 0) continue;
      const name = pair.slice(0, eq).trim();
      const key = pair.slice(eq + 1).trim();
      if (el.attrs[name] !== `V:${key}`) attrProblems.push(`${name}=${key}→${String(el.attrs[name])}`);
    }
  }
  out.push(
    assert(
      "★속성이 **이름 그대로·값 그대로** 붙는다(off-by-one 이면 42자리가 조용히 죽는다)",
      attrProblems.length === 0 && attrEls.length > 0,
      attrProblems.length === 0
        ? `${attrEls.length}개 요소 적용`
        : `★어긋남 ${attrProblems.length}건: ${attrProblems.slice(0, 3).join(" · ")}`,
    ),
  );

  // ── ③ 없는 키는 **손대지 않는다** — 키를 써넣으면 멀쩡한 한국어가 `nav.settings` 가 된다 ──
  {
    const { els: e2, doc: d2 } = fakeDomFrom(html);
    ctx.document = d2;
    vm.runInContext(`this.__apply2 = applyI18n;`, ctx);
    (ctx.window as { __TIGU_I18N__: { strings: Record<string, string> } }).__TIGU_I18N__.strings =
      {};
    (ctx.__apply2 as () => void)();
    const touched = e2.filter((e) => e.textContent !== "원본" || Object.keys(e.attrs).length > 0);
    out.push(
      assert(
        "★카탈로그에 없으면 손대지 않는다(빈 문자열·키 노출로 화면을 깨지 않는다)",
        touched.length === 0,
        touched.length === 0 ? "무개입 확인" : `★${touched.length}개를 건드렸다`,
      ),
    );
  }

  // ── ④ `i18n()` 자체 — 폴백과 자리표시자 ─────────────────────────────────────────
  (ctx.window as { __TIGU_I18N__: { strings: Record<string, string> } }).__TIGU_I18N__.strings = {
    "약 {n}개": "about {n}",
    빈값: "",
  };
  out.push(
    assert(
      "없는 키는 키 자체를 낸다(빈 버튼은 없는 버튼이다)",
      t("없는키") === "없는키",
      t("없는키"),
    ),
    assert(
      "자리표시자를 채운다",
      t("약 {n}개", { n: 3 }) === "about 3",
      t("약 {n}개", { n: 3 }),
    ),
    assert(
      "값이 없으면 자리표시자를 **남긴다**(지우면 문장이 조용히 이상해진다)",
      t("약 {n}개", {}) === "about {n}",
      t("약 {n}개", {}),
    ),
  );

  // ── ⑤ ★번역 값이 escHtml 없이 innerHTML 로 가지 않는다 (적대 검토 F1, P·4) ──────
  //  기계 일괄 변환이 **컴파일 타임 상수를 런타임 데이터로** 바꿨다. 같은 문장의 다른
  //  6자리는 escHtml 을 통과하는데 한 자리만 아니어서, `<home>/locales/*.json`(= 신뢰 경계
  //  밖 — "파일 하나 놓으면 언어가 는다" 가 곧 남의 파일을 받는다는 뜻이다)의 값이 원시
  //  innerHTML 싱크에 꽂혔다. 헤드리스로 `onerror` 실행까지 확인됐다.
  //  ★같은 오리진에 `/api/messages`(= 비서에 임의 지시 = 도구 실행)가 있다.
  {
    const insideEscHtml = (line: string, at: number): boolean => {
      let depth = 0;
      for (let i = at - 1; i >= 0; i--) {
        const c = line[i];
        if (c === ")") depth++;
        else if (c === "(") {
          if (depth === 0) {
            let j = i - 1;
            let name = "";
            while (j >= 0 && /[\w$]/.test(line[j]!)) name = line[j--] + name;
            return name === "escHtml";
          }
          depth--;
        }
      }
      return false;
    };
    const jsDir = new URL("../../../packages/dashboard/js/", import.meta.url);
    const files = (await readdir(jsDir)).filter((f) => f.endsWith(".js"));
    const leaks: string[] = [];
    let scanned = 0;
    // ★싱크는 `innerHTML` 만이 아니다 — `outerHTML`·`insertAdjacentHTML` 도 같은 구멍이다
    //  (적대 검토 B-F4: 셋 중 둘이 검사 밖이었다).
    const SINK = /\b(innerHTML|outerHTML|insertAdjacentHTML)\b/;
    // ★출처도 `i18n(` 만이 아니다 — `resolveText()` 의 출력이 곧 카탈로그 값이고,
    //  **변수 한 칸을 거치면** 종전 검사는 못 봤다(`const s = i18n(k); el.innerHTML = …s…`).
    //  그래서 파일 안에서 카탈로그 값을 담은 **변수 이름을 먼저 걷고** 싱크에서 그 이름도 본다.
    const SOURCE = /\b(?:i18n|i18nNodes|resolveText)\s*\(/g;
    for (const f of files) {
      const src = await readFile(new URL(f, jsDir), "utf8");
      const lines = src.split("\n");
      const tainted = new Set<string>();
      for (const line of lines) {
        const m = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:i18n|resolveText)\s*\(/.exec(line);
        if (m !== null) tainted.add(m[1]!);
      }
      lines.forEach((line, i) => {
        const t = line.trimStart();
        if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return;
        if (!SINK.test(line)) return;
        scanned++;
        for (const m of [...line.matchAll(SOURCE)]) {
          if (!insideEscHtml(line, m.index!)) leaks.push(`${f}:${i + 1}`);
        }
        // ★변수 이름을 찾을 땐 **문자열 내부를 가린다** — 안 가리면 `i18n("common.desc.none")`
        //  안의 `desc` 가 변수로 잡힌다(실제로 오탐 1건). 길이를 보존해 인덱스를 유지한다.
        const masked = line.replace(/(["'`])(?:[^\\]|\\.)*?\1/g, (m) => m[0] + " ".repeat(Math.max(0, m.length - 2)) + m[m.length - 1]);
        for (const name of tainted) {
          const re = new RegExp(`\\b${name}\\b`, "g");
          for (const m of [...masked.matchAll(re)]) {
            if (!insideEscHtml(line, m.index!)) leaks.push(`${f}:${i + 1}(${name})`);
          }
        }
      });
    }
    out.push(
      assert(
        "★번역 값이 escHtml 없이 HTML 싱크로 가지 않는다(언어 파일은 신뢰 경계 밖이다)",
        leaks.length === 0 && scanned > 0,
        leaks.length === 0
          ? `HTML 싱크 ${scanned}줄 전부 안전`
          : `★새는 자리 ${leaks.length}곳: ${leaks.slice(0, 4).join(" ")}`,
      ),
    );
  }

  // ── ⑦ ★`i18nNodes` 를 **실행한다** (2026-08-26 적대 검토 B-F2·B-F1) ──────────────
  //  이 함수는 "카탈로그 값이 innerHTML 로 가는 것"을 막으려고 이번에 새로 만든 자리인데,
  //  **통째로 빈 fragment 를 반환하게 바꿔도** 스위트가 초록이었다(실행 커버리지 0).
  //  ★그리고 실제 결함이 하나 있었다(B-F1): `appendChild` 는 노드를 **옮기므로** 같은
  //   자리표시자가 두 번 나오면 두 번째가 첫 번째에서 훔쳐 가 앞자리가 조용히 빈다.
  //   값이 문자열일 땐 멀쩡하고 **엘리먼트일 때만** 깨져서 더 안 보인다.
  {
    const m = /const i18nNodes = \(key, parts\) => \{[\s\S]*?\n {6}\};/.exec(util);
    if (m === null) throw new Error("i18nNodes 정의를 못 찾음 — 구조가 바뀌었나");
    // 최소 DOM — 텍스트 노드와 엘리먼트를 구분할 수 있을 만큼만.
    const dom = `
      class Node { constructor(){ this.children=[]; this.text=""; } }
      class TextNode extends Node { constructor(t){ super(); this.text=t; } get out(){ return this.text; } }
      class ElNode extends Node {
        constructor(tag,t){ super(); this.tag=tag; this.text=t; }
        get out(){ return "<"+this.tag+">"+this.text+"</"+this.tag+">"; }
        cloneNode(){ return new ElNode(this.tag,this.text); }
      }
      class Frag extends Node {
        appendChild(n){ const i=this.children.indexOf(n); if(i>=0) this.children.splice(i,1); this.children.push(n); return n; }
        get out(){ return this.children.map(c=>c.out).join(""); }
      }
      const document = { createDocumentFragment: () => new Frag(), createTextNode: (t) => new TextNode(t) };
    `;
    const make = new Function(
      "catalog",
      `${dom}
       const i18n = (k, p) => { const r = typeof catalog[k] === "string" ? catalog[k] : k;
         return p ? r.replace(/\\{(\\w+)\\}/g, (w,n) => (p[n] === undefined ? w : String(p[n]))) : r; };
       ${m[0]}
       return { i18nNodes, el: (tag, t) => new ElNode(tag, t) };`,
    ) as (c: Record<string, string>) => {
      i18nNodes: (k: string, p?: Record<string, unknown>) => { out: string };
      el: (tag: string, t: string) => unknown;
    };

    const cat = {
      "t.plain": "앞 {a} 뒤",
      "t.missing": "앞 {a} 뒤",
      "t.dup": "{doc} 는 {name} 가 씁니다. {doc} 를 보세요.",
      "t.tail": "머리 {a} 꼬리글",
    };
    const api = make(cat);
    const run = (k: string, p?: Record<string, unknown>): string => api.i18nNodes(k, p).out;

    const cases: ReadonlyArray<readonly [string, string, string]> = [
      ["문자열 자리를 채운다", run("t.plain", { a: "값" }), "앞 값 뒤"],
      ["값이 없으면 자리표시자를 남긴다", run("t.missing", {}), "앞 {a} 뒤"],
      ["마지막 자리 **뒤 꼬리글**을 잃지 않는다", run("t.tail", { a: "X" }), "머리 X 꼬리글"],
    ];
    const wrong = cases.filter(([, got, want]) => got !== want);
    // ★엘리먼트가 **두 번** 나오는 경우 — B-F1 이 여기서 걸린다.
    const dup = run("t.dup", { doc: api.el("code", "PROJECT.md"), name: "돌쇠" });
    const dupOk = dup === "<code>PROJECT.md</code> 는 돌쇠 가 씁니다. <code>PROJECT.md</code> 를 보세요.";
    out.push(
      assert(
        "★i18nNodes 가 실제로 조립한다(값·빈자리·꼬리글) — 통째로 비워도 초록이던 자리",
        wrong.length === 0,
        wrong.length === 0
          ? `${cases.length}케이스 통과`
          : `★${wrong.map(([n, g, w]) => `${n}: got=${JSON.stringify(g)} want=${JSON.stringify(w)}`).join(" · ")}`,
      ),
      assert(
        "★같은 자리표시자에 **엘리먼트**가 두 번 와도 앞자리가 안 빈다(appendChild 는 옮긴다)",
        dupOk,
        dupOk ? "사본 삽입 확인" : `★got=${JSON.stringify(dup)}`,
      ),
    );
  }

  // ── ⑥ ★`escHtml` **자신**을 검사한다 (2026-08-26 적대 검토 B-F3) ─────────────────
  //  종전엔 호출부가 escHtml 을 **부르는지**만 봤고, escHtml 이 **무엇을 하는지**는 아무도
  //  안 봤다 — `.replace(/</g, "&lt;")` 한 줄을 지워도 스위트 1,820건이 초록이었다.
  //  이 함수는 2026-07-31 에 실증된 XSS 9곳을 막는 **유일한** 방어이고, 같은 오리진에
  //  `/api/messages`(= 비서에게 임의 지시 = 도구 실행)가 있다.
  //  ★"게이트는 '있다'가 아니라 '도는가'" 의 정확한 재발형이라 **순수 함수로 실행**한다.
  {
    const m = /const escHtml = \([\s\S]*?;\n/.exec(util);
    if (m === null) throw new Error("escHtml 정의를 못 찾음 — 구조가 바뀌었나");
    const esc = new Function(`${m[0]}return escHtml;`)() as (v: unknown) => string;
    const cases: ReadonlyArray<readonly [unknown, string]> = [
      ["<img src=x onerror=alert(1)>", "&lt;img src=x onerror=alert(1)&gt;"],
      ["&", "&amp;"],
      ['"', "&quot;"],
      ["'", "&#39;"],
      ["a<b>&\"'c", "a&lt;b&gt;&amp;&quot;&#39;c"],
      [null, ""],
      [undefined, ""],
    ];
    const wrong = cases.filter(([input, want]) => esc(input) !== want);
    out.push(
      assert(
        "★escHtml 이 실제로 다섯 문자를 전부 막는다(호출부가 부르는지만 보면 이 함수는 검사 밖이다)",
        wrong.length === 0,
        wrong.length === 0
          ? `${cases.length}케이스 통과`
          : `★${wrong.length}건 어긋남: ${wrong.map(([i]) => JSON.stringify(i)).join(", ")}`,
      ),
      // ★`&` 를 **먼저** 치환해야 한다 — 나중이면 `&lt;` 가 `&amp;lt;` 로 이중 인코딩된다.
      assert(
        "★`&` 치환이 먼저다(순서가 뒤집히면 이중 인코딩된다)",
        esc("<") === "&lt;" && esc("&lt;") === "&amp;lt;",
        `esc("<")=${esc("<")} · esc("&lt;")=${esc("&lt;")}`,
      ),
    );
  }

  // ── ★빈 값이 HTML 폴백을 지우지 않는다 (2026-08-26 G축 ②) ────────────────────
  //  `applyI18n` 의 `v !== ""` 가드엔 그물이 없었다. HTML 은 기본 언어 문구를 **그대로**
  //  써두는 설계라(카탈로그가 없어도 화면이 멀쩡히 뜬다), 반쯤 번역한 파일의 빈 값이
  //  그걸 **덮으면 빈 화면**이 된다 — 에러 0, 눈으로만 보인다. 코어·브라우저 조회 쪽은
  //  오늘 막았지만(1827e1e) **마크업 적용 경로는 별개 자리**다.
  //
  //  ★첫 판은 **이미 채워진 요소**를 재활용해서 변이가 안 먹었다(가드를 떼도 초록) —
  //   그건 이 작업이 내내 잡아온 **가짜 검사** 그 자체다. 픽스처를 **새로** 만든다:
  //   원본 문구가 남아 있는 요소에 **빈 값만 든 카탈로그**를 적용한다. 가드가 있으면
  //   원본이 그대로고, 없으면 빈 문자열이 된다 — 두 결과가 겹칠 수 없다.
  {
    const fresh = fakeDomFrom(html);
    const freshText = fresh.els.filter((e) => e.dataset.i18n !== undefined);
    const freshAttr = fresh.els.find((e) => (e.dataset.i18nAttrs ?? "").includes("="));
    const emptyCat: Record<string, string> = {};
    for (const el of fresh.els) {
      if (el.dataset.i18n !== undefined) emptyCat[el.dataset.i18n] = "";
      for (const pair of (el.dataset.i18nAttrs ?? "").split(";")) {
        const eq = pair.indexOf("=");
        if (eq >= 0) emptyCat[pair.slice(eq + 1).trim()] = "";
      }
    }
    const w = ctx.window as {
      __TIGU_I18N__: { strings: Record<string, string> };
    };
    const prevDoc = ctx.document;
    ctx.document = fresh.doc;
    w.__TIGU_I18N__.strings = emptyCat;
    apply();
    ctx.document = prevDoc;

    const wiped = freshText.filter((e) => e.textContent === "");
    out.push(
      assert(
        "★카탈로그의 빈 값이 본문을 지우지 않는다(반쯤 번역한 파일이 화면을 비우던 자리)",
        freshText.length > 10 && wiped.length === 0,
        wiped.length === 0
          ? `${freshText.length}개 요소 · 원본 유지`
          : `★${wiped.length}개가 빈 문자열로 덮였다(예: ${String(wiped[0]?.dataset.i18n)})`,
      ),
      assert(
        "★빈 값이 속성도 지우지 않는다(본문과 같은 규칙)",
        freshAttr === undefined || Object.values(freshAttr.attrs).every((v) => v !== ""),
        freshAttr === undefined
          ? "속성 요소 없음"
          : `attrs=${JSON.stringify(freshAttr.attrs)} (기대: 빈 값으로 안 채워짐)`,
      ),
    );
  }

  return out;
};

export const check: RegressionCheck = {
  name: "i18n-applies-to-screen",
  guards:
    "브라우저 쪽 i18n 이 한 번도 실행되지 않아, applyI18n() 호출을 지우거나 속성 파서를 off-by-one 내도 회귀가 전부 초록이던 것 (적대 검토 F3: 변이 8/8 통과)",
  run,
};
export default check;
