/**
 * Observer 플러그인 로더 (Phase B dashboard contract §5).
 *
 * channels.ts 동형 패턴 — 같은 plugins/ 루트에서 1단계 sub-dir walk,
 * `tiguclaw.kind === "observer"` 만 로드.
 *
 * channels 와 차이:
 *  - 로더가 인스턴스화 직후 `start(eventBus)` 자동 호출 (반환 직전).
 *    (channels 는 daemon 부트스트랩이 명시 호출 — observer 는 단방향이라 daemon
 *    이 별도 loop 돌릴 이유 없음.)
 *  - 격리 실패 시 `eventBus.publish({ type: "plugin.error", ... })` 추가.
 *
 * `rootDir` 부재 → `[]` (observer 0개 부팅 정상).
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { EventBus } from "../eventbus.js";
import type {
  LoadedObserverPlugin,
  Observer,
  ObserverPluginManifest,
} from "../observers/types.js";

// re-export for backward compat (외부 import 가 본 모듈에서 가져가는 경우 보호).
export type { LoadedObserverPlugin, ObserverPluginManifest };

const publishError = (
  eventBus: EventBus,
  pluginName: string,
  phase: "load" | "start" | "runtime",
  err: unknown,
): void => {
  try {
    eventBus.publish({
      type: "plugin.error",
      ts: Date.now(),
      payload: {
        pluginName,
        phase,
        error: err instanceof Error ? err.message : String(err),
      },
    });
  } catch {
    // bus 자체가 throw — 격리. 위에서 console.error 이미 찍힘.
  }
};

export const loadObserverPlugins = async (
  rootDir: string,
  eventBus: EventBus,
): Promise<LoadedObserverPlugin[]> => {
  let entries: string[];
  try {
    const dirents = await fs.readdir(rootDir, { withFileTypes: true });
    entries = dirents.filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    // rootDir 부재 = observer 0개 부팅 정상.
    return [];
  }

  const loaded: LoadedObserverPlugin[] = [];
  for (const entryName of entries) {
    const pluginDir = path.resolve(rootDir, entryName);
    try {
      const pkgPath = path.join(pluginDir, "package.json");
      const raw = await fs.readFile(pkgPath, "utf8");
      const pkg = JSON.parse(raw) as { tiguclaw?: unknown };
      const marker = pkg.tiguclaw;

      if (!marker || typeof marker !== "object") continue;
      const m = marker as Partial<ObserverPluginManifest>;

      // observer 만 처리. channel/trigger 는 다른 로더 책임.
      if (m.kind !== "observer") continue;

      if (
        typeof m.schemaVersion !== "number" ||
        typeof m.name !== "string" ||
        typeof m.entry !== "string"
      ) {
        console.error(
          `[observer-plugin-loader] skip ${entryName}: invalid manifest fields`,
        );
        publishError(
          eventBus,
          typeof m.name === "string" ? m.name : entryName,
          "load",
          new Error("invalid manifest fields"),
        );
        continue;
      }

      const manifest: ObserverPluginManifest = {
        schemaVersion: m.schemaVersion,
        kind: "observer",
        name: m.name,
        entry: m.entry,
      };

      const entryAbs = path.resolve(pluginDir, manifest.entry);
      // ESM + Windows 경로 호환: file:// URL.
      const mod = (await import(pathToFileURL(entryAbs).href)) as {
        default?: new () => Observer;
      };
      const Ctor = mod.default;
      if (typeof Ctor !== "function") {
        console.error(
          `[observer-plugin-loader] skip ${entryName}: entry has no default export class`,
        );
        publishError(
          eventBus,
          manifest.name,
          "load",
          new Error("no default export class"),
        );
        continue;
      }

      const observer = new Ctor();

      // start 자동 호출 — 격리 (한 observer 의 start throw 가 다음 진행 막지 X).
      try {
        await observer.start(eventBus);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.error(
          `[observer-plugin-loader] start failed ${entryName}: ${reason}`,
        );
        publishError(eventBus, manifest.name, "start", err);
        continue;
      }

      loaded.push({ manifest, pluginDir, observer });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[observer-plugin-loader] skip ${entryName}: ${reason}`);
      publishError(eventBus, entryName, "load", err);
    }
  }

  return loaded;
};
