/** 답장 귀속을 실제 MCP 작업 선택/지시/취소에 연결. 모델·외부 전송 없음. */
import { deliverOutbound } from "../../core/outbound.js";
import { getChannelOutbound, registerChannelOutbound, unregisterChannelOutbound } from "../../core/channel-outbound.js";
import { initStore } from "../../store/sessions.js";
import { createWorkerMcpServer } from "../../core/llm-runtime/capabilities/worker-registry.js";
import { registerJob, createJobAbort, setSteerChannel, getJob, __resetJobsForTest } from "../../core/worker-jobs.js";
import { createSteeringChannel } from "../../core/steering.js";
import { assert, assertIsolated, loadPluginModule, type RegressionCheck } from "./_framework.js";
export const check: RegressionCheck = {
  name: "two-channel-work-control",
  guards: "답글이 찾은 세션과 다른 세션의 동명 작업에 지시·취소가 적용되는 것",
  run: async () => {
    assertIsolated(); initStore(); __resetJobsForTest();
    const previous = getChannelOutbound("telegram");
    const A = "dashboard:control-a", B = "dashboard:control-b";
    let sentId: number | undefined;
    registerChannelOutbound("telegram", { deliver: async () => { sentId = 982101; return { messageIds: [sentId] }; } });
    const base = { label: "동일 작업", task: "합성 작업", channel: "cli", channelUserId: "fixture" };
    const a = registerJob({ ...base, threadKey: A });
    const b = registerJob({ ...base, threadKey: B });
    const aa = createJobAbort(a), ba = createJobAbort(b);
    const ac = createSteeringChannel(), bc = createSteeringChannel();
    setSteerChannel(a, ac); setSteerChannel(b, bc);
    try {
      await deliverOutbound({ channel: "telegram", target: "control-chat", text: "A 진행", originThreadKey: A, observe: false });
      const { resolveReplyRouting } = await loadPluginModule<{
        resolveReplyRouting: (chat: string, id: number | undefined, bound: string, kind: "text") => { sessionId: string };
      }>("../../../plugins/telegram-channel/reply-routing.ts");
      const routed = resolveReplyRouting("control-chat", sentId, B, "text");
      const server = createWorkerMcpServer({ text: "추가 지시", channel: "telegram", threadKey: routed.sessionId });
      const tools = (server.instance as unknown as { _registeredTools: Record<string, { handler: (a: unknown, e: unknown) => Promise<unknown> }> })._registeredTools;
      const steer = await tools.steer_worker!.handler({ label: base.label, message: "A만 수정" }, {});
      const gotA = ac.drain(), gotB = bc.drain();
      const cancel = await tools.cancel_worker!.handler({ label: base.label }, {});
      const state = { a: getJob(a)?.status, b: getJob(b)?.status, aAborted: aa.signal.aborted, bAborted: ba.signal.aborted };
      const late = await tools.steer_worker!.handler({ label: base.label, message: "늦은 지시" }, {});
      const lateA = ac.drain(), lateB = bc.drain();
      return [
        assert("발송 ID로 현재 B 대신 A를 선택", sentId !== undefined && routed.sessionId === A, { sentId, routed }),
        assert("동명 작업 추가 지시는 A에만 전달", gotA.length === 1 && gotA[0]?.raw === "A만 수정" && gotB.length === 0, { gotA, gotB, steer }),
        assert("취소가 A 상태와 실제 abort 신호에 도달", state.a === "cancelled" && state.aAborted, { state, cancel }),
        assert("다른 세션 B 작업은 계속 실행 가능", state.b === "running" && !state.bAborted, state),
        assert("취소 후 같은 이름의 B로 지시가 새지 않음", lateA.length === 0 && lateB.length === 0 && getJob(b)?.status === "running", { lateA, lateB, late, b: getJob(b)?.status }),
      ];
    } finally {
      aa.done(); ba.done(); ac.close(); bc.close(); __resetJobsForTest();
      if (previous) registerChannelOutbound("telegram", previous); else unregisterChannelOutbound("telegram");
    }
  },
};
