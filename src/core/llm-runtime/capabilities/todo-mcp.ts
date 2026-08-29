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
 *      ★2026-08-13 실측: **소비처가 0이다.** 대시보드 JS·플러그인·패키지 전부에서
 *      `todo.update` 를 읽는 곳이 없다(유일한 매치는 codex 어댑터의 주석 한 줄).
 *      즉 이 값은 **설계엔 있고 배선은 없다** — 발행만 하고 아무 화면에도 안 뜬다.
 *      그래서 도구 설명에서 "대시보드가 읽는다" 고 말하면 **모델에게 거짓을 말하는 것**이라
 *      뺐다. 되살릴지(대시보드에 붙이기)·거둘지는 별건 — 지금은 사실만 적는다.
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
const makeUpdateTodosTool = (threadKey: string) => tool(
  "update_todos",
  // ★부를 때만큼 **안 부를 때**를 적는다 (2026-08-13, 벤치 실측에서 드러남).
  //  종전 설명은 "멀티스텝이면 추적하세요" 라는 **긍정 트리거뿐**이었고, 그래서 단발
  //  작업에서도 3회씩 불렸다(long-horizon-sheet-xl, tiguclaw-codex): ①시작 ②중간
  //  ③끝나고 전부 completed 로 쓸어담기. ③은 **턴의 마지막 도구 호출**이었다 —
  //  턴이 끝나면 그 목록을 볼 사람이 없으므로 그 호출은 순손실이다(왕복 1회 + 토큰).
  //
  //  ★경계의 근거는 **자기 관리**(값 ①)다 — 반환 목록이 다음 단계 컨텍스트에 남는 것.
  //   그래서 "뒤에 읽을 단계가 없는 호출" 은 값이 0이다. 처음엔 "대시보드가 읽으니까"
  //   라고 썼다가 되돌렸다 — `todo.update` 는 **소비처가 0**이라(헤더 참조) 그 말은
  //   모델에게 거짓이었다. 있지도 않은 이유로 도구를 설명하면 안 된다.
  "현재 작업의 할일 목록을 갱신합니다 (Claude Code TodoWrite 동등). " +
    "반환값(전체 목록)이 다음 단계의 컨텍스트에 남아 **당신이 자기 계획을 다시 읽게** 됩니다 — " +
    "그게 이 도구의 값입니다. 그러니 여러 단계를 **앞으로** 밟아야 할 때, 그 단계에 **들어가기 전에** 부르세요. " +
    "부르지 마세요: (a) 한두 스텝이면 끝나는 일 (b) 이미 한 일을 사후에 기록하는 용도 " +
    "(c) 마지막에 전부 completed 로 만드는 마무리 호출 — 그 뒤로 읽을 단계가 없어 아무 값도 만들지 않습니다. " +
    "매 호출 전체 목록을 통째로 전달하며, 정확히 하나만 in_progress 여야 합니다. 갱신된 목록 요약을 반환합니다.",
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
    // (2) 관측 publish — ★현재 소비처 0 (헤더 참조). 발행은 유지한다: 이벤트를 없애면
    //  나중에 붙일 화면이 재료를 잃고, 발행 비용은 무시할 만하다. 다만 "보인다" 고
    //  말하지는 않는다.
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
