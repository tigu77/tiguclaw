/**
 * 영역 A — reply-intent 능력 in-process MCP server (factory).
 *
 * 진실 소스:
 *  - contract: `_workspace/reply_intent_capability_contract.md` §1(a)·§5.
 *  - 패턴 동형: `createSpawnAgentMcpServer(input)` (per-call factory) ·
 *    `todoMcpServer` (createSdkMcpServer + tool).
 *
 * 한 줄:
 *  비서가 agentic loop 중 무인자 도구 `reply_to_current_message()` 를 호출하면
 *  per-turn 플래그(클로저)가 켜지고, 어댑터가 그 값을 `RegionASdkOutput.replyToTrigger`
 *  로 실어 반환 → 흐름 통과 → telegram 만 reply_parameters 로 렌더(다른 채널 no-op).
 *
 * 안전 (per-turn 캡처):
 *  - 어댑터가 *매 호출* 본 factory 를 새로 만들어 `onCalled` 클로저를 주입한다.
 *  - 모듈 전역 가변 상태 0. 동시 turn 마다 별 클로저 → 교차 오염 0
 *    (Node 단일 스레드 + 함수 프레임 격리).
 *
 * 능력만 — 언제 쓸지(정책)는 sysprompt/AGENT.md 지침이 정함. 디폴트 off.
 */
import { createOurMcpServer } from "./_our-mcp.js";
import {
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";

const okText = (text: string) => ({
  content: [{ type: "text" as const, text }],
});

/**
 * reply-intent MCP server factory — `onCalled` 콜백을 클로저로 받아 per-turn
 * 플래그 set. 무인자 도구 `reply_to_current_message`.
 *
 * 양 어댑터(claude=mcpServers map / codex=adaptClaudeMcpServer bridge) 가 동형으로
 * 사용 → parity (원칙 1·2).
 */
export const createReplyIntentMcpServer = (
  onCalled: () => void,
): McpSdkServerConfigWithInstance =>
  createOurMcpServer({
    name: "reply-intent",
    version: "1.0.0",
    tools: [
      tool(
        "reply_to_current_message",
        "이 응답을 사용자의 방금 그 메시지에 대한 *직접 답글* 로 표시합니다. 채널이 지원하면 답글 형식으로 렌더(telegram); 아니면 일반 응답. 무인자. 여러 화제가 오가 어느 메시지에 답하는지 명확히 할 상황에 호출하세요.",
        {}, // 무인자
        async () => {
          onCalled();
          // 2026-06-05 — "응답을 표시했습니다" 처럼 *완료* 어조였더니 모델이 "이미 답함"
          //  으로 오인해 본문 텍스트 0자로 종료하는 케이스가 관측됨. 어조를 명확히:
          //  플래그만 세팅, 본문은 아직 안 쓴 상태 — 별도로 텍스트를 작성해야 함.
          return okText(
            "답글 표시 플래그 세팅 완료. 이 도구는 *표시 방식*만 마킹할 뿐 사용자에게 갈 응답 본문은 아직 비어있습니다 — 이제 응답 텍스트를 별도로 작성해 보내세요.",
          );
        },
      ),
    ],
  });
