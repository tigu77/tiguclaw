/**
 * 회귀: MCP 인스턴스 하나에 transport 하나 — 그 계약이 세 자리에서 깨져 있었다.
 *
 * 사고 (2026-08-10): 한 세션에서 작업 중인데 다른 세션이 메시지를 보내자 뒤 턴이
 *  즉시(33ms) 죽었다 — `모든 어댑터 실패 — Already connected to a transport.`
 *
 * 뿌리는 경합이 아니라 **수명 불일치**였다. 플러그인 MCP 서버는 부팅 때 한 번 만들어
 *  registry 에 박히는 프로세스 싱글턴인데, 어댑터는 턴마다 자기 transport 에 연결한다.
 *  MCP `Protocol.connect` 는 두 번째 transport 를 거절한다. 그래서:
 *
 *   ① codex/openai — 겹친 뒤 턴이 통째로 죽었다(관측된 증상).
 *   ② claude — SDK 가 `connectSdkMcpServer` 실패를 `.catch()` 로 삼키고 로그만 남긴다.
 *      턴은 살고 **그 플러그인 도구만 조용히 사라진다**(더 안 보이는 쪽).
 *   ③ 한 턴 안에서도 — 어댑터가 `extraMcpServers` 로 브리지를 만든 뒤
 *      `find_capabilities` 가 같은 인스턴스로 또 만들어, 플러그인 능력이 늘
 *      "상세 조회 실패"(도구 이름 빈 배열)로 degrade 했다. 2026-07-11 이후 조용히.
 *
 * 고침은 두 겹이다 — registry 가 **인스턴스 대신 팩토리**를 보관해 턴마다 새 인스턴스를
 *  주고(①②), 브리지는 **인스턴스에 묶어** 하나만 만든다(③).
 *
 * 구조는 5967090(2026-05-23)부터 있었고 턴이 겹쳐야 성립해 두 달 반 잠복했다.
 *
 * 이 검사가 지키는 것 — 문구가 아니라 **connect 호출 횟수와 인스턴스 동일성**을 센다.
 */
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  adaptClaudeMcpServer,
  adaptSharedClaudeMcpServer,
} from "../../core/llm-runtime/adapters/_mcp-bridge.js";
import {
  registerMcpServer,
  getRegisteredMcpServers,
} from "../../core/mcp-registry.js";
import type { Assertion, RegressionCheck } from "./_framework.js";

const makeServer = (): McpSdkServerConfigWithInstance =>
  createSdkMcpServer({
    name: "regression-probe",
    version: "1.0.0",
    tools: [
      tool("probe_ping", "회귀용 무해 도구", { x: z.string().optional() }, async () => ({
        content: [{ type: "text" as const, text: "pong" }],
      })),
    ],
  });

/** connect/close 호출을 세는 계수기를 씌운 서버. */
const makeCountedServer = (): {
  config: McpSdkServerConfigWithInstance;
  counts: { connect: number; close: number };
} => {
  const base = makeServer();
  const counts = { connect: 0, close: 0 };
  const inst = base.instance as unknown as {
    connect: (t: unknown) => Promise<void>;
    close: () => Promise<void>;
  };
  const realConnect = inst.connect.bind(inst);
  const realClose = inst.close.bind(inst);
  inst.connect = async (t: unknown): Promise<void> => {
    counts.connect += 1;
    await realConnect(t);
  };
  inst.close = async (): Promise<void> => {
    counts.close += 1;
    await realClose();
  };
  return { config: base, counts };
};

const run = async (): Promise<Assertion[]> => {
  const out: Assertion[] = [];

  // ── ① registry 는 턴마다 **새 인스턴스**를 준다 ────────────────────────────
  //  여기가 뿌리다. 인스턴스를 보관하면 그게 프로세스 싱글턴이 되고, 세 어댑터가
  //  전부 같은 물건을 턴마다 연결하게 된다. 옛 코드로 되돌리면 두 턴이 같은
  //  인스턴스를 받아 이 단언이 깨진다.
  {
    let made = 0;
    registerMcpServer("regression-probe", () => {
      made += 1;
      return makeServer();
    });
    const turnA = getRegisteredMcpServers()["regression-probe"];
    const turnB = getRegisteredMcpServers()["regression-probe"];
    out.push({
      name: "registry — 턴마다 새 인스턴스(팩토리 호출)",
      ok: made === 2 && turnA !== undefined && turnB !== undefined,
      got: `팩토리 호출=${made} (기대 2)`,
    });
    out.push({
      name: "registry — 두 턴의 인스턴스가 서로 다르다",
      ok:
        turnA !== undefined &&
        turnB !== undefined &&
        turnA.instance !== turnB.instance,
      got:
        turnA !== undefined && turnB !== undefined
          ? `동일 인스턴스인가=${String(turnA.instance === turnB.instance)} (기대 false)`
          : "인스턴스 없음",
    });
  }

  // ── ② 같은 인스턴스를 두 곳에서 어댑팅해도 connect 는 한 번 ────────────────
  //  어댑터(extraMcpServers)와 find_capabilities 가 같은 인스턴스를 집는 경우.
  //  공유를 빼면 두 번째 connect 가 "Already connected to a transport" 로 던진다.
  {
    const { config, counts } = makeCountedServer();
    const [a, b] = await Promise.all([
      adaptSharedClaudeMcpServer(config, "probe"),
      adaptSharedClaudeMcpServer(config, "probe"),
    ]);
    const tools = await Promise.all([a.listTools(), b.listTools()]);
    out.push({
      name: "같은 인스턴스 두 곳 어댑팅 — connect 1회",
      ok: counts.connect === 1,
      got: `connect=${counts.connect} (기대 1)`,
    });
    out.push({
      name: "같은 인스턴스 두 곳 어댑팅 — 둘 다 도구를 받는다",
      ok: tools.every((t) => t.length === 1),
      got: `도구수=${JSON.stringify(tools.map((t) => t.length))} (기대 [1,1])`,
    });
    await a.close();
    out.push({
      name: "턴이 끝나면 실제로 닫힌다(누수 0)",
      ok: counts.close === 1,
      got: `instance.close=${counts.close} (기대 1)`,
    });
  }

  // ── ③ 한 브리지 안의 동시 호출도 connect 를 두 번 부르지 않는다 ────────────
  //  `ensureConnected` 의 check-then-act — `connected = true` 가 await 뒤에 있어
  //  연결 중에 들어온 두 번째 호출이 가드를 그냥 통과했다. 턴마다 새로 만드는
  //  capability 브리지(memory·file-ops)에도 있던 잠복 결함이다.
  {
    const { config, counts } = makeCountedServer();
    const bridge = await adaptClaudeMcpServer(config, "probe");
    const results = await Promise.all([
      bridge.listTools(),
      bridge.listTools(),
      bridge.listTools(),
    ]);
    out.push({
      name: "단일 브리지 동시 listTools ×3 — connect 1회",
      ok: counts.connect === 1,
      got: `connect=${counts.connect} (기대 1)`,
    });
    out.push({
      name: "단일 브리지 동시 listTools ×3 — 전부 성공",
      ok: results.every((r) => r.length === 1),
      got: `도구수=${JSON.stringify(results.map((r) => r.length))} (기대 [1,1,1])`,
    });
    await bridge.close();
  }

  return out;
};

export const check: RegressionCheck = {
  name: "mcp-bridge-shared-lifetime",
  guards:
    "플러그인 MCP 가 프로세스 싱글턴이라 동시 턴이 'Already connected to a transport' 로 죽던 것(claude 는 도구가 조용히 유실) + find_capabilities 가 같은 인스턴스를 또 어댑팅해 늘 degrade 하던 것 + ensureConnected 의 check-then-act 경합",
  run,
};
