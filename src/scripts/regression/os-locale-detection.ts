/**
 * 회귀: **OS 언어를 OS 마다 정본에서 읽는다** — 설정에 언어가 없을 때 서버 문구의 기본 언어 (2026-10-06).
 *
 * 함정(실측): 이 맥은 시스템 언어가 `ko-KR` 인데 `LANG=C.UTF-8` 셸의 Node `Intl` 은 `en-US`, launchd 데몬은 `LANG` 이 없어 역시 `en-US`.
 * `LANG`·`Intl` 한 가지로 읽으면 한국어 맥이 영어로 뜬다. 맥=시스템 설정 · Windows=`Intl`(사용자 로캘 API) · 그 밖=`LC_*`/`LANG`.
 *
 * 등급: **동작** — 순수 판정 함수에 OS 별 출처를 넣어 본다(실제 기계에 의존하지 않는다 — 개발 맥·CI 리눅스가 같은 답을 내야 한다).
 */
import { parseAppleLanguages, parsePosixLocale, resolveOsLocale, type OsLocaleSources } from "../../core/os-locale.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const src = (o: Partial<OsLocaleSources> & { env?: Record<string, string | undefined> }): OsLocaleSources => ({
  platform: o.platform ?? "linux",
  env: o.env ?? {},
  appleLanguages: o.appleLanguages ?? (() => undefined),
  intlLocale: o.intlLocale ?? (() => "en-US"),
});

export const check: RegressionCheck = {
  name: "os-locale-detection",
  guards: "OS 언어를 LANG·Intl 로만 읽어 한국어 맥(launchd 데몬)이 영어로 뜨던 것 — 설정 없을 때 서버 문구의 기본 언어",
  run: async (): Promise<Assertion[]> => {
    const APPLE = '(\n    "ko-KR",\n    "en-KR"\n)\n';
    const r = {
      macApple: resolveOsLocale(src({ platform: "darwin", appleLanguages: () => APPLE, env: { LANG: "C.UTF-8" } })),
      macNoApple: resolveOsLocale(src({ platform: "darwin", env: { LANG: "ja_JP.UTF-8" } })),
      macNothing: resolveOsLocale(src({ platform: "darwin", env: {} })),
      win: resolveOsLocale(src({ platform: "win32", intlLocale: () => "ko-KR", env: {} })),
      linuxOrder: resolveOsLocale(src({ env: { LC_ALL: "de_DE.UTF-8", LC_MESSAGES: "fr_FR", LANG: "ko_KR.UTF-8" } })),
      linuxLang: resolveOsLocale(src({ env: { LANG: "ko_KR.UTF-8" } })),
      linuxC: resolveOsLocale(src({ env: { LANG: "C.UTF-8" } })),
      forced: resolveOsLocale(src({ platform: "darwin", appleLanguages: () => APPLE, env: { TIGUCLAW_OS_LOCALE: "en" } })),
      forcedEmpty: resolveOsLocale(src({ env: { TIGUCLAW_OS_LOCALE: "", LANG: "ko_KR.UTF-8" } })),
    };
    return [
      assert(
        "★맥은 시스템 설정(AppleLanguages)을 읽는다 — 셸 LANG=C 여도 · 못 읽으면 LANG · 둘 다 없으면 «없음»(Intl 의 en-US 를 믿지 않는다)",
        r.macApple === "ko-KR" && r.macNoApple === "ja-JP" && r.macNothing === undefined,
        `시스템=${String(r.macApple)} · LANG만=${String(r.macNoApple)} · 없음=${String(r.macNothing)}`,
      ),
      assert(
        "Windows 는 Intl(사용자 로캘)을 읽는다 — LANG 이 없어도",
        r.win === "ko-KR",
        `win=${String(r.win)}`,
      ),
      assert(
        "리눅스는 LC_ALL → LC_MESSAGES → LANG · 인코딩 떼고 _→- · C/POSIX 는 «없음»",
        r.linuxOrder === "de-DE" && r.linuxLang === "ko-KR" && r.linuxC === undefined,
        `순서=${String(r.linuxOrder)} · LANG=${String(r.linuxLang)} · C=${String(r.linuxC)}`,
      ),
      assert(
        "TIGUCLAW_OS_LOCALE 가 있으면 그것(회귀 러너 고정용) · 빈 값은 «없음»",
        r.forced === "en" && r.forcedEmpty === undefined,
        `강제=${String(r.forced)} · 빈값=${String(r.forcedEmpty)}`,
      ),
      assert(
        "파서 — AppleLanguages 첫 항목 · POSIX 수식어(@euro) 제거",
        parseAppleLanguages('(\n    en,\n    "ko-KR"\n)') === "en" && parsePosixLocale("en_US@euro") === "en-US",
        `${String(parseAppleLanguages('(\n    en,\n    "ko-KR"\n)'))} · ${String(parsePosixLocale("en_US@euro"))}`,
      ),
    ];
  },
};
