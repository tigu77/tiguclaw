/**
 * 독립 doctor/onboard의 인증 조회. 서비스 entry/startService는 열지 않는다.
 * 플러그인이 선언한 작은 authProbe만 로더와 같은 활성/번들 우선 게이트로 읽는다.
 * 진단용 등록은 토큰을 반환하거나 refresh할 수 없다. 데몬에서는 호출하지 않는다.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { appRoot, getPaths } from "./paths.js";
import { refusalToRun, resolveEntry, PLUGIN_SCHEMA_VERSION } from "./plugins/loader.js";
import { getAuthProvider } from "./llm-runtime/auth-registry.js";
import { createPluginHost, type PluginHost } from "./plugins/host.js";

export const registerStandaloneAuthProbes = async (): Promise<void> => {
  for (const root of [path.join(appRoot(), "plugins"), path.join(getPaths().home, "plugins")]) {
    let dirs;
    try { dirs = await fs.readdir(root, { withFileTypes: true }); } catch { continue; }
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const pluginDir = path.join(root, dir.name);
      let marker: { schemaVersion?: number; name?: string; entry?: string; kind?: string[]; authProbe?: string; needs?: { auth?: string[] } };
      try { marker = JSON.parse(await fs.readFile(path.join(pluginDir, "package.json"), "utf8")).tiguclaw; }
      catch { continue; }
      if (marker?.schemaVersion !== PLUGIN_SCHEMA_VERSION || typeof marker.name !== "string" || typeof marker.entry !== "string" ||
          !Array.isArray(marker.kind) || !marker.kind.includes("service") || typeof marker.authProbe !== "string") continue;
      if (refusalToRun(root, marker.name) !== undefined) continue;
      try {
        // Broken service entries are not installed auth even if a probe file remains.
        await fs.access(await resolveEntry(pluginDir, marker.entry));
        const entry = await resolveEntry(pluginDir, marker.authProbe);
        const [realDir, realEntry] = await Promise.all([fs.realpath(pluginDir), fs.realpath(entry)]);
        if (!realEntry.startsWith(realDir + path.sep)) throw new Error("authProbe escapes its plugin directory");
        const { authProbe } = await import(pathToFileURL(entry).href) as {
          authProbe?: { provider?: string; isAuthenticated?: () => boolean;
            register?: (host: Pick<PluginHost, "registerAuthProvider">) => { ok: boolean; error?: string } };
        };
        if (typeof authProbe?.provider !== "string" || typeof authProbe.isAuthenticated !== "function" || typeof authProbe.register !== "function" ||
            !Array.isArray(marker.needs?.auth) || !marker.needs.auth.includes(authProbe.provider)) {
          throw new Error("authProbe must match needs.auth and expose isAuthenticated()/register()");
        }
        if (getAuthProvider(authProbe.provider) !== undefined) continue;
        // The installed plugin registers through the existing needs.auth gate. Only
        // this auth capability is passed; no service startup, login or token refresh.
        const host = createPluginHost(marker.name, { auth: marker.needs.auth });
        const result = authProbe.register({ registerAuthProvider: host.registerAuthProvider });
        if (!result.ok) throw new Error(result.error ?? "Auth probe registration failed");
      } catch (e) {
        console.warn(`[auth-probe] ${marker.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
};
