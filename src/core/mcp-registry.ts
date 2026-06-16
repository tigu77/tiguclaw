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

const REGISTRY = new Map<string, McpSdkServerConfigWithInstance>();

export const registerMcpServer = (
  name: string,
  server: McpSdkServerConfigWithInstance,
): void => {
  REGISTRY.set(name, server);
};

export const getRegisteredMcpServers = (): Record<
  string,
  McpSdkServerConfigWithInstance
> => {
  return Object.fromEntries(REGISTRY);
};
