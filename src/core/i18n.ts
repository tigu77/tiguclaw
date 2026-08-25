/**
 * 화면 언어 — **카탈로그는 데이터, 언어 추가는 파일 하나** (2026-08-25 사용자 요청).
 *
 * 요구 셋:
 *  ① 언어를 **바꿀 수 있어야** 한다 → `settings.json` 의 `locale`
 *  ② 언어를 **쉽게 추가**할 수 있어야 한다 → `<home>/locales/<lang>.json` 을 놓으면 끝.
 *     **코드 변경 0.** 스킬·에이전트가 홈 폴더 파일로 늘어나는 것과 같은 방식이다
 *     ([[project_core_philosophy]]: 코어는 단순 불변, 능력은 데이터).
 *  ③ **LLM 이 만드는 말은 제외**하고 시스템이 보여주는 것은 전부 — 대시보드 UI 뿐 아니라
 *     서버가 만들어 텔레그램으로도 나가는 통지까지. 화면만 번역하면 알림은 한국어로 남아
 *     **반쪽이 더 어색하다**(실측: UI 690 · 서버 문장 744).
 *
 * ★설계에서 가장 중요한 것은 **빠진 키가 화면을 깨뜨리지 않는 것**이다. 사용자가 반쯤
 *  번역한 파일을 넣어도 나머지는 기본 언어로 나와야 한다 — 그래야 "일단 조금 번역해 보는"
 *  것이 가능하고, 그게 ②의 전제다. 폴백은 **사용자 언어 → 기본 언어 → 키 자체** 다.
 *  절대로 빈 문자열을 내지 않는다(빈 버튼은 없는 버튼이다).
 *
 * ★번역 문자열에 **로직을 넣지 않는다.** 복수형·조사 같은 것은 카탈로그가 아니라 호출부가
 *  이미 정한 문장 단위로 넘긴다 — 여기서 문법 엔진을 만들기 시작하면 그 자체가 새 시스템이다.
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { appRoot, getPaths } from "./paths.js";
import { loadSettingsLayers } from "./settings.js";

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

/** `settings.json` 의 `locale`. 없거나 설치 안 된 언어면 기본. */
export const readLocale = (cwd: string = process.cwd()): string => {
  let picked = BASE_LOCALE;
  for (const layer of loadSettingsLayers(cwd)) {
    const v = (layer as { locale?: unknown }).locale;
    if (typeof v === "string" && v.trim() !== "") picked = v.trim();
  }
  return availableLocales().includes(picked) ? picked : BASE_LOCALE;
};

const cache = new Map<string, { stamp: string; catalog: Catalog }>();

/** 카탈로그 파일들의 수정 시각 — 이게 바뀌면 캐시를 버린다. */
const stampOf = (files: string[]): string =>
  files
    .map((f) => {
      try {
        return `${f}:${statSync(f).mtimeMs}`;
      } catch {
        return `${f}:-`;
      }
    })
    .join("|");

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
export const loadCatalog = (locale: string): Catalog => {
  const files = catalogDirs().map((d) => path.join(d, `${locale}.json`));
  const stamp = stampOf(files);
  const hit = cache.get(locale);
  if (hit !== undefined && hit.stamp === stamp) return hit.catalog;
  const merged: Record<string, string> = {};
  for (const f of files) {
    if (existsSync(f)) Object.assign(merged, readJson(f));
  }
  cache.set(locale, { stamp, catalog: merged });
  return merged;
};

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
 * 키 → 문장. **폴백: 사용자 언어 → 기본 언어 → 키 자체.**
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
  const found = loadCatalog(lang)[key] ?? (lang === BASE_LOCALE ? undefined : loadCatalog(BASE_LOCALE)[key]);
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
  const strings = { ...loadCatalog(BASE_LOCALE), ...loadCatalog(lang) };
  return { locale: lang, strings, available: availableLocales() };
};
