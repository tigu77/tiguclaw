/**
 * **트리거 발화 기록 — 한 곳** (2026-10-19). 이력 정책 «직전 N회» 의 경계 재료(발화 시작 시각)를 남기고 읽는다.
 *
 * ★표는 트리거마다 자기 것이다(`schedule_runs` · `watch_runs`) — 지울 때 같이 지워지고, 깨질 때 혼자 깨진다. 기록·바운드·조회
 *  판정만 여기 한 곳에 둔다(감시에 같은 정책을 붙이며 스케줄 쪽을 베낄 뻔했다 — 두 벌이면 한쪽만 늙는다).
 * 대화가 남은 발화만 적는다(실행기가 LLM 턴 성공 뒤에 부른다). 트리거마다 최근 `KEEP_RUNS_MAX` 개만 남긴다 — 핫 경로 바운드.
 */
import { getDb } from "./sessions.js";

/** 이력 정책 «직전 N회» 의 N 상한 — 도구 검증(`keep_runs`)과 발화 기록 보존 개수가 이 값 하나를 본다. */
export const KEEP_RUNS_MAX = 50;

/** 발화 기록 표 하나 — 이름은 고정 값만(SQL 에 그대로 들어간다). */
export interface TriggerRunLog {
  readonly table: "schedule_runs" | "watch_runs";
  readonly owner: "schedule_id" | "watch_id";
  readonly parent: "schedules" | "watches";
}
export const SCHEDULE_RUN_LOG: TriggerRunLog = { table: "schedule_runs", owner: "schedule_id", parent: "schedules" };
export const WATCH_RUN_LOG: TriggerRunLog = { table: "watch_runs", owner: "watch_id", parent: "watches" };

export const recordTriggerRun = (log: TriggerRunLog, id: number, ts: number): void => {
  const handle = getDb();
  handle.transaction(() => {
    // 발화 도중 트리거가 지워졌으면 적지 않는다 — 지운 뒤 들어간 행은 아무도 안 읽고 안 치운다(적대 검토 2026-09-28).
    handle.prepare(`INSERT INTO ${log.table} (${log.owner}, ts) SELECT ?, ? WHERE EXISTS (SELECT 1 FROM ${log.parent} WHERE id = ?)`).run(id, ts, id);
    handle.prepare(
      `DELETE FROM ${log.table} WHERE ${log.owner} = ? AND rowid NOT IN
         (SELECT rowid FROM ${log.table} WHERE ${log.owner} = ? ORDER BY ts DESC, rowid DESC LIMIT ?)`,
    ).run(id, id, KEEP_RUNS_MAX);
  })();
};

/** 발화 시각 최신순(최대 `limit` 개). */
export const triggerRunTimes = (log: TriggerRunLog, id: number, limit: number): number[] =>
  (getDb()
    .prepare(`SELECT ts FROM ${log.table} WHERE ${log.owner} = ? ORDER BY ts DESC, rowid DESC LIMIT ?`)
    .all(id, Math.max(0, limit)) as { ts: number }[]).map((r) => r.ts);

/** 그 트리거의 발화 기록을 지운다(트리거를 지울 때). */
export const deleteTriggerRuns = (log: TriggerRunLog, id: number): void => {
  getDb().prepare(`DELETE FROM ${log.table} WHERE ${log.owner} = ?`).run(id);
};
