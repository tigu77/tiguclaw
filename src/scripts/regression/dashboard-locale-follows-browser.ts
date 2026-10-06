/**
 * 회귀: **설정에 언어가 없으면 대시보드는 보는 사람의 브라우저 언어를 따른다** — 정한 값이 있으면 그게 이긴다 (2026-10-06).
 *
 * 배경: 정태님 질문 «처음 설치하면 대시보드가 OS 언어 따라가는건가?» — 아니었다. `locale` 이 없으면 누구나 한국어 화면이었고,
 * v0.66.0 에서 서버 알림이 영어가 되자 영어권 사용자는 «영어 알림 + 한국어 화면» 을 받게 됐다.
 * 결정: 브라우저 `Accept-Language` 로 고르고(한국어면 한국어, 맞는 게 없으면 영어) **설정 파일엔 쓰지 않는다**.
 * ★같은 화면의 플러그인 문구(구독 인증 버튼)는 데몬이 만든다 — 대시보드 프록시가 언어를 실어 보내고 브리지가 그 문맥에서
 *  처리해야 화면과 같은 언어가 된다. 둘 중 하나만 있으면 처음 설치한 사람이 가장 먼저 누르는 버튼만 한국어로 남는다.
 *
 * 등급: **동작**(판정 함수·요청 문맥 실행) + 배선(대시보드·브리지).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  configuredLocale,
  localeForViewer,
  localeFromAcceptLanguage,
  readLocale,
  withViewerLanguage,
} from "../../core/i18n.js";
import { assert, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "dashboard-locale-follows-browser",
  guards:
    "처음 설치하면(설정에 언어 없음) 누구나 한국어 대시보드를 받던 것 — 영어권 사용자에게 영어 알림 + 한국어 화면 + 한국어 인증 버튼",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const unset = mkdtempSync(path.join(tmpdir(), "tiguclaw-regression-locale-unset-"));
    const pinned = mkdtempSync(path.join(tmpdir(), "tiguclaw-regression-locale-pinned-"));
    try {
      mkdirSync(path.join(pinned, ".tiguclaw"), { recursive: true });
      const pinnedSettings = path.join(pinned, ".tiguclaw", "settings.json");
      writeFileSync(pinnedSettings, JSON.stringify({ locale: "ko" }) + "\n", "utf8");
      const AV = ["en", "ko"];
      const parse = {
        koBrowser: localeFromAcceptLanguage("ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7", AV),
        enBrowser: localeFromAcceptLanguage("en-US,en;q=0.9", AV),
        byQ: localeFromAcceptLanguage("fr;q=0.2, en;q=0.5, ko;q=0.9", AV),
        zeroQ: localeFromAcceptLanguage("fr, ko;q=0", AV),
        none: localeFromAcceptLanguage("ja,fr;q=0.5,*;q=0.1", AV),
      };
      const pre = configuredLocale(unset);
      const viewer = {
        ko: localeForViewer("ko-KR,ko;q=0.9", unset),
        en: localeForViewer("en-US,en;q=0.9", unset),
        ja: localeForViewer("ja-JP", unset),
        noHeader: localeForViewer(undefined, unset),
        pinnedEn: localeForViewer("en-US,en;q=0.9", pinned),
      };
      // 요청 문맥 — 데몬 쪽 `readLocale()`(플러그인 `host.locale` 이 부르는 것)이 보는 사람을 따르나. await 를 건너도.
      const inEn = await withViewerLanguage("en-US,en;q=0.9", async () => {
        await new Promise((r) => setTimeout(r, 1));
        return readLocale(unset);
      });
      const inKo = withViewerLanguage("ko-KR", () => readLocale(unset));
      const outside = readLocale(unset);
      const inPinned = withViewerLanguage("en-US", () => readLocale(pinned));
      const settingsAfter = readFileSync(pinnedSettings, "utf8");

      const dash = readFileSync(new URL("../../../packages/dashboard/index.ts", import.meta.url), "utf8");
      const bridge = readFileSync(new URL("../../../plugins/http-bridge/index.ts", import.meta.url), "utf8");
      return [
        assert(
          "Accept-Language 를 q 순으로 읽어 설치된 언어를 고른다(지역 표기 ko-KR→ko · q=0 제외 · 맞는 것 없으면 없음)",
          parse.koBrowser === "ko" && parse.enBrowser === "en" && parse.byQ === "ko" && parse.zeroQ === undefined && parse.none === undefined,
          JSON.stringify(parse),
        ),
        assert(
          "★설정에 언어가 없으면 브라우저를 따른다 — 한국어→한국어 · 영어→영어 · 맞는 게 없으면 영어 · 보는 사람이 없으면 종전 기본",
          pre === undefined && viewer.ko === "ko" && viewer.en === "en" && viewer.ja === "en" && viewer.noHeader === "ko",
          `전제(설정 없음)=${String(pre)} · ${JSON.stringify(viewer)}`,
        ),
        assert(
          "★사용자가 정한 언어는 브라우저보다 우선이고, 고른 값을 설정 파일에 쓰지 않는다",
          viewer.pinnedEn === "ko" && inPinned === "ko" && JSON.parse(settingsAfter).locale === "ko" && configuredLocale(unset) === undefined,
          `고정+영어 브라우저=${viewer.pinnedEn}`,
        ),
        assert(
          "★요청 문맥 안의 readLocale(플러그인 문구가 쓰는 것)도 보는 사람의 언어 — await 를 건너도 · 문맥 밖은 종전 기본",
          inEn === "en" && inKo === "ko" && outside === "ko",
          `영어 요청=${inEn} · 한국어 요청=${inKo} · 밖=${outside}`,
        ),
        assert(
          "배선 — 대시보드가 화면 언어를 브라우저로 고르고 브리지 요청에 언어를 싣는다 · 브리지는 그 문맥에서 처리한다",
          /catalogForClient\(localeForViewer\(viewerLanguage\.getStore\(\)\)\)/.test(dash) &&
            /\.\.\.viewerLanguageHeader\(\),\s*\n\s*Authorization/.test(dash) &&
            /viewerLanguage\.run\(lang, handle\)/.test(dash) &&
            /withViewerLanguage\(req\.headers\["accept-language"\], \(\) => this\.handleRequest\(req, res\)\)/.test(bridge),
          `화면=${/catalogForClient\(localeForViewer/.test(dash)} · 프록시=${/viewerLanguageHeader\(\)/.test(dash)} · 브리지=${/withViewerLanguage\(req/.test(bridge)}`,
        ),
      ];
    } finally {
      rmSync(unset, { recursive: true, force: true });
      rmSync(pinned, { recursive: true, force: true });
    }
  },
};
