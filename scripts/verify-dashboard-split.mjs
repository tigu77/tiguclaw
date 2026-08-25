#!/usr/bin/env node
// 대시보드 분해 구조 게이트 — 순수 node, 외부 의존 0.
// ADR: docs/decisions/2026-07-16-dashboard-decomposition.md · 계획: _workspace/dashboard-split_plan.md
//
// ★분해 마이그레이션(Phase1~2c)은 완료됨. 그 시기엔 "concat == 오라클(f4b2b38) 바이트 동등"
// 으로 순수 텍스트 이동을 증명했으나(git 이력에 기록), 정상 개발이 재개되면 js/*.js·app.css 를
// 합법적으로 편집하므로 오라클 비교는 은퇴한다(계획 §1 말미). 이 스크립트는 이제 **영속 구조
// 불변식**만 지킨다 — 분해된 레이아웃이 깨지지 않았는가:
//   1. index.html 에 인라인 <style> 0 + <link href=/app.css> 존재(모든 CSS 는 app.css).
//   2. index.html 의 모든 앱 <script> 는 src="/js/*.js"(비-vendored 인라인 <script> 본문 0 —
//      모든 앱 JS 는 js/ 모듈). vendored(marked/highlight) 만 예외.
//   3. <script src="/js/..."> 태그 순서 == js/_manifest.json 순서(로드순서 드리프트 차단).
//   4. 참조 정합: 태그가 가리키는 js 파일 실존 + 매니페스트 항목 == 태그 == js/*.js 파일 집합.
//
// pre-commit/CI 에서 packages/dashboard/** 변경 시 실행 권장.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const dashDir = path.join(repoRoot, "packages", "dashboard");
const jsDir = path.join(dashDir, "js");
const VENDORED_SRC = new Set(["/marked.min.js", "/highlight.min.js"]);

const fail = (msg) => {
  console.error(`[verify-dashboard-split] FAIL: ${msg}`);
  process.exit(1);
};
const ok = (msg) => console.log(`[verify-dashboard-split] OK: ${msg}`);

const currentHtml = fs.readFileSync(path.join(dashDir, "index.html"), "utf8");

// ---- 1) CSS 는 app.css 로 외부화 ----
// ★주석은 빼고 본다 — index.html 의 헤더 주석이 규칙을 설명하며 `<style>` 를 언급하는데,
//  그걸 실제 태그로 세서 이 게이트가 **상시 빨간불**이었다(그래서 아무도 안 봤다).
//  검사 대상은 마크업이지 마크업을 설명하는 글이 아니다.
const markupOnly = currentHtml.replace(/<!--[\s\S]*?-->/g, "");
if (/<style[\s>]/.test(markupOnly)) {
  fail("index.html 에 인라인 <style> 잔존 — 모든 CSS 는 app.css 로 가야 함");
}
if (!/<link\s+rel="stylesheet"\s+href="\/app\.css"\s*\/?>/.test(currentHtml)) {
  fail('index.html 에 <link rel="stylesheet" href="/app.css"> 없음');
}
if (!fs.existsSync(path.join(dashDir, "app.css"))) fail("app.css 파일 없음");
ok("CSS: 인라인 <style> 0 · <link href=/app.css> · app.css 존재");

// ---- 2) 앱 JS 는 전부 js/ 모듈(비-vendored 인라인 <script> 본문 0) + 3) 태그 순서 수집 ----
const scriptTagRe = /<script([^>]*)>([\s\S]*?)<\/script>/g;
const jsSrcOrder = [];
for (const m of markupOnly.matchAll(scriptTagRe)) {
  const srcMatch = m[1].match(/\ssrc="([^"]+)"/);
  if (srcMatch) {
    const src = srcMatch[1];
    if (VENDORED_SRC.has(src)) continue;
    if (!src.startsWith("/js/")) fail(`index.html 에 알 수 없는 src 스크립트: ${src}`);
    const base = path.basename(src.slice("/js/".length)); // traversal 방어.
    if (!fs.existsSync(path.join(jsDir, base))) fail(`참조하는 js 파일 없음: js/${base}`);
    jsSrcOrder.push(base);
  } else if (m[2].trim() !== "") {
    // ★언어 카탈로그 주입 자리는 **설계상 인라인이어야 한다** (2026-08-25). 서버가 서빙할 때
    //  이 태그를 통째로 바꿔 카탈로그를 심는다 — fetch 로 받으면 첫 렌더가 카탈로그보다
    //  먼저 돌아 화면이 깜빡인다. 앱 JS 가 아니라 **데이터**다.
    //  ★예외를 이름(`id`)으로 좁게 판다 — "본문 있는 script 는 다 봐준다" 로 넓히면 이
    //   게이트가 지키던 것이 사라진다.
    if (!/\sid="tigu-i18n"/.test(m[1])) {
      fail("index.html 에 인라인 <script> 본문 잔존 — 모든 앱 JS 는 js/ 모듈로(src=)");
    }
  }
}
if (jsSrcOrder.length === 0) fail("index.html 에 /js/ 스크립트 태그가 하나도 없음");
ok(`JS: 인라인 앱 <script> 본문 0 · /js/ 모듈 ${jsSrcOrder.length}개 참조`);

// ---- 3+4) 태그 순서 == _manifest.json 순서 + 집합 정합 ----
const manifestPath = path.join(jsDir, "_manifest.json");
if (!fs.existsSync(manifestPath)) fail("js/_manifest.json 없음");
let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
} catch (e) {
  fail(`js/_manifest.json JSON 파싱 실패: ${e.message}`);
}
if (!Array.isArray(manifest)) fail("js/_manifest.json 은 파일명 배열(로드순서)이어야 함");
const manifestOrder = manifest.map((n) => path.basename(n));

if (jsSrcOrder.length !== manifestOrder.length) {
  fail(`/js/ 태그 수(${jsSrcOrder.length}) != 매니페스트 항목 수(${manifestOrder.length})`);
}
for (let i = 0; i < jsSrcOrder.length; i++) {
  if (jsSrcOrder[i] !== manifestOrder[i]) {
    fail(`로드순서 드리프트: index.html script[${i}]="${jsSrcOrder[i]}" != manifest[${i}]="${manifestOrder[i]}"`);
  }
}
// 디스크의 js/*.js 파일 집합 == 매니페스트 집합(고아 파일/누락 차단).
const diskJs = fs.readdirSync(jsDir).filter((f) => f.endsWith(".js")).sort();
const manSorted = [...manifestOrder].sort();
if (JSON.stringify(diskJs) !== JSON.stringify(manSorted)) {
  fail(`js/ 파일 집합 != 매니페스트 집합\n  disk: ${diskJs.join(",")}\n  manifest: ${manSorted.join(",")}`);
}
ok(`순서·집합 정합: 태그 == 매니페스트 == js/ 파일 (${manifestOrder.length}개)`);

console.log("[verify-dashboard-split] PASS");
process.exit(0);
