/**
 * 회귀: **백그라운드 작업 카드가 모델이 적은 할 일을 «▸ 📋 완료/전체» 로 보이고, 누르면 항목 전부(여러 줄)를 펼친다 — LLM 호출·문장 해석 없이**
 * (2026-10-12 정태님: «백그라운드 작업카드에서 뭘 하는 중인지 llm 사용하지 않고 지금 알 수 있는 방법이 있어?» →
 * «맨위에서 진행상황 todo 그냥 다 나오는게 어떨까 여러줄로» → «항상 펼쳐져있기보단 화살표로 접고펴고»).
 *
 * 재료: `update_todos` 가 내는 `todo.update`(threadKey + todos 구조 필드). 쓸지는 모델 판단이라 없는 작업이 더 많다 — 그땐 안 그린다.
 *
 * 지키는 것:
 *  ① 서버 — 돌고 있는 잡의 `todo.update` 를 활동 증거에 담아 `getJobActivity` 로 준다(새로고침 복원 재료). 남의 좌표·끝난 잡은 무시
 *  ② 화면(실시간) — SSE 가 부르는 `setJobTodos` 로 카드에 «▸ 📋 1/3 · <activeForm>» 한 줄(기본 접힘) →
 *     머리 줄을 누르면 항목 셋이 한 줄씩(✓ 끝남 · ▶ activeForm · ○ 대기), 다시 누르면 접힘
 *  ③ 화면(새로고침) — 잡 목록 응답의 activity.todos 로 같은 머리 줄
 *  ④ 할 일이 없으면 줄을 안 그린다(거짓값 금지)
 *  ⑤ 진행 중이 둘 이상이면 접힌 머리 줄이 «▶ N개 진행» 과 모든 제목을 보인다 — 하나만 보여 병행이 숨던 것(2026-11-20 정태님 관측).
 *     0·1개는 종전 글자 그대로
 *  ⑥ 그 제목은 실제 폭에 들어가는 만큼만 앞에서부터 두고 나머지는 «외 K개» 로 센다(2026-11-23) — 카드 폭 변화(크기 감시)·
 *     좁은 채 새 갱신 모두에서 · 칸이 남으면 최소 하나(말줄임) · 칸이 0 이면 전부 생략 수 · 폭을 모르면(숨김) 전부. 실제 글자 폭·말줄임은 브라우저 렌더로 따로 확인
 *
 * 등급: **동작**(이벤트 버스 · 미니 DOM).
 */
import { assert, i18nForContext, type Assertion, type RegressionCheck } from "./_framework.js";
import { bootDashboard, jsonResponse, makeClock } from "./_mini-dom.js";

type TodoCard = { todoEl: { textContent: string; style: { display: string }; children: { className: string; textContent: string }[] } };
/** 항목 줄만(머리 줄 제외) — 순서·상태·본문을 그대로 비교할 수 있게. */
const itemRows = (c: TodoCard): string[] =>
  c.todoEl.children.filter((r) => r.className.startsWith("bg-job-todo-item")).map((r) => `${r.className.replace("bg-job-todo-item ", "")}|${r.textContent}`);
const EXPECT = ["done|✓ 출처 수집", "now|▶ 원문을 대조하는 중", "wait|○ 위키 기록"];

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
    // 크기 감시는 미니 DOM 에서 배달되지 않는다 — 콜백과 관측 대상을 붙잡아 ⑥ 에서 «카드 폭이 바뀜» 을 손으로 배달한다.
    const observers: { cb: (records: { target: unknown }[]) => void; targets: Set<unknown> }[] = [];
    class CapturingRO {
      private o: { cb: (records: { target: unknown }[]) => void; targets: Set<unknown> };
      constructor(cb: (records: { target: unknown }[]) => void) { this.o = { cb, targets: new Set() }; observers.push(this.o); }
      observe(t: unknown) { this.o.targets.add(t); }
      unobserve(t: unknown) { this.o.targets.delete(t); }
      disconnect() { this.o.targets.clear(); }
    }
    const dash = bootDashboard({ clock: makeClock(), i18n: i18nForContext, upTo: "tabs.js", allIds: true, fetch: async () => jsonResponse({}, 404), extra: { ResizeObserver: CapturingRO, getComputedStyle: () => ({ fontSize: "11px" }) } });
    const card = (id: string, opts: Record<string, unknown>) => {
      dash.run(`ensureJobCard(${JSON.stringify(id)}, ${JSON.stringify({ threadKey: "dashboard:default", kind: "worker", label: "작업", ...opts })})`);
      return dash.run(`jobCards.get(${JSON.stringify(id)})`) as TodoCard;
    };
    const live = card("j-live", {});
    // 실시간 — SSE 가 넘긴 이벤트를 실제 처리기(sse.js renderEvent)로 태운다(카드 함수를 직접 부르면 그 배선이 무검사가 된다).
    dash.run(`renderEvent(${JSON.stringify({ type: "todo.update", ts: Date.now(), payload: { threadKey: "worker:j-live", todos: TODOS } })})`);
    const liveTxt = live.todoEl.textContent;
    const collapsedRows = itemRows(live);
    // ★머리 줄은 같은 노드로 남아야 한다 — 갈아 끼우면 포커스된 버튼이 DOM 에서 빠져 키보드 조작이 끊긴다(아스트라 P3,
    //  헤드리스 실측: Enter 한 번 뒤 포커스가 body 로). 미니 DOM 은 포커스를 모르므로 «노드가 그대로 붙어 있나» 를 잰다 —
    //  브라우저에서 포커스가 빠지는 유일한 길이 노드 제거라서 같은 판정이다. 실제 포커스는 _todo_focus_cdp.mjs 로 확인.
    const headOf = () => dash.run(`jobCards.get("j-live").todoEl.children[0]`);
    const head0 = headOf();
    const clickHead = (id: string) => dash.run(`jobCards.get(${JSON.stringify(id)}).todoEl.children[0].click()`);
    clickHead("j-live");
    const openRows = itemRows(live);
    clickHead("j-live");
    const reclosedRows = itemRows(live);
    dash.run(`window.setJobTodos(${JSON.stringify({ threadKey: "worker:j-live", todos: TODOS })})`);
    const headKept = headOf() === head0 && dash.run(`jobCards.get("j-live").todoEl.children[0].parentNode === jobCards.get("j-live").todoEl`) === true;
    // 새로고침 — 잡 목록 응답(/api/worker-jobs)의 각 잡은 handleWorkerEvent 로 들어온다(activity 포함).
    dash.run(`handleWorkerEvent(${JSON.stringify({ jobId: "j-hyd", threadKey: "dashboard:default", kind: "worker", label: "작업", status: "running", activity: { lastActivityAt: 1, inFlight: [], todos: TODOS } })}, "10:00")`);
    const hydrated = dash.run(`jobCards.get("j-hyd")`) as TodoCard;
    const hydTxt = hydrated.todoEl.textContent;
    const none = card("j-none", {});
    dash.run(`window.setJobTodos(${JSON.stringify({ threadKey: "dashboard:default", todos: TODOS })})`); // 잡 좌표 아님 — 무시
    // ⑤ 병행 — 진행 중이 둘 이상이면 접힌 머리 줄에 «▶ N개 진행» + 모든 제목(activeForm, 없으면 content). 개수가 제목 앞이라
    //  좁아서 끝이 잘려도 개수는 남는다. 0·1개는 종전과 글자 그대로(개수 표기 없음). 실시간 경로(SSE 처리기)로 태운다.
    const sumOf = (id: string) => dash.run(`jobCards.get(${JSON.stringify(id)}).todoEl.children[0].children[1]`) as { textContent: string; title: string };
    const PAR = [
      { content: "출처 수집", status: "completed" },
      { content: "가 작업", status: "in_progress", activeForm: "가를 하는 중" },
      { content: "나 작업", status: "in_progress" },
      { content: "다 작업", status: "in_progress", activeForm: "다를 하는 중" },
      { content: "기록", status: "pending" },
    ];
    card("j-par", {});
    dash.run(`renderEvent(${JSON.stringify({ type: "todo.update", ts: Date.now(), payload: { threadKey: "worker:j-par", todos: PAR } })})`);
    const parSum = sumOf("j-par");
    const parTxt = parSum.textContent;
    const parTitle = parSum.title;
    const parExpect = `${i18nForContext("bg.todo.progress", { done: 1, total: 5 })} · ${i18nForContext("bg.todo.nowCount", { n: 3 })} · 가를 하는 중 · 나 작업 · 다를 하는 중`;
    clickHead("j-par");
    const parOpenTxt = sumOf("j-par").textContent;
    const parOpenRows = itemRows(dash.run(`jobCards.get("j-par")`) as TodoCard);
    clickHead("j-par");
    const oneTxt = sumOf("j-live").textContent;
    const oneTitle = sumOf("j-live").title;
    const ZERO = TODOS.map((t) => (t.status === "in_progress" ? { ...t, status: "pending" } : t));
    card("j-zero", {});
    dash.run(`renderEvent(${JSON.stringify({ type: "todo.update", ts: Date.now(), payload: { threadKey: "worker:j-zero", todos: ZERO } })})`);
    const zeroTxt = sumOf("j-zero").textContent;
    // ⑥ 공간 맞춤 — 미니 DOM 엔 레이아웃이 없어 «글자 수 × 7px» 손 레이아웃을 준다: 머리 글 상자 폭 = W,
    //  제목 조각이 쓸 수 있는 폭 = W − 기본 − 생략. 제목이 넘치면 뒤에서부터 «외 K개» 로 돌고, 최소 1개는 남는다.
    //  폭 변화는 카드 크기 감시(실제 콜백)로 배달하고, 좁은 채 새 갱신이 와도(SSE) 맞춘다. 폭 0(숨김)이면 전부 둔다.
    card("j-fit", {});
    const fitEv = JSON.stringify({ type: "todo.update", ts: Date.now(), payload: { threadKey: "worker:j-fit", todos: PAR } });
    dash.run(`renderEvent(${fitEv})`);
    const noLayout = dash.run(`(() => { const p = jobCards.get("j-fit").todoParts; return [p.now.textContent, p.more.textContent]; })()`) as string[];
    dash.run(`(() => {
      const e = jobCards.get("j-fit"), p = e.todoParts, W = (s) => s.textContent.length * 7;
      p.base = { get textContent() { return p.progress.textContent + p.count.textContent; } }; // 줄지 않는 앞 조각 합(손 레이아웃용)
      window.__sumW = 0;
      Object.defineProperty(e.todoSumEl, "clientWidth", { get: () => window.__sumW, configurable: true });
      Object.defineProperty(p.now, "scrollWidth", { get: () => W(p.now), configurable: true });
      Object.defineProperty(p.now, "clientWidth", { get: () => Math.max(0, Math.min(W(p.now), window.__sumW - W(p.base) - W(p.more))), configurable: true });
    })()`);
    const B = dash.run(`jobCards.get("j-fit").todoParts.base.textContent.length`) as number; // 완료/전체 + 진행 개수
    const cardEl = dash.run(`jobCards.get("j-fit").el`);
    const cardRO = observers.find((o) => o.targets.has(cardEl));
    const resize = (chars: number): string[] => {
      dash.run(`window.__sumW = ${chars * 7}`);
      cardRO?.cb([{ target: cardEl }]);
      return dash.run(`(() => { const p = jobCards.get("j-fit").todoParts; return [p.now.textContent, p.more.textContent]; })()`) as string[];
    };
    const more = (n: number) => ` · ${i18nForContext("bg.todo.more", { n })}`;
    // 제목 셋 = « · 가를 하는 중 · 나 작업 · 다를 하는 중»(27자) · 둘 + « · 외 1개» = 17+7 · 하나 + « · 외 2개» = 10+7
    const fitWide = resize(B + 27);
    const fitTwo = resize(B + 25);
    const fitOne = resize(B + 18);
    const fitOneCut = resize(B + 12); // 제목 하나도 다 안 들어감 — 칸이 남아 있으니 하나는 두고 말줄임(CSS)
    const fitSliver = resize(B + 10); // 제목 칸 21px < 3em(33px) — «· 첫 글자 …» 도 못 담는 칸을 «보였다» 고 세지 않는다
    const fitTiny = resize(B + 2); // 앞 조각+생략만으로 꽉 참 — 제목 칸 0
    const fitHidden = resize(0);
    dash.run(`window.__sumW = ${(B + 18) * 7}`);
    dash.run(`renderEvent(${fitEv})`); // 좁은 채로 새 갱신 — 감시가 아니라 렌더 경로에서 맞춘다
    const fitOnUpdate = dash.run(`(() => { const p = jobCards.get("j-fit").todoParts; return [p.now.textContent, p.more.textContent]; })()`) as string[];
    clickHead("j-fit");
    const fitOpen = dash.run(`(() => { const p = jobCards.get("j-fit").todoParts; return [p.progress.textContent + p.count.textContent, p.now.textContent, p.more.textContent]; })()`) as string[];
    clickHead("j-fit");
    const fitReclosed = dash.run(`(() => { const p = jobCards.get("j-fit").todoParts; return [p.now.textContent, p.more.textContent]; })()`) as string[];
    const fitTitle = sumOf("j-fit").title;
    // 여럿일 때 공백뿐인 제목 — activeForm 이 공백뿐이면 content 로, 둘 다 비면 «보인 제목» 이 아니라 생략 수로 센다(보인+생략=진행 수).
    card("j-blank", {});
    dash.run(`renderEvent(${JSON.stringify({ type: "todo.update", ts: Date.now(), payload: { threadKey: "worker:j-blank", todos: [
      { content: "검토", status: "in_progress", activeForm: "   " },
      { content: "수집", status: "in_progress", activeForm: "\u00a0\u00a0수집\u00a0" },
      { content: "  ", status: "in_progress", activeForm: " " } ] } })})`);
    const blank = dash.run(`(() => { const p = jobCards.get("j-blank").todoParts; return [p.count.textContent, p.now.textContent, p.more.textContent]; })()`) as string[];
    const blankTitle = sumOf("j-blank").title;
    // 진행 1개는 종전 글자 그대로 — 모델 글을 손대지 않는다(줄바꿈·연속 공백·NBSP 도 원문, 화면 접기는 CSS nowrap 몫).
    card("j-one", {});
    const RAW = "A\u00a0B\n  C ";
    dash.run(`renderEvent(${JSON.stringify({ type: "todo.update", ts: Date.now(), payload: { threadKey: "worker:j-one", todos: [
      { content: "x", status: "in_progress", activeForm: "A\u00a0B\n  C " }, { content: "y", status: "pending" } ] } })})`);
    const oneRaw = sumOf("j-one").textContent;
    return [
      assert(
        "★① 서버가 돌고 있는 잡의 할 일을 활동에 담는다(새로고침 복원 재료) · 끝난 잡·잡이 아닌 좌표는 무시",
        JSON.stringify(act?.todos) === JSON.stringify(TODOS) && actDone === undefined,
        { 할일: act?.todos?.length, 끝난잡: actDone },
      ),
      assert(
        "★② 실시간 — 기본은 접힌 «📋 1/3 · <지금 하는 일>» 한 줄 · 머리 줄을 누르면 항목 전부(끝남·진행=activeForm·대기) · 다시 누르면 접힘",
        liveTxt.includes("1/3") && liveTxt.includes("원문을 대조하는 중") && collapsedRows.length === 0 &&
          JSON.stringify(openRows) === JSON.stringify(EXPECT) && reclosedRows.length === 0 && live.todoEl.style.display !== "none",
        { 접힘글: liveTxt, 접힘줄: collapsedRows, 펼침줄: openRows, 다시접힘: reclosedRows },
      ),
      assert(
        "★②' 펼침·접힘·갱신을 거쳐도 머리 줄은 **같은 노드**로 붙어 있다 — 갈아 끼우면 포커스가 빠져 Enter·Space 연속 조작이 끊긴다",
        headKept,
        `같은 노드=${headKept}`,
      ),
      assert(
        "★③ 새로고침 — 잡 목록 응답의 activity.todos 로 같은 머리 줄",
        hydTxt.includes("1/3") && hydTxt.includes("원문을 대조하는 중") && hydrated.todoEl.style.display !== "none",
        hydTxt,
      ),
      assert(
        "④ 할 일이 없는 카드는 줄을 안 그린다 · 잡 좌표가 아닌 할 일은 카드에 안 붙는다",
        none.todoEl.style.display === "none",
        none.todoEl.style.display,
      ),
      assert(
        "★⑤ 병행 — 진행 중 셋이면 접힌 머리 줄이 «📋 1/5 · ▶ 3개 진행 · 가 · 나 · 다»(개수가 제목 앞 — 잘려도 남는다 · activeForm 없으면 content) · 툴팁에 전체 제목 · 펼치면 머리 줄은 개수만, 항목 줄 그대로",
        parTxt === parExpect && parTitle === "가를 하는 중\n나 작업\n다를 하는 중" &&
          parOpenTxt === i18nForContext("bg.todo.progress", { done: 1, total: 5 }) &&
          JSON.stringify(parOpenRows) === JSON.stringify(["done|✓ 출처 수집", "now|▶ 가를 하는 중", "now|▶ 나 작업", "now|▶ 다를 하는 중", "wait|○ 기록"]),
        { 접힘글: parTxt, 기대: parExpect, 툴팁: parTitle, 펼침머리: parOpenTxt, 펼침줄: parOpenRows },
      ),
      assert(
        "⑤' 진행 1개·0개는 종전과 글자 그대로 — 개수 표기·툴팁 없음",
        oneTxt === `${i18nForContext("bg.todo.progress", { done: 1, total: 3 })} · 원문을 대조하는 중` && oneTitle === "" &&
          zeroTxt === i18nForContext("bg.todo.progress", { done: 1, total: 3 }),
        { 하나: oneTxt, 툴팁: oneTitle, 영: zeroTxt },
      ),
      assert(
        "★⑥ 공간 맞춤 — 넓으면 제목 셋 전부 · 좁아지면 들어가는 만큼만 앞에서부터 + «외 K개» · 칸이 남으면 첫 제목 하나는 둔다(말줄임은 CSS) · 칸이 3em 미만(0 포함)이면 제목 0·전부 생략 수 · 폭을 모르면(레이아웃 없음·숨김 0) 전부",
        cardRO !== undefined &&
          JSON.stringify(noLayout) === JSON.stringify([" · 가를 하는 중 · 나 작업 · 다를 하는 중", ""]) &&
          JSON.stringify(fitWide) === JSON.stringify([" · 가를 하는 중 · 나 작업 · 다를 하는 중", ""]) &&
          JSON.stringify(fitTwo) === JSON.stringify([" · 가를 하는 중 · 나 작업", more(1)]) &&
          JSON.stringify(fitOne) === JSON.stringify([" · 가를 하는 중", more(2)]) &&
          JSON.stringify(fitOneCut) === JSON.stringify([" · 가를 하는 중", more(2)]) &&
          JSON.stringify(fitSliver) === JSON.stringify(["", more(3)]) &&
          JSON.stringify(fitTiny) === JSON.stringify(["", more(3)]) &&
          JSON.stringify(fitHidden) === JSON.stringify([" · 가를 하는 중 · 나 작업 · 다를 하는 중", ""]),
        { 감시: cardRO !== undefined, 레이아웃없음: noLayout, 넓음: fitWide, 둘: fitTwo, 하나: fitOne, 하나잘림: fitOneCut, 못읽는칸: fitSliver, 칸없음: fitTiny, 숨김: fitHidden },
      ),
      assert(
        "★⑥' 좁은 채 새 갱신(SSE)이 와도 맞춘다 · 펼치면 머리 글은 기본만(제목·생략 수 없음) · 다시 접으면 다시 맞춘다 · 툴팁은 늘 전체 제목",
        JSON.stringify(fitOnUpdate) === JSON.stringify([" · 가를 하는 중", more(2)]) &&
          JSON.stringify(fitOpen) === JSON.stringify([i18nForContext("bg.todo.progress", { done: 1, total: 5 }), "", ""]) &&
          JSON.stringify(fitReclosed) === JSON.stringify([" · 가를 하는 중", more(2)]) &&
          fitTitle === "가를 하는 중\n나 작업\n다를 하는 중",
        { 갱신: fitOnUpdate, 펼침: fitOpen, 다시접힘: fitReclosed, 툴팁: fitTitle },
      ),
      assert(
        "★⑥'' 여럿일 때 공백뿐인 제목은 content 로 · 둘 다 비면 생략 수로(보인 제목 + 생략 = 진행 수) · 앞뒤 공백(NBSP 포함)은 벗김 · 툴팁도 같은 제목 · 진행 1개는 모델 글 원문 그대로(정규화 0)",
        JSON.stringify(blank) === JSON.stringify([` · ${i18nForContext("bg.todo.nowCount", { n: 3 })}`, " · 검토 · 수집", more(1)]) &&
          blankTitle === "검토\n수집" &&
          oneRaw === `${i18nForContext("bg.todo.progress", { done: 0, total: 2 })} · ${RAW}`,
        { 공백: blank, 툴팁: blankTitle, 하나원문: JSON.stringify(oneRaw) },
      ),
    ];
  },
};

export default check;
