/** 합성 물리 발송의 ID를 실제 텔레그램 인입 라우터까지 연결한다. 모델/네트워크 없음. */
import { deliverOutbound } from "../../core/outbound.js";
import { getChannelOutbound, registerChannelOutbound, unregisterChannelOutbound } from "../../core/channel-outbound.js";
import { initStore } from "../../store/sessions.js";
import { assert, assertIsolated, loadPluginModule, type RegressionCheck } from "./_framework.js";

type Route = { sessionId: string; repliedSession: string | null; routedSession: string | null };
export const check: RegressionCheck = {
  name: "two-channel-reply-continuity",
  guards: "발송→메시지 귀속→답장 라우팅의 연결에서 세션 또는 대화방이 섞이는 것",
  run: async () => {
    assertIsolated(); initStore();
    const { resolveReplyRouting } = await loadPluginModule<{
      resolveReplyRouting: (chat: string, id: number | undefined, bound: string, kind: "text" | "attachment") => Route;
    }>("../../../plugins/telegram-channel/reply-routing.ts");
    const previous = getChannelOutbound("telegram");
    const sent: Array<{ target: string | null; ids: number[] }> = [];
    const A = "dashboard:continuity-a", B = "dashboard:continuity-b";
    const chatA = "continuity-chat-a", chatB = "continuity-chat-b";
    registerChannelOutbound("telegram", {
      deliver: async target => {
        // 서로 다른 대화방에서 같은 ID가 나오는 실제 채번 범위를 재현한다.
        const ids = target === chatA ? [981101, 981102] : [981101];
        sent.push({ target, ids });
        return { messageIds: ids };
      },
    });
    try {
      await deliverOutbound({ channel: "telegram", target: chatA, text: "A 결과", originThreadKey: A, observe: false });
      await deliverOutbound({ channel: "telegram", target: chatB, text: "B 결과", originThreadKey: B, observe: false });
      const idA = sent.find(x => x.target === chatA)?.ids;
      const idB = sent.find(x => x.target === chatB)?.ids[0];
      const routes = (idA ?? []).flatMap(id => ["text", "attachment"].map(kind => resolveReplyRouting(chatA, id, B, kind as "text" | "attachment")));
      const other = resolveReplyRouting(chatB, idB, A, "text");
      const unknown = resolveReplyRouting(chatA, 981199, B, "text");
      const plain = resolveReplyRouting(chatA, undefined, B, "text");
      const repeated = resolveReplyRouting(chatA, idA?.[0], B, "text");
      return [
        assert("실제 발송 경로의 반환 ID를 두 대화방에서 얻음", sent.length === 2 && idA?.length === 2 && idA[0] === idB, sent),
        assert("모든 발송 청크의 텍스트·첨부 답글이 A로 복귀", routes.length === 4 && routes.every(r => r.sessionId === A && r.repliedSession === A && r.routedSession === A), routes),
        assert("다른 대화방의 같은 ID는 B로 복귀", other.sessionId === B && other.repliedSession === B, other),
        assert("매핑 없는 답글은 현재 B 유지", unknown.sessionId === B && unknown.repliedSession === null, unknown),
        assert("답글 없는 메시지는 현재 B 유지", plain.sessionId === B && plain.repliedSession === null, plain),
        assert("B 조회 후에도 A 귀속은 바뀌지 않음", repeated.sessionId === A, repeated),
      ];
    } finally {
      if (previous) registerChannelOutbound("telegram", previous);
      else unregisterChannelOutbound("telegram");
    }
  },
};
