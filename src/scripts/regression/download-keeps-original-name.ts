/**
 * 회귀: **비서가 보낸 파일은 원래 이름으로 받아진다** (2026-10-16, 정태님 «해쉬값 같은 걸로 이름이 바뀌어 다운로드»).
 *
 * 사고: 대시보드 받기 버튼은 `<a download="원래이름">` 이었지만, 브리지가 바로 보여줄 수 없는 형식에
 *  `Content-Disposition: attachment; filename="<저장 이름=해시>"` 를 붙여 브라우저가 그걸 따랐다(서버 헤더가 이긴다). 원래 이름을
 *  넘겨도 이름 정리가 한글을 지워 `file` 이 됐고, 대시보드 프록시는 쿼리를 버렸다.
 *
 * 본다: ① 헤더가 원래 이름(한글)을 UTF-8 `filename*` 로 · ASCII 대체 이름 · 경로·따옴표·줄바꿈 제거 · 이름이 비면 저장 이름
 *  ② 배선 — 브리지가 `name`·`download` 를 읽고 · 프록시가 쿼리를 넘기고 · 화면이 받기·열기 링크에 원래 이름을 싣는다
 *
 * 등급: **실행**(순수 함수) + 배선(소스).
 */
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";
import { readSourceSync, stripComments } from "./_wiring.js";

export const check: RegressionCheck = {
  name: "download-keeps-original-name",
  guards: "비서가 보낸 파일이 저장 이름(해시)으로 받아지던 것 — 서버 헤더가 원래 이름을 덮었고, 한글은 지워졌고, 프록시가 쿼리를 버렸다",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const mod = (await import(new URL("../../../plugins/http-bridge/attachments.js", import.meta.url).href)) as {
      contentDispositionFor: (type: "inline" | "attachment", wanted: string, stored: string) => string;
    };
    const ko = mod.contentDispositionFor("attachment", "보고서 최종.pdf", "5d6c941db5dca4e7.pdf");
    const en = mod.contentDispositionFor("attachment", "synthetic-proof.mp4", "5d6c941db5dca4e7.mp4");
    const evil = mod.contentDispositionFor("attachment", '../../x"\r\nSet-Cookie: a=1.txt', "abc.txt");
    const empty = mod.contentDispositionFor("inline", "", "abc.png");
    // 이모지가 든 긴 이름 — UTF-16 으로 자르면 서로게이트 쌍이 끊겨 encodeURIComponent 가 던지고 500 이었다(레드팀 A)
    let emojiOk = true;
    try { mod.contentDispositionFor("attachment", "😀".repeat(150) + ".pdfx", "abc.pdf"); } catch { emojiOk = false; }
    const decoded = decodeURIComponent((ko.match(/filename\*=UTF-8''(.+)$/) ?? [])[1] ?? "");
    out.push(assert("① 원래 이름(한글)이 UTF-8 filename* 로 · ASCII 대체는 한글만이면 저장 이름 · 경로·따옴표·줄바꿈 제거 · 이름이 비면 저장 이름",
      decoded === "보고서 최종.pdf" && /filename="5d6c941db5dca4e7\.pdf"/.test(ko) &&
        /filename="synthetic-proof\.mp4"/.test(en) && /^attachment; /.test(en) &&
        !/[\r\n]/.test(evil) && !/\.\.\//.test(decodeURIComponent(evil)) && (evil.match(/"/g) ?? []).length === 2 &&
        /^inline; filename="abc\.png"/.test(empty) && emojiOk,
      { ko, en, evil, empty, emojiOk }));

    const route = stripComments(readSourceSync("plugins/http-bridge/routes-files.ts"));
    const proxy = stripComments(readSourceSync("packages/dashboard/index.ts"));
    const view = stripComments(readSourceSync("packages/dashboard/js/history-render.js"));
    const w = {
      routeReadsQuery: /url\.searchParams\.get\("name"\)/.test(route) && /url\.searchParams\.get\("download"\) === "1"/.test(route) && /contentDispositionFor\(/.test(route),
      noHashedDisposition: !/filename="\$\{sanitizeFilename\(path\.basename\(abs\)\)\}"/.test(route),
      proxyForwardsQuery: /proxyRaw\(res, "\/attachments\/" \+ pathname\.slice\("\/api\/attachments\/"\.length\) \+ url\.search\)/.test(proxy),
      downloadLinkNamed: /dlHref \+ "\?download=1&name=" \+ encodeURIComponent\(name\)/.test(view),
      openLinkNamed: /t\.url \+ "\?name=" \+ encodeURIComponent\(name\)/.test(view),
    };
    out.push(assert("② 브리지가 name·download 를 읽고 · 프록시가 쿼리를 넘기고 · 화면이 받기·열기 링크에 원래 이름을 싣는다",
      Object.values(w).every(Boolean), w));
    return out;
  },
};
