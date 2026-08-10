/**
 * 데몬 부팅 시점에 모인 plugin in-process MCP server 들의 registry.
 *
 * 진실 소스: `_workspace/scheduler_architect_contract.md` §8.1 대안 C.
 *
 * 흐름:
 *  - 부팅 (`src/index.ts`) 시 plugin 의 in-process MCP server export 를 import 해서
 *    `registerMcpServer(name, server)` 로 등록.
 *  - 라우터 (`src/core/router.ts`) 가 영역 A 호출 직전 `getRegisteredMcpServers()` 호출
 *    → 그 결과를 `runClaude({ extraMcpServers })` 에 전달.
 *  - claude.ts 가 memory 내장과 spread merge.
 *
 * 별 모듈로 분리한 이유: router → index 순환 import 회피. 1.5층 (코어와 plugin 사이).
 */
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";

/** 서버 **팩토리** — 부를 때마다 새 인스턴스를 준다. */
export type McpServerFactory = () => McpSdkServerConfigWithInstance;

// ★인스턴스가 아니라 팩토리를 보관한다 (2026-08-10).
//  MCP `Protocol` 은 인스턴스당 transport 를 하나만 허용하는데(두 번째 connect 는
//  "Already connected to a transport"), 어댑터는 **턴마다** 자기 transport 에 연결한다.
//  여기 인스턴스를 담아두면 그게 프로세스 싱글턴이 돼, 두 세션의 턴이 겹치는 순간
//   - codex/openai: 뒤 턴이 즉시 죽고
//   - claude: SDK 가 그 실패를 삼켜 **그 플러그인 도구만 조용히 사라진다**.
//  턴마다 새 인스턴스를 주면 셋 다 사라진다 — 어댑터 쪽 특수 처리 0.
const REGISTRY = new Map<string, McpServerFactory>();

export const registerMcpServer = (
  name: string,
  factory: McpServerFactory,
): void => {
  REGISTRY.set(name, factory);
};

/** ★매 호출 새 인스턴스 집합 — 호출자(턴)가 소유한다. 턴 사이에 공유하지 마라. */
export const getRegisteredMcpServers = (): Record<
  string,
  McpSdkServerConfigWithInstance
> => {
  return Object.fromEntries(
    [...REGISTRY].map(([name, factory]) => [name, factory()]),
  );
};
