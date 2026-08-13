import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { appRoot, getPaths } from "../paths.js";
import { countMemories, listMemories } from "../../store/memory.js";
import { listSchedules } from "../../store/schedules.js";
import { collectInventory } from "./inventory.js";
import { resolveEntry } from "./loader.js";
import { listProviderNames, resolveProviderConn } from "../llm-runtime/provider-registry.js";
import { providerAuthAvailable } from "../llm-runtime/provider-availability.js";

export type ModuleKind = "core" | "plugin" | "llm-adapter";
export type ModuleStatus = "active" | "inactive" | "degraded" | "missing" | "error";
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

export interface Module {
  id: string;
  kind: ModuleKind;
  name: string;
  status: ModuleStatus;
  summary?: string;
  capabilities?: string[];
  views?: ViewSpec[];
  actions?: ActionSpec[];
  events?: EventSpec[];
  updatedAt?: string;
}

export interface ModuleRegistryResult {
  providers: Module[]; // ★와이어 유지: JSON 응답 키 `providers`(프런트 view-providers.js 소비)
  generatedAt: string;
}

const toIso = (ms: number | null | undefined): string | null =>
  typeof ms === "number" ? new Date(ms).toISOString() : null;

const latestUpdatedAt = (rows: Array<{ updatedAt: number }>): string | null => {
  const first = rows[0];
  return first === undefined ? null : new Date(first.updatedAt).toISOString();
};

const coreDaemonModule = (): Module => ({
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

const coreMemoryModule = (): Module => {
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

const coreScheduleModule = (): Module => {
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

const corePluginRegistryModule = async (): Promise<Module> => {
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

// LLM 어댑터 벤더 표시명 — 고정 5종 하드매핑(ADR 2026-07-17 §5: 동적 일반화 금지,
// PROVIDER_REGISTRY 가 실제로 5종을 넘을 때만 키 추가). 미지 provider = provider id 원문 폴백.
const LLM_ADAPTER_DISPLAY_NAME: Record<string, string> = {
  anthropic: "Anthropic (Claude)",
  codex: "OpenAI Codex (구독)",
  openai: "OpenAI",
  ollama: "Ollama (로컬)",
  google: "Google Gemini",
};

const llmAdapterModule = (provider: string): Module => {
  const conn = resolveProviderConn(provider);
  // ★판정은 `providerAuthAvailable` 한 곳 (2026-08-13) — 종전엔 `conn.apiKey` 유무만 봐서
  //  claude 구독(키 없이 OAuth 토큰)과 codex refresh-only 설치를 **인증 안 됨**으로 표시했다.
  //  카드가 "미설정" 이라 말하는데 실제로는 그 백엔드로 답하고 있는 상태 = 진단을 망친다.
  const authenticated = providerAuthAvailable(provider);
  const adapter = conn?.adapter ?? "unknown";
  const name = LLM_ADAPTER_DISPLAY_NAME[provider] ?? provider;
  const summary = authenticated
    ? `${adapter} 어댑터 · 인증됨`
    : `${adapter} 어댑터 · ${conn?.apiKeyEnv ?? "?"} 미설정`;

  return {
    id: `llm-adapter.${provider}`,
    kind: "llm-adapter",
    name,
    status: authenticated ? "active" : "inactive",
    summary,
    capabilities: ["llm.turn"],
    views: [
      {
        id: `llm-adapter.${provider}.summary`,
        title: name,
        kind: "summary-card",
        data: {
          provider,
          adapter,
          ...(conn?.baseURL !== undefined ? { baseURL: conn.baseURL } : {}),
          apiKeyEnv: conn?.apiKeyEnv,
          authenticated,
        },
        order: 40,
      },
    ],
    updatedAt: new Date().toISOString(),
  };
};

// listProviderNames(진실 소스: src/core/llm-runtime/provider-registry.ts) 를 순회만 — 하드코딩
// 5종 + 사용자 정의 provider(settings.json models.providers, config-driven 2026-07-18, known
// adapter 만). 어댑터별 특수 if 분기 0(§0 LLM-agnostic 하드게이트). resolveProviderConn 재사용
// (자체 인증 판정 로직 재구현 금지). 실 백엔드 호출/핑 없음 — 인증 설정 유무만(값싸게).
const collectLlmAdapterModules = (): Module[] =>
  listProviderNames().map((provider) => llmAdapterModule(provider));

export interface PluginModuleExport {
  id: string;
  load: () => Module | Promise<Module>;
}

const asPluginModuleExport = (value: unknown): PluginModuleExport | null => {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as { id?: unknown; load?: unknown };
  if (typeof candidate.id !== "string") return null;
  if (typeof candidate.load !== "function") return null;
  return candidate as PluginModuleExport;
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

const readModuleExportFromManifest = async (
  pluginDir: string,
): Promise<{ id: string; entry: string } | null> => {
  const pkg = await readJson(path.join(pluginDir, "package.json"));
  if (!isRecord(pkg) || !isRecord(pkg.tiguclaw)) return null;

  // ★와이어 유지: 매니페스트 마커 문자열 "provider" + provider:{} 블록(플러그인 저작 계약).
  const marker = pkg.tiguclaw;
  const capabilities = asStringArray(marker.kind);
  const provider = marker.provider;
  if (!capabilities.includes("provider")) return null;
  if (!isRecord(provider)) return null;
  if (typeof provider.id !== "string") return null;
  if (typeof provider.entry !== "string") return null;

  return { id: provider.id, entry: provider.entry };
};

const loadPluginModuleExports = async (): Promise<PluginModuleExport[]> => {
  const roots = [appRoot(), getPaths().home];
  const exports: PluginModuleExport[] = [];
  const seen = new Set<string>();

  for (const root of roots) {
    for (const pluginDir of await discoverPluginDirs(root)) {
      const manifest = await readModuleExportFromManifest(pluginDir);
      if (manifest === null) continue;

      // ★built 런타임 대응: loader 와 동일한 entry 해석(.ts→.js 폴백 + tsx 등록).
      // raw path.resolve 면 built 에서 `.ts` entry(예: self-growth provider)가 존재하지
      // 않아 import 실패→조용히 skip→모듈뷰 카드 누락. resolveEntry 재사용으로 대칭 복구.
      const modulePath = await resolveEntry(pluginDir, manifest.entry);
      const key = `${manifest.id}:${modulePath}`;
      if (seen.has(key)) continue;
      seen.add(key);

      try {
        // ★와이어 유지: plugin export lookup 키 mod.provider/default/collectProvider.
        const mod = (await import(pathToFileURL(modulePath).href)) as {
          provider?: unknown;
          default?: unknown;
          collectProvider?: unknown;
        };
        const pluginModule =
          asPluginModuleExport(mod.provider) ??
          asPluginModuleExport(mod.default) ??
          (typeof mod.collectProvider === "function"
            ? { id: manifest.id, load: mod.collectProvider as () => Module | Promise<Module> }
            : null);
        if (pluginModule !== null) exports.push(pluginModule);
      } catch {
        // 부재/로드 실패는 discovery skip. module 실행 중 throw는 moduleError 경계에서 처리.
      }
    }
  }

  return exports;
};

const moduleError = (id: string, err: unknown): Module => {
  const msg = err instanceof Error ? err.message : String(err);
  return {
    id,
    kind: id.startsWith("plugin.") ? "plugin" : "core",
    name: "Module error",
    status: "error",
    summary: msg,
    events: [
      {
        id: `${id}.${Date.now()}`,
        ts: new Date().toISOString(),
        level: "error",
        title: "module load failed",
        message: msg,
      },
    ],
    updatedAt: new Date().toISOString(),
  };
};

export const collectModules = async (): Promise<ModuleRegistryResult> => {
  const loaders: Array<{ id: string; load: () => Module | Promise<Module> }> = [
    { id: "core.daemon", load: coreDaemonModule },
    { id: "core.memory", load: coreMemoryModule },
    { id: "core.schedule", load: coreScheduleModule },
    { id: "core.plugin-registry", load: corePluginRegistryModule },
    ...(await loadPluginModuleExports()),
  ];

  const modules: Module[] = [];
  for (const loader of loaders) {
    try {
      modules.push(await loader.load());
    } catch (err) {
      modules.push(moduleError(loader.id, err));
    }
  }

  modules.push(...collectLlmAdapterModules());

  return { providers: modules, generatedAt: new Date().toISOString() }; // ★와이어 유지: 키 `providers`
};
