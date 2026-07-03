/**
 * 영역 A V7.7 — 태스크 관리 (TodoWrite 동등) in-process MCP server.
 *
 * 진실 소스:
 *  - ADR: `docs/decisions/2026-05-23-region-a-v77-codex-todo-parity.md`
 *  - Claude Code TodoWrite 표준: `{ todos: [{content, status, activeForm}] }`.
 *    status = pending | in_progress | completed.
 *  - OpenClaw `update_plan` (execution-contract.ts) 동형 (step + status).
 *
 * parity 배경 (parity 감사 P1):
 *  - claude 어댑터는 SDK builtin TodoWrite 자동 제공 → 본 server 호출 0.
 *  - codex 어댑터만 등록 (능력 동등 흡수, `feedback_llm_agnostic_parity.md`).
 *
 * 두 가치 (사용자 확인 — "자기 할일 목록이면 중요"):
 *  (1) LLM 자기 관리 — codex agentic loop 에서 `update_todos` 호출 결과가
 *      function_call_output 으로 다음 iteration 컨텍스트에 남아 단계 추적·빠뜨림 방지.
 *  (2) 사용자 가시성 — EventBus `todo.update` publish → dashboard/observer fan-out.
 *      데몬(비대화형) 환경에서 "지금 뭐 하는 중" 을 관측 채널로 흘림 (채널 스팸 0).
 *
 * 정책 게이트:
 *  - dep 추가 0. in-memory 영속 0 (todo 는 turn 컨텍스트 + EventBus 만 — Claude Code
 *    도 세션 한정, store 불요). 매 호출 EventBus publish.
 */
import { z } from "zod";
import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import { getEventBus } from "../../eventbus.js";

const TODO_STATUS = ["pending", "in_progress", "completed"] as const;

const okText = (text: string) => ({
  content: [{ type: "text" as const, text }],
});

/** todo 목록 → 사람·LLM 가독 텍스트 (다음 iteration 자기 확인용). */
const formatTodos = (
  todos: ReadonlyArray<{ content: string; status: string; activeForm?: string }>,
): string => {
  const mark = (s: string) =>
    s === "completed" ? "[x]" : s === "in_progress" ? "[~]" : "[ ]";
  const lines = todos.map((t) => `${mark(t.status)} ${t.content}`);
  const done = todos.filter((t) => t.status === "completed").length;
  return `할일 ${done}/${todos.length} 완료:\n${lines.join("\n")}`;
};

const updateTodosTool = tool(
  "update_todos",
  "현재 작업의 할일 목록을 갱신합니다 (Claude Code TodoWrite 동등). 멀티스텝 작업 시 단계를 추적하고 빠뜨림을 방지하세요. 매 호출 전체 목록을 통째로 전달하며, 정확히 하나만 in_progress 여야 합니다. 갱신된 목록 요약을 반환합니다.",
  {
    todos: z
      .array(
        z.object({
          content: z.string().min(1),
          status: z.enum(TODO_STATUS),
          activeForm: z.string().optional(),
        }),
      )
      .min(1),
  },
  async (args) => {
    // (2) 관측 publish — dashboard/observer fan-out. publish 동기 + EventBus 격리.
    getEventBus().publish({
      type: "todo.update",
      ts: Date.now(),
      payload: { todos: args.todos },
    });
    // (1) 자기 관리 — 포맷 목록 반환 (codex 다음 iteration function_call_output).
    return okText(formatTodos(args.todos));
  },
);

/**
 * codex 어댑터 등록용 — 태스크 관리 in-process MCP server **팩토리**(호출마다 새 인스턴스).
 * claude 어댑터는 SDK builtin TodoWrite 사용 (본 server 등록 0, 회귀 0).
 *
 * ★공유 금지 (2026-07-03): 싱글턴을 여러 브리지가 나눠 쓰면 한쪽 close 가 다른 쪽
 * callTool 을 죽인다 → 턴마다 전용 인스턴스. 도구 무상태라 재생성 0-cost. (memory-mcp.ts 동일.)
 */
export const createTodoMcpServer = (): McpSdkServerConfigWithInstance =>
  createSdkMcpServer({
    name: "todo",
    version: "1.0.0",
    tools: [updateTodosTool],
  });
