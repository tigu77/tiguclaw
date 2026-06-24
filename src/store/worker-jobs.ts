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

export interface PersistedWorkerJob {
  jobId: string;
  label: string;
  threadKey: string;
  channel: string;
  channelUserId: string;
  status: PersistedJobStatus;
  startedAt: number;
  finishedAt: number | null;
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
}): void => {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO worker_jobs
         (job_id, label, thread_key, channel, channel_user_id, status,
          started_at, finished_at, notify_channel, notify_target)
       VALUES (@jobId, @label, @threadKey, @channel, @channelUserId, @status,
          @startedAt, @finishedAt, @notifyChannel, @notifyTarget)`,
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
                started_at, finished_at, notify_channel, notify_target
           FROM worker_jobs WHERE status = 'running' ORDER BY started_at ASC`,
      )
      .all() as DbRow[]
  ).map(toJob);
