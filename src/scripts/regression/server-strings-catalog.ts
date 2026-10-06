/**
 * 회귀: **서버 문구 키(`srv.`)가 카탈로그와 맞는다** — 호출부·한영 두 카탈로그·자리표시자 (2026-10-06).
 *
 * 배경: 서버 고정 문구(채팅 알림·명령 응답)를 `translate("srv.…", {…})` 로 옮겼다(정태님 «키 형태로, 사용자가 덮어쓸 수 있게,
 * 기본 언어는 설치 언어·없으면 영어»). 화면 문구의 검사(`i18n-*`)는 대시보드 JS 만 읽으므로 서버 호출부는 이 검사가 본다.
 * 지키는 것 — 넷 다 «개발 기계(영어 고정 러너)에선 멀쩡하고 다른 언어에서만 틀리는» 부류다:
 *  ① 호출부가 부르는 키가 **en·ko 둘 다** 있다(없으면 사용자에게 키 이름이 그대로 간다)
 *  ② 자리표시자가 en·ko·호출부 params 셋 다 같다(빠지면 숫자·이름이 사라진 문장, 남으면 `{n}` 이 그대로)
 *  ③ 아무도 안 부르는 `srv.` 키가 없다(문구를 고치며 키를 바꾸면 번역이 조용히 고아가 된다)
 *  ④ 영어 값에 한글이 없다(조각을 반대로 넣으면 영어 사용자에게 한국어가 간다)
 *
 * 등급: **소스·자산 게이트** — 실제 소스와 카탈로그를 읽어 대조한다.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";
import { stripComments } from "./_wiring.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const PLACEHOLDER = /\{(\w+)\}/g;
const HANGUL = /[가-힣]/;

const tsFiles = (dir: string, out: string[] = []): string[] => {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === "scripts" || e.startsWith(".")) continue;
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) tsFiles(p, out);
    else if (/\.(ts|mts)$/.test(e) && !e.endsWith(".d.ts")) out.push(p);
  }
  return out;
};

/**
 * `translate(` 의 **첫 인자** 범위 — 최상위 쉼표나 닫는 괄호까지. 그 안의 `"srv.…"` 가 전부 이 호출의 후보 키다
 * (단수/복수 `n === 1 ? "srv.a.one" : "srv.a.other"` 처럼 키를 고르는 호출부가 36곳 — 리터럴 첫 인자만 보면 그물이 빈다, 적대 검토 G1).
 */
export const firstArgAt = (src: string, openParen: number): { text: string; end: number } => {
  let d = 0;
  let quote: string | null = null;
  for (let j = openParen + 1; j < src.length; j++) {
    const c = src[j]!;
    if (quote !== null) {
      if (c === "\\") j++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "(" || c === "{" || c === "[") d++;
    else if (c === ")" || c === "}" || c === "]") {
      if (d === 0) return { text: src.slice(openParen + 1, j), end: j };
      d--;
    } else if (c === "," && d === 0) return { text: src.slice(openParen + 1, j), end: j };
  }
  return { text: src.slice(openParen + 1), end: src.length };
};

/** `translate("srv.x", { a, b: 1 })` 의 params 최상위 키. 객체 리터럴이 아니면 undefined(대조하지 않는다). */
export const paramKeysAt = (src: string, from: number): string[] | undefined => {
  let i = from;
  while (i < src.length && /\s/.test(src[i]!)) i++;
  if (src[i] === ")") return [];
  if (src[i] !== ",") return undefined;
  i++;
  while (i < src.length && /\s/.test(src[i]!)) i++;
  if (src[i] === ")") return [];
  if (src[i] !== "{") return undefined;
  let depth = 0;
  let j = i;
  for (; j < src.length; j++) {
    const c = src[j];
    if (c === "{" || c === "(" || c === "[") depth++;
    else if (c === "}" || c === ")" || c === "]") {
      depth--;
      if (depth === 0) break;
    }
  }
  // 최상위 쉼표로 나눠 키만 — 중첩 괄호 안은 건너뛴다.
  const body = src.slice(i + 1, j);
  const parts: string[] = [];
  let d = 0;
  let cur = "";
  for (const c of body) {
    if (c === "{" || c === "(" || c === "[") d++;
    if (c === "}" || c === ")" || c === "]") d--;
    if (c === "," && d === 0) {
      parts.push(cur);
      cur = "";
    } else cur += c;
  }
  if (cur.trim() !== "") parts.push(cur);
  const keys: string[] = [];
  for (const p of parts) {
    const t = p.trim();
    if (t.startsWith("...")) return undefined; // 펼침은 키를 모른다
    const m = /^["']?(\w+)["']?\s*(?::|$)/.exec(t);
    if (m) keys.push(m[1]!);
  }
  return keys;
};

export const check: RegressionCheck = {
  name: "server-strings-catalog",
  guards:
    "서버 문구 키가 한쪽 카탈로그에만 있거나 자리표시자가 호출부와 어긋나 다른 언어 사용자에게 키 이름·빈 숫자가 가던 것 + 고아 번역",
  run: async (): Promise<Assertion[]> => {
    const en = JSON.parse(readFileSync(path.join(REPO, "locales/en.json"), "utf8")) as Record<string, string>;
    const ko = JSON.parse(readFileSync(path.join(REPO, "locales/ko.json"), "utf8")) as Record<string, string>;
    const files = [...tsFiles(path.join(REPO, "src")), ...tsFiles(path.join(REPO, "plugins"))];
    const calls: { key: string; params: string[] | undefined; where: string }[] = [];
    const mentioned = new Set<string>();
    for (const f of files) {
      // ★주석을 걷고 센다 — 주석 속 키 언급이 «쓰는 중» 으로 잡혀 고아가 숨었다(적대 검토 G3).
      const src = stripComments(readFileSync(f, "utf8"));
      for (const m of src.matchAll(/["'`](srv\.[\w.]+)["'`]/g)) mentioned.add(m[1]!);
      for (const m of src.matchAll(/\btranslate\(/g)) {
        const open = m.index! + m[0].length - 1;
        const arg = firstArgAt(src, open);
        const keys = [...arg.text.matchAll(/["'](srv\.[\w.]+)["']/g)].map((k) => k[1]!);
        if (keys.length === 0) continue;
        const params = paramKeysAt(src, arg.end);
        for (const key of keys) {
          calls.push({ key, params, where: `${path.relative(REPO, f)}:${src.slice(0, m.index).split("\n").length}` });
        }
      }
    }
    const srvKeys = [...new Set([...Object.keys(en), ...Object.keys(ko)].filter((k) => k.startsWith("srv.")))];
    const ph = (s: string | undefined): string => [...new Set([...(s ?? "").matchAll(PLACEHOLDER)].map((m) => m[1]!))].sort().join(",");

    const missing = [...new Set(calls.map((c) => c.key))].filter((k) => !en[k] || !ko[k]);
    const catalogMismatch = srvKeys.filter((k) => ph(en[k]) !== ph(ko[k]));
    const callMismatch = calls.filter((c) => c.params !== undefined && en[c.key] !== undefined && c.params.slice().sort().join(",") !== ph(en[c.key]));
    const orphans = srvKeys.filter((k) => !mentioned.has(k));
    const hangulInEn = srvKeys.filter((k) => HANGUL.test(en[k] ?? ""));
    return [
      assert(
        "★서버 문구가 실제로 키로 나간다(호출부 0 이면 이 검사는 아무것도 지키지 않는다)",
        calls.length >= 50 && srvKeys.length >= 50,
        `호출부 ${calls.length} · srv 키 ${srvKeys.length} · 파일 ${new Set(calls.map((c) => c.where.split(":")[0])).size}`,
      ),
      assert(
        "★호출부가 부르는 키는 en·ko 둘 다 있다(없으면 키 이름이 그대로 간다)",
        missing.length === 0,
        missing.length === 0 ? "누락 0" : `누락 ${missing.length}: ${missing.slice(0, 6).join(", ")}`,
      ),
      assert(
        "★자리표시자가 en·ko 와 호출부 params 셋 다 같다",
        catalogMismatch.length === 0 && callMismatch.length === 0,
        catalogMismatch.length + callMismatch.length === 0
          ? `params 대조 ${calls.filter((c) => c.params !== undefined).length}곳`
          : [
              ...catalogMismatch.slice(0, 3).map((k) => `${k}: en={${ph(en[k])}} ko={${ph(ko[k])}}`),
              ...callMismatch.slice(0, 3).map((c) => `${c.where} ${c.key}: 호출={${c.params!.sort().join(",")}} en={${ph(en[c.key])}}`),
            ].join(" · "),
      ),
      assert(
        "아무도 안 부르는 srv 키가 없다(고아 번역)",
        orphans.length === 0,
        orphans.length === 0 ? "고아 0" : `고아 ${orphans.length}: ${orphans.slice(0, 6).join(", ")}`,
      ),
      assert(
        "영어 값에 한글이 없다",
        hangulInEn.length === 0,
        hangulInEn.length === 0 ? "0" : hangulInEn.slice(0, 6).join(", "),
      ),
    ];
  },
};
