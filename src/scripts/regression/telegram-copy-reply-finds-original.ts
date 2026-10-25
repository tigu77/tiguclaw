/**
 * 회귀: **텔레그램 사본에 단 답글도 원문을 짚는다** (2026-10-25 사용자 요청: «텔레그램 사본도 원문 ID에 연결해»).
 *
 * 증상: 대시보드 대화의 답이 «함께 보낼 채널» 로 텔레그램에도 똑같이 가는데(사본), 그 사본에 텔레그램에서 답장하면 대시보드의
 *  «↩ 원문» 이 눌리지 않았다(실시간·새로고침 뒤 모두). 사본은 대화 기록에 안 남기므로(대화 한 번 = 한 줄) 사본의 텔레그램 message_id 가
 *  어느 행에도 묶이지 않았다 — 10-19 결정에 «정직하게 못 하는 것» 으로 적혀 있던 한계다.
 * 고침: 원본 송신 이벤트를 발행한 함수가 돌려준 좌표(대화·정확 시각)를 사본이 싣고, 적재가 그 좌표로 원본 행을 **한 건** 찾았을 때만
 *  사본의 message_id(청크 전부)를 그 행에 묶는다.
 *
 * 재는 것(가짜 Bot API — 네트워크 0, 진짜 `TelegramChannel`·진짜 `deliverOutbound`·진짜 적재·진짜 인입 핸들러):
 *  ① 좌표 동일성 — `publishReplyOut`·`replyCommand` 의 반환 좌표 = 실제로 발행된 이벤트의 ts·threadKey · 휘발이면 없음
 *  ② ★여러 청크로 나뉜 사본의 **청크마다** 답글 → 원래 세션 · `replyToRef` = 원본 행(청크 전부 같은 행) · 인용 머리 «비서(나)의 메시지 #id»
 *     · 줄었으면 그 번호로 전문 읽기 안내 · 카드 표시에 id·ts
 *  ③ 반대 방향 — 원본 좌표 없는 사본(멈춤 안내 같은 것)에 단 답글은 종전처럼 좌표 없음(세션 라우팅은 그대로)
 *  ④ 배선(소스 모양 — `src/index.ts` 핸들러 클로저는 import 하면 데몬이 떠서 동작으로 못 부른다): 성공·실패·작업취소가 원본 발행의 반환을
 *     `fanOutEgress` 에 넘기고, 멈춤 안내 두 곳은 안 넘기며, `fanOutEgress` 가 그것을 `deliverOutbound` 에 넘긴다.
 * 등급: ①~③ **동작**, ④ 배선.
 */
import { assert, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";
import { fakeChannel, loadTelegram, settle, startWithOwners, textUpdate } from "./_fake-telegram.js";
import { callArgTexts, readSourceSync, stripComments } from "./_wiring.js";

const OWNER = 333;
const SESSION = "dashboard:regr-copy-reply-origin";

type Seen = { threadKey: string; text: string; replyToText?: string; replyToRef?: { id: number; role?: "user" | "assistant" } };

export const check: RegressionCheck = {
  name: "telegram-copy-reply-finds-original",
  guards: "대시보드 답의 텔레그램 사본에 텔레그램에서 답장하면 대시보드 «↩ 원문» 이 눌리지 않고 비서 인용에 원문 번호가 없던 것(사본 message_id 가 원본 행에 안 묶였다)",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const { initStore } = await import("../../store/sessions.js");
    initStore();
    const { createEventBus, getEventBus } = await import("../../core/eventbus.js");
    const { startEventPersistence } = await import("../../core/event-persist.js");
    const { publishReplyOut, replyCommand } = await import("../../core/entry/reply-command.js");
    const { deliverOutbound } = await import("../../core/outbound.js");
    const { getChannelOutbound, registerChannelOutbound, unregisterChannelOutbound } = await import("../../core/channel-outbound.js");
    const { chatRowCoords } = await import("../../store/chat-log.js");
    const { withReplyQuote, replyQuoteRefOf } = await import("../../core/reply-quote.js");
    const { replyPreviewOf } = await import("../../core/reply-preview.js");

    // ① 좌표 동일성 — 진짜 버스에 실제로 나온 이벤트와 반환을 대조한다.
    const seenOut: Array<{ ts: number; threadKey: unknown }> = [];
    const unsub = getEventBus().subscribe((e) => {
      if (e.type === "channel.message.out") seenOut.push({ ts: e.ts, threadKey: (e.payload as { threadKey?: unknown }).threadKey });
    });
    let rcAt, rcEphemeral, rcFailed;
    try {
      rcAt = await replyCommand({ reply: async () => undefined, channel: "cli", threadKey: "regr:copy-coords" }, "기록되는 응답");
      // 실패 안내(턴 실패 표식) — 핸들러의 실패·작업취소 경로가 이 반환을 사본에 넘긴다(§5c 레드팀 G3: 이 분기를 안 재서 «실패면 좌표 없음» 변이가 초록이었다).
      rcFailed = await replyCommand({ reply: async () => undefined, channel: "cli", threadKey: "regr:copy-coords-failed" }, "실패 안내", { turnFailed: true });
      rcEphemeral = await replyCommand({ reply: async () => undefined, channel: "cli", threadKey: "regr:copy-coords-eph" }, "휘발 응답", { ephemeral: true });
    } finally {
      unsub();
    }
    const rcEvent = seenOut.find((e) => e.threadKey === "regr:copy-coords");
    const rcFailedEvent = seenOut.find((e) => e.threadKey === "regr:copy-coords-failed");
    const bus = createEventBus(); // 전용 버스 — 다른 검사가 단일 버스에 붙인 적재와 섞이지 않게(행이 두 벌이면 «같은 시각 한 건» 이 깨진다)
    startEventPersistence(bus);
    const busOut: Array<{ ts: number }> = [];
    bus.subscribe((e) => { if (e.type === "channel.message.out" && (e.payload as { threadKey?: unknown }).threadKey === SESSION) busOut.push({ ts: e.ts }); });
    // 문단 30개 ≈ 1.5만 자 — 텔레그램 4,096자 상한이라 문단 경계에서 여러 청크로 나뉜다(한 문단짜리 긴 글은 라이브러리가 안 쪼갠다).
    const LONG = `원본 답 앞부분\n\n${`문단 ${"가나다라마바사 ".repeat(60)}\n\n`.repeat(30)}끝의 질문: 이대로 진행할까요?`;
    const original = publishReplyOut(bus, { channel: "http-bridge", threadKey: SESSION, text: LONG });
    const { chatIdAtExactTs } = await import("../../store/chat-log.js");
    const origRow = chatIdAtExactTs(SESSION, original.ts, "assistant");

    // ② 진짜 텔레그램 채널 + 진짜 deliverOutbound 사본
    const mod = await loadTelegram("copy-reply");
    const { channel, bot, calls } = fakeChannel(mod);
    const seen: Seen[] = [];
    await startWithOwners(channel, String(OWNER), async (msg) => {
      seen.push(msg as unknown as Seen);
    });
    const prev = getChannelOutbound("telegram");
    const outbound = (channel as unknown as { outbound?: Parameters<typeof registerChannelOutbound>[1] }).outbound;
    if (outbound !== undefined) registerChannelOutbound("telegram", outbound);
    try {
      const sentBefore = calls.filter((c) => c.method === "sendMessage").length;
      const r1 = await deliverOutbound({ channel: "telegram", target: String(OWNER), text: LONG, bus, originThreadKey: SESSION, copyOfRecorded: true, copyOf: original });
      const copySends = calls.filter((c) => c.method === "sendMessage").slice(sentBefore);
      // 가짜 API 는 sendMessage 마다 message_id 를 1씩 올려 준다 — 그 순서로 청크 id 를 되짚는다(응답을 직접 들여다보지 않는다).
      const firstId = 1000 + sentBefore;
      const chunkIds = copySends.map((_, i) => firstId + i);
      const replies: Seen[] = [];
      for (const [i, mid] of chunkIds.entries()) {
        const u = textUpdate(OWNER, `청크 ${i + 1} 에 답글`) as { message: Record<string, unknown> };
        u.message.reply_to_message = { message_id: mid, date: 0, chat: { id: OWNER, type: "private" }, from: { id: 999, is_bot: true, first_name: "regr" }, text: String(copySends[i]?.payload.text ?? "") };
        await bot.handleUpdate(u as never);
        await settle();
        const got = seen.find((s) => s.text === `청크 ${i + 1} 에 답글`);
        if (got !== undefined) replies.push(got);
      }
      const first = replies[0];
      const quote = first === undefined ? "" : withReplyQuote(first.text, first.replyToText, replyQuoteRefOf(first));
      const preview = first === undefined ? undefined : replyPreviewOf(first, (id) => chatRowCoords(first.threadKey, id));

      // ③ 반대 방향 — 원본 좌표 없는 사본
      const before3 = calls.filter((c) => c.method === "sendMessage").length;
      await deliverOutbound({ channel: "telegram", target: String(OWNER), text: "멈췄습니다(사본만)", bus, originThreadKey: SESSION, copyOfRecorded: true });
      const plainId = 1000 + before3;
      const u3 = textUpdate(OWNER, "좌표 없는 사본에 답글") as { message: Record<string, unknown> };
      u3.message.reply_to_message = { message_id: plainId, date: 0, chat: { id: OWNER, type: "private" }, from: { id: 999, is_bot: true, first_name: "regr" }, text: "멈췄습니다(사본만)" };
      await bot.handleUpdate(u3 as never);
      await settle();
      const plain = seen.find((s) => s.text === "좌표 없는 사본에 답글");

      // ④ 배선 — AST 로 호출의 그 자리를 본다(주석·다른 자리의 낱말로 만족되지 않게).
      const idx = stripComments(readSourceSync("src/index.ts"));
      const fan = callArgTexts("src/index.ts", "fanOutEgress");
      const fanBy = (text: string): string[][] => fan.filter((a) => a[1] === text);
      const fanBody = idx.slice(idx.indexOf("const fanOutEgress = async ("), idx.indexOf("const maybeSuggestNextMessage"));
      const wiring = {
        success: fanBy("replyText").map((a) => a[4] ?? null),
        failure: fanBy("failText").map((a) => a[4] ?? null),
        stopped: fanBy("STOPPED_NOTICE()").map((a) => a[4] ?? null),
        publishBinds: (idx.match(/const original = publishReplyOut\(bus, \{/g) ?? []).length,
        replyBinds: (idx.match(/const original = await replyCommand\(msg, (?:failText|STOPPED_NOTICE\(\)), \{ turnFailed: true \}\);/g) ?? []).length,
        forwards: /deliverOutbound\(\{[\s\S]*copyOfRecorded: true,\s*\.\.\.\(copyOf !== undefined \? \{ copyOf \} : \{\}\)/.test(fanBody),
      };

      return [
        assert("★① 원본 발행이 돌려준 좌표 = 실제로 발행된 이벤트의 ts·대화(replyCommand·실패 안내·publishReplyOut) · 휘발 응답은 좌표 없음",
          rcAt !== undefined && rcEvent !== undefined && rcAt.ts === rcEvent.ts && rcAt.threadKey === "regr:copy-coords" && rcEphemeral === undefined &&
            rcFailed !== undefined && rcFailedEvent !== undefined && rcFailed.ts === rcFailedEvent.ts && rcFailed.threadKey === "regr:copy-coords-failed" &&
            busOut.length === 1 && busOut[0]!.ts === original.ts && original.threadKey === SESSION && origRow !== undefined,
          { rcAt, rcEvent, rcEphemeral, rcFailed, rcFailedEvent, busOut, original, origRow }),
        assert("★② 사본이 여러 청크로 나갔고 청크마다 단 답글이 원래 세션으로 · 원본 행 id(청크 전부 같은 행)·비서 발화로 실린다",
          r1.delivered && chunkIds.length >= 2 && replies.length === chunkIds.length &&
            replies.every((s) => s.threadKey === SESSION && s.replyToRef?.id === origRow && s.replyToRef?.role === "assistant"),
          { delivered: r1.delivered, chunks: chunkIds.length, replies: replies.map((s) => ({ tk: s.threadKey, ref: s.replyToRef })), origRow }),
        assert("★② 비서 인용 머리에 «비서(나)의 메시지 #원본» · 줄었으면 그 번호로 전문 읽기 안내 · 카드 표시에 원본 id·시각",
          quote.includes(`대상: 비서(나)의 메시지 #${origRow}`) && quote.includes(`threadKey=${JSON.stringify(SESSION)} id=${origRow}`) &&
            preview?.id === origRow && preview?.ts === original.ts,
          { head: quote.slice(0, 120), preview: preview === undefined ? null : { id: preview.id, ts: preview.ts } }),
        assert("③ 반대 방향 — 원본 좌표 없는 사본에 단 답글은 종전처럼 좌표 없음(세션 라우팅은 그대로 원래 세션)",
          plain !== undefined && plain.threadKey === SESSION && plain.replyToRef === undefined,
          { tk: plain?.threadKey, ref: plain?.replyToRef ?? null }),
        assert("④ 배선 — 성공·실패·작업취소는 원본 발행의 반환을 넘기고 멈춤 안내 두 곳은 안 넘긴다 · fanOutEgress 가 deliverOutbound 에 넘긴다",
          JSON.stringify(wiring.success) === '["original"]' && JSON.stringify(wiring.failure) === '["original"]' &&
            wiring.stopped.filter((x) => x === "original").length === 1 && wiring.stopped.filter((x) => x === null).length === 2 &&
            wiring.publishBinds === 1 && wiring.replyBinds === 2 && wiring.forwards,
          wiring),
      ];
    } finally {
      if (prev !== undefined) registerChannelOutbound("telegram", prev);
      else unregisterChannelOutbound("telegram");
      await (channel as unknown as { stop?: () => Promise<void> }).stop?.();
    }
  },
};

export default check;
