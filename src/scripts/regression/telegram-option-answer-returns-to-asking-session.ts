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
 *
 * 등급: **동작**.
 */
import { assert, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";
import { callbackUpdate, fakeChannel, loadTelegram, settle, startWithOwners, textUpdate } from "./_fake-telegram.js";

const OWNER = 222;
const SESSION_X = "dashboard:regr-asking-session";

type Seen = { text: string; threadKey: string; explicit?: string; present?: (q: string, o: { label: string; value: string }[]) => Promise<unknown> };

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
      seen.push({ text: m.text, threadKey: m.threadKey, explicit: m.session?.explicitSessionId, present: m.presentOptions });
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
      ];
    } finally {
      await (channel as unknown as { stop?: () => Promise<void> }).stop?.();
    }
  },
};

export default check;
