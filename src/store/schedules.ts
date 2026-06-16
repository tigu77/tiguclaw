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
}

const SELECT_COLS = `id, label, cron_expr, timezone, prompt,
       dest_channel, dest_target, enabled,
       created_at, updated_at,
       last_fired_at, last_status, last_error,
       trigger_type`;

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
});

export const addSchedule = (input: {
  label: string;
  cronExpr: string;
  timezone?: string;
  prompt: string;
  destChannel: string;
  destTarget?: string | null;
  triggerType?: TriggerType;
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
        last_fired_at, last_status, last_error, trigger_type)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, NULL, NULL, NULL, ?)`,
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
  return result.changes > 0;
};
