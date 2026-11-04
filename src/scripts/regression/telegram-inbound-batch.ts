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
 *  ⑨ 세션이 A→B→A로 갈려도 도착순서·세션을 지킨다(글·첨부 답글 모두)
 *  ⑩ 타이머 상한을 넘은 창 설정은 기본값으로 돌아간다(1ms로 실행되지 않게)
 *
 * 등급: **동작**. 창은 짧게 줄여 잰다(조용한 창 300ms · 상한 800ms) — 판정은 기본값이 아니라 배선이다.
 */
import { assert, assertIsolated, fakeNetwork, loadPluginModule, type Assertion, type RegressionCheck } from "./_framework.js";
import { callbackUpdate, fakeChannel, loadTelegram, settle, startWithOwners, textUpdate } from "./_fake-telegram.js";

const OWNER = 111;
let uid = 900_000;

const docUpdate = (fromId: number, caption: string, replyTo?: number): unknown => ({
  update_id: uid++,
  message: {
    message_id: uid,
    date: Math.floor(Date.now() / 1000),
    chat: { id: fromId, type: "private", first_name: "o" },
    from: { id: fromId, is_bot: false, first_name: "o" },
    caption,
    ...(replyTo !== undefined ? { reply_to_message: { message_id: replyTo, date: 0, chat: { id: fromId, type: "private" }, text: `원글${replyTo}` } } : {}),
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
  threadKey: string | undefined;
  explicitSessionId: string | undefined;
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
    const { readBatchWindow, DEFAULT_QUIET_MS, DEFAULT_MAX_MS } = await loadPluginModule<{
      readBatchWindow: () => { quietMs: number; maxMs: number };
      DEFAULT_QUIET_MS: number;
      DEFAULT_MAX_MS: number;
    }>("../../../plugins/telegram-channel/inbound-batch.ts");
    const { recordOutboundMessage } = await import("../../store/outbound-messages.js");
    const { resolveSessionId } = await import("../../core/threadkey.js");
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
        const m = msg as unknown as {
          threadKey?: string;
          session?: { explicitSessionId?: string };
          attachments?: unknown[];
          channelMessageRef?: { messageIds: number[] };
        };
        seen.push({
          text: msg.text, threadKey: m.threadKey, explicitSessionId: m.session?.explicitSessionId,
          attachments: m.attachments?.length ?? 0, ids: m.channelMessageRef?.messageIds.length ?? 0, at: Date.now(),
        });
        if (msg.text === "종료 직전 글") await longTurn;
      });
      // ⑩ 설정은 두 창을 각각 검사한다 — 한쪽만 잘못됐어도 다른 쪽은 보존한다.
      const invalidWindows = ["2147483648", "2147483649", "1e100", "Infinity", "NaN", "-1", "bad", "", " "];
      const invalidResults = invalidWindows.map((raw) => {
        setWindow(raw, "800");
        const quiet = readBatchWindow();
        setWindow("300", raw);
        const max = readBatchWindow();
        return { raw, quiet, max };
      });
      out.push(assert(
        "⑩ 잘못된 창·32비트 타이머 상한 초과는 해당 창만 기본값으로",
        invalidResults.every(({ quiet, max }) => quiet.quietMs === DEFAULT_QUIET_MS && quiet.maxMs === 800 && max.quietMs === 300 && max.maxMs === DEFAULT_MAX_MS),
        invalidResults,
      ));
      const validWindows = ["0", "1.5", "300", "2147483647"];
      const validResults = validWindows.map((raw) => {
        setWindow(raw, raw);
        return { raw, got: readBatchWindow() };
      });
      delete process.env.TELEGRAM_BATCH_QUIET_MS;
      delete process.env.TELEGRAM_BATCH_MAX_MS;
      const defaults = readBatchWindow();
      out.push(assert(
        "⑩ 0·작은 창·상한값은 보존하고, 미설정은 기본값",
        validResults.every(({ raw, got }) => got.quietMs === Number(raw) && got.maxMs === Number(raw)) && defaults.quietMs === DEFAULT_QUIET_MS && defaults.maxMs === DEFAULT_MAX_MS,
        { validResults, defaults },
      ));
      setWindow("2147483648", "2147483649");
      await bot.handleUpdate(textUpdate(OWNER, "상한 밖 창"));
      await settle(60);
      const overflowEarly = seen.length;
      await bot.handleUpdate(textUpdate(OWNER, "/stop"));
      await settle(60);
      out.push(assert(
        "★⑩ 상한 밖 창이 1ms로 발사되지 않고, 명령이 오면 잔여 묶음 먼저 전달",
        overflowEarly === 0 && seen.length === 2 && seen[0]!.text === "상한 밖 창" && seen[1]!.text === "/stop",
        { overflowEarly, seen },
      ));
      setWindow("300", "0");
      seen.length = 0;
      await bot.handleUpdate(textUpdate(OWNER, "상한 0"));
      await settle(60);
      out.push(assert("⑩ 상한 0은 즉시 전달", seen.length === 1 && seen[0]!.text === "상한 0", JSON.stringify(seen)));
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

      // ⑨ 같은 chat의 A→B→A. 서로 다른 원글 답글만 시험하면 replyTo 경계가 세션 키 변이를 가려 버린다.
      const defaultSession = resolveSessionId("telegram", String(OWNER));
      const otherSession = "dashboard:regr-batch-other";
      const originId = 948_001;
      recordOutboundMessage("telegram", String(OWNER), originId, otherSession, Date.now());
      seen.length = 0;
      await bot.handleUpdate(textUpdate(OWNER, "A1"));
      await settle(80);
      await bot.handleUpdate(replyTextUpdate(OWNER, "B1", originId));
      await settle(80);
      await bot.handleUpdate(textUpdate(OWNER, "A2"));
      await settle(500);
      out.push(assert(
        "★⑨ 글 A1→B세션 답글 B1→A2는 세 턴·도착순서·각 발원 세션 보존",
        seen.length === 3 && seen[0]!.text === "A1" && seen[1]!.text === "B1" && seen[2]!.text === "A2" &&
          seen[0]!.threadKey === defaultSession && seen[1]!.threadKey === otherSession && seen[2]!.threadKey === defaultSession &&
          seen[1]!.explicitSessionId === otherSession && seen.every((s) => s.ids === 1),
        JSON.stringify(seen),
      ));
      seen.length = 0;
      // 첨부 경로의 키도 독립적으로 잰다 — A/B 모두 첨부여야 첨부만 세션 키를 빼는 변이도 잡는다.
      const downloadingA1 = bot.handleUpdate(docUpdate(OWNER, "첨부 전 A1"));
      await settle(80);
      // 다운로드보다 먼저 B의 묶음 자리가 잡힌다. 기다리지 않고 A2를 보내 순서·세션 분리를 함께 잰다.
      const downloadingB = bot.handleUpdate(docUpdate(OWNER, "B 첨부", originId));
      await settle(80);
      const downloadingA2 = bot.handleUpdate(docUpdate(OWNER, "첨부 후 A2"));
      await Promise.all([downloadingA1, downloadingB, downloadingA2]);
      await settle(500);
      out.push(assert(
        "★⑨ 첨부 답글도 A→B→A 세션 경계 — 다운로드가 늦어도 섞임·역전 없음",
        seen.length === 3 && seen[0]!.text === "첨부 전 A1" && seen[1]!.text === "B 첨부" && seen[2]!.text === "첨부 후 A2" &&
          seen[0]!.threadKey === defaultSession && seen[1]!.threadKey === otherSession && seen[2]!.threadKey === defaultSession &&
          seen[1]!.explicitSessionId === otherSession && seen.every((s) => s.attachments === 1 && s.ids === 1),
        JSON.stringify(seen),
      ));

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
