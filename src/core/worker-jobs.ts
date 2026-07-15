/**
 * 백그라운드 워커 — daemon 인프라 (잡 레지스트리 + 완료 재주입 + thread 직렬 큐 +
 * reply 클로저 재획득 + 워커 전용 타임아웃 주입).
 *
 * 진실 소스: architect contract `_workspace/background-worker_architect.md`
 * (불변식 W-I1~W-I8, 구현 contract §9-b). 본 모듈은 daemon 인프라 파트 —
 * region-engineer 의 worker-registry.ts(발사 도구 + runWorkerJob 실행 본체)가
 * 호출할 *깨끗한 API* 를 제공한다. 워커 실행 본체(runRegionA)는 region 경계.
 *
 * 경계 (W-I4 코어 불변):
 *  - daemon (본 모듈): registerJob / markDone / markFailed / listJobs (레지스트리),
 *    onWorkerComplete (완료→메인 재주입 훅), thread 직렬 큐, reply 재획득,
 *    워커 전용 abortSignal 발급(createWorkerAbort).
 *  - region (worker-registry.ts): spawn_worker 도구 + runWorkerJob(job, deps) 가
 *    runRegionA 를 `worker:<jobId>` thread 에서 fire-and-forget 실행 후, 완료/실패를
 *    daemon 이 주입한 `deps.onComplete(jobId, ...)` = onWorkerComplete 로 콜백.
 *
 * MVP = 메모리 레지스트리(영속 0, W-I7 재시작 정직). scheduler `inFlight` Set 동형.
 */
import { randomUUID } from "node:crypto";
import { extractTelegramChatId } from "./threadkey.js";
import type { ChannelName, MessageHandler } from "../channels/types.js";
import {
  upsertWorkerJob,
  updateWorkerJobStatus,
  listInterruptedWorkerJobs,
  pruneTerminalWorkerJobs,
} from "../store/worker-jobs.js";
import { getEventBus } from "./eventbus.js";

// Step 1 (2026-06-30) — 워커 lifecycle 을 EventBus 에 발행한다. 워커 활동(llm.activity,
// threadKey=worker:<jobId>)은 이미 버스에 흐르지만 "잡 시작/완료/실패" 상태 전이는 그동안
// worker_jobs SQLite 에만 있어 대시보드가 라이브로 못 받았다 → 백그라운드 작업 뷰의 토대.
// best-effort: 관측 발행 실패가 워커 흐름을 무르지 않는다(원칙 3 견고성). 단방향: core
// worker → core bus(플러그인 무참조). 대시보드 등 구독자가 worker.* 를 받아 렌더.
const publishWorkerLifecycle = (
  type: "worker.started" | "worker.done" | "worker.failed" | "worker.cancelled",
  job: {
    jobId: string;
    label: string;
    threadKey: string;
    status: string;
    kind?: WorkerJobKind;
    agentName?: string;
    modelTier?: string;
    cwd?: string;
  },
  extra?: { error?: string; task?: string; result?: string },
): void => {
  try {
    getEventBus().publish({
      type,
      ts: Date.now(),
      payload: {
        jobId: job.jobId,
        label: job.label,
        threadKey: job.threadKey, // 어느 대화가 띄운 잡인지 상관(correlate)용.
        status: job.status,
        // kind='agent' 면 대시보드가 서브에이전트 카드로 렌더(agentName 라벨). 미지정=worker.
        kind: job.kind ?? "worker",
        ...(job.agentName !== undefined ? { agentName: job.agentName } : {}),
        ...(job.modelTier !== undefined && job.modelTier !== "" ? { modelTier: job.modelTier } : {}),
        // 실행 cwd — 대시보드가 프로젝트별 라이브 카드 필터에 사용(관측용). ADR §6 G2.
        ...(job.cwd !== undefined && job.cwd !== "" ? { cwd: job.cwd } : {}),
        // task(무슨 작업이었나) + result(결과)도 실어 카드가 도구 스텝 없어도 내용을
        // 보여주게 한다. 길이 컷(이벤트/버퍼 바운드 — 전체 result 는 채널 재주입이 보유).
        ...(extra?.error !== undefined ? { error: extra.error.slice(0, 300) } : {}),
        ...(extra?.task !== undefined ? { task: extra.task.slice(0, 500) } : {}),
        ...(extra?.result !== undefined ? { result: extra.result.slice(0, 1200) } : {}),
      },
    });
  } catch {
    /* noop — 관측 발행 실패가 워커를 무르지 않는다. */
  }
};

// DB 미러는 best-effort — 영속 실패가 워커 진행/완료를 막지 않게 격리(데몬 생존, 원칙 3).
// 런타임 진실 소스는 아래 in-memory Map. DB 는 재시작 생존(정직 통지)만 담당.
const persistSafe = (label: string, fn: () => void): void => {
  try {
    fn();
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.error(`worker-jobs: DB 미러 실패(${label}): ${reason}`);
  }
};

// ─── 터미널 잡 캡 (2026-07-12, P1 runtime-maintenance) ───────────────────────
// worker_jobs DB 미러가 무바운드로 계속 쌓이는 유일한 파생 store 였다(architect contract
// §1). `events.ts RETENTION_KEEP` 동형이나 events(고volume, 10k) 보다 훨씬 저volume
// (잡은 spawn_worker/서브에이전트 호출당 1건) 이라 "넉넉히" 훨씬 큰 값을 잡아 관측이력
// 손실을 최소화한다. running 은 이 캡과 무관하게 절대 보존(store 쿼리 자체가 가드).
// export: core/maintenance.ts(runMaintenanceScan) 가 store health 판정(count vs bound)에
// 재사용 — 값 중복 정의 금지(RETENTION_KEEP export 와 동형 패턴).
export const TERMINAL_WORKER_JOB_KEEP = 1000;

/** 터미널 전이(done/failed/cancelled/interrupted) 마다 호출 — best-effort(persistSafe 동형). */
const pruneTerminalJobsSafe = (): void => {
  persistSafe("pruneTerminalWorkerJobs", () =>
    pruneTerminalWorkerJobs(TERMINAL_WORKER_JOB_KEEP),
  );
};

// ─── 통지 목적지 (generic 좌표 — architect §3-a) ─────────────────────────────
/**
 * 워커 완료/실패 통지를 보낼 *목적지* — generic 좌표(어느 플러그인이 채웠는지 코어 무관).
 * 미지정 시 onWorkerComplete 가 job.channel/threadKey 로 폴백(텔레그램 직접 발화 워커 회귀 0).
 *  - channel: 통지 채널명(예 "telegram"). reacquireReply 가 이 값으로 dispatch.
 *  - target : 채널 내 목적지(telegram=chatId, cli=무시). 채널 의미는 reacquireReply 가 해석.
 *
 * ★단방향 불변식: 이 타입은 "telegram" 같은 *채널명* 만 담는다. 코어는 어느 플러그인
 * (scheduler 등)이 이 dest 를 채웠는지 영원히 모른다 — 오직 generic {channel,target} 데이터.
 */
export interface WorkerNotifyDest {
  channel: ChannelName;
  target: string | null;
}

// ─── 잡 레코드 (architect §6) ────────────────────────────────────────────────

export type WorkerJobStatus = "running" | "done" | "failed" | "cancelled";

/**
 * 잡 종류 — 'worker'(detached, run_in_background) | 'agent'(awaited 서브에이전트).
 * ADR 2026-07-03 subagent-worker-unify. awaited 는 별 필드 아닌 kind==='agent' 파생.
 * 배타 불변식(U-I1~U-I5): 재주입·워커타임아웃·cancel_worker·재시작 복구 통지는 'worker'만.
 */
export type WorkerJobKind = "worker" | "agent";

export interface WorkerJobRecord {
  jobId: string;
  /** 잡 종류 — 관측은 공용, 실행 의미(재주입·타임아웃 등)는 kind 로 분기. */
  kind: WorkerJobKind;
  /** 서브에이전트 정의 이름(kind==='agent' 만) — 대시보드 라벨. */
  agentName?: string;
  /** 서브에이전트 모델 티어(high/mid/low/nano 또는 provider:model). 관측용(대시보드·/agents). */
  modelTier?: string;
  /** 사람이 읽는 짧은 이름 (완료 보고·상태 조회·로그). */
  label: string;
  /** 워커가 수행한 자연어 작업 지시 (메인이 작성). */
  task: string;
  /** 완료 재주입이 합류할 *원* thread (메인 인격·history 연속, W-I1). 예 "tg:123". */
  threadKey: string;
  /** 완료 재주입 채널 (reply 재획득용). 예 "telegram". */
  channel: ChannelName;
  /** 원 잡 발사 사용자 (재주입 합성 메시지의 channelUserId). */
  channelUserId: string;
  /**
   * 완료/실패 통지를 보낼 generic 목적지 (additive). 채운 주체(예 스케줄)가 dest 를 데이터로
   * 주입 → onWorkerComplete 가 이걸로 dispatch. 미지정이면 channel/threadKey 폴백(회귀 0).
   */
  notifyDest?: WorkerNotifyDest;
  /**
   * 이 잡이 실행된 작업 폴더(cwd) — spawn_agent(path=X) 로 폴더 스코프 위임 시 그 폴더.
   * 대시보드가 **프로젝트별 실행/최근 서브에이전트 귀속**에 사용(관측용, in-memory only —
   * awaited 서브는 재시작 비생존이라 DB 영속 불필요, U-I5). 미지정=부모 cwd 상속(무귀속).
   * ADR 2026-07-06 §6 G2(잡 귀속 키=실행 cwd).
   */
  cwd?: string;
  status: WorkerJobStatus;
  startedAt: number;
  finishedAt?: number;
  /** status==="done" 시 워커 출력 (재주입 전 — 채널 직행 절대 X, W-I1). */
  result?: string;
  /** status==="failed" 시 redact 된 원인 문자열. */
  error?: string;
}

/** 모듈 전역 레지스트리 — singleton 데몬 (scheduler inFlight 동형). */
const jobs = new Map<string, WorkerJobRecord>();

export interface RegisterJobInput {
  label: string;
  task: string;
  threadKey: string;
  channel: ChannelName;
  channelUserId: string;
  /** 완료/실패 통지 generic 목적지 (additive). 미지정 = channel/threadKey 폴백. */
  notifyDest?: WorkerNotifyDest;
  /** 잡 종류 — 미지정=worker(회귀 안전). 'agent'=awaited 서브에이전트. */
  kind?: WorkerJobKind;
  /** 서브에이전트 이름(kind==='agent' 만) — 대시보드 라벨. */
  agentName?: string;
  /** 서브에이전트 모델 티어(관측용). */
  modelTier?: string;
  /** 실행 cwd(관측용) — spawn_agent(path=X) 가 프로젝트 귀속 위해 전달. 미지정=무귀속. */
  cwd?: string;
}

/**
 * 잡 등록 → jobId 반환. spawn_worker(kind:worker) / 서브에이전트 관측(kind:agent) 이 사용.
 * status="running" / startedAt=now 로 시작.
 */
export const registerJob = (input: RegisterJobInput): string => {
  const jobId = randomUUID();
  const startedAt = Date.now();
  const kind: WorkerJobKind = input.kind ?? "worker";
  jobs.set(jobId, {
    jobId,
    kind,
    agentName: input.agentName,
    modelTier: input.modelTier,
    cwd: input.cwd,
    label: input.label,
    task: input.task,
    threadKey: input.threadKey,
    channel: input.channel,
    channelUserId: input.channelUserId,
    notifyDest: input.notifyDest,
    status: "running",
    startedAt,
  });
  persistSafe("registerJob", () =>
    upsertWorkerJob({
      jobId,
      label: input.label,
      threadKey: input.threadKey,
      channel: input.channel,
      channelUserId: input.channelUserId,
      notifyDest: input.notifyDest,
      status: "running",
      startedAt,
      kind,
      agentName: input.agentName,
    }),
  );
  publishWorkerLifecycle(
    "worker.started",
    {
      jobId,
      label: input.label,
      threadKey: input.threadKey,
      status: "running",
      kind,
      agentName: input.agentName,
      modelTier: input.modelTier,
      cwd: input.cwd,
    },
    { task: input.task },
  );
  return jobId;
};

/** 워커 성공 — 결과 기록. 재주입(채널 보고)은 onWorkerComplete 가 별도 수행. */
export const markDone = (jobId: string, result: string): void => {
  const job = jobs.get(jobId);
  if (job === undefined) return;
  job.status = "done";
  job.result = result;
  job.finishedAt = Date.now();
  persistSafe("markDone", () =>
    updateWorkerJobStatus(jobId, "done", job.finishedAt!),
  );
  pruneTerminalJobsSafe(); // 터미널 전이 — worker_jobs 캡(P1, running 은 위 UPDATE 대상 아님).
  publishWorkerLifecycle("worker.done", job, { task: job.task, result });
};

/** 워커 실패/타임아웃 — 원인 기록. */
export const markFailed = (jobId: string, error: string): void => {
  const job = jobs.get(jobId);
  if (job === undefined) return;
  job.status = "failed";
  job.error = error;
  job.finishedAt = Date.now();
  persistSafe("markFailed", () =>
    updateWorkerJobStatus(jobId, "failed", job.finishedAt!),
  );
  pruneTerminalJobsSafe(); // 터미널 전이 — worker_jobs 캡(P1).
  publishWorkerLifecycle("worker.failed", job, { error, task: job.task });
};

/**
 * 워커 취소 마킹 — 사용자 명시 취소(타임아웃과 구분, 별도 status). worker_jobs DB
 * status 는 TEXT 라 자유. 통지 문구는 onWorkerComplete 가 status 로 분기.
 */
export const markCancelled = (jobId: string, reason: string): void => {
  const job = jobs.get(jobId);
  if (job === undefined) return;
  job.status = "cancelled";
  job.error = reason;
  job.finishedAt = Date.now();
  persistSafe("markCancelled", () =>
    updateWorkerJobStatus(jobId, "cancelled", job.finishedAt!),
  );
  pruneTerminalJobsSafe(); // 터미널 전이 — worker_jobs 캡(P1).
  publishWorkerLifecycle("worker.cancelled", job, { error: reason, task: job.task });
};

export const getJob = (jobId: string): WorkerJobRecord | undefined =>
  jobs.get(jobId);

export interface ListJobsOpts {
  /** 진행 중만 (status==="running"). 미지정 = 전체. */
  runningOnly?: boolean;
  /** 최근 N개 (startedAt 내림차순). 미지정 = 전체. */
  limit?: number;
}

/**
 * 잡 목록 — list_workers 도구(region)가 사용. startedAt 내림차순(최신 먼저).
 * 레코드 복사본 반환(외부 변조 방지, 레지스트리 단일 진실).
 */
export const listJobs = (opts?: ListJobsOpts): WorkerJobRecord[] => {
  let all = [...jobs.values()];
  if (opts?.runningOnly === true) {
    all = all.filter((j) => j.status === "running");
  }
  all.sort((a, b) => b.startedAt - a.startedAt);
  if (opts?.limit !== undefined && opts.limit > 0) {
    all = all.slice(0, opts.limit);
  }
  return all.map((j) => ({ ...j }));
};

/** 테스트 전용 — 레지스트리 비움 (프로덕션 경로 미사용). */
export const __resetJobsForTest = (): void => {
  jobs.clear();
  cancelHooks.clear();
  pendingTurnIds.clear();
};

// ─── 워커 전용 타임아웃 (architect §5, W-I6) ─────────────────────────────────
// 워커는 2층 턴 타임아웃(480s) *제외* — 길게 도는 게 정상. 대신 워커 전용 상한을
// 기존 abortSignal 메커니즘(turn-timeout.ts 동형)으로 주입. 1층 idle/first 는 전 턴
// 면제(idleConfigExempt, 어댑터 wrap — 2026-06-24)라 워커도 당연히 면제다. 긴 배치의
// 무이벤트 구간이 정상이라 idle 오살이 없다. 워커의 hung 방어는 이 워커 전용 상한이 담당.
// 값은 상수+env override (매직넘버 금지, turn-timeout.ts 정책 답습).

const parsePosIntEnv = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

/** 기본 워커 상한 (ms) — 30분. 2층 turn(8분)보다 훨씬 김(워커는 오래 도는 게 정상). */
const DEFAULT_WORKER_TIMEOUT_MS = 30 * 60_000;

/** 워커 1잡 전체 wall-clock 상한 (ms). env `WORKER_TIMEOUT_MS` override. */
export const WORKER_TIMEOUT_MS = parsePosIntEnv(
  process.env.WORKER_TIMEOUT_MS,
  DEFAULT_WORKER_TIMEOUT_MS,
);

/** 하드 백스톱 grace (ms) — index.ts TURN_HARD_GRACE_MS 동형. 기본 60s. */
const DEFAULT_WORKER_HARD_GRACE_MS = 60_000;

/**
 * 워커 하드 백스톱 grace (ms). createWorkerAbort 의 abort 가 hung MCP callTool 을
 * 못 끊는 경우(MCP 한계), abort 시점(WORKER_TIMEOUT_MS) 이후 이만큼 더 기다려도
 * runRegionA 가 안 settle 하면 runner 가 WorkerTimeoutError 로 *강제* 종료해 통지를
 * 정시 발화시킨다. env `WORKER_HARD_GRACE_MS` override (매직넘버 금지, 채널 백스톱 동형).
 */
export const WORKER_HARD_GRACE_MS = parsePosIntEnv(
  process.env.WORKER_HARD_GRACE_MS,
  DEFAULT_WORKER_HARD_GRACE_MS,
);

/**
 * 워커 상한 타임아웃 에러.
 *
 * TurnTimeoutError 와 동형 — message 에 "모델 거부 아님" 토큰을 박아 facade
 * `MODEL_REJECTED_PATTERNS` 비매칭 보장 (멀쩡한 모델이 깨진 것으로 오제거되는 것 방지).
 */
export class WorkerTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(timeoutMs: number = WORKER_TIMEOUT_MS) {
    super(
      `워커 처리 시간 초과 (${timeoutMs}ms wall-clock 상한) — 모델 거부 아님`,
    );
    this.name = "WorkerTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/**
 * 워커 사용자 취소 에러 — 타임아웃과 *구분*(통지 문구 "취소됨" vs "시간 초과").
 * abort reason 으로 운반되거나 cancelJob 이 직접 마킹. WorkerTimeoutError 처럼
 * "모델 거부 아님" 토큰을 박아 facade MODEL_REJECTED_PATTERNS 오매칭을 막는다.
 */
export class WorkerCancelledError extends Error {
  constructor() {
    super("워커가 사용자 요청으로 취소됨 — 모델 거부 아님");
    this.name = "WorkerCancelledError";
  }
}

// ─── 외부 취소 레지스트리 (cancel_worker 도구 — 2026-06-20) ───────────────────
// createWorkerAbort 의 abort 함수는 runWorkerJob 안 지역변수라 외부에서 못 끊는다.
// jobId → abort 매핑을 daemon 경계(본 모듈)에 둬 cancel_worker 가 호출 가능하게.
// createWorkerAbort(jobId) 가 발급 시 자기 abort 를 등록하고, done() 이 해제(settle 시).
const cancelHooks = new Map<string, () => void>();

export interface WorkerAbort {
  /** runRegionA(input.abortSignal) 로 운반할 signal — 어댑터가 1층 idle 과 OR 결합. */
  signal: AbortSignal;
  /** 워커 정상/throw 종료 시 호출 — 타이머 해제 + 취소 레지스트리 해제(누수·오발화 0). 멱등. */
  done(): void;
}

/**
 * 워커 전용 abortSignal 발급 — 만료 시 WorkerTimeoutError 로 abort.
 * region 의 runWorkerJob 이 호출해 `RegionASdkInput.abortSignal` 로 주입한다
 * (새 메커니즘 0, 값만 워커 전용 — architect §5).
 *
 * jobId 를 주면 그 워커의 abort 를 취소 레지스트리에 등록 → cancelJob(jobId) 이
 * WorkerCancelledError 로 abort 가능(외부 취소). done() 시 등록 해제.
 */
export const createWorkerAbort = (
  jobId?: string,
  ms: number = WORKER_TIMEOUT_MS,
): WorkerAbort => {
  const ac = new AbortController();
  const handle = setTimeout(() => {
    if (!ac.signal.aborted) ac.abort(new WorkerTimeoutError(ms));
  }, ms);
  (handle as { unref?: () => void }).unref?.();
  if (jobId !== undefined) {
    cancelHooks.set(jobId, () => {
      if (!ac.signal.aborted) ac.abort(new WorkerCancelledError());
    });
  }
  return {
    signal: ac.signal,
    done(): void {
      clearTimeout(handle);
      if (jobId !== undefined) cancelHooks.delete(jobId);
    },
  };
};

/**
 * 진행 중 워커 취소(best-effort) — cancel_worker 도구가 호출. abort 를 부르고 취소
 * 상태로 마킹한다. abort 는 LLM 스트림은 끊지만 hung MCP callTool 은 signal 미수신
 * (MCP 한계)이라 *다음 도구 경계*(최대 MCP_CALL_TIMEOUT)에서 멈춤 — 도구가 그 점 안내.
 *
 * @returns true=취소 신호 발사(running 잡 존재), false=대상이 없거나 이미 종료.
 */
export const cancelJob = (jobId: string): boolean => {
  const job = jobs.get(jobId);
  if (job === undefined || job.status !== "running") return false;
  // U-I4 (subagent-worker-unify ADR) — cancel 은 kind='worker' 만. awaited 서브에이전트
  // (kind='agent')는 부모 턴 종속이라 취소 대상이 아니다(createWorkerAbort 미등록 = 실제
  // abort 도 안 걸리고, markCancelled 만 하면 서브 완료 시 markDone 이 덮어써 상태 뒤집힘).
  // 코어 하드 게이트 — 어느 호출자든 agent 잡을 못 끊게(cancel_worker 도구도 별도 필터).
  if (job.kind !== "worker") return false;
  // 취소 상태를 먼저 마킹 — 이후 abort 가 runRegionA 를 reject 시키면 runner 의 catch 가
  // onWorkerComplete(error) 를 부르는데, 그 시점엔 이미 status="cancelled" 라 통지 문구가
  // 취소로 나간다(타임아웃과 구분). markCancelled 는 멱등(재호출 무해).
  markCancelled(jobId, "사용자 요청으로 취소됨");
  const hook = cancelHooks.get(jobId);
  if (hook !== undefined) hook();
  return true;
};

// ─── thread 별 turn 직렬 큐 (architect §4, W-I4 보강) ────────────────────────
// 현 핸들러에 turn 직렬화 락 없음 → 완료-turn 재주입이 유저 interim 메시지와 같은
// thread resume 을 동시에 건드려 race. `Map<threadKey, Promise>` chain 으로 threadKey
// 별 직렬화(전역 락 아님 — 다른 thread 는 병렬). scheduler inFlight 의 thread 단위 일반화.

const threadTails = new Map<string, Promise<unknown>>();

// ─── 큐-취소 primitive (ADR 2026-07-15, 대기 중 메시지 취소) ──────────────────
// threadKey 별 *아직 시작 안 한* 큐 항목의 correlationId → marker 를 추적한다. 항목이
// 디큐(task 실행 직전)되면 marker.state="started"(취소 불가), 체인 settle 후 map 에서 제거.
// cancelQueuedTurn 이 디큐 전에 marker.cancelled=true 로 마킹하면, 체인이 그 항목에
// 도달했을 때 task 를 실행하지 않고 sentinel 로 no-op resolve → 순서 자리에서 즉시 다음으로.
// ★보존(구현 시 보존 목록 §1·§2): 단일-enqueue 레이어·`prev.then(task,task)` 체인·tail
// settle-무관 이음·map 엔트리 정리(누수 0)·재주입 deadlock 불변식(60d1777, onWorkerComplete
// 직접-호출·재주입 id 미부여) 전부 불변 — id 추적은 *얹기만* 한다. 스킵 항목도 반드시
// resolve 로 체인을 이어 뒤 항목 순서·병렬 threadKey 를 왜곡하지 않는다.
interface QueueMarker {
  state: "pending" | "started";
  cancelled: boolean;
}
const pendingTurnIds = new Map<string, Map<string, QueueMarker>>();

/**
 * 취소된 큐 항목이 resolve 하는 sentinel — task 미실행 no-op 신호. POST /messages 핸들러가
 * 이 값을 감지해 `{replyText:"", cancelled:true}` 200 으로 응답한다(회색지대 G1, 정상 흐름·
 * 에러 아님). 일반 완료와 구분되는 유일 목적. 어댑터는 이 값을 읽지 않는다(큐 차원, #2).
 */
export const CANCELLED_TURN_RESULT: unique symbol = Symbol(
  "tiguclaw.cancelledQueuedTurn",
);

/** enqueueThreadTurn 결과가 큐-취소 no-op 인지 판정 — http-bridge POST 응답 분기용. */
export const isCancelledTurnResult = (v: unknown): boolean =>
  v === CANCELLED_TURN_RESULT;

/**
 * 같은 threadKey 작업을 직렬화 — 앞 작업 settle(성공/실패 무관) 후 다음 시작.
 * 다른 threadKey 는 병렬. 작업 throw 가 체인을 끊지 않게 tail 은 항상 settle 로 잇는다.
 *
 * `opts.id`(클라 correlationId) 지정 시 그 항목을 큐-취소 대상으로 추적한다. 미지정 =
 * 익명 항목(취소 불가, 현행 동작 — 텔레그램·cli·스케줄·합성 turn 회귀 0).
 *
 * 반환 = 이 작업의 결과 Promise (호출자가 await 가능). 취소된 항목은 CANCELLED_TURN_RESULT
 * 로 resolve(task 미실행). chain 무결성은 내부 tail 이 보장.
 */
export const enqueueThreadTurn = <T>(
  threadKey: string,
  task: () => Promise<T>,
  opts?: { id?: string },
): Promise<T> => {
  // id 있으면 미시작 집합에 marker 등록(같은 threadKey 스코프 마지막 등록만 신뢰 — G4).
  const id = opts?.id !== undefined && opts.id !== "" ? opts.id : undefined;
  let marker: QueueMarker | undefined;
  if (id !== undefined) {
    marker = { state: "pending", cancelled: false };
    let m = pendingTurnIds.get(threadKey);
    if (m === undefined) {
      m = new Map();
      pendingTurnIds.set(threadKey, m);
    }
    m.set(id, marker);
  }
  // 디큐(task 실행 직전) = "시작". 취소 마킹돼 있으면 task 미실행 no-op sentinel resolve.
  // 스킵도 resolve 로 체인을 이어 뒤 항목이 곧장 진행(순서 왜곡 0).
  const gatedTask = (): Promise<T> => {
    if (marker !== undefined) {
      marker.state = "started"; // 이 순간부터 취소 불가(already-started).
      if (marker.cancelled) {
        return Promise.resolve(CANCELLED_TURN_RESULT as unknown as T);
      }
    }
    return task();
  };
  const prev = threadTails.get(threadKey) ?? Promise.resolve();
  // 앞 작업이 reject 해도 다음이 실행되도록 catch 로 흡수한 prev 에 chain.
  const run = prev.then(() => gatedTask(), () => gatedTask());
  // tail 은 결과/에러 무관 settle 로 — chain 끊김 0. 최신 tail 만 추적(완료 후 정리).
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  threadTails.set(threadKey, tail);
  // tail(settle-safe) 종료 후: (1) 이 항목의 marker map 엔트리 정리(누수 0), (2) 그 사이
  // 새 turn 이 안 들어왔으면 threadTails 정리. tail 은 절대 reject 안 하므로 finally 안전.
  void tail.finally(() => {
    if (marker !== undefined && id !== undefined) {
      const m = pendingTurnIds.get(threadKey);
      if (m !== undefined && m.get(id) === marker) {
        m.delete(id);
        if (m.size === 0) pendingTurnIds.delete(threadKey);
      }
    }
    if (threadTails.get(threadKey) === tail) {
      threadTails.delete(threadKey);
    }
  });
  return run;
};

/**
 * 대기 중(미시작) 큐 항목 취소 — 멱등. http-bridge `POST /cancel-queued` 가 코어 export 인
 * 본 함수를 부른다(§0 단방향 — 코어는 http-bridge 를 모른다). `/stop`(러닝 턴 abort)의
 * 자매: 이건 아직 시작 안 된 특정 대기 항목을 correlationId 로 지목해 스킵한다.
 *  - "cancelled": 미시작 항목을 취소 마킹(체인 도달 시 no-op resolve).
 *  - "already-started": 이미 디큐돼 실행 중(취소 불가 — /stop 영역, G3).
 *  - "not-found": 해당 threadKey 에 그 id 없음(미상·완료 후 제거됨).
 */
export const cancelQueuedTurn = (
  threadKey: string,
  id: string,
): "cancelled" | "already-started" | "not-found" => {
  if (id === "") return "not-found";
  const m = pendingTurnIds.get(threadKey);
  const marker = m?.get(id);
  if (marker === undefined) return "not-found";
  if (marker.state === "started") return "already-started";
  marker.cancelled = true; // 멱등 — 중복 취소 무해(이미 true 여도 동일 결과).
  return "cancelled";
};

/** 테스트·진단용 — 현재 직렬 큐가 추적 중인 thread 수. */
export const pendingThreadCount = (): number => threadTails.size;

// ─── reply 클로저 재획득 (architect §3-b) ────────────────────────────────────
// 워커는 원 turn 의 reply 클로저를 안 들고 있다(원 turn 종료). 재주입 turn 의 reply 를
// 채널명→send 매핑으로 재구성. dispatcher.ts 의 telegram/cli 분기와 *동일 의미* —
// 단 dispatcher 는 결과 텍스트 직접 push 였고, 여기선 핸들러 재진입의 reply 통로.
// (telegram threadKey "tg:<chatId>" → chatId 복원, cli → console.log.)

import { deliverOutbound } from "./outbound.js";
import type { ReplyOptions } from "../channels/types.js";
import { canonicalSessionChannel } from "../store/sessions.js";

/**
 * notifyDest 없는 워커(텔레그램 직접 발화 등)의 *폴백* target 도출 — 기존 telegram threadKey
 * slice 로직을 그대로 추출. 텔레그램 직접 워커는 notifyDest 미주입이므로 이 폴백이 현행과
 * *비트 동일* 한 chatId 를 낸다(회귀 0, architect §5). cli·미지원 채널은 target 무의미 → null.
 */
const deriveTargetFromThreadKey = (
  channel: ChannelName,
  threadKey: string,
): string | null => {
  if (channel === "telegram") {
    // threadKey "tg:<chatId>" → chatId. 접두 없으면 threadKey 자체(기존 동작 보존).
    return extractTelegramChatId(threadKey) ?? threadKey;
  }
  return null;
};

/**
 * generic 통지 목적지(dest)로 reply 클로저 재획득. 코어는 dest.channel("telegram" 등)만 보고
 * dispatch — *어느 플러그인이 dest 를 채웠는지*(scheduler 였는지)는 영원히 모른다(단방향 §6).
 * 라우팅·발송·관측은 core 단일 통로 deliverOutbound 에 위임(scheduler·file-watch·부팅통지와
 * 동일 로직 — 같은 걸 두 번 구현 X). 덕분에 워커 완료 통지도 대시보드 chat_log 에 뜬다
 * (예전엔 raw 발송이라 안 보였음). 미지원 채널·발송 실패는 deliverOutbound 가 정직 처리.
 */
const reacquireReply = (
  dest: WorkerNotifyDest,
  opts?: { observe?: boolean },
): ((text: string, opts?: ReplyOptions) => Promise<void>) => {
  // observe(기본 true) — 우회 통지(handler 미경유: failed/cancelled·done 안전망·부팅 복구)는
  // 자체가 유일 발신이라 관측 발행 필요(대시보드 가시성 유지). observe:false 는 done 재주입
  // reply 전용 — 관측은 핸들러(index.ts) 성공분기 단일 지점에 위임해 일반 turn 과 대칭
  // (대시보드 이중 버블 0). 물리 발송(telegram send 등)은 두 경우 모두 동일하게 수행된다.
  const observe = opts?.observe;
  return async (text: string): Promise<void> => {
    await deliverOutbound({
      channel: dest.channel,
      target: dest.target ?? null,
      text,
      label: "worker",
      ...(observe === false ? { observe: false } : {}),
    });
  };
};

/**
 * 잡의 notifyDest(있으면) 또는 channel/threadKey 폴백으로 통지 dest 를 도출 — onWorkerComplete·
 * recoverInterruptedJobs 공용. notifyDest 미지정 워커(텔레그램 직접 발화)는 폴백이 현행 동작
 * 재현(회귀 0). 채운 주체가 누구든 코어는 generic 좌표만 본다(단방향).
 */
const destForJob = (job: {
  channel: ChannelName;
  threadKey: string;
  notifyDest?: WorkerNotifyDest;
}): WorkerNotifyDest =>
  job.notifyDest ?? {
    channel: job.channel,
    target: deriveTargetFromThreadKey(job.channel, job.threadKey),
  };

// ─── 완료 → 메인 재주입 (architect §3, W-I1 단일 인격 핵심) ───────────────────
// 워커 완료 시 원 잡의 threadKey 로 *합성 user-turn* 을 주입해 메인 핸들러를 재진입 →
// 메인(같은 SYSTEM/AGENT 인격 + 그 thread history)이 결과를 받아 맥락 입혀 채널 보고.
// 채널로 나가는 텍스트는 *항상 메인 출력* (워커 텍스트 직행 절대 금지, W-I1).

/**
 * daemon 부팅 시 1회 주입되는 핸들러 핸들. index.ts 가 메인 MessageHandler 를
 * registerWorkerHandler 로 등록 → onWorkerComplete 가 재주입 시 호출.
 * (index.ts → worker-jobs 순환을 피하려 setter 주입. region 의 lazy import 와 동형.)
 */
let mainHandler: MessageHandler | undefined;

/**
 * 메인 핸들러 등록 — index.ts 가 부팅 시 1회 호출.
 * 등록 전 onWorkerComplete 가 불리면(이론상 워커가 핸들러보다 먼저 끝날 일 없음) 경고.
 */
// 워커 스트림 스톨 → 유저 통지 (ADR 2026-07-02). codex 어댑터는 llm.stream_stall 만
// publish(채널 무결합) — 여기서 워커 dest 로 "이어서 재개 중" 핑을 보낸다(deliverOutbound
// 단일 통로 → 텔레그램+대시보드). threadKey=worker:<jobId> 만 대상(메인 턴은 제외 — 사용자가
// 직접 대기 중이라 별도 통지 불요). 부팅 1회 구독.
let stallNotifySubscribed = false;
const subscribeWorkerStallNotify = (): void => {
  if (stallNotifySubscribed) return;
  stallNotifySubscribed = true;
  getEventBus().subscribe((event) => {
    if (event.type !== "llm.stream_stall") return;
    const tk =
      typeof event.payload.threadKey === "string" ? event.payload.threadKey : "";
    if (!tk.startsWith("worker:")) return;
    const job = getJob(tk.slice("worker:".length));
    if (job === undefined) return;
    const dest = destForJob(job);
    const attempt = String(event.payload.attempt ?? "?");
    const max = String(event.payload.maxRetries ?? "?");
    void deliverOutbound({
      channel: dest.channel,
      target: dest.target ?? null,
      text: `⚠️ 백그라운드 작업 '${job.label}' 의 응답이 잠시 멎어 이어서 재개 중이에요 (${attempt}/${max}).`,
      label: "worker",
    }).catch(() => {
      /* 통지 실패는 재개에 영향 0 */
    });
  });
};

// 워커 도구 조기-경고 → 유저 통지 (2026-07-03). codex 어댑터가 `llm.tool_slow` 발행(도구가
// CODEX_TOOL_SLOW_WARN_MS(기본 90s) 초과 실행). 워커면 dest 로 "멈춤 — Mac 권한 확인" 핑을
// *잡당 1회*(스팸 방지) 보낸다. 권한요청/hung/느림 구분은 못 하나 "확인해봐"가 actionable —
// 실측: 워커가 macOS 권한 다이얼로그에 조용히 막혀 30분+ 헤맴. 부팅 1회 구독. 통지 실패 무해.
const toolSlowNotified = new Set<string>();
let toolSlowNotifySubscribed = false;
const subscribeWorkerToolSlowNotify = (): void => {
  if (toolSlowNotifySubscribed) return;
  toolSlowNotifySubscribed = true;
  getEventBus().subscribe((event) => {
    if (event.type !== "llm.tool_slow") return;
    const tk =
      typeof event.payload.threadKey === "string" ? event.payload.threadKey : "";
    if (!tk.startsWith("worker:")) return;
    const jobId = tk.slice("worker:".length);
    if (toolSlowNotified.has(jobId)) return; // 잡당 1회.
    const job = getJob(jobId);
    if (job === undefined) return;
    if (toolSlowNotified.size > 500) toolSlowNotified.clear(); // 누수 가드.
    toolSlowNotified.add(jobId);
    const dest = destForJob(job);
    const tool =
      typeof event.payload.tool === "string" ? event.payload.tool : "도구";
    const sec = Math.round(
      (typeof event.payload.ms === "number" ? event.payload.ms : 90_000) / 1000,
    );
    void deliverOutbound({
      channel: dest.channel,
      target: dest.target ?? null,
      text: `⏳ 백그라운드 작업 '${job.label}' 이(가) 도구 '${tool}'에서 ${sec}초+ 멈춰 있어요. OS 권한 요청 다이얼로그가 떠 있는지, 또는 외부 MCP 도구면 대상 앱(예: 에디터)이 실행 중인지 확인해주세요 (아니면 도구가 느리거나 멈춘 것일 수 있어요).`,
      label: "worker",
    }).catch(() => {
      /* 통지 실패는 작업에 영향 0 */
    });
  });
};

export const registerWorkerHandler = (handler: MessageHandler): void => {
  mainHandler = handler;
  subscribeWorkerStallNotify(); // 부팅 1회 — 워커 스톨 재개 유저 통지 구독.
  subscribeWorkerToolSlowNotify(); // 부팅 1회 — 워커 도구 멈춤(권한 등) 조기 통지 구독.
};

/**
 * 실패 원인 문자열을 사용자가 *왜 안 됐는지·다음에 뭘 할지* 알 수 있는 한 줄로 정제.
 *
 * 통지의 actionable 화 핵심(임무 §2) — generic "실패했습니다" 금지. raw error(어댑터·모델
 * 포함)는 어댑터 분기 없이(LLM-agnostic) 문자열 휴리스틱으로만 분류한다(facade
 * isModelRejected 와 동형 — 모델 카탈로그 아님, 에러 *종류* 분류). 미매칭이면 원문 cap.
 *
 * 입력 error 는 onWorkerComplete 가 이미 redactSecrets 통과시킨 안전 문자열.
 */
const humanizeWorkerError = (raw: string): string => {
  // codex 사용량 한도(429 usage_limit) — resets_in_seconds 가 있으면 "~N분 후 리셋" 안내.
  // 사용자가 *언제 다시 시도하면 되는지* 알게(가장 actionable). 양 provider 무관 문자열만.
  if (/usage_limit_reached|usage limit/i.test(raw)) {
    const m = raw.match(/resets_in_seconds"\s*:\s*(\d+)/);
    if (m !== null) {
      const min = Math.max(1, Math.round(Number(m[1]) / 60));
      return `LLM 사용량 한도 도달(429) — 약 ${min}분 후 한도가 리셋됩니다. 그 뒤 다시 시켜주세요.`;
    }
    return "LLM 사용량 한도 도달(429) — 잠시 후 한도가 리셋되면 다시 시켜주세요.";
  }
  // 유휴/턴 타임아웃 — 모델이 응답을 멈춤(거부 아님). 더 작게 쪼개 재시도 권장.
  if (/유휴 타임아웃|idle|시간 초과|timeout/i.test(raw)) {
    return "LLM 응답이 멈춰(타임아웃) 완료하지 못했습니다. 작업을 더 작게 쪼개 다시 시켜주세요.";
  }
  // 풀 전체 소진 — 모든 어댑터가 동시에 실패(단일 provider 풀 흔들림 등). 원문 일부 보존.
  if (/모든 어댑터 실패|모델 풀이 비어/i.test(raw)) {
    return `사용 가능한 LLM 모델이 모두 일시적으로 응답하지 못했습니다. 잠시 후 다시 시켜주세요. (원인: ${raw.slice(0, 160)})`;
  }
  // 미분류 — 원문을 길이 cap 해 그대로 노출(사용자=운영자, "에러 다 보이는 게 좋다"). 빈값 방어.
  const t = raw.trim();
  return t === "" ? "알 수 없는 오류" : t.slice(0, 400);
};

/**
 * 워커 종료를 *LLM 무경유* 로 결정 전달하는 raw 아웃바운드 문구(done/failed/cancelled).
 *
 * 안전망 전용 — 정상 경로(LLM 재주입)가 메인 인격으로 자연스럽게 보고하지만, 모델 풀이
 * 죽어 재주입 turn 마저 실패하면(워커 실패의 흔한 원인과 동일 — codex 429+claude idle)
 * 통지가 영영 안 가는 deadlock 을 막는다. recoverInterruptedJobs 의 raw 통지와 동형.
 * failed 는 humanizeWorkerError 로 *왜·언제 다시* 를 담는다(actionable, 임무 §2).
 */
const buildRawNotice = (job: WorkerJobRecord): string => {
  if (job.status === "done") {
    return (
      `✅ 백그라운드 작업 '${job.label}'이(가) 완료됐어요.\n` +
      `결과:\n${job.result ?? "(결과 없음)"}`
    );
  }
  if (job.status === "cancelled") {
    return `🛑 백그라운드 작업 '${job.label}'을(를) 요청대로 취소했어요.`;
  }
  // 부분 진행 힌트 — daemon 경계엔 정확한 처리 건수가 없다(워커 thread 의 부수효과로만
  // 존재, region 도메인). 카운트를 *지어내지 않고* 일부 진행 가능성을 정직히 안내해
  // 사용자가 이어서/처음부터 중 결정하게 한다(임무 §3 — feasible 범위 한도).
  return (
    `⚠️ 백그라운드 작업 '${job.label}'이(가) 실패했어요.\n` +
    `원인: ${humanizeWorkerError(job.error ?? "알 수 없는 오류")}\n` +
    `일부는 처리됐을 수 있어요 — 이어서 할지/처음부터 다시 할지 알려주시면 맞춰 진행할게요.`
  );
};

/**
 * 성공(done) 재주입 prompt — 메인이 결과를 맥락 입혀 보고하게 하는 내부 스캐폴딩.
 * failed/cancelled 는 onWorkerComplete 가 LLM 무경유 raw 통지(buildRawNotice)로 직행하므로
 * 이 함수는 done 에만 쓰인다(호출 전 status==="done" 보장). 방어로 비-done 도 일반 문구 반환.
 */
const buildCompletionPrompt = (job: WorkerJobRecord): string => {
  if (job.status !== "done") {
    // 도달 불가(호출자 가드) — 방어. raw 통지로 가야 할 케이스가 새면 가시화되게 명시 문구.
    return (
      `〔백그라운드 작업 '${job.label}' 종료 알림 (${job.status}) — 사용자에게 알리세요〕\n` +
      `${job.error ?? ""}\n〔/알림〕`
    );
  }
  return (
    `〔백그라운드 작업 완료 알림 — 사용자에게 보고하세요〕\n` +
    `작업: "${job.label}"\n` +
    `결과:\n${job.result ?? ""}\n` +
    `〔/알림〕\n\n` +
    `위 결과를 사용자에게 자연스럽게 보고하세요.`
  );
};

/**
 * region 의 runWorkerJob 이 호출하는 *완료 훅* (인계 경계).
 *
 * 흐름 (status 분기 — 통지 미도착 0 보장):
 *  1) result/error 로 레지스트리 마킹 (markDone/markFailed/cancelled 보존).
 *  2-failed/cancelled) LLM *무경유* raw 아웃바운드 직행(reacquireReply + buildRawNotice).
 *     워커 실패의 흔한 원인이 모델 풀 소진(429+idle)이라, 같은 죽은 풀로 통지 turn 을 돌리면
 *     통지마저 침묵하기 때문(2026-06-22 실측). humanizeWorkerError 로 actionable. 메인 thread/
 *     직렬 큐 미경유(폴러 차단 0). recoverInterruptedJobs 의 raw 통지와 동형.
 *  2-done) 합성 user-turn 으로 메인 핸들러 재주입(W-I1 — 결과는 맥락 입혀 보고). 재주입을
 *     await 해 delivered(실제 send 성공) 추적 → 미도달 시 raw 안전망(buildRawNotice)으로
 *     결과를 결정 전달. mainHandler(serializedHandler)가 *자체* enqueueThreadTurn 단일 직렬화
 *     하므로 직접 호출(이중 enqueue deadlock 0, 60d1777 유지).
 *
 * 본 함수는 워커의 분리(fire-and-forget) promise 안에서 await 되므로 done 재주입을 await 해도
 * 채널 폴러·데몬 메인루프를 막지 않는다. 내부 try/catch 로 throw 0(데몬 생존, 원칙 3).
 *
 * @param outcome 성공이면 {result}, 실패면 {error}. error 는 호출자가 redact 후 전달 권장
 *                (방어로 본 모듈도 한 번 더 redact 통과시킨다).
 */
export const onWorkerComplete = async (
  jobId: string,
  outcome: { result: string } | { error: string },
): Promise<void> => {
  // 1) 레지스트리 마킹. 단 이미 cancelled 면(cancelJob 이 abort 전 마킹) 그 status 보존 —
  //    abort 가 runRegionA 를 reject 시켜 여기로 error 가 와도 "실패" 아닌 "취소"로 통지.
  const existing = jobs.get(jobId);
  if ("result" in outcome) {
    // 취소 직후 워커가 마지막 도구를 끝내고 결과를 낸 희귀 경우 — 취소 의도 보존(통지 일관).
    if (existing?.status !== "cancelled") markDone(jobId, outcome.result);
  } else if (existing?.status === "cancelled") {
    // 이미 취소 마킹됨 — 재마킹 불요(멱등). buildCompletionPrompt 가 취소 문구로 분기.
  } else {
    // 시크릿 누수 0 — redactSecrets 통과 후 기록 (architect §7).
    const { redactSecrets } = await import("./outbound-sanitize.js");
    markFailed(jobId, redactSecrets(outcome.error));
  }

  const job = jobs.get(jobId);
  if (job === undefined) {
    console.error(`worker-jobs: onWorkerComplete unknown jobId=${jobId}`);
    return;
  }
  if (mainHandler === undefined) {
    console.error(
      `worker-jobs: 메인 핸들러 미등록 — 워커 '${job.label}'(${jobId}) 완료 보고 불가`,
    );
    return;
  }

  // notifyDest(스케줄 등이 주입한 generic 좌표) 우선, 없으면 channel/threadKey 폴백(회귀 0).
  // baseReply = 우회 통지용(관측 발행 O) — failed/cancelled 직행·done 안전망이 이걸 쓴다.
  const dest = destForJob(job);
  const baseReply = reacquireReply(dest);

  // ─── 실패/취소 — LLM 무경유 raw 통지로 *결정* 전달 (actionable, deadlock-free) ──────
  // failed/cancelled 는 (a) 사용자가 *무조건* 알아야 하는 운영 사건이고, (b) LLM 이 실패
  // 원인에 보탤 material 이 없으며(원인 문자열이 곧 전부), (c) 워커 실패의 흔한 원인이 모델 풀
  // 소진(codex 429 + claude idle, 2026-06-22 실측)이라 *같은 죽은 풀로 재주입 turn 을 돌리면
  // 통지마저 침묵* 한다. → recoverInterruptedJobs 와 동형으로 raw 아웃바운드 직행해 모델
  // 상태와 무관하게 결정적으로 전달한다(LLM-agnostic — 어댑터·모델 무관). humanizeWorkerError
  // 가 "왜·언제 다시"(예 429 → ~N분 후 리셋)를 담아 actionable(임무 §2). 채널 직행이라 메인
  // thread/직렬 큐를 안 타 폴러·메인루프 차단 0(fire-and-forget 격리 유지). 본 함수는 워커의
  // 분리된 promise 안에서 await 되므로 데몬 메인루프와 무관.
  if (job.status !== "done") {
    try {
      await baseReply(buildRawNotice(job));
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      console.error(
        `worker-jobs: ${job.status} 통지 전송 실패 (job='${job.label}' ${jobId} thread=${job.threadKey}): ${reason}`,
      );
    }
    return;
  }

  // ─── 성공(done) — 메인 인격 재주입 + raw 안전망 ─────────────────────────────────
  // 성공 결과는 메인(같은 SYSTEM/AGENT 인격 + thread history)이 맥락 입혀 보고해야 가치가
  // 산다(W-I1). 단 재주입 turn 도 모델 풀 소진 시 침묵할 수 있으므로 delivered 추적 + raw
  // 안전망으로 "결과는 무조건 전달" 을 보장한다(통지 미도착 0).
  //
  // 합성 user-turn 구성. text = 내부 스캐폴딩(메인이 echo 안 하도록 sysprompt +
  // stripInternalRuntimeScaffolding 이중 방어). reply 는 delivered 추적으로 감싼다 —
  // 재주입 turn 이 사용자에게 *실제로* 한 줄이라도 내보냈는지 알아야 안전망 이중 발화를 피한다.
  // 재주입 reply 는 *관측 발행 안 하는* raw 전송(observe:false) — 물리 발송(telegram send)은
  // 하되 대시보드 관측은 핸들러(index.ts) 성공분기 단일 지점에 위임한다. 일반 turn 과 대칭 →
  // 대시보드 이중 버블 0(과거엔 여기 baseReply 의 publishOut + 핸들러 발행 둘 다 = 이중이었다).
  const reinjectReply = reacquireReply(dest, { observe: false });
  let delivered = false;
  const trackedReply = async (
    text: string,
    opts?: ReplyOptions,
  ): Promise<void> => {
    await reinjectReply(text, opts);
    delivered = true; // send 성공 후에만 마킹 — throw 시 미마킹 → 안전망 발화.
  };
  // 세션-정체성 정규화(채널/세션 분리 ADR 2026-07-15 §D1, QA §6 P1) — 재주입 완료턴이
  // route() 를 통해 **실세션 정체성**(resume/history/context boundary)에 붙도록, 사용자 세션
  // threadKey(dashboard:*)이면서 job.channel 이 canonical 과 다를 때만(telegram/cli發 워커)
  // session 을 실어 정규화한다 → route 가 (SESSION_STORAGE_CHANNEL, job.threadKey) 로 키잉해
  // 이전 유저턴과 **동일 세션 정체성**(resume/transcript 파편화 해소). ★내부 파생 스레드
  // (scheduler:/worker:/endpoint: 등)·대시보드發(이미 canonical)은 idChannel===job.channel →
  // session 미부여 = 현행 passthrough(스케줄러·서브에이전트 세션 정체성 무변경, 회귀 0).
  // channelAddress 는 캡처된 배달 좌표(dest.target)로 재확인 — route 의 setSessionChannelMeta
  // 가 last_channel_target 을 null 로 덮어쓰지 않게(telegram chatId 보존).
  const idChannel = canonicalSessionChannel(job.threadKey, job.channel);
  const synthetic = {
    channel: job.channel,
    channelUserId: job.channelUserId,
    threadKey: job.threadKey,
    text: buildCompletionPrompt(job),
    ...(idChannel !== job.channel
      ? {
          session: {
            explicitSessionId: job.threadKey,
            ...(dest.target !== null ? { channelAddress: dest.target } : {}),
          },
        }
      : {}),
    // 내부 기원 표식 — 핸들러가 `channel.message.in` 관측 발행을 스킵(스캐폴딩 텍스트가
    // 대시보드에 "나(user)"로 새는 걸 차단). 라우팅·직렬화 등 나머지는 실 인바운드와 동일.
    synthetic: true,
    receivedAt: Date.now(),
    reply: trackedReply,
  };

  // 메인 핸들러로 재주입 (유저 interim turn 과 직렬). ★ mainHandler(=serializedHandler)
  // 가 *자체적으로* enqueueThreadTurn 으로 직렬화하므로 여기서 또 enqueueThreadTurn 으로
  // 감싸면 같은 thread 에 이중 enqueue → 재진입 deadlock(외부 task 가 내부 task 를 await 하는데
  // 내부 task 는 외부 tail 을 기다림) → 통지 턴이 영영 실행 안 됨(2026-06-20 발견). 직접 호출해
  // 단일 enqueue 로 닫는다. 재주입을 *await* 해 delivered 를 본 뒤 안전망을 결정한다 — 이
  // await 은 워커의 분리 promise 안이라 데몬 메인루프·폴러를 막지 않는다(워커는 fire-and-forget).
  const handler = mainHandler;
  try {
    await handler(synthetic);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.error(
      `worker-jobs: 완료 재주입 실패 (job='${job.label}' ${jobId} thread=${job.threadKey}): ${reason}`,
    );
  }

  // 안전망 — 재주입 turn 이 사용자에게 아무것도 못 보냈으면(모델 풀 소진·채널 throw 등) LLM
  // 무경유 raw 통지로 결과를 결정 전달한다. delivered=true 면(LLM 이 이미 보고) 생략 → 이중 0.
  if (!delivered) {
    try {
      await baseReply(buildRawNotice(job));
      console.warn(
        `worker-jobs: 완료 재주입 통지 미도달 — raw 안전망 통지 발화 (job='${job.label}' ${jobId})`,
      );
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      console.error(
        `worker-jobs: raw 안전망 통지마저 실패 (job='${job.label}' ${jobId}): ${reason}`,
      );
    }
  }
};

// ─── 부팅 복구 (option b, 2026-06-19) ────────────────────────────────────────
// 재시작/크래시로 중단된 워커(DB status='running')를 사용자에게 정직 통지. index.ts 가
// 채널 start 직후 1회 호출. 통지는 *raw 아웃바운드*(LLM 무경유) — 모델 풀이 죽어 있어도
// 결정적으로 전달된다. 통지 후 status='interrupted' 전이 → 다음 부팅 재통지 0(멱등).

export const recoverInterruptedJobs = async (): Promise<void> => {
  let interrupted: ReturnType<typeof listInterruptedWorkerJobs>;
  try {
    interrupted = listInterruptedWorkerJobs();
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.error(`worker-jobs: 중단 잡 조회 실패: ${reason}`);
    return;
  }
  for (const job of interrupted) {
    // U-I5: awaited 서브에이전트(kind='agent')는 부모 turn 에 종속 — 재시작 시 부모도 사라져
    // 통지 대상이 없다(고아 통지 방지). status='interrupted' 마킹만 하고 통지는 생략.
    // (detached 워커만 사용자에게 "중단됐어요" 정직 통지 — 그건 부모와 무관하게 돌던 잡.)
    if (job.kind === "agent") {
      persistSafe("recover-agent", () =>
        updateWorkerJobStatus(job.jobId, "interrupted", Date.now()),
      );
      continue;
    }
    const text =
      `⚠️ 이전에 맡긴 백그라운드 작업 '${job.label}'이 데몬 재시작으로 중단됐어요. ` +
      `결과를 받지 못했으니, 필요하면 다시 시켜주세요.`;
    try {
      // 영속된 notifyDest(store 가 미러)가 있으면 그걸로, 없으면 channel/threadKey 폴백 →
      // 재시작 후에도 스케줄 워커 통지가 올바른 chatId 로 도달(정직 통지 강화). store 가
      // notifyDest 컬럼을 아직 안 실어도 폴백이 현행 동작 재현(회귀 0). job.notifyDest 는
      // PersistedWorkerJob 에 additive 라 미존재 시 undefined → 폴백 분기.
      const reply = reacquireReply(
        destForJob({
          channel: job.channel as ChannelName,
          threadKey: job.threadKey,
          notifyDest: (job as { notifyDest?: WorkerNotifyDest }).notifyDest,
        }),
      );
      await reply(text);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      console.error(
        `worker-jobs: 중단 통지 전송 실패 (job='${job.label}' ${job.jobId}): ${reason}`,
      );
    }
    persistSafe("recover", () =>
      updateWorkerJobStatus(job.jobId, "interrupted", Date.now()),
    );
  }
  // 터미널 전이(interrupted) 배치 종료 후 1회만 prune — 루프 안에서 N번 부르지 않음(§5 얇게).
  if (interrupted.length > 0) pruneTerminalJobsSafe();
  if (interrupted.length > 0) {
    console.log(
      `worker-jobs: 재시작으로 중단된 워커 ${interrupted.length}건 정직 통지`,
    );
  }
};

// ─── region 이 호출할 발사 API 경계 (architect §9-a/§9-b) ─────────────────────
// startWorkerJob = (a) registerJob (b) region 의 runWorkerJob 을 fire-and-forget 호출.
// 단 runWorkerJob(워커 실행 본체 = runRegionA on worker:<jobId>)은 region 파트 →
// 본 모듈은 그 함수를 *주입* 받아 호출만 한다(경계 명확, 순환은 region 이 lazy import).

/**
 * region 이 구현·주입하는 워커 실행 본체 시그니처.
 *  - job: 본 모듈이 registerJob 으로 만든 레코드 (jobId·task·threadKey 등).
 *  - 워커는 `worker:<jobId>` thread 에서 runRegionA 실행(메인 history 청결, §3).
 *  - workerDepth:1 가드 + createWorkerAbort().signal 주입은 region 책임(daemon 헬퍼 제공).
 *  - 완료/실패 시 onWorkerComplete(jobId, ...) 를 부른다 (await 불필요).
 *  - fire-and-forget — 반환 즉시(워커는 백그라운드). throw 금지(내부에서 onComplete 로 닫음).
 */
export type WorkerRunner = (job: WorkerJobRecord) => void;

let workerRunner: WorkerRunner | undefined;

/**
 * region 의 worker-registry 가 부팅 시(또는 lazy) 워커 실행 본체를 주입.
 * 미주입 상태에서 startWorkerJob 호출 시 명시 에러(사일런트 실패 회피).
 */
export const registerWorkerRunner = (runner: WorkerRunner): void => {
  workerRunner = runner;
};

export interface StartWorkerJobInput {
  label: string;
  task: string;
  /** 완료 재주입이 합류할 원 thread (메인 turn 의 threadKey). */
  threadKey: string;
  channel: ChannelName;
  channelUserId: string;
  /**
   * 완료/실패 통지 generic 목적지 (additive). 워커 발사 도구(run_in_background)가
   * parentInput.notifyDest 를 읽어 채운다 — 스케줄이 dest(telegram/chatId)를 주입하는 경로.
   * 미지정(텔레그램 직접 발화 등)이면 channel/threadKey 폴백(회귀 0).
   */
  notifyDest?: WorkerNotifyDest;
  /**
   * 실행 cwd(관측+동작) — run_in_background(path=X) 가 프로젝트 스코프 위임 시 그 폴더.
   * registerJob 으로 흘러 잡 레코드·SSE 에 실리고(대시보드 프로젝트 귀속), runner 가
   * 이 값을 childInput.cwd 로 써 워커의 file-ops 상대경로가 그 폴더 기준(3b). 미지정=home 폴백.
   */
  cwd?: string;
  /**
   * 워커 모델 등급(high/mid/low/nano 또는 provider:model). run_in_background(tier=X) 가
   * 채운다 — registerJob 이 레코드로 흘려 runner 가 resolveTier→specs 로 그 티어 풀 사용
   * (미지정 시 기본 모델). 서브에이전트 model 등급과 동일 경로. 대시보드 관측에도 실림.
   */
  modelTier?: string;
}

/**
 * spawn_worker 도구가 호출하는 발사 API (즉시 jobId 반환 — W-I2 메인 안 갇힘).
 *  1) registerJob → jobId.
 *  2) region 이 주입한 workerRunner 를 fire-and-forget 호출 (워커는 백그라운드 진행).
 *  3) jobId 즉시 반환 → 도구는 {jobId, status:"started"} 로 응답.
 *
 * runner 미등록(부팅 순서 이상)이면 잡을 즉시 failed 마킹 + throw 없이 jobId 반환
 * (도구가 정직 보고하도록 — 단 보통은 등록 보장됨).
 */
export const startWorkerJob = (input: StartWorkerJobInput): string => {
  const jobId = registerJob(input);
  if (workerRunner === undefined) {
    markFailed(jobId, "워커 실행기 미등록(부팅 순서 이상)");
    console.error("worker-jobs: startWorkerJob — workerRunner 미등록");
    return jobId;
  }
  const job = jobs.get(jobId)!;
  try {
    // fire-and-forget — runner 내부에서 runRegionA 를 await 안 하고 백그라운드 실행,
    // 완료 시 onWorkerComplete 콜백. runner 가 동기 throw 하면 즉시 failed 마킹.
    workerRunner(job);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    markFailed(jobId, reason);
    console.error(`worker-jobs: workerRunner 동기 throw (job=${jobId}): ${reason}`);
  }
  return jobId;
};
