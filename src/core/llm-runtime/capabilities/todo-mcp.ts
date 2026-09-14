/**
 * 영역 A V7.7 — 태스크 관리 (TodoWrite 동등) in-process MCP server.
 *
 * 진실 소스:
 *  - ADR: `docs/decisions/2026-05-23-region-a-v77-codex-todo-parity.md`
 *  - Claude Code TodoWrite 표준: `{ todos: [{content, status, activeForm}] }`.
 *    status = pending | in_progress | completed.
 *  - OpenClaw `update_plan` (execution-contract.ts) 동형 (step + status).
 *
 * 현재 등록: Claude·Codex OAuth·OpenAI SDK가 공용 도구를 사용한다.
 * Claude의 SDK 할일 도구 대체 배선은 claude-agent-sdk의 등록/제외 목록이 정본이다.
 *
 * 두 가치 (사용자 확인 — "자기 할일 목록이면 중요"):
 *  (1) LLM 자기 관리 — codex agentic loop 에서 `update_todos` 호출 결과가
 *      function_call_output 으로 다음 iteration 컨텍스트에 남아 단계 추적·빠뜨림 방지.
 *  (2) 사용자 가시성 — llm.activity의 도구 카드에 요약과 전체 목록이 표시된다.
 *      todo.update 이벤트의 전용 구독자가 없다는 사실과 화면 표시 부재는 다르다.
 *      _activity-detail/_activity-output 및 todo-update-is-rendered 회귀가 실제 경로다.
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

/**
 * ★threadKey 를 받는다 (2026-08-14) — 종전 payload 는 `{ todos }` 뿐이라 **어느 대화의
 *  할일인지 알 수가 없었다.** 소비처가 0이던 동안엔 안 드러났지만, 화면에 붙이는 순간
 *  매니저·서브에이전트의 할일이 메인 대화에 뜨는 오염이 된다(대시보드는 세션별 화면이다).
 *  session-tools·file-ops 가 이미 같은 이유로 threadKey 를 받는다 — 같은 규칙을 따른다.
 */
/**
 * 우리 할일 도구 이름 — SDK 의 `SDK_TODO_TOOL_NAMES` 와 짝이다.
 *
 * ★export 하는 이유: 배포되는 **지침 글**(스킬)이 어느 어휘를 쓰는지 검사가 여기서 파생한다
 *  (`harness-skill-vocabulary`). 검사 쪽에 이름을 또 적으면 손 목록이 된다.
 */
export const DAEMON_TODO_TOOL = "update_todos";

const makeUpdateTodosTool = (threadKey: string) => tool(
  DAEMON_TODO_TOOL,
  // 설명은 실제 두 소비 경로(모델의 다음 입력, llm.activity 도구 카드)에 맞춘다.
  // 복잡한 작업의 계획/완료 표시는 유지하고, 짧은 작업의 형식적 갱신은 생략한다.
  "복잡한 다단계 작업의 계획과 진행 상태를 갱신합니다. 목록은 다음 모델 입력과 사용자 도구 카드에 표시됩니다. " +
    "짧은 조회·단일 수정에는 사용하지 마세요. 계획이나 상태가 실제로 바뀔 때만 갱신하고, 같은 내용을 반복하지 마세요. " +
    "필요한 갱신은 결과에 의존하지 않는 다른 도구 호출과 같은 응답에 묶으세요. 검증 전에는 완료로 표시하지 마세요. " +
    "매번 전체 목록을 전달합니다. in_progress는 최대 하나이며, 모든 작업이 끝났으면 모두 completed로 표시할 수 있습니다.",
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
    // 별도 todo.update 이벤트도 유지한다. 사용자 도구 카드는 llm.activity 경로다.
    getEventBus().publish({
      type: "todo.update",
      ts: Date.now(),
      payload: { threadKey, todos: args.todos },
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
export const createTodoMcpServer = (
  threadKey = "",
): McpSdkServerConfigWithInstance =>
  createSdkMcpServer({
    name: "todo",
    version: "1.0.0",
    tools: [makeUpdateTodosTool(threadKey)],
  });

/**
 * SDK 빌트인 할일 도구 이름 — **여기가 정의점**이다. 어댑터가 이름을 다시 적지 않는다
 * (`SHELL_TOOL_NAMES`·`SEARCH_TOOL_NAMES` 와 같은 수법·같은 이유).
 *
 * ★왜 막는가 (2026-08-14, A/B 실측): claude 는 이 도구들을 쓰는데 그 활동이 우리 이벤트로
 *  안 와서 **할일 카드가 claude 에서만 안 떴다**(codex·openai 는 뜬다 = 원칙 #2 위반).
 *  그리고 대체가 손해가 아니었다 — 같은 6단계 과제에서
 *    SDK: `TaskCreate×6 + TaskUpdate×12` = **18 호출** / 우리: `update_todos×6` = **6 호출**
 *  (소요 54초 동일·산출 동일). SDK 는 항목별이라 "이전 완료 + 다음 시작" 에 2번이 드는데
 *  우리는 배열 통째라 한 번에 둘 다 한다. 표현력이 낮은 설계가 이 패턴에선 더 싸다.
 *
 * ★안 쓰는 표현력은 안 만들었다: `TaskGet`·`TaskList`(읽기) **실사용 0건**,
 *  `blocks`/`blockedBy`(의존성) **0건**, `metadata` **0건** — 윈도우 인스턴스 6일치 실측.
 *  그래서 CRUD 한 벌을 새로 만들지 않고 기존 도구로 대체했다("3번 반복된 후 추상화").
 *  ★단서: 항목이 아주 많아지면(수십 개) 매번 전체를 다시 뱉는 비용이 커져 교환이 뒤집힐
 *   수 있다. 실측은 6개 규모다.
 *
 * ★`TodoWrite` 도 넣는다 — 실사용 0건(1,304건 중)이지만 상류가 되살릴 수 있고, 그때
 *  조용히 두 도구가 공존하면 계획이 두 군데로 갈린다.
 */
export const SDK_TODO_TOOL_NAMES = [
  "TodoWrite",
  "TaskCreate",
  "TaskUpdate",
  "TaskGet",
  "TaskList",
] as const;
