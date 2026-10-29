/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * 회귀: **화면에 그리지 않는 요소(style·script·title…)의 글자가 답변에 드러나지 않고, 닫히지 않은 채 와도 뒤 문단을 삼키지 않는다** (2026-10-28).
 *
 * 사고: 오류 안내에 실린 520 HTML(200자로 잘림)이 대시보드 마크다운에서 `<title>` 글자와 `body{margin:0;…` CSS 로 보였다.
 *  정화기가 허용 밖 태그를 **풀어(unwrap)** 안의 글자를 남겼고, 잘린 `<style>` 은 HTML 파서가 글 끝까지를 그 안에 넣어
 *  뒤따르던 문단이 마크업째 글자로 보였다.
 *  ★첫 수정(마지막 노드면 안의 글자에서 태그부터 다시 파싱해 살리기)은 **닫힌** 마지막 `<style>`·`<script>` 안의 문자열까지
 *   본문으로 되살렸다(GPT 검토 재현: `<style>.x::after{content:"<b>CSSPAYLOAD</b>"}</style>`). 그래서 되살리기를 버리고,
 *   닫히지 않은 raw-text 요소를 **마크다운 블록 끝에서 닫아** 그 블록 안에 가둔다.
 *
 * 본다: 실제 `markdown.js`(통째)와 실제 `marked.min.js` 를 vm 에서 돌린다. DOMParser 는 이 레포에 DOM 라이브러리가 없어
 *  아래 대역을 쓴다 — **raw-text 의미(닫는 태그까지·없으면 글 끝까지)** 만 브라우저와 같게 만든 작은 파서다.
 *  실제 Chrome 대조는 따로 했다(같은 입력, 결정 기록·인계 보고에 적는다).
 *
 * 등급: **실행**(제품 파일·실제 marked) + 파서 대역.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const RAW = new Set(["script", "style", "title", "textarea", "xmp", "iframe", "noembed", "noframes"]);
const VOID = new Set(["br", "hr", "img", "input", "meta", "link", "wbr"]);
const CLOSES_P = new Set(["p", "div", "ul", "ol", "table", "pre", "blockquote", "details", "hr", "h1", "h2", "h3", "h4", "h5", "h6"]);

class N {
  parentNode: any = null;
  childNodes: any[] = [];
  constructor(public nodeType: number, public data = "") {}
  get firstChild(): any { return this.childNodes[0] ?? null; }
  get nextSibling(): any {
    const s = this.parentNode?.childNodes; if (!s) return null;
    return s[s.indexOf(this) + 1] ?? null;
  }
  get textContent(): string { return this.nodeType === 3 ? this.data : this.nodeType === 8 ? "" : this.childNodes.map((c) => c.textContent).join(""); }
  insertBefore(n: any, ref: any): any {
    if (n.parentNode) n.parentNode.removeChild(n);
    const i = ref === null ? this.childNodes.length : this.childNodes.indexOf(ref);
    this.childNodes.splice(i, 0, n); n.parentNode = this; return n;
  }
  appendChild(n: any): any { return this.insertBefore(n, null); }
  removeChild(n: any): any { this.childNodes.splice(this.childNodes.indexOf(n), 1); n.parentNode = null; return n; }
}
class E extends N {
  attrs = new Map<string, string>();
  constructor(public tag: string) { super(1); }
  get tagName(): string { return this.tag.toUpperCase(); }
  get attributes(): Array<{ name: string }> { return [...this.attrs.keys()].map((name) => ({ name })); }
  getAttribute(k: string): string | null { return this.attrs.get(k) ?? null; }
  setAttribute(k: string, v: string): void { this.attrs.set(k, String(v)); }
  removeAttribute(k: string): void { this.attrs.delete(k); }
  hasAttribute(k: string): boolean { return this.attrs.has(k); }
  get innerHTML(): string {
    return this.childNodes.map((c) => c.nodeType === 3 ? c.data : c.nodeType === 8 ? "" :
      `<${c.tag}${[...c.attrs].map(([k, v]: [string, string]) => ` ${k}="${v}"`).join("")}>${VOID.has(c.tag) ? "" : `${c.innerHTML}</${c.tag}>`}`).join("");
  }
}
/** 작은 HTML 파서 — raw-text 요소는 맞는 닫는 태그까지(없으면 글 끝까지) 글자 하나로 넣는다. */
const parseHtml = (html: string): E => {
  const body = new E("body");
  const stack: E[] = [body];
  const top = (): E => stack[stack.length - 1]!;
  const text = (s: string): void => { if (s !== "") top().appendChild(new N(3, s)); };
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) { text(html.slice(i)); break; }
    text(html.slice(i, lt));
    if (html.startsWith("<!--", lt)) { const e = html.indexOf("-->", lt); top().appendChild(new N(8)); i = e < 0 ? html.length : e + 3; continue; }
    const m = /^<(\/?)([a-zA-Z][\w-]*)([^>]*)>/.exec(html.slice(lt)) ?? /^<!([^>]*)>/.exec(html.slice(lt));
    if (m === null) { text("<"); i = lt + 1; continue; }
    i = lt + m[0].length;
    if (m[0].startsWith("<!")) continue; // doctype 등 — 버린다
    const name = m[2]!.toLowerCase();
    if (m[1] === "/") {
      const at = stack.map((e) => e.tag).lastIndexOf(name);
      if (at > 0) stack.length = at;
      continue;
    }
    if (CLOSES_P.has(name)) { const p = stack.map((e) => e.tag).lastIndexOf("p"); if (p > 0) stack.length = p; }
    const el = new E(name);
    for (const a of m[3]!.matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) el.setAttribute(a[1]!.toLowerCase(), a[2] ?? a[3] ?? a[4] ?? "");
    top().appendChild(el);
    if (RAW.has(name)) {
      const rest = html.slice(i);
      const c = rest.search(new RegExp(`</${name}[\\s/>]`, "i"));
      if (c < 0) { el.appendChild(new N(3, rest)); i = html.length; }
      else { el.appendChild(new N(3, rest.slice(0, c))); i += c + rest.slice(c).indexOf(">") + 1; }
      continue;
    }
    if (!VOID.has(name)) stack.push(el);
  }
  return body;
};

export const check: RegressionCheck = {
  name: "markdown-hidden-elements",
  guards: "답변 마크다운에서 style·title·script 의 글자가 보이던 것(520 오류 페이지의 제목·CSS) + 첫 수정이 닫힌 마지막 style/script 안의 문자열을 되살리던 것",
  run: async (): Promise<Assertion[]> => {
    const ctx: any = { DOMParser: class { parseFromString(h: string) { return { body: parseHtml(h) }; } } };
    ctx.window = ctx;
    vm.createContext(ctx);
    vm.runInContext(readFileSync(path.join(REPO, "packages/dashboard/marked.min.js"), "utf8"), ctx);
    vm.runInContext(readFileSync(path.join(REPO, "packages/dashboard/js/markdown.js"), "utf8"), ctx);
    const render = (src: string): { html: string; text: string } => {
      ctx.__src = src;
      const html = vm.runInContext("renderMarkdown(__src)", ctx) as string;
      return { html, text: parseHtml(html).textContent };
    };
    // 종전 안내 그대로(200자로 잘린 합성 520 페이지 + 뒤 문단).
    const cf = '<!DOCTYPE html>\n<html lang="en-US">\n<head>\n<title>chatgpt.com | 520: Web server is returning an unknown error</title>\n<meta charset="UTF-8" />\n<style>body{margin:0;padding:0;font-family:-apple-system,system-ui}</style></head></html>';
    const notice = render(`요청 처리 중 오류가 발생했습니다 — ${("Codex backend request failed: 520 " + cf).slice(0, 200)}\n\n이번 턴에 실행한 도구: Bash.`);
    const gpt = render('<p>안내</p><style>.x::after{content:"<b>CSSPAYLOAD</b>"}</style>');
    const gptTail = render('<p>안내</p><style>.x::after{content:"<b>CSSPAYLOAD</b>"}</style>\n\n꼬리 본문');
    const script = render('본문\n\n<script>var s="<p>SECRET</p>"</script>');
    const title = render("본문\n\n<title><b>HIDDEN_TITLE</b></title>");
    const inline = render("문단 A <style>p{color:red}\n\n문단 B 보존");
    const xss = render("a <title>x\n\n<img src=x onerror=alert(1)>ok");
    const fence = render("```html\n<style>body{color:red}</style>\n```\n\n인라인 `<title>t</title>` 끝");
    const details = render("<details>\n<summary>More</summary>\n\n내용 **굵게**\n\n</details>\n\n뒤 문단");

    // 블록마다 만든 HTML 을 이은 것 == marked.parse (raw-text 가 없는 보통 답변은 전과 같은 HTML).
    const corpus = [
      "# 제목\n\n- [ ] 할일\n- [x] 끝\n\n| a | b |\n|:-|-:|\n| 1 | 2 |\n\n<kbd>Ctrl</kbd> **굵게** [링크](https://example.com)",
      "> 인용\n> 두 줄\n\n1. 하나\n2. 둘\n   - 중첩\n\n```js\nconst a = '<b>x</b>';\n```\n\n[참조][1]\n\n[1]: https://example.com/ref\n\n줄바꿈\n그대로",
      "<details open><summary>요약</summary>\n\n본문\n\n</details>\n\n<u>밑줄</u> <!-- 주석 --> 끝",
    ];
    ctx.__corpus = corpus;
    const same = vm.runInContext(`__corpus.map((s) => {
      const opts = Object.assign({}, marked.defaults, { gfm: true, breaks: true });
      const t = marked.lexer(sealFences(s), opts);
      const joined = t.map((x) => { const one = [x]; one.links = t.links; return marked.parser(one, opts); }).join("");
      return joined === marked.parse(sealFences(s), { gfm: true, breaks: true });
    })`, ctx) as boolean[];
    const closer = vm.runInContext(`[
      closeRawTextAtBlockEnd("<p>a<style>x</style>b</p>"),
      closeRawTextAtBlockEnd("<p>a<style>x</p>"),
      closeRawTextAtBlockEnd("<p>a<style>x</stylex></p>"),
      closeRawTextAtBlockEnd("<p><title>t</title><script>s"),
    ]`, ctx) as string[];

    const leak = /CSSPAYLOAD|SECRET|HIDDEN_TITLE|margin:0|font-family|color:red|520: Web server/;
    return [
      assert(
        "★잘린 520 오류 페이지 — 제목·CSS 글자 0 · 뒤 문단은 마크업 없이 그대로",
        !leak.test(notice.text) && notice.text.includes("이번 턴에 실행한 도구: Bash.") && !/<p>|&lt;p&gt;/.test(notice.text),
        notice.text,
      ),
      assert(
        "★닫힌 마지막 style/script/title 안의 문자열을 되살리지 않는다(GPT 재현 입력 포함) · 뒤 문단은 산다",
        !leak.test(gpt.text) && gpt.text.includes("안내") && !leak.test(gptTail.text) && gptTail.text.includes("꼬리 본문") &&
          !leak.test(script.text) && !leak.test(title.text),
        { gpt: gpt.text, gptTail: gptTail.text, script: script.text, title: title.text },
      ),
      assert(
        "★닫히지 않은 style 은 그 블록 안에 갇힌다 — 다음 문단 보존 · 되살아난 꼬리도 정화를 지난다(onerror 0)",
        inline.text.includes("문단 B 보존") && !leak.test(inline.text) && xss.text.includes("ok") && !/onerror/.test(xss.html),
        { inline: inline.text, xss: xss.html },
      ),
      assert(
        "코드 블록·인라인 코드 안의 HTML 은 그대로 글자로 보인다 · details 접기는 블록을 넘어 그대로",
        /&lt;style&gt;body\{color:red\}&lt;\/style&gt;/.test(fence.html) && /<code>&lt;title&gt;t&lt;\/title&gt;<\/code>/.test(fence.html) &&
          /<details>\s*<summary>More<\/summary>[\s\S]*내용[\s\S]*<\/details>[\s\S]*뒤 문단/.test(details.html),
        { fence: fence.html, details: details.html },
      ),
      assert(
        "블록마다 만든 HTML 을 이은 것 == marked.parse(보통 답변 무변화) · 블록 끝 닫기는 닫힌 것엔 손대지 않는다",
        same.every(Boolean) && closer[0] === "<p>a<style>x</style>b</p>" && closer[1] === "<p>a<style>x</p></style>" &&
          closer[2] === "<p>a<style>x</stylex></p></style>" && closer[3] === "<p><title>t</title><script>s</script>",
        { same, closer },
      ),
    ];
  },
};
