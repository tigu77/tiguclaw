/**
 * 회귀: **대시보드 HTML 에 번역 표식 없는 한국어가 없다** (2026-10-07).
 *
 * 사고(정태님 «대시보드에 백그라운드 버튼은 영어로 해도 한글로 나오네»): 우상단 버튼 글자 `<span class="bg-word">백그라운드</span>` 에
 * `data-i18n` 이 없어 영어 화면에서도 한국어였다 — 같은 버튼의 툴팁은 번역되는데 보이는 글자만. «번역 안 된 한국어» 검사
 * (`i18n-catalogs-and-coverage` ③)는 대시보드 **JS** 만 훑어 `index.html` 의 정적 글자를 못 봤다.
 *
 * 규칙: `index.html` 의 한국어 텍스트·속성(aria-label·title·placeholder·alt)은 `data-i18n` / `data-i18n-attrs` 로 카탈로그를 거치거나,
 *  JS 가 덮어쓰는 자리면 그 요소에 `data-i18n-js="<속성|text>"` 로 **그렇다고 적는다**(목록을 여기 두지 않는다 — 파일이 스스로 말한다).
 *  `<title>`·`<meta>` 는 서버(`packages/dashboard/index.ts`)가 정규식으로 찾아 바꾸는 자리라 속성을 달 수 없다 — 그래서 뺀다.
 *
 * 등급: **소스·자산 게이트**.
 */
import { readFileSync } from "node:fs";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const HANGUL = /[가-힣]/;

export const findRawKorean = (html: string): string[] => {
  const h = html
    .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/<(script|style|title)\b[\s\S]*?<\/\1>/g, (m) => m.replace(/[^\n]/g, " "));
  const lineOf = (i: number): number => h.slice(0, i).split("\n").length;
  const out: string[] = [];
  for (const m of h.matchAll(/<([a-z0-9-]+)(\s[^>]*)?>([^<]*)/gi)) {
    const [, tag, attrs = "", text = ""] = m;
    if (/^meta$/i.test(tag!)) continue;
    const jsSet = (/data-i18n-js="([^"]*)"/.exec(attrs)?.[1] ?? "").split(/[;,\s]+/);
    if (HANGUL.test(text) && !/\bdata-i18n="/.test(attrs) && !jsSet.includes("text")) {
      out.push(`${lineOf(m.index!)}: <${tag}> «${text.trim().slice(0, 30)}»`);
    }
    const mapped = (/data-i18n-attrs="([^"]*)"/.exec(attrs)?.[1] ?? "").split(";").map((p) => p.split("=")[0]!.trim());
    for (const a of attrs.matchAll(/\b(aria-label|title|placeholder|alt)="([^"]*)"/g)) {
      if (HANGUL.test(a[2]!) && !mapped.includes(a[1]!) && !jsSet.includes(a[1]!)) {
        out.push(`${lineOf(m.index!)}: <${tag} ${a[1]}> «${a[2]!.slice(0, 30)}»`);
      }
    }
  }
  return out;
};

export const check: RegressionCheck = {
  name: "dashboard-html-has-no-raw-korean",
  guards: "대시보드 HTML 에 번역 표식 없는 한국어 글자가 남아 영어 화면에서도 한국어로 보이던 것(우상단 «백그라운드» 버튼)",
  run: async (): Promise<Assertion[]> => {
    const html = readFileSync(new URL("../../../packages/dashboard/index.html", import.meta.url), "utf8");
    const raw = findRawKorean(html);
    const probe = findRawKorean('<button><span class="bg-word">백그라운드</span></button><p data-i18n="x">설명</p><i title="툴팁"></i>');
    return [
      assert(
        "★index.html 의 한국어 텍스트·속성은 전부 카탈로그를 거치거나 «JS 가 정한다» 고 적혀 있다",
        raw.length === 0,
        raw.length === 0 ? "0건" : raw.slice(0, 6).join(" · "),
      ),
      assert(
        "판정 자체가 돈다 — 표식 없는 텍스트·속성을 잡고, 표식 있는 것은 넘긴다",
        probe.length === 2 && probe.some((p) => p.includes("백그라운드")) && probe.some((p) => p.includes("툴팁")),
        probe.join(" · "),
      ),
    ];
  },
};
