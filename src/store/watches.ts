import { getDb } from "./sessions.js";
import { WATCH_RUN_LOG, deleteTriggerRuns, recordTriggerRun, triggerRunTimes } from "./trigger-runs.js";

export interface WatchRow {
  id: number;
  label: string;
  path: string;
  pattern: string | null;
  recursive: boolean;
  debounceMs: number;
  eventFilter: string;
  prompt: string;
  destChannel: string;
  destTarget: string | null;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  lastFiredAt: number | null;
  lastPath: string | null;
  lastEvent: string | null;
  lastStatus: "ok" | "error" | null;
  lastError: string | null;
  /** 이력 정책 — null = 이전 실행 대화를 계속 이어감(기본), 0 = 매번 새로, N = 직전 N회만. 스케줄 `keep_runs` 와 같은 뜻·같은 판정(`applyRunHistory`). */
  keepRuns: number | null;
}

interface DbWatchRow {
  id: number;
  label: string;
  path: string;
  pattern: string | null;
  recursive: number;
  debounce_ms: number;
  event_filter: string;
  prompt: string;
  dest_channel: string;
  dest_target: string | null;
  enabled: number;
  created_at: number;
  updated_at: number;
  last_fired_at: number | null;
  last_path: string | null;
  last_event: string | null;
  last_status: string | null;
  last_error: string | null;
  keep_runs: number | null;
}

const SELECT_COLS = `id, label, path, pattern, recursive, debounce_ms,
       event_filter, prompt, dest_channel, dest_target, enabled,
       created_at, updated_at,
       last_fired_at, last_path, last_event, last_status, last_error, keep_runs`;

const toRow = (r: DbWatchRow): WatchRow => ({
  id: r.id,
  label: r.label,
  path: r.path,
  pattern: r.pattern,
  recursive: r.recursive !== 0,
  debounceMs: r.debounce_ms,
  eventFilter: r.event_filter,
  prompt: r.prompt,
  destChannel: r.dest_channel,
  destTarget: r.dest_target,
  enabled: r.enabled !== 0,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  lastFiredAt: r.last_fired_at,
  lastPath: r.last_path,
  lastEvent: r.last_event,
  lastStatus:
    r.last_status === "ok" || r.last_status === "error" ? r.last_status : null,
  lastError: r.last_error,
  keepRuns: typeof r.keep_runs === "number" && r.keep_runs >= 0 ? r.keep_runs : null,
});

export const addWatch = (input: {
  label: string;
  path: string;
  pattern?: string | null;
  recursive?: boolean;
  debounceMs?: number;
  eventFilter?: string;
  prompt: string;
  destChannel: string;
  destTarget?: string | null;
  keepRuns?: number | null;
}): WatchRow => {
  const handle = getDb();
  const now = Date.now();
  const pattern = input.pattern ?? null;
  const recursive = input.recursive === false ? 0 : 1;
  const debounceMs = input.debounceMs ?? 500;
  const eventFilter = input.eventFilter ?? "all";
  const destTarget = input.destTarget ?? null;
  const result = handle
    .prepare(
      `INSERT INTO watches
       (label, path, pattern, recursive, debounce_ms, event_filter,
        prompt, dest_channel, dest_target,
        enabled, created_at, updated_at,
        last_fired_at, last_path, last_event, last_status, last_error, keep_runs)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL, NULL, NULL, NULL, NULL, ?)`,
    )
    .run(
      input.label,
      input.path,
      pattern,
      recursive,
      debounceMs,
      eventFilter,
      input.prompt,
      input.destChannel,
      destTarget,
      now,
      now,
      input.keepRuns ?? null,
    );
  const id = Number(result.lastInsertRowid);
  const created = getWatch(id);
  if (created === undefined) {
    throw new Error(`addWatch: failed to read back inserted row id=${id}`);
  }
  return created;
};

export const listWatches = (opts?: {
  onlyEnabled?: boolean;
  eventFilter?: string;
}): WatchRow[] => {
  const handle = getDb();
  const wheres: string[] = [];
  const params: (string | number)[] = [];
  if (opts?.onlyEnabled === true) {
    wheres.push("enabled = 1");
  }
  if (opts?.eventFilter !== undefined) {
    wheres.push("event_filter = ?");
    params.push(opts.eventFilter);
  }
  const whereSql = wheres.length > 0 ? ` WHERE ${wheres.join(" AND ")}` : "";
  const sql = `SELECT ${SELECT_COLS} FROM watches${whereSql} ORDER BY id ASC`;
  const rows = handle.prepare(sql).all(...params) as DbWatchRow[];
  return rows.map(toRow);
};

export const getWatch = (id: number): WatchRow | undefined => {
  const handle = getDb();
  const row = handle
    .prepare(`SELECT ${SELECT_COLS} FROM watches WHERE id = ?`)
    .get(id) as DbWatchRow | undefined;
  if (row === undefined) return undefined;
  return toRow(row);
};

export const updateWatch = (
  id: number,
  patch: Partial<{
    label: string;
    path: string;
    pattern: string | null;
    recursive: boolean;
    debounceMs: number;
    eventFilter: string;
    prompt: string;
    destChannel: string;
    destTarget: string | null;
    enabled: boolean;
    keepRuns: number | null;
  }>,
): WatchRow | undefined => {
  const existing = getWatch(id);
  if (existing === undefined) return undefined;

  const sets: string[] = [];
  const vals: (string | number | null)[] = [];
  if (patch.label !== undefined) {
    sets.push("label = ?");
    vals.push(patch.label);
  }
  if (patch.path !== undefined) {
    sets.push("path = ?");
    vals.push(patch.path);
  }
  if (patch.pattern !== undefined) {
    sets.push("pattern = ?");
    vals.push(patch.pattern);
  }
  if (patch.recursive !== undefined) {
    sets.push("recursive = ?");
    vals.push(patch.recursive ? 1 : 0);
  }
  if (patch.debounceMs !== undefined) {
    sets.push("debounce_ms = ?");
    vals.push(patch.debounceMs);
  }
  if (patch.eventFilter !== undefined) {
    sets.push("event_filter = ?");
    vals.push(patch.eventFilter);
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
    .prepare(`UPDATE watches SET ${sets.join(", ")} WHERE id = ?`)
    .run(...vals);
  return getWatch(id);
};

export const recordFiring = (
  id: number,
  result: { ok: boolean; path?: string; event?: string; error?: string },
): void => {
  const handle = getDb();
  const now = Date.now();
  const pathVal = result.path ?? null;
  const eventVal = result.event ?? null;
  if (result.ok) {
    handle
      .prepare(
        `UPDATE watches
         SET last_fired_at = ?, last_path = ?, last_event = ?,
             last_status = 'ok', last_error = NULL
         WHERE id = ?`,
      )
      .run(now, pathVal, eventVal, id);
  } else {
    handle
      .prepare(
        `UPDATE watches
         SET last_fired_at = ?, last_path = ?, last_event = ?,
             last_status = 'error', last_error = ?
         WHERE id = ?`,
      )
      .run(now, pathVal, eventVal, result.error ?? "unknown", id);
  }
};

export const deleteWatch = (id: number): boolean => {
  const handle = getDb();
  const result = handle.prepare(`DELETE FROM watches WHERE id = ?`).run(id);
  deleteTriggerRuns(WATCH_RUN_LOG, id); // 그 감시의 발화 기록도 같이 간다
  return result.changes > 0;
};

/** 발화 기록 한 줄 — 판정·바운드는 `trigger-runs.ts` 한 곳(스케줄과 같은 규칙). `ts` = 발화 시작 시각(스레드 줄 안). */
export const recordWatchRun = (watchId: number, ts: number): void => recordTriggerRun(WATCH_RUN_LOG, watchId, ts);

/** 발화 시각 최신순(최대 `limit` 개). */
export const watchRunTimes = (watchId: number, limit: number): number[] => triggerRunTimes(WATCH_RUN_LOG, watchId, limit);
