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

export interface PluginManifest {
  schemaVersion: number;
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
const KNOWN_CAPABILITIES = new Set([
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
  if (eventBus === undefined) {
    console.error(`[plugin-loader] ${pluginName} ${phase}: ${reason}`);
    return;
  }
  try {
    eventBus.publish({
      type: "plugin.error",
      ts: Date.now(),
      payload: { pluginName, phase, error: reason },
    });
  } catch {
    console.error(`[plugin-loader] ${pluginName} ${phase}: ${reason}`);
  }
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
      const raw = await fs.readFile(pkgPath, "utf8");
      const pkg = JSON.parse(raw) as { tiguclaw?: unknown };
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

      const manifest: PluginManifest = {
        schemaVersion: m.schemaVersion,
        kind: m.kind as string | string[],
        name: m.name,
        entry: m.entry,
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
      loaded.push({ manifest, pluginDir, capabilities, instance });
    } catch (err) {
      publishError(eventBus, entryName, "load", err);
    }
  }

  return loaded;
};
