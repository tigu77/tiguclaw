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

/**
 * persisted `llm.activity` 활동 묶음 조회 — self-growth 스킬화 제안(Phase 1)의
 * 세그먼트화 입력. `getLastWorkerActivity` 동형 SELECT(type='llm.activity' +
 * json_extract)지만 *복수* 행을 `(threadKey, ts, label, kind)` 로 끌어온다.
 *
 * 정렬은 `(threadKey, ts)` 오름차순 — 호출자(세그먼트화)가 thread 별 시간순
 * 윈도로 끊기 쉽게. `sinceTs` 로 스캔 윈도를 제한(배치마다 전체 10k 재집계 회피),
 * `limit` 으로 cap. label/kind 가 없는 행(코어 누락·구버전)은 자연 제외(WHERE).
 *
 * 주의: threadKey 필터(worker:/internal 제외)는 SQL 이 아니라 *호출자* 가 한다 —
 * 제외 규칙(메타재귀 §6)을 store SQL 에 하드코딩하지 않고 순수 함수에 둬 테스트·
 * 진화 용이하게(원칙 5).
 */
export const getRecentActivities = (opts?: {
  sinceTs?: number;
  limit?: number;
}): { threadKey: string; ts: number; label: string; kind: string }[] => {
  const where: string[] = [
    `type = 'llm.activity'`,
    `json_extract(payload, '$.threadKey') IS NOT NULL`,
    `json_extract(payload, '$.label') IS NOT NULL`,
  ];
  const params: unknown[] = [];
  if (opts?.sinceTs !== undefined) {
    where.push(`ts >= ?`);
    params.push(opts.sinceTs);
  }
  const limit = opts?.limit !== undefined && opts.limit > 0 ? opts.limit : 5000;
  const rows = getDb()
    .prepare(
      `SELECT
         json_extract(payload, '$.threadKey') AS threadKey,
         ts,
         json_extract(payload, '$.label') AS label,
         json_extract(payload, '$.kind')  AS kind
       FROM events
       WHERE ${where.join(" AND ")}
       ORDER BY threadKey ASC, ts ASC
       LIMIT ?`,
    )
    .all(...params, limit) as {
    threadKey: string | null;
    ts: number;
    label: string | null;
    kind: string | null;
  }[];
  return rows
    .filter(
      (r): r is { threadKey: string; ts: number; label: string; kind: string } =>
        typeof r.threadKey === "string" &&
        typeof r.label === "string" &&
        typeof r.kind === "string",
    )
    .map((r) => ({
      threadKey: r.threadKey,
      ts: r.ts,
      label: r.label,
      kind: r.kind,
    }));
};
