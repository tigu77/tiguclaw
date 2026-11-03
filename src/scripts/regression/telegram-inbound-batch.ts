/**
 * 회귀: **텔레그램에서 연달아 온 메시지는 한 턴이 된다** (2026-11-03).
 *
 * ★사고: 글(«아스트라 회신»)과 파일이 2.3초 간격으로 따로 왔고, 글만으로 턴이 시작돼 «첨부 못 받았다» 고 틀리게 답했다.
 *
 * 지키는 것 — 진짜 `TelegramChannel` 에 진짜 update 를 흘린다(Bot API·파일 다운로드는 가짜, 네트워크 0):
 *  ① 글 뒤 창 안에 파일(캡션 있음)이 오면 **한 턴** — 글·캡션이 순서대로 잇히고 첨부·원문 id 가 다 실린다
 *  ② 창 밖이면 두 턴
 *  ③ 명령(슬래시)은 기다리지 않는다 — 쌓인 묶음을 먼저 보내 순서를 지킨다
 *  ④ 계속 이어 와도 상한에서 강제로 보낸다
 *  ⑤ 창 0 = 끔(종전처럼 메시지마다 바로)
 *  ⑥ 서로 다른 메시지에 단 답글은 한 턴에 섞지 않는다
 *  ⑦ 종료(stop) 때 쌓인 묶음을 버리지 않는다 — 종료가 기다리는 동안 새로 온 글도 모으지 않고 바로 넘긴다
 *  ⑧ 버튼(선택지) 답은 기다리지 않는다 — 쌓인 묶음을 먼저 보낸다
 *
 * 등급: **동작**. 창은 짧게 줄여 잰다(조용한 창 300ms · 상한 800ms) — 판정은 기본값이 아니라 배선이다.
 */
import { assert, assertIsolated, fakeNetwork, type Assertion, type RegressionCheck } from "./_framework.js";
import { callbackUpdate, fakeChannel, loadTelegram, settle, startWithOwners, textUpdate } from "./_fake-telegram.js";

const OWNER = 111;
let uid = 900_000;

const docUpdate = (fromId: number, caption: string): unknown => ({
  update_id: uid++,
  message: {
    message_id: uid,
    date: Math.floor(Date.now() / 1000),
    chat: { id: fromId, type: "private", first_name: "o" },
    from: { id: fromId, is_bot: false, first_name: "o" },
    caption,
    document: { file_id: `f${uid}`, file_unique_id: `fu${uid}`, file_name: "reply.md", mime_type: "text/markdown", file_size: 16 },
  },
});
const replyTextUpdate = (fromId: number, text: string, replyTo: number): unknown => ({
  update_id: uid++,
  message: {
    message_id: uid,
    date: Math.floor(Date.now() / 1000),
    chat: { id: fromId, type: "private", first_name: "o" },
    from: { id: fromId, is_bot: false, first_name: "o" },
    text,
    reply_to_message: { message_id: replyTo, date: 0, chat: { id: fromId, type: "private" }, text: `원글${replyTo}` },
  },
});

interface Seen {
  text: string;
  attachments: number;
  ids: number;
  at: number;
}

export const check: RegressionCheck = {
  name: "telegram-inbound-batch",
  guards:
    "텔레그램에서 글과 파일이 몇 초 간격으로 따로 오면 글만으로 턴이 시작돼, 이미 와 있던 파일을 못 보고 «첨부 못 받았다» 고 틀리게 답하던 것",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const out: Assertion[] = [];
    const mod = await loadTelegram();
    const { channel, bot, calls } = fakeChannel(mod, (method) =>
      method === "getFile" ? { ok: true, result: { file_id: "f", file_unique_id: "fu", file_path: "documents/reply.md" } } : undefined,
    );
    const savedFetch = globalThis.fetch;
    const savedQuiet = process.env.TELEGRAM_BATCH_QUIET_MS;
    const savedMax = process.env.TELEGRAM_BATCH_MAX_MS;
    globalThis.fetch = fakeNetwork(async () => {
      await new Promise((r) => setTimeout(r, 400)); // 다운로드가 조용한 창보다 길어도 앞 글과 한 턴이어야 한다
      return new Response("# 아스트라 회신\n");
    }) as typeof fetch;
    const setWindow = (quiet: string, max: string): void => {
      process.env.TELEGRAM_BATCH_QUIET_MS = quiet;
      process.env.TELEGRAM_BATCH_MAX_MS = max;
    };
    const seen: Seen[] = [];
    // ⑦ 의 «긴 턴» — 종료가 이 턴을 기다리는 동안(최대 1초) 새 글이 온다.
    let releaseLong: () => void = () => {};
    const longTurn = new Promise<void>((r) => {
      releaseLong = r;
    });
    try {
      await startWithOwners(channel, String(OWNER), async (msg) => {
        const m = msg as unknown as { attachments?: unknown[]; channelMessageRef?: { messageIds: number[] } };
        seen.push({ text: msg.text, attachments: m.attachments?.length ?? 0, ids: m.channelMessageRef?.messageIds.length ?? 0, at: Date.now() });
        if (msg.text === "종료 직전 글") await longTurn;
      });
      setWindow("300", "800");

      // ① 글 → 150ms 뒤 파일(캡션) → 한 턴
      seen.length = 0;
      await bot.handleUpdate(textUpdate(OWNER, "아스트라 회신"));
      await settle(150);
      await bot.handleUpdate(docUpdate(OWNER, "첨부 확인"));
      await settle(500);
      out.push(
        assert(
          "★① 글 뒤 창 안에 온 파일은 한 턴 — 글·캡션 순서대로, 첨부 1·원문 id 2",
          seen.length === 1 && seen[0]!.text === "아스트라 회신\n첨부 확인" && seen[0]!.attachments === 1 && seen[0]!.ids === 2,
          JSON.stringify(seen),
        ),
      );

      // ② 창 밖 → 두 턴
      seen.length = 0;
      await bot.handleUpdate(textUpdate(OWNER, "하나"));
      await settle(500);
      await bot.handleUpdate(textUpdate(OWNER, "둘"));
      await settle(500);
      out.push(assert("② 창 밖에 온 메시지는 따로 두 턴", seen.length === 2 && seen[0]!.text === "하나" && seen[1]!.text === "둘", JSON.stringify(seen)));

      // ③ 명령은 즉시 — 쌓인 글이 먼저
      seen.length = 0;
      await bot.handleUpdate(textUpdate(OWNER, "먼저 쓴 글"));
      await bot.handleUpdate(textUpdate(OWNER, "/stop"));
      await settle(60);
      out.push(
        assert(
          "★③ 명령은 창을 기다리지 않고, 쌓여 있던 글을 먼저 보낸다(순서 보존)",
          seen.length === 2 && seen[0]!.text === "먼저 쓴 글" && seen[1]!.text === "/stop",
          JSON.stringify(seen),
        ),
      );

      // ④ 200ms 간격으로 계속 → 상한(800ms)에서 강제로
      seen.length = 0;
      const t0 = Date.now();
      for (let i = 0; i < 6; i++) {
        await bot.handleUpdate(textUpdate(OWNER, `연속${i}`));
        await settle(200);
      }
      await settle(500);
      const firstAfter = seen.length > 0 ? seen[0]!.at - t0 : -1;
      out.push(
        assert(
          "④ 이어 오는 동안에도 상한에서 강제로 보낸다(첫 턴이 상한 무렵, 묶음 2개)",
          seen.length === 2 && firstAfter >= 700 && firstAfter < 1100 && seen[0]!.text.startsWith("연속0\n연속1"),
          { firstAfter, turns: seen.map((s) => s.text) },
        ),
      );

      // ⑥ 서로 다른 글에 단 답글 → 섞지 않는다
      seen.length = 0;
      await bot.handleUpdate(replyTextUpdate(OWNER, "이건 A 얘기", 41));
      await bot.handleUpdate(replyTextUpdate(OWNER, "이건 B 얘기", 42));
      await settle(500);
      out.push(assert("⑥ 서로 다른 메시지에 단 답글은 따로 턴", seen.length === 2, JSON.stringify(seen)));

      // ⑧ 버튼 답은 즉시 — 쌓인 글이 먼저
      await channel.outbound!.presentOptionsTo!(String(OWNER), "어떻게 할까요?", [{ label: "보관", value: "보관해 줘" }]);
      const kb = ([...calls].reverse().find((c) => c.method === "sendMessage" && c.payload.reply_markup !== undefined)?.payload
        .reply_markup as { inline_keyboard?: { callback_data: string }[][] } | undefined)?.inline_keyboard;
      const optionId = kb?.[0]?.[0]?.callback_data ?? "";
      seen.length = 0;
      await bot.handleUpdate(textUpdate(OWNER, "버튼 전에 쓴 글"));
      await bot.handleUpdate(callbackUpdate(OWNER, optionId));
      await settle(60);
      out.push(
        assert(
          "★⑧ 버튼 답은 창을 기다리지 않고, 쌓여 있던 글을 먼저 보낸다(순서 보존)",
          optionId !== "" && seen.length === 2 && seen[0]!.text === "버튼 전에 쓴 글" && seen[1]!.text === "보관해 줘",
          { optionId, seen },
        ),
      );

      // ⑤ 0 = 끔 → 메시지마다 바로
      setWindow("0", "800");
      seen.length = 0;
      await bot.handleUpdate(textUpdate(OWNER, "끔1"));
      await settle(30);
      await bot.handleUpdate(textUpdate(OWNER, "끔2"));
      await settle(30);
      out.push(assert("⑤ 창 0 이면 끈다 — 메시지마다 바로 한 턴", seen.length === 2 && seen[0]!.text === "끔1", JSON.stringify(seen)));

      // ⑦ 종료 — 쌓인 묶음을 핸들러에 넘긴다
      setWindow("5000", "10000");
      seen.length = 0;
      await bot.handleUpdate(textUpdate(OWNER, "종료 직전 글"));
      await settle(30);
      const beforeStop = seen.length;
      const stopping = channel.stop(); // 긴 턴을 기다리느라 최대 1초 걸린다 — 그 사이 폴러는 계속 돈다
      await settle(200);
      await bot.handleUpdate(textUpdate(OWNER, "종료 중 도착"));
      await stopping;
      out.push(
        assert("⑦ 종료 때 쌓인 묶음을 버리지 않는다(창이 남았어도 핸들러로)", beforeStop === 0 && seen[0]?.text === "종료 직전 글", { beforeStop, seen }),
      );
      out.push(
        assert(
          "★⑦ 종료가 기다리는 동안 온 글도 종료가 끝나기 전에 핸들러로 간다(새 묶음에 담겨 타이머째 사라지지 않게)",
          seen.length === 2 && seen[1]!.text === "종료 중 도착",
          seen.map((s) => s.text),
        ),
      );
    } finally {
      releaseLong();
      globalThis.fetch = savedFetch;
      if (savedQuiet === undefined) delete process.env.TELEGRAM_BATCH_QUIET_MS;
      else process.env.TELEGRAM_BATCH_QUIET_MS = savedQuiet;
      if (savedMax === undefined) delete process.env.TELEGRAM_BATCH_MAX_MS;
      else process.env.TELEGRAM_BATCH_MAX_MS = savedMax;
      await channel.stop();
    }
    return out;
  },
};
