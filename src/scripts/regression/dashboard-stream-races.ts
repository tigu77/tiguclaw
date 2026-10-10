/**
 * 회귀: **대시보드 채팅 스트림의 경합 여섯 갈래** — 제품 js 를 그대로 vm 에서 돌려 판정한다 (2026-10-09 적대 검토).
 *
 * 전체 적대 검토가 실행으로 재현한 것들이다. 공통점은 «부품은 멀쩡한데 **순서**가 틀렸다» 는 것 —
 * 그래서 소스 문자열이 아니라 **사건 순서를 재연**해서 본다.
 *
 *  ① 늦게 온 이력 응답(더보기·초기 로드·점프)이 **다른 세션 탭**에 그려지고 그 탭의 커서까지 덮었다.
 *  ② 이력 로드 창에 보류한 SSE 를 `renderEvent` 전체로 다시 돌려 상태 갱신이 두 번 났다 —
 *     `channel.message.in` → `llm.turn_error` 면 흘릴 때 유예 해제 타이머가 지워지고 진행 표시가 다시 켜져
 *     «생각 중» 유령이 남았다.
 *  ③ 재연결 경합으로 EventSource 가 둘이 됐다(onerror 예약 + forceReconnect).
 *  ④ 브라우저 시계가 데몬보다 5초+ 빠르면 낙관적 버블·로컬 안내가 «최신» 이 되어 진행 중 턴의
 *     도구 스텝·답이 stale replay 로 버려졌다.
 *  ⑤ `llm.agent_no_tools` 통지가 replay 마다 «지금 시각» 으로 다시 붙었다.
 *  ⑥ 채팅 셸 칩 ⏹ 이 확인 없이 셸을 죽였다.
 *
 * 등급: **동작**. 각 파일에서 제품 구간을 잘라 실행하고, 그 밖(DOM·네트워크·상태 저장소)만 최소 대역으로 둔다.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const DASH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/dashboard/js");
const js = (f: string): string => readFileSync(path.join(DASH, f), "utf8");

/** 제품 소스에서 `start` 부터 `end` 직전까지 — 경계가 없으면 던진다(조용히 빈 구간을 돌리지 않는다). */
const section = (src: string, start: string, end: string | null): string => {
  const a = src.indexOf(start);
  if (a < 0) throw new Error(`제품 경계 없음: ${start}`);
  if (end === null) return src.slice(a);
  const b = src.indexOf(end, a + start.length);
  if (b < 0) throw new Error(`제품 경계 없음: ${end}`);
  return src.slice(a, b);
};

/** 최소 DOM 대역 — 제품 판정이 아니라 붙이고·찾는 경계만 흉내 낸다. */
class El {
  children: El[] = [];
  parentNode: El | null = null;
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  className = "";
  textContent = "";
  title = "";
  type = "";
  disabled = false;
  private handlers = new Map<string, Array<(ev: unknown) => void>>();
  get classList() {
    const names = (): string[] => this.className.split(/\s+/).filter(Boolean);
    return {
      contains: (c: string) => names().includes(c),
      add: (c: string) => { if (!names().includes(c)) this.className = [...names(), c].join(" "); },
      remove: (c: string) => { this.className = names().filter((x) => x !== c).join(" "); },
    };
  }
  appendChild(n: El): El { n.parentNode = this; this.children.push(n); return n; }
  get firstChild(): El | null { return this.children[0] ?? null; }
  get lastChild(): El | null { return this.children[this.children.length - 1] ?? null; }
  insertBefore(n: El, before: El | null): El {
    n.parentNode = this;
    const i = before ? this.children.indexOf(before) : -1;
    if (i < 0) this.children.push(n); else this.children.splice(i, 0, n);
    return n;
  }
  removeChild(n: El): El { n.remove(); return n; }
  remove(): void {
    if (!this.parentNode) return;
    const i = this.parentNode.children.indexOf(this);
    if (i >= 0) this.parentNode.children.splice(i, 1);
    this.parentNode = null;
  }
  addEventListener(t: string, fn: (ev: unknown) => void): void {
    this.handlers.set(t, [...(this.handlers.get(t) ?? []), fn]);
  }
  fire(t: string): void {
    for (const fn of this.handlers.get(t) ?? []) fn({ stopPropagation() {}, preventDefault() {} });
  }
  querySelector(sel: string): El | null {
    let s = sel;
    let direct = false;
    if (s.startsWith(":scope > ")) { direct = true; s = s.slice(9); } else if (s.startsWith(":scope ")) s = s.slice(7);
    const hit = (n: El): boolean =>
      s === "[data-ts]" ? !!n.dataset.ts : s.startsWith(".") && s.slice(1).split(".").every((c) => n.classList.contains(c));
    for (const c of this.children) {
      if (hit(c)) return c;
      if (!direct) { const r = c.querySelector(s); if (r) return r; }
    }
    return null;
  }
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

// ── ① 늦게 온 이력 응답 ───────────────────────────────────────────────────────
const historyRaces = async (): Promise<Assertion[]> => {
  const out: Assertion[] = [];
  const pending: Array<{ url: string; resolve: (v: unknown) => void }> = [];
  const renders: Array<{ n: number; first: number }> = [];
  const depth = { begin: 0, end: 0 };
  const ctx = vm.createContext({
    console: { warn() {}, debug() {}, log() {} },
    window: { vtScrollToTs: async () => false } as Record<string, unknown>,
    document: { querySelector: () => null },
    i18n: (k: string) => k,
    activeThreadKey: "dashboard:A",
    switchToken: 0,
    assistantName: "tiguclaw",
    currentView: "chat",
    historyLoadState: "loading",
    showOverview() {},
    refreshChatEmpty() {},
    scrollChatToNewest() {},
    beginHistoryLoad: () => { depth.begin += 1; },
    endHistoryLoad: () => { depth.end += 1; },
    setHistoryLoadState(s: string) { (ctx as { historyLoadState: string }).historyLoadState = s; },
    renderHistoryBatch: (entries: Array<{ ts: number }>) => { renders.push({ n: entries.length, first: entries[0]?.ts ?? -1 }); },
    setTimeout: (fn: () => void) => { fn(); return 0; },
    fetch: (url: string) => new Promise((resolve) => pending.push({ url, resolve })),
  });
  vm.runInContext(section(js("history-render.js"), "      const HISTORY_PAGE = 20;", null), ctx);
  const run = <T>(code: string): T => vm.runInContext(code, ctx) as T;
  const peek = (): { ts: number | null; id: number | null; loading: boolean } =>
    run("({ ts: oldestLoadedTs, id: oldestLoadedId, loading: loadingOlder })");
  const page = (from: number, n: number): unknown => ({
    ok: true,
    json: async () => ({ entries: Array.from({ length: n }, (_, i) => ({ ts: from + i, id: from + i })), activities: [] }),
  });
  /** 탭 전환 — tabs.js 가 하는 그대로: 토큰을 올리고 새 탭 커서를 세운다. */
  const switchTab = (ts: number, id: number): void => {
    (ctx as { switchToken: number }).switchToken += 1;
    run(`setOldestCursor([{ ts: ${ts}, id: ${id} }], null); reachedOldest = false; loadingOlder = false;`);
  };
  const waitFetch = async (n: number): Promise<void> => {
    for (let i = 0; i < 50 && pending.length < n; i += 1) await tick();
  };

  // 대조군 — 같은 탭이면 그리고 커서를 옮긴다(아래 «안 그린다» 가 공짜 통과가 아니게).
  run("setOldestCursor([{ ts: 1000, id: 5 }], null)");
  const own = run<Promise<void>>("loadOlderHistory()");
  await waitFetch(1);
  pending[0]!.resolve(page(100, 20));
  await own;
  const ownView = { renders: renders.length, cursor: peek() };

  // 더보기 도중 탭 전환.
  run("setOldestCursor([{ ts: 1000, id: 5 }], null)");
  const olderStart = renders.length;
  const older = run<Promise<void>>("loadOlderHistory()");
  await waitFetch(2);
  switchTab(9000, 90);
  // 새 탭도 곧바로 더보기를 시작한다 — 버려진 배치가 그 가드(loadingOlder)를 풀면 같은 페이지를 두 번 받는다.
  const newer = run<Promise<void>>("loadOlderHistory()");
  await waitFetch(3);
  pending[1]!.resolve(page(10, 20));
  await older;
  const olderView = { drawn: renders.length - olderStart, cursor: peek() };
  pending[2]!.resolve(page(8000, 20));
  await newer;

  out.push(assert(
    "★더보기 응답이 늦게 와도 **떠난 탭의 페이지를 새 탭에 그리지 않고 새 탭 커서·진행 가드를 건드리지 않는다**(같은 탭이면 그린다)",
    ownView.renders === 1 && ownView.cursor.ts === 100 &&
      olderView.drawn === 0 && olderView.cursor.ts === 9000 && olderView.cursor.id === 90 && olderView.cursor.loading === true,
    { 같은탭: ownView, 전환뒤: olderView },
  ));

  // 부팅 초기 로드 도중 탭 전환.
  const bootStart = renders.length;
  const depth0 = { ...depth };
  const boot = run<Promise<void>>("loadChatHistory()");
  await waitFetch(4);
  switchTab(7000, 70);
  (ctx as { historyLoadState: string }).historyLoadState = "loading"; // 새 탭 로드가 올린 상태.
  pending[3]!.resolve(page(1, 20));
  await boot;
  const bootView = {
    drawn: renders.length - bootStart,
    cursor: peek().ts,
    state: (ctx as { historyLoadState: string }).historyLoadState,
    beginEnd: [depth.begin - depth0.begin, depth.end - depth0.end],
  };
  out.push(assert(
    "★초기 로드 응답이 탭 전환 뒤에 와도 그리지 않고·커서를 안 덮고·새 탭의 «불러오는 중» 을 닫지 않는다(보류 창은 짝 맞춰 닫는다)",
    bootView.drawn === 0 && bootView.cursor === 7000 && bootView.state === "loading" &&
      bootView.beginEnd[0] === 1 && bootView.beginEnd[1] === 1,
    bootView,
  ));

  // 부팅 로드가 **실패**로 돌아왔는데 그 사이 탭이 바뀌었다 — 새 탭을 «못 불러왔다» 로 만들지 않는다.
  const boot2 = run<Promise<void>>("loadChatHistory()");
  await waitFetch(5);
  switchTab(7100, 71);
  (ctx as { historyLoadState: string }).historyLoadState = "loading";
  pending[4]!.resolve({ ok: false, json: async () => ({}) });
  await boot2;
  const bootFailState = (ctx as { historyLoadState: string }).historyLoadState;
  out.push(assert(
    "★떠난 탭의 초기 로드 **실패**가 새 탭 상태를 «error» 로 덮지 않는다",
    bootFailState === "loading",
    { 새탭상태: bootFailState },
  ));

  // 비서 이름은 탭과 무관하다 — 초기 로드 도중 탭을 바꿔도 반영된다(헤더 대기 중 · 본문 대기 중 둘 다). 떠난 탭의 이력은 여전히 안 그린다.
  //  (2026-10-10 아스트라 검토: 헤더 대기 중 전환이면 첫 가드가 이름을 읽기 전에 돌아가 «tiguclaw» 로 남았다)
  const nameStart = renders.length;
  (ctx as { assistantName: string }).assistantName = "tiguclaw";
  const boot3 = run<Promise<void>>("loadChatHistory()");
  await waitFetch(6);
  switchTab(7200, 72); // 헤더 대기 중 전환
  pending[5]!.resolve({ ok: true, json: async () => ({ assistantName: "돌쇠", entries: [{ ts: 1, id: 1 }], activities: [] }) });
  await boot3;
  const afterHeader = (ctx as { assistantName: string }).assistantName;
  (ctx as { assistantName: string }).assistantName = "tiguclaw";
  const boot4 = run<Promise<void>>("loadChatHistory()");
  await waitFetch(7);
  let openName: (v: unknown) => void = () => {};
  const nameBody = new Promise((r) => { openName = r; });
  pending[6]!.resolve({ ok: true, json: () => nameBody });
  await tick();
  switchTab(7300, 73); // 본문 대기 중 전환
  openName({ assistantName: "돌쇠2", entries: [{ ts: 2, id: 2 }], activities: [] });
  await boot4;
  const afterBody = (ctx as { assistantName: string }).assistantName;
  out.push(assert(
    "★초기 로드 도중 탭을 바꿔도 비서 이름은 반영된다(헤더 대기·본문 대기 둘 다) — 떠난 탭 이력은 그리지 않는다",
    afterHeader === "돌쇠" && afterBody === "돌쇠2" && renders.length === nameStart,
    { 헤더대기: afterHeader, 본문대기: afterBody, 그림: renders.length - nameStart },
  ));

  // 검색 점프 — ⓐ 응답 본문을 읽는 도중 전환 ⓑ 실패 응답이 전환 뒤에 도착.
  const jumpStart = renders.length;
  switchTab(5000, 50);
  const jump = run<Promise<string>>("window.jumpToMessageTs(100)");
  await waitFetch(8);
  let openBody: (v: unknown) => void = () => {};
  const body = new Promise((r) => { openBody = r; });
  pending[7]!.resolve({ ok: true, json: () => body });
  await tick();
  switchTab(8000, 80); // 헤더는 왔고 본문을 기다리는 사이.
  openBody({ entries: Array.from({ length: 200 }, (_, i) => ({ ts: 50 + i, id: 50 + i })), activities: [] });
  const jumpResult = await jump;
  switchTab(6000, 60);
  const jump2 = run<Promise<string>>("window.jumpToMessageTs(100)");
  await waitFetch(9);
  switchTab(8000, 80);
  pending[8]!.resolve({ ok: false, json: async () => ({}) });
  const jump2Result = await jump2;
  const jumpView = { 본문중전환: jumpResult, 실패뒤전환: jump2Result, drawn: renders.length - jumpStart, cursor: peek().ts };
  out.push(assert(
    "★검색 점프가 도중에 탭이 바뀌면(본문 대기 중이든 실패 응답이든) 그 세션 페이지를 새 탭에 붙이지 않고 «switched» 로 끝난다(«못 찾음» 안내를 띄우지 않는다)",
    jumpView.본문중전환 === "switched" && jumpView.실패뒤전환 === "switched" && jumpView.drawn === 0 && jumpView.cursor === 8000,
    jumpView,
  ));
  return out;
};

// ── ②④⑤ SSE 렌더 경로 — chat-core 보류 + sse.js + virtualization 순서 판정 ─────────
const sseRaces = async (): Promise<Assertion[]> => {
  const out: Assertion[] = [];
  let browserNow = Date.now();
  class FakeDate extends Date { static override now(): number { return browserNow; } }
  const turn = { active: new Set<string>(), clearPending: new Set<string>(), calls: [] as string[] };
  const drawn = { messages: [] as number[], activities: [] as number[] };
  const vtItems: Array<{ node: El }> = [];
  const ctx = vm.createContext({
    console: { warn() {}, debug() {}, log() {} },
    Date: FakeDate,
    setInterval: () => 0,
    window: {},
    document: { getElementById: () => null, createElement: () => new El() },
    firstEvent: false,
    evCount: 0,
    evCountEl: new El(),
    currentView: "chat",
    showOverview() {},
    fmtTime: () => "12:00",
    i18n: (k: string) => k,
    currentLocale: () => "en",
    handleActivityLiveEvent() {},
    // 모르는 이벤트(턴 오류의 원본 줄 등)가 가는 숨은 로그 싱크 — 채팅 리스트가 아니다.
    typeClass: () => "t-other",
    applyFilter() {},
    logSink: new El(),
    LOG_SINK_MAX: 50,
    isEndpointThread: () => false,
    activeThreadKey: "A",
    isActiveThread: (tk: string) => tk === (ctx as { activeThreadKey: string }).activeThreadKey,
    pendingQueued: [] as Array<{ text: string; el: El; cid: string }>,
    bumpUnread() {},
    markTurnActive: (tk: string) => { turn.calls.push("active"); turn.active.add(tk); },
    markTurnDone: (tk: string) => { turn.calls.push("done"); turn.active.delete(tk); },
    scheduleErrClear: (tk: string) => { turn.calls.push("scheduleClear"); turn.clearPending.add(tk); },
    cancelErrClear: (tk: string) => { turn.calls.push("cancelClear"); turn.clearPending.delete(tk); },
    markTurnCardDone() {},
    setTurnCost() {},
    setTurnEffort() {},
    setTurnPhase() {},
    handleWorkerActivity: () => false,
    activityByStep: new Map(),
    stepKey: (a: string, b: unknown) => `${a}|${String(b)}`,
    annotateToolDuration() {},
    renderActivity: (ap: { ts: number }) => { drawn.activities.push(ap.ts); },
    renderChannelMessage: (ev: { ts: number }) => {
      const el = new El();
      el.className = "ev local channel-chat";
      el.dataset.ts = String(ev.ts);
      vtItems.push({ node: el });
      drawn.messages.push(ev.ts);
    },
    vtItems,
    vtAppend: (n: El) => { vtItems.push({ node: n }); },
    vtOwns: () => false,
    setChatBody: (n: El, t: string) => { n.textContent = t; },
    localChatCount: 0,
    refreshChatEmpty() {},
    scrollChatToNewest() {},
    assistantName: "tiguclaw",
    // 탭 전환 리셋(tabs.js resetStreamState)이 부르는 것들.
    vtClear() {},
    cardByThread: new Map(),
    setOldestCursor() {},
    buildHistoryDiv: (e: { ts: number }) => {
      const d = new El();
      d.className = "ev local channel-chat";
      d.dataset.ts = String(e.ts);
      return d;
    },
  });
  const core = js("chat-core.js");
  vm.runInContext(section(core, "      const renderedMsgKeys = new Set();", "      /**\n       * 빈 채팅 자리에"), ctx);
  vm.runInContext(section(js("virtualization.js"), "      const vtTsOf =", "      // 하단 재-pin"), ctx);
  vm.runInContext(js("sse.js"), ctx);
  vm.runInContext(section(js("axis1-options.js"), "      const queueOptimisticBubble", null), ctx);
  vm.runInContext(section(js("tabs.js"), "      const resetStreamState = () => {", "      // active 세션 이력 fetch"), ctx);
  const run = <T>(code: string): T => vm.runInContext(code, ctx) as T;
  const renderEvent = (ev: unknown): void => run<(e: unknown) => void>("renderEvent")(ev);

  // ② 이력 로드 창: in → turn_error(답 없음) 순서. 흘린 뒤 유예 해제가 살아 있어야 한다.
  const t0 = Date.now();
  browserNow = t0;
  run("beginHistoryLoad()");
  renderEvent({ type: "channel.message.in", ts: t0 - 2000, payload: { threadKey: "A", text: "질문" } });
  renderEvent({ type: "llm.turn_error", ts: t0 - 1000, payload: { threadKey: "A", message: "boom", adapter: "codex" } });
  const beforeFlush = { drawn: drawn.messages.length, calls: turn.calls.length };
  run("endHistoryLoad()");
  const ghost = turn.active.has("A") && !turn.clearPending.has("A");
  const notices = vtItems.filter((i) => i.node.classList.contains("local") && !i.node.classList.contains("channel-chat"));
  out.push(assert(
    "★이력 창에서 보류한 이벤트를 흘릴 때 **그리기만** 한다 — in→turn_error 뒤 유예 해제가 살아 있고(«생각 중» 유령 없음) 메시지·오류 줄은 한 번씩 그려진다",
    !ghost && beforeFlush.drawn === 0 && drawn.messages.length === 1 && notices.length === 1 &&
      turn.calls.length === beforeFlush.calls,
    { 유령: ghost, 상태호출_흘리기전후: [beforeFlush.calls, turn.calls.length], 호출순서: turn.calls, 메시지: drawn.messages.length, 오류줄: notices.length },
  ));

  // ②b 보류 중 탭을 옮기면 보류분은 버린다 — 세션 판정은 도착 때 끝났으니 흘리면 다른 세션 리스트에 붙는다.
  run("beginHistoryLoad()");
  renderEvent({ type: "channel.message.out", ts: t0 - 500, payload: { threadKey: "A", text: "A 의 답" } });
  (ctx as { activeThreadKey: string }).activeThreadKey = "B";
  run("resetStreamState()");
  const beforeB = drawn.messages.length;
  run("endHistoryLoad()");
  const leaked = drawn.messages.length - beforeB;
  (ctx as { activeThreadKey: string }).activeThreadKey = "A";
  out.push(assert(
    "★이력 창에 보류된 A 세션 메시지가 탭을 B 로 옮긴 뒤 B 리스트에 흘러들지 않는다",
    leaked === 0,
    { B에붙은수: leaked },
  ));

  // ⑤ agent_no_tools — replay(같은 이벤트 두 번)는 한 줄, 그 줄의 시각은 이벤트 시각.
  const T = t0 + 100;
  browserNow = t0 + 60_000; // 재연결은 1분 뒤.
  const ev5 = { type: "llm.agent_no_tools", ts: T, payload: { threadKey: "A", jobId: "job-1", agentName: "x", resultChars: 3 } };
  const before5 = vtItems.length;
  renderEvent(ev5);
  renderEvent(ev5);
  const added5 = vtItems.slice(before5).map((i) => Number(i.node.dataset.ts));
  out.push(assert(
    "★`llm.agent_no_tools` 통지가 replay 로 다시 와도 한 줄이고, 시각은 «지금» 이 아니라 이벤트 시각이다",
    added5.length === 1 && added5[0] === T,
    { 붙은줄: added5.length, 시각: added5, 이벤트ts: T, 브라우저now: browserNow },
  ));

  // ④ 브라우저 시계가 8초 빠르다 — 낙관적 버블·로컬 안내가 서버 스텝을 stale 로 만들지 않는다.
  const S = t0 + 200_000; // 서버 시각.
  renderEvent({ type: "channel.message.out", ts: S, payload: { threadKey: "A", text: "이전 답" } });
  browserNow = S + 8_000;
  run('queueOptimisticBubble("다음 질문", {})');
  const bubble = vtItems[vtItems.length - 1]!.node;
  const bubbleClock = bubble.dataset.clock;
  run('renderLocalChat("info", "chat.send.stillRunning")');
  const localClock = vtItems[vtItems.length - 1]!.node.dataset.clock;
  const actBefore = drawn.activities.length;
  const msgBefore = drawn.messages.length;
  renderEvent({ type: "llm.activity", ts: S + 500, payload: { threadKey: "A", seq: 1, kind: "tool", label: "Read" } });
  renderEvent({ type: "channel.message.out", ts: S + 900, payload: { threadKey: "A", text: "답" } });
  const stepKept = drawn.activities.length - actBefore === 1;
  const answerKept = drawn.messages.length - msgBefore === 1;
  // echo 승격 — 서버 시각으로 바뀌면 순서 판정에 다시 든다.
  renderEvent({ type: "channel.message.in", ts: S + 300, payload: { threadKey: "A", text: "다음 질문" } });
  const promoted = { ts: bubble.dataset.ts, clock: bubble.dataset.clock ?? "(없음)" };
  // 대조군 — 서버 시각끼리는 여전히 지나간 replay 를 막는다(가드를 끈 게 아니다).
  const staleOld = run<(ts: number) => boolean>("vtIsStaleForAppend")(S - 60_000);
  out.push(assert(
    "★브라우저 시계가 8초 빨라도 진행 중 턴의 도구 스텝·답이 버려지지 않는다 — 브라우저 시계 항목은 순서 판정에서 빠지고, echo 승격이 서버 시각으로 되돌린다(1분 전 replay 는 여전히 막는다)",
    bubbleClock === "local" && localClock === "local" && stepKept && answerKept &&
      promoted.ts === String(S + 300) && promoted.clock === "(없음)" && staleOld === true,
    { 버블시계: bubbleClock, 안내시계: localClock, 스텝그려짐: stepKept, 답그려짐: answerKept, 승격: promoted, 옛replay차단: staleOld },
  ));
  return out;
};

// ── ③ EventSource 는 하나 ─────────────────────────────────────────────────────
const streamSingleton = (): Assertion[] => {
  const created: Array<{ closed: boolean; readyState: number; onerror?: () => void }> = [];
  const timers = new Map<number, () => void>();
  let nextId = 1;
  class FakeES {
    static CLOSED = 2;
    closed = false;
    readyState = 0;
    onopen?: () => void;
    onmessage?: () => void;
    onerror?: () => void;
    constructor() { created.push(this); }
    close(): void { this.closed = true; this.readyState = 2; }
  }
  const ctx = vm.createContext({
    EventSource: FakeES,
    setConn() {},
    appVersion: "",
    window: {},
    renderEvent() {},
    setTimeout: (fn: () => void) => { const id = nextId++; timers.set(id, fn); return id; },
    clearTimeout: (id: number) => { timers.delete(id); },
    fetch: () => Promise.reject(new Error("no network")),
  });
  vm.runInContext(section(js("activity.js"), "      let es = null;", "      // 주기 점검"), ctx);
  const run = (code: string): void => { vm.runInContext(code, ctx); };
  const runTimers = (): void => { for (const [id, fn] of [...timers]) { timers.delete(id); fn(); } };
  run("connectStream()");
  const first = created[0]!;
  first.readyState = 2;
  first.onerror?.(); // CLOSED → 3초 뒤 재연결 예약.
  run("forceReconnect()"); // 그 사이 워치독·탭 복귀가 새로 연다.
  runTimers();
  first.onerror?.(); // 갈아끼운 옛 연결의 늦은 오류.
  runTimers();
  const open = created.filter((e) => !e.closed).length;
  return [assert(
    "★재연결 예약과 강제 재연결이 겹쳐도 열린 EventSource 는 하나다(옛 것은 닫히고, 옛 연결의 늦은 오류는 새로 열지 않는다)",
    open === 1 && created.length === 2,
    { 만든수: created.length, 열린수: open },
  )];
};

// ── ⑥ 셸 칩 ⏹ 은 **한 번** 묻고 죽인다 ─────────────────────────────────────────
// ★진짜 `requestKillShell`(view-shells.js)을 같이 싣는다 — 칩과 그 함수가 각각 물으면 두 번 묻는다(2026-10-09 재검토:
//  칩만 따로, 함수만 따로 재면 둘 다 초록인데 이으면 두 번이었다).
const shellChipConfirms = (): Assertion[] => {
  const fetched: string[] = [];
  const asked: string[] = [];
  let answer = false;
  const ctx = vm.createContext({
    document: { createElement: () => new El() },
    i18n: (k: string, p?: Record<string, string>) => (p ? `${k}:${JSON.stringify(p)}` : k),
    syncShellChip() {},
    scheduleShellsRender() {},
    showToast() {},
    shellRegistry: new Map([["sh-1", { status: "running", killable: true, killRequested: false }]]),
    fetch: (url: string) => { fetched.push(url); return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) }); },
    window: { confirm: (q: string) => { asked.push(q); return answer; } },
  });
  vm.runInContext(section(js("view-shells.js"), "      const requestKillShell =", "      const fmtShellCwd =") + "\nglobalThis.requestKillShell = requestKillShell;", ctx);
  vm.runInContext(section(js("virtualization.js"), "      const attachShellChip =", "      const buildActivityLine =") + "\nglobalThis.__attach = attachShellChip;", ctx);
  const line = new El();
  (ctx as { __attach: (l: El, id: string) => void }).__attach(line, "sh-1");
  const btn = line.querySelector(".act-shell-chip-kill");
  btn?.fire("click");
  const askedNo = asked.length;
  const fetchedNo = fetched.length;
  answer = true;
  btn?.fire("click");
  return [assert(
    "★채팅 셸 칩 ⏹ 은 한 번 누르면 **정확히 한 번** 묻고, 아니오면 죽이지 않는다(예면 죽인다)",
    btn !== null && askedNo === 1 && fetchedNo === 0 && asked.length === 2 && fetched.length === 1 && /ctx\.confirm/.test(asked[0] ?? ""),
    { 버튼: btn !== null, 첫클릭물음: askedNo, 아니오뒤요청: fetchedNo, 전체물음: asked.length, 예뒤요청: fetched.length },
  )];
};

export const check: RegressionCheck = {
  name: "dashboard-stream-races",
  guards:
    "늦은 이력 응답이 다른 세션 탭에 그려지고 커서를 덮던 것 · 보류 SSE 재실행으로 «생각 중» 유령 · EventSource 이중 연결 · 브라우저 시계가 빠르면 진행 중 턴이 stale 로 버려지던 것 · agent_no_tools 통지가 replay 마다 다시 붙던 것 · 셸 칩 ⏹ 무확인 종료",
  run: async (): Promise<Assertion[]> => [
    ...(await historyRaces()),
    ...(await sseRaces()),
    ...streamSingleton(),
    ...shellChipConfirms(),
  ],
};
