/**
 * 회귀: 답장하면 **그 답이 나온 세션으로** 간다.
 *
 * 배경 (2026-08-10): egress("이 답도 함께 보낼 채널")로 한 텔레그램 대화에 **여러 세션의
 *  답이 섞여** 오게 됐다. 그러면 "어느 답에 대한 얘기인지" 를 가를 수단이 필요한데,
 *  답장이 그 자연스러운 UI 다. 그런데 `sendOutgoing` 이 `void` 라 텔레그램이 준
 *  `message_id` 를 **그냥 버렸고**, "이 메시지가 어느 세션 것" 을 알 방법이 아예 없었다.
 *
 * 지키는 것 — ①기록·조회가 왕복한다 ②없으면 null(=현재 세션 폴백, 조용히) ③상한이
 *  실제로 걸린다(무한 증가 금지) ④좌표가 다르면 안 섞인다(다른 대화방의 같은 id).
 *
 * ★상한은 직감이 아니라 실측이다: 이 인스턴스의 비서 발신은 하루 65건
 *  (`transcripts(role=assistant)`, 80일 창, 전 채널). 2,000행이면 한 달치를 훨씬 넘는다.
 */
import {
  recordOutboundMessage,
  findSessionForOutboundMessage,
  countOutboundMessageMappings,
  OUTBOUND_MESSAGE_MAP_MAX_ROWS,
} from "../../store/outbound-messages.js";
import { initStore } from "../../store/sessions.js";
import { assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";

const run = async (): Promise<Assertion[]> => {
  assertIsolated(); // 라이브 홈·DB 를 절대 안 만진다(러너가 임시 홈을 잡아준다).
  const out: Assertion[] = [];
  initStore();
  {

    // ── ① 기록 → 조회 왕복 ────────────────────────────────────────────────
    recordOutboundMessage("telegram", "chat-1", 1001, "dashboard:sessionA", 1);
    out.push({
      name: "기록한 메시지의 발원 세션을 되찾는다",
      ok: findSessionForOutboundMessage("telegram", "chat-1", 1001) === "dashboard:sessionA",
      got: `조회=${String(findSessionForOutboundMessage("telegram", "chat-1", 1001))} (기대 dashboard:sessionA)`,
    });

    // ── ② 없으면 null — 조용히 현재 세션으로 폴백하는 근거 ────────────────
    out.push({
      name: "모르는 메시지는 null(= 현재 세션 폴백, 에러 아님)",
      ok: findSessionForOutboundMessage("telegram", "chat-1", 999999) === null,
      got: `조회=${String(findSessionForOutboundMessage("telegram", "chat-1", 999999))} (기대 null)`,
    });

    // ── ③ 좌표가 다르면 안 섞인다 ─────────────────────────────────────────
    //  같은 message_id 라도 대화방이 다르면 남의 세션이다(텔레그램 id 는 chat 별 채번).
    recordOutboundMessage("telegram", "chat-2", 1001, "dashboard:sessionB", 2);
    out.push({
      name: "★다른 대화방의 같은 message_id 는 섞이지 않는다",
      ok:
        findSessionForOutboundMessage("telegram", "chat-1", 1001) === "dashboard:sessionA" &&
        findSessionForOutboundMessage("telegram", "chat-2", 1001) === "dashboard:sessionB",
      got: `chat-1=${String(findSessionForOutboundMessage("telegram", "chat-1", 1001))} chat-2=${String(findSessionForOutboundMessage("telegram", "chat-2", 1001))}`,
    });

    // ── ④ 같은 좌표·같은 id 재기록은 멱등(덮어쓰기) ───────────────────────
    recordOutboundMessage("telegram", "chat-1", 1001, "dashboard:sessionC", 3);
    out.push({
      name: "같은 메시지 재기록은 덮어쓴다(행 증식 없음)",
      ok: findSessionForOutboundMessage("telegram", "chat-1", 1001) === "dashboard:sessionC",
      got: `조회=${String(findSessionForOutboundMessage("telegram", "chat-1", 1001))} (기대 sessionC)`,
    });

    // ── ⑤ 상한 — 무한히 쌓이지 않는다 ─────────────────────────────────────
    //  상한 + 50 을 넣고 초과분이 실제로 잘리는지. 오래된 것부터 사라져야 한다.
    const over = OUTBOUND_MESSAGE_MAP_MAX_ROWS + 50;
    for (let i = 0; i < over; i++) {
      recordOutboundMessage("telegram", "chat-bulk", 5_000_000 + i, "s", 1000 + i);
    }
    const n = countOutboundMessageMappings();
    out.push({
      name: "★상한이 실제로 걸린다(무한 증가 금지)",
      ok: n <= OUTBOUND_MESSAGE_MAP_MAX_ROWS,
      got: `${over}건 기록 후 보관=${n}행 (상한 ${OUTBOUND_MESSAGE_MAP_MAX_ROWS})`,
    });
    out.push({
      name: "가장 최근 것은 상한 뒤에도 살아 있다",
      ok:
        findSessionForOutboundMessage("telegram", "chat-bulk", 5_000_000 + over - 1) === "s",
      got: `최신 조회=${String(findSessionForOutboundMessage("telegram", "chat-bulk", 5_000_000 + over - 1))} (기대 s)`,
    });
  }
  // ── ★egress 로 복사된 답에도 귀속이 실린다 (2026-08-11 실사고) ──────────
  //  사용자 신고: 대시보드 세션에서 나온 답이 텔레그램으로도 갔는데, 거기에 답장하니
  //  원래 세션이 아니라 **공통 세션**으로 들어갔다. 뿌리는 한 필드가 두 질문을 겸한 것 —
  //  `observeThreadKey` 는 *"어디에 표시할까"* 인데 답장 매핑은 *"누가 한 말인가"* 다.
  //  fan-out 은 표시 중복을 피하려 그 필드를 비웠고, 그 순간 **매핑까지 사라졌다.**
  //  그래서 `originThreadKey` 를 갈라놓았다. 여기선 그 분리를 **실행해서** 확인한다.
  {
    const { registerChannelOutbound } = await import("../../core/channel-outbound.js");
    const { deliverOutbound } = await import("../../core/outbound.js");
    registerChannelOutbound("regr-egress", {
      deliver: async () => ({ messageIds: [777_001] }),
      defaultOutboundTarget: async () => "chat-egress",
    });
    // 표시용 키는 **주지 않고** 귀속만 준다 = fan-out 이 하는 그대로.
    await deliverOutbound({
      channel: "regr-egress",
      target: "chat-egress",
      text: "egress 복사본",
      originThreadKey: "dashboard:origin-session",
    });
    out.push({
      name: "★표시 키 없이 귀속만 실어도 답장 매핑이 남는다(egress 경로)",
      ok:
        findSessionForOutboundMessage("regr-egress", "chat-egress", 777_001) ===
        "dashboard:origin-session",
      got: `조회=${String(findSessionForOutboundMessage("regr-egress", "chat-egress", 777_001))} (기대 dashboard:origin-session)`,
    });

    // 폴백 — 기존 호출부(observeThreadKey 만 주는 곳)는 그대로 동작해야 한다.
    await deliverOutbound({
      channel: "regr-egress",
      target: "chat-egress",
      text: "기존 경로",
      observeThreadKey: "dashboard:legacy",
    });
    out.push({
      name: "기존 호출부(표시 키만)는 그대로 귀속된다(회귀 0)",
      ok:
        findSessionForOutboundMessage("regr-egress", "chat-egress", 777_001) ===
        "dashboard:legacy",
      got: `조회=${String(findSessionForOutboundMessage("regr-egress", "chat-egress", 777_001))} (기대 dashboard:legacy)`,
    });
  }

  // ── 배선 — fan-out 이 실제로 그 값을 넘기는가 ────────────────────────────
  {
    const { sourceHas } = await import("./_wiring.js");
    const has = await sourceHas("../../index.ts", [
      /fanOutEgress = async \(\s*\n?\s*targets[\s\S]{0,220}?originThreadKey\?: string,/,
      /fanOutEgress\(egressTargets, replyText, bus, msg\.threadKey\)/,
    ]);
    out.push({
      name: "★egress fan-out 이 발원 세션을 싣는다(안 실으면 공통 세션으로 떨어진다)",
      ok: has.ok,
      got: has.ok ? "fan-out 배선 확인" : `누락: ${has.missing.join(" / ")}`,
    });
  }

  return out;
};

export const check: RegressionCheck = {
  name: "reply-routes-to-origin-session",
  guards:
    "답장이 발원 세션으로 못 가던 것(발신 message_id 를 버려 매핑 자체가 없었다 / egress 복사본은 표시 키를 안 실어 귀속까지 같이 사라졌다) + 매핑 테이블이 무한히 쌓이는 것 + 다른 대화방의 같은 message_id 가 섞이는 것",
  run,
};
