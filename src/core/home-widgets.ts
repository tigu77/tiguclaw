// src/core/home-widgets.ts
/**
 * **홈 위젯 배치** — 무엇이 · 어떤 순서로 · 얼마나 크게 (2026-08-28, 위젯 플랫폼 §J).
 *
 * ★**좌표를 저장하지 않는다.** 이 파일에 `x`·`y`·픽셀·breakpoint 가 없는 것은 빠뜨린 게
 *  아니라 설계다(§J.1). 로드맵 A3 는 *"레이아웃은 비서가 읽고 쓸 수 있는 데이터여야
 *  한다"* 고 하고 프런트 노트는 *"그리드 좌표·픽셀은 Client-local"* 이라고 하는데,
 *  **비서에겐 브라우저가 없다.** 둘 다 지키는 방법은 비서가 쓰는 것을 좌표가 아니게
 *  만드는 것뿐이다 — 순서 배열 + 크기 등급이면 격자는 CSS 가 푼다.
 *  덤으로 breakpoint 마다 레이아웃이 한 벌씩 생기는 일도 없다.
 *
 * ★**판정이 순수 함수다**(`normalizeHomeWidgets`). 도구 핸들러 안에 두면 검사가 문자열
 *  grep 밖에 못 하고, 그러면 지키는 게 없다
 *  ([[feedback_simple_composable_no_duplication]] — *"검사가 껄끄러우면 코드가 잘못 놓인 것"*).
 *
 * ★**읽기는 홈 레이어만** 본다. 쓰기가 `<home>/settings.json` 으로 가는데 읽기를 레이어
 *  병합으로 하면, 프로젝트 `.tiguclaw/settings.json` 이 값을 가리는 순간 **쓰기가 먹은 것
 *  처럼 보이는데 화면은 안 바뀐다.** 읽는 자리와 쓰는 자리는 같아야 한다.
 */
import { getPaths } from "./paths.js";
import {
  readSettingsRootForWrite,
  readSettingsRootLenient,
  writeSettingsRootAtomic,
} from "./settings-file.js";

/** 크기 등급 — 격자 좌표가 아니라 **의미**다. 실제 열 수는 CSS 가 정한다. */
export type HomeWidgetSize = "small" | "wide";

const SIZES: ReadonlySet<string> = new Set<HomeWidgetSize>(["small", "wide"]);

export interface HomeWidget {
  /** 이 배치 안에서만 유일하면 된다. 화면이 컨테이너를 식별하는 데 쓴다. */
  readonly id: string;
  /** `<plugin>/<widget>` — 이름공간은 폴더가 강제한다(§D.3). */
  readonly type: string;
  readonly size: HomeWidgetSize;
  /** 이 **인스턴스** 몫 설정(도시 등). 플러그인 설정(§D.1)과 자리가 다르다. */
  readonly config: Readonly<Record<string, string | number | boolean>>;
}

export interface HomeWidgetsResolution {
  readonly widgets: HomeWidget[];
  /** 왜 떨어졌는지 — 모델이 고쳐서 다시 부를 수 있어야 한다. */
  readonly rejected: { readonly at: string; readonly reason: string }[];
}

/**
 * 홈에 놓을 수 있는 최대 개수.
 *
 * ★캡을 두는 이유는 화면이 아니라 **poll** 이다 — 위젯 하나가 곧 주기적인 외부 호출
 *  하나다. 무한히 놓을 수 있으면 사용자가(또는 모델이) 자기도 모르게 데몬을 크롤러로
 *  만든다. 값은 잠정이고, 실제로 모자라면 그때 재본다.
 */
export const HOME_WIDGET_MAX = 12;

/** `<plugin>/<widget>` — 소문자·숫자·하이픈. 경로가 되는 값이라 좁게 잡는다. */
const TYPE_RE = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/;

/**
 * **자격증명 낱말** — 키 이름 어디에 있어도 걸린다(부분 문자열).
 *
 * ★규칙이 **하나**다. 종전엔 "어디서나 걸리는 낱말" 과 "낱말로 서 있을 때만 걸리는 낱말"
 *  둘로 나눴는데, 뒤쪽이 `accesskey`·`authkey`·`basicauth`·`authorization` 처럼 **붙여 쓴
 *  소문자·대문자 이름에서 통째로 사라졌다**(쪼갤 경계가 없으면 한 낱말이 된다).
 *  실측 29/29 통과 — 규칙의 절반이 없는 것과 같았다.
 */
const CREDENTIAL_WORDS = [
  "token", "secret", "password", "passwd", "credential", "bearer", "cookie",
  "jwt", "oauth", "signature", "authorization",
];

/**
 * 같은 자격증명 낱말이지만, **무해한 낱말을 덜어낸 뒤에** 본다 — 이것들은 평범한 이름에도
 * 자주 들어간다(`keyword`·`author`·`passenger`).
 */
const CREDENTIAL_WORDS_AFTER_STRIP = [
  "key", "auth", "pass", "cert", "private", "session", "pwd",
];

/**
 * **자격증명 낱말을 품고 있지만 무해한 낱말** — 판정 전에 **지워서** 본다.
 *
 * ★지우고 보는 이유는 합성을 살리기 위해서다. `authorName` 은 `author` 를 지우면 `Name`
 *  만 남아 통과하고, `keywordToken` 은 `keyword` 를 지워도 `Token` 이 남아 걸린다.
 *  이름 전체를 열거하면 `authorName` 이 새 이름일 때마다 목록이 낡는다
 *  ([[feedback_hand_maintained_lists]]).
 */
const INNOCENT_WORDS = [
  "keyword", "monkey", "donkey", "turnkey", "keyboard", "hockey", "whiskey",
  "author", "passenger", "passage", "compass", "certain", "concert",
];

/**
 * 자격증명처럼 **보이는** 키인가 — 거부 판정.
 *
 * ★이건 경계가 아니라 **가드**다. 진짜 경계는 §D.1 이 정한 것(secret 은 `.env`)이고,
 *  여기서 막는 건 흔한 실수 하나다: 모델이 친절하게 `apiKey` 를 위젯 설정에 넣는 것.
 *  이 레코드는 **브라우저로 나가고 백업에 들어간다** — 들어가면 조용히 샌다.
 *
 * ★**종전 정규식은 거의 아무것도 안 막았다** (2026-08-29, 적대 검토 A-F2). 앞에 `(^|[^a-z])`
 *  가 붙어 있어서 낱말이 이름 중간에 오면 통과했다 — `authToken`·`clientSecret`·
 *  `accessKey`·`x-api-key`·`bearer`·`cookie` 가 전부 뚫렸다.
 *
 * ★**첫 수정은 절반만 닫았다**(같은 날 적대 검토). 낱말 경계를 쓰는 갈래를 뒀는데, 경계가
 *  없는 이름(`accesskey`·`AUTHORIZATION`)에선 그 갈래가 통째로 무효였다. 그런데 **표본
 *  21종이 전부 camelCase 라 그 절반을 한 번도 안 밟았다** — 표본이 규칙을 다 밟지 않으면
 *  개수가 많아도 표본이 아니다.
 *
 * ★**틀리는 방향을 골랐다.** 잘못 막으면 위젯이 사유와 함께 떨어져 사용자가 즉시 안다.
 *  잘못 통과시키면 열쇠가 브라우저와 백업으로 **조용히** 나간다. 그래서 넓게 잡고,
 *  흔한 무해 낱말만 위에서 덜어낸다.
 *
 * @param key 설정 키 이름
 */
export const looksLikeCredentialKey = (key: string): boolean => {
  const lower = key.toLowerCase();
  // ★강한 낱말은 **지우기 전에** 본다 — 안 그러면 `author` 를 덜어내다 `authorization`
  //  까지 사라진다(실측으로 그렇게 뚫렸다).
  if (CREDENTIAL_WORDS.some((w) => lower.includes(w))) return true;
  let rest = lower;
  for (const w of INNOCENT_WORDS) rest = rest.split(w).join(" ");
  return CREDENTIAL_WORDS_AFTER_STRIP.some((w) => rest.includes(w));
};

const isScalar = (v: unknown): v is string | number | boolean =>
  typeof v === "string" || typeof v === "number" || typeof v === "boolean";

/**
 * 값 하나를 배치로 해석한다. **모르는 것은 조용히 고치지 않고 떨어뜨린다** —
 * 반쪽으로 살아난 위젯은 "왜 이렇게 떴지" 가 되고, 그건 아무도 못 고친다.
 *
 * @param raw `settings.json` 의 `dashboard.home.widgets` 또는 도구가 받은 배열.
 * @param knownPlugins 지금 **로드된** 플러그인 이름들. 코어는 위젯 id 목록을 모른다
 *   (등록소는 브라우저에 있다) — 그래서 확인할 수 있는 데까지만 확인한다: 플러그인이
 *   실재하는가. 목록을 여기 적어두면 그게 곧 드리프트다([[feedback_hand_maintained_lists]]).
 */
export const normalizeHomeWidgets = (
  raw: unknown,
  knownPlugins: ReadonlySet<string>,
): HomeWidgetsResolution => {
  const widgets: HomeWidget[] = [];
  const rejected: { at: string; reason: string }[] = [];
  if (raw === undefined || raw === null) return { widgets, rejected };
  if (!Array.isArray(raw)) {
    return { widgets, rejected: [{ at: "widgets", reason: "배열이 아닙니다." }] };
  }
  const seen = new Set<string>();
  for (const [i, entry] of raw.entries()) {
    const at = `widgets[${i}]`;
    const drop = (reason: string): void => {
      rejected.push({ at, reason });
    };
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      drop("객체가 아닙니다.");
      continue;
    }
    const e = entry as Record<string, unknown>;
    const type = typeof e.type === "string" ? e.type.trim() : "";
    if (!TYPE_RE.test(type)) {
      drop(`type "${String(e.type)}" 이 <plugin>/<widget> 형식이 아닙니다.`);
      continue;
    }
    const owner = type.slice(0, type.indexOf("/"));
    if (!knownPlugins.has(owner)) {
      drop(
        `플러그인 "${owner}" 이 없거나 꺼져 있습니다 — 켜져 있는 것만 홈에 놓을 수 있습니다.`,
      );
      continue;
    }
    const id = typeof e.id === "string" ? e.id.trim() : "";
    if (id === "" || id.length > 64) {
      drop("id 는 1~64자 문자열이어야 합니다.");
      continue;
    }
    if (seen.has(id)) {
      drop(`id "${id}" 가 중복입니다.`);
      continue;
    }
    const sizeRaw = e.size === undefined ? "small" : e.size;
    if (typeof sizeRaw !== "string" || !SIZES.has(sizeRaw)) {
      drop(`size 는 small 또는 wide 여야 합니다(받은 값: ${String(e.size)}).`);
      continue;
    }
    let config: Record<string, string | number | boolean> = {};
    if (e.config !== undefined && e.config !== null) {
      if (typeof e.config !== "object" || Array.isArray(e.config)) {
        drop("config 는 객체여야 합니다.");
        continue;
      }
      const src = e.config as Record<string, unknown>;
      const keys = Object.keys(src);
      if (keys.length > 16) {
        drop("config 키가 16개를 넘습니다.");
        continue;
      }
      let bad: string | undefined;
      for (const k of keys) {
        const v = src[k];
        if (looksLikeCredentialKey(k)) {
          bad =
            `config.${k} 는 자격증명처럼 보입니다 — 이 값은 브라우저로 나가고 백업에 ` +
            `들어갑니다. 열쇠는 홈 .env 의 TIGUCLAW_PLUGIN_<NAME>_<KEY> 로 두세요.`;
          break;
        }
        if (!isScalar(v)) {
          bad = `config.${k} 는 문자열·숫자·참거짓만 됩니다.`;
          break;
        }
        if (typeof v === "string" && v.length > 200) {
          bad = `config.${k} 가 200자를 넘습니다.`;
          break;
        }
      }
      if (bad !== undefined) {
        drop(bad);
        continue;
      }
      config = src as Record<string, string | number | boolean>;
    }
    if (widgets.length >= HOME_WIDGET_MAX) {
      drop(`홈 위젯은 최대 ${HOME_WIDGET_MAX}개입니다.`);
      continue;
    }
    seen.add(id);
    widgets.push({ id, type, size: sizeRaw as HomeWidgetSize, config });
  }
  return { widgets, rejected };
};

/**
 * `<home>/settings.json` 의 `dashboard.home.widgets` 원값.
 *
 * ★**읽기와 쓰기가 다른 함수를 쓴다**(2026-08-29, 적대 검토). 읽기는 못 읽어도 `{}` 로
 *  물러서지만(화면이 깨진 파일 하나로 죽으면 고칠 수단까지 잃는다), **쓰기는 거부한다** —
 *  그 `{}` 를 파일에 덮으면 모델 프로파일·테마가 함께 사라진다.
 */
const readRaw = (forWrite = false): { root: Record<string, unknown>; widgets: unknown } => {
  const file = getPaths().settings;
  const root = forWrite
    ? readSettingsRootForWrite(file)
    : readSettingsRootLenient(file);
  const dashboard = root.dashboard;
  const home =
    dashboard !== null && typeof dashboard === "object" && !Array.isArray(dashboard)
      ? (dashboard as Record<string, unknown>).home
      : undefined;
  const widgets =
    home !== null && typeof home === "object" && !Array.isArray(home)
      ? (home as Record<string, unknown>).widgets
      : undefined;
  return { root, widgets };
};

/** 지금 배치. 못 읽거나 깨졌으면 **빈 배열**(홈은 위젯 영역을 아예 안 그린다). */
export const readHomeWidgets = (
  knownPlugins: ReadonlySet<string>,
): HomeWidgetsResolution => normalizeHomeWidgets(readRaw().widgets, knownPlugins);

/**
 * 배치를 쓴다 — `setModelReasoning` 과 같은 형(읽고·그 키만 바꾸고·원자 교체).
 *
 * ★빈 배열이면 키를 **지운다.** 남겨두면 "설정한 적 없음" 과 "비워둠" 이 구분 안 되는데,
 *  화면 동작은 어차피 같다(안 그린다). 흔적을 안 남기는 쪽이 파일을 읽는 사람에게 정직하다.
 */
export const writeHomeWidgets = (widgets: readonly HomeWidget[]): void => {
  const file = getPaths().settings;
  // ★깨진 파일이면 **여기서 던진다** — 덮으면 남의 설정이 사라진다(적대 검토 A-F1).
  const { root } = readRaw(true);
  const existingDashboard = root.dashboard;
  const dashboard: Record<string, unknown> =
    existingDashboard !== null &&
    typeof existingDashboard === "object" &&
    !Array.isArray(existingDashboard)
      ? (existingDashboard as Record<string, unknown>)
      : {};
  const existingHome = dashboard.home;
  const home: Record<string, unknown> =
    existingHome !== null && typeof existingHome === "object" && !Array.isArray(existingHome)
      ? (existingHome as Record<string, unknown>)
      : {};
  if (widgets.length === 0) delete home.widgets;
  else home.widgets = widgets;
  if (Object.keys(home).length === 0) delete dashboard.home;
  else dashboard.home = home;
  if (Object.keys(dashboard).length === 0) delete root.dashboard;
  else root.dashboard = dashboard;
  writeSettingsRootAtomic(file, root);
};
