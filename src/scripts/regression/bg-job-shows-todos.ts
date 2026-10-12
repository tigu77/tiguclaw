/**
 * 회귀: **백그라운드 작업 카드가 모델이 적은 할 일로 «📋 진행 · 지금 · 다음» 을 보인다 — LLM 호출·문장 해석 없이** (2026-10-12 정태님:
 * «백그라운드 작업카드에서 뭘 하는 중인지 llm 사용하지 않고 지금 알 수 있는 방법이 있어?»).
 *
 * 재료: `update_todos` 가 내는 `todo.update`(threadKey + todos 구조 필드). 쓸지는 모델 판단이라 없는 작업이 더 많다 — 그땐 안 그린다.
 *
 * 지키는 것:
 *  ① 서버 — 돌고 있는 잡의 `todo.update` 를 활동 증거에 담아 `getJobActivity` 로 준다(새로고침 복원 재료). 남의 좌표·끝난 잡은 무시
 *  ② 화면(실시간) — SSE 가 부르는 `setJobTodos` 로 카드에 «📋 1/3 · 지금: <activeForm> · 다음: <첫 대기>»
 *  ③ 화면(새로고침) — 잡 목록 응답의 activity.todos 로 같은 줄
 *  ④ 할 일이 없으면 줄을 안 그린다(거짓값 금지)
 *
 * 등급: **동작**(이벤트 버스 · 미니 DOM).
 */
import { assert, i18nForContext, type Assertion, type RegressionCheck } from "./_framework.js";
import { bootDashboard, jsonResponse, makeClock } from "./_mini-dom.js";

const TODOS = [
  { content: "출처 수집", status: "completed", activeForm: "수집 중" },
  { content: "원문 대조", status: "in_progress", activeForm: "원문을 대조하는 중" },
  { content: "위키 기록", status: "pending" },
];

export const check: RegressionCheck = {
  name: "bg-job-shows-todos",
  guards: "백그라운드 작업 카드가 «지금 무엇을 하나» 를 도구 이름·경과로만 말하고, 모델이 이미 적은 할 일(지금·다음)은 도구 단계 목록 안에만 있던 것",
  run: async (): Promise<Assertion[]> => {
    // ① 서버
    const { getEventBus, initEventBus } = await import("../../core/eventbus.js");
    try { getEventBus(); } catch { initEventBus(); }
    const wj = await import("../../core/worker-jobs.js");
    wj.__resetJobsForTest();
    const jid = wj.registerJob({ channel: "cli", channelUserId: "u", task: "t", kind: "worker", label: "할일잡", threadKey: "cli:todo" });
    const done = wj.registerJob({ channel: "cli", channelUserId: "u", task: "t", kind: "worker", label: "끝난잡", threadKey: "cli:todo2" });
    wj.markDone(done, "끝");
    getEventBus().publish({ type: "todo.update", ts: Date.now(), payload: { threadKey: `worker:${jid}`, todos: TODOS } });
    getEventBus().publish({ type: "todo.update", ts: Date.now(), payload: { threadKey: `worker:${done}`, todos: TODOS } });
    getEventBus().publish({ type: "todo.update", ts: Date.now(), payload: { threadKey: "cli:todo", todos: TODOS } });
    const act = wj.getJobActivity(jid);
    const actDone = wj.getJobActivity(done);
    wj.__resetJobsForTest();

    // ②③④ 화면
    const dash = bootDashboard({ clock: makeClock(), i18n: i18nForContext, upTo: "tabs.js", allIds: true, fetch: async () => jsonResponse({}, 404) });
    const card = (id: string, opts: Record<string, unknown>) => {
      dash.run(`ensureJobCard(${JSON.stringify(id)}, ${JSON.stringify({ threadKey: "dashboard:default", kind: "worker", label: "작업", ...opts })})`);
      return dash.run(`jobCards.get(${JSON.stringify(id)})`) as { todoEl: { textContent: string; style: { display: string } } };
    };
    const live = card("j-live", {});
    // 실시간 — SSE 가 넘긴 이벤트를 실제 처리기(sse.js renderEvent)로 태운다(카드 함수를 직접 부르면 그 배선이 무검사가 된다).
    dash.run(`renderEvent(${JSON.stringify({ type: "todo.update", ts: Date.now(), payload: { threadKey: "worker:j-live", todos: TODOS } })})`);
    const liveTxt = live.todoEl.textContent;
    // 새로고침 — 잡 목록 응답(/api/worker-jobs)의 각 잡은 handleWorkerEvent 로 들어온다(activity 포함).
    dash.run(`handleWorkerEvent(${JSON.stringify({ jobId: "j-hyd", threadKey: "dashboard:default", kind: "worker", label: "작업", status: "running", activity: { lastActivityAt: 1, inFlight: [], todos: TODOS } })}, "10:00")`);
    const hydrated = dash.run(`jobCards.get("j-hyd")`) as { todoEl: { textContent: string; style: { display: string } } };
    const hydTxt = hydrated.todoEl.textContent;
    const none = card("j-none", {});
    dash.run(`window.setJobTodos(${JSON.stringify({ threadKey: "dashboard:default", todos: TODOS })})`); // 잡 좌표 아님 — 무시
    return [
      assert(
        "★① 서버가 돌고 있는 잡의 할 일을 활동에 담는다(새로고침 복원 재료) · 끝난 잡·잡이 아닌 좌표는 무시",
        JSON.stringify(act?.todos) === JSON.stringify(TODOS) && actDone === undefined,
        { 할일: act?.todos?.length, 끝난잡: actDone },
      ),
      assert(
        "★② 실시간 — 카드에 «📋 1/3 · 지금: <activeForm> · 다음: <첫 대기>»",
        liveTxt.includes("1/3") && liveTxt.includes("원문을 대조하는 중") && liveTxt.includes("위키 기록") && live.todoEl.style.display !== "none",
        liveTxt,
      ),
      assert(
        "★③ 새로고침 — 잡 목록 응답의 activity.todos 로 같은 줄",
        hydTxt.includes("1/3") && hydTxt.includes("원문을 대조하는 중") && hydrated.todoEl.style.display !== "none",
        hydTxt,
      ),
      assert(
        "④ 할 일이 없는 카드는 줄을 안 그린다 · 잡 좌표가 아닌 할 일은 카드에 안 붙는다",
        none.todoEl.style.display === "none",
        none.todoEl.style.display,
      ),
    ];
  },
};

export default check;
