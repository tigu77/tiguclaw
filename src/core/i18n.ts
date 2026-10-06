/**
 * 화면 언어 — **카탈로그는 데이터, 언어 추가는 파일 하나** (2026-08-25 사용자 요청).
 *
 * 요구 셋:
 *  ① 언어를 **바꿀 수 있어야** 한다 → `settings.json` 의 `locale`
 *  ② 언어를 **쉽게 추가**할 수 있어야 한다 → `<home>/locales/<lang>.json` 을 놓으면 끝.
 *     **코드 변경 0.** 스킬·에이전트가 홈 폴더 파일로 늘어나는 것과 같은 방식이다
 *     ([[project_core_philosophy]]: 코어는 단순 불변, 능력은 데이터).
 *  ③ **LLM 이 만드는 말은 제외**하고 **화면**이 보여주는 것은 전부.
 *  ★2026-10-06 개정: **서버 문구(채팅 알림·명령 응답)도 이 카탈로그로 간다**(`srv.` 키 — 정태님 «키 형태로, 덮어쓸 수 있게,
 *   기본 언어는 설치 언어·없으면 영어»). 아래 «범위를 좁혔다» 는 그 이전 판단의 기록이다.
 *
 * ★③의 범위를 좁혔다 (2026-08-25 사용자 결정: *"그냥 서버에서 내려오는건 그냥 쓰고 번역
 *  안해도돼"*). 종전엔 이 자리에 *"서버가 텔레그램으로 내보내는 통지까지 — 안 하면 반쪽이
 *  더 어색하다(서버 문장 744)"* 라고 적혀 있었는데, **그 근거가 틀렸다.**
 *   - 744 는 파일 안의 한국어 리터럴 총량이지 **사용자에게 원문으로 나가는 양이 아니다.**
 *   - 통지의 **정상 경로는 LLM 이 다시 쓴다** — 매니저 완료는 메인에 재주입돼 비서가 자기
 *     말로 전하고(`worker-jobs.ts` 의 재주입 훅), 스케줄은 virtual prompt 의 답이다.
 *     원문 그대로 나가는 raw 통지는 **메인 핸들러조차 없을 때의 안전망**이다.
 *   - 즉 사용자가 보는 알림은 이미 사용자 언어다. 번역할 것이 애초에 거기 없었다.
 *  ★그래서 `translate()` 의 생산 호출부가 0인 것은 **결함이 아니라 범위**다. 카탈로그
 *   조회·폴백의 정의점으로 남기고, 회귀가 그 규칙을 지킨다.
 *  ★남는 것(백로그, 착수 조건 = 다른 언어 사용자가 실제로 생길 때): `tiguclaw onboard`
 *   같은 **CLI 첫 화면 23개**. 설치 직후엔 대시보드가 없어서 거기가 첫인상이다.
 *
 * ★설계에서 가장 중요한 것은 **빠진 키가 화면을 깨뜨리지 않는 것**이다. 사용자가 반쯤
 *  번역한 파일을 넣어도 나머지는 기본 언어로 나와야 한다 — 그래야 "일단 조금 번역해 보는"
 *  것이 가능하고, 그게 ②의 전제다. 폴백은 **사용자 언어 → 기본 언어 → 키 자체** 다.
 *  절대로 빈 문자열을 내지 않는다(빈 버튼은 없는 버튼이다).
 *
 * ★번역 문자열에 **로직을 넣지 않는다.** 복수형·조사 같은 것은 카탈로그가 아니라 호출부가
 *  이미 정한 문장 단위로 넘긴다 — 여기서 문법 엔진을 만들기 시작하면 그 자체가 새 시스템이다.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { appRoot, getPaths } from "./paths.js";
import { loadSettingsLayers } from "./settings.js";
import { osLocale } from "./os-locale.js";

/** 기본 언어 — 배포본이 항상 들고 있는 카탈로그. 폴백의 바닥이다. */
export const BASE_LOCALE = "ko";

/** `{name}` 자리표시자. 값이 끼어드는 문장은 이 형태로만 쓴다(실측 39곳). */
const PLACEHOLDER = /\{(\w+)\}/g;

export type Catalog = Readonly<Record<string, string>>;

const readJson = (file: string): Record<string, string> => {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v; // 문자열만 — 중첩 객체는 안 받는다(키는 평면).
    }
    return out;
  } catch {
    return {}; // 없거나 깨졌으면 없는 것으로 — 언어 파일 하나가 데몬을 죽이면 안 된다.
  }
};

/** 카탈로그가 사는 두 곳. 홈이 배포본을 **덮는다**(사용자가 문구를 고칠 수 있게). */
const catalogDirs = (): string[] => [path.join(appRoot(), "locales"), path.join(getPaths().home, "locales")];

/**
 * 설치된 언어 목록 — 배포본 + 사용자 홈. **파일이 곧 목록**이라 손으로 관리하는 목록이 없다
 * ([[feedback_hand_maintained_lists]]).
 */
export const availableLocales = (): string[] => {
  const out = new Set<string>([BASE_LOCALE]);
  for (const dir of catalogDirs()) {
    try {
      for (const f of readdirSync(dir)) {
        if (f.endsWith(".json")) out.add(f.slice(0, -5));
      }
    } catch {
      /* 폴더 없음 = 없는 것 */
    }
  }
  return [...out].sort();
};

/** 사용자가 `settings.json` 에 정한 언어. 없거나 설치 안 된 언어면 undefined. */
export const configuredLocale = (cwd: string = process.cwd()): string | undefined => {
  let picked: string | undefined;
  for (const layer of loadSettingsLayers(cwd)) {
    const v = (layer as { locale?: unknown }).locale;
    if (typeof v === "string" && v.trim() !== "") picked = v.trim();
  }
  return picked !== undefined && availableLocales().includes(picked) ? picked : undefined;
};

/**
 * 브라우저가 원하는 언어(`Accept-Language`) 중 **설치된** 첫 언어 — q 값 순. 맞는 게 없으면 undefined.
 * `ko-KR` 은 `ko-kr` 파일이 있으면 그것, 없으면 `ko`. 언어 목록은 파일이 정한다(코드에 언어 이름 없음).
 */
export const localeFromAcceptLanguage = (
  header: string | undefined,
  available: readonly string[] = availableLocales(),
): string | undefined => {
  if (header === undefined) return undefined;
  const have = new Map(available.map((l) => [l.toLowerCase(), l]));
  const wants = header
    .split(",")
    .map((part, i) => {
      const [tag = "", ...params] = part.trim().split(";");
      const q = params.map((x) => /^\s*q=([0-9.]+)\s*$/.exec(x)?.[1]).find((x) => x !== undefined);
      return { tag: tag.trim().toLowerCase(), q: q === undefined ? 1 : Number(q), i };
    })
    .filter((w) => w.tag !== "" && w.tag !== "*" && w.q > 0)
    .sort((a, b) => b.q - a.q || a.i - b.i);
  for (const w of wants) {
    const hit = have.get(w.tag) ?? have.get(w.tag.split("-")[0]!);
    if (hit !== undefined) return hit;
  }
  return undefined;
};

/**
 * 서버가 만드는 문구(채팅 알림·명령 응답·CLI)의 키 접두사 (2026-10-06). 화면 문구와 같은 카탈로그·같은 덮어쓰기(`<홈>/locales/<언어>.json`)를
 * 쓰되, 브라우저로는 내려보내지 않는다(`catalogForClient`).
 */
export const SERVER_KEY_PREFIX = "srv.";

/** 아무것도 못 정했을 때의 언어 — **영어**. 공개 첫 화면(README)과 설치 안내가 영어라서다. */
export const FALLBACK_LOCALE = "en";

/**
 * 설정이 없을 때의 기본 언어 — **이 기계의 OS 언어**(설치된 카탈로그 중), 없으면 영어 (2026-10-06 정태님 «기본 언어는 설치 언어, 없으면 영어»).
 * ★설치 때 `settings.json` 에 적지 않고 매번 읽는다 — 이미 설치된 인스턴스도 같이 따라오고, 판정이 셸 두 벌과 갈리지 않으며,
 *  «사용자가 정한 값» 과 섞이지 않는다. 기본 언어(`BASE_LOCALE`)는 카탈로그 폴백의 바닥이고 이것과 다른 판단이다.
 */
export const machineLocale = (available: readonly string[] = availableLocales()): string =>
  localeFromAcceptLanguage(osLocale(), available) ??
  (available.includes(FALLBACK_LOCALE) ? FALLBACK_LOCALE : BASE_LOCALE);

/**
 * 화면·문구 언어 — **사용자가 정한 값이 이긴다.** 없으면 보는 사람의 브라우저 언어(대시보드), 그다음 이 기계의 OS 언어, 끝으로 영어.
 * ★처음 설치하면 `locale` 이 없다 — 종전엔 그때 누구나 한국어였다(영어권 사용자는 영어 알림 + 한국어 화면).
 * ★고른 값을 `settings.json` 에 **쓰지 않는다** — 쓰면 추측이 사용자 결정처럼 굳는다. 바꾸는 길은 설정 화면 하나다.
 * ★보는 사람이 없으면(헤더 없음 — 텔레그램 알림·스케줄·명령 응답) OS 언어부터 본다.
 */
export const localeForViewer = (acceptLanguage: string | undefined, cwd: string = process.cwd()): string => {
  const set = configuredLocale(cwd);
  if (set !== undefined) return set;
  const available = availableLocales();
  const fromBrowser =
    acceptLanguage === undefined || acceptLanguage.trim() === ""
      ? undefined
      : localeFromAcceptLanguage(acceptLanguage, available);
  return fromBrowser ?? machineLocale(available);
};

/** 지금 처리 중인 요청을 보낸 브라우저의 `Accept-Language` — 브리지가 요청마다 건다(`withViewerLanguage`). */
const viewer = new AsyncLocalStorage<string>();

/**
 * 이 요청을 보낸 브라우저의 언어 안에서 `fn` 을 돈다 — 그 안의 `readLocale()` 이 보는 사람 기준이 된다.
 * ★대시보드 화면만 브라우저를 따르면, 같은 화면에 뜨는 **플러그인 문구**(구독 인증 버튼 — 처음 설치하면 가장 먼저 누르는 것)는
 *  데몬 쪽 `host.locale` 이라 한국어로 남는다. 요청에 언어를 실어 그 자리도 같은 판정을 따르게 한다.
 */
export const withViewerLanguage = <T>(acceptLanguage: string | string[] | undefined, fn: () => T): T =>
  typeof acceptLanguage === "string" && acceptLanguage.trim() !== "" ? viewer.run(acceptLanguage, fn) : fn();

/** 지금 쓸 언어 — 설정 → (요청 중이면) 보는 사람의 브라우저 → OS 언어 → 영어. */
export const readLocale = (cwd: string = process.cwd()): string => localeForViewer(viewer.getStore(), cwd);

/** 카탈로그 파일의 수정 시각 — 이게 바뀌면 캐시를 버린다. */
const stampOf = (f: string): string => {
  try {
    return String(statSync(f).mtimeMs);
  } catch {
    return "-";
  }
};

/**
 * 카탈로그 읽개 — 배포본(`appDir`)과 사용자 홈(`homeDir`)의 `<언어>.json` 을 합친다(홈이 덮는다).
 *
 * ★**배포본은 처음 읽을 때 고정한다** (2026-10-07 적대 검토 P2). 업데이트는 파일을 바꾼 뒤 재시작하는데, 그 사이(위임 업데이트·재시작
 *  알림·5초 창)에 **옛 코드가 새 카탈로그**를 읽으면 키 이름을 바꾼 문구는 키 그대로(`srv.update.applied`), 자리표시자를 바꾼 문구는
 *  `{sec}` 그대로 나간다. 배포본 문구는 코드와 한 몸이라 코드와 같은 수명을 갖는다(바뀌면 재시작 — 설정 반영 경계의 «코드» 쪽).
 * ★홈 덮어쓰기는 **수정 시각으로** 매번 확인한다 — 사용자가 고친 문구는 재시작 없이 다음 문장부터(데이터는 fresh).
 */
export const createCatalogLoader = (dirs: () => { appDir: string; homeDir: string }): ((locale: string) => Catalog) => {
  const app = new Map<string, Record<string, string>>();
  const cache = new Map<string, { stamp: string; catalog: Catalog }>();
  return (locale) => {
    const { appDir, homeDir } = dirs();
    const appFile = path.join(appDir, `${locale}.json`);
    let base = app.get(appFile);
    if (base === undefined) {
      base = existsSync(appFile) ? readJson(appFile) : {};
      app.set(appFile, base);
    }
    const homeFile = path.join(homeDir, `${locale}.json`);
    const stamp = `${appFile}|${homeFile}:${stampOf(homeFile)}`;
    const hit = cache.get(locale);
    if (hit !== undefined && hit.stamp === stamp) return hit.catalog;
    const merged: Record<string, string> = { ...base, ...(existsSync(homeFile) ? readJson(homeFile) : {}) };
    cache.set(locale, { stamp, catalog: merged });
    return merged;
  };
};

/**
 * 한 언어의 카탈로그(배포본 위에 홈을 덮은 것).
 *
 * ★캐시는 **파일 수정 시각으로 무효화**한다. 명시적 `clearCatalogCache()` 를 두면 부르는
 *  곳을 손으로 관리해야 하고, 한 곳만 빠져도 "고쳤는데 그대로" 가 된다
 *  ([[feedback_hand_maintained_lists]]). 그리고 이 레포의 설정 규약이 **데이터는 매 턴
 *  fresh** 다([[reference_config_reload_boundary]]) — 언어 파일도 데이터다.
 *  ★첫 판엔 `clearCatalogCache()` 를 만들어 `setLocale` 에서 불렀는데, 변이 테스트가
 *   그걸 지워도 초록이었다. 재보니 **언어 전환 땐 애초에 필요 없었다**(새 언어는 캐시에
 *   없다). 정말 필요한 건 **파일 편집** 때고, 그건 시각으로 잡는 게 맞다.
 */
export const loadCatalog = createCatalogLoader(() => ({
  appDir: path.join(appRoot(), "locales"),
  homeDir: path.join(getPaths().home, "locales"),
}));

/**
 * 자리표시자를 채운다. **없는 값은 자리표시자를 그대로 둔다** — 지우면 문장이 조용히
 * 이상해지고(“약  뒤”), 남겨두면 무엇이 빠졌는지 화면에서 보인다.
 */
export const interpolate = (
  template: string,
  params?: Readonly<Record<string, string | number>>,
): string =>
  params === undefined
    ? template
    : template.replace(PLACEHOLDER, (whole, name: string) => {
        const v = params[name];
        return v === undefined ? whole : String(v);
      });

/**
 * 키 → 문장. **폴백: 사용자 언어 → 영어 → 기본 언어 → 키 자체.**
 *
 * ★키 자체를 마지막에 두는 이유: 빈 문자열이면 버튼이 사라져 **화면이 깨진다.** 키가 보이면
 *  못생겼을 뿐 동작은 살아 있고, 무엇이 빠졌는지도 바로 보인다.
 */
export const translate = (
  key: string,
  params?: Readonly<Record<string, string | number>>,
  locale?: string,
): string => {
  const lang = locale ?? readLocale();
  // ★**빈 문자열도 「없음」이다** (2026-08-26). `??` 는 *키 부재*만 보므로 반쯤 번역한
  //  파일에 `"chat.send": ""` 이 있으면 그 빈 값이 기본 언어를 **이겨서** 빈 버튼이 된다 —
  //  화면은 멀쩡히 뜨고 에러도 안 난다. 이 기능(언어를 파일 하나로 늘린다)의 핵심 실패
  //  모드가 정확히 그것이라 헤더가 이미 그렇게 적어놨는데, 조회가 그걸 안 봤다.
  const pick = (v: string | undefined): string | undefined =>
    v !== undefined && v !== "" ? v : undefined;
  // 폴백 순서: 그 언어 → 영어(서버 문구의 원본 언어) → 기본 언어 → 키. 반쯤 번역한 파일의 빈 자리가 한국어로 새지 않게 영어를 먼저 본다.
  const found =
    pick(loadCatalog(lang)[key]) ??
    (lang === FALLBACK_LOCALE ? undefined : pick(loadCatalog(FALLBACK_LOCALE)[key])) ??
    (lang === BASE_LOCALE ? undefined : pick(loadCatalog(BASE_LOCALE)[key]));
  return interpolate(found ?? key, params);
};

/**
 * 대시보드로 통째로 내려보낼 카탈로그(기본 언어 위에 선택 언어를 덮은 것).
 *
 * ★`available` 을 **같이** 싣는다 — 설정 화면의 언어 선택이 그걸 읽는다. 목록 조회
 *  엔드포인트를 따로 만들면 "무슨 언어가 있나" 의 정본이 둘이 되고, 화면은 이미 이 값을
 *  받고 있다([[feedback_hand_maintained_lists]]: 파일이 곧 목록).
 */
export const catalogForClient = (
  locale?: string,
): { locale: string; strings: Catalog; available: string[] } => {
  const lang = locale ?? readLocale();
  // ★빈 값이 기본 언어를 **덮지 못하게** 한다 — 얕은 스프레드는 `""` 도 값으로 쳐서
  //  덮는다(위 `translate` 와 같은 이유). 화면은 이 병합 결과만 받으므로 여기서 막아야
  //  브라우저 쪽이 다시 판단할 필요가 없다(가장자리는 판단하지 않는다).
  // ★폴백 순서는 `translate` 와 같다 — 그 언어 → 영어 → 기본 언어(2026-10-07 적대 검토 P3: 서버는 영어, 화면은 한국어로 갈렸다).
  //  아래 층부터 깔고 위 층이 덮는다.
  // ★중복은 **뒤쪽을 남긴다** — 앞쪽을 남기면 `lang === "ko"` 일 때 `[ko, en]` 이 되어 영어가 한국어를 덮었다(2026-10-07 돌쇠
  //  실사고: 한국어로 설정했는데 대시보드가 영어). 맨 위는 언제나 그 언어다.
  const layers = [BASE_LOCALE, FALLBACK_LOCALE, lang].filter((l, i, a) => a.lastIndexOf(l) === i);
  // ★서버 문구(`srv.`)는 화면에 안 싣는다 — 서버가 문장으로 만들어 보내므로 브라우저가 쓸 일이 없고, 수백 개가 매 페이지에 실린다.
  const strings: Record<string, string> = {};
  for (const l of layers) {
    for (const [k, v] of Object.entries(loadCatalog(l))) {
      if (typeof v === "string" && v !== "" && !k.startsWith(SERVER_KEY_PREFIX)) strings[k] = v;
    }
  }
  return { locale: lang, strings, available: availableLocales() };
};
