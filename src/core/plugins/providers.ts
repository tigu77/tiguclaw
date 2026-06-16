import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { appRoot, getPaths } from "../paths.js";
import { countMemories, listMemories } from "../../store/memory.js";
import { listSchedules } from "../../store/schedules.js";
import { collectInventory } from "./inventory.js";

export type ProviderKind = "core" | "plugin";
export type ProviderStatus = "active" | "inactive" | "degraded" | "missing" | "error";
export type ViewKind =
  | "summary-card"
  | "metric-card"
  | "table"
  | "timeline"
  | "log-list"
  | "link-list"
  | "action-panel";
export type DangerLevel = "safe" | "gray" | "danger";
export type EventLevel = "info" | "warn" | "error";

export interface ViewSpec {
  id: string;
  title: string;
  kind: ViewKind;
  data: unknown;
  order?: number;
  refreshMs?: number;
}

export interface ActionSpec {
  id: string;
  label: string;
  description?: string;
  inputSchema?: unknown;
  danger: DangerLevel;
  requiresConfirmation: boolean;
}

export interface EventSpec {
  id: string;
  ts: string;
  level: EventLevel;
  title: string;
  message?: string;
  relatedActionId?: string;
}

export interface Provider {
  id: string;
  kind: ProviderKind;
  name: string;
  status: ProviderStatus;
  summary?: string;
  capabilities?: string[];
  views?: ViewSpec[];
  actions?: ActionSpec[];
  events?: EventSpec[];
  updatedAt?: string;
}

export interface ProviderRegistryResult {
  providers: Provider[];
  generatedAt: string;
}

const toIso = (ms: number | null | undefined): string | null =>
  typeof ms === "number" ? new Date(ms).toISOString() : null;

const latestUpdatedAt = (rows: Array<{ updatedAt: number }>): string | null => {
  const first = rows[0];
  return first === undefined ? null : new Date(first.updatedAt).toISOString();
};

const coreDaemonProvider = (): Provider => ({
  id: "core.daemon",
  kind: "core",
  name: "Daemon",
  status: "active",
  summary: `pid ${process.pid}`,
  capabilities: ["daemon.health"],
  views: [
    {
      id: "core.daemon.summary",
      title: "데몬",
      kind: "summary-card",
      data: {
        pid: process.pid,
        node: process.version,
        uptimeSec: Math.round(process.uptime()),
        platform: process.platform,
      },
      order: 1,
    },
  ],
  updatedAt: new Date().toISOString(),
});

const coreMemoryProvider = (): Provider => {
  const total = countMemories();
  const recent = listMemories({ limit: 10, orderBy: "updated" });
  const sample = listMemories({ limit: 1000, orderBy: "updated" });
  const byType = new Map<string, number>();
  for (const m of sample) byType.set(m.type, (byType.get(m.type) ?? 0) + 1);

  return {
    id: "core.memory",
    kind: "core",
    name: "Memory",
    status: "active",
    summary: `${total} memories`,
    capabilities: ["memory.read"],
    views: [
      {
        id: "core.memory.summary",
        title: "메모리",
        kind: "summary-card",
        data: {
          total,
          sampled: sample.length,
          byType: Object.fromEntries(byType.entries()),
          latestUpdatedAt: latestUpdatedAt(recent),
        },
        order: 10,
      },
      {
        id: "core.memory.recent",
        title: "최근 메모리",
        kind: "table",
        data: {
          columns: ["type", "name", "description", "updatedAt"],
          rows: recent.map((m) => ({
            type: m.type,
            name: m.name,
            description: m.description,
            updatedAt: toIso(m.updatedAt),
          })),
        },
        order: 11,
      },
    ],
    updatedAt: new Date().toISOString(),
  };
};

const coreScheduleProvider = (): Provider => {
  const schedules = listSchedules();
  const enabled = schedules.filter((s) => s.enabled);
  return {
    id: "core.schedule",
    kind: "core",
    name: "Schedule",
    status: "active",
    summary: `${enabled.length}/${schedules.length} enabled`,
    capabilities: ["schedule.read"],
    views: [
      {
        id: "core.schedule.summary",
        title: "스케줄",
        kind: "summary-card",
        data: {
          total: schedules.length,
          enabled: enabled.length,
          disabled: schedules.length - enabled.length,
        },
        order: 20,
      },
      {
        id: "core.schedule.table",
        title: "등록된 스케줄",
        kind: "table",
        data: {
          columns: [
            "id",
            "label",
            "triggerType",
            "cronExpr",
            "timezone",
            "enabled",
            "lastFiredAt",
            "lastStatus",
          ],
          rows: schedules.map((s) => ({
            id: s.id,
            label: s.label,
            triggerType: s.triggerType,
            cronExpr: s.cronExpr,
            timezone: s.timezone,
            enabled: s.enabled,
            lastFiredAt: toIso(s.lastFiredAt),
            lastStatus: s.lastStatus,
          })),
        },
        order: 21,
      },
    ],
    updatedAt: new Date().toISOString(),
  };
};

const corePluginRegistryProvider = async (): Promise<Provider> => {
  const inv = await collectInventory();
  const categories = {
    channel: inv.channel.length,
    external_plugin: inv.external_plugin.length,
    skill: inv.skill.length,
    agent: inv.agent.length,
    mcp: inv.mcp.length,
  };
  const all = [
    ...inv.channel,
    ...inv.external_plugin,
    ...inv.skill,
    ...inv.agent,
    ...inv.mcp,
  ];
  const enabled = all.filter((e) => e.enabled).length;

  return {
    id: "core.plugin-registry",
    kind: "core",
    name: "Plugin Registry",
    status: "active",
    summary: `${all.length} entries`,
    capabilities: ["plugin.discovery", "plugin.inventory"],
    views: [
      {
        id: "core.plugin-registry.summary",
        title: "플러그인/능력 인벤토리",
        kind: "summary-card",
        data: {
          total: all.length,
          enabled,
          categories,
          generatedAt: toIso(inv.generatedAt),
        },
        order: 30,
      },
      {
        id: "core.plugin-registry.entries",
        title: "인벤토리 항목",
        kind: "table",
        data: {
          columns: ["category", "layer", "name", "enabled", "description"],
          rows: all.map((e) => ({
            category: e.category,
            layer: e.layer,
            name: e.name,
            enabled: e.enabled,
            description: e.description ?? "",
          })),
        },
        order: 31,
      },
    ],
    updatedAt: new Date().toISOString(),
  };
};

export interface PluginProviderExport {
  id: string;
  load: () => Provider | Promise<Provider>;
}

const asPluginProviderExport = (value: unknown): PluginProviderExport | null => {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as { id?: unknown; load?: unknown };
  if (typeof candidate.id !== "string") return null;
  if (typeof candidate.load !== "function") return null;
  return candidate as PluginProviderExport;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const asStringArray = (value: unknown): string[] => {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
};

const readJson = async (file: string): Promise<unknown | null> => {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as unknown;
  } catch {
    return null;
  }
};

const discoverPluginDirs = async (root: string): Promise<string[]> => {
  const pluginsRoot = path.join(root, "plugins");
  try {
    const entries = await fs.readdir(pluginsRoot, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(pluginsRoot, entry.name));
  } catch {
    return [];
  }
};

const readProviderExportFromManifest = async (
  pluginDir: string,
): Promise<{ id: string; entry: string } | null> => {
  const pkg = await readJson(path.join(pluginDir, "package.json"));
  if (!isRecord(pkg) || !isRecord(pkg.tiguclaw)) return null;

  const marker = pkg.tiguclaw;
  const capabilities = asStringArray(marker.kind);
  const provider = marker.provider;
  if (!capabilities.includes("provider")) return null;
  if (!isRecord(provider)) return null;
  if (typeof provider.id !== "string") return null;
  if (typeof provider.entry !== "string") return null;

  return { id: provider.id, entry: provider.entry };
};

const loadPluginProviderExports = async (): Promise<PluginProviderExport[]> => {
  const roots = [appRoot(), getPaths().home];
  const exports: PluginProviderExport[] = [];
  const seen = new Set<string>();

  for (const root of roots) {
    for (const pluginDir of await discoverPluginDirs(root)) {
      const manifest = await readProviderExportFromManifest(pluginDir);
      if (manifest === null) continue;

      const providerPath = path.resolve(pluginDir, manifest.entry);
      const key = `${manifest.id}:${providerPath}`;
      if (seen.has(key)) continue;
      seen.add(key);

      try {
        const mod = (await import(pathToFileURL(providerPath).href)) as {
          provider?: unknown;
          default?: unknown;
          collectProvider?: unknown;
        };
        const pluginProvider =
          asPluginProviderExport(mod.provider) ??
          asPluginProviderExport(mod.default) ??
          (typeof mod.collectProvider === "function"
            ? { id: manifest.id, load: mod.collectProvider as () => Provider | Promise<Provider> }
            : null);
        if (pluginProvider !== null) exports.push(pluginProvider);
      } catch {
        // 부재/로드 실패는 discovery skip. provider 실행 중 throw는 providerError 경계에서 처리.
      }
    }
  }

  return exports;
};

const providerError = (id: string, err: unknown): Provider => {
  const msg = err instanceof Error ? err.message : String(err);
  return {
    id,
    kind: id.startsWith("plugin.") ? "plugin" : "core",
    name: "Provider error",
    status: "error",
    summary: msg,
    events: [
      {
        id: `${id}.${Date.now()}`,
        ts: new Date().toISOString(),
        level: "error",
        title: "provider load failed",
        message: msg,
      },
    ],
    updatedAt: new Date().toISOString(),
  };
};

export const collectProviders = async (): Promise<ProviderRegistryResult> => {
  const loaders: Array<{ id: string; load: () => Provider | Promise<Provider> }> = [
    { id: "core.daemon", load: coreDaemonProvider },
    { id: "core.memory", load: coreMemoryProvider },
    { id: "core.schedule", load: coreScheduleProvider },
    { id: "core.plugin-registry", load: corePluginRegistryProvider },
    ...(await loadPluginProviderExports()),
  ];

  const providers: Provider[] = [];
  for (const loader of loaders) {
    try {
      providers.push(await loader.load());
    } catch (err) {
      providers.push(providerError(loader.id, err));
    }
  }

  return { providers, generatedAt: new Date().toISOString() };
};
