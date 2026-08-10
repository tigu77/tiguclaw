/**
 * 회귀: 프로세스 수명 MCP 서버를 턴마다 붙였다 떼면 동시 턴이 죽는다.
 *
 * 사고 (2026-08-10, 회사돌쇠 · 그 전날 로컬): 한 세션에서 작업 중인데 다른 세션이
 *  메시지를 보내자 뒤 턴이 즉시(33ms) 죽었다 —
 *  `모든 어댑터 실패 — Already connected to a transport.`
 *
 * 뿌리는 경합이 아니라 **수명 불일치**였다. 플러그인 MCP 서버는 부팅 때 한 번 만들어
 *  registry 에 박히는 *프로세스 싱글턴*(`src/index.ts` registerMcpServer ←
 *  `schedulerMcpServer` 같은 모듈 상수)인데, codex/openai 어댑터는 그 싱글턴을 **턴마다**
 *  새 in-memory transport 에 연결하고 finally 에서 닫았다. 턴이 겹치면
 *   ① 뒤 턴의 connect 가 던지고(관측된 증상)
 *   ② 앞 턴의 close 가 뒤 턴이 쓰는 중인 서버를 닫는다(조용한 쪽).
 *
 * 구조는 2026-05-23(V7.5 extraMcpServers bridge)부터 있었고 두 달 반 잠복했다 —
 *  턴이 겹쳐야만 성립해서다. 로컬에선 claude 폴백이 받아내 `warn` 으로만 남았다(그래서
 *  더 늦게 보였다). 폴백 없는 인스턴스에서 처음으로 턴 전체가 죽었다.
 *
 * 이 검사가 지키는 것 — 인스턴스 하나에 연결은 **한 번**뿐이고, 턴의 close 가 그
 *  프로세스 수명 연결을 끊지 않는다. 문구가 아니라 **connect 호출 횟수**를 센다.
 */
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  adaptClaudeMcpServer,
  adaptSharedClaudeMcpServer,
} from "../../core/llm-runtime/adapters/_mcp-bridge.js";
import type { Assertion, RegressionCheck } from "./_framework.js";

/** 플러그인 싱글턴 흉내 — connect/close 호출을 세는 계수기를 씌운다. */
const makeCountedServer = (): {
  config: McpSdkServerConfigWithInstance;
  counts: { connect: number; close: number };
} => {
  const base = createSdkMcpServer({
    name: "regression-probe",
    version: "1.0.0",
    tools: [
      tool("probe_ping", "회귀용 무해 도구", { x: z.string().optional() }, async () => ({
        content: [{ type: "text" as const, text: "pong" }],
      })),
    ],
  });
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

  // ── ① 동시 턴 3개가 같은 싱글턴을 집어도 연결은 한 번 ──────────────────────
  //  옛 코드(adaptClaudeMcpServer)로 되돌리면 connect=3 이 되고, 2·3번째는
  //  "Already connected to a transport" 로 던진다 = 이 검사가 잡는 회귀.
  {
    const { config, counts } = makeCountedServer();
    const turns = await Promise.all(
      [0, 1, 2].map(async () => {
        const bridge = await adaptSharedClaudeMcpServer(config, "probe");
        return (await bridge.listTools()).length;
      }),
    );
    out.push({
      name: "동시 턴 3개 — 싱글턴 connect 는 1회뿐",
      ok: counts.connect === 1,
      got: `connect=${counts.connect} (기대 1)`,
    });
    out.push({
      name: "동시 턴 3개 — 전부 도구를 받는다(아무도 안 죽는다)",
      ok: turns.every((n) => n === 1),
      got: `turn별 도구수=${JSON.stringify(turns)} (기대 [1,1,1])`,
    });
  }

  // ── ② 턴의 일괄 close 가 프로세스 수명 연결을 끊지 않는다 ─────────────────
  //  어댑터는 생성한 bridge 를 finally 에서 모두 close 한다. 공유 브리지의 close 가
  //  진짜로 닫히면, 앞 턴이 끝나는 순간 뒤 턴의 도구가 사라진다(조용한 두 번째 고장).
  {
    const { config, counts } = makeCountedServer();
    const bridge = await adaptSharedClaudeMcpServer(config, "probe");
    await bridge.listTools();
    await bridge.close(); // 턴 finally 흉내
    const after = await bridge.listTools();
    out.push({
      name: "턴 close 후에도 도구가 살아있다 (close=no-op)",
      ok: after.length === 1 && counts.close === 0,
      got: `close후 도구수=${after.length} instance.close 호출=${counts.close} (기대 1 / 0)`,
    });
    out.push({
      name: "close 뒤에도 재연결이 일어나지 않는다",
      ok: counts.connect === 1,
      got: `connect=${counts.connect} (기대 1)`,
    });
  }

  // ── ③ 한 브리지 안의 동시 호출도 connect 를 두 번 부르지 않는다 ───────────
  //  ①과 다른 층이다 — 이건 `ensureConnected` 자체의 check-then-act 경합으로,
  //  턴마다 새로 만드는 capability 브리지(memory·file-ops…)에도 있던 잠복 결함이다.
  //  `connected = true` 가 await *뒤*에 있어, 연결 중에 들어온 두 번째 호출이 가드를
  //  그냥 통과했다.
  {
    const { config, counts } = makeCountedServer();
    const bridge = await adaptClaudeMcpServer(config, "probe");
    const results = await Promise.all([
      bridge.listTools(),
      bridge.listTools(),
      bridge.listTools(),
    ]);
    out.push({
      name: "단일 브리지 동시 listTools ×3 — connect 는 1회뿐",
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
    "프로세스 수명 MCP 싱글턴을 턴마다 연결/close 해 동시 턴이 'Already connected to a transport' 로 죽던 것 + ensureConnected 의 check-then-act 경합",
  run,
};
