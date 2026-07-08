/**
 * 외부 MCP 서버 동적 연결 — `<home>/mcp.json` (파일=진실, 비서가 씀·부팅/턴이 읽음).
 *
 * 진실 소스 ADR: docs/decisions/2026-07-07-external-mcp-dynamic-connect.md.
 * 표준 MCP config 형태(`.mcp.json` 동형, inventory.ts 가 이미 읽는 shape — 커스텀 DSL 0):
 *   { "mcpServers": {
 *       "github": { "command": "npx", "args": [...], "env": {...} },   // stdio
 *       "docs":   { "type": "sse", "url": "https://..." }              // sse
 *   } }
 *
 * ★역할 분리:
 *  - claude 어댑터 = 이 config 를 SDK `options.mcpServers` 유니온에 *그대로* 주입(네이티브 연결).
 *  - codex/openai 어댑터 = `@modelcontextprotocol/sdk` 클라이언트로 spawn+연결 후 브리지(Phase 2).
 *  - 코어(add/list/remove 도구)는 파일만 다룬다 — 연결은 어댑터가. 단방향(코어→플러그인 참조 0).
 *
 * 견고성: 읽기 실패/손상 → 빈 맵(never-throw). 데몬 생존 우선(원칙 #3).
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { MCPServer } from "@openai/agents-core";
import { getPaths } from "./paths.js";

/** stdio 서버 config (claude McpStdioServerConfig 동형). */
export interface StdioMcpConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}
/** sse 서버 config (claude McpSSEServerConfig 동형). */
export interface SseMcpConfig {
  type: "sse";
  url: string;
  headers?: Record<string, string>;
}
export type ExternalMcpConfig = StdioMcpConfig | SseMcpConfig;

interface McpJsonFile {
  mcpServers?: Record<string, ExternalMcpConfig>;
}

const mcpJsonPath = (): string => path.join(getPaths().home, "mcp.json");

// ─── 프로젝트 스코프 MCP (ADR 2026-07-08) ────────────────────────────────────
// 전역 = <home>/mcp.json (크로스-프로젝트). 프로젝트 = <cwd>/.mcp.json (Claude Code 파리티,
// 그 프로젝트 위임 턴에만). 마스터/비프로젝트 턴(cwd 미지정) = 전역만.
const projectMcpPath = (cwd: string): string => path.join(cwd, ".mcp.json");

/**
 * cwd 가 프로젝트 스코프 대상인가 — 지정됨 + 홈 아님(홈은 전역 mcp.json 소유). 어댑터가
 * "프로젝트 위임 서브/워커면 외부 MCP 를 읽는다" 게이트로도 사용(export).
 */
export const isProjectMcpCwd = (cwd?: string): cwd is string => {
  if (cwd === undefined || cwd === "") return false;
  try {
    return path.resolve(cwd) !== path.resolve(getPaths().home);
  } catch {
    return false;
  }
};

/** 한 mcp.json/.mcp.json 파일의 mcpServers 읽기 — 부재/손상 시 빈 맵(throw 0). */
const readMcpFile = async (
  file: string,
): Promise<Record<string, ExternalMcpConfig>> => {
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw) as McpJsonFile;
    const servers = parsed?.mcpServers;
    if (servers === undefined || servers === null || typeof servers !== "object") {
      return {};
    }
    return servers;
  } catch {
    return {}; // 부재/손상/JSON 오류 — 빈 맵(데몬 생존).
  }
};

// upsert/remove 대상 파일 — projectPath 지정 시 <projectPath>/.mcp.json, 아니면 <home>/mcp.json.
const resolveWriteFile = (projectPath?: string): string =>
  projectPath !== undefined && projectPath !== ""
    ? projectMcpPath(projectPath)
    : mcpJsonPath();

/**
 * 외부 MCP server 맵 — 전역 <home>/mcp.json + (cwd 가 프로젝트면) <cwd>/.mcp.json 병합.
 * 프로젝트가 같은 이름을 덮어쓴다(더 구체적). claude 어댑터가 네이티브 config 로 사용.
 * cwd 미지정/홈(마스터·비프로젝트 턴) = 전역만(회귀 0).
 */
export const readExternalMcpServers = async (
  cwd?: string,
): Promise<Record<string, ExternalMcpConfig>> => {
  const global = await readMcpFile(mcpJsonPath());
  if (!isProjectMcpCwd(cwd)) return global;
  const project = await readMcpFile(projectMcpPath(cwd));
  return { ...global, ...project }; // 프로젝트 우선.
};

/** 프로젝트 <cwd>/.mcp.json 만(전역 제외) — project_capabilities 표시용. */
export const readProjectMcpServers = async (
  cwd: string,
): Promise<Record<string, ExternalMcpConfig>> => {
  if (!isProjectMcpCwd(cwd)) return {};
  return readMcpFile(projectMcpPath(cwd));
};

/** name→config upsert 후 파일 저장(디렉터리 ensure). projectPath = 프로젝트 .mcp.json 대상. */
export const upsertExternalMcpServer = async (
  name: string,
  config: ExternalMcpConfig,
  projectPath?: string,
): Promise<void> => {
  const file = resolveWriteFile(projectPath);
  const servers = await readMcpFile(file);
  servers[name] = config;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`, "utf8");
};

/** name 제거 후 저장. 존재 여부 반환. projectPath = 프로젝트 .mcp.json 대상. */
export const removeExternalMcpServer = async (
  name: string,
  projectPath?: string,
): Promise<boolean> => {
  const file = resolveWriteFile(projectPath);
  const servers = await readMcpFile(file);
  if (!(name in servers)) return false;
  delete servers[name];
  await fs.writeFile(file, `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`, "utf8");
  return true;
};

/** 사람이 읽는 한 줄 요약(list 도구·로그용). */
export const describeExternalMcpConfig = (
  name: string,
  c: ExternalMcpConfig,
): string =>
  "type" in c && c.type === "sse"
    ? `${name} (sse: ${c.url})`
    : `${name} (stdio: ${(c as StdioMcpConfig).command}${(c as StdioMcpConfig).args?.length ? " " + (c as StdioMcpConfig).args!.join(" ") : ""})`;

// ─── codex/openai 어댑터용 브리지 (Phase 2, ADR §1d) ─────────────────────────
// claude 는 SDK 네이티브(config 를 options.mcpServers 로)라 이 경로를 안 탄다.
// codex/openai 는 @mcp/sdk Client 로 외부 서버를 spawn+연결 → @openai/agents MCPServer
// shape 로 래핑(adaptClaudeMcpServer 동형, 단 소스가 in-process 아닌 외부 프로세스).
//
// ★persistent: 모듈 캐시로 *한 번만* 연결하고 턴을 가로질러 재사용(매 턴 spawn 낭비 0).
// bridge.close()=no-op → 어댑터의 per-turn 일괄 close 가 외부 연결을 끊지 않게(핵심).
// 실제 종료는 데몬 shutdown 의 closeAllExternalMcp 만. 연결 실패 서버는 skip+로그(격리, #3).

const MCP_CALL_TIMEOUT_MS = ((): number => {
  const raw = process.env.MCP_CALL_TIMEOUT_MS;
  const n = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isInteger(n) && n > 0 ? n : 660_000; // _mcp-bridge 와 동일 정책.
})();

type MCPTool = Awaited<ReturnType<MCPServer["listTools"]>>[number];
type CallToolResultContent = Awaited<ReturnType<MCPServer["callTool"]>>;

interface CachedExt {
  server: MCPServer;
  realClose: () => Promise<void>;
}
const cache = new Map<string, CachedExt>(); // 전역: name → bridge.
let connectPromise: Promise<void> | null = null;
// 프로젝트 스코프: projectPath(resolved) → (name → bridge). 지연연결·종료까지 캐시(축출 없음).
const projectCache = new Map<string, Map<string, CachedExt>>();
const projectConnect = new Map<string, Promise<void>>();

const buildEnv = (extra?: Record<string, string>): Record<string, string> => {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) base[k] = v;
  return { ...base, ...(extra ?? {}) };
};

const connectOne = async (
  name: string,
  config: ExternalMcpConfig,
): Promise<CachedExt> => {
  const client = new Client(
    { name: `tiguclaw-ext-${name}`, version: "1.0.0" },
    { capabilities: {} },
  );
  const transport =
    "type" in config && config.type === "sse"
      ? new SSEClientTransport(new URL(config.url))
      : new StdioClientTransport({
          command: (config as StdioMcpConfig).command,
          args: (config as StdioMcpConfig).args,
          env: buildEnv((config as StdioMcpConfig).env),
        });
  await client.connect(transport); // 실제 프로세스 spawn(stdio) 또는 SSE 연결.
  const server: MCPServer = {
    cacheToolsList: true,
    get name() {
      return name;
    },
    async connect() {
      /* 이미 연결됨(persistent) — no-op */
    },
    async close() {
      /* ★no-op — per-turn 일괄 close 가 외부 연결을 끊지 않게. 실종료=closeAllExternalMcp. */
    },
    async listTools(): Promise<MCPTool[]> {
      const res = await client.listTools();
      return res.tools as unknown as MCPTool[];
    },
    async callTool(
      toolName: string,
      args: Record<string, unknown> | null,
    ): Promise<CallToolResultContent> {
      const res = await client.callTool(
        { name: toolName, arguments: args ?? {} },
        undefined,
        { timeout: MCP_CALL_TIMEOUT_MS },
      );
      return res.content as CallToolResultContent;
    },
    async invalidateToolsCache() {
      /* cache 미사용 */
    },
  };
  return { server, realClose: () => client.close() };
};

const doConnectAll = async (): Promise<void> => {
  const servers = await readExternalMcpServers();
  for (const [name, config] of Object.entries(servers)) {
    try {
      cache.set(name, await connectOne(name, config));
      console.log(`external-mcp: '${name}' 연결됨 (${describeExternalMcpConfig(name, config)}).`);
    } catch (e) {
      // 격리 — 한 서버 실패가 나머지·데몬을 죽이지 않게(#3).
      console.error(
        `external-mcp: '${name}' 연결 실패 — skip (${e instanceof Error ? e.message : String(e)}).`,
      );
    }
  }
};

// 프로젝트 <cwd>/.mcp.json server 들을 지연 연결(그 프로젝트 첫 사용 턴). 격리 스킵.
const doConnectProject = async (projectPath: string): Promise<void> => {
  const servers = await readMcpFile(projectMcpPath(projectPath));
  const map = new Map<string, CachedExt>();
  for (const [name, config] of Object.entries(servers)) {
    try {
      map.set(name, await connectOne(name, config));
      console.log(
        `external-mcp: [project ${projectPath}] '${name}' 연결됨 (${describeExternalMcpConfig(name, config)}).`,
      );
    } catch (e) {
      console.error(
        `external-mcp: [project ${projectPath}] '${name}' 연결 실패 — skip (${e instanceof Error ? e.message : String(e)}).`,
      );
    }
  }
  projectCache.set(projectPath, map);
};

/**
 * codex/openai 어댑터가 호출 — 연결된 외부 MCP 브리지 목록(persistent, 캐시). 최초 1회
 * 연결하고 재사용. 동시 최초호출은 connectPromise 로 단일화(중복 spawn 0).
 * cwd 가 프로젝트면 그 프로젝트 <cwd>/.mcp.json 브리지를 지연연결해 전역에 더한다(프로젝트
 * 우선 — 같은 이름이면 전역 대신 프로젝트). 마스터/비프로젝트 턴(cwd 미지정) = 전역만.
 */
export const getConnectedExternalMcpBridges = async (
  cwd?: string,
): Promise<MCPServer[]> => {
  if (connectPromise === null) connectPromise = doConnectAll();
  await connectPromise;
  const globalBridges = [...cache.values()].map((c) => c.server);
  if (!isProjectMcpCwd(cwd)) return globalBridges;
  const key = path.resolve(cwd);
  if (!projectConnect.has(key)) projectConnect.set(key, doConnectProject(key));
  await projectConnect.get(key);
  const pm = projectCache.get(key);
  if (pm === undefined || pm.size === 0) return globalBridges;
  const names = new Set(pm.keys());
  return globalBridges
    .filter((s) => !names.has(s.name)) // 프로젝트가 같은 이름을 덮어씀.
    .concat([...pm.values()].map((c) => c.server));
};

/** 데몬 shutdown 시 외부 MCP 프로세스 실제 종료(orphan 0). 전역 + 프로젝트 캐시 모두. */
export const closeAllExternalMcp = async (): Promise<void> => {
  const closeMap = async (m: Map<string, CachedExt>): Promise<void> => {
    for (const c of m.values()) {
      try {
        await c.realClose();
      } catch {
        /* 이미 죽었을 수 있음 */
      }
    }
    m.clear();
  };
  await closeMap(cache);
  for (const pm of projectCache.values()) await closeMap(pm);
  projectCache.clear();
  projectConnect.clear();
  connectPromise = null;
};
