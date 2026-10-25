/**
 * 회귀: **실시간으로 그린 카드 = 새로고침으로 그린 카드** — 같은 입력이면 두 경로의 결과가 같아야 한다 (2026-10-23, 사용자 승인).
 *
 * 왜 «기능별 기대값» 이 아니라 «두 경로 대조» 인가: 사용자 메시지 카드는 생성 경로가 셋이다 — ①낙관 카드(보내는 순간) → 서버 echo 로 **승격**,
 *  ②실시간 SSE 카드, ③새로고침(이력 `/messages`). 한 속성의 «정하는 곳» 이 경로마다 다르면 실시간 화면만 틀리고 새로고침하면 멀쩡해진다 —
 *  사용자는 «가끔 안 된다» 로 겪고, 기능별 기대값 검사는 경로 하나만 재서 놓친다.
 * 첫 사례(출시 후 결함, Codex 발견 — docs/decisions/2026-10-23-reply-preview-on-card.md): 낙관 카드의 답글 표시는 보낸 순간의 `{ text, ts }` 뿐인데,
 *  승격 분기(`sse.js`)가 배지·시각만 바꾸고 서버가 확인한 `replyTo`(원문 행 id·완료 턴 id)를 버렸다. 같은 시각 메시지가 둘이면 «찾지 못했습니다»,
 *  새로고침하면 정상.
 *
 * 판정 = 카드의 **서명**(지금은 답글 표시: 글 · 누를 수 있나 · 눌렀을 때 도착하는 원문)을 세 경로에서 뽑아 같아야 한다. 다른 카드 속성으로 넓히려면
 *  `signature` 에 칸을 더하면 된다(시나리오·경로는 그대로).
 * 등급: **동작** — 대시보드 제품 js(`history-render`·`channel-hints`·`sse`·`axis1-options`·`chat-core`·`virtualization` 의 해당 구간)를 작은 DOM(`_mini-dom`) 위 VM 에서 실행.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { makeDomContext, type MElement } from "./_mini-dom.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const src = (rel: string): string => readFileSync(path.join(ROOT, rel), "utf8");
const section = (s: string, start: string, end: string | null): string => {
  const a = s.indexOf(start);
  if (a < 0) throw new Error(`제품 경계 없음: ${start}`);
  if (end === null) return s.slice(a);
  const b = s.indexOf(end, a + start.length);
  if (b < 0) throw new Error(`제품 경계 없음: ${end}`);
  return s.slice(a, b);
};

type Rt = { text: string; id?: number; ts?: number; turn?: string };
/** 한 시나리오 — 화면에 이미 있는 원문 후보(눌렀을 때 고를 대상)와 그 메시지의 두 재료(보내는 순간 / 서버 확인). */
interface Scenario {
  name: string;
  /** 원문 후보 — 라벨·data-*·(안쪽 말풍선 data-*). */
  screen: Array<{ label: string; data: Record<string, string>; inner?: Record<string, string> }>;
  optimistic: Rt;
  server: Rt;
}

const SCENARIOS: Scenario[] = [
  {
    name: "같은 시각 메시지 둘(원문 행 id 로만 가려진다)",
    screen: [
      { label: "원문#7", data: { id: "7", ts: "1000" } },
      { label: "다른#8", data: { id: "8", ts: "1000" } },
    ],
    optimistic: { text: "A 와 B 중 무엇?", ts: 1000 },
    server: { text: "A 와 B 중 무엇?", id: 7, ts: 1000 },
  },
  {
    name: "도구 턴 답(완료 턴 id 로만 찾힌다 — 행 시각이 화면에 없다)",
    screen: [
      { label: "다른#30", data: { id: "30", ts: "1900" } },
      { label: "도구턴답", data: { ts: "1950" }, inner: { turn: "turn-X" } },
    ],
    optimistic: { text: "결과 요약", ts: 2000 },
    server: { text: "결과 요약", id: 31, ts: 2000, turn: "turn-X" },
  },
  {
    name: "서버도 보낸 순간과 같은 값",
    screen: [{ label: "원문#40", data: { id: "40", ts: "3000" } }],
    optimistic: { text: "평범한 원문", ts: 3000 },
    server: { text: "평범한 원문", ts: 3000 },
  },
  {
    // GPT 검토 R1: 서버가 좌표를 **못** 확인했다(앞부분만) — 확정 카드도 누를 수 없어야 새로고침과 같다(보낸 순간의 시각을 붙들면 실시간만 눌린다).
    name: "서버가 좌표를 잃은 답글(앞부분만)",
    screen: [{ label: "원문#50", data: { id: "50", ts: "4000" } }],
    optimistic: { text: "좌표 없는 원문", ts: 4000 },
    server: { text: "좌표 없는 원문" },
  },
];

const harness = () => {
  const jumps: Array<{ ts: number; picked: string }> = [];
  let screen: Array<{ node: MElement; label: string }> = [];
  const vtItems: Array<{ node: MElement }> = [];
  const { document, window, ctx } = makeDomContext({
    setInterval: () => 0, setTimeout: () => 0,
    firstEvent: false, evCount: 0, currentView: "chat", showOverview() {},
    fmtTime: () => "12:00", i18n: (k: string) => k, currentLocale: () => "en",
    handleActivityLiveEvent() {}, typeClass: () => "t-other", applyFilter() {}, LOG_SINK_MAX: 50,
    isEndpointThread: () => false, activeThreadKey: "A", pendingQueued: [] as unknown[],
    isActiveThread: (tk: string) => tk === "A",
    bumpUnread() {}, markTurnActive() {}, markTurnDone() {}, scheduleErrClear() {}, cancelErrClear() {},
    markTurnCardDone() {}, setTurnCost() {}, setTurnEffort() {}, setTurnPhase() {},
    handleWorkerActivity: () => false, activityByStep: new Map(), stepKey: (x: string, y: unknown) => `${x}|${String(y)}`,
    annotateToolDuration() {}, renderActivity() {},
    vtItems, vtAppend: (n: MElement) => { vtItems.push({ node: n }); }, vtOwns: () => false, vtIndex: new Map(),
    setChatBody: (n: MElement, t: string) => { n.textContent = String(t ?? ""); },
    localChatCount: 0, refreshChatEmpty() {}, scrollChatToNewest() {}, assistantName: "tiguclaw",
    vtClear() {}, cardByThread: new Map(), setOldestCursor() {}, interruptOpenTurn() {}, completeTurnGroup: () => null, scheduleRelayout() {},
    makeCardCaret: () => document.createElement("span"), buildChannelBadge: () => null, renderModelLabel() {}, costLine: () => null,
    renderLocalChat() {}, cancelQueuedBubble() {}, buildAttachmentsPreview: () => document.createElement("div"),
  });
  ctx.evCountEl = document.createElement("span");
  ctx.logSink = document.createElement("div");
  window.jumpToMessageTs = async (ts: number, pick?: (items: unknown[], strongOnly?: boolean) => { label?: string } | null) => {
    const hit = typeof pick === "function" ? pick(screen) : null;
    jumps.push({ ts, picked: hit?.label ?? "(못 찾음)" });
    return hit ? "ok" : "not-found";
  };
  vm.createContext(ctx);
  const hist = src("packages/dashboard/js/history-render.js");
  const run = <T>(code: string): T => vm.runInContext(code, ctx) as T;
  run(section(src("packages/dashboard/js/chat-core.js"), "      const renderedMsgKeys = new Set();", "      /**\n       * 빈 채팅 자리에"));
  run(section(src("packages/dashboard/js/virtualization.js"), "      const vtTsOf =", "      // 하단 재-pin"));
  run(section(hist, "      const buildHistoryDiv = (entry) => {", "      // 보낸 메시지 버블 안 첨부 미리보기"));
  run(section(hist, "      const replyTargetPick = (rt) => (items, strongOnly) => {", "      // 메시지 유닛 → element"));
  run(section(src("packages/dashboard/js/channel-hints.js"), "      const renderChannelMessage = (ev, ts) => {", null));
  run(src("packages/dashboard/js/sse.js"));
  run(section(src("packages/dashboard/js/axis1-options.js"), "      const queueOptimisticBubble = (text, opts) => {", null));

  const setScreen = (sc: Scenario): void => {
    screen = sc.screen.map((s) => {
      const node = document.createElement("div");
      for (const [k, v] of Object.entries(s.data)) node.dataset[k] = v;
      if (s.inner !== undefined) {
        const c = document.createElement("div");
        for (const [k, v] of Object.entries(s.inner)) c.dataset[k] = v;
        node.appendChild(c);
      }
      return { node, label: s.label };
    });
  };
  /** 카드의 서명 — 사용자가 보고·누르는 것. 넓힐 때 여기에 칸을 더한다. */
  const signature = async (card: MElement | undefined): Promise<string> => {
    if (card === undefined) return "(카드 없음)";
    const rr = card.querySelector(".reply-ref");
    if (rr === null) return JSON.stringify({ reply: null });
    const before = jumps.length;
    // 미니 DOM 의 클릭 — 제품이 addEventListener 로 단 처리기를 그대로 부른다.
    for (const l of (rr as unknown as { _ls: Map<string, Array<{ fn: (e: unknown) => unknown }>> })._ls.get("click") ?? []) await l.fn({ type: "click", stopPropagation() {}, preventDefault() {} });
    const arrived = jumps.slice(before).map((j) => j.picked).join(",") || "(누를 수 없음)";
    return JSON.stringify({ text: rr.querySelector(".rr-text")?.textContent ?? "", jump: rr.classList.contains("reply-ref-jump"), arrived });
  };
  let cid = 0;
  let ts = 10_000;
  const paths = {
    /** ① 낙관 카드 → 서버 echo 로 제자리 승격. */
    optimisticThenEcho: (sc: Scenario, text: string): MElement | undefined => {
      cid += 1; ts += 1;
      const before = vtItems.length;
      run<(t: string, o: unknown) => void>("queueOptimisticBubble")(text, { queued: true, cid: `c${cid}`, replyTo: sc.optimistic });
      const card = vtItems[before]?.node;
      run<(e: unknown) => void>("renderEvent")({ type: "channel.message.in", ts, payload: { threadKey: "A", text, correlationId: `c${cid}`, replyTo: sc.server } });
      return vtItems.length === before + 1 ? card : undefined; // 승격이면 새 카드가 안 생긴다
    },
    /** ①′ 낙관 카드 → **서버 `replyTo` 없는** echo — 확정 전후 서명(보낸 순간의 표시가 그대로여야 한다). */
    optimisticThenBareEcho: (sc: Scenario, text: string): [MElement | undefined, () => void] => {
      cid += 1; ts += 1;
      const before = vtItems.length;
      run<(t: string, o: unknown) => void>("queueOptimisticBubble")(text, { queued: true, cid: `c${cid}`, replyTo: sc.optimistic });
      const card = vtItems[before]?.node;
      const myCid = `c${cid}`;
      const myTs = ts;
      return [card, () => run<(e: unknown) => void>("renderEvent")({ type: "channel.message.in", ts: myTs, payload: { threadKey: "A", text, correlationId: myCid } })];
    },
    /** ② 실시간 SSE 카드(낙관 없이 — 다른 채널에서 보낸 것). */
    liveSse: (sc: Scenario, text: string): MElement | undefined => {
      ts += 1;
      const before = vtItems.length;
      run<(e: unknown) => void>("renderEvent")({ type: "channel.message.in", ts, payload: { threadKey: "A", text, replyTo: sc.server } });
      return vtItems[before]?.node;
    },
    /** ③ 새로고침 — 이력 행(`chat_log.data.replyTo` = 서버 값). */
    refresh: (sc: Scenario, text: string): MElement => {
      ts += 1;
      ctx.E = { id: ts, ts, role: "user", text, data: { replyTo: sc.server } };
      return run<MElement>("buildHistoryDiv(E)");
    },
  };
  return { setScreen, signature, paths };
};

export const check: RegressionCheck = {
  name: "card-live-equals-refresh",
  guards:
    "같은 메시지 카드가 실시간 화면과 새로고침 화면에서 다르게 그려지던 것 — 낙관 카드가 echo 로 확정될 때 서버가 확인한 답글 좌표를 버려, 실시간에선 «원문을 찾지 못했습니다» 이고 새로고침하면 정상이었다(Codex 발견)",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const h = harness();
    for (const sc of SCENARIOS) {
      h.setScreen(sc);
      const refresh = await h.signature(h.paths.refresh(sc, `${sc.name} 답`));
      const optimistic = await h.signature(h.paths.optimisticThenEcho(sc, `${sc.name} 답(낙관)`));
      const live = await h.signature(h.paths.liveSse(sc, `${sc.name} 답(실시간)`));
      out.push(
        assert(`★${sc.name} — 낙관→승격 카드 = 새로고침 카드`, optimistic === refresh, `낙관→승격 ${optimistic} · 새로고침 ${refresh}`),
        assert(`${sc.name} — 실시간 SSE 카드 = 새로고침 카드`, live === refresh, `실시간 ${live} · 새로고침 ${refresh}`),
      );
    }
    // 서버 `replyTo` 없는 echo — 확정 전후가 같다(보낸 순간의 표시를 지우거나 바꾸지 않는다).
    {
      const sc = SCENARIOS[0]!;
      h.setScreen(sc);
      const [card, echo] = h.paths.optimisticThenBareEcho(sc, "서버 값 없는 echo");
      const before = await h.signature(card);
      echo();
      const after = await h.signature(card);
      out.push(assert("서버 `replyTo` 가 없는 echo — 확정 전후 답글 표시가 그대로(글·누를 수 있나·도착)", before === after && before.includes("jump\":true"), `전 ${before} · 후 ${after}`));
    }
    // 대조가 공허하지 않다 — 새로고침 카드가 실제로 원문에 도착한다(첫 두 시나리오).
    const h2 = harness();
    h2.setScreen(SCENARIOS[0]!);
    const a = await h2.signature(h2.paths.refresh(SCENARIOS[0]!, "x"));
    h2.setScreen(SCENARIOS[1]!);
    const b = await h2.signature(h2.paths.refresh(SCENARIOS[1]!, "y"));
    out.push(assert("기준(새로고침)이 정확한 원문에 도착한다 — 동률 시각은 원문#7 · 도구 턴 답은 턴 id 로", a.includes("원문#7") && b.includes("도구턴답"), `${a} · ${b}`));
    return out;
  },
};
