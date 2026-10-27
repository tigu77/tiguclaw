/** 선택지 message_id도 기존 영속 발원 기록에 묶여 일반 답글이 원세션으로 돌아온다. 실제 TelegramChannel + API 변환기(네트워크 0). */
import { assert, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";
import type { IncomingMessage } from "../../channels/types.js";
import type { ChannelOutbound } from "../../core/channel-outbound.js";
import { callbackUpdate, fakeChannel, loadTelegram, settle, startWithOwners, textUpdate } from "./_fake-telegram.js";

type Msg = IncomingMessage;
export const check: RegressionCheck = {
  name: "telegram-option-origin-recorded",
  guards: "선택지 버튼에 일반 답글을 달면 원세션 대신 현재 바인딩으로 가는 것 + 직접 턴의 발원 세션을 렌더 시점에 다시 읽는 것 + 재시작 뒤 영속 답글/만료 버튼 혼동",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const { initStore, closeStore, setThreadName, getDb } = await import("../../store/sessions.js");
    const { getChannelSessionBinding, setChannelSessionBinding } = await import("../../store/channel-session.js");
    const { setChannelSessionBindingLookup } = await import("../../core/threadkey.js");
    const { findSessionForOutboundMessage, countOutboundMessageMappings } = await import("../../store/outbound-messages.js");
    const { withPromptOptionsObservation } = await import("../../core/prompt-options-observe.js");
    const { withEgressPromptOptions } = await import("../../core/prompt-options-egress.js");
    const { issuePromptId, claimPromptAnswer, __resetPromptClaimsForTest } = await import("../../core/prompt-answer-claims.js");
    const { createEventBus } = await import("../../core/eventbus.js");
    const { startEventPersistence } = await import("../../core/event-persist.js");
    const { chatIdForChannelMessage, chatRowCoords, getRecentChatLog } = await import("../../store/chat-log.js");
    const { replyPreviewOf } = await import("../../core/reply-preview.js");
    initStore();
    const bus = createEventBus();
    startEventPersistence(bus);
    setChannelSessionBindingLookup(getChannelSessionBinding);
    const owner = 224;
    const A = "dashboard:option-origin-a", B = "dashboard:option-origin-b", X = "dashboard:option-origin-worker";
    const O = [{ label: "선택", value: "선택응답" }];
    const out: Assertion[] = [];
    let n = 887000;
    const sent: { id: number; text: string; cb: string }[] = [];
    const mod = await loadTelegram("option-origin-before");
    const first = fakeChannel(mod, (method, payload) => {
      if (method !== "sendMessage") return undefined;
      if (String(payload.text).includes("식별자없는성공")) return { ok: true, result: { date: 0, chat: { id: owner, type: "private" } } };
      if (String(payload.chat_id) === String(owner + 2) || String(payload.text).includes("발송실패")) return { ok: false, error_code: 400, description: "Bad Request: fixture failure" };
      const id = n++;
      const kb = payload.reply_markup as { inline_keyboard?: { callback_data: string }[][] } | undefined;
      sent.push({ id, text: String(payload.text), cb: kb?.inline_keyboard?.[0]?.[0]?.callback_data ?? "" });
      return { ok: true, result: { message_id: id, date: 0, chat: { id: owner, type: "private" } } };
    });
    const seen: Msg[] = [];
    await startWithOwners(first.channel, String(owner), async (m) => { seen.push(m as unknown as Msg); });
    const replyTo = (id: number, text: string): unknown => {
      const u = textUpdate(owner, text) as { message: Record<string, unknown> };
      u.message.reply_to_message = { message_id: id, date: 0, chat: { id: owner, type: "private" }, from: { id: 999, is_bot: true, first_name: "bot" }, text: "질문" };
      return u;
    };
    let stopped = false;
    try {
      setThreadName(A, "원세션A");
      setChannelSessionBinding("telegram", String(owner), A);
      await first.bot.handleUpdate(textUpdate(owner, "직접 질문 턴"));
      await settle();
      const asked = seen.find((m) => m.text === "직접 질문 턴");
      // factory 는 A에서 만들고 렌더 시점에는 B. 기록·버튼은 A, 직접현재 라벨은 없음.
      setChannelSessionBinding("telegram", String(owner), B);
      const present = withPromptOptionsObservation(asked?.presentOptions as never, { channel: "telegram", threadKey: A, bus });
      const directResult = await present?.("직접 선택지", O);
      const direct = sent.find((s) => s.text === "직접 선택지")!;
      out.push(assert("★직접현재 선택지도 송신ID를 턴 생성 시 원세션 A에 기록(렌더 시 바인딩 B를 읽지 않음)", direct !== undefined && findSessionForOutboundMessage("telegram", String(owner), direct.id) === A, { direct, mapped: direct && findSessionForOutboundMessage("telegram", String(owner), direct.id) }));
      const directRowId = chatIdForChannelMessage("telegram", String(owner), direct.id);
      const directRow = getRecentChatLog({ threadKey: A, limit: 100 }).find((r) => r.id === directRowId);
      await first.bot.handleUpdate(replyTo(direct.id, "직접 일반답글"));
      await settle();
      const directReply = seen.find((m) => m.text === "직접 일반답글");
      const directPreview = directReply && replyPreviewOf(directReply, (id) => chatRowCoords(A, id));
      out.push(assert("★직접 선택지도 native ref→기존 prompt.options 한 행→일반 인입 replyToRef→replyPreview의 id/ts",
        directResult?.ok === true && directResult.channelRefs?.[0]?.messageIds[0] === direct.id &&
        directRow?.kind === "prompt.options" && directRow.role === "assistant" && directReply?.replyToRef?.role === "assistant" && directReply?.threadKey === A && directReply?.replyToRef?.id === directRowId &&
        directPreview?.id === directRowId && directPreview?.ts === directRow?.ts,
        { result: directResult, row: directRow, reply: directReply?.replyToRef, preview: directPreview }));
      await first.bot.handleUpdate(callbackUpdate(owner, direct?.cb ?? ""));
      await settle();
      const callback = seen.find((m) => m.text === "선택응답");
      out.push(assert("★LLM 선택지 콜백도 바뀐 바인딩 대신 발급 원세션 A를 threadKey/명시세션 둘 다 유지", callback?.threadKey === A && callback.session?.explicitSessionId === A, { thread: callback?.threadKey, session: callback?.session }));
      await callback?.reply("다른세션 콜백 답");
      await callback?.presentOptions?.("다른세션 콜백 선택지", O);
      out.push(assert("★바인딩 B에서 A 선택지를 눌러 이어진 실제 콜백 답·선택지에는 A 라벨", sent.some((s) => s.text === "[원세션A] 다른세션 콜백 답") && sent.some((s) => s.text === "[원세션A] 다른세션 콜백 선택지"), sent.map((s) => s.text)));
      setChannelSessionBinding("telegram", String(owner), A);
      const sameId = issuePromptId(A);
      await asked?.presentOptions?.("같은세션 콜백용", O, { promptId: sameId });
      const same = sent.find((s) => s.text === "같은세션 콜백용")!;
      await first.bot.handleUpdate(callbackUpdate(owner, same.cb));
      await settle();
      const sameCallback = seen.at(-1);
      await sameCallback?.reply("같은세션 콜백 답");
      await sameCallback?.presentOptions?.("같은세션 콜백 선택지", O);
      out.push(assert("★현재 바인딩 A에서 A 선택지 콜백 답·선택지는 라벨 생략", sent.some((s) => s.text === "같은세션 콜백 답") && sent.some((s) => s.text === "같은세션 콜백 선택지"), sent.map((s) => s.text)));
      const consumed = issuePromptId(A);
      await asked?.presentOptions?.("다른채널 선소비", O, { promptId: consumed });
      const consumedSent = sent.find((s) => s.text === "다른채널 선소비")!;
      claimPromptAnswer(consumed);
      const beforeConsumed = seen.length;
      await first.bot.handleUpdate(callbackUpdate(owner, consumedSent.cb));
      await settle();
      out.push(assert("★대시보드 선소비 뒤 실제 Telegram 콜백은 모델 처리로 들어가지 않음", seen.length === beforeConsumed, { before: beforeConsumed, after: seen.length }));
      setChannelSessionBinding("telegram", String(owner), B);
      await first.bot.handleUpdate(replyTo(direct.id, "직접질문에 일반답글"));
      await settle();
      out.push(assert("★직접 선택지 일반 답글이 원세션 A로 복귀", seen.find((m) => m.text === "직접질문에 일반답글")?.threadKey === A, { thread: seen.find((m) => m.text === "직접질문에 일반답글")?.threadKey }));
      const outbound = first.channel.outbound as unknown as Required<Pick<ChannelOutbound, "presentOptionsTo">>;
      await outbound.presentOptionsTo(String(owner), "완료 선택지", O, { replyToSession: X, labelSession: X, promptId: issuePromptId(X) });
      const other = sent.find((s) => s.text.includes("완료 선택지"))!;
      out.push(assert("★egress/worker 완료 좌표 선택지 message_id도 원세션 X에 기록", findSessionForOutboundMessage("telegram", String(owner), other.id) === X, { id: other.id, origin: findSessionForOutboundMessage("telegram", String(owner), other.id) }));
      // 실제 egress 조합층도 거친다. 채널에 id를 직접 주는 검사만으로는 전송 표식 유실을 못 잡는다.
      const observed: { payload: Record<string, unknown> }[] = [];
      const egress = withPromptOptionsObservation(withEgressPromptOptions(undefined, [{
        channel: "telegram", target: String(owner), outbound: first.channel.outbound as unknown as ChannelOutbound,
      }, {
        channel: "telegram", target: String(owner + 1), outbound: first.channel.outbound as unknown as ChannelOutbound,
      }, {
        channel: "telegram", target: String(owner + 2), outbound: first.channel.outbound as unknown as ChannelOutbound,
      }], { originThreadKey: X, deliverText: async () => { throw new Error("버튼 경로여야 함"); } }), {
        channel: "http-bridge", threadKey: X,
        bus: { publish(e: Parameters<typeof bus.publish>[0]) { observed.push(e); bus.publish(e); } } as never,
      });
      const egressResult = await egress?.("egress 실제 연계", O);
      const egressSent = sent.find((s) => s.text.includes("egress 실제 연계"));
      const egressIds = sent.filter((s) => s.text.includes("egress 실제 연계")).map((s) => s.id);
      const egressRowId = egressSent && chatIdForChannelMessage("telegram", String(owner), egressSent.id);
      const egressRow = getRecentChatLog({ threadKey: X, limit: 100 }).find((r) => r.id === egressRowId);
      const secondRef = chatIdForChannelMessage("telegram", String(owner + 1), egressIds[1]!);
      await first.bot.handleUpdate(replyTo(egressSent!.id, "egress 일반답글"));
      await settle();
      const ordinary = seen.find((m) => m.text === "egress 일반답글");
      const preview = ordinary && replyPreviewOf(ordinary, (id) => chatRowCoords(X, id));
      out.push(assert("★복수 TG 주소·부분 실패도 관측/저장은 원세션 한 행: 일반답글 원세션 X+id/ts(버튼 아닌 일반 인입)",
        egressResult?.ok === true && egressResult.channelRefs?.length === 2 && observed.length === 1 &&
        egressRow?.kind === "prompt.options" && egressRow.role === "assistant" && ordinary?.replyToRef?.role === "assistant" && secondRef === egressRowId &&
        getRecentChatLog({ threadKey: X, limit: 100 }).filter((r) => r.kind === "prompt.options").length === 1 &&
        ordinary?.threadKey === X && ordinary.session?.explicitSessionId === X && ordinary.replyToRef?.id === egressRowId &&
        preview?.id === egressRowId && preview?.ts === egressRow?.ts,
        { result: egressResult, events: observed.length, ids: egressIds, row: egressRow, secondRef, reply: ordinary?.replyToRef, thread: ordinary?.threadKey, preview }));
      // 인접 일반글 singleton + 사본은 원본 행에만 bind(같은 shared helper의 기존 계약).
      bus.publish({ type: "channel.message.out", ts: 880001, payload: { channel: "http-bridge", threadKey: X, text: "일반 원본",
        channelRefs: { channel: "telegram", address: String(owner), messageIds: [77801] } } });
      const original = chatIdForChannelMessage("telegram", String(owner), 77801);
      bus.publish({ type: "channel.message.out", ts: 880002, payload: { channel: "telegram", threadKey: "tg:copy", text: "일반 사본", copyOfRecorded: true,
        copyOf: { threadKey: X, ts: 880001 }, channelRefs: { channel: "telegram", address: String(owner + 1), messageIds: [77802] } } });
      out.push(assert("인접 일반글 singleton·사본도 같은 원본 행에 연결하며 중복 행 없음",
        original !== undefined && chatIdForChannelMessage("telegram", String(owner + 1), 77802) === original &&
        getRecentChatLog({ threadKey: "tg:copy", limit: 100 }).length === 0,
        { original, copy: chatIdForChannelMessage("telegram", String(owner + 1), 77802), copyRows: getRecentChatLog({ threadKey: "tg:copy", limit: 100 }) }));
      const noIdBefore = countOutboundMessageMappings();
      const noId = await outbound.presentOptionsTo(String(owner), "식별자없는성공", O, { replyToSession: X });
      const noOrigin = await outbound.presentOptionsTo(String(owner), "발원없는송신", O);
      out.push(assert("native ID 없는 성공은 성공 유지·허위 ref 없음, 발원 세션 없는 성공도 실제 ref는 돌려준다",
        noId.ok === true && noId.channelRefs === undefined && countOutboundMessageMappings() === noIdBefore &&
        noOrigin.ok === true && noOrigin.channelRefs?.[0]?.address === String(owner),
        { noId, noOrigin, before: noIdBefore, after: countOutboundMessageMappings() }));
      const sharedId = observed[0]?.payload.promptId as string;
      const consumedAtDashboard = claimPromptAnswer(sharedId);
      const beforeEgressClick = seen.length;
      await first.bot.handleUpdate(callbackUpdate(owner, egressSent?.cb ?? ""));
      await settle();
      out.push(assert("★관측→egress→실제 TG 버튼도 공통 질문 ID 보존: 대시보드 선소비 후 콜백 재실행 0회",
        egressResult?.ok === true && observed.length === 1 && Boolean(egressSent?.cb) &&
          consumedAtDashboard === "ok" && seen.length === beforeEgressClick,
        { ok: egressResult?.ok, observed: observed.length, sharedId, consumedAtDashboard, before: beforeEgressClick, after: seen.length }));
      bus.publish({ type: "prompt.options", ts: 880003, payload: { channel: "telegram", threadKey: X, question: "불량형제", options: O,
        channelRefs: [null, { channel: "telegram", address: String(owner), messageIds: [null, 77803] }, { channel: "telegram", address: 3, messageIds: [77804] }] } });
      const malformedRows = getDb().prepare("SELECT id FROM chat_log WHERE thread_key = ? AND ts = ?").all(X, 880003) as { id: number }[];
      out.push(assert("refs 목록 불량형제는 건너뛰고 정상 항목은 기존 한 행에 연결",
        malformedRows.length === 1 && chatIdForChannelMessage("telegram", String(owner), 77803) === malformedRows[0]?.id && chatIdForChannelMessage("telegram", String(owner), 77804) === undefined,
        { malformedRows, valid: chatIdForChannelMessage("telegram", String(owner), 77803), invalid: chatIdForChannelMessage("telegram", String(owner), 77804) }));
      const count = countOutboundMessageMappings();
      const fail = await outbound.presentOptionsTo(String(owner), "발송실패", O, { replyToSession: X });
      out.push(assert("송신 실패는 성공·허위 발원 기록으로 남기지 않는다", fail.ok === false && countOutboundMessageMappings() === count, { ok: fail.ok, before: count, after: countOutboundMessageMappings() }));
      await first.channel.stop();
      stopped = true;
      closeStore(); initStore(); __resetPromptClaimsForTest();
      const fresh = fakeChannel(await loadTelegram("option-origin-after"));
      const after: Msg[] = [];
      await startWithOwners(fresh.channel, String(owner), async (m) => { after.push(m as unknown as Msg); });
      try {
        await fresh.bot.handleUpdate(replyTo(egressSent!.id, "재시작뒤 일반답글"));
        await settle();
        const restarted = after.find((m) => m.text === "재시작뒤 일반답글");
        const restartedPreview = restarted && replyPreviewOf(restarted, (id) => chatRowCoords(X, id));
        out.push(assert("★재시작 뒤 영속 chat_message_refs/원문 행으로 선택지 일반답글 좌표 복원",
          egressRowId !== undefined && egressRow?.kind === "prompt.options" && restarted?.threadKey === X &&
          restarted.replyToRef?.id === egressRowId && restartedPreview?.id === egressRowId && restartedPreview?.ts === egressRow.ts,
          { ref: restarted?.replyToRef, preview: restartedPreview, row: egressRow }));
        await fresh.bot.handleUpdate(callbackUpdate(owner, other.cb));
        await settle();
        out.push(assert("★재시작 뒤에도 일반 답글 원세션 X는 영속 보존, 이전 버튼은 만료로 실행하지 않음", after.length === 1 && after[0]?.threadKey === X && after[0]?.text === "재시작뒤 일반답글", after.map((m) => ({ text: m.text, thread: m.threadKey }))));
      } finally { await fresh.channel.stop(); }
    } finally { if (!stopped) await first.channel.stop(); setChannelSessionBindingLookup(null); }
    return out;
  },
};
export default check;
