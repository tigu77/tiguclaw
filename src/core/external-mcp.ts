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

/** `<home>/mcp.json` 읽기 — 부재/손상 시 빈 맵(throw 0). */
export const readExternalMcpServers = async (): Promise<
  Record<string, ExternalMcpConfig>
> => {
  try {
    const raw = await fs.readFile(mcpJsonPath(), "utf8");
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

/** name→config upsert 후 파일 저장(디렉터리 ensure). */
export const upsertExternalMcpServer = async (
  name: string,
  config: ExternalMcpConfig,
): Promise<void> => {
  const servers = await readExternalMcpServers();
  servers[name] = config;
  const abs = mcpJsonPath();
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`, "utf8");
};

/** name 제거 후 저장. 존재 여부 반환. */
export const removeExternalMcpServer = async (name: string): Promise<boolean> => {
  const servers = await readExternalMcpServers();
  if (!(name in servers)) return false;
  delete servers[name];
  await fs.writeFile(
    mcpJsonPath(),
    `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`,
    "utf8",
  );
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
const cache = new Map<string, CachedExt>();
let connectPromise: Promise<void> | null = null;

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

/**
 * codex/openai 어댑터가 호출 — 연결된 외부 MCP 브리지 목록(persistent, 캐시). 최초 1회
 * 연결하고 재사용. 동시 최초호출은 connectPromise 로 단일화(중복 spawn 0).
 */
export const getConnectedExternalMcpBridges = async (): Promise<MCPServer[]> => {
  if (connectPromise === null) connectPromise = doConnectAll();
  await connectPromise;
  return [...cache.values()].map((c) => c.server);
};

/** 데몬 shutdown 시 외부 MCP 프로세스 실제 종료(orphan 0). */
export const closeAllExternalMcp = async (): Promise<void> => {
  for (const c of cache.values()) {
    try {
      await c.realClose();
    } catch {
      /* 이미 죽었을 수 있음 */
    }
  }
  cache.clear();
  connectPromise = null;
};
