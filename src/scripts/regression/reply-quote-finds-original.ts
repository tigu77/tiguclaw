/**
 * 회귀: **답글 인용이 «어느 메시지인지(대화 기록 행 id)» 를 싣고, 줄었으면 비서가 그 전문을 정확히 다시 읽는다** (2026-10-19).
 *
 * 사고(실측, 돌쇠): 답글 턴 130건 중 21건(16%)의 인용이 1,500자에서 잘려 끝(질문)이 빠졌다 — «답글 응답에 엉뚱한 소리를 할 때가 있다».
 *  긴 원문은 지금도 앞·끝만 남기므로 좌표가 필요하다. ★첫 판은 **시각 ±3초 가장 가까운 메시지**로 찾았다 — 텔레그램은 원글 시각과 대화 기록
 *  시각이 어긋나(발송 뒤 기록 · 청크 · 429 대기) **가까운 다른 말을 원문으로** 돌려줄 수 있었다(아스트라 10-19). 그래서 **행 id** 로 바꿨다 —
 *  대시보드 이력 말풍선은 이미 `data-id` 를 갖고, 텔레그램은 원글 message_id 를 대화 기록을 쓸 때 묶어 둔 매핑으로 바꾼다.
 *
 * 재는 것:
 *  ① 인용 머리 — 대상(보낸 쪽·#행 번호) · 줄었을 때만 «threadKey·id 로 읽으세요(offset 으로 이어서)» · threadKey 는 JSON 으로(따옴표가 문장을 안 깬다) ·
 *     좌표 없으면 종전 모양.
 *  ② 저장소 — 적재가 행 id 를 돌려준다 · `chatMessageById` 는 **그 대화 범위**만 · `chatIdAtExactTs` 는 정확히 같은 시각·발화자 **한 건**일 때만
 *     (둘이면·1ms 어긋나면 없음 — 추측하지 않는다) · 채널 메시지 id(여러 청크) → 같은 행.
 *  ③ ★적재 이음매(진짜 이벤트 버스 + 진짜 적재) — 송신 이벤트의 채널 메시지 id 가 그 행에 묶인다 · egress 사본은 안 묶인다.
 *  ④ 진짜 도구 `search_conversations(id)` — 전문 · 2만 자 넘으면 offset 으로 이어 읽기 · 다른 대화의 번호는 not_found · threadKey 없으면 거절 · query 경로 그대로.
 *  ⑤ 브리지 변환 — `{id}` 그대로 · `{ts}` 는 정확히 한 건일 때만 · 모양이 틀리거나 큰 수(1e20)여도 터지지 않고 없음.
 *  ⑥ 끼워넣기·재주입 — 메시지마다 **자기** 좌표.
 *  ⑦ 배선 — 대시보드가 id/ts 를 보내고 · 텔레그램이 원글 id 를 행 id 로 바꾸고 인입 id 를 싣고 · 핸들러·deliverOutbound 가 보낸 id 를 이벤트에 싣는다.
 *  ⑨ ★적대 검토 10-19 — 답장 라우팅이 고른 대화에 없는 행은 좌표를 싣지 않는다(not_found 안내 방지) · 남의 대화 id 를 브리지가 거른다 ·
 *     매핑 조회가 실패해도 **던지지 않는다**(텔레그램 핸들러가 라우팅보다 앞에서 부른다 — 던지면 답장이 조용히 유실).
 *  ⑧ ★방금 받은 답(스트리밍 → 완료 승격)에 단 답글(아스트라 10-19 후속) — 승격이 저장 이벤트 시각을 말풍선에 붙이고(배선), 진짜 `messageCtxFromEl`(reply.js,
 *     VM 실행)이 그 시각·발화자를 대상으로 내고, 브리지가 같은 원문 행 id 로 바꾼다. 시각이 없던 승격 전 모양은 대상 없음(종전 결함의 재현).
 * 등급: ①~⑥ **동작**(순수 함수 · 진짜 저장소 · 진짜 이벤트 버스 · 진짜 도구 핸들러), ⑦ 배선(소스 모양).
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { assert, assertIsolated, loadPluginModule, type Assertion, type RegressionCheck } from "./_framework.js";
import { getDb, initStore } from "../../store/sessions.js";
import { bindChannelMessages, chatIdAtExactTs, chatIdForChannelMessage, chatMessageById, recordChatMessage, replyTargetInThread } from "../../store/chat-log.js";
import { withReplyQuote } from "../../core/reply-quote.js";
import { buildReinjectMessage, toSteeringInput } from "../../core/steering.js";
import { createEventBus } from "../../core/eventbus.js";
import { channelRefsField, startEventPersistence } from "../../core/event-persist.js";

const src = (rel: string): string => readFileSync(new URL(rel, import.meta.url), "utf8");

export const check: RegressionCheck = {
  name: "reply-quote-finds-original",
  guards: "답글 인용이 길어 가운데가 줄면 비서가 «무엇에 대한 말인지» 모르고 엉뚱하게 답하던 것 + 시각으로 고르면 가까운 다른 말을 원문으로 돌려주던 것",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    initStore();
    const TK = "dashboard:regr-reply-ref";
    const T = 1_900_000_000_000;
    const longText = "앞부분 ".repeat(4_000) + "가운데 질문: 8발로 할까요? " + "뒷부분 ".repeat(4_000); // ≈ 3.2만 자 — 2만 자 넘김
    // ② 저장소
    const idA = recordChatMessage({ ts: T, threadKey: TK, channel: "http-bridge", role: "assistant", text: longText });
    const idU = recordChatMessage({ ts: T + 1, threadKey: TK, channel: "http-bridge", role: "user", text: "바로 뒤 사용자 말" });
    recordChatMessage({ ts: T + 5, threadKey: TK, channel: "http-bridge", role: "assistant", text: "같은 시각 하나" });
    recordChatMessage({ ts: T + 5, threadKey: TK, channel: "http-bridge", role: "assistant", text: "같은 시각 둘" });
    const idOther = recordChatMessage({ ts: T, threadKey: "dashboard:regr-reply-other", channel: "http-bridge", role: "assistant", text: "다른 대화" });
    const byId = idA === undefined ? undefined : chatMessageById(TK, idA);
    const crossThread = idOther === undefined ? undefined : chatMessageById(TK, idOther);
    const exactTs = chatIdAtExactTs(TK, T, "assistant");
    const offByOne = chatIdAtExactTs(TK, T + 2, "assistant");
    const ambiguous = chatIdAtExactTs(TK, T + 5, "assistant");
    bindChannelMessages("telegram", "777", [101, 102, 103], idA!, T);
    const chunks = [101, 102, 103].map((m) => chatIdForChannelMessage("telegram", "777", m));
    const unmapped = chatIdForChannelMessage("telegram", "777", 999);

    // ① 인용 머리
    const shortQ = withReplyQuote("8발로", "짧은 원문", { threadKey: TK, id: idA!, role: "assistant" });
    const longQ = withReplyQuote("8발로", longText, { threadKey: 'dashboard:"q', id: idA!, role: "assistant" });
    const noRef = withReplyQuote("8발로", "짧은 원문");

    // ③ 적재 이음매 — 진짜 버스 + 진짜 적재
    const bus = createEventBus();
    startEventPersistence(bus);
    bus.publish({ type: "channel.message.out", ts: T + 100, payload: { channel: "telegram", threadKey: TK, text: "텔레그램으로 간 답", ...channelRefsField("telegram", { address: "888", messageIds: [201, 202] }) } });
    bus.publish({ type: "channel.message.in", ts: T + 200, payload: { channel: "telegram", threadKey: TK, text: "사용자가 보낸 말", ...channelRefsField("telegram", { address: "888", messageIds: [301] }) } });
    bus.publish({ type: "channel.message.out", ts: T + 300, payload: { channel: "telegram", threadKey: TK, text: "사본", copyOfRecorded: true, ...channelRefsField("telegram", { address: "888", messageIds: [401] }) } });
    await new Promise((r) => setTimeout(r, 30));
    const outRow = chatIdForChannelMessage("telegram", "888", 202);
    const outText = outRow === undefined ? undefined : chatMessageById(TK, outRow)?.text;
    const inRow = chatIdForChannelMessage("telegram", "888", 301);
    const inRole = inRow === undefined ? undefined : chatMessageById(TK, inRow)?.role;
    const copyRow = chatIdForChannelMessage("telegram", "888", 401);

    // ④ 진짜 도구
    type Reg = Record<string, { handler: (a: unknown, x?: unknown) => Promise<{ content: Array<{ text: string }> }> }>;
    const { createMemoryMcpServer } = await import("../../core/memory-mcp.js");
    const reg = (createMemoryMcpServer().instance as unknown as { _registeredTools: Reg })._registeredTools;
    const call = async (args: unknown): Promise<Record<string, unknown>> =>
      JSON.parse((await reg["search_conversations"]!.handler(args, {})).content.map((c) => c.text).join("")) as Record<string, unknown>;
    type Msg = { text?: string; nextOffset?: number; length?: number };
    const p1 = await call({ id: idA, threadKey: TK });
    const m1 = p1.message as Msg;
    const p2 = await call({ id: idA, threadKey: TK, offset: m1?.nextOffset });
    const m2 = p2.message as Msg;
    const other = await call({ id: idOther, threadKey: TK });
    const noTk = await call({ id: idA });
    const plain = await call({ query: "아무거나" });

    // ⑤ 브리지 변환
    const bridgeMod = await loadPluginModule<{ resolveReplyToRef: (t: string, raw: unknown, tk: string) => { id: number; role?: string } | undefined }>("../../../plugins/http-bridge/routes-chat.ts");
    const r = bridgeMod.resolveReplyToRef;
    const bId = r("인용", { id: idU, role: "user" }, TK);
    const bTs = r("인용", { ts: T, role: "assistant" }, TK);
    const bAmb = r("인용", { ts: T + 5, role: "assistant" }, TK);
    let bBig: unknown = "throw";
    try { bBig = r("인용", { ts: 1e20 }, TK) ?? null; } catch { bBig = "throw"; }
    const bNoText = r("", { id: idU }, TK);

    // ⑥ 끼워넣기·재주입
    const steerA = toSteeringInput({ channel: "http-bridge", threadKey: TK, text: "A 에 답", replyToText: longText, replyToRef: { id: idA, role: "assistant" } } as never);
    const steerB = toSteeringInput({ channel: "http-bridge", threadKey: TK, text: "그냥 말" } as never);
    const opener = { channel: "http-bridge", threadKey: TK, text: "턴을 연 말", replyToText: "연 메시지의 원문", replyToRef: { id: 424242, role: "user" } };
    const re = buildReinjectMessage(opener as never, [steerA, steerB]);

    // ⑧ 방금 받은 답 — 진짜 messageCtxFromEl 을 VM 으로(브라우저 없이). 말풍선은 ensureReplyBubble 이 만드는 모양(.ev.local · data-type=out).
    const replyJs = src("../../../packages/dashboard/js/reply.js");
    const fnStart = replyJs.indexOf("const messageCtxFromEl = (msg) => {");
    let depth = 0, fnEnd = -1;
    for (let i = replyJs.indexOf("{", fnStart); i < replyJs.length; i++) {
      if (replyJs[i] === "{") depth++;
      else if (replyJs[i] === "}") { depth--; if (depth === 0) { fnEnd = i + 1; break; } }
    }
    const ctxFn = vm.runInNewContext(`(${replyJs.slice(replyJs.indexOf("(msg) =>", fnStart), fnEnd)})`, { i18n: (k: string) => k, Date, Number }) as (m: unknown) => { replyRef: unknown };
    const bubble = (dataset: Record<string, string>) => {
      const host = { dataset, querySelector: () => null };
      return { textContent: "방금 받은 답", dataset: {}, closest: (sel: string) => (sel.includes(".ev.local") ? host : null), parentElement: host };
    };
    const LIVE_TS = T + 7;
    const liveId = recordChatMessage({ ts: LIVE_TS, threadKey: TK, channel: "http-bridge", role: "assistant", text: "방금 받은 답" });
    const beforeFix = ctxFn(bubble({ type: "channel.message.out" })).replyRef; // 승격이 시각을 안 붙이던 모양
    const afterFix = ctxFn(bubble({ type: "channel.message.out", ts: String(LIVE_TS) })).replyRef;
    const liveResolved = r("방금 받은 답", afterFix, TK);
    const hints = src("../../../packages/dashboard/js/channel-hints.js");
    const promo = hints.slice(hints.indexOf("if (card && !card.interrupted && card.replyBubble && vtIndex.has(card.group)) {"));
    const promoBody = promo.slice(0, promo.indexOf("card.replyBubble = null;"));

    // ⑨ 대화 범위 확인 · 조회 실패가 안 던짐
    const inThread = replyTargetInThread(TK, idA);
    const notInThread = replyTargetInThread(TK, idOther);
    const bOther = r("인용", { id: idOther }, TK);
    getDb().exec("ALTER TABLE chat_message_refs RENAME TO chat_message_refs_regr");
    let lookupThrew = false, lookupVal: unknown = "x";
    try { lookupVal = chatIdForChannelMessage("telegram", "777", 101) ?? null; } catch { lookupThrew = true; }
    getDb().exec("ALTER TABLE chat_message_refs_regr RENAME TO chat_message_refs");

    // ⑦ 배선
    const reply = src("../../../packages/dashboard/js/reply.js");
    const tg = src("../../../plugins/telegram-channel/index.ts");
    const idx = src("../../index.ts");
    const outb = src("../../core/outbound.ts");

    return [
      assert("★좌표가 있으면 머리에 «대상: 비서(나)의 메시지 #id» · 줄지 않았으면 전문 읽기 안내는 없다",
        shortQ.includes(`대상: 비서(나)의 메시지 #${idA}`) && !shortQ.includes("전문이 필요하면"), shortQ.slice(0, 140)),
      assert("★줄었으면 «threadKey·id 로 읽으세요(offset 으로 이어서)» — threadKey 는 JSON 이라 따옴표가 문장을 안 깬다",
        longQ.includes("가운데를 줄였습니다") && longQ.includes(`threadKey="dashboard:\\"q" id=${idA}`) && longQ.includes("offset"), longQ.slice(-260)),
      assert("좌표가 없으면 종전 모양 그대로", !noRef.includes("대상:") && !noRef.includes("전문이 필요하면"), noRef.slice(0, 100)),
      assert("★저장소: id 로 그 대화의 행 · 다른 대화의 id 는 없음 · 정확히 같은 시각·발화자 한 건만(1ms 어긋남·둘이면 없음)",
        byId?.text === longText && crossThread === undefined && exactTs === idA && offByOne === undefined && ambiguous === undefined,
        { byId: byId?.id, crossThread, exactTs, offByOne, ambiguous }),
      assert("채널 메시지 id 의 여러 청크가 같은 행을 가리킨다 · 매핑 없으면 없음", chunks.every((c) => c === idA) && unmapped === undefined, { chunks, unmapped }),
      assert("★적재 이음매: 송신·수신 이벤트의 채널 메시지 id 가 그 행에 묶인다 · egress 사본은 안 묶인다",
        outText === "텔레그램으로 간 답" && inRole === "user" && copyRow === undefined, { outRow, outText, inRow, inRole, copyRow }),
      assert("★진짜 도구: id 로 전문 · 2만 자 넘으면 nextOffset 으로 이어 읽어 합치면 원문 그대로",
        p1.ok === true && typeof m1?.nextOffset === "number" && p2.ok === true && (m1.text ?? "") + (m2?.text ?? "") === longText && m2?.nextOffset === undefined,
        { len: m1?.length, part1: (m1?.text ?? "").length, next: m1?.nextOffset, part2: (m2?.text ?? "").length }),
      assert("다른 대화의 번호는 not_found · threadKey 없으면 거절 · query 경로 그대로",
        other.error === "not_found" && noTk.error === "threadKey_required" && plain.ok === true && Array.isArray(plain.hits), { other: other.error, noTk: noTk.error, plain: plain.ok }),
      assert("★브리지: {id} 그대로 · {ts} 는 정확히 한 건일 때만 · 둘이면 없음 · 1e20 도 터지지 않고 없음 · 인용 없으면 없음",
        bId?.id === idU && bId?.role === "user" && bTs?.id === idA && bAmb === undefined && bBig === null && bNoText === undefined, { bId, bTs, bAmb, bBig, bNoText }),
      assert("★끼워넣기는 자기 좌표 · 재주입은 메시지마다 자기 좌표 — 턴을 연 메시지의 좌표·원문이 섞이지 않는다",
        steerA.text.includes(`메시지 #${idA}`) && re !== null && re.text.includes(`id=${idA}`) && !re.text.includes("#424242") && !("replyToRef" in re) && !("replyToText" in re),
        re === null ? "★null" : re.text.slice(0, 160)),
      assert("배선: 대시보드 id/ts · 텔레그램 원글 id→행 id·인입 id · 핸들러·deliverOutbound 가 보낸 id 를 이벤트에",
        /replyToRef: reply\.ref/.test(reply) && /ds\.id/.test(reply) && /chatIdForChannelMessage\("telegram"/.test(tg) && /channelMessageRef: \{ address: chatId, messageIds: \[ctx\.message\.message_id\] \}/.test(tg) &&
          /const sentRef = await msg\.reply\(/.test(idx) && /channelRefsField\(msg\.channel, sentRef\)/.test(idx) && /channelRefsField\(msg\.channel, msg\.channelMessageRef\)/.test(idx) &&
          /copy \? \{\} : channelRefsField\(channel, sentRef\)/.test(outb),
        "소스 모양"),
      assert("★그 대화에서 읽히는 행만 좌표로(다른 대화의 행은 없음 — not_found 안내 방지) · 브리지도 남의 대화 id 를 거른다 · 매핑 조회 실패가 던지지 않는다",
        inThread === idA && notInThread === undefined && bOther === undefined && !lookupThrew && lookupVal === null, { inThread, notInThread, bOther, lookupThrew, lookupVal }),
      assert("★방금 받은 답에 단 답글 — 완료 승격이 저장 이벤트 시각을 붙이고(배선) · 진짜 messageCtxFromEl 이 그 시각·비서를 대상으로 · 브리지가 같은 원문 행 id 로 · 시각 없던 모양은 대상 없음",
        /card\.replyBubble\.dataset\.ts = String\(ev\.ts\)/.test(promoBody) && beforeFix === null &&
          JSON.stringify(afterFix) === JSON.stringify({ ts: LIVE_TS, role: "assistant" }) && liveResolved?.id === liveId,
        { beforeFix, afterFix, liveResolved, liveId, promoHasTs: /dataset\.ts = String\(ev\.ts\)/.test(promoBody) }),
    ];
  },
};
