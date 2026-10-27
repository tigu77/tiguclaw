/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * 회귀: **비서 답(텍스트 세그먼트 말풍선)에 단 답글도 «↩ 원문» 으로 그 답에 정확히 옮겨 간다** (2026-10-25 사용자 신고).
 *
 * 사고(실측, 개발 세션): 비서 답에 단 답글 3건의 저장값(`chat_log.data.replyTo`)이 전부 `{text}` 뿐 — 카드가 버튼이 아니라 글로 남아 안 눌렸다(새로고침해도).
 *  사용자 원글 답글은 정상. 뿌리: 실시간 비서 답 말풍선(`ensureReplyBubble`)은 좌표가 없고, 텍스트 세그먼트가 그 참조를 버린 뒤 완료(`channel.message.out`)의
 *  «세그먼트를 낸 턴» 분기는 턴 묶음에 `data-turn` 만 붙였다 — 저장 좌표를 말풍선에 붙이는 일은 세그먼트 없는 «승격» 분기(10-19)에만 있었다.
 *  10-19 그물(`reply-quote-finds-original` ⑧)은 승격 분기 소스를 정규식으로만 봐서 세그먼트 분기를 원리적으로 못 봤다.
 *
 * 좌표 계약(설계: docs/decisions/2026-10-25-reply-assistant-segment-coords.md R3) — 비서 텍스트 말풍선:
 *  `data-ts` 화면·정렬 좌표(**불변**) · `data-seg` 이 시각은 활동 시각(행 조회 금지) · `data-rowid` 보여 주는 행 id(이력, 커서 아님) ·
 *  `data-rowts` 그 행의 시각(실시간 완료) · `data-turn` 완료 턴 id.
 *
 * 재는 것(전부 **동작** — 제품 js 를 VM 에서 그대로: SSE `renderEvent`→`renderDelta`/`renderActivity`/`renderChannelMessage` · `messageCtxFromEl` ·
 *  이력 `renderHistoryBatch`(병합 포함) · `replyTargetPick` · 가상화 `vtTsOf`/`vtCursorFromNodes` — 저장·변환은 진짜 저장소 + 진짜 브리지 `resolveReplyToRef` + `replyPreviewOf`):
 *  ⓐ 텍스트만 끝난 턴 ⓑ 텍스트→도구→텍스트(마지막·중간) ⓒ 텍스트→도구→완료 ⓔ 세그먼트 없는 승격(보존) ⓕ 사용자 원글(보존)
 *  ⓖ 중간 세그먼트 ms 의 다른 비서 행(행 조회 안 함) ⓗ 이력 세그먼트 행 id 가 커서를 바꾸지 않음 ⓘ 중단 뒤 새 턴 ⓙ 폴백(seq 재시작)
 *  ⓚ 이력 복원 뒤 replay ⓛ 완료 전 선택 → 완료 뒤 전송 ⓜ 정렬 시각 오름차순 ⓝ 턴 표식 없는 답 행.
 *  고른 대상은 «무엇이든 찾았다» 가 아니라 **원문 말풍선을 가진 바로 그 항목**인지로 본다(R1 #1).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { assert, assertIsolated, loadPluginModule, type Assertion, type RegressionCheck } from "./_framework.js";
import { makeDomContext } from "./_mini-dom.js";
import { initStore } from "../../store/sessions.js";
import { chatRowCoords, recordChatMessage } from "../../store/chat-log.js";
import { replyPreviewOf, type ReplyPreview } from "../../core/reply-preview.js";

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

type Resolve = (t: string, raw: unknown, tk: string) => { id: number; role?: string } | undefined;
type Item = { node: any };

/** 대시보드 한 화면 — 제품 js 를 새 VM 에 싣는다(실시간·새로고침을 서로 다른 화면으로). */
const screen = (tk: string) => {
  const handlers = new Map<string, (c: unknown) => unknown>();
  const bodies: Array<Record<string, unknown>> = [];
  const vtItems: Item[] = [];
  const vtIndex = new Map<any, number>();
  const { document, ctx } = makeDomContext({
    setInterval: () => 0, setTimeout: () => 0, clearTimeout() {}, requestAnimationFrame: () => 0,
    firstEvent: false, evCount: 0, currentView: "chat", showOverview() {},
    fmtTime: () => "12:00", i18n: (k: string) => k, currentLocale: () => "en",
    handleActivityLiveEvent() {}, typeClass: () => "t-other", applyFilter() {}, LOG_SINK_MAX: 50,
    isEndpointThread: () => false, activeThreadKey: tk, pendingQueued: [] as unknown[],
    isActiveThread: (k: string) => k === tk,
    bumpUnread() {}, markTurnActive() {}, markTurnDone() {}, scheduleErrClear() {}, cancelErrClear() {},
    handleWorkerActivity: () => false, activityByStep: new Map(), stepKey: (x: string, y: unknown) => `${x}|${String(y)}`,
    annotateToolDuration() {}, skillStepInfo: () => null, setTurnPhase() {}, ADAPTERS: ["claude", "codex", "openai"],
    vtItems, vtIndex,
    vtAppend: (n: any) => { vtItems.push({ node: n }); vtIndex.set(n, vtItems.length - 1); },
    vtPrependOlder: (ns: any[]) => { vtItems.unshift(...ns.map((n) => ({ node: n }))); vtIndex.clear(); vtItems.forEach((it, i) => vtIndex.set(it.node, i)); },
    vtOwns: () => false,
    setChatBody: (n: any, t: string) => { n.textContent = String(t ?? ""); },
    localChatCount: 0, refreshChatEmpty() {}, scrollChatToNewest() {}, assistantName: "tiguclaw",
    vtClear() {}, cardByThread: new Map(), setOldestCursor() {}, scheduleRelayout() {},
    makeCardCaret: () => document.createElement("span"), buildChannelBadge: () => null,
    renderLocalChat() {}, cancelQueuedBubble() {}, fmtElapsed: () => "",
    buildActivityLine: () => document.createElement("div"),
    chatKindBuilders: new Map(), renderedPromptOptionKeys: new Set(),
    // 답글 전송 사슬(reply.js) 바깥 — 메뉴 핸들러 등록·포커스·전송 부수효과·POST 본문 포착.
    registerBuiltinHandler: (id: string, fn: (c: unknown) => unknown) => { handlers.set(id, fn); },
    focusChatInput() {}, recordTypedTags() {}, activeTurns: new Map(), queueOptimisticBubble() {}, setChatWorking() {},
    fetch: async (_u: string, init: { body: string }) => { bodies.push(JSON.parse(init.body)); return { ok: true, status: 200, json: async () => ({}) }; },
  });
  const chatReply = document.createElement("div");
  chatReply.id = "chat-reply";
  document.body.appendChild(chatReply);
  ctx.evCountEl = document.createElement("span");
  ctx.logSink = document.createElement("div");
  vm.createContext(ctx);
  const run = <T>(code: string): T => vm.runInContext(code, ctx) as T;
  const hist = src("packages/dashboard/js/history-render.js");
  const virt = src("packages/dashboard/js/virtualization.js");
  run(section(src("packages/dashboard/js/chat-core.js"), "      const renderedMsgKeys = new Set();", "      /**\n       * 빈 채팅 자리에"));
  run(section(virt, "      const vtTsOf =", "      // 하단 재-pin"));
  run(section(virt, "      const vtCursorFromNodes = (nodes) => {", "      const vtCap = () => {"));
  run(section(virt, "      const agentOfThread = (thread) => {", "      // delta-only 턴"));
  run(section(virt, "      const createDeltaGroup = (p, ts, adapter, thread) => {", "      // 진행(타이핑) 버블을"));
  run(section(virt, "      const ensureReplyBubble = (card, ts) => {", "\n\n"));
  run(section(hist, "      const buildHistoryDiv = (entry) => {", "      // ── 페이지네이션 상태"));
  run(src("packages/dashboard/js/token-delta.js"));
  run(section(src("packages/dashboard/js/channel-hints.js"), "      const renderChannelMessage = (ev, ts) => {", null));
  run(src("packages/dashboard/js/sse.js"));
  const replyJs = src("packages/dashboard/js/reply.js");
  run(section(replyJs, "      const chatReplyEl = document.getElementById(\"chat-reply\");", "      // 메시지 카드 hover 시"));
  run(section(replyJs, "      const messageCtxFromEl = (msg) => {", "      registerBuiltinHandler(\"message.copy\""));
  run(section(replyJs, "      const sendChatMessage = async (text, attachments, reply, promptId) => {", "      const submitOptionValue"));
  const renderEvent = run<(e: unknown) => void>("renderEvent");
  const bubbles = (): any[] => vtItems.flatMap((it) => [it.node, ...it.node.querySelectorAll(".chat-message")]).filter((n) => n.classList?.contains("chat-message"));
  return {
    run, vtItems,
    ev: (e: unknown) => renderEvent(e),
    /** 그 글을 가진 말풍선(`.chat-message`) — 없으면 undefined. */
    msg: (text: string): any => bubbles().find((m) => m.textContent === text),
    ctxOf: (m: any): any => run<(m: unknown) => any>("messageCtxFromEl")(m),
    /** 메뉴 «답글» — 실제 핸들러(`message.reply` → `startReply`)로 고른다. */
    choose: (m: any): void => { handlers.get("message.reply")!(run<(m: unknown) => any>("messageCtxFromEl")(m)); },
    /** 고른 답글을 보낸다 — 실제 `sendChatMessage` 가 만든 POST 본문(입력창 전송과 같은 순서: 사본 → 비우기 → 전송). */
    sendChosen: async (text: string): Promise<Record<string, unknown>> => {
      await run<Promise<unknown>>(`(async () => { const r = replyingTo ? { ...replyingTo } : undefined; clearReply(); return sendChatMessage(${JSON.stringify(text)}, [], r); })()`);
      return bodies[bodies.length - 1] ?? {};
    },
    history: (entries: unknown[], activities: unknown[]) => { ctx.__e = entries; ctx.__a = activities; run("renderHistoryBatch(__e, __a, false)"); },
    pick: (rt: ReplyPreview | undefined): Item | null => (rt ? run<(r: unknown) => (i: Item[]) => Item | null>("replyTargetPick")(rt)(vtItems) : null),
    tsOrder: (): number[] => vtItems.map((it) => run<(n: unknown) => number | null>("vtTsOf")(it.node)).filter((t): t is number => t !== null),
    cursor: () => run<(n: unknown) => unknown>("vtCursorFromNodes")(vtItems.map((x) => ({ ts: run<(n: unknown) => number | null>("vtTsOf")(x.node), id: x.node.dataset.id !== undefined ? parseInt(x.node.dataset.id, 10) : NaN }))),
  };
};

/** 진짜 저장 경로 — 대시보드가 보낸 POST 본문 → 브리지 변환(`routes-chat.ts` 와 같은 규칙, 진짜 `resolveReplyToRef`) → 인입 발행 재료(`replyPreviewOf`, 대화 기록에 그대로 남는 값). */
const storeBody = (resolve: Resolve, tk: string, body: Record<string, unknown>): ReplyPreview | undefined => {
  const text = typeof body.replyToText === "string" ? body.replyToText.trim().slice(0, 50_000) : "";
  const ref = resolve(text, body.replyToRef, tk);
  const at = text !== "" && typeof body.replyToAt === "number" && Number.isFinite(body.replyToAt) ? body.replyToAt : undefined;
  return replyPreviewOf({ replyToText: text, ...(ref ? { replyToRef: ref } : {}), ...(at !== undefined ? { replyToAt: at } : {}) }, (id) => chatRowCoords(tk, id));
};
/** 화면에서 그 말풍선에 메뉴로 답글을 달아 보내고 저장값까지. */
const replyVia = async (resolve: Resolve, tk: string, sc: ReturnType<typeof screen>, m: any): Promise<ReplyPreview | undefined> => {
  sc.choose(m);
  return storeBody(resolve, tk, await sc.sendChosen("답글"));
};

/** 고른 항목이 원문 말풍선을 **그대로** 품고 있나(존재가 아니라 동일성). */
const holds = (it: Item | null, m: any): boolean => !!it && !!m && (it.node === m || it.node.contains(m));

let T = 1_900_100_000_000;
const nextT = (): number => (T += 10_000);

export const check: RegressionCheck = {
  name: "reply-assistant-bubble-coords",
  guards:
    "2026-10-25 비서 답(텍스트 세그먼트 말풍선)에 단 답글이 `{text}` 만 저장돼 «↩ 원문» 이 안 눌림 — 세그먼트 분기가 말풍선에 저장 좌표를 안 붙였다. " +
    "형제: 이력 세그먼트에 행 id 없음 · 중간 세그먼트 활동 시각이 같은 ms 의 다른 행을 원문으로 · 완료 때 data-ts 교체가 미리 고른 답글과 정렬을 깨뜨림(설계 R1·R2).",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    initStore();
    const { resolveReplyToRef: resolve } = await loadPluginModule<{ resolveReplyToRef: Resolve }>("../../../plugins/http-bridge/routes-chat.ts");
    const out: Assertion[] = [];

    // ── ⓐ 텍스트만 끝난 턴 · ⓛ 완료 전 선택 · ⓕ 사용자 원글 ─────────────────────────────
    {
      const TK = "dashboard:rabc-a";
      const tU = nextT(), tSeg = tU + 200, tOut = tU + 210;
      const uId = recordChatMessage({ ts: tU, threadKey: TK, channel: "http-bridge", role: "user", text: "질문 A" });
      const aId = recordChatMessage({ ts: tOut, threadKey: TK, channel: "http-bridge", role: "assistant", text: "답 A", turn: { id: "turn-a", through: 2 } as never });
      const live = screen(TK);
      live.ev({ type: "channel.message.in", ts: tU, payload: { threadKey: TK, text: "질문 A" } });
      live.ev({ type: "llm.delta", ts: tU + 100, payload: { threadKey: TK, adapter: "claude", delta: "답 A" } });
      live.ev({ type: "llm.activity", ts: tSeg, payload: { threadKey: TK, adapter: "claude", kind: "text", seq: 0, text: "답 A" } });
      const pre = live.ctxOf(live.msg("답 A")); // ⓛ 완료 전 — 메뉴가 넘길 재료
      live.choose(live.msg("답 A"));             // ⓛ 완료 전에 메뉴로 골라 둔다(보내기는 완료 뒤)
      live.ev({ type: "channel.message.out", ts: tOut, payload: { threadKey: TK, text: "답 A", turn: { id: "turn-a" } } });
      const liveA = live.msg("답 A");
      const sPre = storeBody(resolve, TK, await live.sendChosen("답글")); // ⓛ 완료 뒤 전송
      const sLive = await replyVia(resolve, TK, live, liveA);
      const sUser = await replyVia(resolve, TK, live, live.msg("질문 A"));
      const entries = [
        { id: uId, ts: tU, role: "user", text: "질문 A", threadKey: TK },
        { id: aId, ts: tOut, role: "assistant", text: "답 A", threadKey: TK, turnId: "turn-a" },
      ];
      const acts = [{ ts: tSeg, threadKey: TK, adapter: "claude", seq: 0, kind: "text", label: "text", detail: "", text: "답 A" }];
      const withActs = screen(TK); withActs.history(entries, acts);
      const noActs = screen(TK); noActs.history(entries, []);
      const sHist = await replyVia(resolve, TK, withActs, withActs.msg("답 A"));
      out.push(
        assert(
          "ⓐ 실시간 비서 답(세그먼트로 끝난 턴)에 단 답글 — 저장값이 행 id·행 시각·턴 id 를 갖는다(종전 `{text}` 뿐)",
          sLive?.id === aId && sLive?.ts === tOut && sLive?.turn === "turn-a",
          JSON.stringify(sLive),
        ),
        assert(
          "ⓐ 그 답글의 «↩ 원문» — 실시간·새로고침(활동 있음)·새로고침(활동 없음→평범한 행) 세 화면 모두 **원문 말풍선을 가진 그 항목**을 고른다",
          holds(live.pick(sLive), liveA) && holds(withActs.pick(sLive), withActs.msg("답 A")) && holds(noActs.pick(sLive), noActs.msg("답 A")),
          `실시간 ${holds(live.pick(sLive), liveA)} · 활동있음 ${holds(withActs.pick(sLive), withActs.msg("답 A"))} · 활동없음 ${holds(noActs.pick(sLive), noActs.msg("답 A"))}`,
        ),
        assert(
          "ⓐ 새로고침 뒤 이력 세그먼트에 단 답글도 행 id 로 저장되고(`data-rowid`) 활동 없는 화면에서도 고른다",
          sHist?.id === aId && sHist?.ts === tOut && sHist?.turn === "turn-a" && holds(noActs.pick(sHist), noActs.msg("답 A")) && holds(live.pick(sHist), liveA),
          JSON.stringify(sHist),
        ),
        assert(
          "ⓛ 완료 **전** 골라 둔 답글 — 행 조회는 안 하고(세그먼트 시각은 행 좌표가 아니다) 화면 좌표로 남아, 완료 뒤 실시간·새로고침(활동 있음) 화면에서 고른다",
          pre.replyRef === null && sPre?.id === undefined && sPre?.ts === tSeg && holds(live.pick(sPre), liveA) && holds(withActs.pick(sPre), withActs.msg("답 A")) &&
            liveA.closest(".ev.local").dataset.ts === String(tSeg),
          `ref=${JSON.stringify(pre.replyRef)} · 저장 ${JSON.stringify(sPre)} · 말풍선 ts=${liveA.closest(".ev.local").dataset.ts}`,
        ),
        assert(
          "ⓕ 사용자 원글 답글은 그대로(행 id·시각)",
          sUser?.id === uId && sUser?.ts === tU && holds(noActs.pick(sUser), noActs.msg("질문 A")),
          JSON.stringify(sUser),
        ),
      );
    }

    // ── ⓑ 텍스트→도구→텍스트 · ⓖ 중간 세그먼트 ms 의 다른 비서 행 · ⓜ 정렬 · ⓗ 커서 ───────────
    {
      const TK = "dashboard:rabc-b";
      const tU = nextT(), tSeg1 = tU + 100, tTool = tU + 110, tSeg2 = tU + 300, tOut = tU + 320;
      const uId = recordChatMessage({ ts: tU, threadKey: TK, channel: "http-bridge", role: "user", text: "질문 B" });
      // ⓖ 중간 세그먼트와 **같은 ms** 의 다른 비서 행 한 건(예: 통지) — 세그먼트 시각으로 행을 찾으면 이것을 원문으로 저장한다.
      const otherId = recordChatMessage({ ts: tSeg1, threadKey: TK, channel: "http-bridge", role: "assistant", text: "같은 ms 다른 행", notice: true } as never);
      const aId = recordChatMessage({ ts: tOut, threadKey: TK, channel: "http-bridge", role: "assistant", text: "최종 B", turn: { id: "turn-b", through: 4 } as never });
      const live = screen(TK);
      live.ev({ type: "channel.message.in", ts: tU, payload: { threadKey: TK, text: "질문 B" } });
      live.ev({ type: "llm.delta", ts: tU + 50, payload: { threadKey: TK, adapter: "claude", delta: "중간 B" } });
      live.ev({ type: "llm.activity", ts: tSeg1, payload: { threadKey: TK, adapter: "claude", kind: "text", seq: 0, text: "중간 B" } });
      live.ev({ type: "llm.activity", ts: tTool, payload: { threadKey: TK, adapter: "claude", kind: "tool", seq: 1, label: "Bash" } });
      live.ev({ type: "llm.delta", ts: tU + 200, payload: { threadKey: TK, adapter: "claude", delta: "최종 B" } });
      live.ev({ type: "llm.activity", ts: tSeg2, payload: { threadKey: TK, adapter: "claude", kind: "text", seq: 2, text: "최종 B" } });
      live.ev({ type: "channel.message.out", ts: tOut, payload: { threadKey: TK, text: "최종 B", turn: { id: "turn-b" } } });
      const mid = live.msg("중간 B"), fin = live.msg("최종 B");
      const cMid = live.ctxOf(mid);
      const sFin = await replyVia(resolve, TK, live, fin);
      const sMid = await replyVia(resolve, TK, live, mid);
      const entries = [
        { id: uId, ts: tU, role: "user", text: "질문 B", threadKey: TK },
        { id: otherId, ts: tSeg1, role: "assistant", text: "같은 ms 다른 행", threadKey: TK, notice: true },
        { id: aId, ts: tOut, role: "assistant", text: "최종 B", threadKey: TK, turnId: "turn-b" },
      ];
      const acts = [
        { ts: tSeg1, threadKey: TK, adapter: "claude", seq: 0, kind: "text", label: "text", detail: "", text: "중간 B" },
        { ts: tTool, threadKey: TK, adapter: "claude", seq: 1, kind: "tool", label: "Bash", detail: "" },
        { ts: tSeg2, threadKey: TK, adapter: "claude", seq: 2, kind: "text", label: "text", detail: "", text: "최종 B" },
      ];
      const withActs = screen(TK); withActs.history(entries, acts);
      const noActs = screen(TK); noActs.history(entries, []);
      const histMid = withActs.ctxOf(withActs.msg("중간 B"));
      const order = live.tsOrder();
      out.push(
        assert(
          "ⓑ 텍스트→도구→텍스트 — 마지막 말풍선 답글은 행 id 로, 고르기는 세 화면 모두 **마지막** 말풍선(중간 말풍선·도구 카드 아님)",
          sFin?.id === aId && sFin?.turn === "turn-b" && holds(live.pick(sFin), fin) && !holds(live.pick(sFin), mid) &&
            holds(withActs.pick(sFin), withActs.msg("최종 B")) && !holds(withActs.pick(sFin), withActs.msg("중간 B")) && holds(noActs.pick(sFin), noActs.msg("최종 B")),
          JSON.stringify(sFin),
        ),
        assert(
          "ⓖ 중간 세그먼트 답글 — 활동 시각으로 행을 찾지 않는다(같은 ms 의 다른 비서 행을 원문으로 저장하지 않음, 실시간·이력 둘 다) · 실시간 화면은 그 말풍선을 고르고 · " +
            "같은 시각 후보가 둘인 새로고침 화면은 **고르지 않는다**(다른 행으로 가지 않음 — 시각만 같은 후보 둘이면 모른다는 기존 규칙)",
          cMid.replyRef === null && histMid.replyRef === null && sMid?.id === undefined && sMid?.ts === tSeg1 &&
            holds(live.pick(sMid), mid) && withActs.pick(sMid) === null,
          `실시간 ref=${JSON.stringify(cMid.replyRef)} · 이력 ref=${JSON.stringify(histMid.replyRef)} · 저장 ${JSON.stringify(sMid)} · 다른 행 id=${otherId} · 새로고침 고름=${withActs.pick(sMid) === null ? "없음" : "있음"}`,
        ),
        assert(
          "ⓑ 중간 세그먼트 답글 — 시각 후보가 하나인 새로고침 화면에선 그 중간 말풍선을 고른다",
          (() => { const s2 = screen(TK); s2.history(entries.filter((e) => e.id !== otherId), acts); return holds(s2.pick(sMid), s2.msg("중간 B")); })(),
          JSON.stringify(sMid),
        ),
        assert(
          "ⓜ 실시간 항목의 정렬 시각이 오름차순(완료가 말풍선 data-ts 를 바꾸지 않는다)",
          order.length >= 3 && order.every((t, i) => i === 0 || order[i - 1]! <= t) && mid.closest(".ev.local").dataset.ts === String(tSeg1) && fin.closest(".ev.local").dataset.ts === String(tSeg2),
          JSON.stringify(order),
        ),
      );
      // ⓗ 이력 세그먼트만 남은 화면의 커서 — 행 id 는 커서 축(`data-id`)에 들어가지 않는다(같은 ms 행·활동 재수신 → 세그먼트 중복 생성 방지).
      const segOnly = screen(TK);
      segOnly.history([{ id: aId, ts: tOut, role: "assistant", text: "최종 B", threadKey: TK, turnId: "turn-b" }], [acts[2]]);
      const cur = segOnly.cursor() as { entries: unknown[]; fallbackTs: number } | null;
      out.push(
        assert(
          "ⓗ 이력 세그먼트 말풍선의 행 id 는 커서의 둘째 축이 아니다 — 커서 = (세그먼트 시각, id 없음)",
          cur !== null && cur.entries.length === 0 && cur.fallbackTs === tSeg2 && segOnly.vtItems[0]?.node.dataset.id === undefined,
          JSON.stringify(cur),
        ),
      );
    }

    // ── ⓒ 텍스트→도구→완료(끝이 도구) ───────────────────────────────────────────
    {
      const TK = "dashboard:rabc-c";
      const tU = nextT(), tSeg = tU + 100, tTool = tU + 110, tOut = tU + 400;
      const uId = recordChatMessage({ ts: tU, threadKey: TK, channel: "http-bridge", role: "user", text: "질문 C" });
      const aId = recordChatMessage({ ts: tOut, threadKey: TK, channel: "http-bridge", role: "assistant", text: "답 C", turn: { id: "turn-c", through: 3 } as never });
      const live = screen(TK);
      live.ev({ type: "channel.message.in", ts: tU, payload: { threadKey: TK, text: "질문 C" } });
      live.ev({ type: "llm.activity", ts: tSeg, payload: { threadKey: TK, adapter: "codex", kind: "text", seq: 0, text: "답 C" } });
      live.ev({ type: "llm.activity", ts: tTool, payload: { threadKey: TK, adapter: "codex", kind: "tool", seq: 1, label: "Bash" } });
      live.ev({ type: "channel.message.out", ts: tOut, payload: { threadKey: TK, text: "답 C", turn: { id: "turn-c" } } });
      const m = live.msg("답 C");
      const s = await replyVia(resolve, TK, live, m);
      const withActs = screen(TK);
      withActs.history(
        [{ id: uId, ts: tU, role: "user", text: "질문 C", threadKey: TK }, { id: aId, ts: tOut, role: "assistant", text: "답 C", threadKey: TK, turnId: "turn-c" }],
        [{ ts: tSeg, threadKey: TK, adapter: "codex", seq: 0, kind: "text", label: "text", detail: "", text: "답 C" }, { ts: tTool, threadKey: TK, adapter: "codex", seq: 1, kind: "tool", label: "Bash", detail: "" }],
      );
      out.push(
        assert(
          "ⓒ 텍스트→도구→완료 — 답 행 좌표가 앞 텍스트 말풍선에 붙고, 실시간 고르기가 뒤 도구 카드가 아니라 **그 말풍선의 항목**(R1 #1)",
          s?.id === aId && s?.turn === "turn-c" && holds(live.pick(s), m) && holds(withActs.pick(s), withActs.msg("답 C")),
          `저장 ${JSON.stringify(s)} · 고른 항목 ${live.vtItems.findIndex((it) => it === live.pick(s))} / 말풍선 항목 ${live.vtItems.findIndex((it) => holds(it, m))}`,
        ),
      );
    }

    // ── ⓟ 중간 세그먼트와 뒤 도구 단계가 **같은 ms** (어댑터가 세그먼트를 닫고 곧바로 도구를 발행 — 실제 브라우저 실측에서 간헐로 났다) ──
    {
      const TK = "dashboard:rabc-p";
      const tU = nextT(), tSeg1 = tU + 100, tSeg2 = tU + 300, tOut = tU + 320;
      const uId = recordChatMessage({ ts: tU, threadKey: TK, channel: "http-bridge", role: "user", text: "질문 P" });
      const aId = recordChatMessage({ ts: tOut, threadKey: TK, channel: "http-bridge", role: "assistant", text: "최종 P", turn: { id: "turn-p", through: 4 } as never });
      const live = screen(TK);
      live.ev({ type: "channel.message.in", ts: tU, payload: { threadKey: TK, text: "질문 P" } });
      live.ev({ type: "llm.delta", ts: tU + 50, payload: { threadKey: TK, adapter: "openai", delta: "중간 P" } });
      live.ev({ type: "llm.activity", ts: tSeg1, payload: { threadKey: TK, adapter: "openai", kind: "text", seq: 0, text: "중간 P" } });
      live.ev({ type: "llm.activity", ts: tSeg1, payload: { threadKey: TK, adapter: "openai", kind: "tool", seq: 1, label: "Bash" } }); // 같은 ms
      live.ev({ type: "llm.activity", ts: tSeg2, payload: { threadKey: TK, adapter: "openai", kind: "text", seq: 2, text: "최종 P" } });
      live.ev({ type: "channel.message.out", ts: tOut, payload: { threadKey: TK, text: "최종 P", turn: { id: "turn-p" } } });
      const sMid = await replyVia(resolve, TK, live, live.msg("중간 P"));
      const withActs = screen(TK);
      withActs.history(
        [{ id: uId, ts: tU, role: "user", text: "질문 P", threadKey: TK }, { id: aId, ts: tOut, role: "assistant", text: "최종 P", threadKey: TK, turnId: "turn-p" }],
        [
          { ts: tSeg1, threadKey: TK, adapter: "openai", seq: 0, kind: "text", label: "text", detail: "", text: "중간 P" },
          { ts: tSeg1, threadKey: TK, adapter: "openai", seq: 1, kind: "tool", label: "Bash", detail: "" },
          { ts: tSeg2, threadKey: TK, adapter: "openai", seq: 2, kind: "text", label: "text", detail: "", text: "최종 P" },
        ],
      );
      out.push(
        assert(
          "ⓟ 중간 세그먼트와 뒤 도구 단계가 같은 ms — 도구 카드·단계 줄은 원문 후보가 아니다: 실시간·새로고침 모두 그 중간 말풍선을 고른다",
          sMid?.ts === tSeg1 && sMid?.id === undefined && holds(live.pick(sMid), live.msg("중간 P")) && holds(withActs.pick(sMid), withActs.msg("중간 P")),
          `저장 ${JSON.stringify(sMid)} · 실시간 ${holds(live.pick(sMid), live.msg("중간 P"))} · 새로고침 ${holds(withActs.pick(sMid), withActs.msg("중간 P"))}`,
        ),
      );
    }

    // ── ⓔ 세그먼트 없는 승격(보존) · ⓝ 턴 표식 없는 답 행 ───────────────────────────
    {
      const TK = "dashboard:rabc-e";
      const tU = nextT(), tOut = tU + 150;
      recordChatMessage({ ts: tU, threadKey: TK, channel: "http-bridge", role: "user", text: "질문 E" });
      const aId = recordChatMessage({ ts: tOut, threadKey: TK, channel: "http-bridge", role: "assistant", text: "답 E", turn: { id: "turn-e", through: 2 } as never });
      const live = screen(TK);
      live.ev({ type: "channel.message.in", ts: tU, payload: { threadKey: TK, text: "질문 E" } });
      live.ev({ type: "llm.delta", ts: tU + 50, payload: { threadKey: TK, adapter: "openai", delta: "답 E" } });
      live.ev({ type: "channel.message.out", ts: tOut, payload: { threadKey: TK, text: "답 E", turn: { id: "turn-e" } } });
      const s = await replyVia(resolve, TK, live, live.msg("답 E"));
      out.push(assert("ⓔ 세그먼트 없는 승격 답글은 그대로(행 id·시각·턴)", s?.id === aId && s?.ts === tOut && s?.turn === "turn-e" && holds(live.pick(s), live.msg("답 E")), JSON.stringify(s)));
    }
    {
      const TK = "dashboard:rabc-n";
      const tU = nextT(), tSeg = tU + 100, tOut = tU + 130;
      const uId = recordChatMessage({ ts: tU, threadKey: TK, channel: "http-bridge", role: "user", text: "질문 N" });
      const aId = recordChatMessage({ ts: tOut, threadKey: TK, channel: "http-bridge", role: "assistant", text: "답 N" }); // 턴 표식 없음
      const live = screen(TK);
      live.ev({ type: "channel.message.in", ts: tU, payload: { threadKey: TK, text: "질문 N" } });
      live.ev({ type: "llm.activity", ts: tSeg, payload: { threadKey: TK, adapter: "claude", kind: "text", seq: 0, text: "답 N" } });
      live.ev({ type: "channel.message.out", ts: tOut, payload: { threadKey: TK, text: "답 N" } });
      const sLive = await replyVia(resolve, TK, live, live.msg("답 N"));
      const withActs = screen(TK);
      withActs.history([{ id: uId, ts: tU, role: "user", text: "질문 N", threadKey: TK }, { id: aId, ts: tOut, role: "assistant", text: "답 N", threadKey: TK }],
        [{ ts: tSeg, threadKey: TK, adapter: "claude", seq: 0, kind: "text", label: "text", detail: "", text: "답 N" }]);
      const sHist = await replyVia(resolve, TK, withActs, withActs.msg("답 N"));
      out.push(
        assert(
          "ⓝ 턴 표식 없는 답 행 — 실시간·이력 세그먼트 답글 모두 행 id 로 저장되고 실시간(행 시각)·새로고침(행 id) 화면에서 그 말풍선을 고른다(R2 #1)",
          sLive?.id === aId && sLive?.turn === undefined && sHist?.id === aId &&
            holds(live.pick(sLive), live.msg("답 N")) && holds(withActs.pick(sLive), withActs.msg("답 N")) && holds(live.pick(sHist), live.msg("답 N")),
          `실시간 ${JSON.stringify(sLive)} · 이력 ${JSON.stringify(sHist)}`,
        ),
      );
    }

    // ── ⓞ 고르기의 행 id 배제 — 다른 `data-rowid` 를 가진 같은 시각 말풍선은 원문이 아니다(R3 계약, GPT 코드 R1) ──
    {
      const sc = screen("dashboard:rabc-o");
      sc.run(`(() => {
        const mk = (ds) => { const d = document.createElement("div"); d.className = "ev local channel-chat"; Object.assign(d.dataset, ds); const m = document.createElement("div"); m.className = "chat-message"; m.textContent = ds.label; d.appendChild(m); vtAppend(d); };
        mk({ ts: "100", rowid: "202", seg: "1", label: "다른 행의 세그먼트" });
        mk({ ts: "300", rowid: "303", seg: "1", label: "그 행의 세그먼트" });
      })()`);
      const other = sc.pick({ text: "x", id: 101, ts: 100 });
      const same = sc.pick({ text: "x", id: 303, ts: 999 });
      const tsOnly = sc.pick({ text: "x", ts: 100 });
      out.push(
        assert(
          "ⓞ 요청한 행 id 와 다른 `data-rowid` 를 가진 말풍선은 시각이 같아도 고르지 않는다 · 같은 `data-rowid` 는 시각이 달라도 고른다 · 행 id 없는 시각만의 요청은 그 말풍선",
          other === null && same !== null && holds(same, sc.msg("그 행의 세그먼트")) && tsOnly !== null && holds(tsOnly, sc.msg("다른 행의 세그먼트")),
          `다른 id=${other === null ? "안 고름" : "고름"} · 같은 rowid=${same ? "고름" : "안 고름"} · 시각만=${tsOnly ? "고름" : "안 고름"}`,
        ),
      );
    }

    // ── ⓘ 중단 뒤 새 턴 · ⓙ 폴백(seq 재시작) · ⓚ 이력 복원 뒤 replay ────────────────────
    {
      const TK = "dashboard:rabc-i";
      const t1 = nextT(), tSeg1 = t1 + 100, tCut = t1 + 150, tSeg2 = t1 + 300, tOut2 = t1 + 320;
      recordChatMessage({ ts: t1, threadKey: TK, channel: "http-bridge", role: "user", text: "질문 I" });
      recordChatMessage({ ts: tCut, threadKey: TK, channel: "http-bridge", role: "user", text: "끼어든 말" });
      const a2 = recordChatMessage({ ts: tOut2, threadKey: TK, channel: "http-bridge", role: "assistant", text: "새 턴 답", turn: { id: "turn-i2", through: 5 } as never });
      const live = screen(TK);
      live.ev({ type: "channel.message.in", ts: t1, payload: { threadKey: TK, text: "질문 I" } });
      live.ev({ type: "llm.activity", ts: tSeg1, payload: { threadKey: TK, adapter: "claude", kind: "text", seq: 0, text: "중단 전 말" } });
      live.ev({ type: "channel.message.in", ts: tCut, payload: { threadKey: TK, text: "끼어든 말" } }); // 진행 중 턴을 닫는다
      live.ev({ type: "llm.activity", ts: tSeg2, payload: { threadKey: TK, adapter: "claude", kind: "text", seq: 1, text: "새 턴 답" } });
      live.ev({ type: "channel.message.out", ts: tOut2, payload: { threadKey: TK, text: "새 턴 답", turn: { id: "turn-i2" } } });
      const before = live.msg("중단 전 말").closest(".ev.local").dataset;
      const s = await replyVia(resolve, TK, live, live.msg("새 턴 답"));
      out.push(
        assert(
          "ⓘ 중단된 턴의 말풍선엔 다음 턴 답의 좌표가 안 붙는다 · 새 턴 답은 자기 행 좌표",
          before.rowts === undefined && before.turn === undefined && s?.id === a2 && holds(live.pick(s), live.msg("새 턴 답")),
          `중단 전 ${JSON.stringify(before)} · 새 턴 ${JSON.stringify(s)}`,
        ),
      );
    }
    {
      const TK = "dashboard:rabc-j";
      const t1 = nextT(), tA = t1 + 100, tB = t1 + 300, tOut = t1 + 320;
      recordChatMessage({ ts: t1, threadKey: TK, channel: "http-bridge", role: "user", text: "질문 J" });
      const aId = recordChatMessage({ ts: tOut, threadKey: TK, channel: "http-bridge", role: "assistant", text: "폴백 답", turn: { id: "turn-j", through: 3 } as never });
      const live = screen(TK);
      live.ev({ type: "channel.message.in", ts: t1, payload: { threadKey: TK, text: "질문 J" } });
      live.ev({ type: "llm.activity", ts: tA, payload: { threadKey: TK, adapter: "codex", kind: "text", seq: 0, text: "첫 시도 말" } });
      live.ev({ type: "llm.turn_error", ts: tA + 5, payload: { threadKey: TK, adapter: "codex", errorKind: "error", message: "x" } });
      live.ev({ type: "llm.activity", ts: tB, payload: { threadKey: TK, adapter: "claude", kind: "text", seq: 0, text: "폴백 답" } });
      live.ev({ type: "channel.message.out", ts: tOut, payload: { threadKey: TK, text: "폴백 답", turn: { id: "turn-j" } } });
      const first = live.msg("첫 시도 말")?.closest(".ev.local").dataset;
      const s = await replyVia(resolve, TK, live, live.msg("폴백 답"));
      out.push(
        assert(
          "ⓙ 폴백(seq 재시작) — 답 행 좌표는 마지막 시도의 말풍선에만(첫 시도 말풍선엔 없음)",
          first !== undefined && first.rowts === undefined && first.turn === undefined && s?.id === aId && holds(live.pick(s), live.msg("폴백 답")),
          `첫 시도 ${JSON.stringify(first)} · 저장 ${JSON.stringify(s)}`,
        ),
      );
    }
    {
      const TK = "dashboard:rabc-k";
      const tU = nextT(), tSeg = tU + 100, tOut = tU + 120;
      const uId = recordChatMessage({ ts: tU, threadKey: TK, channel: "http-bridge", role: "user", text: "질문 K" });
      const aId = recordChatMessage({ ts: tOut, threadKey: TK, channel: "http-bridge", role: "assistant", text: "답 K", turn: { id: "turn-k", through: 2 } as never });
      const sc = screen(TK);
      sc.history([{ id: uId, ts: tU, role: "user", text: "질문 K", threadKey: TK }, { id: aId, ts: tOut, role: "assistant", text: "답 K", threadKey: TK, turnId: "turn-k" }],
        [{ ts: tSeg, threadKey: TK, adapter: "claude", seq: 0, kind: "text", label: "text", detail: "", text: "답 K" }]);
      const n0 = sc.vtItems.length;
      sc.ev({ type: "llm.activity", ts: tSeg, payload: { threadKey: TK, adapter: "claude", kind: "text", seq: 0, text: "답 K" } });
      sc.ev({ type: "channel.message.out", ts: tOut, payload: { threadKey: TK, text: "답 K", turn: { id: "turn-k" } } });
      const s = await replyVia(resolve, TK, sc, sc.msg("답 K"));
      out.push(
        assert(
          "ⓚ 이력 복원 뒤 activity/out replay — 새 항목 0 · 이력 말풍선 답글은 그대로 행 id",
          sc.vtItems.length === n0 && s?.id === aId && holds(sc.pick(s), sc.msg("답 K")),
          `항목 ${n0}→${sc.vtItems.length} · 저장 ${JSON.stringify(s)}`,
        ),
      );
    }
    return out;
  },
};
