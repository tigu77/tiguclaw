/**
 * 통합 플러그인 로더 — 한 plugin = 한 인스턴스, 다중 capability 등록 (contract §3 보강 D-(ii)).
 *
 * 기존 channels.ts / observers.ts 두 로더가 같은 plugin 을 두 번 인스턴스화하던 위험 제거.
 * `<rootDir>/<plugin-dir>/package.json` 의 `tiguclaw` 마커 하나에서:
 *  - `kind` 가 string 또는 string[] (자동 정규화) — schemaVersion 1 무 변경.
 *  - dynamic import + `new Default()` 한 번 → capabilities 별로 호출자 분기.
 *
 * 격리 try/catch — manifest parse / import / 인스턴스화 throw 가 다음 plugin 막지 않음.
 *   eventBus 인자 있으면 `plugin.error` publish, 없으면 console.error 만.
 *
 * 본 로더는 *인스턴스화만* — `start*()` 호출은 호출자 (src/index.ts) 가 capability 별로 분기.
 *  - hybrid plugin (channel + observer) 의 경우 `startChannel(handler)` + `startObserver(bus)`
 *    명시 method 우선, 없으면 단일 `start(arg)` fallback (단일 capability plugin 호환).
 */
import { promises as fs, existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { EventBus } from "../eventbus.js";
import { describeNeeds, readNeeds, type PluginNeeds } from "./host.js";
import { readSettingsSpec, type PluginSettingSpec } from "./settings.js";
import { isModuleActive } from "./inventory.js";

// D1-c (2026-07-14, ADR built-artifact-production-runtime) — built(순수 node) 런타임에서
//  컴파일되지 않은 `.ts` drop-in 플러그인을 로드하기 위한 tsx 온디맨드 로더 등록.
//  source(tsx 상주) 모드에선 이 모듈이 `.ts` 로 실행되므로 RUNNING_COMPILED=false →
//  아무것도 안 함(현행 동작 완전 불변). built 모드에선 이 모듈이 `.js` 로 실행 →
//  `.ts` 엔트리를 만났을 때만 tsx/esm 훅을 1회 등록(멱등). tsx 는 이미 runtime dep.
const RUNNING_COMPILED = import.meta.url.endsWith(".js");
let tsxRegistered = false;
const ensureTsxLoader = async (): Promise<void> => {
  if (!RUNNING_COMPILED || tsxRegistered) return;
  const { register } = (await import("tsx/esm/api")) as { register: () => unknown };
  register();
  tsxRegistered = true;
};

/**
 * manifest.entry(예: `./src/index.ts`) → import 가능한 절대 URL 로 해석.
 *  - source 모드: `.ts` 원본이 실재 → 그대로(tsx 가 처리). 동작 불변.
 *  - built 1st-party: `.ts` 부재 + `.js` 형제 존재(D1-b) → 컴파일된 `.js` 로드.
 *  - built drop-in `.ts`(사용자/프로젝트, `.js` 없음): tsx 온디맨드 등록 후 `.ts` 로드(D1-c).
 */
export const resolveEntry = async (pluginDir: string, entry: string): Promise<string> => {
  const entryAbs = path.resolve(pluginDir, entry);
  if (entryAbs.endsWith(".ts")) {
    const jsSibling = `${entryAbs.slice(0, -3)}.js`;
    if (!existsSync(entryAbs) && existsSync(jsSibling)) {
      // built 1st-party — 컴파일 산출물 우선(핫경로·무-tsx).
      return jsSibling;
    }
    if (existsSync(entryAbs)) {
      // `.ts` 실재 — source 모드는 tsx 상주라 no-op, built 모드는 여기서 tsx 등록.
      await ensureTsxLoader();
    }
  }
  return entryAbs;
};

/**
 * 목록·설치 화면이 보여줄 것. 전부 **npm 표준 필드**에서 온다 — 새 키를 만들지 않는다.
 *
 * ★`description` 은 **문자열이거나 언어별 객체**다: 모양으로 갈린다(`DisplayText` 규약과
 *  같은 결). 서버가 언어를 고르지 않고 **화면이** 고른다.
 * ★**`author` 가 가장 중요하다.** 격리가 0이라(설계 §H) 설치는 곧 신뢰 결정이고,
 *  *"누가 만들었나"* 가 그 자리에서 유일한 판단 재료다.
 */
export interface PluginMeta {
  readonly description?: string | Record<string, string>;
  readonly author?: string;
  readonly homepage?: string;
  readonly license?: string;
}

/**
 * 플러그인 이름으로 쓸 수 있나 — **순수 판정**(회귀가 직접 부른다).
 *
 * ★이 이름은 세 곳에서 **좌표와 경로**가 된다: `pluginThreadKey(name, scope)` =
 *  `<name>:<scope>` · `dataDir`·`settingsFile` = `<home>/plugins/<name>/…`. 종전엔
 *  `typeof === "string"` 뿐이라 `name:"../../.ssh"` 가 `~/.ssh` 로 나갔다(실측).
 *
 * 소문자·숫자·하이픈만 — 경로 문자(`/`·`.`·`\\`)와 콜론이 **원천적으로 못 들어온다.**
 *
 * ★**예약어 목록은 두지 않는다.** 처음엔 `dashboard`·`telegram`·`cli` 를 막으려 했는데,
 *  그게 **번들 플러그인의 실제 이름**이라 전부 로드에 실패했다(실측으로 즉시 잡혔다).
 *  좌표 충돌은 이름을 단속해서가 아니라 **좌표를 만들 때** 막는 게 맞다 —
 *  `pluginThreadKey` 가 접두사를 붙인다.
 */
export const isValidPluginName = (name: string): boolean =>
  /^[a-z0-9][a-z0-9-]{0,63}$/.test(name);

export interface PluginManifest {
  schemaVersion: number;
  /** 이 플러그인이 요구하는 것 — 검사·정규화를 거친 값(`readNeeds`). */
  needs?: PluginNeeds;
  /**
   * 이 플러그인이 사람에게 물어보는 것 — 검사·정규화를 거친 값(`readSettingsSpec`).
   * ★화면은 **이 선언에서** 행을 만든다. 손으로 행을 짓지 않는다(§D.2).
   */
  settings?: PluginSettingSpec[];
  /** 플러그인 자기 버전(`package.json` 의 `version`). 없으면 undefined. */
  version?: string;
  /**
   * **사람이 알아야 할 것** — 전부 `package.json` 의 **npm 표준 필드**에서 읽는다
   * (2026-08-28 정태님: *"많이 사용하는 플러그인들 방식"*).
   *
   * ★새 키를 만들지 않는다. `description`·`author`·`homepage`·`license` 는 이미 표준이고
   *  자리가 있었다 — 우리가 안 읽고 있었을 뿐이다.
   * ★**`author` 가 가장 중요하다.** 격리가 0이라(설계 §H) 설치는 곧 신뢰 결정이고,
   *  *"누가 만들었나"* 가 그 자리에서 유일한 판단 재료다.
   */
  meta?: PluginMeta;
  /** V1: string 단일 OR V2: string[] 배열. 로더 정규화 후 capabilities 보존. */
  kind: string | string[];
  name: string;
  /** plugin 디렉토리 기준 상대 경로. default export = class. */
  entry: string;
  /**
   * ★제품의 일부인가 = **끄기 대상이 아닌가**(2026-08-26).
   *
   * 로더는 이 값으로 **아무 행동도 바꾸지 않는다** — 읽는 곳은 인벤토리와 토글 경로다.
   * ★**번들에서만 유효**하다: 유효성은 선언이 아니라 **위치**로 판정한다(레포 `plugins/`).
   *  자기가 자기를 "핵심" 이라 선언하면 검증할 방법이 없기 때문이다 — 설치된 플러그인이
   *  적어도 코어가 되지 않는다.
   */
  core?: boolean;
}

export interface LoadedPlugin {
  manifest: PluginManifest;
  /** 절대 경로. */
  pluginDir: string;
  /** 정규화 — manifest.kind 가 string 이면 [kind], array 면 그대로. */
  capabilities: string[];
  /** 인스턴스화 완료. Channel | Observer | hybrid (덕 타이핑). */
  instance: unknown;
}

/**
 * 로더가 아는 capability.
 *
 * ★`provider` 는 **로더가 start 훅을 부르지 않는** 값인데도 여기 있다(2026-08-26). 종전엔
 *  빠져 있었고, 그래서 `kind` 한 필드를 **두 소비자가 서로 다른 사전으로** 읽었다 —
 *  로더는 넷을 알고 `core/plugins/providers.ts` 만 `provider` 를 안다(모듈 카드용).
 *  결과: `kind:["provider"]` 만 적은 플러그인은 **카드는 뜨는데 로더엔 안 뜨는** 반쪽
 *  상태가 된다(아래 `hasKnown` 이 skip 하므로). 사전을 하나로 합쳐서 그 구멍을 막는다.
 *  ★소비자가 둘인 건 괜찮다. 아는 값 목록이 둘인 게 사고다.
 */
/**
 * 이 tiguclaw 가 아는 **플러그인 계약 버전**.
 *
 * ★올리는 규칙: 호스트 표면(`host.ts` 의 `PluginHost`)이나 매니페스트 모양을 **깨는 방식**
 *  으로 바꿀 때만 올린다. 필드를 *더하는* 건 안 올린다(옛 플러그인이 그대로 돈다).
 * ★올리면 옛 플러그인은 **사유와 함께 멈춘다** — 조용히 반쯤 도는 것보다 낫다.
 */
export const PLUGIN_SCHEMA_VERSION = 1;

/** npm 표준 필드에서 사람이 볼 것을 뽑는다. 없으면 없는 대로(빈 객체). */
export const readPluginMeta = (pkg: Record<string, unknown>): PluginMeta => {
  const m: {
    description?: string | Record<string, string>;
    author?: string;
    homepage?: string;
    license?: string;
  } = {};
  const d = pkg.description;
  if (typeof d === "string" && d.trim() !== "") m.description = d.trim();
  else if (d !== null && typeof d === "object" && !Array.isArray(d)) {
    const byLang: Record<string, string> = {};
    for (const [k, v] of Object.entries(d as Record<string, unknown>)) {
      if (typeof v === "string" && v.trim() !== "") byLang[k] = v.trim();
    }
    if (Object.keys(byLang).length > 0) m.description = byLang;
  }
  // ★`author` 는 npm 이 문자열도 객체(`{name,email,url}`)도 허용한다 — 둘 다 받는다.
  const a = pkg.author;
  if (typeof a === "string" && a.trim() !== "") m.author = a.trim();
  else if (a !== null && typeof a === "object" && typeof (a as { name?: unknown }).name === "string") {
    m.author = String((a as { name: string }).name).trim();
  }
  // `homepage` 가 없으면 `repository.url`(또는 문자열)로 대신한다 — 같은 질문에 답한다.
  const h = pkg.homepage;
  if (typeof h === "string" && /^https?:\/\//.test(h.trim())) m.homepage = h.trim();
  else {
    const r = pkg.repository;
    const url =
      typeof r === "string" ? r : r !== null && typeof r === "object" ? (r as { url?: unknown }).url : undefined;
    if (typeof url === "string") {
      const clean = url.replace(/^git\+/, "").replace(/\.git$/, "");
      if (/^https?:\/\//.test(clean)) m.homepage = clean;
    }
  }
  if (typeof pkg.license === "string" && pkg.license.trim() !== "") m.license = pkg.license.trim();
  return m;
};


/**
 * 아는 capability — 여기 없는 `kind` 는 거부한다.
 *
 * ★export 인 이유: 회귀가 **문서와 양방향 대조**한다(2026-09-01). `needs` 키엔 그 그물이
 *  있었는데 `kind` 엔 없어서, 로더가 받는 `provider` 가 가이드에 **한 줄도 없는** 채로
 *  살아 있었다 — 받아주면서 설명이 0이면 «LLM provider 를 붙이는 자리» 로 읽힌다.
 */
export const KNOWN_CAPABILITIES = new Set([
  "channel",
  "observer",
  "trigger",
  "service",
  "provider",
]);

const publishError = (
  eventBus: EventBus | undefined,
  pluginName: string,
  phase: "load" | "start" | "runtime",
  err: unknown,
): void => {
  const reason = err instanceof Error ? err.message : String(err);
  // ★**항상 로그에 남긴다** (2026-08-28). 종전엔 버스가 있으면 이벤트만 발행하고 **콘솔엔
  //  아무것도 안 찍었다** — 그래서 `weather` 플러그인이 로드에 실패해 도구가 통째로 없는데,
  //  데몬 로그엔 한 줄도 없었고 흔적은 DB `events` 행 하나뿐이었다. 그걸 보려면 이미
  //  "플러그인이 안 뜬다" 를 의심하고 SQL 을 쳐야 한다 — 진단이 거꾸로다.
  //  ★이 레포 규범: **로그가 1차 진단면**이다([[feedback_logs_must_stand_alone]]) —
  //   회사 PC·윈도우처럼 원격이 안 되는 기계에선 로그가 유일한 창이다.
  //  ★버스 발행은 대시보드를 위한 것이고 로그는 진단을 위한 것이라, **둘 다** 한다.
  console.error(`[plugin-loader] ${pluginName} ${phase}: ${reason}`);
  if (eventBus === undefined) return;
  try {
    eventBus.publish({
      type: "plugin.error",
      ts: Date.now(),
      payload: { pluginName, phase, error: reason },
    });
  } catch {
    /* 발행 실패 — 위에서 이미 로그에 남겼다 */
  }
};

/**
 * **코드를 실행하지 않고** 매니페스트만 훑는다 (2026-08-28).
 *
 * ★목록에는 **꺼진 것도** 나와야 한다 — 안 그러면 끄는 순간 목록에서 사라져 **다시 켤 수가
 *  없다**(일방통행 문). 그런데 그걸 보려고 `loadPlugins` 를 쓰면 **코드를 실행**하게 된다.
 * ★**목록을 보려고 남의 코드를 돌리지 않는다** — 지금은 우리 것뿐이라 무해하지만, 서드파티를
 *  받는 순간 그건 "구경만 하려다 실행" 이 된다. 지금 갈라 두는 게 싸다.
 */
export const scanPluginManifests = async (
  rootDir: string,
): Promise<Array<{ manifest: PluginManifest; pluginDir: string; capabilities: string[] }>> => {
  let entries: string[];
  try {
    entries = (await fs.readdir(rootDir, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
  const out: Array<{ manifest: PluginManifest; pluginDir: string; capabilities: string[] }> = [];
  for (const entryName of entries) {
    const pluginDir = path.resolve(rootDir, entryName);
    try {
      const pkgRaw = JSON.parse(
        await fs.readFile(path.join(pluginDir, "package.json"), "utf8"),
      ) as Record<string, unknown>;
      const pkg = pkgRaw as { tiguclaw?: unknown; version?: unknown };
      const m = pkg.tiguclaw as Partial<PluginManifest> | undefined;
      if (m === undefined || typeof m !== "object") continue;
      if (typeof m.name !== "string" || typeof m.entry !== "string") continue;
      if (typeof m.schemaVersion !== "number") continue;
      // ★**여기에도 이름 가드가 있어야 한다** (2026-08-29, 2라운드 P-1). 종전엔
      //  `loadPlugins` 에만 걸어놨는데, **경로를 실제로 만드는 소비처**는 이쪽을 탄다 —
      //  `listAllPlugins`(대시보드 목록)와 브리지 `set-setting` 이 여기서 이름을 받아
      //  `<home>/plugins/<name>/settings.json` 을 쓴다. 실측으로 `../../ESCAPED` 가
      //  **홈 밖에 파일을 만들었다.** 가드는 이름이 **쓰이는 곳**에 건다.
      if (!isValidPluginName(m.name)) continue;
      const capabilities =
        typeof m.kind === "string"
          ? [m.kind]
          : Array.isArray(m.kind)
            ? m.kind.filter((k): k is string => typeof k === "string")
            : [];
      out.push({
        manifest: {
          schemaVersion: m.schemaVersion,
          kind: m.kind as string | string[],
          name: m.name,
          entry: m.entry,
          needs: readNeeds((m as { needs?: unknown }).needs).needs,
          settings: readSettingsSpec((m as { settings?: unknown }).settings).specs,
          ...(typeof pkg.version === "string" ? { version: pkg.version } : {}),
          meta: readPluginMeta(pkgRaw),
          ...(m.core === true ? { core: true } : {}),
        },
        pluginDir,
        capabilities,
      });
    } catch {
      /* 읽기·파싱 실패 = 플러그인 아님(로드 때 사유가 남는다) */
    }
  }
  return out;
};

export const loadPlugins = async (
  rootDir: string,
  eventBus?: EventBus,
): Promise<LoadedPlugin[]> => {
  let entries: string[];
  try {
    const dirents = await fs.readdir(rootDir, { withFileTypes: true });
    entries = dirents.filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    // rootDir 부재 = plugin 0개 부팅 정상.
    return [];
  }

  const loaded: LoadedPlugin[] = [];
  for (const entryName of entries) {
    const pluginDir = path.resolve(rootDir, entryName);
    try {
      const pkgPath = path.join(pluginDir, "package.json");
      // ★**`package.json` 이 없으면 플러그인이 아니다 — 에러가 아니다** (2026-08-31).
      //  같은 질문에 답이 둘이었다: `scanPluginManifests` 는 이걸 *"플러그인 아님"* 으로
      //  조용히 넘기는데(그리고 바로 아래 `마커 부재` 도 그렇게 넘긴다) 여기만 ENOENT 를
      //  잡아 `[error]` 로 찍었다.
      // ★그런데 **코어가 바로 그 자리에 폴더를 만든다** — `settingsFile`·`dataDir` 가 둘 다
      //  `<home>/plugins/<이름>/` 이다. 그래서 `weather` 설정을 한 번 바꾸기만 해도 매 부팅
      //  `[error] weather load: ENOENT …` 가 찍힌다. `weather` 는 멀쩡한데 깨진 것처럼
      //  읽히고, 로그가 1차 진단면인 이 레포에서 가짜 에러는 진짜를 묻는다
      //  ([[feedback_logs_must_stand_alone]]).
      // ★**조용히 넘기지는 않는다.** `index.js` 만 넣고 `package.json` 을 빠뜨린 설치는
      //  진짜 실수이고, 그건 여전히 흔적이 있어야 한다. 그래서 **없애는 것은 `[error]` 라는
      //  거짓말이지 신호가 아니다** — 사실대로 한 줄 남긴다.
      if (!(await fs.stat(pkgPath).then(() => true).catch(() => false))) {
        console.log(
          `[plugin-loader] ${entryName}: package.json 이 없어 플러그인이 아닙니다 ` +
            `— 설정·데이터 폴더면 정상입니다.`,
        );
        continue;
      }
      const raw = await fs.readFile(pkgPath, "utf8");
      const pkgRaw = JSON.parse(raw) as Record<string, unknown>;
      const pkg = pkgRaw as { tiguclaw?: unknown; version?: unknown };
      const marker = pkg.tiguclaw;

      // 마커 부재 — 조용히 skip (tiguclaw plugin 아님).
      if (!marker || typeof marker !== "object") continue;
      const m = marker as Partial<PluginManifest>;

      // kind 정규화 — string OR string[].
      let capabilities: string[];
      if (typeof m.kind === "string") {
        capabilities = [m.kind];
      } else if (Array.isArray(m.kind)) {
        capabilities = m.kind.filter((k): k is string => typeof k === "string");
      } else {
        // kind 부재 — skip.
        continue;
      }

      // ★모르는 값은 **조용히 버리지 않는다**(2026-08-26). 종전엔 로그가 0이라
      //  `kind:["chanel"]` 같은 오타가 플러그인을 통째로 사라지게 하고도 아무 흔적을 안
      //  남겼고, `["observer","chanel"]` 은 절반만 무시된 채 떴다. 둘 다 무음이었다.
      const unknown = capabilities.filter((c) => !KNOWN_CAPABILITIES.has(c));
      const hasKnown = capabilities.length > unknown.length;
      if (unknown.length > 0) {
        const known = [...KNOWN_CAPABILITIES].join(", ");
        console.warn(
          `[plugin-loader] ${entryName}: kind 에 알 수 없는 값 ${JSON.stringify(unknown)} ` +
            `— 아는 값은 [${known}]. ` +
            (hasKnown
              ? "이 값만 무시하고 나머지로 로드합니다."
              : "아는 값이 하나도 없어 이 플러그인을 건너뜁니다."),
        );
      }
      if (!hasKnown) continue;

      // ★**스키마 버전을 실제로 본다** (2026-08-28). 종전엔 *숫자인지*만 확인해서
      //  `schemaVersion: 99` 도 통과했다 — 선언이 있는데 집행이 0이었다.
      //  ★이게 앞으로의 안전장치다: 호스트 표면(`plugins/host.ts`)이나 매니페스트 모양을
      //   바꿀 때 이 숫자를 올리면, 옛 플러그인이 **조용히 반쯤 도는 대신 사유와 함께**
      //   멈춘다. 안 올리면 그때 깨지는 건 사용자 화면이다.
      if (typeof m.schemaVersion === "number" && m.schemaVersion !== PLUGIN_SCHEMA_VERSION) {
        publishError(
          eventBus,
          typeof m.name === "string" ? m.name : entryName,
          "load",
          new Error(
            `schemaVersion ${m.schemaVersion} 은 이 tiguclaw 가 모릅니다(아는 것: ` +
              `${PLUGIN_SCHEMA_VERSION}). 플러그인을 갱신하거나 tiguclaw 를 업데이트하세요.`,
          ),
        );
        continue;
      }
      if (
        typeof m.schemaVersion !== "number" ||
        typeof m.name !== "string" ||
        typeof m.entry !== "string"
      ) {
        publishError(
          eventBus,
          typeof m.name === "string" ? m.name : entryName,
          "load",
          new Error("invalid manifest fields"),
        );
        continue;
      }
      // ★**이름을 좁게 검사한다** (2026-08-29, 적대 검토 A). 종전엔 `typeof === "string"`
      //  뿐이었는데, 이 이름은 세 곳에서 **좌표와 경로**가 된다:
      //    `pluginThreadKey(name, scope)` = `<name>:<scope>`  ← 대화 좌표
      //    `dataDir` · `settingsFile` = `<home>/plugins/<name>/…`  ← 파일 경로
      //  실측으로 `name:"dashboard"` 는 **사용자의 실제 메인 대화**(`dashboard:default`)를
      //  가리켰고, `name:"../../.ssh"` 는 `~/.ssh` 로 나갔다. §D.1 이 *"경계가 코드가 아니라
      //  파일시스템에서 지켜진다"* 고 한 자리인데, 이름이 자유로우면 파일시스템이 못 지킨다.
      if (!isValidPluginName(m.name)) {
        publishError(
          eventBus,
          m.name,
          "load",
          new Error(
            `플러그인 이름 '${m.name}' 을 받지 않습니다 — 소문자·숫자·하이픈만 됩니다. ` +
              `이 이름은 대화 좌표와 파일 경로가 됩니다.`,
          ),
        );
        continue;
      }

      // ★**권한 선언을 여기서 읽고 검사한다** (2026-08-28). 모르는 키는 거부한다 —
      //  집행하지 않는 권한을 선언하게 두면 사용자가 "막히는 줄" 오해한다.
      const nv = readNeeds((marker as { needs?: unknown }).needs);
      for (const problem of nv.problems) {
        console.warn(`[plugin-loader] ${m.name}: ${problem}`);
      }
      // ★설정 선언도 **같은 자리에서** 읽고 검사한다 — 나쁜 칸 하나는 그 칸만 떨어지고
      //  이유가 로그에 남는다(오타 하나에 설정이 통째로 사라지지 않는다).
      const sv = readSettingsSpec((marker as { settings?: unknown }).settings);
      for (const problem of sv.problems) {
        console.warn(`[plugin-loader] ${m.name}: ${problem}`);
      }
      const manifest: PluginManifest = {
        schemaVersion: m.schemaVersion,
        kind: m.kind as string | string[],
        name: m.name,
        entry: m.entry,
        needs: nv.needs,
        settings: sv.specs,
        // 플러그인 자기 버전 — 목록에 보여주고, 갱신됐는지 사람이 판단할 근거가 된다.
        ...(typeof pkg.version === "string" ? { version: pkg.version } : {}),
        meta: readPluginMeta(pkgRaw),
        ...(m.core === true ? { core: true } : {}),
      };

      // 사용자 비활성(ADR 2026-07-17-module-capability-model §5.6 MVP) — settings.json
      // `modules.disabled[]` 에 이 plugin 이름이 있으면 로드 자체를 스킵(import/인스턴스화
      // 0회 — 부작용 없음).
      // ★판정은 `isModuleActive` 하나가 한다 — **코어는 목록에 있어도 돈다**(v0.40.0 F2:
      //  settings.json 한 줄로 브리지를 꺼서 되돌릴 길이 없어지던 것). 인벤토리의 `enabled`
      //  도 같은 함수를 쓰므로 화면과 실제가 갈리지 않는다.
      if (!isModuleActive(manifest.name)) {
        console.log(`[plugin-loader] skip ${manifest.name}: user-disabled`);
        continue;
      }

      const entryAbs = await resolveEntry(pluginDir, manifest.entry);
      const mod = (await import(pathToFileURL(entryAbs).href)) as {
        default?: new () => unknown;
      };
      const Ctor = mod.default;
      if (typeof Ctor !== "function") {
        publishError(
          eventBus,
          manifest.name,
          "load",
          new Error("entry has no default export class"),
        );
        continue;
      }

      const instance = new Ctor();
      // ★**무엇을 요구하는지 부팅 로그에 남긴다.** 사용자가 나중에 "쟤가 왜 나가지?" 를
      //  물을 수 있어야 한다 — 특히 홈에 설치한 것은 우리가 검토하지 않았다.
      console.log(`[plugin-loader] ${manifest.name}: ${describeNeeds(nv.needs)}`);
      loaded.push({ manifest, pluginDir, capabilities, instance });
    } catch (err) {
      publishError(eventBus, entryName, "load", err);
    }
  }

  return loaded;
};
