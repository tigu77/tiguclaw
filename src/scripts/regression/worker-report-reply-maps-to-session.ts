/**
 * 회귀: **매니저 결과 보고에 답글을 달면 그 매니저를 띄운 세션으로 간다** (2026-09-25).
 *
 * ★사고(정태님, 텔레그램): 답글이 해당 세션으로 안 가고 기본 세션으로 갈 때가 있었다. 로그:
 *   09:23:30 세션 b27957a2 가 매니저 결과를 보고 → 09:23:31 `deliverOutbound: 보냈지만 답장 매핑을
 *   못 남겼습니다 — 발원 세션 미지정 · label=worker` → 09:24:50 그 메시지(5063)에 답글 →
 *   `발원 세션을 못 찾았습니다 … dashboard:default 으로 진행` → 이후 대화가 기본 세션에서 이어짐.
 * ★뿌리: 완료 재주입(메인이 결과를 받아 보고하는 턴)의 답 통로 `reinjectReply` 만 발원 세션을
 *  안 실었다. 표시는 핸들러가 맡으니 `observe:false` 로 비웠는데, 그러면서 **귀속까지** 비웠다 —
 *  `originThreadKey` 를 갈라놓은 08-11 사고와 같은 모양이다(표시 ≠ 누가 한 말인가).
 *  그리고 이 통로가 **사용자가 가장 답글을 달 법한 메시지**(결과 보고)를 낸다.
 *
 * 지키는 것: 스텁 채널(메시지 id 를 돌려준다)을 꽂고 `onWorkerComplete` 를 **실제로 돌려**,
 *  ① 재주입 턴의 답이 매니저를 띄운 세션으로 매핑된다 ② 내부 파생 스레드(스케줄)가 띄운 매니저는
 *  기본 세션으로 매핑된다(보이는 곳과 같은 자리 — `notifySessionThreadKey` 규칙)
 *  ③ 재주입 답은 여전히 관측을 발행하지 않는다(대시보드 이중 버블 0 — 관측은 핸들러 몫).
 */
import { getEventBus, initEventBus } from "../../core/eventbus.js";
import { registerChannelOutbound } from "../../core/channel-outbound.js";
import {
  __resetJobsForTest,
  onWorkerComplete,
  registerJob,
  registerWorkerHandler,
} from "../../core/worker-jobs.js";
import { initStore } from "../../store/sessions.js";
import { findSessionForOutboundMessage } from "../../store/outbound-messages.js";
import { assert, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";

const CH = "regr-worker-report";
const TARGET = "regr-chat";
let nextId = 880_000;

const drive = async (threadKey: string): Promise<{ id: number | null; outs: number }> => {
  __resetJobsForTest();
  let sentId: number | null = null;
  registerChannelOutbound(CH, {
    deliver: async () => {
      sentId = ++nextId;
      return { messageIds: [sentId] };
    },
    defaultOutboundTarget: async () => TARGET,
  });
  let outs = 0;
  const off = getEventBus().subscribe((e) => {
    if (e.type === "channel.message.out" && e.payload.channel === CH) outs++;
  });
  registerWorkerHandler(async (msg) => {
    await msg.reply("매니저 결과를 정리해 보고합니다");
  });
  const jobId = registerJob({
    label: "회귀용 잡",
    task: "아무 일",
    threadKey,
    channel: CH,
    channelUserId: "regr-user",
    notifyDest: { channel: CH, target: TARGET },
  });
  await onWorkerComplete(jobId, { result: "결과물" });
  if (typeof off === "function") off();
  return { id: sentId, outs };
};

export const check: RegressionCheck = {
  name: "worker-report-reply-maps-to-session",
  guards:
    "매니저 결과 보고(완료 재주입 턴의 답)가 답장 매핑 없이 나가, 거기에 텔레그램 답글을 달면 매니저를 띄운 세션이 아니라 기본 세션으로 가던 것",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    initStore();
    initEventBus();
    const SESSION = "dashboard:regr-worker-origin";
    const fromSession = await drive(SESSION);
    const mappedSession = fromSession.id === null ? null : findSessionForOutboundMessage(CH, TARGET, fromSession.id);
    const fromSchedule = await drive("scheduler:regr-1");
    const mappedSchedule = fromSchedule.id === null ? null : findSessionForOutboundMessage(CH, TARGET, fromSchedule.id);
    return [
      assert("재주입 턴의 답이 실제로 채널로 나갔다(없으면 아래는 공짜 초록)", fromSession.id !== null, `message_id=${String(fromSession.id)}`),
      assert("★① 결과 보고에 답글을 달면 매니저를 띄운 세션으로 간다", mappedSession === SESSION, `매핑=${String(mappedSession)} (기대 ${SESSION})`),
      assert("② 스케줄이 띄운 매니저의 보고는 기본 세션으로 매핑된다(보이는 곳과 같은 자리)", mappedSchedule === "dashboard:default", `매핑=${String(mappedSchedule)}`),
      assert("③ 재주입 답은 관측을 발행하지 않는다(이중 버블 0 — 관측은 핸들러 몫)", fromSession.outs === 0, `channel.message.out ${fromSession.outs}회`),
    ];
  },
};
