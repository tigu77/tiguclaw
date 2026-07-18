/**
 * Plugin Inventory V1 — 5 카테고리 통합 walk + LLM/사용자 포맷터.
 * contract `_workspace/phaseB_inventory_architect_contract.md` §2 §3.
 *
 * 단방향 import: memory.ts 가 본 모듈을 import (역방향 0 — 순환 import 회피).
 * 격리 try/catch: 한 영역의 실패가 다른 영역에 전파 X.
 * 부재 디렉토리/파일 silent skip — `enabled = true` 디폴트 (외부 plugin 만 cross-ref).
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { appRoot, getPaths } from "../paths.js";
import { discoverSkills } from "../llm-runtime/capabilities/skill-registry.js";
import { discoverAgents } from "../llm-runtime/capabilities/agent-registry.js";
import { discoverEndpoints, type Endpoint } from "../entry/endpoint-registry.js";
import {
  discoverCommands,
  BUILTIN_COMMANDS,
  type Command,
} from "../entry/command-registry.js";
import { isModuleDisabled } from "../settings.js";

export type PluginCategory =
  | "channel"
  | "external_plugin"
  | "skill"
  | "agent"
  | "mcp"
  | "endpoint"
  | "command";

/**
 * 3 layer — 사용자 멘탈 모델: 개발 레포가 *in-tree* 로 들고 있는가, 외부가 떠 있는 걸 *발견* 만 하는가, 그도 저도 아닌 코어 *메타 인프라* 인가.
 * - meta_infra: tiguclaw 운영 자체에 의존하는 외부 메타 도구 (V1 hardcode: harness)
 * - in_tree: tiguclaw 개발 레포가 직접 들고 있는 dogfood plugin — repo working tree 안에 위치
 *   (Phase B Must #2 install 메커니즘 진입 시 `installed` layer 동반 추가 — 2026-05-16 결정 노트)
 * - discovered: 외부 install, 데몬이 자동 발견. 능력 카탈로그만.
 */
export type PluginLayer = "meta_infra" | "in_tree" | "discovered";

export interface PluginEntry {
  category: PluginCategory;
  layer: PluginLayer;
  name: string;
  description?: string;
  source: string; // 절대 경로 또는 "in-process:<id>"
  enabled: boolean; // (b) 만 settings cross-ref. 그 외 항상 true (V1).
  metadata?: Record<string, unknown>;
}

export interface InventoryResult {
  channel: PluginEntry[];
  external_plugin: PluginEntry[];
  skill: PluginEntry[];
  agent: PluginEntry[];
  mcp: PluginEntry[];
  endpoint: PluginEntry[];
  command: PluginEntry[];
  generatedAt: number;
}

// ─── 내부 유틸 ───────────────────────────────────────────────────────────

/** 인용부호(작은/큰) 제거 — 값 그대로면 통과. */
const stripQuotes = (val: string): string => {
  if (
    (val.startsWith('"') && val.endsWith('"') && val.length >= 2) ||
    (val.startsWith("'") && val.endsWith("'") && val.length >= 2)
  ) {
    return val.slice(1, -1);
  }
  return val;
};

/**
 * 컨텍스트메뉴 외부 기여 — 항목 원시 스키마 (`_workspace/context-menu_architect_contract.md`
 * §2.1 §2.3). 스킬 frontmatter 선언 형식은 `on`/`label`(+선택 danger/group/icon) 만 —
 * **`action` 은 여기서 절대 읽지 않는다**: 스킬 기여의 실행 action 은 항상 `invoke_skill`
 * (그 스킬명, 집계기 http-bridge 가 고정) — frontmatter 가 임의 action 을 지정할 방법
 * 자체가 없다(구조적 화이트리스트, §2.4 보안).
 */
export interface ContextMenuItemRaw {
  on: string; // ctx.type 매칭 키 (예: "session" | "job" | ...)
  label: string;
  danger?: boolean;
  group?: string;
  icon?: string;
}

/**
 * frontmatter `context-menu:` 중첩 리스트 정규식 파싱. yaml lib 0(계약 제약).
 * 지원 shape 은 딱 하나만:
 *   context-menu:
 *     - on: session
 *       label: "이 세션 요약"
 *       danger: false
 *     - on: job
 *       label: "실패 로그 분석"
 * 리스트 밖 최상위 라인(들여쓰기 0) 도달 시 종료. 항목 단위 개별 skip(파일 전체 drop
 * 아님) — `on`/`label` 둘 다 비어있지 않아야 유효. 파싱 실패는 빈 배열(never-throw).
 */
const parseContextMenuBlock = (frontmatterBody: string): ContextMenuItemRaw[] => {
  const items: ContextMenuItemRaw[] = [];
  try {
    let inList = false;
    let current: Record<string, string> | null = null;
    const flush = (): void => {
      if (current === null) return;
      const on = (current.on ?? "").trim();
      const label = (current.label ?? "").trim();
      const c = current;
      current = null;
      if (on === "" || label === "") return; // 필수 필드 결여 — 항목 skip.
      const item: ContextMenuItemRaw = { on, label };
      if (c.danger !== undefined) {
        const d = c.danger.trim().toLowerCase();
        if (d === "true") item.danger = true;
        else if (d === "false") item.danger = false;
      }
      if (c.group !== undefined && c.group.trim() !== "") item.group = c.group.trim();
      if (c.icon !== undefined) {
        const ic = c.icon.trim();
        if (ic !== "" && ic.length <= 8) item.icon = ic; // 이모지/문자 1개 — 과도한 값은 조용히 생략.
      }
      items.push(item);
    };
    for (const rawLine of frontmatterBody.split(/\r?\n/)) {
      if (!inList) {
        if (/^context-menu\s*:\s*$/.test(rawLine)) inList = true;
        continue;
      }
      if (/^\S/.test(rawLine)) {
        // 들여쓰기 0 라인 도달 — context-menu 리스트 섹션 종료.
        flush();
        inList = false;
        continue;
      }
      const itemStart = rawLine.match(/^\s*-\s*(.*)$/);
      if (itemStart) {
        flush();
        current = {};
        const rest = itemStart[1];
        if (rest) {
          const kv = rest.match(/^([\w-]+)\s*:\s*(.+?)\s*$/);
          if (kv) current[kv[1]!] = stripQuotes(kv[2]!);
        }
        continue;
      }
      if (current !== null) {
        const kv = rawLine.match(/^\s+([\w-]+)\s*:\s*(.+?)\s*$/);
        if (kv) current[kv[1]!] = stripQuotes(kv[2]!);
      }
    }
    flush();
  } catch {
    return [];
  }
  return items;
};

/** frontmatter `name`/`description`(+선택 `context-menu`) 정규식 추출. 외부 yaml lib 0. */
const parseFrontmatter = (
  filePath: string,
): { name?: string; description?: string; contextMenu?: ContextMenuItemRaw[] } => {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!m) return {};
    const out: { name?: string; description?: string; contextMenu?: ContextMenuItemRaw[] } = {};
    for (const line of m[1]!.split(/\r?\n/)) {
      const kv = line.match(/^(name|description)\s*:\s*(.+?)\s*$/);
      if (!kv) continue;
      const key = kv[1] as "name" | "description";
      out[key] = stripQuotes(kv[2]!);
    }
    const contextMenu = parseContextMenuBlock(m[1]!);
    if (contextMenu.length > 0) out.contextMenu = contextMenu;
    return out;
  } catch {
    return {};
  }
};

const safeReadJson = (p: string): unknown | undefined => {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return undefined;
  }
};

const safeReaddir = (p: string): string[] => {
  try {
    return fs.readdirSync(p, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
};

// ─── (a) 채널 ─────────────────────────────────────────────────────────────

const collectChannels = (repoRoot: string): PluginEntry[] => {
  const root = path.join(repoRoot, "plugins");
  const out: PluginEntry[] = [];
  for (const dir of safeReaddir(root)) {
    try {
      const pluginDir = path.resolve(root, dir);
      const pkg = safeReadJson(path.join(pluginDir, "package.json")) as
        | { tiguclaw?: Record<string, unknown> }
        | undefined;
      const m = pkg?.tiguclaw;
      if (!m || typeof m !== "object") continue;
      const marker = m as {
        kind?: string | string[];
        name?: string;
        schemaVersion?: number;
        entry?: string;
      };
      // kind 는 문자열 또는 배열(예 http-bridge: ['channel','observer']) — 정규화해 검사.
      const kinds = Array.isArray(marker.kind)
        ? marker.kind
        : marker.kind !== undefined
          ? [marker.kind]
          : [];
      if (!kinds.includes("channel")) continue; // 채널이 아니면 여기선 스킵(아래 번들 walker 가 담음).
      if (typeof marker.name !== "string") continue;
      out.push({
        category: "channel",
        layer: "in_tree", // <repo>/plugins/* — 위치 자체가 in-tree dogfood
        name: marker.name,
        source: pluginDir,
        // 사용자 비활성(ADR 2026-07-17 §5.6 MVP) — loadPlugins 스킵 대상과 동일 판정
        // (settings.json modules.disabled). "disabled" ≠ "inactive" — 이건 명시 off.
        enabled: !isModuleDisabled(marker.name),
        metadata: {
          kind: kinds.join(", "),
          schemaVersion: marker.schemaVersion,
          entry: marker.entry,
        },
      });
    } catch {
      // 한 plugin 실패 무시.
    }
  }
  return out;
};

// 번들 비채널 플러그인 (appRoot/plugins/* 중 kind 에 "channel" 없는 것 — service·trigger·
// observer·provider: dashboard·scheduler·file-watch·self-growth 등). 채널은 collectChannels 가
// "채널"로 담으니 여기선 제외(중복 방지). "플러그인"(external_plugin) 카테고리로 노출 —
// 이게 없어 홈 플러그인 0인 공개 설치에서 플러그인 섹션이 텅 비던 버그(2026-07-09).
const collectBundledPlugins = (repoRoot: string): PluginEntry[] => {
  const root = path.join(repoRoot, "plugins");
  const out: PluginEntry[] = [];
  for (const dir of safeReaddir(root)) {
    try {
      const pluginDir = path.resolve(root, dir);
      const pkg = safeReadJson(path.join(pluginDir, "package.json")) as
        | { tiguclaw?: Record<string, unknown>; description?: string }
        | undefined;
      const m = pkg?.tiguclaw as
        | { kind?: string | string[]; name?: string }
        | undefined;
      if (!m || typeof m !== "object") continue;
      const kinds = Array.isArray(m.kind)
        ? m.kind
        : m.kind !== undefined
          ? [m.kind]
          : [];
      if (kinds.includes("channel")) continue; // 채널은 collectChannels 담당.
      if (typeof m.name !== "string") continue;
      out.push({
        category: "external_plugin",
        layer: "in_tree", // appRoot 번들 — in-tree.
        name: m.name,
        description: pkg?.description,
        source: pluginDir,
        // 사용자 비활성(ADR 2026-07-17 §5.6 MVP) — loadPlugins 스킵 대상과 동일 판정.
        enabled: !isModuleDisabled(m.name),
        metadata: { kind: kinds.join(", ") },
      });
    } catch {
      // 한 plugin 실패 무시.
    }
  }
  return out;
};

// ─── (b) 외부 plugin ─────────────────────────────────────────────────────

const readEnabledPlugins = (repoRoot: string): Set<string> => {
  const enabled = new Set<string>();
  for (const file of ["settings.json", "settings.local.json"]) {
    const p = path.join(repoRoot, ".claude", file);
    const data = safeReadJson(p) as
      | { enabledPlugins?: Record<string, unknown> }
      | undefined;
    const ep = data?.enabledPlugins;
    if (!ep || typeof ep !== "object") continue;
    for (const [k, v] of Object.entries(ep)) {
      if (v) enabled.add(k);
    }
  }
  return enabled;
};

/** semver-aware 비교; 실패 시 lexical fallback. 단순+견고. */
const pickLatestVersion = (versions: string[]): string | undefined => {
  if (versions.length === 0) return undefined;
  const parsed = versions.map((v) => {
    const parts = v.replace(/^v/, "").split(".").map((s) => parseInt(s, 10));
    return { v, parts };
  });
  const allNumeric = parsed.every(
    (p) => p.parts.length > 0 && p.parts.every((n) => Number.isFinite(n)),
  );
  if (allNumeric) {
    parsed.sort((a, b) => {
      const len = Math.max(a.parts.length, b.parts.length);
      for (let i = 0; i < len; i += 1) {
        const ai = a.parts[i] ?? 0;
        const bi = b.parts[i] ?? 0;
        if (ai !== bi) return bi - ai;
      }
      return 0;
    });
    return parsed[0].v;
  }
  return [...versions].sort().reverse()[0];
};

/**
 * 2026-06-06 — `~/.claude/plugins/cache/` (Claude Code 마켓플레이스 캐시) walk 폐기.
 *  그 캐시는 Claude Code CLI 의 영역이지 tiguclaw 데몬이 발견·실행하지 않음 — 표시하면
 *  사용자 혼란 (예: 데몬과 무관한 "harness(비활성)" 가 외부 플러그인으로 보였던 사례).
 *  대신 tiguclaw 홈 플러그인 (`<home>/plugins/<plugin>/`) 의 package.json 메타데이터
 *  를 읽어 inventory 에 노출. 번들 플러그인 (`appRoot/plugins/`) 은 별도 walker
 *  (collectChannels 등) 가 카테고리별로 분해해 표시하므로 여기서 중복 listing X.
 */
const collectExternalPlugins = (): PluginEntry[] => {
  const homePluginsRoot = getPaths().commonPlugins;
  const out: PluginEntry[] = [];
  for (const name of safeReaddir(homePluginsRoot)) {
    try {
      if (name.startsWith(".") || name === "node_modules") continue;
      const pluginDir = path.join(homePluginsRoot, name);
      const pkg = safeReadJson(path.join(pluginDir, "package.json")) as
        | { name?: string; version?: string; description?: string }
        | undefined;
      const manifest = safeReadJson(
        path.join(pluginDir, ".tiguclaw-plugin", "plugin.json"),
      ) as { description?: string } | undefined;
      // 2026-06-06 — manifest 없는 디렉터리는 플러그인 아님 (옛 컨벤션 잔재 차단).
      //  진짜 플러그인은 package.json 또는 .tiguclaw-plugin/plugin.json 가 있어야.
      if (pkg === undefined && manifest === undefined) continue;
      const description = manifest?.description ?? pkg?.description;
      out.push({
        category: "external_plugin",
        layer: "discovered",
        name: pkg?.name ?? name,
        description,
        source: pluginDir,
        enabled: true,
        metadata:
          pkg?.version !== undefined ? { version: pkg.version } : undefined,
      });
    } catch {
      // 한 plugin 실패 무시.
    }
  }
  return out;
};

// ─── (c)(d) 스킬 / 에이전트 ──────────────────────────────────────────────

const collectFrontmatterFiles = (
  category: "skill" | "agent",
  bases: { dir: string; layer: PluginLayer }[],
  pattern: "skill" | "agent",
): PluginEntry[] => {
  const out: PluginEntry[] = [];
  for (const { dir: base, layer } of bases) {
    try {
      if (!fs.existsSync(base)) continue;
      if (pattern === "skill") {
        // <base>/<dir>/SKILL.md
        for (const dir of safeReaddir(base)) {
          try {
            const skillFile = path.join(base, dir, "SKILL.md");
            if (!fs.existsSync(skillFile)) continue;
            const fm = parseFrontmatter(skillFile);
            out.push({
              category,
              layer,
              name: fm.name ?? dir,
              description: fm.description,
              source: skillFile,
              enabled: true,
            });
          } catch {
            // 한 entry 실패 무시.
          }
        }
      } else {
        // agent: <base>/<file>.md
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(base, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const ent of entries) {
          try {
            if (!ent.isFile() || !ent.name.endsWith(".md")) continue;
            const filePath = path.join(base, ent.name);
            const fm = parseFrontmatter(filePath);
            const fallbackName = ent.name.replace(/\.md$/, "");
            out.push({
              category,
              layer,
              name: fm.name ?? fallbackName,
              description: fm.description,
              source: filePath,
              enabled: true,
            });
          } catch {
            // 한 entry 실패 무시.
          }
        }
      }
    } catch {
      // 한 base 실패 무시.
    }
  }
  return out;
};

/**
 * 2026-06-06 — 데몬 발견 경로(discoverSkills)와 일치. 옛 `.claude/skills` walk 는
 *  데몬 런타임이 안 보는 dev-team 자산이라 inventory 에서 노출하면 두 시스템이 어긋남
 *  (사용자가 보는 /plugins 와 실제 invocable 능력이 다름). discoverSkills 는
 *  builtin(appRoot) · user(<home>) · project(<cwd>) · plugin(번들+홈) 모두 자연 회수.
 *
 * source → layer 매핑:
 *  - builtin → meta_infra (1st-party 부트스트랩)
 *  - user → discovered (홈 설치)
 *  - project → in_tree (현재 작업 폴더)
 *  - plugin → discovered (플러그인 자산)
 */
const sourceToLayer = (source: string): PluginLayer => {
  switch (source) {
    case "builtin":
      return "meta_infra";
    case "project":
      return "in_tree";
    default:
      return "discovered"; // user / plugin
  }
};

const collectSkills = async (cwd: string): Promise<PluginEntry[]> => {
  const skills = await discoverSkills(cwd);
  return skills.map((s) => ({
    category: "skill" as const,
    layer: sourceToLayer(s.source),
    name: s.name,
    description: s.description,
    source: s.filePath,
    enabled: true,
    metadata: s.pluginId !== undefined ? { pluginId: s.pluginId } : undefined,
  }));
};

// ─── 컨텍스트메뉴 외부 기여 (스킬 frontmatter) ────────────────────────────
// `_workspace/context-menu_architect_contract.md` §2.3 Phase 3. 스킬 discovery
// (discoverSkills — 이미 builtin/user/project/plugin 4 source 를 회수)를 그대로 타고,
// 각 스킬의 SKILL.md 를 위 확장된 parseFrontmatter 로 다시 읽어 `context-menu` 선언만
// 뽑는다. 스킬 목록 재-walk 0(discoverSkills 단일 진실원 재사용) — 새 디렉터리 순회
// 로직 추가 X.

export interface ContextMenuContribution {
  skillName: string;
  items: ContextMenuItemRaw[];
}

/**
 * 외부 기여 action 화이트리스트(계약 §2.4 보안). `endpoint`/`builtin` = 빌트인 전용 —
 * 외부 데이터에서 이 값이 나오면(향후 플러그인 매니페스트 기여 확장 대비 방어선) drop.
 * 스킬 기여는 애초에 action 을 frontmatter 에서 읽지 않으므로(항상 invoke_skill 고정)
 * 구조적으로 이미 안전 — 이 화이트리스트는 집계기(http-bridge)가 최종 항목을 만들 때
 * 통과시키는 defense-in-depth 체크포인트.
 */
export const CONTEXT_MENU_EXTERNAL_ACTION_WHITELIST = [
  "send_message",
  "invoke_skill",
  "navigate",
] as const;
export type ContextMenuExternalActionKind =
  (typeof CONTEXT_MENU_EXTERNAL_ACTION_WHITELIST)[number];

export const isWhitelistedContextMenuAction = (
  kind: string,
): kind is ContextMenuExternalActionKind =>
  (CONTEXT_MENU_EXTERNAL_ACTION_WHITELIST as readonly string[]).includes(kind);

/**
 * 전 스킬(4 source)을 discoverSkills 로 열거 → 각 SKILL.md frontmatter 의
 * `context-menu` 선언만 파싱해 반환. 항목 없는 스킬은 결과에서 제외. 한 스킬 실패가
 * 다른 스킬을 막지 않음(격리 try/catch), 전체 실패 시 빈 배열(never-throw).
 */
export const collectContextMenuContributions = async (
  cwd?: string,
): Promise<ContextMenuContribution[]> => {
  try {
    const skills = await discoverSkills(cwd ?? appRoot());
    const out: ContextMenuContribution[] = [];
    for (const s of skills) {
      try {
        const fm = parseFrontmatter(s.filePath);
        if (fm.contextMenu && fm.contextMenu.length > 0) {
          out.push({ skillName: s.name, items: fm.contextMenu });
        }
      } catch {
        // 한 스킬 실패 — 무시(격리).
      }
    }
    return out;
  } catch {
    return [];
  }
};

const collectAgents = async (cwd: string): Promise<PluginEntry[]> => {
  const agents = await discoverAgents(cwd);
  return agents.map((a) => {
    // 모델 티어(high/mid/low 또는 provider:model)를 메타에 노출 — 대시보드 에이전트 카드 표시.
    const meta: Record<string, unknown> = {};
    if (a.pluginId !== undefined) meta.pluginId = a.pluginId;
    if (a.model !== undefined && a.model !== "") meta.model = a.model;
    return {
      category: "agent" as const,
      layer: sourceToLayer(a.source),
      name: a.name,
      description: a.description,
      source: a.filePath,
      enabled: true,
      metadata: Object.keys(meta).length > 0 ? meta : undefined,
    };
  });
};

// ─── (e) MCP — 세 source ─────────────────────────────────────────────────

const collectMcp = async (repoRoot: string): Promise<PluginEntry[]> => {
  const out: PluginEntry[] = [];

  // <repoRoot>/.mcp.json 과 <home>/mcp.json 은 동일 shape(mcpServers 맵) — 한 헬퍼로 처리.
  const collectFromMcpFile = (file: string): void => {
    try {
      const mcpJson = safeReadJson(file) as
        | { mcpServers?: Record<string, Record<string, unknown>> }
        | undefined;
      const servers = mcpJson?.mcpServers;
      if (servers && typeof servers === "object") {
        for (const [name, cfg] of Object.entries(servers)) {
          try {
            out.push({
              category: "mcp",
              layer: "discovered", // 외부 server — 우리가 spawn/연결만, 소유 X
              name,
              source: file,
              enabled: true,
              metadata: { ...cfg, inProcess: false, external: true },
            });
          } catch {
            // 한 server 실패 무시.
          }
        }
      }
    } catch {
      // 파일 부재/손상 무시.
    }
  };

  // (i) <repoRoot>/.mcp.json — Claude Code 호환 정적 config.
  collectFromMcpFile(path.join(repoRoot, ".mcp.json"));

  // (ii) <home>/mcp.json — 비서가 add_mcp_server 로 등록한 외부 MCP 서버(런타임 동적 연결).
  // external-mcp.ts 가 쓰는 파일과 동일 경로·shape(getPaths().home). 부팅이 연결하므로
  // 인벤토리에 노출해야 한다(예: mcp-unity). 이게 빠져 연결된 외부 MCP 가 목록에 안 뜨던 버그.
  try {
    collectFromMcpFile(path.join(getPaths().home, "mcp.json"));
  } catch {
    // getPaths 실패 등 — 무시(다른 source 는 계속).
  }

  // (iii) in-process MCP — contract §결정 5 에 따라 hardcode (memory.ts import X,
  // 단방향 보장: memory.ts 가 inventory.ts 를 import). server name "memory" 와
  // memory CRUD + search + list_installed_plugins = 6 도구.
  try {
    out.push({
      category: "mcp",
      layer: "in_tree", // in-process — 우리가 직접 구현·소유 (개발 레포 안에 위치)
      name: "memory",
      source: "in-process:memory",
      enabled: true,
      metadata: {
        tools: [
          "read_memory",
          "search_memory",
          "add_memory",
          "update_memory",
          "delete_memory",
          "list_installed_plugins",
        ],
        inProcess: true,
      },
    });
  } catch {
    // 무시.
  }

  return out;
};

// ─── (f) 엔드포인트 — 능력(데이터) 축 (ADR 2026-07-17-module-capability-model P4c) ────────

/**
 * 슬래시 명령의 HTTP 판 — `discoverEndpoints`(endpoint-registry.ts, 진실 소스)를 그대로
 * 재사용(신규 walk 로직 0). endpoint-registry 는 inventory.ts 를 역참조하지 않음(단방향
 * import 유지 — 파일 상단 주석 §0 준수, memory.ts → inventory.ts 방향과 동일 결).
 *  - layer: user/project(개발 레포·홈이 직접 들고 있는 정의) → in_tree, plugin(번들/설치
 *    플러그인 산 정의) → discovered. skill/agent 의 sourceToLayer 와 소스 종류가 달라
 *    (endpoint 엔 builtin 이 없음) 별도 매핑.
 *  - enabled: 항상 true (V1 — skill/agent 동형, settings.modules.disabled 대상 아님).
 */
const endpointSourceToLayer = (source: Endpoint["source"]): PluginLayer =>
  source === "plugin" ? "discovered" : "in_tree"; // user | project

const collectEndpoints = async (cwd: string): Promise<PluginEntry[]> => {
  const endpoints = await discoverEndpoints(cwd);
  return endpoints.map((ep) => ({
    category: "endpoint" as const,
    layer: endpointSourceToLayer(ep.source),
    name: ep.name,
    description: ep.desc || ep.label || ep.routePath,
    source: ep.filePath,
    enabled: true,
    metadata: {
      routePath: ep.routePath,
      method: ep.method,
      role: ep.role,
      mode: ep.mode,
      source: ep.source,
    },
  }));
};

// ─── (g) 커맨드 — 능력(데이터) 축: 슬래시 명령 모음 ────────────────────────────
//
// 빌트인(코드 등록 코어 명령: /models·/update·/status …) = meta_infra, 유저/프로젝트/
// 플러그인 `<home>/commands/*.md`(discoverCommands, 진실 소스 재사용 — 신규 walk 0) =
// in_tree/discovered. ★비서 트리거 아님(사용자 단축키) — enabled 항상 true(비활성 개념 밖).
// command-registry 는 inventory 를 역참조 안 함(단방향 §0 유지).
const commandSourceToLayer = (source: Command["source"]): PluginLayer =>
  source === "plugin" ? "discovered" : "in_tree"; // user | project

const collectCommands = async (cwd: string): Promise<PluginEntry[]> => {
  const out: PluginEntry[] = [];
  // 빌트인 슬래시 명령(코드 등록·항상 존재) — meta_infra.
  for (const c of BUILTIN_COMMANDS) {
    out.push({
      category: "command" as const,
      layer: "meta_infra",
      name: c.name,
      description: c.description,
      source: "builtin:command",
      enabled: true,
      metadata: { builtin: true },
    });
  }
  // 유저/프로젝트/플러그인 슬래시 명령(.md).
  const discovered = await discoverCommands(cwd);
  for (const c of discovered) {
    out.push({
      category: "command" as const,
      layer: commandSourceToLayer(c.source),
      name: c.name,
      description: c.description,
      source: c.filePath,
      enabled: true,
      metadata: {
        source: c.source,
        ...(c.pluginId !== undefined ? { pluginId: c.pluginId } : {}),
      },
    });
  }
  return out;
};

// ─── 통합 walker ─────────────────────────────────────────────────────────

export const collectInventory = async (opts?: {
  repoRoot?: string;
  homeDir?: string;
}): Promise<InventoryResult> => {
  // α (2026-05-25): plugins·.mcp.json 루트를 appRoot 로 정정 (앱 배포 아티팩트).
  //  결정 A: .mcp.json 은 appRoot 단일 (home 머지는 별도 라운드). dev=레포=cwd 동치라
  //  회귀 0. opts.repoRoot 명시 호출은 그대로 존중 (collectInventory({repoRoot}) 테스트·격리).
  const repoRoot = path.resolve(opts?.repoRoot ?? appRoot());
  const homeDir = opts?.homeDir ?? os.homedir();

  // 5 영역 격리 — 한 영역 throw 가 다른 영역 막지 X.
  const safe = <T>(fn: () => T, fallback: T): T => {
    try {
      return fn();
    } catch {
      return fallback;
    }
  };
  const safeAsync = async <T>(fn: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await fn();
    } catch {
      return fallback;
    }
  };

  const channel = safe(() => collectChannels(repoRoot), [] as PluginEntry[]);
  // "플러그인"(external_plugin) = 번들 비채널 플러그인(appRoot) + 홈 플러그인. 이름 중복 제거
  // (번들 우선 — 데몬이 appRoot 에서 로드하는 canonical). 이게 없어 공개 설치서 텅 비던 버그.
  const external_plugin = safe(() => {
    const bundled = collectBundledPlugins(repoRoot);
    const home = collectExternalPlugins();
    const seen = new Set<string>();
    const merged: PluginEntry[] = [];
    for (const e of [...bundled, ...home]) {
      if (seen.has(e.name)) continue;
      seen.add(e.name);
      merged.push(e);
    }
    return merged;
  }, [] as PluginEntry[]);
  const skill = await safeAsync(
    () => collectSkills(repoRoot),
    [] as PluginEntry[],
  );
  const agent = await safeAsync(
    () => collectAgents(repoRoot),
    [] as PluginEntry[],
  );
  const mcp = await safeAsync(
    () => collectMcp(repoRoot),
    [] as PluginEntry[],
  );
  const endpoint = await safeAsync(
    () => collectEndpoints(repoRoot),
    [] as PluginEntry[],
  );
  const command = await safeAsync(
    () => collectCommands(repoRoot),
    [] as PluginEntry[],
  );

  return {
    channel,
    external_plugin,
    skill,
    agent,
    mcp,
    endpoint,
    command,
    generatedAt: Date.now(),
  };
};

// ─── 포맷터 ──────────────────────────────────────────────────────────────

const LLM_CAP_BYTES = 4096;
const USER_CAP_BYTES = 3072;

const formatEntryLine = (
  e: PluginEntry,
  showEnabledMark: boolean,
): string => {
  const mark = showEnabledMark ? (e.enabled ? "[+] " : "[-] ") : "";
  const desc = e.description ? ` — ${e.description}` : "";
  let suffix = "";
  if (e.category === "external_plugin") {
    const md = e.metadata as { vendor?: string; version?: string } | undefined;
    if (md?.vendor && md?.version) {
      suffix = ` (${md.vendor}@${md.version})`;
    }
  } else if (e.category === "mcp") {
    const md = e.metadata as { inProcess?: boolean; tools?: string[] } | undefined;
    if (md?.inProcess) {
      const n = md.tools?.length ?? 0;
      suffix = ` (in-process, 도구 ${n}개)`;
    }
  }
  return `- ${mark}${e.name}${suffix}${desc}`;
};

const totalEntries = (inv: InventoryResult): number =>
  inv.channel.length +
  inv.external_plugin.length +
  inv.skill.length +
  inv.agent.length +
  inv.mcp.length;

const buildCategorySection = (
  header: string,
  entries: PluginEntry[],
  showEnabledMark: boolean,
): string[] => {
  if (entries.length === 0) return [];
  const enabledCount = entries.filter((e) => e.enabled).length;
  const headerLine = showEnabledMark
    ? `### ${header} (${entries.length}개, ${enabledCount}개 활성)`
    : `### ${header} (${entries.length}개)`;
  const lines = [headerLine];
  for (const e of entries) lines.push(formatEntryLine(e, showEnabledMark));
  return lines;
};

/** layer 안에서 카테고리별 sub-섹션을 빌드. 카테고리 자체가 비면 sub-섹션 생략. */
const buildLayerBody = (
  inv: InventoryResult,
  layer: PluginLayer,
): string[] => {
  const filterByLayer = <T extends PluginEntry>(arr: T[]): T[] =>
    arr.filter((e) => e.layer === layer);

  const channel = filterByLayer(inv.channel);
  const ext = filterByLayer(inv.external_plugin);
  const skill = filterByLayer(inv.skill);
  const agent = filterByLayer(inv.agent);
  const mcp = filterByLayer(inv.mcp);

  const out: string[] = [];
  if (channel.length > 0) out.push(...buildCategorySection("채널", channel, false), "");
  if (ext.length > 0) out.push(...buildCategorySection("외부 플러그인", ext, true), "");
  if (skill.length > 0) out.push(...buildCategorySection("스킬", skill, false), "");
  if (agent.length > 0) out.push(...buildCategorySection("에이전트", agent, false), "");
  if (mcp.length > 0) {
    const inProc = mcp.filter(
      (e) => (e.metadata as { inProcess?: boolean } | undefined)?.inProcess,
    ).length;
    const e2 = mcp.length - inProc;
    out.push(
      `### MCP 서버 (${mcp.length}개, in-process ${inProc} / 외부 ${e2})`,
    );
    for (const e of mcp) out.push(formatEntryLine(e, false));
    out.push("");
  }
  return out;
};

const layerTotal = (inv: InventoryResult, layer: PluginLayer): number => {
  const all = [
    ...inv.channel,
    ...inv.external_plugin,
    ...inv.skill,
    ...inv.agent,
    ...inv.mcp,
  ];
  return all.filter((e) => e.layer === layer).length;
};

const capWithEllipsis = (text: string, capBytes: number): string => {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= capBytes) return text;
  // 줄 단위 절단
  const lines = text.split("\n");
  const kept: string[] = [];
  let used = 0;
  for (const ln of lines) {
    const lnBytes = Buffer.byteLength(ln + "\n", "utf8");
    if (used + lnBytes > capBytes - 32) break;
    kept.push(ln);
    used += lnBytes;
  }
  kept.push("…(중략)");
  return kept.join("\n");
};

/**
 * layer 그룹 → 카테고리 sub-섹션 2단 구조.
 * 빈 layer 는 섹션 자체 생략 (사용자 멘탈 모델 잡음 회피).
 */
const buildLayeredBody = (inv: InventoryResult): string[] => {
  const out: string[] = [];

  const meta = layerTotal(inv, "meta_infra");
  if (meta > 0) {
    out.push(`## 메타 인프라 (tiguclaw 코어 의존, ${meta}건)`);
    out.push(...buildLayerBody(inv, "meta_infra"));
  }

  const inTree = layerTotal(inv, "in_tree");
  if (inTree > 0) {
    out.push(`## 개발 레포 in-tree (tiguclaw 개발 레포가 직접 들고 있는 dogfood, ${inTree}건)`);
    out.push(...buildLayerBody(inv, "in_tree"));
  }

  const discovered = layerTotal(inv, "discovered");
  if (discovered > 0) {
    out.push(`## 발견된 능력 (외부 install, 자동 발견 사용 가능, ${discovered}건)`);
    out.push(...buildLayerBody(inv, "discovered"));
  }

  return out;
};

export const formatInventoryForLlm = (inv: InventoryResult): string => {
  const total = totalEntries(inv);
  const out: string[] = [
    `# tiguclaw 플러그인 인벤토리 (총 ${total}건)`,
    "",
    ...buildLayeredBody(inv),
  ];
  return capWithEllipsis(out.join("\n"), LLM_CAP_BYTES);
};

/**
 * 사용자용 compact 포맷 (2026-06-06) — `/plugins` 명령 출력.
 *  - 카테고리별 한 줄, 이름들을 `·` 로 join.
 *  - description·layer 헤더·[+]/[-] 마커 제거 (장황함 차단).
 *  - 외부 플러그인 비활성은 `(비활성)` 접미사로 표시. 그 외는 모두 활성 가정 (조용).
 *  - MCP 만 in-process 갯수 보조 표기 (의미 있음).
 * 자세한 본문(layer 분리·description)이 필요하면 사용자가 LLM 에게 물어보면
 * `formatInventoryForLlm`(메모리 인벤토리 도구)이 제공.
 */
export const formatInventoryForUser = (inv: InventoryResult): string => {
  const total = totalEntries(inv);
  const compactLine = (name: string, entries: PluginEntry[]): string | null => {
    if (entries.length === 0) return null;
    const names = entries.map((e) =>
      e.category === "external_plugin" && e.enabled === false
        ? `${e.name}(비활성)`
        : e.name,
    );
    return `${name} (${entries.length}): ${names.join(" · ")}`;
  };

  const lines: string[] = [`tiguclaw 플러그인 (총 ${total}건)`, ""];

  const ch = compactLine("채널", inv.channel);
  if (ch !== null) lines.push(ch);

  const sk = compactLine("스킬", inv.skill);
  if (sk !== null) lines.push(sk);

  const ag = compactLine("에이전트", inv.agent);
  if (ag !== null) lines.push(ag);

  if (inv.mcp.length > 0) {
    const inProc = inv.mcp.filter(
      (e) => (e.metadata as { inProcess?: boolean } | undefined)?.inProcess,
    ).length;
    const suffix = inProc > 0 ? ` (in-proc ${inProc})` : "";
    lines.push(
      `MCP (${inv.mcp.length})${suffix}: ${inv.mcp.map((e) => e.name).join(" · ")}`,
    );
  }

  const ex = compactLine("외부 플러그인", inv.external_plugin);
  if (ex !== null) lines.push(ex);

  return capWithEllipsis(lines.join("\n"), USER_CAP_BYTES);
};
