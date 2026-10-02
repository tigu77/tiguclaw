/**
 * 회귀: **매니저 완료 보고·점검 턴의 선택지가 그 대화에도 뜬다** (2026-10-01 정태님 — «간혹 텔레그램에만 옵션이 뜨고 대시보드엔 안 뜬다»).
 *
 * ★사고(회사돌쇠 10-01 00:56, 로그 `synthetic → 새 턴`): 매니저 완료 보고 턴에서 비서가 선택지를 띄웠는데 텔레그램에만 갔다.
 *  인입 메시지가 없는 턴이라 채널이 주는 `presentOptions` 가 없었고, 선택지는 «함께 보낼 채널»(egress)로만 나갔다 —
 *  그리고 좌표로 선택지를 그리는 자리(`presentOptionsTo`)는 텔레그램에만 있었다. 답 글자는 대시보드에 보이니 «선택지만 빠짐».
 * ★고침: `completion-report-can-send-file` 과 같은 처방 — 대시보드 발신에 선택지 자리를 두고, 재주입 턴이 보고 좌표로 묶어 쓴다.
 *
 * 지키는 것: 스텁 채널로 `onWorkerComplete` 를 **실제로 돌려** ① 완료 턴이 선택지 통로를 받는다 ② 보고 좌표·질문·보기·발원 세션이
 *  채널에 그대로 닿는다 ③ 선택지 자리가 없는 채널은 통로를 비운다(종전 동작 — egress·텍스트 폴백)
 *  ④ 대시보드: 인입 턴과 **같은 발행 함수**로 그 세션에 `prompt.options` 를 낸다 · 좌표가 없으면 사유와 함께 실패 ⑤ 점검 턴도 같은 처방.
 */
import { initEventBus } from "../../core/eventbus.js";
import { registerChannelOutbound, unregisterChannelOutbound } from "../../core/channel-outbound.js";
import { __resetJobsForTest, onWorkerComplete, registerJob, registerWorkerHandler } from "../../core/worker-jobs.js";
import { initStore } from "../../store/sessions.js";
import { assert, assertIsolated, loadPluginModule, type Assertion, type RegressionCheck } from "./_framework.js";

const CH = "regr-report-options";
const CH_TEXT_ONLY = "regr-report-options-textonly";

interface Seen { had: boolean; result?: { ok: boolean; error?: string } }

const drive = async (channel: string, target: string | null, threadKey = "dashboard:regr-report-options"): Promise<Seen> => {
  __resetJobsForTest();
  const seen: Seen = { had: false };
  registerWorkerHandler(async (msg) => {
    seen.had = msg.presentOptions !== undefined;
    if (msg.presentOptions !== undefined) {
      seen.result = await msg.presentOptions("어느 색으로 갈까요?", [{ label: "주황갈색", value: "주황갈색으로" }, { label: "황토", value: "황토로" }], { note: "권장: 주황갈색" });
    }
    await msg.reply("결과를 보고합니다");
  });
  const jobId = registerJob({
    label: "회귀용 잡", task: "원화 검수", threadKey, channel, channelUserId: "regr-user",
    notifyDest: { channel, target },
  });
  await onWorkerComplete(jobId, { result: "검수 끝" });
  return seen;
};

export const check: RegressionCheck = {
  name: "completion-report-can-ask-options",
  guards: "매니저 완료 보고 턴의 선택지가 «함께 보낼 채널»(텔레그램)에만 가고 그 턴이 나가는 대화(대시보드)엔 안 뜨던 것",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    initStore();
    initEventBus();
    const asked: { target: string | null; question: string; values: string[]; note?: string; replyToSession?: string }[] = [];
    registerChannelOutbound(CH, {
      deliver: async () => undefined,
      defaultOutboundTarget: async () => "regr-default",
      presentOptionsTo: async (target, question, options, opts) => {
        asked.push({ target, question, values: options.map((o) => o.value), ...(opts?.note !== undefined ? { note: opts.note } : {}), ...(opts?.replyToSession !== undefined ? { replyToSession: opts.replyToSession } : {}) });
        return { ok: true };
      },
    });
    registerChannelOutbound(CH_TEXT_ONLY, { deliver: async () => undefined });
    try {
      const explicit = await drive(CH, "dashboard:regr-report-options");
      const textOnly = await drive(CH_TEXT_ONLY, "x");
      const first = asked[0];
      // 좌표를 생략한 잡(스케줄이 띄운 매니저) — 채널의 기본 좌표로 풀고, 고른 값은 **물어본 스레드**로(표시용 기본 세션이 아니다).
      await drive(CH, null, "scheduler:regr-21");
      const sched = asked[1];
      // ④ 대시보드 — 실제 발행 함수(인입 턴과 같은 것)
      const pub = await loadPluginModule<{ publishPromptOptions: (bus: unknown, i: { channel: string; threadKey: string; question: string; options: { label: string; value: string }[]; note?: string }) => { ok: boolean; error?: string } }>("../../../plugins/http-bridge/prompt-options-publish.js");
      const events: { type: string; payload: Record<string, unknown> }[] = [];
      const fakeBus = { publish: (e: { type: string; payload: Record<string, unknown> }) => { events.push(e); } };
      const ok = pub.publishPromptOptions(fakeBus, { channel: "http-bridge", threadKey: "dashboard:regr-s", question: "고를까요?", options: [{ label: "A", value: "a" }], note: "n" });
      const noBus = pub.publishPromptOptions(null, { channel: "http-bridge", threadKey: "dashboard:regr-s", question: "q", options: [] });
      // ④ 대시보드 발신 — 실제 채널 인스턴스의 presentOptionsTo 를 부른다(설명·채널·좌표가 그대로 가는가, 좌표 없으면 물어본 세션).
      const Bridge = (await loadPluginModule<{ default: new () => { outbound: { presentOptionsTo?: (t: string | null, q: string, o: { label: string; value: string }[], x?: { note?: string; replyToSession?: string }) => Promise<{ ok: boolean; error?: string }> } } }>("../../../plugins/http-bridge/index.js")).default;
      const savedTok = process.env.HTTP_BRIDGE_TOKEN;
      process.env.HTTP_BRIDGE_TOKEN = "regression-fake-bridge-token";
      const inst = new Bridge();
      if (savedTok === undefined) delete process.env.HTTP_BRIDGE_TOKEN; else process.env.HTTP_BRIDGE_TOKEN = savedTok;
      const bridgeEvents: { type: string; payload: Record<string, unknown> }[] = [];
      (inst as unknown as { bus: unknown }).bus = { publish: (e: { type: string; payload: Record<string, unknown> }) => { bridgeEvents.push(e); } };
      const viaTarget = await inst.outbound.presentOptionsTo?.("dashboard:regr-b", "고를까요?", [{ label: "A", value: "a" }], { note: "설명", replyToSession: "scheduler:x" });
      const viaSession = await inst.outbound.presentOptionsTo?.(null, "고를까요?", [{ label: "A", value: "a" }], { replyToSession: "dashboard:regr-c" });
      const noCoord = await inst.outbound.presentOptionsTo?.(null, "q", []);
      // ⑥ 스케줄 발화 — 핸들러를 우회하는 턴도 목적지로 묶은 선택지·파일 통로를 받는다(고른 값은 그 스케줄 스레드로).
      const sch = await loadPluginModule<{ scheduleChannels: (d: { channel: string; target: string | null } | undefined, tk: string) => { presentOptions?: (q: string, o: { label: string; value: string }[]) => Promise<{ ok: boolean }>; sendAttachment?: unknown } }>("../../../plugins/scheduler/src/index.js");
      const schOn = sch.scheduleChannels({ channel: CH, target: null }, "scheduler:regr-7");
      const before6 = asked.length; // ③ 은 이 시점까지의 호출 수로 본다
      await schOn.presentOptions?.("오늘 보고서 형식은?", [{ label: "짧게", value: "짧게" }]);
      const schAsk = asked[before6];
      const schNone = sch.scheduleChannels(undefined, "scheduler:regr-7");
      const schText = sch.scheduleChannels({ channel: CH_TEXT_ONLY, target: "x" }, "scheduler:regr-7");
      const { readSourceSync } = await import("./_wiring.js");
      const httpSrc = readSourceSync("plugins/http-bridge/index.ts");
      const chatSrc = readSourceSync("plugins/http-bridge/routes-chat.ts");
      const jobsSrc = readSourceSync("src/core/worker-jobs.ts");
      const wired = {
        // 좌표 발신이 같은 발행 함수를 쓴다(두 벌 금지 — 동작은 위 인스턴스 검사가 본다).
        outbound: /return publishPromptOptions\(this\.bus, \{/.test(httpSrc),
        // 인입 턴도 같은 함수(두 벌 금지).
        inbound: /presentOptions: IncomingMessage\["presentOptions"\] = async \([\s\S]{0,80}\) =>\s*publishPromptOptions\(bus, \{/.test(chatSrc) && !/type: "prompt\.options"/.test(chatSrc),
        // ⑤ 점검 턴도 같은 처방 — 완료·점검 두 곳.
        // ⑥ 스케줄 실행부가 그 통로를 실제로 싣는다.
        scheduler: /\.\.\.input,[\s\S]{0,400}\.\.\.scheduleChannels\(input\.notifyDest, input\.threadKey\),/.test(readSourceSync("plugins/scheduler/src/index.ts")),
        checkin: (jobsSrc.match(/optionsPresenterFor\(dest\.channel, dest\.target \?\? null, (?:job|reportJob)\.threadKey\)/g) ?? []).length === 2,
      };
      return [
        assert("★① 완료 보고 턴이 선택지 통로를 받는다", explicit.had && explicit.result?.ok === true, JSON.stringify(explicit)),
        assert("② 보고 좌표·질문·보기·설명·발원 세션이 채널에 그대로 닿는다",
          first?.target === "dashboard:regr-report-options" && first.question === "어느 색으로 갈까요?" && first.values.join(",") === "주황갈색으로,황토로" &&
            first.note === "권장: 주황갈색" && first.replyToSession === "dashboard:regr-report-options", JSON.stringify(first)),
        assert("③ 선택지 자리가 없는 채널은 통로를 비운다(종전 동작) · 새는 호출 없음", !textOnly.had && before6 === 2, JSON.stringify({ textOnly, calls: before6 })),
        assert("★좌표를 생략하면 채널의 기본 좌표로 · 내부 스레드 잡의 고른 값은 물어본 스레드로 돌아간다(기본 세션 아님)",
          sched?.target === "regr-default" && sched.replyToSession === "scheduler:regr-21", JSON.stringify(sched)),
        assert("④ 대시보드: 그 세션에 prompt.options 를 낸다 · 버스가 없으면 사유와 함께 실패",
          ok.ok && events[0]?.type === "prompt.options" && events[0]?.payload.threadKey === "dashboard:regr-s" && events[0]?.payload.note === "n" && !noBus.ok,
          JSON.stringify({ ok, ev: events[0]?.payload, noBus })),
        assert("★④ 대시보드 발신(실제 인스턴스): 좌표의 대화에 설명·채널과 함께 · 좌표가 없으면 물어본 세션에 · 둘 다 없으면 사유와 함께 실패",
          viaTarget?.ok === true && bridgeEvents[0]?.payload.threadKey === "dashboard:regr-b" && bridgeEvents[0]?.payload.note === "설명" && bridgeEvents[0]?.payload.channel === "http-bridge" &&
            viaSession?.ok === true && bridgeEvents[1]?.payload.threadKey === "dashboard:regr-c" && noCoord?.ok === false,
          { viaTarget, viaSession, noCoord, ev: bridgeEvents.map((e) => e.payload) }),
        assert("★⑥ 스케줄 발화도 목적지 기본 좌표로 선택지를 띄우고 고른 값은 그 스케줄 스레드로 · 목적지가 없거나 능력 없는 채널이면 비운다",
          schAsk?.target === "regr-default" && schAsk.replyToSession === "scheduler:regr-7" && schNone.presentOptions === undefined &&
            schText.presentOptions === undefined && schText.sendAttachment === undefined && wired.scheduler,
          { schAsk, wired: wired.scheduler }),
        assert("④⑤ 배선: 대시보드 좌표 발신·인입 턴이 같은 발행 함수 · 완료·점검 두 턴 모두 통로를 싣는다", Object.values(wired).every(Boolean), wired),
      ];
    } finally {
      unregisterChannelOutbound(CH);
      unregisterChannelOutbound(CH_TEXT_ONLY);
    }
  },
};
