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

export type PluginCategory =
  | "channel"
  | "external_plugin"
  | "skill"
  | "agent"
  | "mcp";

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
  generatedAt: number;
}

// ─── 내부 유틸 ───────────────────────────────────────────────────────────

/** frontmatter `name`/`description` 만 정규식 추출. 외부 yaml lib 0. */
const parseFrontmatter = (
  filePath: string,
): { name?: string; description?: string } => {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!m) return {};
    const out: { name?: string; description?: string } = {};
    for (const line of m[1].split(/\r?\n/)) {
      const kv = line.match(/^(name|description)\s*:\s*(.+?)\s*$/);
      if (!kv) continue;
      const key = kv[1] as "name" | "description";
      let val = kv[2];
      // 인용부호 제거
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      out[key] = val;
    }
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
        kind?: string;
        name?: string;
        schemaVersion?: number;
        entry?: string;
      };
      if (marker.kind !== "channel") continue;
      if (typeof marker.name !== "string") continue;
      out.push({
        category: "channel",
        layer: "in_tree", // <repo>/plugins/* — 위치 자체가 in-tree dogfood
        name: marker.name,
        source: pluginDir,
        enabled: true,
        metadata: {
          kind: marker.kind,
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
  // V3 4 도구 + 본 라운드 신규 1 도구 = 5 도구.
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
  const external_plugin = safe(
    () => collectExternalPlugins(),
    [] as PluginEntry[],
  );
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

  return {
    channel,
    external_plugin,
    skill,
    agent,
    mcp,
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
