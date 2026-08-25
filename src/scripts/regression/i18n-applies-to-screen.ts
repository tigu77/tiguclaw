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
    for (const f of files) {
      const src = await readFile(new URL(f, jsDir), "utf8");
      src.split("\n").forEach((line, i) => {
        if (!line.includes("innerHTML")) return;
        scanned++;
        for (const m of line.matchAll(/i18n\(/g)) {
          if (!insideEscHtml(line, m.index!)) leaks.push(`${f}:${i + 1}`);
        }
      });
    }
    out.push(
      assert(
        "★번역 값이 escHtml 없이 innerHTML 로 가지 않는다(언어 파일은 신뢰 경계 밖이다)",
        leaks.length === 0 && scanned > 0,
        leaks.length === 0
          ? `innerHTML 문장 ${scanned}줄 전부 안전`
          : `★새는 자리 ${leaks.length}곳: ${leaks.slice(0, 4).join(" ")}`,
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
