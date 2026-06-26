/**
 * 대시보드 대화 이력 영속 (기능 B, 2026-06-25).
 *
 * 대시보드 채팅은 EventBus 인메모리 ring(최근 50)으로만 그려져 데몬 재시작 시 화면서
 * 사라진다. `transcripts` 는 raw 모델 I/O(사용자 턴에 system-reminder·SYSTEM.md 주입이
 * 섞임)라 그대로 못 쓴다 → 깨끗한 `channel.message.in/out` 텍스트만 담는 전용 작은
 * 테이블(`chat_log`)의 read/write 헬퍼. 메시지당 insert 1줄(비용 무시).
 *
 * 견고성 경계: recordChatMessage 는 *boundary*(턴/메시지 처리 핫패스에서 불림)라 내부
 * try/catch 로 감싸 로깅 실패가 호출자를 절대 못 깨게 한다(best-effort). getRecentChatLog
 * 는 읽기(렌더용)라 throw 가능 — 호출자(대시보드 핸들러)가 정상 경로에서 가린다.
 *
 * 기존 store 모듈(skill-usage.ts·worker-jobs.ts) 의 prepared statement·getDb 접근 동형.
 */
import { getDb } from "./sessions.js";

export type ChatRole = "user" | "assistant";

export interface ChatLogEntry {
  ts: number;
  threadKey: string;
  channel: string;
  role: ChatRole;
  text: string;
}

interface ChatLogRow {
  ts: number;
  thread_key: string;
  channel: string;
  role: string;
  text: string;
}

/**
 * 깨끗한 채팅 메시지 1줄 기록 — INSERT. 빈 text 는 스킵(무의미 로그 방지).
 *
 * boundary: 내부 try/catch 로 best-effort — DB write 실패(디스크 가득 등)가 호출자(턴/
 * 메시지 처리)를 절대 안 깨게 한다(1차 안전망, 데몬 생존 우선). 실패는 console.error 만.
 */
export const recordChatMessage = (row: ChatLogEntry): void => {
  if (row.text === "") return; // 빈 text 스킵.
  try {
    getDb()
      .prepare(
        `INSERT INTO chat_log (ts, thread_key, channel, role, text)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(row.ts, row.threadKey, row.channel, row.role, row.text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[chat-log] recordChatMessage failed (best-effort): ${msg}`);
  }
};

/**
 * 최근 채팅 메시지 — 시간 오름차순 반환(렌더용). limit 기본 200.
 *  - sinceTs: 그 시각 *이후*(>=)만 (라이브 갱신용).
 *  - beforeTs: 그 시각 *이전*(<)만 (스크롤 더보기 — 페이지네이션). 가장 최근 N 건을 잡아
 *    ASC 반환하므로, beforeTs=현재 로드된 최古 ts 로 호출하면 그 바로 앞 묶음이 온다.
 *
 * 내부 조회는 최신 N 건을 잡기 위해 ts DESC LIMIT 로 가져온 뒤 ASC 로 뒤집어 반환한다
 * (가장 최근 N 건을 시간순으로 — 오래된 쪽이 잘리고 최신이 남게). 읽기라 throw 가능.
 */
export const getRecentChatLog = (opts?: {
  limit?: number;
  sinceTs?: number;
  beforeTs?: number;
}): ChatLogEntry[] => {
  const limit = opts?.limit !== undefined && opts.limit > 0 ? opts.limit : 200;
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts?.sinceTs !== undefined) {
    where.push(`ts >= ?`);
    params.push(opts.sinceTs);
  }
  if (opts?.beforeTs !== undefined) {
    where.push(`ts < ?`);
    params.push(opts.beforeTs);
  }
  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : ``;
  const rows = getDb()
    .prepare(
      `SELECT ts, thread_key, channel, role, text
         FROM chat_log
         ${whereClause}
        ORDER BY ts DESC, id DESC
        LIMIT ?`,
    )
    .all(...params, limit) as ChatLogRow[];
  // ts DESC 로 최신 N 건을 잡고 ASC(오래된→최신)로 뒤집어 렌더 순서로 반환.
  return rows.reverse().map((r) => ({
    ts: r.ts,
    threadKey: r.thread_key,
    channel: r.channel,
    role: r.role === "assistant" ? "assistant" : "user",
    text: r.text,
  }));
};
