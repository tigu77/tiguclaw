import { getDb } from "./sessions.js";
import { SCHEDULE_RUN_LOG, deleteTriggerRuns, recordTriggerRun, triggerRunTimes } from "./trigger-runs.js";

/**
 * `cron`·`reboot` = 끝없는 반복(인벤토리에 남는 **스케줄**). `once` = 한 번 울리는 **타이머**(2026-10-20) — `runAt` 에 울리고 지워진다,
 *  건 대화의 백그라운드 패널에만 보인다. 간격 반복은 없다(반복 확인은 비서가 한 번 타이머를 다시 건다 — 설계 2026-10-20-schedule-timers-design §0).
 */
export type TriggerType = "cron" | "reboot" | "once";

/** 타이머(끝이 있는 것)인가 — 보이는 곳·지우는 시점을 이 한 줄로 가른다. */
export const isTimer = (r: { triggerType: TriggerType }): boolean => r.triggerType === "once";

export interface ScheduleRow {
  id: number;
  label: string;
  cronExpr: string;
  timezone: string;
  prompt: string;
  destChannel: string;
  destTarget: string | null;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  lastFiredAt: number | null;
  lastStatus: "ok" | "error" | null;
  lastError: string | null;
  triggerType: TriggerType;
  /** 이력 정책 — null = 계속(기본), 0 = 매번 새로 시작, N = 직전 N회만 유지. */
  keepRuns: number | null;
  /** `once` 가 울릴 시각(ms). 다른 종류는 null. */
  runAt: number | null;
  /** 처리되는 대화 — 만든 사람의 대화(서버가 적음). null = 전용 세션 `scheduler:<id>`(이 칸 전의 스케줄·사람 없는 자리에서 만든 것). */
  originThreadKey: string | null;
}

interface DbScheduleRow {
  id: number;
  label: string;
  cron_expr: string;
  timezone: string;
  prompt: string;
  dest_channel: string;
  dest_target: string | null;
  enabled: number;
  created_at: number;
  updated_at: number;
  last_fired_at: number | null;
  last_status: string | null;
  last_error: string | null;
  trigger_type: string;
  keep_runs: number | null;
  run_at: number | null;
  origin_thread_key: string | null;
}

const SELECT_COLS = `id, label, cron_expr, timezone, prompt,
       dest_channel, dest_target, enabled,
       created_at, updated_at,
       last_fired_at, last_status, last_error,
       trigger_type, keep_runs, run_at, origin_thread_key`;

const toRow = (r: DbScheduleRow): ScheduleRow => ({
  id: r.id,
  label: r.label,
  cronExpr: r.cron_expr,
  timezone: r.timezone,
  prompt: r.prompt,
  destChannel: r.dest_channel,
  destTarget: r.dest_target,
  enabled: r.enabled !== 0,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  lastFiredAt: r.last_fired_at,
  lastStatus:
    r.last_status === "ok" || r.last_status === "error" ? r.last_status : null,
  lastError: r.last_error,
  triggerType: r.trigger_type === "reboot" ? "reboot" : r.trigger_type === "once" ? "once" : "cron",
  keepRuns: typeof r.keep_runs === "number" && r.keep_runs >= 0 ? r.keep_runs : null,
  runAt: typeof r.run_at === "number" ? r.run_at : null,
  originThreadKey: typeof r.origin_thread_key === "string" && r.origin_thread_key !== "" ? r.origin_thread_key : null,
});

export const addSchedule = (input: {
  label: string;
  cronExpr: string;
  timezone?: string;
  prompt: string;
  destChannel: string;
  destTarget?: string | null;
  triggerType?: TriggerType;
  keepRuns?: number | null;
  runAt?: number | null;
  originThreadKey?: string | null;
}): ScheduleRow => {
  const handle = getDb();
  const now = Date.now();
  const timezone = input.timezone ?? "Asia/Seoul";
  const destTarget = input.destTarget ?? null;
  const triggerType = input.triggerType ?? "cron";
  const result = handle
    .prepare(
      `INSERT INTO schedules
       (label, cron_expr, timezone, prompt, dest_channel, dest_target,
        enabled, created_at, updated_at,
        last_fired_at, last_status, last_error, trigger_type, keep_runs, run_at, origin_thread_key)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?)`,
    )
    .run(
      input.label,
      input.cronExpr,
      timezone,
      input.prompt,
      input.destChannel,
      destTarget,
      now,
      now,
      triggerType,
      input.keepRuns ?? null,
      input.runAt ?? null,
      input.originThreadKey ?? null,
    );
  const id = Number(result.lastInsertRowid);
  const created = getSchedule(id);
  if (created === undefined) {
    throw new Error(`addSchedule: failed to read back inserted row id=${id}`);
  }
  return created;
};

export const listSchedules = (opts?: {
  onlyEnabled?: boolean;
  triggerType?: TriggerType;
}): ScheduleRow[] => {
  const handle = getDb();
  const wheres: string[] = [];
  const params: (string | number)[] = [];
  if (opts?.onlyEnabled === true) {
    wheres.push("enabled = 1");
  }
  if (opts?.triggerType !== undefined) {
    wheres.push("trigger_type = ?");
    params.push(opts.triggerType);
  }
  const whereSql = wheres.length > 0 ? ` WHERE ${wheres.join(" AND ")}` : "";
  const sql = `SELECT ${SELECT_COLS} FROM schedules${whereSql} ORDER BY id ASC`;
  const rows = handle.prepare(sql).all(...params) as DbScheduleRow[];
  return rows.map(toRow);
};

export const getSchedule = (id: number): ScheduleRow | undefined => {
  const handle = getDb();
  const row = handle
    .prepare(`SELECT ${SELECT_COLS} FROM schedules WHERE id = ?`)
    .get(id) as DbScheduleRow | undefined;
  if (row === undefined) return undefined;
  return toRow(row);
};

export const updateSchedule = (
  id: number,
  patch: Partial<{
    enabled: boolean;
    cronExpr: string;
    timezone: string;
    prompt: string;
    destChannel: string;
    destTarget: string | null;
    label: string;
    triggerType: TriggerType;
    keepRuns: number | null;
    runAt: number | null;
    originThreadKey: string | null;
  }>,
): ScheduleRow | undefined => {
  const existing = getSchedule(id);
  if (existing === undefined) return undefined;

  const sets: string[] = [];
  const vals: (string | number | null)[] = [];
  if (patch.label !== undefined) {
    sets.push("label = ?");
    vals.push(patch.label);
  }
  if (patch.cronExpr !== undefined) {
    sets.push("cron_expr = ?");
    vals.push(patch.cronExpr);
  }
  if (patch.timezone !== undefined) {
    sets.push("timezone = ?");
    vals.push(patch.timezone);
  }
  if (patch.prompt !== undefined) {
    sets.push("prompt = ?");
    vals.push(patch.prompt);
  }
  if (patch.destChannel !== undefined) {
    sets.push("dest_channel = ?");
    vals.push(patch.destChannel);
  }
  if (patch.destTarget !== undefined) {
    sets.push("dest_target = ?");
    vals.push(patch.destTarget);
  }
  if (patch.enabled !== undefined) {
    sets.push("enabled = ?");
    vals.push(patch.enabled ? 1 : 0);
  }
  if (patch.triggerType !== undefined) {
    sets.push("trigger_type = ?");
    vals.push(patch.triggerType);
  }
  if (patch.keepRuns !== undefined) {
    sets.push("keep_runs = ?");
    vals.push(patch.keepRuns);
  }
  if (patch.runAt !== undefined) {
    sets.push("run_at = ?");
    vals.push(patch.runAt);
  }
  if (patch.originThreadKey !== undefined) {
    sets.push("origin_thread_key = ?");
    vals.push(patch.originThreadKey);
  }
  if (sets.length === 0) return existing;

  sets.push("updated_at = ?");
  vals.push(Date.now());
  vals.push(id);

  const handle = getDb();
  handle
    .prepare(`UPDATE schedules SET ${sets.join(", ")} WHERE id = ?`)
    .run(...vals);
  return getSchedule(id);
};

export const recordFiring = (
  id: number,
  result: { ok: boolean; error?: string },
): void => {
  const handle = getDb();
  const now = Date.now();
  if (result.ok) {
    handle
      .prepare(
        `UPDATE schedules
         SET last_fired_at = ?, last_status = 'ok', last_error = NULL
         WHERE id = ?`,
      )
      .run(now, id);
  } else {
    handle
      .prepare(
        `UPDATE schedules
         SET last_fired_at = ?, last_status = 'error', last_error = ?
         WHERE id = ?`,
      )
      .run(now, result.error ?? "unknown", id);
  }
};

export const deleteSchedule = (id: number): boolean => {
  const handle = getDb();
  const result = handle.prepare(`DELETE FROM schedules WHERE id = ?`).run(id);
  deleteTriggerRuns(SCHEDULE_RUN_LOG, id); // 그 스케줄의 발화 기록도 같이 간다
  return result.changes > 0;
};

export { KEEP_RUNS_MAX } from "./trigger-runs.js";

/** 스케줄러가 살아 있던 마지막 시각 — 없으면 null(처음 켠 설치·업데이트 직후: 보충하지 않는다). */
export const schedulerLastAlive = (): number | null =>
  (getDb().prepare(`SELECT ts FROM scheduler_alive WHERE id = 1`).get() as { ts: number } | undefined)?.ts ?? null;

/** 살아 있음을 적는다 — 스케줄러가 주기적으로·멈출 때 부른다. */
export const markSchedulerAlive = (ts: number): void => {
  getDb().prepare(`INSERT INTO scheduler_alive (id, ts) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET ts = excluded.ts`).run(ts);
};

/** 발화 기록 한 줄 — 판정·바운드는 `trigger-runs.ts` 한 곳(감시와 같은 규칙). `ts` = 발화 시작 시각. */
export const recordScheduleRun = (scheduleId: number, ts: number): void => recordTriggerRun(SCHEDULE_RUN_LOG, scheduleId, ts);

/** 발화 시각 최신순(최대 `limit` 개). */
export const scheduleRunTimes = (scheduleId: number, limit: number): number[] => triggerRunTimes(SCHEDULE_RUN_LOG, scheduleId, limit);
