import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Channel } from "../../channels/types.js";

/**
 * 채널 플러그인 마커 schema (V1).
 * `<plugin-dir>/package.json` 의 `tiguclaw` 필드로 박힘.
 * Phase A 시연 1 architect contract §2.
 */
export interface ChannelPluginManifest {
  /** 본 라운드 1 픽스. 미래 schema 변경 시 가드. */
  schemaVersion: number;
  /** "trigger" 는 Phase B — V1 로더는 조용히 스킵. */
  kind: "channel" | "trigger";
  /** 런타임 채널 식별자 (ChannelName 으로 매핑). */
  name: string;
  /** plugin 디렉토리 기준 상대 경로. default export = Channel class. */
  entry: string;
}

export interface LoadedChannelPlugin {
  manifest: ChannelPluginManifest;
  /** 절대 경로. */
  pluginDir: string;
  /** 인스턴스화 완료. */
  channel: Channel;
}

/**
 * `rootDir` 의 1단계 sub-dir 만 walk. 각 sub-dir 의 `package.json` 에서
 * `tiguclaw.kind === "channel"` 마커 있는 것만 로드.
 *
 * 격리: 한 plugin 의 manifest 파싱 / entry import / 인스턴스화 실패는
 * `console.error` 1줄 + 다음 plugin 진행 (architect contract §4 격리).
 *
 * `rootDir` 자체가 없으면 `[]` 반환 (채널 0개 부팅 정상 — 비전 §42).
 *
 * name 충돌은 검증 X — `LoadedChannelPlugin[]` 그대로 반환, 호출자가 정책 결정.
 */
export const loadChannelPlugins = async (
  rootDir: string,
): Promise<LoadedChannelPlugin[]> => {
  let entries: string[];
  try {
    const dirents = await fs.readdir(rootDir, { withFileTypes: true });
    entries = dirents.filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    // rootDir 부재 = 채널 0개 부팅 정상.
    return [];
  }

  const loaded: LoadedChannelPlugin[] = [];
  for (const entryName of entries) {
    const pluginDir = path.resolve(rootDir, entryName);
    try {
      const pkgPath = path.join(pluginDir, "package.json");
      const raw = await fs.readFile(pkgPath, "utf8");
      const pkg = JSON.parse(raw) as { tiguclaw?: unknown };
      const marker = pkg.tiguclaw;

      // 마커 부재 — 조용히 skip.
      if (!marker || typeof marker !== "object") continue;
      const m = marker as Partial<ChannelPluginManifest>;

      // trigger 는 V1 조용히 skip (Phase B).
      if (m.kind === "trigger") continue;
      if (m.kind !== "channel") continue;

      if (
        typeof m.schemaVersion !== "number" ||
        typeof m.name !== "string" ||
        typeof m.entry !== "string"
      ) {
        console.error(
          `[channel-plugin-loader] skip ${entryName}: invalid manifest fields`,
        );
        continue;
      }

      const manifest: ChannelPluginManifest = {
        schemaVersion: m.schemaVersion,
        kind: "channel",
        name: m.name,
        entry: m.entry,
      };

      const entryAbs = path.resolve(pluginDir, manifest.entry);
      // ESM + Windows 경로 호환: file:// URL 로 변환 후 dynamic import.
      const mod = (await import(pathToFileURL(entryAbs).href)) as {
        default?: new () => Channel;
      };
      const Ctor = mod.default;
      if (typeof Ctor !== "function") {
        console.error(
          `[channel-plugin-loader] skip ${entryName}: entry has no default export class`,
        );
        continue;
      }

      const channel = new Ctor();
      loaded.push({ manifest, pluginDir, channel });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[channel-plugin-loader] skip ${entryName}: ${reason}`);
    }
  }

  return loaded;
};
