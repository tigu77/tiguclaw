/**
 * 관측 이벤트 영속 — 감사·메트릭 기반.
 *
 * EventBus(비영속 ring buffer)와 별개로, *의미있는* 이벤트를 SQLite 에 영속한다.
 * 기록 정책(어떤 type 을 남길지·페이로드 캡)은 core/event-persist.ts 의 sink 가 결정 —
 * 본 모듈은 순수 저장/조회/prune CRUD.
 */
import { getDb } from "./sessions.js";

export interface PersistedEvent {
  id: number;
  ts: number;
  type: string;
  payload: string;
}

interface DbRow {
  id: number;
  ts: number;
  type: string;
  payload: string;
}

/** 이벤트 1건 기록. */
export const insertEvent = (
  ts: number,
  type: string,
  payload: string,
): void => {
  getDb()
    .prepare(`INSERT INTO events (ts, type, payload) VALUES (?, ?, ?)`)
    .run(ts, type, payload);
};

/** 최근 keepLast 건만 남기고 오래된 것 삭제 → 무한증가 방지. 삭제 행수 반환. */
export const pruneEvents = (keepLast: number): number =>
  getDb()
    .prepare(
      `DELETE FROM events
         WHERE id <= (SELECT MAX(id) FROM events) - ?`,
    )
    .run(keepLast).changes;

/** 감사·대시보드 조회 — 최신 먼저. type/sinceTs/limit 필터. */
export const listEvents = (opts?: {
  types?: string[];
  sinceTs?: number;
  limit?: number;
}): PersistedEvent[] => {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts?.types !== undefined && opts.types.length > 0) {
    where.push(`type IN (${opts.types.map(() => "?").join(",")})`);
    params.push(...opts.types);
  }
  if (opts?.sinceTs !== undefined) {
    where.push(`ts >= ?`);
    params.push(opts.sinceTs);
  }
  const limit = opts?.limit !== undefined && opts.limit > 0 ? opts.limit : 100;
  const sql =
    `SELECT id, ts, type, payload FROM events` +
    (where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ``) +
    ` ORDER BY id DESC LIMIT ?`;
  params.push(limit);
  return getDb().prepare(sql).all(...params) as DbRow[];
};

/**
 * 한 워커 thread(`worker:<jobId>`)의 *최신* llm.activity 1건 — list_workers 가
 * running 워커마다 "마지막: <도구> N분 전" 표시에 사용(stuck 신호 가시화).
 *
 * 어댑터가 흘린 활동 이벤트의 payload.threadKey 가 워커 thread 이고 payload.label 이
 * 도구명(kind="tool")/코어스 문구(kind="turn"). 활동이 없으면 null(워커가 아직 첫
 * 도구 전이거나 openai coarse floor 미발화 — 정직히 "활동 없음" 표시).
 */
export const getLastWorkerActivity = (
  threadKey: string,
): { label: string; ts: number } | null => {
  const row = getDb()
    .prepare(
      `SELECT ts, json_extract(payload, '$.label') AS label
         FROM events
        WHERE type = 'llm.activity'
          AND json_extract(payload, '$.threadKey') = ?
        ORDER BY id DESC
        LIMIT 1`,
    )
    .get(threadKey) as { ts: number; label: string | null } | undefined;
  if (row === undefined || row.label === null) return null;
  return { label: row.label, ts: row.ts };
};
