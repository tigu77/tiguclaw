/**
 * 이 기계의 OS 언어 — 설정에 언어가 없을 때 서버 문구의 기본 언어가 된다 (2026-10-06 정태님 «기본 언어는 설치 언어로, 없으면 영어»).
 *
 * ★`LANG`·`Intl` 로 읽으면 **맥에서 틀린다**(실측): 이 맥은 시스템 언어가 `ko-KR` 인데 셸 `LANG=C.UTF-8` 에서 Node `Intl` 은 `en-US`,
 *  데몬(launchd)은 `LANG` 자체가 없어 역시 `en-US` 다. 그래서 OS 마다 정본을 따로 읽는다:
 *   - **macOS**: `defaults read -g AppleLanguages` — 시스템 설정의 언어 목록(첫 항목).
 *   - **Windows**: Node `Intl` — 환경 변수가 아니라 사용자 로캘 API 를 읽는다(집 PC 실측 `ko-KR`, `LANG` 없음).
 *   - **그 밖(Linux 등)**: `LC_ALL` → `LC_MESSAGES` → `LANG` — 거기선 이게 정본이다. `C`·`POSIX` 는 «정해지지 않음».
 * 프로세스당 한 번 읽는다(OS 언어는 기계의 성질이고, 맥은 외부 명령이다).
 *
 * ★`TIGUCLAW_OS_LOCALE` 가 있으면 그 값을 쓴다 — 회귀 러너가 개발 맥(한국어)과 CI(영어)를 같게 만드는 자리다. 빈 값은 «없음».
 */
import { spawnSync } from "node:child_process";

/** `defaults read -g AppleLanguages` 출력(`(\n "ko-KR",\n "en-KR"\n)`)의 첫 언어. */
export const parseAppleLanguages = (out: string): string | undefined => {
  const m = /\(\s*"?([A-Za-z]{2,3}(?:[-_][A-Za-z0-9]+)*)"?/.exec(out);
  return m?.[1];
};

/** POSIX 로캘 문자열(`ko_KR.UTF-8`·`en_US@euro`)의 언어 태그. `C`·`POSIX`·빈 값은 undefined. */
export const parsePosixLocale = (raw: string | undefined): string | undefined => {
  const v = (raw ?? "").split(".")[0]!.split("@")[0]!.trim();
  if (v === "" || v === "C" || v === "POSIX") return undefined;
  return /^[A-Za-z]{2,3}([-_][A-Za-z0-9]+)*$/.test(v) ? v.replace(/_/g, "-") : undefined;
};

export interface OsLocaleSources {
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** macOS 시스템 언어 목록을 읽는다 — 실패하면 undefined. */
  readonly appleLanguages: () => string | undefined;
  /** Node `Intl` 이 아는 기본 로캘. */
  readonly intlLocale: () => string | undefined;
}

/** 출처를 받아 OS 언어를 정한다 — 순수(회귀가 OS 마다 돌려 본다). */
export const resolveOsLocale = (s: OsLocaleSources): string | undefined => {
  const forced = s.env.TIGUCLAW_OS_LOCALE;
  if (forced !== undefined) return forced.trim() === "" ? undefined : forced.trim();
  if (s.platform === "darwin") {
    const out = s.appleLanguages();
    const apple = out === undefined ? undefined : parseAppleLanguages(out);
    if (apple !== undefined) return apple.replace(/_/g, "-");
  }
  const posix = parsePosixLocale(s.env.LC_ALL) ?? parsePosixLocale(s.env.LC_MESSAGES) ?? parsePosixLocale(s.env.LANG);
  if (s.platform === "win32") return s.intlLocale() ?? posix;
  // ★맥에서 `Intl` 로 내려가지 않는다 — 시스템 언어를 못 읽었으면 `Intl` 은 `en-US` 를 지어낸다(위 실측).
  return posix;
};

let cached: { value: string | undefined } | undefined;

/** 이 기계의 OS 언어(예 `ko-KR`) — 못 정하면 undefined. 프로세스당 한 번 읽는다. */
export const osLocale = (): string | undefined => {
  if (cached !== undefined && process.env.TIGUCLAW_OS_LOCALE === undefined) return cached.value;
  const value = resolveOsLocale({
    platform: process.platform,
    env: process.env,
    appleLanguages: () => {
      try {
        const r = spawnSync("defaults", ["read", "-g", "AppleLanguages"], { encoding: "utf8", timeout: 2000 });
        return r.status === 0 ? r.stdout : undefined;
      } catch {
        return undefined;
      }
    },
    intlLocale: () => {
      try {
        return Intl.DateTimeFormat().resolvedOptions().locale;
      } catch {
        return undefined;
      }
    },
  });
  if (process.env.TIGUCLAW_OS_LOCALE === undefined) cached = { value };
  return value;
};
