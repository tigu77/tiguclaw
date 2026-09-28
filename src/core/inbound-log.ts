/**
 * 들어온 메시지 한 줄 로그 (2026-09-28).
 *
 * ★왜: 회사돌쇠 로그에는 **나가는 전달(`route`)만** 있고 들어온 메시지 기록이 없었다. 그래서
 *  «답하는 중에 보낸 두 번째 메시지가 버려진다» 를 로그만으로는 확정할 수 없었다 — 언제 왔는지,
 *  진행 턴에 끼워졌는지(steer), 새 턴이 됐는지가 안 보였다([[feedback_logs_must_stand_alone]]).
 * ★본문은 싣지 않는다 — 길이·첨부 수만. 로그는 사용자에게서 받아 보는 파일이다.
 */

/** 들어온 메시지가 어디로 갔나 — `steer`=진행 턴에 끼움 · `queued`=앞 턴 뒤에 대기 · `new`=새 턴. */
export type InboundRoute = "steer" | "queued" | "new";

export const formatInboundLog = (m: {
  channel: string;
  threadKey: string;
  textLength: number;
  attachments: number;
  route: InboundRoute;
  /** 사용자가 보낸 게 아니라 데몬이 다시 태운 것(작업 완료 재주입·steer 잔여 재주입). */
  synthetic?: boolean;
}): string => {
  const where =
    m.route === "steer" ? "진행 턴에 끼움(steer)" : m.route === "queued" ? "앞 턴 뒤에 대기" : "새 턴";
  return `[inbound] channel=${m.channel} session=${m.threadKey} len=${m.textLength} att=${m.attachments}${m.synthetic === true ? " synthetic" : ""} → ${where}`;
};
