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
import { getDb, setThreadArchived } from "./sessions.js";

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

/**
 * **그 세션을 가리키는 모든 바인딩 해제** — 세션이 사라지거나(삭제) 목록에서 빠질 때
 * (보관) 남은 방들이 유령 세션에 계속 쌓는 것을 막는다.
 *
 * ★방 하나만 푸는 것으로는 부족하다 (2026-07-29 검토 실측): 보관 명령을 보낸 방만 풀면
 *  다른 방(다른 채널·다른 그룹)은 그대로 묶여 있고, 대시보드에서 보관하면 **아무 방도**
 *  안 풀린다(대시보드는 바인딩을 안 쓰므로 명령자의 방이 없다) — 그게 주 경로였다.
 * @returns 해제된 (채널, 주소) 수.
 */
export const clearBindingsForSession = (sessionId: string): number => {
  const sid = norm(sessionId);
  if (sid === "") return 0;
  return getDb()
    .prepare(`DELETE FROM channel_session_binding WHERE session_id = ?`)
    .run(sid).changes;
};

/**
 * 세션 보관/복원 — **보관은 곧 바인딩 해제다** (2026-08-19).
 *
 * ★같은 판단이 세 곳에 흩어져 있었다: `/sessions archive`(명령)·`archive_session`(도구)·
 *  `/session-archive`(엔드포인트, **대시보드 탭 닫기가 오는 주 경로**). 그리고 실제로
 *  갈려 있었다 — 명령만 바인딩을 풀고 엔드포인트는 안 풀었다. 그러면 텔레그램 방이
 *  **목록에 없는 세션**(보관돼서 `/sessions` 에도 안 뜬다)에 계속 묶인 채 쌓인다.
 *  ★2026-07-29 주석이 *"대시보드에서 보관하면(주 경로) 명령자의 방이 없어 아무것도 안
 *   풀렸다"* 라고 원인을 정확히 적어놓고도, 정작 그 주 경로엔 코드가 안 들어갔다.
 *
 * 그래서 셋이 **이 함수 하나**를 부른다 — 규칙을 지키라고 검사로 감시하는 대신 부를 것을
 * 하나로 만든다([[feedback_hand_maintained_lists]] 의 같은 뿌리: 열거 대신 정의점).
 *
 * ★삭제가 아니다: `threads.archived_at` 만 세우고 대화 레코드(`transcripts`·`chat_log`)는
 *  건드리지 않는다. 복원(`archived=false`)은 바인딩을 되돌리지 않는다 — 어느 방을 다시
 *  묶을지는 사람이 정할 일이다(추측해서 되묶으면 엉뚱한 방이 되살아난다).
 *
 * @returns `{ changed, unboundRooms }` — changed 0 이면 그런 세션이 없다.
 */
export const setSessionArchived = (
  threadKey: string,
  archived: boolean,
): { changed: number; unboundRooms: number } => {
  const changed = setThreadArchived(threadKey, archived ? Date.now() : null);
  if (changed === 0) return { changed: 0, unboundRooms: 0 };
  const unboundRooms = archived ? clearBindingsForSession(threadKey) : 0;
  return { changed, unboundRooms };
};
