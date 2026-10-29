/**
 * 회귀: **텔레그램 선택지를 누르면 그 선택지를 띄운 세션으로 돌아간다 — 답글로 다른 세션에서 돈 턴이 물었어도** (2026-10-12 정태님:
 * «텔레그램 프롬프트 옵션에서 선택하면 해당 옵션을 보낸 세션으로 가는게 아닌가?»).
 *
 * 사고(코드 추적): 다른 경로(대시보드·작업 완료)가 텔레그램으로 물으면 버튼에 «물어본 세션» 이 실리지만, **텔레그램에서 받은 턴**이
 *  물으면 안 실렸다 — «그땐 이 대화가 묶인 세션과 같다» 는 가정이었다. 그런데 사용자가 세션 X 의 메시지에 **답글**로 말하면 그 턴은
 *  X 에서 돈다. 그 턴이 띄운 버튼을 누르면 답은 X 가 아니라 이 채팅의 기본 세션으로 갔다 — 일하던 쪽은 답을 못 받는다.
 *
 * 재는 것(가짜 Bot API — 네트워크 0):
 *  ① 세션 X 메시지에 답글 → 그 턴이 X 에서 돌고 선택지를 띄운다 → 버튼 클릭이 X 로 간다
 *  ② 대조 — 답글 아닌 평소 메시지의 턴이 띄운 버튼은 종전대로 이 채팅의 세션으로 간다
 *  ③ ★평소 턴의 버튼은 세션을 **싣지 않는다** — 실으면 클릭이 명시 세션을 달고 들어가 `/sessions` 의 «선택기 채널» 가드에
 *     걸려, 텔레그램 세션 목록 버튼으로 세션을 **바꿀 수 없었다**(같은 날 릴리스 적대 검토 F1, 실측). 실제 `/sessions use` 로 잰다.
 *
 * 등급: **동작**.
 */
import { assert, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";
import { callbackUpdate, fakeChannel, loadTelegram, settle, startWithOwners, textUpdate } from "./_fake-telegram.js";

const OWNER = 222;
const SESSION_X = "dashboard:regr-asking-session";

type Seen = { text: string; threadKey: string; explicit?: string; present?: (q: string, o: { label: string; value: string }[]) => Promise<unknown>; msg: unknown };

export const check: RegressionCheck = {
  name: "telegram-option-answer-returns-to-asking-session",
  guards: "텔레그램에서 답글로 다른 세션에 이어 말한 턴이 띄운 선택지를 누르면, 답이 그 세션이 아니라 이 채팅의 기본 세션으로 가던 것",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const { initStore } = await import("../../store/sessions.js");
    initStore();
    const { recordOutboundMessage } = await import("../../store/outbound-messages.js");
    const mod = await loadTelegram("asking-session");
    const { channel, bot, calls } = fakeChannel(mod);
    const seen: Seen[] = [];
    await startWithOwners(channel, String(OWNER), async (msg) => {
      const m = msg as unknown as { text: string; threadKey: string; session?: { explicitSessionId?: string }; presentOptions?: Seen["present"] };
      seen.push({ text: m.text, threadKey: m.threadKey, explicit: m.session?.explicitSessionId, present: m.presentOptions, msg });
    });
    const lastButton = (): string => {
      const last = [...calls].reverse().find((c) => c.method === "sendMessage" && c.payload.reply_markup !== undefined);
      const kb = (last?.payload.reply_markup as { inline_keyboard?: { callback_data: string }[][] } | undefined)?.inline_keyboard ?? [];
      return kb[0]?.[0]?.callback_data ?? "";
    };
    try {
      // 세션 X 가 보낸 메시지(봇 메시지 777)에 사용자가 답글
      recordOutboundMessage("telegram", String(OWNER), 777, SESSION_X, Date.now());
      const reply = textUpdate(OWNER, "이거 어떻게 할까?") as { message: Record<string, unknown> };
      reply.message.reply_to_message = { message_id: 777, date: 0, chat: { id: OWNER, type: "private" }, from: { id: 1, is_bot: true, first_name: "bot" }, text: "X 의 답" };
      await bot.handleUpdate(reply as never);
      await settle();
      const asked = seen[0];
      await asked?.present?.("어느 쪽?", [{ label: "A", value: "회귀-선택A" }]);
      await bot.handleUpdate(callbackUpdate(OWNER, lastButton()) as never);
      await settle();
      const answered = seen.find((s) => s.text === "회귀-선택A");

      // ② 대조 — 평소 메시지
      const plain = textUpdate(OWNER, "그냥 질문");
      await bot.handleUpdate(plain as never);
      await settle();
      const plainTurn = seen.find((s) => s.text === "그냥 질문");
      await plainTurn?.present?.("어느 쪽?", [{ label: "B", value: "회귀-선택B" }]);
      await bot.handleUpdate(callbackUpdate(OWNER, lastButton()) as never);
      await settle();
      const answeredPlain = seen.find((s) => s.text === "회귀-선택B");

      // ③ 평소 턴이 띄운 «세션 고르기» 버튼 → 실제 `/sessions use` 가 바인딩을 바꾼다
      const { saveSession } = await import("../../store/sessions.js");
      const { getChannelSessionBinding } = await import("../../store/channel-session.js");
      const { handleSessions } = await import("../../core/entry/slash-commands.js");
      const TARGET = "dashboard:regr-sessions-pick";
      saveSession({ channel: "http-bridge", threadKey: TARGET, claudeSessionId: "regr-pick", model: null, systemPromptHash: null });
      const pickTurn = textUpdate(OWNER, "/sessions");
      await bot.handleUpdate(pickTurn as never);
      await settle();
      const pickAsked = seen.find((s) => s.text === "/sessions");
      await pickAsked?.present?.("어느 세션?", [{ label: "고르기", value: `/sessions use ${TARGET}` }]);
      await bot.handleUpdate(callbackUpdate(OWNER, lastButton()) as never);
      await settle();
      const picked = seen.find((s) => s.text === `/sessions use ${TARGET}`);
      const replies: string[] = [];
      if (picked !== undefined) {
        const pm = picked.msg as { reply?: (t: string) => Promise<void> };
        pm.reply = async (t: string) => { replies.push(t); };
        await handleSessions({ msg: picked.msg as never, args: `use ${TARGET}`, trimmed: `/sessions use ${TARGET}`, sidChannel: "telegram" as never });
      }
      const boundAfter = getChannelSessionBinding("telegram", String(OWNER));

      // ④⑤⑥ (2026-10-28 B3) — LLM 턴의 선택지는 관측 래퍼를 지나 **발급 id** 를 달고, 그 클릭은 늘 명시 세션(물어본 세션)을 싣는다.
      //  그 명시 세션은 «답 좌표» 표식(`fromPromptAnswer`)을 달아 `/sessions` 가 선택기 채널로 오판하지 않는다. 답 좌표는 그대로.
      const { withPromptOptionsObservation } = await import("../../core/prompt-options-observe.js");
      const sessionsReplies = async (m: unknown, args: string): Promise<string[]> => {
        const got: string[] = [];
        (m as { reply?: (t: string) => Promise<void> }).reply = async (t: string) => { got.push(t); };
        await handleSessions({ msg: m as never, args, trimmed: `/sessions ${args}`, sidChannel: "telegram" as never });
        return got;
      };
      const observedAsk = async (turn: Seen | undefined, value: string): Promise<void> => {
        const present = withPromptOptionsObservation(turn?.present as never, { channel: "telegram", threadKey: turn?.threadKey ?? "", bus: { publish() {} } as never });
        await present?.("어느 세션?", [{ label: "고르기", value }]);
      };
      // ④ 평소 턴(바인딩 = TARGET)의 발급 id 보기 `/sessions use default`
      const nBefore4 = seen.length;
      await bot.handleUpdate(textUpdate(OWNER, "평소 질문 B3") as never);
      await settle();
      const plain4 = seen.slice(nBefore4).find((s) => s.text === "평소 질문 B3");
      await observedAsk(plain4, "/sessions use default");
      await bot.handleUpdate(callbackUpdate(OWNER, lastButton()) as never);
      await settle();
      const click4 = seen.slice(nBefore4).find((s) => s.text === "/sessions use default");
      const marker4 = (click4?.msg as { session?: { fromPromptAnswer?: boolean } } | undefined)?.session?.fromPromptAnswer;
      const replies4 = click4 === undefined ? [] : await sessionsReplies(click4.msg, "use default");
      const bound4 = getChannelSessionBinding("telegram", String(OWNER));
      const { translate } = await import("../../core/i18n.js");
      // ⑤ 리다이렉트 턴(세션 X 메시지에 답글)의 발급 id 보기 — 같은 표식, 답 좌표 = X
      const nBefore5 = seen.length;
      const reply5 = textUpdate(OWNER, "X 에 이어서 B3") as { message: Record<string, unknown> };
      reply5.message.reply_to_message = { message_id: 777, date: 0, chat: { id: OWNER, type: "private" }, from: { id: 1, is_bot: true, first_name: "bot" }, text: "X 의 답" };
      await bot.handleUpdate(reply5 as never);
      await settle();
      const turn5 = seen.slice(nBefore5).find((s) => s.text === "X 에 이어서 B3");
      await observedAsk(turn5, `/sessions use ${TARGET}`);
      await bot.handleUpdate(callbackUpdate(OWNER, lastButton()) as never);
      await settle();
      const click5 = seen.slice(nBefore5).find((s) => s.text === `/sessions use ${TARGET}`);
      const marker5 = (click5?.msg as { session?: { fromPromptAnswer?: boolean } } | undefined)?.session?.fromPromptAnswer;
      const replies5 = click5 === undefined ? [] : await sessionsReplies(click5.msg, `use ${TARGET}`);
      const bound5 = getChannelSessionBinding("telegram", String(OWNER));
      // ⑥ 진짜 선택기·사용자 명시 세션은 종전대로 거절 — 대시보드(http-bridge) · 텔레그램 글 답장 라우팅(표식 없음)
      const dashReplies = await sessionsReplies({ channel: "http-bridge", channelUserId: "u", threadKey: "dashboard:regr-sel", channelAddress: "dashboard:regr-sel", session: { explicitSessionId: "dashboard:regr-sel", channelAddress: "dashboard:regr-sel", fromPromptAnswer: true }, text: "/sessions use default", receivedAt: Date.now() }, "use default");
      const nBefore6 = seen.length;
      const reply6 = textUpdate(OWNER, "/sessions use default") as { message: Record<string, unknown> };
      reply6.message.reply_to_message = { message_id: 777, date: 0, chat: { id: OWNER, type: "private" }, from: { id: 1, is_bot: true, first_name: "bot" }, text: "X 의 답" };
      await bot.handleUpdate(reply6 as never);
      await settle();
      const typed6 = seen.slice(nBefore6).find((s) => s.text === "/sessions use default");
      const typedReplies = typed6 === undefined ? [] : await sessionsReplies(typed6.msg, "use default");
      const hasSel = translate("srv.sessions.hasSelector");

      return [
        assert(
          "★① 답글로 세션 X 에서 돈 턴이 띄운 선택지를 누르면 답이 X 로 간다",
          asked?.threadKey === SESSION_X && answered?.threadKey === SESSION_X,
          { 물은턴: asked?.threadKey, 답: answered?.threadKey, 명시세션: answered?.explicit },
        ),
        assert(
          "② 대조 — 평소 메시지의 턴이 띄운 선택지는 그 턴과 같은 세션으로 간다",
          plainTurn !== undefined && answeredPlain?.threadKey === plainTurn.threadKey,
          { 물은턴: plainTurn?.threadKey, 답: answeredPlain?.threadKey },
        ),
        assert(
          "★③ 평소 턴의 버튼은 세션을 싣지 않는다 — 그래서 텔레그램 세션 목록 버튼(`/sessions use`)이 거절되지 않고 바인딩이 바뀐다",
          picked !== undefined && picked.explicit === undefined && boundAfter === TARGET,
          { 클릭명시세션: picked?.explicit, 바인딩: boundAfter, 답: replies.map((r) => r.slice(0, 60)) },
        ),
        assert(
          "★④ 발급 id 가 있는 평소 턴 보기 `/sessions use default` — 답 좌표(물어본 세션)는 그대로 싣고 «답 좌표» 표식 · 선택기 거절 없이 기본 세션으로 돌아간다",
          plain4 !== undefined && click4 !== undefined && click4.explicit === plain4.threadKey && click4.threadKey === plain4.threadKey && marker4 === true &&
            replies4.includes(translate("srv.sessions.backToDefault")) && !replies4.includes(hasSel) && bound4 === null,
          { 물은턴: plain4?.threadKey, 클릭명시: click4?.explicit, 표식: marker4 ?? null, 답: replies4.map((r) => r.slice(0, 60)), 바인딩: bound4 },
        ),
        assert(
          "★⑤ 리다이렉트 턴(세션 X)의 보기도 같은 표식 · 답 좌표 = X · `/sessions use` 가 이 방 바인딩을 바꾼다",
          turn5?.threadKey === SESSION_X && click5?.explicit === SESSION_X && click5?.threadKey === SESSION_X && marker5 === true &&
            !replies5.includes(hasSel) && bound5 === TARGET,
          { 물은턴: turn5?.threadKey, 클릭명시: click5?.explicit, 표식: marker5 ?? null, 답: replies5.map((r) => r.slice(0, 60)), 바인딩: bound5 },
        ),
        assert(
          "⑥ 진짜 선택기 채널(대시보드 — 본문 표식이 있어도)·텔레그램 글 답장의 명시 세션(표식 없음)은 종전대로 «세션 선택기 채널» 거절",
          dashReplies.includes(hasSel) && typed6 !== undefined && typed6.explicit === SESSION_X && typedReplies.includes(hasSel),
          { 대시보드: dashReplies.map((r) => r.slice(0, 40)), 글답장명시: typed6?.explicit, 글답장: typedReplies.map((r) => r.slice(0, 40)) },
        ),
      ];
    } finally {
      await (channel as unknown as { stop?: () => Promise<void> }).stop?.();
    }
  },
};

export default check;
