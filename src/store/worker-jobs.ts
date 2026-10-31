/**
 * 백그라운드 매니저 잡 영속 (메타만) — 재시작 정직 통지용.
 *
 * 런타임 진실 소스는 `core/worker-jobs.ts` 의 in-memory Map. 이 모듈은 그 메타를
 * SQLite 에 미러해 *데몬 재시작 생존*만 담당한다. 부팅 시 status='running' 으로 남아있는
 * 잡 = 그 잡을 돌던 프로세스가 죽은 것(새 부팅엔 실제 도는 잡이 없음) → "중단됨" 통지.
 *
 * option (b): 메타 영속 + 정직 통지. 풀 재개는 비범위(W-I7 정직 답습).
 * ★2026-10-31 완료 보고 복구 — 원결과·원오류(필드당 상한)와 사용자 통지 **전달 상태**도 같은 행에 둔다: 재시작 뒤에도 정식 조회로
 *  읽히고, 미전달 통지를 다음 사람 메시지 때 회수한다(설계 docs/decisions/2026-10-31-completion-report-recovery-design.md).
 */
import { getDb } from "./sessions.js";

export type PersistedJobStatus =
  | "running"
  | "done"
  | "failed"
  | "cancelled"
  | "interrupted";

/**
 * 매니저 완료/실패 통지 목적지 — generic 좌표(어느 플러그인이 채웠는지 store 무관).
 * core/worker-jobs.ts 의 `WorkerNotifyDest` 와 동형(코어 export 확정 전까지 구조적 호환
 * 로컬 정의). store 는 이 형 ↔ notify_channel/notify_target 2 컬럼 변환만 담당하며
 * scheduler·채널 의미를 해석하지 않는다(단방향: store 는 generic channel/target 만 봄).
 */
export interface WorkerNotifyDest {
  channel: string;
  target: string | null;
}

/**
 * 잡 종류 — **표시 축**이다(에이전트냐 매니저냐). ★2026-08-19 이전엔 실행 축(기다리나)도
 * 겸했는데, `spawn_agent(wait:false)` 가 그 조합을 깼다(agent 인데 detached).
 * 기다렸는지는 `detached` 가 진다.
 */
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
   * **실행 축** — 소환자가 기다리지 않는 잡인가(매니저 전부 + `spawn_agent(wait:false)`).
   * 재시작 복구가 "통지할 소환자가 있나" 를 이걸로 가른다: awaited 서브는 부모 턴이
   * 같이 사라져 통지 대상이 없지만, detached 는 소환자가 살아 있어 **말해줘야 한다**.
   */
  detached: boolean;
  /**
   * 영속된 통지 목적지. notify_channel 이 있으면 {channel, target} 로 복원,
   * 미지정(NULL)이면 undefined → core 가 job.channel/threadKey 폴백(회귀 0).
   */
  notifyDest?: WorkerNotifyDest;
  // ── 완료 보고 복구(2026-10-31 §4-2) — 고른 열에만 있다(목록 조회는 본문을 안 싣는다). 구버전 행은 NULL → undefined.
  /** 원결과(저장 상한 이하 전문 · 넘으면 앞부분). */
  resultText?: string;
  /** 원결과 **전체** 길이(JS length). `resultText.length` 가 더 작으면 저장 상한으로 앞부분만 보존. */
  resultChars?: number;
  errorText?: string;
  errorChars?: number;
  errorName?: string;
  /** 통지 전달 상태(설계 §5-1) — 정본은 이 열 하나. */
  noticeState?: NoticeState;
  /** 자동 회수 대상 사람 대화 키 — 사람 소유가 아니면 없음. */
  noticeSession?: string;
  noticeAttempts?: number;
  noticeAt?: number;
}

/** 통지 전달 상태(설계 §5-1). NULL(=undefined) = 해당 없음 또는 기록 이전 판. */
export type NoticeState = "sending" | "delivered" | "undelivered" | "recovering" | "gave_up";

const NOTICE_STATES: readonly string[] = ["sending", "delivered", "undelivered", "recovering", "gave_up"];

/**
 * 원결과·원오류의 **필드당 저장 상한**(JS 코드 단위). 넘으면 앞부분만 저장하고 `*_chars` 에 전체 길이를 남긴다 — 조용한 자름이 아니다.
 * 근거(설계 §4-2): claude 턴 표본 최대 19,892자의 약 13배 · 사용자 미확정 권고값(§10 U3).
 */
export const STORED_BODY_CAP = 256_000;

/**
 * 저장할 앞부분 — 상한 이하면 그대로. ★자르는 자리가 서로게이트 쌍 가운데면 **한 단위 앞에서** 자른다(홑 서로게이트를 저장하지 않는다).
 * 순수 함수 — 검사가 경계를 직접 잰다.
 */
export const capStoredText = (text: string, cap: number = STORED_BODY_CAP): string => {
  if (text.length <= cap) return text;
  const last = text.charCodeAt(cap - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? cap - 1 : cap);
};

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
  detached: number | null;
  // 고른 열에만 있다(없으면 undefined).
  result_text?: string | null;
  result_chars?: number | null;
  error_text?: string | null;
  error_chars?: number | null;
  error_name?: string | null;
  notice_state?: string | null;
  notice_session?: string | null;
  notice_attempts?: number | null;
  notice_at?: number | null;
}

/** NULL·없음 → undefined(구버전 행·고르지 않은 열이 같은 뜻). */
const opt = <T>(v: T | null | undefined): T | undefined => (v === null ? undefined : v);

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
  // 구 레코드(컬럼 부재/NULL)는 0 → awaited. 매니저는 등록 시 항상 1을 쓴다.
  detached: r.detached === 1,
  // 채널이 영속돼 있을 때만 dest 복원(미지정 = 기존 매니저 → undefined → core 폴백).
  notifyDest:
    r.notify_channel !== null
      ? { channel: r.notify_channel, target: r.notify_target }
      : undefined,
  resultText: opt(r.result_text),
  resultChars: opt(r.result_chars),
  errorText: opt(r.error_text),
  errorChars: opt(r.error_chars),
  errorName: opt(r.error_name),
  noticeState: r.notice_state != null && NOTICE_STATES.includes(r.notice_state) ? (r.notice_state as NoticeState) : undefined,
  noticeSession: opt(r.notice_session),
  noticeAttempts: opt(r.notice_attempts),
  noticeAt: opt(r.notice_at),
});

/** 행 메타 열(본문 제외) — 목록 조회가 쓴다. 본문이 필요한 조회는 `FULL_COLS`. */
const META_COLS = `job_id, label, thread_key, channel, channel_user_id, status, started_at, finished_at,
  notify_channel, notify_target, kind, agent_name, detached,
  result_chars, error_chars, error_name, notice_state, notice_session, notice_attempts, notice_at`;
const FULL_COLS = `${META_COLS}, result_text, error_text`;

/**
 * 잡 등록/갱신 — registerJob 시 INSERT (멱등 REPLACE).
 * ★**종료 기록에 쓰지 마라** (2026-10-31). `INSERT OR REPLACE` 는 행을 지우고 다시 넣어 여기 없는 열(원결과·원오류·전달 상태)을
 *  NULL 로 날린다. 종료는 `finishWorkerJob`, 전달 상태는 `notice*` 함수(전부 UPDATE)가 쓴다.
 */
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
  /** 소환자가 안 기다리는 잡인가. 미지정=false(회귀 안전 — 기존 호출부는 전부 awaited 의미). */
  detached?: boolean;
}): void => {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO worker_jobs
         (job_id, label, thread_key, channel, channel_user_id, status,
          started_at, finished_at, notify_channel, notify_target, kind, agent_name, detached)
       VALUES (@jobId, @label, @threadKey, @channel, @channelUserId, @status,
          @startedAt, @finishedAt, @notifyChannel, @notifyTarget, @kind, @agentName, @detached)`,
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
      detached: job.detached === true ? 1 : 0,
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

/**
 * 종료 기록 — 상태·끝 시각·원결과·원오류를 **한 UPDATE** 로(상태만 있고 본문이 없는 창이 없다 · 설계 §4-2).
 * 본문은 필드당 `STORED_BODY_CAP` 까지 — 넘으면 앞부분 + `*_chars` 에 전체 길이, `onCapped` 로 알린다(본문 없이). 없는 jobId 는 no-op.
 * ★주어진 칸만 쓰지 않는다 — 안 준 본문은 NULL 로 둔다(이 행의 종료 기록은 한 번이다).
 */
export const finishWorkerJob = (
  jobId: string,
  status: "done" | "failed",
  finishedAt: number,
  body: { resultText?: string; errorText?: string; errorName?: string },
  onCapped?: (field: "result" | "error", kept: number, total: number) => void,
): number => {
  const result = body.resultText === undefined ? null : capStoredText(body.resultText);
  const error = body.errorText === undefined ? null : capStoredText(body.errorText);
  if (result !== null && body.resultText !== undefined && result.length < body.resultText.length) onCapped?.("result", result.length, body.resultText.length);
  if (error !== null && body.errorText !== undefined && error.length < body.errorText.length) onCapped?.("error", error.length, body.errorText.length);
  return getDb()
    .prepare(
      `UPDATE worker_jobs SET status = ?, finished_at = ?, result_text = ?, result_chars = ?, error_text = ?, error_chars = ?, error_name = ?
        WHERE job_id = ?`,
    )
    .run(
      status,
      finishedAt,
      result,
      body.resultText === undefined ? null : body.resultText.length,
      error,
      body.errorText === undefined ? null : body.errorText.length,
      body.errorName ?? null,
      jobId,
    ).changes;
};

/** 한 행 전부(본문 포함) — 재시작 뒤 단건 조회(`getJobForRead`)·대시보드 단건. */
export const getWorkerJobRow = (jobId: string): PersistedWorkerJob | undefined => {
  const r = getDb().prepare(`SELECT ${FULL_COLS} FROM worker_jobs WHERE job_id = ?`).get(jobId) as DbRow | undefined;
  return r === undefined ? undefined : toJob(r);
};

/** 이 좌표가 **직접** 띄운 종료 행(본문 제외) — 재시작 뒤 목록 조회가 메모리 목록과 합친다. */
export const listTerminalWorkerJobsByThread = (threadKey: string): PersistedWorkerJob[] =>
  (
    getDb()
      .prepare(`SELECT ${META_COLS} FROM worker_jobs WHERE thread_key = ? AND status != 'running'`)
      .all(threadKey) as DbRow[]
  ).map(toJob);

/** 여러 잡의 전달 상태 한 번에(메모리 잡 목록에 붙인다 — 목록 한 쪽 최대 100건). */
export const getWorkerJobNotices = (jobIds: readonly string[]): Map<string, PersistedWorkerJob> => {
  const out = new Map<string, PersistedWorkerJob>();
  if (jobIds.length === 0) return out;
  const rows = getDb()
    .prepare(`SELECT ${META_COLS} FROM worker_jobs WHERE job_id IN (${jobIds.map(() => "?").join(",")})`)
    .all(...jobIds) as DbRow[];
  for (const r of rows) out.set(r.job_id, toJob(r));
  return out;
};

// ─── 통지 전달 상태 전이 (설계 §5-2 · §5-6) ─────────────────────────────────────
// ★전이는 언제나 **기대 상태를 조건으로** 건다 — 바뀐 행이 0이면(정리로 지워졌거나 상태가 이미 다르면) 던지지도, 다시 넣지도 않는다.
//  판정(누가·언제)은 `core/job-report-delivery.ts` 가 하고, 여기는 SQL 만 한다.

/** NULL → sending(사용자 대상 종료 통지를 보내기 직전). `session` = 자동 회수 대상 사람 대화(아니면 null). */
export const noticeBeginSending = (jobId: string, session: string | null, now: number): number =>
  getDb()
    .prepare(
      `UPDATE worker_jobs SET notice_state = 'sending', notice_session = ?, notice_at = ? WHERE job_id = ? AND notice_state IS NULL`,
    )
    .run(session, now, jobId).changes;

/** 재시작 중단 — `running` → `interrupted` 와 NULL → `sending` 을 **한 UPDATE** 로(중단 통지 직전). */
export const markInterruptedSending = (jobId: string, now: number, session: string | null): number =>
  getDb()
    .prepare(
      `UPDATE worker_jobs SET status = 'interrupted', finished_at = ?, notice_state = 'sending', notice_session = ?, notice_at = ?
        WHERE job_id = ? AND status = 'running'`,
    )
    .run(now, session, now, jobId).changes;

/** 첫 통지 결과 — sending → delivered | undelivered. */
export const noticeSettleSending = (jobId: string, delivered: boolean, now: number): number =>
  getDb()
    .prepare(`UPDATE worker_jobs SET notice_state = ?, notice_at = ? WHERE job_id = ? AND notice_state = 'sending'`)
    .run(delivered ? "delivered" : "undelivered", now, jobId).changes;

/** 재전달 결과 — recovering → delivered | (시도 < max → undelivered | gave_up). 바뀐 뒤 상태를 돌려준다(0행이면 undefined). */
export const noticeSettleRecovering = (jobId: string, delivered: boolean, maxAttempts: number, now: number): NoticeState | undefined => {
  const db = getDb();
  const changed = db
    .prepare(
      `UPDATE worker_jobs SET notice_state = CASE WHEN ? = 1 THEN 'delivered' WHEN notice_attempts >= ? THEN 'gave_up' ELSE 'undelivered' END,
              notice_at = ?
        WHERE job_id = ? AND notice_state = 'recovering'`,
    )
    .run(delivered ? 1 : 0, maxAttempts, now, jobId).changes;
  if (changed === 0) return undefined;
  const r = db.prepare(`SELECT notice_state FROM worker_jobs WHERE job_id = ?`).get(jobId) as { notice_state: string } | undefined;
  return r === undefined ? undefined : (r.notice_state as NoticeState);
};

/**
 * 부팅 잔여 정리(설계 §5-3) — 이전 프로세스가 남긴 `sending` → `undelivered`, `recovering` → 시도 수에 따라 `undelivered`/`gave_up`.
 * ★채널 시작 **전**에만 부른다 — 그 시점의 두 상태는 전부 이전 프로세스 것이다.
 */
export const reconcileNoticesAtBoot = (maxAttempts: number, now: number): { sending: number; recovering: number } => {
  const db = getDb();
  return db.transaction(() => ({
    sending: db.prepare(`UPDATE worker_jobs SET notice_state = 'undelivered', notice_at = ? WHERE notice_state = 'sending'`).run(now).changes,
    recovering: db
      .prepare(
        `UPDATE worker_jobs SET notice_state = CASE WHEN notice_attempts >= ? THEN 'gave_up' ELSE 'undelivered' END, notice_at = ?
          WHERE notice_state = 'recovering'`,
      )
      .run(maxAttempts, now).changes,
  }))();
};

/**
 * **원자 선점**(설계 §5-4) — 한 동기 트랜잭션 안에서 «이 세션의 미전달 행(오래 끝난 순)» 을 읽고, `pick` 이 고른 행만
 *  `recovering`·시도 +1 로 바꿔 **발송·렌더에 필요한 열 전부**(본문 포함)를 돌려준다. SQL 은 후보 축소(세션·상태)만 —
 *  나머지 판정(시도 상한·생존·사람 소유·건수)은 `pick` 이 한다(조건을 두 자리에 두지 않는다).
 * better-sqlite3 는 동기라 고르기와 바꾸기 사이에 다른 메시지가 끼지 못한다.
 */
export const claimUndeliveredNotices = (
  session: string,
  pick: (candidates: readonly PersistedWorkerJob[]) => readonly PersistedWorkerJob[],
  now: number,
): PersistedWorkerJob[] => {
  const db = getDb();
  return db.transaction(() => {
    const candidates = (
      db
        .prepare(
          `SELECT ${FULL_COLS} FROM worker_jobs WHERE notice_state = 'undelivered' AND notice_session = ?
            ORDER BY COALESCE(finished_at, started_at) ASC, job_id ASC`,
        )
        .all(session) as DbRow[]
    ).map(toJob);
    const claimed: PersistedWorkerJob[] = [];
    const upd = db.prepare(
      `UPDATE worker_jobs SET notice_state = 'recovering', notice_attempts = notice_attempts + 1, notice_at = ?
        WHERE job_id = ? AND notice_state = 'undelivered'`,
    );
    for (const row of pick(candidates)) {
      if (upd.run(now, row.jobId).changes === 1) {
        claimed.push({ ...row, noticeState: "recovering", noticeAttempts: (row.noticeAttempts ?? 0) + 1, noticeAt: now });
      }
    }
    return claimed;
  })();
};

/** 부팅 복구 — 아직 'running' 인 잡(= 재시작으로 중단). startedAt 오름차순. */
export const listInterruptedWorkerJobs = (): PersistedWorkerJob[] =>
  (
    getDb()
      .prepare(
        // ★`detached` 를 반드시 싣는다 (2026-08-19 적대 검토 F1). 빠지면 toJob 이
        //  `undefined === 1` → **항상 false** 로 읽어, 재시작 복구의 `!job.detached`
        //  게이트가 모든 잡에 참이 된다 → **매니저 중단 통지까지 죽는다**(원래 돌던 기능).
        //  컬럼을 추가하면서 이 SELECT 를 안 고친 전형적인 "열거를 손으로 관리하는" 사고다.
        `SELECT job_id, label, thread_key, channel, channel_user_id, status,
                started_at, finished_at, notify_channel, notify_target, kind, agent_name,
                detached
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
  pruneTerminalWorkerJobsCounted(keepLast).deleted;

/**
 * 위와 **같은 삭제**(대상 정의 그대로) + 지운 행 중 **전달 확인이 안 된 것**의 상태별 건수(2026-10-31 §4-2) — 조용히 사라지지 않게
 *  호출부가 로그에 남긴다. 미전달 행을 상한에서 빼지 않는다(보관 상한은 하나 — 설계 §8-6).
 */
export const pruneTerminalWorkerJobsCounted = (
  keepLast: number,
): { deleted: number; unconfirmed: Partial<Record<"undelivered" | "sending" | "recovering" | "gave_up", number>> } => {
  const rows = getDb()
    .prepare(
      `DELETE FROM worker_jobs
         WHERE status != 'running'
           AND job_id NOT IN (
             SELECT job_id FROM worker_jobs
               WHERE status != 'running'
               ORDER BY COALESCE(finished_at, started_at) DESC
               LIMIT ?
           )
         RETURNING notice_state`,
    )
    .all(keepLast) as Array<{ notice_state: string | null }>;
  const unconfirmed: Partial<Record<"undelivered" | "sending" | "recovering" | "gave_up", number>> = {};
  for (const r of rows) {
    const s = r.notice_state;
    if (s === "undelivered" || s === "sending" || s === "recovering" || s === "gave_up") unconfirmed[s] = (unconfirmed[s] ?? 0) + 1;
  }
  return { deleted: rows.length, unconfirmed };
};

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
