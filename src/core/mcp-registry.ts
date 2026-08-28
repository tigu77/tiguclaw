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

/**
 * **이 턴이 어느 대화인가** — 플러그인 도구가 화면에 뭔가를 붙이려면 반드시 필요하다
 * (2026-08-28, 위젯 플랫폼 증분 2).
 *
 * ★없어서 막혔다. 코어 MCP 도구는 만들 때 `threadKey` 를 **받는데**(todo·session-tools·
 *  file-ops 가 전부 그렇다), 플러그인의 `getMcpServer()` 는 인자가 없어 자기가 어느 세션에
 *  있는지 알 방법이 0이었다. 그래서 플러그인은 도구를 낼 수는 있어도 **그 결과를 대화에
 *  붙일 수가 없었다.**
 *
 * ★팩토리가 **턴마다** 불린다는 사실이 이걸 공짜로 만들어 준다(그 이유는 아래 주석 —
 *  transport 충돌 때문에 이미 그렇게 돼 있었다). 그 자리에 좌표를 실어 보내면 된다.
 *
 * ★**옵션이다.** 안 받는 기존 플러그인은 그대로 돈다(회귀 0).
 */
export interface PluginTurnContext {
  /** 세션 단위 키. 관측·적재가 이 값으로 대화를 가른다. */
  threadKey: string;
  /** 실채널 — 표시·배달 좌표. */
  channel: string;
  /** 채널 내 목적지(telegram=chatId, http-bridge=threadKey). 모르면 null. */
  target: string | null;
}

/** 서버 **팩토리** — 부를 때마다 새 인스턴스를 준다. */
export type McpServerFactory = (
  ctx?: PluginTurnContext,
) => McpSdkServerConfigWithInstance;

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

/**
 * 등록 해제 (2026-08-28, 런타임 설치/제거).
 *
 * ★넣는 길만 있고 **빼는 길이 없었다.** 그러면 플러그인을 제거해도 도구는 다음 턴에도
 *  그대로 뜬다 — 사용자에겐 "제거가 안 된 것" 이다.
 * ★**"더 이상 안 불린다" 까지**다. 이미 로드된 모듈 코드는 프로세스에 남는다(ESM 은
 *  언로드가 없다). 진짜 언로드는 프로세스 경계가 있어야 한다 — 설계 §H.
 */
export const unregisterMcpServer = (name: string): boolean => REGISTRY.delete(name);

/** ★매 호출 새 인스턴스 집합 — 호출자(턴)가 소유한다. 턴 사이에 공유하지 마라. */
export const getRegisteredMcpServers = (
  ctx?: PluginTurnContext,
): Record<string, McpSdkServerConfigWithInstance> => {
  return Object.fromEntries(
    [...REGISTRY].map(([name, factory]) => [name, factory(ctx)]),
  );
};
