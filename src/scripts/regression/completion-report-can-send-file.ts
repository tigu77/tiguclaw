/**
 * 회귀: **매니저 완료 보고 턴도 결과물 파일을 보낼 수 있다** (2026-09-30 정태님 — «이것도 가능하면 수정해야지»).
 *
 * ★사고(회사돌쇠 09-29 5회): 매니저가 만든 아이콘·원화를 보고와 함께 붙이려다 `send_file` 이 매번
 *  «자동 보고 턴이라 채널로 직접 보낼 통로가 없습니다» 로 막혔다. 인입 메시지가 없는 턴이라 채널이 주는
 *  `sendAttachment` 콜백이 없었고, 채널 레지스트리엔 **글만** 보내는 자리(`deliver`)가 있었다.
 * ★고침: 레지스트리에 파일 자리(`deliverAttachment`)를 두고, 완료 재주입 턴이 매니저의 보고 좌표로 묶어 쓴다.
 *
 * 지키는 것: 스텁 채널을 꽂고 `onWorkerComplete` 를 **실제로 돌려**
 *  ① 재주입 턴이 파일 전송 콜백을 받는다 ② 그 콜백이 매니저의 보고 좌표로 채널의 파일 자리에 닿는다(캡션 포함)
 *  ③ 좌표가 비면 채널의 기본 좌표로 간다(글 발송과 같은 규칙)
 *  ④ 파일 발송 능력이 없는 채널(CLI 등)은 콜백을 비워 둔다 — 종전 동작(«이 턴에선 불가» 자리표시)으로
 *  ⑤ 매니저의 채널이 아니라 **보고 좌표의 채널**로 묶는다(적대 검토 N8)
 *  ⑥ 실제 채널 구현을 실행한다 — 텔레그램 `deliverDocument`·대시보드 `deliverSessionAttachment`(적대 검토 G2):
 *     좌표·캡션이 그대로 가고, 좌표가 없으면 «다시 해도 안 됨»(unavailable)으로 답한다
 *  ⑦ 파일에도 세션 정보를 싣는다(정태님 09-30): 보낸 메시지를 발원 세션에 묶어 답글이 그 세션으로 가고,
 *     다른 세션이면 캡션 앞에 `[세션명]`, 캡션이 1,024자를 넘으면 나머지는 뒤 글 메시지로(그것도 묶는다)
 */
import { initEventBus } from "../../core/eventbus.js";
import { registerChannelOutbound, unregisterChannelOutbound } from "../../core/channel-outbound.js";
import {
  __resetJobsForTest,
  onWorkerComplete,
  registerJob,
  registerWorkerHandler,
} from "../../core/worker-jobs.js";
import { initStore } from "../../store/sessions.js";
import { findSessionForOutboundMessage } from "../../store/outbound-messages.js";
import { assert, assertIsolated, loadPluginModule, type Assertion, type RegressionCheck } from "./_framework.js";

const CH = "regr-report-file";
const CH_TEXT_ONLY = "regr-report-textonly";
const DEFAULT_TARGET = "regr-default-chat";

interface Seen { hadSender: boolean; result?: { ok: boolean; error?: string }; delivered: { target: string | null; filePath: string; caption?: string; origin?: string }[] }

const drive = async (channel: string, target: string | null, jobChannel: string = channel): Promise<Seen> => {
  __resetJobsForTest();
  const seen: Seen = { hadSender: false, delivered: [] };
  registerWorkerHandler(async (msg) => {
    seen.hadSender = msg.sendAttachment !== undefined;
    if (msg.sendAttachment !== undefined) seen.result = await msg.sendAttachment("/tmp/regr-icon.png", { caption: "아이콘" });
    await msg.reply("결과를 보고합니다");
  });
  const jobId = registerJob({
    label: "회귀용 잡",
    task: "아이콘 만들기",
    threadKey: "dashboard:regr-report-file",
    channel: jobChannel,
    channelUserId: "regr-user",
    notifyDest: { channel, target },
  });
  await onWorkerComplete(jobId, { result: "아이콘 67개" });
  return seen;
};

/** 실제 채널 함수 — 봇·서버 없이 부른다(토큰이 있어야 뜨는 인스턴스 대신 판단 함수를 직접). */
const realChannels = async (): Promise<Assertion[]> => {
  const tg = await loadPluginModule<{
    deliverDocument: (
      api: { sendDocument: (...a: unknown[]) => Promise<unknown>; sendMessage: (...a: unknown[]) => Promise<unknown> } | undefined,
      target: string | null, filePath: string, opts?: { caption?: string; originThreadKey?: string },
    ) => Promise<{ ok: boolean; error?: string; unavailable?: true }>;
    CAPTION_MAX: number;
  }>("../../../plugins/telegram-channel/send-document.js");
  let mid = 770_000;
  const calls: { chatId: unknown; extra: unknown }[] = [];
  const texts: { chatId: unknown; text: unknown; id: number }[] = [];
  const api = {
    sendDocument: async (chatId: unknown, _file: unknown, extra: unknown) => { calls.push({ chatId, extra }); return { message_id: ++mid }; },
    sendMessage: async (chatId: unknown, text: unknown) => { const id = ++mid; texts.push({ chatId, text, id }); return { message_id: id }; },
  };
  const sent = await tg.deliverDocument(api, "4242", "/tmp/regr-icon.png", { caption: "아이콘" });
  const firstCall = calls[0];
  const failing = await tg.deliverDocument({ sendDocument: async () => { throw new Error("Bad Request: file too big"); }, sendMessage: api.sendMessage }, "4242", "/tmp/x.png");
  // ⑦ 세션 정보 — 다른 세션에서 온 파일
  const ORIGIN = "dashboard:regr-file-origin";
  calls.length = 0;
  const fromOther = await tg.deliverDocument(api, "4242", "/tmp/regr-icon.png", { caption: "아이콘 67개", originThreadKey: ORIGIN });
  const labeled = String((calls[0]?.extra as { caption?: string } | undefined)?.caption ?? "");
  const fileId = mid;
  const mapped = findSessionForOutboundMessage("telegram", "4242", fileId);
  calls.length = 0;
  const fromDefault = await tg.deliverDocument(api, "4242", "/tmp/regr-icon.png", { caption: "아이콘", originThreadKey: "dashboard:default" });
  const plain = String((calls[0]?.extra as { caption?: string } | undefined)?.caption ?? "");
  // ⑦ 긴 설명 — 캡션 한도를 넘는 나머지는 뒤 글 메시지로, 그것도 세션에 묶는다
  calls.length = 0; texts.length = 0;
  const long = "가".repeat(tg.CAPTION_MAX) + " 나머지 설명";
  const longSent = await tg.deliverDocument(api, "4242", "/tmp/regr-icon.png", { caption: long, originThreadKey: ORIGIN });
  const longCap = String((calls[0]?.extra as { caption?: string } | undefined)?.caption ?? "");
  const restId = texts[0]?.id;
  const restMapped = restId === undefined ? null : findSessionForOutboundMessage("telegram", "4242", restId);
  const noTarget = await tg.deliverDocument(api, null, "/tmp/x.png");
  const noBot = await tg.deliverDocument(undefined, "4242", "/tmp/x.png");

  const http = await loadPluginModule<{
    deliverSessionAttachment: (i: {
      bus: { publish: (e: { type: string; payload: Record<string, unknown> }) => void } | null;
      channel: string; target: string | null; filePath: string; caption?: string;
    }) => Promise<{ ok: boolean; error?: string; unavailable?: true }>;
  }>("../../../plugins/http-bridge/attachments.js");
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "regr-report-file-"));
  const file = join(dir, "icon.png");
  await writeFile(file, "png");
  const published: { type: string; payload: Record<string, unknown> }[] = [];
  const bus = { publish: (e: { type: string; payload: Record<string, unknown> }) => { published.push(e); } };
  const pub = await http.deliverSessionAttachment({ bus, channel: "http-bridge", target: "dashboard:regr-s", filePath: file, caption: "아이콘" });
  const att = (published[0]?.payload.attachments as { caption?: string }[] | undefined)?.[0];
  const httpNoTarget = await http.deliverSessionAttachment({ bus, channel: "http-bridge", target: null, filePath: file });
  const httpMissing = await http.deliverSessionAttachment({ bus, channel: "http-bridge", target: "dashboard:regr-s", filePath: join(dir, "없음.png") });
  // 인입 턴 세 곳(글·사진·선택지 후속)도 같은 세션을 넘기는가 — 채널 인스턴스는 토큰이 있어야 떠서 배선을 본다.
  const { readSourceSync } = await import("./_wiring.js");
  const tgSrc = readSourceSync("plugins/telegram-channel/index.ts");
  const inboundSends = tgSrc.match(/sendAttachment: \(filePath, opts\) =>\s*sendDocumentTo\([^)]*\)/g) ?? [];
  const inboundWithSession = inboundSends.filter((m) => m.includes("recordSession: sessionId")).length;
  // 좌표 발송 배선 — 채널 클래스가 실제 봇·버스와 받은 좌표를 그대로 넘기는가(재검토 G3: 봇을 undefined 로, 좌표를 null 로 바꿔도 초록이었다).
  const tgOutbound = /deliverAttachment: \(target, filePath, opts\) => deliverDocument\(this\.bot\?\.api, target, filePath, opts\)/.test(tgSrc);
  const httpSrc = readSourceSync("plugins/http-bridge/index.ts");
  const httpOutbound = /deliverSessionAttachment\(\{\s*bus: this\.bus,\s*channel: this\.name,\s*target,/.test(httpSrc);
  return [
    assert("⑥ 채널 클래스가 실제 봇·버스와 받은 좌표로 파일 자리를 배선한다", tgOutbound && httpOutbound, `텔레그램=${tgOutbound} 대시보드=${httpOutbound}`),
    assert("⑦ 인입 턴 세 곳 모두 파일을 그 턴의 세션에 묶는다", inboundSends.length === 3 && inboundWithSession === 3, `send_file 자리 ${inboundSends.length}곳 · 세션 넘김 ${inboundWithSession}곳`),
    assert("⑥ 텔레그램: 보고 좌표로 캡션과 함께 보낸다", sent.ok && firstCall?.chatId === "4242" && JSON.stringify(firstCall?.extra) === JSON.stringify({ caption: "아이콘" }), JSON.stringify({ sent, firstCall })),
    assert("⑥ 텔레그램: 전송 실패를 삼키지 않는다(사유 그대로)", !failing.ok && /file too big/.test(String(failing.error)) && failing.unavailable !== true, JSON.stringify(failing)),
    assert("⑦ 텔레그램: 다른 세션의 파일은 캡션 앞에 [세션] 표시 + 설명", fromOther.ok && /^\[[^\]]+\] 아이콘 67개$/.test(labeled), JSON.stringify({ fromOther, labeled })),
    assert("★⑦ 텔레그램: 파일 메시지가 발원 세션에 묶인다(답글이 그 세션으로 간다)", mapped === ORIGIN, `매핑=${String(mapped)}`),
    assert("⑦ 텔레그램: 기본 세션이면 표시를 안 붙인다(평소 무변화)", fromDefault.ok && plain === "아이콘", JSON.stringify({ plain })),
    assert(
      "⑦ 텔레그램: 한도를 넘는 설명은 캡션+뒤 글 메시지로 나뉘고 둘 다 세션에 묶인다",
      longSent.ok && longCap.length <= tg.CAPTION_MAX && texts.length === 1 && String(texts[0]?.text).includes("나머지 설명") && restMapped === ORIGIN,
      JSON.stringify({ capLen: longCap.length, rest: String(texts[0]?.text ?? "").slice(-12), restMapped }),
    ),
    assert("⑥ 텔레그램: 좌표 없음·봇 미기동은 «다시 해도 안 됨»", noTarget.unavailable === true && noBot.unavailable === true, JSON.stringify({ noTarget, noBot })),
    assert(
      "⑥ 대시보드: 그 세션에 캡션 달린 첨부로 발행한다",
      pub.ok && published[0]?.payload.threadKey === "dashboard:regr-s" && att?.caption === "아이콘",
      JSON.stringify({ pub, threadKey: published[0]?.payload.threadKey, att }),
    ),
    assert("⑥ 대시보드: 좌표 없음은 «다시 해도 안 됨», 파일 없음은 사유와 함께 실패", httpNoTarget.unavailable === true && !httpMissing.ok && httpMissing.unavailable !== true, JSON.stringify({ httpNoTarget, httpMissing })),
  ];
};

export const check: RegressionCheck = {
  name: "completion-report-can-send-file",
  guards:
    "매니저 완료 보고 턴에서 send_file 이 «자동 보고 턴이라 보낼 통로가 없습니다» 로 매번 막혀, 매니저가 만든 결과물을 보고와 함께 못 보내던 것",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    initStore();
    initEventBus();
    const delivered: Seen["delivered"] = [];
    registerChannelOutbound(CH, {
      deliver: async () => undefined,
      defaultOutboundTarget: async () => DEFAULT_TARGET,
      deliverAttachment: async (target, filePath, opts) => {
        delivered.push({ target, filePath, ...(opts?.caption !== undefined ? { caption: opts.caption } : {}), ...(opts?.originThreadKey !== undefined ? { origin: opts.originThreadKey } : {}) });
        return { ok: true };
      },
    });
    registerChannelOutbound(CH_TEXT_ONLY, { deliver: async () => undefined, defaultOutboundTarget: async () => DEFAULT_TARGET });
    try {
      const explicit = await drive(CH, "regr-chat");
      const firstDelivery = delivered[0];
      const viaDefault = await drive(CH, null);
      const secondDelivery = delivered[1];
      const textOnly = await drive(CH_TEXT_ONLY, "regr-chat");
      const crossed = await drive(CH, "regr-chat", CH_TEXT_ONLY); // 매니저는 파일 못 보내는 채널, 보고 좌표는 보내는 채널
      const channelOut = await realChannels();
      return [
        assert("⑤ 매니저 채널이 아니라 보고 좌표의 채널로 묶는다", crossed.hadSender && crossed.result?.ok === true, JSON.stringify(crossed.result)),
        ...channelOut,
        assert("★① 완료 보고 턴이 파일 전송 콜백을 받는다", explicit.hadSender, `hadSender=${explicit.hadSender}`),
        assert("② 보낸 결과가 성공이다", explicit.result?.ok === true, JSON.stringify(explicit.result)),
        assert(
          "② 매니저의 보고 좌표·경로·캡션 그대로 채널의 파일 자리에 닿는다",
          firstDelivery?.target === "regr-chat" && firstDelivery.filePath === "/tmp/regr-icon.png" && firstDelivery.caption === "아이콘",
          JSON.stringify(firstDelivery),
        ),
        assert("⑦ 매니저 보고 파일은 발원 세션을 채널에 넘긴다(답글 라우팅 재료)", firstDelivery?.origin === "dashboard:regr-report-file", JSON.stringify(firstDelivery)),
        assert("③ 좌표가 비면 채널의 기본 좌표로 간다", viaDefault.hadSender && secondDelivery?.target === DEFAULT_TARGET, JSON.stringify(secondDelivery)),
        assert("④ 파일 발송 능력이 없는 채널은 콜백을 비워 둔다(종전 동작)", !textOnly.hadSender, `hadSender=${textOnly.hadSender}`),
        assert("④ 그때 채널의 파일 자리로 새는 호출이 없다", delivered.length === 3, `호출 ${delivered.length}회(①·③·⑤)`),
      ];
    } finally {
      unregisterChannelOutbound(CH);
      unregisterChannelOutbound(CH_TEXT_ONLY);
    }
  },
};
