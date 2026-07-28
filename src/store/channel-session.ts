/**
 * 채널→세션 바인딩 저장소 (2026-07-28).
 *
 * 세션 셀렉터가 없는 채널(텔레그램·CLI)이 "이 대화방은 이 세션" 을 기억하게 한다.
 * ADR `2026-07-15-channel-session-decoupling.md` §D5 의 확장점 (b) 를 채우는 조각으로,
 * 아키텍처(세션 id 채널 무관·주소 캡처·세션별 직렬 큐)는 이미 이걸 지원한다.
 *
 * ★대시보드와의 차이: 대시보드 탭 상태는 브라우저 localStorage(그 브라우저에서만, 캐시
 *  지우면 소실). 이쪽은 **서버 DB** 라 재시작·기기교체와 무관하게 유지된다.
 *
 * 키 = (채널, 채널주소). 같은 사람이라도 DM 과 그룹은 다른 대화방이므로 각각 따로 묶인다
 * (사용자 확정 2026-07-28). 행이 없으면 바인딩 없음 = 기본 세션(기존 동작, 회귀 0).
 */
import { getDb } from "./sessions.js";

export interface ChannelSessionBinding {
  readonly channel: string;
  readonly channelAddress: string;
  readonly sessionId: string;
  readonly updatedAt: number;
}

const norm = (v: string): string => (typeof v === "string" ? v.trim() : "");

/**
 * 바인딩 조회 — 없으면 null.
 *
 * ★store 미초기화(검증 스크립트·부팅 전)에서는 **조용히 null** 이 아니라 던지게 두지
 *  않는다: 이 함수는 인입 경로(resolveSessionId)에서 불리므로 던지면 메시지가 통째로
 *  죽는다. 대신 null 을 돌려 기존 동작(기본 세션)으로 안전 degrade 하고, 호출부가
 *  그 사실을 로그로 남긴다(조용한 실패 금지 — 오늘 종일 고친 부류).
 */
export const getChannelSessionBinding = (
  channel: string,
  channelAddress: string,
): string | null => {
  const ch = norm(channel);
  const addr = norm(channelAddress);
  if (ch === "" || addr === "") return null;
  const row = getDb()
    .prepare(
      `SELECT session_id FROM channel_session_binding WHERE channel = ? AND channel_address = ?`,
    )
    .get(ch, addr) as { session_id?: string } | undefined;
  const sid = norm(row?.session_id ?? "");
  return sid === "" ? null : sid;
};

/** 바인딩 설정(멱등 upsert). */
export const setChannelSessionBinding = (
  channel: string,
  channelAddress: string,
  sessionId: string,
): void => {
  const ch = norm(channel);
  const addr = norm(channelAddress);
  const sid = norm(sessionId);
  if (ch === "" || addr === "" || sid === "") return;
  getDb()
    .prepare(
      `INSERT INTO channel_session_binding (channel, channel_address, session_id, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(channel, channel_address)
       DO UPDATE SET session_id = excluded.session_id, updated_at = excluded.updated_at`,
    )
    .run(ch, addr, sid, Date.now());
};

/** 바인딩 해제 — 이후 그 대화방은 기본 세션으로 돌아간다. */
export const clearChannelSessionBinding = (
  channel: string,
  channelAddress: string,
): void => {
  const ch = norm(channel);
  const addr = norm(channelAddress);
  if (ch === "" || addr === "") return;
  getDb()
    .prepare(
      `DELETE FROM channel_session_binding WHERE channel = ? AND channel_address = ?`,
    )
    .run(ch, addr);
};

/** 전체 바인딩(진단·관측용). */
export const listChannelSessionBindings = (): ChannelSessionBinding[] =>
  (
    getDb()
      .prepare(
        `SELECT channel, channel_address, session_id, updated_at
         FROM channel_session_binding ORDER BY updated_at DESC`,
      )
      .all() as Array<{
      channel: string;
      channel_address: string;
      session_id: string;
      updated_at: number;
    }>
  ).map((r) => ({
    channel: r.channel,
    channelAddress: r.channel_address,
    sessionId: r.session_id,
    updatedAt: r.updated_at,
  }));
