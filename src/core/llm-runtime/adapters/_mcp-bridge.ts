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

// ─── 프로세스 수명 인스턴스용 공유 브리지 (2026-08-10) ────────────────────────
//
// 사고: 두 세션의 턴이 겹치자 뒤 턴이 **모든 어댑터 실패 — Already connected to a
//  transport** 로 즉시(33ms) 죽었다. 뿌리는 경합이 아니라 **수명 불일치**다 —
//  플러그인 MCP 서버는 부팅 때 한 번 만들어 registry 에 박히는 *프로세스 싱글턴*
//  (`src/index.ts` registerMcpServer ← `schedulerMcpServer` 같은 모듈 상수)인데,
//  브리지는 *턴 단위*로 그 싱글턴을 자기 transport 에 연결하고 finally 에서 닫았다.
//  턴이 겹치면 ①뒤 턴의 connect 가 던지고 ②앞 턴의 close 가 뒤 턴이 쓰는 서버를 닫는다.
//
// 고침: 인스턴스당 브리지를 **하나만** 만들어 턴을 가로질러 재사용한다. per-turn
//  close 대상이 아니므로 `close()` 는 no-op — 외부 MCP 브리지(`external-mcp.ts`)가
//  이미 쓰는 관용구 그대로다(거기 주석: "bridge.close()=no-op → 어댑터의 per-turn
//  일괄 close 가 외부 연결을 끊지 않게(핵심)"). 실제 종료는 프로세스 종료가 맡는다.
//  ★그래서 호출부가 allBridges 에 넣어도 무해하다 — 넣고 빼는 걸 기억해야 하는 규칙
//  대신, 잘못 닫힐 수 없는 객체를 준다.
//
// 키는 이름이 아니라 **인스턴스**다(WeakMap): 같은 서버가 다른 이름으로 와도 한 번만
//  연결되고, registry 에서 빠지면 GC 된다.
const SHARED_BRIDGES = new WeakMap<object, Promise<MCPServer>>();

/**
 * `adaptClaudeMcpServer` 와 같지만, **인스턴스당 한 번만** 만들고 재사용한다.
 * 프로세스 수명 서버(플러그인 registry 의 `extraMcpServers`)에만 쓴다 — 턴마다 새로
 * 만드는 capability 서버(`createMemoryMcpServer()` 등)는 기존 함수를 그대로 쓴다.
 */
export const adaptSharedClaudeMcpServer = async (
  config: McpSdkServerConfigWithInstance,
  name: string,
  callTimeoutMs?: number,
): Promise<MCPServer> => {
  const key = config.instance as unknown as object;
  const cached = SHARED_BRIDGES.get(key);
  if (cached !== undefined) return cached;

  const created = adaptClaudeMcpServer(config, name, callTimeoutMs)
    .then(
      (inner): MCPServer => ({
        cacheToolsList: inner.cacheToolsList,
        get name() {
          return inner.name;
        },
        connect: () => inner.connect(),
        // ★no-op — 이 브리지는 턴이 아니라 프로세스가 소유한다(위 주석).
        close: async () => {},
        listTools: () => inner.listTools(),
        callTool: (toolName, args) => inner.callTool(toolName, args),
        invalidateToolsCache: () => inner.invalidateToolsCache(),
      }),
    )
    .catch((e: unknown) => {
      // 실패한 브리지를 캐시에 남기면 그 서버가 프로세스 내내 죽는다 — 버리고
      // 다음 턴이 다시 시도하게 한다(일시적 실패가 영구 고장이 되지 않게).
      SHARED_BRIDGES.delete(key);
      throw e;
    });
  SHARED_BRIDGES.set(key, created);
  return created;
};
