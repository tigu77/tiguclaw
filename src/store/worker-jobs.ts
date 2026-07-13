/**
 * 백그라운드 워커 잡 영속 (메타만) — 재시작 정직 통지용.
 *
 * 런타임 진실 소스는 `core/worker-jobs.ts` 의 in-memory Map. 이 모듈은 그 메타를
 * SQLite 에 미러해 *데몬 재시작 생존*만 담당한다. 부팅 시 status='running' 으로 남아있는
 * 잡 = 그 잡을 돌던 프로세스가 죽은 것(새 부팅엔 실제 도는 잡이 없음) → "중단됨" 통지.
 *
 * option (b): 메타 영속 + 정직 통지. result/error 본문·풀 재개는 비범위(W-I7 정직 답습).
 */
import { getDb } from "./sessions.js";

export type PersistedJobStatus =
  | "running"
  | "done"
  | "failed"
  | "cancelled"
  | "interrupted";

/**
 * 워커 완료/실패 통지 목적지 — generic 좌표(어느 플러그인이 채웠는지 store 무관).
 * core/worker-jobs.ts 의 `WorkerNotifyDest` 와 동형(코어 export 확정 전까지 구조적 호환
 * 로컬 정의). store 는 이 형 ↔ notify_channel/notify_target 2 컬럼 변환만 담당하며
 * scheduler·채널 의미를 해석하지 않는다(단방향: store 는 generic channel/target 만 봄).
 */
export interface WorkerNotifyDest {
  channel: string;
  target: string | null;
}

/** 잡 종류 — 'worker'(detached) | 'agent'(awaited 서브에이전트). ADR subagent-worker-unify. */
export type PersistedJobKind = "worker" | "agent";

export interface PersistedWorkerJob {
  jobId: string;
  label: string;
  threadKey: string;
  channel: string;
  channelUserId: string;
  status: PersistedJobStatus;
  startedAt: number;
  finishedAt: number | null;
  /** 잡 종류. 기존 레코드(컬럼 DEFAULT 'worker')는 항상 'worker'. */
  kind: PersistedJobKind;
  /** 서브에이전트 정의 이름(kind==='agent' 만). 대시보드 라벨용. */
  agentName?: string;
  /**
   * 영속된 통지 목적지. notify_channel 이 있으면 {channel, target} 로 복원,
   * 미지정(NULL)이면 undefined → core 가 job.channel/threadKey 폴백(회귀 0).
   */
  notifyDest?: WorkerNotifyDest;
}

interface DbRow {
  job_id: string;
  label: string;
  thread_key: string;
  channel: string;
  channel_user_id: string;
  status: string;
  started_at: number;
  finished_at: number | null;
  notify_channel: string | null;
  notify_target: string | null;
  kind: string | null;
  agent_name: string | null;
}

const toJob = (r: DbRow): PersistedWorkerJob => ({
  jobId: r.job_id,
  label: r.label,
  threadKey: r.thread_key,
  channel: r.channel,
  channelUserId: r.channel_user_id,
  status:
    r.status === "done" ||
    r.status === "failed" ||
    r.status === "cancelled" ||
    r.status === "interrupted"
      ? r.status
      : "running",
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  // kind 미존재(구 레코드)·비정상값이면 'worker'(회귀 안전).
  kind: r.kind === "agent" ? "agent" : "worker",
  agentName: r.agent_name ?? undefined,
  // 채널이 영속돼 있을 때만 dest 복원(미지정 = 기존 워커 → undefined → core 폴백).
  notifyDest:
    r.notify_channel !== null
      ? { channel: r.notify_channel, target: r.notify_target }
      : undefined,
});

/** 잡 등록/갱신 — registerJob 시 INSERT (멱등 REPLACE). */
export const upsertWorkerJob = (job: {
  jobId: string;
  label: string;
  threadKey: string;
  channel: string;
  channelUserId: string;
  status: PersistedJobStatus;
  startedAt: number;
  finishedAt?: number | null;
  notifyDest?: WorkerNotifyDest;
  /** 잡 종류(미지정=worker, 회귀 안전). */
  kind?: PersistedJobKind;
  agentName?: string;
}): void => {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO worker_jobs
         (job_id, label, thread_key, channel, channel_user_id, status,
          started_at, finished_at, notify_channel, notify_target, kind, agent_name)
       VALUES (@jobId, @label, @threadKey, @channel, @channelUserId, @status,
          @startedAt, @finishedAt, @notifyChannel, @notifyTarget, @kind, @agentName)`,
    )
    .run({
      jobId: job.jobId,
      label: job.label,
      threadKey: job.threadKey,
      channel: job.channel,
      channelUserId: job.channelUserId,
      status: job.status,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt ?? null,
      notifyChannel: job.notifyDest?.channel ?? null,
      notifyTarget: job.notifyDest?.target ?? null,
      kind: job.kind ?? "worker",
      agentName: job.agentName ?? null,
    });
};

/** 상태 전이 — markDone/markFailed 시 UPDATE. 없는 jobId 는 no-op. */
export const updateWorkerJobStatus = (
  jobId: string,
  status: PersistedJobStatus,
  finishedAt: number,
): void => {
  getDb()
    .prepare(
      `UPDATE worker_jobs SET status = ?, finished_at = ? WHERE job_id = ?`,
    )
    .run(status, finishedAt, jobId);
};

/** 부팅 복구 — 아직 'running' 인 잡(= 재시작으로 중단). startedAt 오름차순. */
export const listInterruptedWorkerJobs = (): PersistedWorkerJob[] =>
  (
    getDb()
      .prepare(
        `SELECT job_id, label, thread_key, channel, channel_user_id, status,
                started_at, finished_at, notify_channel, notify_target, kind, agent_name
           FROM worker_jobs WHERE status = 'running' ORDER BY started_at ASC`,
      )
      .all() as DbRow[]
  ).map(toJob);

/**
 * 터미널(비-'running') 잡 중 최신 keepLast 건만 남기고 나머지 삭제 → 무한증가 방지.
 * `events.ts pruneEvents` 동형(관측 파생 메타 캡). ★running 은 `WHERE status != 'running'`
 * 가드로 캡·삭제 대상에서 애초에 제외 — 재시작 복구 소스(listInterruptedWorkerJobs) 보존,
 * 절대 안 지운다. "최신"은 `finished_at`(완료 시각) 우선, 미종료 레코드 방어로 `started_at`
 * 폴백(COALESCE) — 정상 흐름에선 터미널 행 전부 finished_at 존재.
 *
 * job_id 가 시퀀셜 아닌 UUID 라 events 의 `id <= MAX(id)-keep` 패턴을 못 쓴다 — 대신
 * "유지할 최신 keepLast 건의 id 집합"을 서브쿼리로 뽑아 그 밖을 삭제(NOT IN). 삭제 행수 반환.
 */
export const pruneTerminalWorkerJobs = (keepLast: number): number =>
  getDb()
    .prepare(
      `DELETE FROM worker_jobs
         WHERE status != 'running'
           AND job_id NOT IN (
             SELECT job_id FROM worker_jobs
               WHERE status != 'running'
               ORDER BY COALESCE(finished_at, started_at) DESC
               LIMIT ?
           )`,
    )
    .run(keepLast).changes;

/** 관측용 — 전체/터미널(비-running) 잡 건수. maintenance_status 가 캡 대비 표시에 사용. */
export const countWorkerJobs = (): { total: number; terminal: number } => {
  const db = getDb();
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM worker_jobs`).get() as {
    n: number;
  }).n;
  const terminal = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM worker_jobs WHERE status != 'running'`)
      .get() as { n: number }
  ).n;
  return { total, terminal };
};
