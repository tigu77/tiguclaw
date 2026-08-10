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

// callTool 진단 트레이스 (2026-07-03) — 병렬 callTool 이 InMemoryTransport 응답을
// 못 받고 hang 하는지 추적. loop-diag 로 "callTool never-resolve + 루프 idle" 까지
// 좁힌 뒤, 여기서 요청별 SEND/RECV·동시성(inflight)을 찍어 *어느 요청이 응답을 못
// 받나* 를 직접 관측한다. env `MCP_BRIDGE_TRACE=1` 일 때만 (평시 오버헤드 0).
const MCP_BRIDGE_TRACE = process.env.MCP_BRIDGE_TRACE === "1";
let bridgeReqSeq = 0;

export const adaptClaudeMcpServer = async (
  config: McpSdkServerConfigWithInstance,
  name: string,
  /**
   * 이 브리지의 callTool 상한(ms). 미지정 = MCP_CALL_TIMEOUT_MS(11분).
   *
   * ★불변식: **바깥 경계는 안쪽 경계보다 넉넉해야 한다.** 위 상수 주석의 근거 그대로다
   *  (2026-06-19 위키 11h outage = MCP 60s 가 정상 도구를 잘라 재시도 폭주). 그런데 그
   *  불변식이 도구마다 다르다 — 백그라운드 잡을 소유하는 도구(spawn_agent)의 **진짜
   *  경계는 잡의 상한(WORKER_TIMEOUT_MS 2시간)** 이라, 11분 천장은 다시 "바깥이 더 조임"
   *  이 된다. 그런 브리지는 자기 안쪽 경계에 맞춰 여기로 넉넉한 값을 넘긴다.
   */
  callTimeoutMs?: number,
): Promise<MCPServer> => {
  const callTimeout =
    typeof callTimeoutMs === "number" && Number.isFinite(callTimeoutMs) && callTimeoutMs > 0
      ? callTimeoutMs
      : MCP_CALL_TIMEOUT_MS;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  const client = new Client(
    { name: `tiguclaw-codex-bridge-${name}`, version: "1.0.0" },
    { capabilities: {} },
  );

  let connected = false;
  let inFlight = 0; // 이 브리지의 동시 in-flight callTool 수 (트레이스용).

  // ★in-flight 연결을 memo 한다 (2026-08-10). 이전엔 `if (connected) return` 뒤에
  //  await 하고 나서야 `connected = true` 라, **연결이 끝나기 전에** 들어온 두 번째
  //  호출이 그 가드를 그대로 통과해 `connect()` 를 또 불렀다(check-then-act). MCP
  //  Protocol 은 두 번째 connect 를 "Already connected to a transport" 로 던진다.
  //  한 턴 안에서도 listTools/callTool 이 겹치면 성립하는 잠복 경합이었다.
  //  실패 시 promise 를 버려 다음 호출이 다시 시도하게 한다(영구 고장 방지).
  let connecting: Promise<void> | null = null;
  const ensureConnected = async (): Promise<void> => {
    if (connected) return;
    if (connecting === null) {
      connecting = Promise.all([
        config.instance.connect(serverTransport),
        client.connect(clientTransport),
      ])
        .then(() => {
          connected = true;
        })
        .catch((e: unknown) => {
          connecting = null;
          throw e;
        });
    }
    await connecting;
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
      connecting = null; // 다음 ensureConnected 가 다시 연결하도록.
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
      if (!MCP_BRIDGE_TRACE) {
        const res = await client.callTool(
          { name: toolName, arguments: args ?? {} },
          undefined,
          { timeout: callTimeout },
        );
        return res.content as CallToolResultContent;
      }
      // 트레이스 경로: SEND/RECV 를 요청ID·동시성과 함께 찍는다. p 에 settle 로거를
      // 별도로 붙여, 호출측(codex 8분 race)이 abandon 해도 *실제* settle 시각을
      // 잡는다 — never-resolve 면 RECV 가 영영 안 찍혀 그게 곧 hung 요청의 증거.
      const reqId = ++bridgeReqSeq;
      inFlight += 1;
      const t0 = Date.now();
      console.log(`[mcp-bridge] SEND #${reqId} ${name}.${toolName} inflight=${inFlight}`);
      const p = client.callTool(
        { name: toolName, arguments: args ?? {} },
        undefined,
        { timeout: callTimeout },
      );
      p.then(
        () => {
          inFlight -= 1;
          console.log(
            `[mcp-bridge] RECV #${reqId} ${name}.${toolName} ok ${Date.now() - t0}ms inflight=${inFlight}`,
          );
        },
        (e: unknown) => {
          inFlight -= 1;
          console.log(
            `[mcp-bridge] RECV #${reqId} ${name}.${toolName} ERR ${Date.now() - t0}ms ${e instanceof Error ? e.message : String(e)} inflight=${inFlight}`,
          );
        },
      );
      const res = await p;
      return res.content as CallToolResultContent;
    },
    async invalidateToolsCache() {
      // 본 bridge 는 cache 미사용 — listTools 매 호출 client 위임.
    },
  };
};

// ─── 인스턴스당 브리지 하나 (2026-08-10) ──────────────────────────────────────
//
// 불변식: **MCP 인스턴스 하나에 transport 하나.** `Protocol.connect` 는 두 번째
//  transport 를 `Already connected to a transport` 로 거절한다 — 우회가 아니라
//  지켜야 하는 계약이다. 그러니 "같은 인스턴스를 두 번 어댑팅"이 성립하면 안 된다.
//
// 그게 실제로 두 자리에서 성립했다:
//  ① 턴을 가로질러 — 플러그인 MCP 가 프로세스 싱글턴이라 두 세션의 턴이 겹치면 충돌.
//     (뿌리는 `mcp-registry.ts` 에서 고쳤다 — 이제 턴마다 새 인스턴스다.)
//  ② 한 턴 안에서 — 어댑터가 `extraMcpServers` 로 브리지를 만든 뒤,
//     `find_capabilities` 가 **같은 인스턴스로 또** 만들었다. 두 번째 connect 가
//     던지고 catch 가 삼켜, 플러그인 능력이 늘 "상세 조회 실패"로 degrade 했다
//     (도구 이름이 빈 배열 — 2026-07-11 이후 조용히).
//
// 그래서 브리지를 **인스턴스에 묶어** 기억한다(WeakMap). 이름이 아니라 인스턴스가 키다 —
//  이름은 호출부마다 다를 수 있어도 계약을 어기는 건 인스턴스이기 때문이다.
//  `close()` 는 진짜로 닫고 기억도 지운다: 인스턴스 수명 = 턴 수명이므로, 턴이 끝날 때
//  닫히는 게 맞다(닫고 나면 다음에 다시 만든다).
const BRIDGE_BY_INSTANCE = new WeakMap<object, Promise<MCPServer>>();

/**
 * `adaptClaudeMcpServer` 와 같지만, **같은 인스턴스면 같은 브리지**를 돌려준다.
 *
 * 한 인스턴스를 여러 곳에서 어댑팅할 수 있는 경로(플러그인 `extraMcpServers` +
 * `find_capabilities`)에 쓴다. 호출부가 하나뿐인 서버(`createMemoryMcpServer()` 등)는
 * 기존 함수를 그대로 쓴다 — 거기엔 이 기억이 필요 없다.
 */
export const adaptSharedClaudeMcpServer = async (
  config: McpSdkServerConfigWithInstance,
  name: string,
  callTimeoutMs?: number,
): Promise<MCPServer> => {
  const key = config.instance as unknown as object;
  const cached = BRIDGE_BY_INSTANCE.get(key);
  if (cached !== undefined) return cached;

  const created = adaptClaudeMcpServer(config, name, callTimeoutMs)
    .then(
      (inner): MCPServer => ({
        cacheToolsList: inner.cacheToolsList,
        get name() {
          return inner.name;
        },
        connect: () => inner.connect(),
        close: async () => {
          // 기억을 먼저 지운다 — 닫힌 브리지를 나눠주는 창이 없게.
          BRIDGE_BY_INSTANCE.delete(key);
          await inner.close();
        },
        listTools: () => inner.listTools(),
        callTool: (toolName, args) => inner.callTool(toolName, args),
        invalidateToolsCache: () => inner.invalidateToolsCache(),
      }),
    )
    .catch((e: unknown) => {
      // 실패한 브리지를 기억에 남기면 그 인스턴스가 영영 죽는다 — 버린다.
      BRIDGE_BY_INSTANCE.delete(key);
      throw e;
    });
  BRIDGE_BY_INSTANCE.set(key, created);
  return created;
};
