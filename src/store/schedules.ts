import { getDb } from "./sessions.js";

export type TriggerType = "cron" | "reboot";

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
}

const SELECT_COLS = `id, label, cron_expr, timezone, prompt,
       dest_channel, dest_target, enabled,
       created_at, updated_at,
       last_fired_at, last_status, last_error,
       trigger_type, keep_runs`;

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
  triggerType: r.trigger_type === "reboot" ? "reboot" : "cron",
  keepRuns: typeof r.keep_runs === "number" && r.keep_runs >= 0 ? r.keep_runs : null,
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
        last_fired_at, last_status, last_error, trigger_type, keep_runs)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, NULL, NULL, NULL, ?, ?)`,
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
  handle.prepare(`DELETE FROM schedule_runs WHERE schedule_id = ?`).run(id); // 그 스케줄의 발화 기록도 같이 간다
  return result.changes > 0;
};

/** 이력 정책 «직전 N회» 의 N 상한 — 도구 검증(`keep_runs`)과 발화 기록 보존 개수가 이 값 하나를 본다. */
export const KEEP_RUNS_MAX = 50;

/**
 * 발화 기록 한 줄 — **대화가 남은 발화만**(runner 가 LLM 턴 성공 뒤에 부른다). `ts` = 발화 시작 시각. 스케줄마다 최근
 * `KEEP_RUNS_MAX` 개만 남긴다.
 */
export const recordScheduleRun = (scheduleId: number, ts: number): void => {
  const handle = getDb();
  handle.transaction(() => {
    // 발화 도중 스케줄이 지워졌으면 적지 않는다 — 지운 뒤 들어간 행은 아무도 안 읽고 안 치운다(적대 검토 2026-09-28).
    handle.prepare(`INSERT INTO schedule_runs (schedule_id, ts) SELECT ?, ? WHERE EXISTS (SELECT 1 FROM schedules WHERE id = ?)`).run(scheduleId, ts, scheduleId);
    handle.prepare(
      `DELETE FROM schedule_runs WHERE schedule_id = ? AND rowid NOT IN
         (SELECT rowid FROM schedule_runs WHERE schedule_id = ? ORDER BY ts DESC, rowid DESC LIMIT ?)`,
    ).run(scheduleId, scheduleId, KEEP_RUNS_MAX);
  })();
};

/** 발화 시각 최신순(최대 `limit` 개). */
export const scheduleRunTimes = (scheduleId: number, limit: number): number[] =>
  (getDb()
    .prepare(`SELECT ts FROM schedule_runs WHERE schedule_id = ? ORDER BY ts DESC, rowid DESC LIMIT ?`)
    .all(scheduleId, Math.max(0, limit)) as { ts: number }[]).map((r) => r.ts);
