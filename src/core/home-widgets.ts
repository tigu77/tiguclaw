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
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getPaths } from "./paths.js";

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
 * 자격증명처럼 **보이는** 키 — 거부한다.
 *
 * ★이건 경계가 아니라 **가드**다. 진짜 경계는 §D.1 이 정한 것(secret 은 `.env`)이고,
 *  여기서 막는 건 흔한 실수 하나다: 모델이 친절하게 `apiKey` 를 위젯 설정에 넣는 것.
 *  이 레코드는 **브라우저로 나가고 백업에 들어간다** — 들어가면 조용히 샌다.
 */
const SECRETISH_RE = /(^|[^a-z])(api_?key|token|secret|password|passwd|credential)/i;

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
        if (SECRETISH_RE.test(k)) {
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

/** `<home>/settings.json` 의 `dashboard.home.widgets` 원값. 없으면 undefined. */
const readRaw = (): { root: Record<string, unknown>; widgets: unknown } => {
  const file = getPaths().settings;
  let root: Record<string, unknown> = {};
  try {
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        root = parsed as Record<string, unknown>;
      }
    }
  } catch {
    // 파싱 실패 → 배치 없음으로 본다. 여기서 파일을 고치지 않는다(다른 키를 날린다).
  }
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
  const { root } = readRaw();
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
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(root, null, 2) + "\n", "utf8");
  renameSync(tmp, file);
};
