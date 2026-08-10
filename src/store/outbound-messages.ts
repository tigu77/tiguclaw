/**
 * 발신 메시지 → 발원 세션 매핑 (2026-08-10).
 *
 * 목적: **답장하면 그 답이 나온 세션으로 간다.** egress("이 답도 함께 보낼 채널")로 한
 *  텔레그램 대화에 여러 세션의 답이 섞여 오게 되면서 필요해졌다 — 어느 답에 대한
 *  얘기인지 가르는 자연스러운 UI 가 답장인데, 종전엔 `sendOutgoing` 이 `void` 라
 *  텔레그램이 준 `message_id` 를 그냥 버렸다. 그래서 "이 메시지가 어느 세션 것인지" 를
 *  알 방법이 아예 없었다.
 *
 * 행이 없으면 = 매핑 없음 = 현재 세션(기존 동작 그대로). 없는 게 정상인 경우가 많다
 *  (오래된 메시지, 매핑 이전에 보낸 것, 다른 경로 발신) — 그래서 조회 실패는 에러가 아니다.
 *
 * ★상한의 근거(직감 아님): 이 인스턴스의 비서 발신은 `transcripts(role=assistant)`
 *  실측으로 **하루 65건**(80일 창, 전 채널 합)이다. 한 답이 여러 청크로 쪼개져도
 *  2,000행이면 전 채널 발신을 다 담아 **한 달치를 훨씬 넘는다**. 답장은 대개 최근
 *  메시지에 하므로 그보다 오래된 매핑은 값이 거의 없다. 행도 작다(5개 컬럼).
 */
import { getDb } from "./sessions.js";

/** 보관 상한(행). 위 주석의 실측 근거 참조. */
export const OUTBOUND_MESSAGE_MAP_MAX_ROWS = 2_000;

const norm = (v: string): string => (typeof v === "string" ? v.trim() : "");

/**
 * 발신 메시지 하나를 세션에 묶는다. 같은 좌표·같은 id 면 덮어쓴다(멱등).
 *
 * 실패는 삼킨다 — 이건 편의 기능의 재료이지 배달의 일부가 아니다. 여기서 던지면
 * **이미 보낸** 메시지 때문에 턴이 실패한다(발송은 되돌릴 수 없다).
 */
export const recordOutboundMessage = (
  channel: string,
  channelAddress: string,
  messageId: string | number,
  sessionId: string,
  ts: number,
): void => {
  const ch = norm(channel);
  const addr = norm(channelAddress);
  const mid = norm(String(messageId));
  const sid = norm(sessionId);
  if (ch === "" || addr === "" || mid === "" || sid === "") return;
  try {
    const handle = getDb();
    handle
      .prepare(
        `INSERT INTO outbound_message_session
           (channel, channel_address, message_id, session_id, ts)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(channel, channel_address, message_id)
           DO UPDATE SET session_id = excluded.session_id, ts = excluded.ts`,
      )
      .run(ch, addr, mid, sid, ts);
    // 상한 유지 — 오래된 것부터 버린다(핫 워킹셋만 바운드, 비파괴 대상 아님:
    // 이건 편의 인덱스이지 보존해야 할 레코드가 아니다).
    handle
      .prepare(
        `DELETE FROM outbound_message_session
          WHERE rowid NOT IN (
            SELECT rowid FROM outbound_message_session ORDER BY ts DESC LIMIT ?
          )`,
      )
      .run(OUTBOUND_MESSAGE_MAP_MAX_ROWS);
  } catch {
    /* 매핑 실패가 배달을 무르지 않는다 — 답장 라우팅만 현재 세션으로 폴백된다. */
  }
};

/** 답장 대상 메시지의 발원 세션. 없으면 `null`(= 현재 세션 사용). */
export const findSessionForOutboundMessage = (
  channel: string,
  channelAddress: string,
  messageId: string | number,
): string | null => {
  const ch = norm(channel);
  const addr = norm(channelAddress);
  const mid = norm(String(messageId));
  if (ch === "" || addr === "" || mid === "") return null;
  try {
    const row = getDb()
      .prepare(
        `SELECT session_id FROM outbound_message_session
          WHERE channel = ? AND channel_address = ? AND message_id = ?`,
      )
      .get(ch, addr, mid) as { session_id: string } | undefined;
    return row === undefined ? null : row.session_id;
  } catch {
    return null; // store 미초기화·조회 실패 = 매핑 없음과 같게 취급(현재 세션).
  }
};

/** 검사·진단용 — 지금 보관 중인 매핑 수. */
export const countOutboundMessageMappings = (): number => {
  try {
    const row = getDb()
      .prepare(`SELECT COUNT(*) AS n FROM outbound_message_session`)
      .get() as { n: number } | undefined;
    return row?.n ?? 0;
  } catch {
    return 0;
  }
};
