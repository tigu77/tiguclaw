/**
 * claude-agent-sdk 의 in-process McpServer (McpSdkServerConfigWithInstance)를
 * @openai/agents 의 MCPServer 인터페이스로 어댑팅하는 in-memory bridge.
 *
 * 진실 소스: `_workspace/codex_strengthening_architect_contract.md` §4.2 (옵션 C).
 *
 * 동작:
 *  - `McpSdkServerConfigWithInstance.instance` (표준 MCP `McpServer`) 와
 *    `@modelcontextprotocol/sdk/client` 의 `Client` 를 `InMemoryTransport` 양 끝으로
 *    연결 → client 측의 listTools/callTool 을 @openai/agents 의 MCPServer 시그니처로
 *    노출. 별도 프로세스 0, transport 외부 노출 0.
 *
 * 사용: codex 어댑터에서 claude 와 동일한 memoryMcpServer 를 사용하기 위해
 *       `await adaptClaudeMcpServer(memoryMcpServer, "memory")` 로 변환.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { MCPServer } from "@openai/agents-core";

// MCPTool / CallToolResultContent 는 @openai/agents-core 의 index re-export 에
// 부재 (`mcp.d.ts` 내부 타입). listTools/callTool 반환 shape 만 호환되면 충분 —
// `unknown[]` / `unknown` 으로 좁히고 호출처에서 SDK 가 검증.
type MCPTool = Awaited<ReturnType<MCPServer["listTools"]>>[number];
type CallToolResultContent = Awaited<ReturnType<MCPServer["callTool"]>>;

// MCP callTool 타임아웃 (2026-06-20, 본질 수정) — in-process bridge 라 네트워크 0,
// 도구 *자체* 타임아웃(Bash execFile 120s/max 600s 등)이 진짜 경계다. MCP SDK 기본
// 60s 를 그대로 두면 60s 넘는 정상 도구(예: `npx quartz build`)가 매번 false "MCP
// timeout" 으로 잘려 재시도 폭주·혼란을 부른다 (2026-06-19 위키 빌드 11h outage 의
// 본질). Bash max(600s)보다 넉넉히 잡아 도구 자체 타임아웃이 먼저 발화하게 한다.
// env `MCP_CALL_TIMEOUT_MS` override (양의 정수만).
const MCP_CALL_TIMEOUT_MS = ((): number => {
  const raw = process.env.MCP_CALL_TIMEOUT_MS;
  const n = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isInteger(n) && n > 0 ? n : 660_000; // 11분 (Bash max 600s + 여유)
})();

export const adaptClaudeMcpServer = async (
  config: McpSdkServerConfigWithInstance,
  name: string,
): Promise<MCPServer> => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  const client = new Client(
    { name: `tiguclaw-codex-bridge-${name}`, version: "1.0.0" },
    { capabilities: {} },
  );

  let connected = false;

  const ensureConnected = async (): Promise<void> => {
    if (connected) return;
    await Promise.all([
      config.instance.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    connected = true;
  };

  return {
    cacheToolsList: true,
    get name() {
      return name;
    },
    async connect() {
      await ensureConnected();
    },
    async close() {
      if (!connected) return;
      await client.close();
      await config.instance.close();
      connected = false;
    },
    async listTools(): Promise<MCPTool[]> {
      await ensureConnected();
      const res = await client.listTools();
      return res.tools as unknown as MCPTool[];
    },
    async callTool(
      toolName: string,
      args: Record<string, unknown> | null,
    ): Promise<CallToolResultContent> {
      await ensureConnected();
      const res = await client.callTool(
        { name: toolName, arguments: args ?? {} },
        undefined,
        { timeout: MCP_CALL_TIMEOUT_MS },
      );
      return res.content as CallToolResultContent;
    },
    async invalidateToolsCache() {
      // 본 bridge 는 cache 미사용 — listTools 매 호출 client 위임.
    },
  };
};
