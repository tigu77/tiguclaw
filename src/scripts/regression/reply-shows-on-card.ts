/**
 * 회귀: **답글로 보낸 메시지 카드 위에 «무엇에 단 답글인지» 가 남는다** (2026-10-23, 사용자 «답글 표시는 같이 진행해 줘»).
 *
 * 재료(답글 원문·원문 행 id)는 이미 서버까지 왔는데 **저장되지 않아서**, 보낸 순간에도 새로고침 뒤에도 카드엔 아무 표시가 없었다.
 *  이제 `core/reply-preview.ts` 한 곳이 `{ text: 앞부분, id?, ts? }` 를 만들고, 인입 이벤트에 실려 화면(실시간)과 `chat_log.data.replyTo`(새로고침)로 간다.
 *
 * 재는 것:
 *  ① 순수 — 답글 아니면 없음 · 공백 접기 · 앞부분 상한(서로게이트 안 쪼갬) · ★자르기 전에 비밀 가림(R1: 잘린 비밀 앞부분이 가림을 빠져나갔다) ·
 *     이동 좌표 순서(행 시각·턴 id → 말풍선 시각 → 없음) · 조회가 던져도 안 던짐.
 *  ② ★진짜 이벤트 버스 + 진짜 적재 + 진짜 조회 — 사용자 메시지에만 남고 · 답글 아닌 메시지·비서 답은 모양 그대로(`data` 없음) · 휘발은 안 남고 ·
 *     모델이 읽는 전문 조회(`chatMessageById`)엔 안 섞인다.
 *  ③ ★대시보드 제품 js 를 VM 에서 실행 — 이력·낙관 버블(`buildHistoryDiv`)·실시간(`renderChannelMessage`) 세 생성 지점이 같은 줄을 그리고 ·
 *     글은 텍스트로만 · 본문(`.chat-message`) 밖 · 비서 답엔 안 그림 · 누르면 정확 선택과 함께 이동 · 못 찾으면 말한다 · 좌표 없으면 누를 수 없다.
 *  ⑤ ★진짜 이동(`jumpToMessageTs` + `vtScrollToTs` + `replyTargetPick`) — 원문이 아직 안 그려졌으면 **먼저 당기고** 찾는다(R1: 경계 근처 다른
 *     메시지에 내려앉던 것) · 동률 시각은 행 id 로 · 행 id·시각 없이 그려진 답은 완료 턴 id 로 · 정확한 대상이 없으면 «못 찾음»(가까운 것으로 치지 않음).
 *  ⑥ ★진짜 승격(`sse.js`) — 낙관 버블이 echo 로 승격되면 제자리에서 확정되고(새 카드 0) 답글 줄은 **서버가 확인한 값**으로 바뀐다
 *     (확정 카드의 정본은 서버 값 — 2026-10-23 출시 후 결함. 화면·새로고침 대조는 `card-live-equals-refresh`).
 *  ④ 배선(소스 모양) — 인입 발행(index.ts 클로저)·브리지·대시보드 전송이 재료를 싣는다.
 * 등급: ①②③⑤⑥ **동작**, ④ 배선.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { assert, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";
import { initStore } from "../../store/sessions.js";
import { chatMessageById, chatRowCoords, getRecentChatLog, recordChatMessage } from "../../store/chat-log.js";
import { REPLY_PREVIEW_MAX_CHARS, replyPreviewFromPayload, replyPreviewOf } from "../../core/reply-preview.js";
import { createEventBus } from "../../core/eventbus.js";
import { startEventPersistence } from "../../core/event-persist.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const src = (rel: string): string => readFileSync(path.join(ROOT, rel), "utf8");

/** 제품 소스에서 `start` 부터 `end` 직전까지(`end` 없으면 끝까지) — 경계가 없으면 던진다(빈 구간을 조용히 돌리지 않는다). */
const section = (s: string, start: string, end: string | null): string => {
  const a = s.indexOf(start);
  if (a < 0) throw new Error(`제품 경계 없음: ${start}`);
  if (end === null) return s.slice(a);
  const b = s.indexOf(end, a + start.length);
  if (b < 0) throw new Error(`제품 경계 없음: ${end}`);
  return s.slice(a, b);
};

/** 최소 DOM 대역 — 붙이고·찾고·누르는 경계만. `innerHTML` 은 일부러 없다(쓰면 터진다 = 텍스트로만 넣는지의 그물). */
class El {
  children: El[] = [];
  parentNode: El | null = null;
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  className = "";
  textContent = "";
  title = "";
  type = "";
  private handlers = new Map<string, Array<(ev: unknown) => unknown>>();
  constructor(readonly tagName: string) {}
  get classList() {
    const names = (): string[] => this.className.split(/\s+/).filter(Boolean);
    return {
      contains: (c: string) => names().includes(c),
      add: (c: string) => { if (!names().includes(c)) this.className = [...names(), c].join(" "); },
      remove: (c: string) => { this.className = names().filter((x) => x !== c).join(" "); },
    };
  }
  appendChild(n: El): El { n.parentNode = this; this.children.push(n); return n; }
  insertBefore(n: El, ref: El | null): El {
    const i = ref === null ? -1 : this.children.indexOf(ref);
    n.parentNode = this;
    if (i < 0) this.children.push(n); else this.children.splice(i, 0, n);
    return n;
  }
  replaceWith(n: El): void {
    const p = this.parentNode;
    if (!p) return;
    const i = p.children.indexOf(this);
    n.parentNode = p;
    p.children.splice(i, 1, n);
    this.parentNode = null;
  }
  get firstChild(): El | null { return this.children[0] ?? null; }
  remove(): void {
    if (!this.parentNode) return;
    const i = this.parentNode.children.indexOf(this);
    if (i >= 0) this.parentNode.children.splice(i, 1);
    this.parentNode = null;
  }
  querySelectorAll(sel: string): El[] {
    const m = /^\[data-([a-z]+)\]$/.exec(sel);
    const out: El[] = [];
    const walk = (n: El): void => { for (const k of n.children) { if (m !== null && k.dataset[m[1]!] !== undefined) out.push(k); walk(k); } };
    walk(this);
    return out;
  }
  addEventListener(t: string, fn: (ev: unknown) => unknown): void { this.handlers.set(t, [...(this.handlers.get(t) ?? []), fn]); }
  async fire(t: string): Promise<void> { for (const fn of this.handlers.get(t) ?? []) await fn({ stopPropagation() {}, preventDefault() {} }); }
  hasHandler(t: string): boolean { return (this.handlers.get(t) ?? []).length > 0; }
  querySelector(sel: string): El | null {
    const direct = sel.startsWith(":scope > ");
    const c0 = direct ? sel.slice(9) : sel;
    const c = c0.startsWith(".") ? c0.slice(1) : null;
    for (const k of this.children) {
      if (c !== null && k.classList.contains(c)) return k;
      if (direct) continue;
      const r = k.querySelector(sel);
      if (r) return r;
    }
    return null;
  }
}

const dashboardRun = async (): Promise<Assertion[]> => {
  const out: Assertion[] = [];
  const jumps: number[] = [];
  const picks: string[] = [];
  const notices: Array<[string, string]> = [];
  const appended: El[] = [];
  let jumpResult = "ok";
  const ctx = vm.createContext({
    document: { createElement: (t: string) => new El(t) },
    window: { jumpToMessageTs: async (ts: number, pick: unknown) => { jumps.push(ts); picks.push(typeof pick); return jumpResult; } } as Record<string, unknown>,
    i18n: (k: string) => k,
    renderLocalChat: (kind: string, text: string) => { notices.push([kind, text]); },
    makeCardCaret: () => new El("span"),
    fmtTime: () => "00:00",
    buildChannelBadge: () => null,
    setChatBody: (el: El, text: string) => { el.textContent = String(text ?? ""); },
    renderModelLabel() {},
    costLine: () => null,
    assistantName: "tiguclaw",
    activeThreadKey: "dashboard:A",
    cardByThread: new Map(),
    vtIndex: new Map(),
    interruptOpenTurn() {},
    completeTurnGroup: () => null,
    scheduleRelayout() {},
    vtAppend: (el: El) => { appended.push(el); },
    localChatCount: 0,
    refreshChatEmpty() {},
    scrollChatToNewest() {},
    currentView: "chat",
    showOverview() {},
    setTimeout: () => 0,
  });
  const hist = src("packages/dashboard/js/history-render.js");
  vm.runInContext(section(hist, "      const buildHistoryDiv = (entry) => {", "      // 보낸 메시지 버블 안 첨부 미리보기"), ctx);
  vm.runInContext(section(hist, "      const replyTargetPick = (rt) => (items, strongOnly) => {", "      // 메시지 유닛 → element"), ctx);
  vm.runInContext(section(src("packages/dashboard/js/channel-hints.js"), "      const renderChannelMessage = (ev, ts) => {", null), ctx);
  vm.runInContext(
    "var pendingQueued = []; var cancelQueuedBubble = () => {}; var buildAttachmentsPreview = () => document.createElement('div');" +
      section(src("packages/dashboard/js/axis1-options.js"), "      const queueOptimisticBubble = (text, opts) => {", null),
    ctx,
  );
  const run = <T>(code: string): T => vm.runInContext(code, ctx) as T;
  const order = (div: El): string[] => div.children.map((c) => c.className.split(" ")[0] ?? "");
  const rrOf = (div: El): El | undefined => div.children.find((c) => c.classList.contains("reply-ref"));

  // 이력 — 사용자 메시지 + data.replyTo
  (ctx as { E: unknown }).E = { id: 9, ts: 2000, role: "user", text: "B로 해", data: { replyTo: { text: "<b>A</b> 와  B\n중 무엇?", id: 7, ts: 1000 } } };
  const histDiv = run<El>("buildHistoryDiv(E)");
  const rr = rrOf(histDiv);
  out.push(
    assert(
      "이력 — 사용자 카드에 «↩ 원문 앞부분» 이 본문 **위·밖**에 그려진다",
      rr !== undefined && order(histDiv).join(",") === "bubble-meta,reply-ref,chat-message" && rr.tagName === "button",
      `자식 순서 ${order(histDiv).join(",")} · 태그 ${rr?.tagName ?? "없음"}`,
    ),
  );
  const textEl = rr?.children.find((c) => c.className === "rr-text");
  out.push(
    assert(
      "글은 **텍스트로만**(마크다운·HTML 해석 없음) · 공백은 한 칸으로 · 본문 글엔 안 섞인다",
      textEl?.textContent === "<b>A</b> 와 B 중 무엇?" && (rr?.children.length ?? 0) === 2 && histDiv.querySelector(".chat-message")?.textContent === "B로 해",
      `표시 ${JSON.stringify(textEl?.textContent)} · 본문 ${JSON.stringify(histDiv.querySelector(".chat-message")?.textContent)}`,
    ),
  );
  jumpResult = "ok";
  await rr?.fire("click");
  out.push(
    assert(
      "누르면 그 시각으로 이동한다(검색 이동과 같은 길 + 정확 선택 함수)",
      jumps.join(",") === "1000" && picks.join(",") === "function" && notices.length === 0,
      `이동 ${jumps.join(",")} · 선택 ${picks.join(",")} · 안내 ${notices.length}`,
    ),
  );
  jumpResult = "not-found";
  await rr?.fire("click");
  out.push(
    assert(
      "★원문을 못 찾으면 **말한다**(조용히 아무 일도 안 일어나지 않게)",
      notices.length === 1 && notices[0]![1] === "reply.ref.notFound",
      JSON.stringify(notices),
    ),
  );
  jumpResult = "switched";
  await rr?.fire("click");
  out.push(assert("이동 중 탭을 옮긴 것은 실패로 알리지 않는다", notices.length === 1, `안내 ${notices.length}`));

  // 좌표 없음 · 비서 답 · 답글 아님
  (ctx as { E: unknown }).E = { ts: 2100, role: "user", text: "x", data: { replyTo: { text: "옛 텔레그램 원문" } } };
  const noTs = rrOf(run<El>("buildHistoryDiv(E)"));
  (ctx as { E: unknown }).E = { ts: 2200, role: "assistant", text: "y", data: { replyTo: { text: "원문", ts: 1 } } };
  const asst = rrOf(run<El>("buildHistoryDiv(E)"));
  (ctx as { E: unknown }).E = { ts: 2300, role: "user", text: "그냥 메시지" };
  const plainDiv = run<El>("buildHistoryDiv(E)");
  out.push(
    assert(
      "좌표가 없으면 앞부분만(누를 수 없음) · 비서 답엔 안 그림 · 답글 아닌 메시지는 모양 그대로",
      noTs !== undefined && noTs.tagName === "div" && !noTs.hasHandler("click") && asst === undefined && order(plainDiv).join(",") === "bubble-meta,chat-message",
      `좌표없음 ${noTs?.tagName ?? "없음"}/${noTs?.hasHandler("click")} · 비서 ${asst ? "그림" : "안 그림"} · 평범 ${order(plainDiv).join(",")}`,
    ),
  );

  // 실시간 — SSE 인입 이벤트
  run(`renderChannelMessage({ type: "channel.message.in", ts: 3000, payload: { threadKey: "dashboard:A", text: "실시간 답글", replyTo: { text: "실시간 원문", ts: 2500 } } }, "00:00")`);
  run(`renderChannelMessage({ type: "channel.message.out", ts: 3100, payload: { threadKey: "dashboard:A", text: "비서 답", replyTo: { text: "섞이면 안 됨", ts: 1 } } }, "00:00")`);
  const live = appended[0];
  const liveOut = appended[1];
  out.push(
    assert(
      "실시간 — 인입 이벤트의 `replyTo` 로 같은 줄을 그린다(비서 답엔 안 그림)",
      live !== undefined && rrOf(live)?.children[1]?.textContent === "실시간 원문" && order(live).join(",") === "bubble-meta,reply-ref,chat-message" &&
        liveOut !== undefined && rrOf(liveOut) === undefined,
      `실시간 ${live ? order(live).join(",") : "없음"} · 비서 ${liveOut && rrOf(liveOut) ? "그림" : "안 그림"}`,
    ),
  );
  jumps.length = 0;
  jumpResult = "ok";
  await (live && rrOf(live))?.fire("click");

  // 낙관 버블 — 보내는 순간
  run(`queueOptimisticBubble("대기 중 답글", { queued: true, cid: "c1", replyTo: { text: "낙관 원문", ts: 2600 } })`);
  const opt = appended[2];
  out.push(
    assert(
      "낙관 버블(보내는 순간)에도 같은 줄 · 실시간 줄도 눌러 이동",
      opt !== undefined && rrOf(opt)?.children[1]?.textContent === "낙관 원문" && jumps.join(",") === "2500",
      `낙관 ${opt ? order(opt).join(",") : "없음"} · 실시간 이동 ${jumps.join(",")}`,
    ),
  );
  return out;
};

/** 화면 항목 하나(가상화 `vtItems` 의 한 칸) — 노드와 그 노드의 data-* 를 흉내 낸다. */
const item = (data: Record<string, string>, inner?: Record<string, string>): { node: El; top: number } => {
  const node = new El("div");
  node.dataset = { ...data };
  if (inner !== undefined) { const c = new El("div"); c.dataset = { ...inner }; node.appendChild(c); }
  return { node, top: 0 };
};

// ── ⑤ 진짜 이동 — jumpToMessageTs + vtScrollToTs + replyTargetPick ────────────────
const jumpRun = async (): Promise<Assertion[]> => {
  const out: Assertion[] = [];
  const vtItems: Array<{ node: El; top: number }> = [];
  const pages: Array<Array<{ ts: number; id: number; inner?: Record<string, string> }> | "fail"> = [];
  let fetches = 0;
  let scrollTop = 0;
  const ctx = vm.createContext({
    console: { warn() {}, debug() {}, log() {} },
    window: {} as Record<string, unknown>,
    document: { querySelector: () => null, createElement: (t: string) => new El(t) },
    i18n: (k: string) => k,
    activeThreadKey: "dashboard:A",
    switchToken: 0,
    assistantName: "tiguclaw",
    currentView: "chat",
    historyLoadState: "ready",
    showOverview() {}, refreshChatEmpty() {}, scrollChatToNewest() {}, beginHistoryLoad() {}, endHistoryLoad() {}, setHistoryLoadState() {},
    // 이력 배치 = 받은 행을 화면 항목으로(위에 붙인다 — 과거 페이지).
    renderHistoryBatch: (entries: Array<{ ts: number; id: number; inner?: Record<string, string> }>) => {
      vtItems.unshift(...entries.map((e) => item({ ts: String(e.ts), id: String(e.id) }, e.inner)));
      vtItems.forEach((it, i) => { it.top = i * 100; });
    },
    fetch: async () => {
      fetches += 1;
      const pg = pages.shift();
      return pg === "fail" ? { ok: false, json: async () => ({}) } : { ok: true, json: async () => ({ entries: pg ?? [], activities: [] }) };
    },
    // vtScrollToTs 의 바깥(레이아웃·스크롤)만 대역.
    vtItems, stickBottom: true, updateChatJump() {}, relayout() {},
    getClientH: () => 900, scEl: () => ({ scrollTop }), setScrollTop: (v: number) => { scrollTop = v; },
    requestAnimationFrame: (cb: () => void) => setImmediate(cb),
    setTimeout: () => 0,
  });
  const hist = src("packages/dashboard/js/history-render.js");
  const virt = src("packages/dashboard/js/virtualization.js");
  vm.runInContext(section(virt, "      const vtTsOf = (el) => {", "      // ★현재 렌더된 마지막"), ctx);
  vm.runInContext(section(virt, "      const JUMP_PASSES = 14;", "      // 파일 확장자 → highlight.js"), ctx);
  vm.runInContext(section(hist, "      const replyTargetPick = (rt) => (items, strongOnly) => {", "      /**\n       * 답글 표시 줄"), ctx);
  vm.runInContext(section(hist, "      const HISTORY_PAGE = 20;", null), ctx);
  const run = <T>(code: string): T => vm.runInContext(code, ctx) as T;
  const reset = (loaded: Array<{ ts: number; id: number }>): void => {
    vtItems.length = 0;
    for (const e of loaded) vtItems.push(item({ ts: String(e.ts), id: String(e.id) }));
    vtItems.forEach((it, i) => { it.top = i * 100; });
    run(`setOldestCursor(${JSON.stringify(loaded)}, null); reachedOldest = false;`);
  };
  const hitIds = (): string[] => vtItems.filter((it) => it.node.classList.contains("msg-jump-hit")).map((it) => it.node.dataset.id ?? it.node.dataset.ts ?? "?");
  const jump = (rt: Record<string, unknown>): Promise<string> =>
    run<(ts: number, pick: unknown) => Promise<string>>("window.jumpToMessageTs")(rt.ts as number, run<(r: unknown) => unknown>("replyTargetPick")(rt));

  // (a) 원문(4990, #7)이 아직 안 그려졌고, 경계 근처(5000)에 다른 메시지가 그려져 있다 — 먼저 당기고 #7 에 내려앉아야 한다.
  reset(Array.from({ length: 20 }, (_, i) => ({ ts: 5000 + i, id: 50 + i })));
  pages.push([{ ts: 4980, id: 5 }, { ts: 4990, id: 6 }, { ts: 4990, id: 7 }, { ts: 4995, id: 8 }]);
  const a = await jump({ id: 7, ts: 4990 });
  const aHit = hitIds();
  out.push(
    assert(
      "⑤ ★원문이 첫 페이지 밖 — 먼저 과거를 당기고, 동률 시각(#6·#7) 중 행 id 로 #7 에 내려앉는다(경계 근처 #50 아님)",
      a === "ok" && aHit.join(",") === "7" && pages.length === 0,
      `결과 ${a} · 강조 ${aHit.join(",")} · 남은 페이지 ${pages.length}`,
    ),
  );
  // (b) 행 id·행 시각 없이 그려진 답(도구 턴) — 안쪽 말풍선의 완료 턴 id 로
  reset([{ ts: 6000, id: 60 }, { ts: 6100, id: 61 }]);
  vtItems.splice(1, 0, item({ ts: "6050" }, { turn: "turn-X" }));
  const b = await jump({ id: 999, ts: 6070, turn: "turn-X" });
  out.push(assert("⑤ 행 id·시각이 화면에 없으면 완료 턴 id(`data-turn`, 안쪽 말풍선)로 찾는다", b === "ok" && hitIds().join(",") === "6050", `결과 ${b} · 강조 ${hitIds().join(",")}`));
  // (c) 정확한 대상이 없다 — 60초 안에 다른 메시지가 있어도 «못 찾음»
  reset([{ ts: 7000, id: 70 }, { ts: 7010, id: 71 }]);
  run("reachedOldest = true;");
  const c = await jump({ id: 1234, ts: 7005 });
  out.push(assert("⑤ ★정확한 대상이 없으면 가까운 메시지(5ms 옆)를 원문으로 치지 않고 «not-found»", c === "not-found" && hitIds().length === 0, `결과 ${c} · 강조 ${hitIds().join(",")}`));
  // (e) R2 — 동률 시각이 페이지 경계에 걸렸다: 화면 최古 #8(5000), 원문 #7(5000)은 다음 페이지 — 더 당겨서 #7
  reset([{ ts: 5000, id: 8 }, { ts: 5001, id: 9 }]);
  pages.length = 0;
  pages.push([{ ts: 4999, id: 6 }, { ts: 5000, id: 7 }]);
  const e = await jump({ id: 7, ts: 5000 });
  out.push(
    assert(
      "⑤ ★동률 시각이 페이지 경계에 걸려도 원문 페이지를 당긴다(같은 시각의 #8 에 멈추지 않음)",
      e === "ok" && hitIds().join(",") === "7" && pages.length === 0,
      `결과 ${e} · 강조 ${hitIds().join(",")} · 남은 페이지 ${pages.length}`,
    ),
  );
  // (e2) R3 — 같은 경계에 **행 id 없는 같은 시각 카드**(이력 활동 카드 등)가 있어도, 시각 일치로 멈추지 말고 원문 #7 까지 당긴다
  reset([{ ts: 5000, id: 8 }, { ts: 5001, id: 9 }]);
  vtItems.unshift(item({ ts: "5000" }));
  pages.length = 0;
  pages.push([{ ts: 5000, id: 7 }]);
  const e2 = await jump({ id: 7, ts: 5000 });
  out.push(assert("⑤ ★동률 경계의 행 id 없는 같은 시각 카드에서 멈추지 않고 원문 #7 을 당긴다", e2 === "ok" && hitIds().join(",") === "7" && pages.length === 0, `결과 ${e2} · 강조 ${hitIds().join(",")} · 남은 페이지 ${pages.length}`));
  // (h2) R3 — 시각만 아는데 같은 시각 후보가 **서로 다른 페이지**에: 당겨 보니 둘 → 고르지 않는다
  reset([{ ts: 5000, id: 8 }]);
  pages.length = 0;
  pages.push([{ ts: 5000, id: 7 }]);
  fetches = 0;
  const h2 = await jump({ ts: 5000 });
  out.push(assert("⑤ 시각만 아는 동률이 페이지에 갈려 있어도 다 당겨 보고, 둘이면 고르지 않는다", h2 === "not-found" && fetches === 1 && hitIds().length === 0, `결과 ${h2} · 요청 ${fetches} · 강조 ${hitIds().join(",")}`));
  // (i) R3 — 당기기가 실패해 범위를 다 못 봤다: 시각만 같은 카드로 확정하지 않는다(강한 일치만)
  reset([{ ts: 5000, id: 8 }]);
  vtItems.unshift(item({ ts: "5000" }));
  pages.length = 0;
  pages.push("fail");
  const i9 = await jump({ id: 7, ts: 5000 });
  out.push(assert("⑤ ★당기기 실패로 범위를 다 못 봤으면 시각 폴백으로 «찾았다» 하지 않는다", i9 === "not-found" && hitIds().length === 0, `결과 ${i9} · 강조 ${hitIds().join(",")}`));
  // (f) R2 — 행 id 를 못 찾고 같은 시각의 **다른 행**(#8)이 있어도, 확인된 턴 id 쪽이 원문
  reset([{ ts: 6070, id: 8 }, { ts: 6100, id: 9 }]);
  vtItems.push(item({ ts: "6060" }, { turn: "turn-Y" }));
  vtItems.push(item({ ts: "6200" }, { ts: "6070" })); // 행 id 없는 같은 시각 말풍선(실시간 묶음 안) — 시각만으론 이게 걸린다
  run("reachedOldest = true;");
  const f = await jump({ id: 999, ts: 6070, turn: "turn-Y" });
  out.push(assert("⑤ ★확인된 턴 id 가 시각보다 먼저 — 같은 시각의 다른 행 #8·행 id 없는 같은 시각 말풍선을 원문으로 치지 않는다", f === "ok" && hitIds().join(",") === "6060", `결과 ${f} · 강조 ${hitIds().join(",")}`));
  // (g) 다른 행 id 를 가진 같은 시각 노드뿐 → 못 찾음 / (h) 시각만 아는데 같은 시각 후보가 둘 → 고르지 않음
  reset([{ ts: 6500, id: 65 }]);
  run("reachedOldest = true;");
  const g = await jump({ id: 999, ts: 6500 });
  reset([{ ts: 6600, id: 66 }]);
  vtItems.push(item({ ts: "6600" }));
  run("reachedOldest = true;");
  const h = await jump({ ts: 6600 });
  out.push(
    assert(
      "⑤ 시각은 가장 약한 증거 — 다른 행 id 를 가진 같은 시각 노드는 원문이 아니고, 시각만 같은 후보가 둘이면 고르지 않는다",
      g === "not-found" && h === "not-found" && hitIds().length === 0,
      `다른 id=${g} · 동률 둘=${h} · 강조 ${hitIds().join(",")}`,
    ),
  );
  // (d) 검색 이동(선택 없음)은 종전대로 가장 가까운 것
  reset([{ ts: 8000, id: 80 }, { ts: 8100, id: 81 }]);
  const d = await run<(ts: number) => Promise<string>>("window.jumpToMessageTs")(8090);
  out.push(assert("⑤ 검색 이동(정확 선택 없음)은 종전대로 가장 가까운 메시지", d === "ok" && hitIds().join(",") === "81", `결과 ${d} · 강조 ${hitIds().join(",")}`));
  return out;
};

// ── ⑥ 진짜 승격 — 낙관 버블 → sse.js echo ────────────────────────────────────────
const promoteRun = async (): Promise<Assertion[]> => {
  const out: Assertion[] = [];
  const vtItems: Array<{ node: El }> = [];
  const jumps: number[] = [];
  const drawnLive: number[] = [];
  const ctx = vm.createContext({
    console: { warn() {}, debug() {}, log() {} },
    setInterval: () => 0,
    setTimeout: () => 0,
    window: { jumpToMessageTs: async (ts: number) => { jumps.push(ts); return "ok"; } } as Record<string, unknown>,
    document: { getElementById: () => null, createElement: (t: string) => new El(t) },
    firstEvent: false, evCount: 0, evCountEl: new El("span"), currentView: "chat", showOverview() {},
    fmtTime: () => "12:00", i18n: (k: string) => k, currentLocale: () => "en",
    handleActivityLiveEvent() {}, typeClass: () => "t-other", applyFilter() {}, logSink: new El("div"), LOG_SINK_MAX: 50,
    isEndpointThread: () => false, activeThreadKey: "A", pendingQueued: [] as unknown[],
    isActiveThread: (tk: string) => tk === "A",
    bumpUnread() {}, markTurnActive() {}, markTurnDone() {}, scheduleErrClear() {}, cancelErrClear() {},
    markTurnCardDone() {}, setTurnCost() {}, setTurnEffort() {}, setTurnPhase() {},
    handleWorkerActivity: () => false, activityByStep: new Map(), stepKey: (x: string, y: unknown) => `${x}|${String(y)}`,
    annotateToolDuration() {}, renderActivity() {},
    renderChannelMessage: (ev: { ts: number }) => { drawnLive.push(ev.ts); },
    vtItems, vtAppend: (n: El) => { vtItems.push({ node: n }); }, vtOwns: () => false,
    setChatBody: (n: El, t: string) => { n.textContent = t; },
    localChatCount: 0, refreshChatEmpty() {}, scrollChatToNewest() {}, assistantName: "tiguclaw",
    vtClear() {}, cardByThread: new Map(), setOldestCursor() {},
    makeCardCaret: () => new El("span"), buildChannelBadge: () => null, renderModelLabel() {}, costLine: () => null,
    renderLocalChat() {},
  });
  const core = src("packages/dashboard/js/chat-core.js");
  const hist = src("packages/dashboard/js/history-render.js");
  vm.runInContext(section(core, "      const renderedMsgKeys = new Set();", "      /**\n       * 빈 채팅 자리에"), ctx);
  vm.runInContext(section(src("packages/dashboard/js/virtualization.js"), "      const vtTsOf =", "      // 하단 재-pin"), ctx);
  vm.runInContext(section(hist, "      const buildHistoryDiv = (entry) => {", "      // 보낸 메시지 버블 안 첨부 미리보기"), ctx);
  vm.runInContext(section(hist, "      const replyTargetPick = (rt) => (items, strongOnly) => {", "      // 메시지 유닛 → element"), ctx);
  vm.runInContext(src("packages/dashboard/js/sse.js"), ctx);
  vm.runInContext(
    "var buildAttachmentsPreview = () => document.createElement('div');" +
      section(src("packages/dashboard/js/axis1-options.js"), "      const queueOptimisticBubble", null),
    ctx,
  );
  const run = <T>(code: string): T => vm.runInContext(code, ctx) as T;
  run(`queueOptimisticBubble("대기 답글", { queued: true, cid: "cid-1", replyTo: { text: "낙관 원문", ts: 2600 } })`);
  const bubble = vtItems[0]?.node;
  const T = Date.now();
  run<(e: unknown) => void>("renderEvent")({
    type: "channel.message.in", ts: T,
    payload: { threadKey: "A", text: "대기 답글", correlationId: "cid-1", replyTo: { text: "서버 원문", ts: 2600 } },
  });
  const rr = bubble?.children.find((c) => c.classList.contains("reply-ref"));
  await rr?.fire("click");
  out.push(
    assert(
      "⑥ ★echo 승격 — 같은 버블이 제자리에서 확정되고(대기 배지 빠짐·서버 시각) 답글 줄은 **서버 값**으로(같은 자리 하나), 새 카드 0 · 눌러 이동",
      vtItems.length === 1 && bubble !== undefined && !bubble.classList.contains("queued") && bubble.dataset.ts === String(T) &&
        rr?.children[1]?.textContent === "서버 원문" && bubble.children.filter((c) => c.classList.contains("reply-ref")).length === 1 &&
        drawnLive.length === 0 && jumps.join(",") === "2600",
      `항목 ${vtItems.length} · queued=${bubble?.classList.contains("queued")} · ts=${bubble?.dataset.ts} · 줄=${JSON.stringify(rr?.children[1]?.textContent)} · 새 카드 ${drawnLive.length} · 이동 ${jumps.join(",")}`,
    ),
  );
  return out;
};

export const check: RegressionCheck = {
  name: "reply-shows-on-card",
  guards: "답글로 보낸 메시지 카드에 «무엇에 단 답글인지» 가 없던 것(재료가 와도 저장 안 됨) · 새로고침하면 사라지던 것 · 원문으로 못 옮기던 것 · 근처 다른 메시지에 내려앉던 것",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    initStore();
    const out: Assertion[] = [];

    // ── ① 순수 ──────────────────────────────────────────────────────────────
    const row = (ts: number, turnId?: string) => () => ({ ts, ...(turnId !== undefined ? { turnId } : {}) });
    const none = replyPreviewOf({}, row(1));
    const blank = replyPreviewOf({ replyToText: "  \n " }, row(1));
    const long = replyPreviewOf({ replyToText: "가".repeat(REPLY_PREVIEW_MAX_CHARS - 1) + "😀끝" }, () => undefined);
    const byRow = replyPreviewOf({ replyToText: "원문", replyToRef: { id: 7 }, replyToAt: 555 }, (id) => (id === 7 ? { ts: 1000, turnId: "t-7" } : undefined));
    const rowMiss = replyPreviewOf({ replyToText: "원문", replyToRef: { id: 7 }, replyToAt: 555 }, () => undefined);
    const throws = replyPreviewOf({ replyToText: "원문", replyToRef: { id: 7 }, replyToAt: 555 }, () => { throw new Error("db busy"); });
    const atOnly = replyPreviewOf({ replyToText: "원문", replyToAt: 555 }, row(1, "t-x"));
    const badAt = replyPreviewOf({ replyToText: "원문", replyToAt: Number.NaN }, row(1));
    out.push(
      assert(
        "① 답글이 아니면 없음 · 앞부분 상한에서 «…»(서로게이트 안 쪼갬)",
        none === undefined && blank === undefined && long !== undefined && long.text.endsWith("…") && !/[\uD800-\uDBFF]…$/.test(long.text) &&
          long.text.length <= REPLY_PREVIEW_MAX_CHARS + 1 && long.ts === undefined,
        `none=${String(none)} blank=${String(blank)} long=${long?.text.length}자 끝=${JSON.stringify(long?.text.slice(-2))}`,
      ),
    );
    out.push(
      assert(
        "① 이동 좌표 순서 — 행 시각·턴 id → (행 못 찾음·조회 실패) 말풍선 시각 → 없음 · 턴 id 는 행에서만 · 조회가 던져도 안 던진다",
        byRow?.ts === 1000 && byRow.id === 7 && byRow.turn === "t-7" && rowMiss?.ts === 555 && rowMiss.id === undefined && throws?.ts === 555 &&
          atOnly?.ts === 555 && atOnly.turn === undefined && badAt?.ts === undefined,
        JSON.stringify({ byRow, rowMiss, throws, atOnly, badAt }),
      ),
    );
    // ★자르기 전에 가린다 — 가짜 값(실제 자격 증명 아님)을 이 프로세스 env 에 잠시 둔다.
    const FAKE = "Q".repeat(80);
    process.env.REGR_REPLY_PREVIEW_TOKEN = FAKE;
    let secret: ReturnType<typeof replyPreviewOf>;
    try {
      secret = replyPreviewOf({ replyToText: "가".repeat(190) + " " + FAKE }, () => undefined);
    } finally {
      delete process.env.REGR_REPLY_PREVIEW_TOKEN;
    }
    out.push(
      assert(
        "① ★자르기 경계에 걸친 비밀도 가려진다(가림이 먼저) — 잘린 앞부분이 남지 않는다",
        secret !== undefined && !secret.text.includes("QQQQ") && secret.text.includes("[REDACTED"),
        JSON.stringify(secret?.text.slice(-40)),
      ),
    );
    const bounded = [replyPreviewFromPayload({ text: 3 }), replyPreviewFromPayload(null), replyPreviewFromPayload({ text: "x".repeat(9_000), ts: "1", turn: 5 })];
    out.push(
      assert(
        "① 적재 경계 — 모양이 틀리면 버리고, 길이를 다시 묶는다",
        bounded[0] === undefined && bounded[1] === undefined && bounded[2]?.text.length === REPLY_PREVIEW_MAX_CHARS + 1 && bounded[2].ts === undefined && bounded[2].turn === undefined,
        JSON.stringify(bounded.map((b) => (b === undefined ? null : { len: b.text.length, ts: b.ts ?? null, turn: b.turn ?? null }))),
      ),
    );

    // ── ② 진짜 버스 + 적재 + 조회 ────────────────────────────────────────────
    const TK = "dashboard:regr-reply-card";
    const T = 1_910_000_000_000;
    const orig = recordChatMessage({ ts: T, threadKey: TK, channel: "http-bridge", role: "assistant", text: "A 와 B 중 무엇으로 할까요?", turn: { id: "turn-regr-1", through: 3 } as never });
    const other = recordChatMessage({ ts: T, threadKey: "dashboard:regr-reply-other", channel: "http-bridge", role: "assistant", text: "다른 대화" });
    const bus = createEventBus();
    startEventPersistence(bus);
    const replyTo = replyPreviewOf({ replyToText: "A 와 B 중 무엇으로 할까요?", replyToRef: { id: orig! } }, (id) => chatRowCoords(TK, id));
    bus.publish({ type: "channel.message.in", ts: T + 10, payload: { channel: "http-bridge", threadKey: TK, text: "B로 해 REPLYCARD", replyTo } });
    bus.publish({ type: "channel.message.in", ts: T + 20, payload: { channel: "http-bridge", threadKey: TK, text: "그냥 메시지" } });
    bus.publish({ type: "channel.message.out", ts: T + 30, payload: { channel: "http-bridge", threadKey: TK, text: "비서 답", replyTo: { text: "섞임", ts: 1 } } });
    bus.publish({ type: "channel.message.in", ts: T + 40, payload: { channel: "http-bridge", threadKey: TK, text: "/휘발", ephemeral: true, replyTo: { text: "휘발 원문" } } });
    await new Promise((r) => setImmediate(r));
    const rows = getRecentChatLog({ threadKey: TK, limit: 20 });
    const reply = rows.find((r) => r.text === "B로 해 REPLYCARD");
    const plain = rows.find((r) => r.text === "그냥 메시지");
    const asst = rows.find((r) => r.text === "비서 답");
    out.push(
      assert(
        "② ★새로고침 경로 — 사용자 답글 행에 `data.replyTo`(앞부분·원문 행 id·그 행 시각·완료 턴 id)가 남는다",
        JSON.stringify(reply?.data) === JSON.stringify({ replyTo: { text: "A 와 B 중 무엇으로 할까요?", id: orig, ts: T, turn: "turn-regr-1" } }),
        JSON.stringify(reply?.data ?? null),
      ),
    );
    const cross = other === undefined ? "기록 실패" : JSON.stringify(chatRowCoords(TK, other) ?? null);
    out.push(assert("② 원문 좌표는 그 대화 화면 범위의 행만(남의 대화 번호는 없음)", cross === "null", cross));
    out.push(
      assert(
        "② 보존 — 답글 아닌 메시지·비서 답은 `data` 없음 · 휘발은 안 남는다",
        plain !== undefined && plain.data === undefined && asst !== undefined && asst.data === undefined && !rows.some((r) => r.text === "/휘발"),
        `평범 ${JSON.stringify(plain?.data ?? null)} · 비서 ${JSON.stringify(asst?.data ?? null)} · 행 ${rows.length}`,
      ),
    );
    const byId = reply?.id === undefined ? undefined : chatMessageById(TK, reply.id);
    out.push(
      assert(
        "② 모델이 읽는 전문 조회(`search_conversations(id)` 의 재료)엔 답글 표시가 안 섞인다 — 본문 그대로",
        byId?.text === "B로 해 REPLYCARD" && !JSON.stringify(byId).includes("replyTo"),
        JSON.stringify(byId),
      ),
    );

    // ── ③⑤⑥ 대시보드(VM) ────────────────────────────────────────────────────
    out.push(...(await dashboardRun()));
    out.push(...(await jumpRun()));
    out.push(...(await promoteRun()));

    // ── ④ 배선(소스 모양) ────────────────────────────────────────────────────
    const idx = src("src/index.ts");
    const echo = section(idx, "const publishInboundEcho = (", "\n};\n");
    const nonSynth = echo.slice(echo.indexOf("if (msg.synthetic === true)"));
    const call = /const replyTo = replyPreviewOf\(msg, \(id\) => chatRowCoords\(msg\.threadKey, id\)\);/.exec(nonSynth)?.[0] ?? "";
    const spread = /\.\.\.\(replyTo !== undefined \? \{ replyTo \} : \{\}\)/.exec(nonSynth)?.[0] ?? "";
    out.push(
      assert(
        "④ 인입 발행이 답글 표시를 싣는다(합성 턴 아닌 쪽) — 판정은 `replyPreviewOf` 한 곳",
        call !== "" && spread !== "",
        { 호출: call || "(없음)", 실음: spread || "(없음)" },
      ),
    );
    const bridge = src("plugins/http-bridge/routes-chat.ts");
    const replyJs = src("packages/dashboard/js/reply.js");
    const wires = {
      브리지: /\.\.\.\(replyToAt !== undefined \? \{ replyToAt \} : \{\}\)/.test(bridge),
      전송: /replyToAt: reply\.at/.test(replyJs),
      낙관: /replyTo: \{ text: reply\.text/.test(replyJs),
      메뉴: /startReply\(ctx\.text, ctx\.label, ctx\.replyRef, ctx\.at\)/.test(replyJs),
    };
    out.push(assert("④ 브리지가 말풍선 시각을 넘기고 · 대시보드가 보내고 · 낙관 버블에 싣는다", Object.values(wires).every(Boolean), wires));
    return out;
  },
};
