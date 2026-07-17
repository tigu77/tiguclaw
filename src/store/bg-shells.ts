/**
 * 백그라운드 셸 프로세스 영속 (reap 전용 메타) — Unit 1 Phase 1.
 *
 * 진실 소스: `docs/decisions/2026-07-17-background-shell-observability.md` §4.
 * 런타임 진실은 `core/llm-runtime/capabilities/file-ops-mcp.ts` 의 in-memory
 * `BG_SHELLS` Map(`store/worker-jobs.ts` 와 동형 패턴 — 이 테이블은 *재시작 생존*만
 * 담당한다). 부팅 reaper(`reapPreviousGeneration`, file-ops-mcp.ts)가 부팅 시
 * status='running' 으로 남은 행(=이전 세대 데몬이 돌리던 셸)을 PID 재사용 신원검증
 * (`startedLabel` — ps lstart+command 스냅샷) 후에만 킬한다. 출력·결과는 비영속
 * (순수 프로세스 위생 메타만, worker_jobs 의 "메타만"보다도 얇음 — 재개·통지 없음).
 *
 * codex/openai 전용 — claude 셸은 SDK 빌트인 Bash 가 자체 소유해 이 테이블 밖(ADR §6).
 */
import { getDb } from "./sessions.js";

export type BgShellStatus = "running" | "completed" | "killed" | "stale";

export interface BgShellRecord {
  bashId: string;
  pid: number;
  pgid: number;
  command: string;
  cwd: string;
  status: BgShellStatus;
  startedAt: number;
  finishedAt: number | null;
  exitCode: number | null;
  /** 부팅 reaper 신원검증용 스냅샷(ps lstart+command 또는 spawn 시각 폴백). 미보유=undefined. */
  startedLabel?: string;
}

interface DbRow {
  bash_id: string;
  pid: number;
  pgid: number;
  command: string;
  cwd: string;
  status: string;
  started_at: number;
  finished_at: number | null;
  exit_code: number | null;
  started_label: string | null;
}

const toRecord = (r: DbRow): BgShellRecord => ({
  bashId: r.bash_id,
  pid: r.pid,
  pgid: r.pgid,
  command: r.command,
  cwd: r.cwd,
  // 비정상값 방어(구 레코드·손상) — running 폴백(회귀 안전, worker_jobs toJob 동형).
  status:
    r.status === "completed" || r.status === "killed" || r.status === "stale"
      ? r.status
      : "running",
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  exitCode: r.exit_code,
  startedLabel: r.started_label ?? undefined,
});

/** launchBgShell 등록 시 INSERT(멱등 REPLACE) — status는 항상 'running'으로 시작. */
export const insertBgShell = (row: {
  bashId: string;
  pid: number;
  pgid: number;
  command: string;
  cwd: string;
  startedAt: number;
  startedLabel?: string;
}): void => {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO bg_shells
         (bash_id, pid, pgid, command, cwd, status, started_at, finished_at, exit_code, started_label)
       VALUES (@bashId, @pid, @pgid, @command, @cwd, 'running', @startedAt, NULL, NULL, @startedLabel)`,
    )
    .run({
      bashId: row.bashId,
      pid: row.pid,
      pgid: row.pgid,
      command: row.command,
      cwd: row.cwd,
      startedAt: row.startedAt,
      startedLabel: row.startedLabel ?? null,
    });
};

/**
 * started_label 사후 채움 — spawn 직후 ps 조회가 비동기라 INSERT 시점엔 아직 label 이
 * 없을 수 있다(레이스 회피: INSERT 는 spawn 과 같은 tick 에 동기 실행돼 close/error 보다
 * 항상 먼저 — 상태는 이 함수가 건드리지 않는다). status='running' 인 행에만 적용
 * (셸이 이미 종료돼 터미널 상태가 됐으면 label 은 더 이상 reaper 대상이 아니라 무의미).
 */
export const updateBgShellStartedLabel = (
  bashId: string,
  startedLabel: string,
): void => {
  getDb()
    .prepare(
      `UPDATE bg_shells SET started_label = ? WHERE bash_id = ? AND status = 'running'`,
    )
    .run(startedLabel, bashId);
};

/**
 * 상태 전이 — 셸 close/error(completed)·KillShell(killed)·killAllBgShells(killed)·
 * reapPreviousGeneration(killed|stale) 이 호출. 없는 bashId 는 no-op(멱등).
 */
export const markBgShellStatus = (
  bashId: string,
  status: Exclude<BgShellStatus, "running">,
  opts: { finishedAt: number; exitCode: number | null },
): void => {
  getDb()
    .prepare(
      `UPDATE bg_shells SET status = ?, finished_at = ?, exit_code = ? WHERE bash_id = ?`,
    )
    .run(status, opts.finishedAt, opts.exitCode, bashId);
};

/**
 * 부팅 reaper 대상 목록 — 아직 status='running' 인 행(= 이전 세대, 새로 부팅한 데몬엔
 * 도는 셸이 없으므로 전부 고아 후보). started_at 오름차순. `listInterruptedWorkerJobs` 동형.
 */
export const listRunningBgShells = (): BgShellRecord[] =>
  (
    getDb()
      .prepare(
        `SELECT bash_id, pid, pgid, command, cwd, status, started_at, finished_at, exit_code, started_label
           FROM bg_shells WHERE status = 'running' ORDER BY started_at ASC`,
      )
      .all() as DbRow[]
  ).map(toRecord);

/**
 * 터미널(비-running) 행 중 최신 keepLast 건만 남기고 삭제 — `pruneTerminalWorkerJobs` 동형,
 * 무한증가 방지. running 은 WHERE 가드로 캡·삭제 대상에서 애초에 제외(reaper 소스 보존).
 */
export const pruneTerminalBgShells = (keepLast: number): number =>
  getDb()
    .prepare(
      `DELETE FROM bg_shells
         WHERE status != 'running'
           AND bash_id NOT IN (
             SELECT bash_id FROM bg_shells
               WHERE status != 'running'
               ORDER BY COALESCE(finished_at, started_at) DESC
               LIMIT ?
           )`,
    )
    .run(keepLast).changes;
