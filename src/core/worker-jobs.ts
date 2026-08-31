/**
 * ★**용어: 사람에게는 「매니저」, 코드에는 `worker`** (2026-07-29 개명 · 2026-08-29 정리).
 *
 *  옛 한국어 이름이 능력 서열과 **반대**였다 — 매니저가 서브에이전트보다 유능한데 더
 *  하찮게 들리는 말이었다. 그래서 **사람·모델이 보는 말만** 바꾸고 식별자는 그대로 뒀다:
 *
 *  | 어디 | 뭐라고 부르나 |
 *  |---|---|
 *  | 화면·모델이 읽는 글·로그·주석 | **매니저** |
 *  | DB(`worker_jobs`)·이벤트(`worker.*`)·도구명(`run_in_background`·`steer_worker`) | `worker` 그대로 |
 *
 *  ★식별자를 안 바꾼 이유는 **마이그레이션이 이름값을 못 한다**는 것이다 — 테이블·이벤트를
 *   개명하면 옛 레코드·옛 구독자가 조용히 갈리는데, 얻는 건 영문 단어 하나다.
 *  ★2026-08-29 에 주석 450건이 아직 옛 이름을 쓰고 있는 걸 정태님이 잡았다. 화면은
 *   매니저인데 주석은 그 반대였으니 **읽는 사람마다 다른 어휘**를 갖게 된다. 회귀
 *   `manager-naming-is-one-word` 가 이제 그 갈림을 막는다.
 *
 * 백그라운드 매니저 — daemon 인프라 (잡 레지스트리 + 완료 재주입 + thread 직렬 큐 +
 * reply 클로저 재획득 + 매니저 전용 타임아웃 주입).
 *
 * 진실 소스: architect contract `_workspace/background-worker_architect.md`
 * (불변식 W-I1~W-I8, 구현 contract §9-b). 본 모듈은 daemon 인프라 파트 —
 * region-engineer 의 worker-registry.ts(발사 도구 + runWorkerJob 실행 본체)가
 * 호출할 *깨끗한 API* 를 제공한다. 매니저 실행 본체(runRegionA)는 region 경계.
 *
 * 경계 (W-I4 코어 불변):
 *  - daemon (본 모듈): registerJob / markDone / markFailed / listJobs (레지스트리),
 *    onWorkerComplete (완료→메인 재주입 훅), thread 직렬 큐, reply 재획득,
 *    잡 전용 abortSignal 발급(createJobAbort) + 취소 훅 레지스트리(setCancelHook/clearCancelHook).
 *  - region (worker-registry.ts): spawn_worker 도구 + runWorkerJob(job, deps) 가
 *    runRegionA 를 `worker:<jobId>` thread 에서 fire-and-forget 실행 후, 완료/실패를
 *    daemon 이 주입한 `deps.onComplete(jobId, ...)` = onWorkerComplete 로 콜백.
 *
 * MVP = 메모리 레지스트리(영속 0, W-I7 재시작 정직). scheduler `inFlight` Set 동형.
 */
import { formatResetAt, isRateLimited, parseCooldownMs } from "./llm-runtime/rate-limit.js";
import { bumpRevision, stampFor, RUNNING_WORK } from "./resource-revision.js";
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
import { formatDurationKo } from "./format-duration.js";
import { isSubagentTool } from "./llm-runtime/subagent-tools.js";
import { createSteeringChannel } from "./steering.js";
import type { SteeringChannel, SteeringInput } from "./steering.js";
import { runSubagentStopHooks } from "./entry/hook-runner.js";

// Step 1 (2026-06-30) — 매니저 lifecycle 을 EventBus 에 발행한다. 매니저 활동(llm.activity,
// threadKey=worker:<jobId>)은 이미 버스에 흐르지만 "잡 시작/완료/실패" 상태 전이는 그동안
// worker_jobs SQLite 에만 있어 대시보드가 라이브로 못 받았다 → 백그라운드 작업 뷰의 토대.
// best-effort: 관측 발행 실패가 매니저 흐름을 무르지 않는다(원칙 3 견고성). 단방향: core
// worker → core bus(플러그인 무참조). 대시보드 등 구독자가 worker.* 를 받아 렌더.
const publishWorkerLifecycle = (
  type:
    | "worker.started"
    | "worker.done"
    | "worker.failed"
    | "worker.cancelled"
    /** 재시작으로 중단 — 부팅 복구가 발행(2026-07-29). 아래 recoverInterruptedJobs 주석 참조. */
    | "worker.interrupted",
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
    // ★리비전 스탬프 (2026-08-27 Phase 1) — 이 이벤트가 스냅샷 대비 **몇 번째 변경인가**.
    //  화면은 `event.revision === local.revision + 1` 일 때만 적용하고, 크면 스냅샷을 다시
    //  받는다. 그 한 줄이 dedup·sticky 종료·순서 가드·"replay 창 밖으로 밀린 긴 매니저" 를
    //  전부 대체한다(근거: docs/decisions/2026-08-27-frontend-architecture.md §A.4).
    //  ★발행하는 **이 자리에서 정확히 한 번** 올린다 — 두 곳에서 올리면 화면이 헛되이
    //   스냅샷을 받고, 안 올리면 조용히 안 따라온다(후자가 훨씬 나쁘다).
    const stamp = { ...stampFor(RUNNING_WORK), revision: bumpRevision(RUNNING_WORK) };
    getEventBus().publish({
      type,
      ts: Date.now(),
      payload: {
        ...stamp,
        jobId: job.jobId,
        label: job.label,
        threadKey: job.threadKey, // 어느 대화가 띄운 잡인지 상관(correlate)용.
        // 원 세션 threadKey — 서브에이전트처럼 threadKey 가 부모 *잡 좌표*인 경우를 환원한 값.
        // 대시보드 세션 스코프 필터가 이걸로 판정한다(프런트의 부분 지도 추측 제거).
        ownerThreadKey: resolveOwnerThreadKey(job.threadKey),
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
    /* noop — 관측 발행 실패가 매니저를 무르지 않는다. */
  }
};

// DB 미러는 best-effort — 영속 실패가 매니저 진행/완료를 막지 않게 격리(데몬 생존, 원칙 3).
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
 * 매니저 완료/실패 통지를 보낼 *목적지* — generic 좌표(어느 플러그인이 채웠는지 코어 무관).
 * 미지정 시 onWorkerComplete 가 job.channel/threadKey 로 폴백(텔레그램 직접 발화 매니저 회귀 0).
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
 * 잡 종류 — **표시 축**: 'worker'(매니저) | 'agent'(서브에이전트).
 * ADR 2026-07-03 subagent-worker-unify.
 *
 * ★2026-08-19 개정 — 이 타입은 **실행 의미를 더는 안 진다.**
 *  종전 문장: *"awaited 는 별 필드 아닌 kind==='agent' 파생. 배타 불변식(U-I1~U-I5):
 *  재주입·매니저타임아웃·cancel_worker·재시작 복구 통지는 'worker'만."*
 *  `spawn_agent(wait:false)` 가 그 등식을 깼다 — agent 인데 detached 인 잡이 생겼다.
 *  그 잡은 소환자가 손을 뗐으므로 재주입·취소·재시작 통지가 **전부 필요하다.**
 *
 *  그래서 U-I1~U-I5 의 판정 기준은 `kind === "worker"` 가 아니라 **`detached`** 다.
 *  (실측 위험: kind 로 두면 재시작 시 백그라운드 서브의 결과가 아무에게도 안 가고,
 *   cancel_worker 는 "부모 대화를 멈추면 정리됩니다" 라는 **거짓 안내**를 한다 —
 *   detached 엔 멈출 부모 턴이 없다.)
 *
 *  ★이 주석이 늙으면 판단이 늙는다. 같은 날 ADR 하나가 코드보다 늙어 있어서 설계
 *   선택지 하나를 잘못 차단했다 — 근거로 쓸 문장은 코드와 같이 고친다.
 */
export type WorkerJobKind = "worker" | "agent";

export interface WorkerJobRecord {
  jobId: string;
  /**
   * 잡 종류 — **표시 축**(에이전트냐 매니저냐). ★2026-08-19 이전엔 실행 의미도 겸했는데
   * `spawn_agent(wait:false)` 가 그 조합을 깼다(agent 인데 안 기다림). 실행 축은 `detached`.
   */
  kind: WorkerJobKind;
  /** **실행 축** — 소환자가 안 기다리는가. 매니저=항상 true, 서브=`wait:false` 일 때만. */
  detached: boolean;
  /** 서브에이전트 정의 이름(kind==='agent' 만) — 대시보드 라벨. */
  agentName?: string;
  /** 서브에이전트 모델 티어(high/mid/low/nano 또는 provider:model). 관측용(대시보드·/agents). */
  modelTier?: string;
  /** 사람이 읽는 짧은 이름 (완료 보고·상태 조회·로그). */
  label: string;
  /** 매니저가 수행한 자연어 작업 지시 (메인이 작성). */
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
  /**
   * 이 잡 좌표(`worker:<id>`/`agent:<id>`)에서 마지막으로 관측된 활동 시각 (ms).
   * 점검(check-in)이 "돌고 있나 멈췄나" 를 판정하는 **유일한 근거**. 미기록이면 startedAt.
   */
  lastActivityAt?: number;
  /** 정체 보고를 몇 번 했나 — 반복을 세서 "배경소음" 이 되지 않게(로그·문구에 싣는다). */
  stallReports?: number;
  /** status==="done" 시 매니저 출력 (재주입 전 — 채널 직행 절대 X, W-I1). */
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
  /** 잡 종류(**표시 축**) — 미지정=worker(회귀 안전). 'agent'=서브에이전트. */
  kind?: WorkerJobKind;
  /**
   * **실행 축** — 소환자가 안 기다리는 잡인가 (ADR 2026-08-19 Q0).
   * 매니저는 항상 true. 서브는 `spawn_agent(wait:false)` 일 때만 true.
   * 미지정 = false(awaited) — 종전 호출부 전부가 그 의미였다(회귀 0).
   */
  detached?: boolean;
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
  // 매니저는 정의상 detached — 호출부가 매번 적게 하지 않는다(적는 자리가 늘면 빠뜨린다).
  const detached = input.detached ?? kind === "worker";
  jobs.set(jobId, {
    jobId,
    kind,
    detached,
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
    lastActivityAt: startedAt,
  });
  // ★증거 레코드를 **여기서** 연다 (2026-08-22). 첫 틱에서 지연 생성하면 첫 점검이
  //  "시작 후 1주기" 가 아니라 "첫 틱 후 1주기" 에 와서, 잡마다 점검 시점이 제각각
  //  밀린다(실측: 400ms 주기에서 첫 점검이 1.1초). 기준 시각은 잡의 시작이어야 한다.
  seedCheckinEvidence(jobId, startedAt);
  startCheckinScanner(); // 점검 시계 기동(멱등 — 이미 돌면 no-op).
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
      detached,
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

/**
 * SubagentStop 훅 디스패치 (Phase 1.1, 2026-07-24) — kind==='agent' 잡의 done/failed
 * 전이에서만 발화한다. 매니저(kind==='worker', run_in_background)는 Claude Code
 * SubagentStop 시맨틱 대상이 아니라(SubagentStop = Task *서브에이전트* 종료 전용)
 * 제외(`src/core/entry/hook-runner.ts` Phase 1.1 주석 참고).
 *
 * markDone/markFailed 는 codex/openai(agent-registry.ts)·claude(claude-agent-sdk.ts)
 * 양쪽 서브에이전트 경로가 이미 수렴하는 단일 지점이라, 여기 하나만 배선하면 3어댑터
 * 대칭이 공짜로 확보된다(README "데몬에서 강제" — 새 실행 경로 0).
 *
 * fire-and-forget — markDone/markFailed 는 동기 함수라 훅 실행(셸 spawn, 최대 60s)을
 * await 하면 잡 완료 마킹·DB 미러·EventBus publish 가 그만큼 지연된다(원칙 3 위배).
 * `runSubagentStopHooks` 자체가 내부 try/catch 로 never-throw 라 미처리 rejection 없음.
 */
const dispatchSubagentStopHook = (
  job: WorkerJobRecord,
  status: "done" | "failed",
  summary: string,
): void => {
  if (job.kind !== "agent") return;
  void runSubagentStopHooks({
    jobId: job.jobId,
    agentName: job.agentName,
    threadKey: job.threadKey, // 잡을 띄운 원 대화 thread(실행 thread agent:<jobId> 아님).
    cwd: job.cwd,
    channel: job.channel,
    status,
    // publishWorkerLifecycle 의 result/error cap(1200/300) 과 별개 — 훅 stdin payload 는
    // 셸 프로세스로 나가는 텍스트라 관대하게, 단 무바운드는 피한다(이벤트 바운드 원칙).
    summary: summary.slice(0, 2000),
  });
};

/** 매니저 성공 — 결과 기록. 재주입(채널 보고)은 onWorkerComplete 가 별도 수행. */
export const markDone = (jobId: string, result: string): void => {
  const job = jobs.get(jobId);
  if (job === undefined) return;
  // 취소는 terminal·sticky (U-I4 개정 2026-07-17) — 늦게 도착한 완료가 사용자 취소를
  // 못 뒤집는다. worker 경로는 onWorkerComplete 의 existing?.status==="cancelled" 가드와
  // 중복이나 무해; agent 직접호출(agent-registry.ts) 경로엔 이 가드가 유일 방어선이다.
  if (job.status === "cancelled") return;
  job.status = "done";
  job.result = result;
  job.finishedAt = Date.now();
  persistSafe("markDone", () =>
    updateWorkerJobStatus(jobId, "done", job.finishedAt!),
  );
  dropCheckinEvidence(jobId);
  pruneTerminalJobsSafe(); // 터미널 전이 — worker_jobs 캡(P1, running 은 위 UPDATE 대상 아님).
  publishWorkerLifecycle("worker.done", job, { task: job.task, result });
  dispatchSubagentStopHook(job, "done", result); // Phase 1.1 — agent kind 만(no-op for worker).
};

/**
 * 실패 분류 — **통지와 로그가 같은 판정을 쓴다** (2026-08-12). 두 곳이 각자 정규식을
 * 가지면 화면과 로그가 다른 말을 하고, 그러면 원격 진단이 다시 추론이 된다.
 */
export const classifyFailure = (raw: string): string =>
  /wall-clock 상한|매니저 처리 시간 초과/i.test(raw)
    ? "wall-clock상한"
    : /도구 .*안 끝나|tool-hang/i.test(raw)
      ? "도구상한"
      : /유휴 타임아웃|idle timeout|first timeout/i.test(raw)
        ? "유휴(무응답)"
        : isRateLimited(raw)
          ? "사용량한도"
          : /server_is_overloaded|overloaded/i.test(raw)
            ? "백엔드과부하"
            : /취소|cancel/i.test(raw)
              ? "취소"
              : "기타";

/** 매니저 실패/타임아웃 — 원인 기록. */
export const markFailed = (jobId: string, error: string): void => {
  const job = jobs.get(jobId);
  if (job === undefined) return;
  // 취소는 terminal·sticky (U-I4 개정 2026-07-17) — 늦게 도착한 실패가 사용자 취소를
  // 못 뒤집는다. worker 경로는 onWorkerComplete 의 existing?.status==="cancelled" 가드와
  // 중복이나 무해; agent 직접호출(agent-registry.ts) 경로엔 이 가드가 유일 방어선이다.
  if (job.status === "cancelled") return;
  job.status = "failed";
  job.error = error;
  job.finishedAt = Date.now();
  // ★실패를 **로그만으로 진단할 수 있게** (2026-08-12, 사용자: "확실하게 로그를 심어보자").
  //  종전엔 실패가 이벤트·DB 로만 남아, 원격 기계(회사 PC 는 접속 불가)에서 신고가 오면
  //  "무슨 에러였나" 를 추론으로 다뤄야 했다. 한 줄에 **판정 재료**를 싣는다.
  console.error(
    `[job-failed] '${job.label}' (${job.kind}:${jobId}) — ${Math.round(
      (job.finishedAt - job.startedAt) / 1000,
    )}s 실행 후 실패 · 분류=${classifyFailure(error)} · thread=${job.threadKey} · 원인=${error.slice(0, 300)}`,
  );
  persistSafe("markFailed", () =>
    updateWorkerJobStatus(jobId, "failed", job.finishedAt!),
  );
  dropCheckinEvidence(jobId);
  pruneTerminalJobsSafe(); // 터미널 전이 — worker_jobs 캡(P1).
  publishWorkerLifecycle("worker.failed", job, { error, task: job.task });
  dispatchSubagentStopHook(job, "failed", error); // Phase 1.1 — agent kind 만(no-op for worker).
};

/**
 * 매니저 취소 마킹 — 사용자 명시 취소(타임아웃과 구분, 별도 status). worker_jobs DB
 * status 는 TEXT 라 자유. 통지 문구는 onWorkerComplete 가 status 로 분기.
 */
/**
 * **연쇄 취소** 사유 — 사용자가 이 잡을 직접 고른 게 아니라, 위가 끊겨서 같이 끊긴 것.
 *
 * ★알림 판정에 쓴다. 사용자는 매니저 **하나**를 중지했는데 그 밑 자식 수만큼 알림이 오면
 *  안 된다(실측: 자식 2 → 알림 3번). `wait:false` 이전엔 서브가 완료 통지를 안 타서
 *  1번이었으므로 이건 회귀다. 부모의 알림 하나가 그 사건 전체를 설명한다.
 *
 * ★문자열을 손으로 비교하지 않게 상수로 둔다 — 사유 문구를 고치면 알림이 조용히 늘어난다.
 */
/**
 * 정체 판정으로 점검이 끊은 잡의 사유.
 *
 * ★`CASCADE_CANCEL_REASONS` 에 **같이 넣는다** — 그 목록의 뜻은 "연쇄" 가 아니라
 *  *"완료 경로가 따로 통지하지 말 것"* 이다(사용자가 이미 아는 사실이라서). 정체 중단도
 *  같다: 점검이 **자기 손으로 보고**하고, 그 보고엔 완료 경로가 못 담는 것(왜 끊었는지 ·
 *  재개할지 소환자가 고르라는 안내)이 들어간다. 두 곳이 각자 말하면 한 사건에 알림이 둘이다.
 */
export const STALL_CANCEL_REASON = "점검에서 정체로 판정돼 중단됨";

export const CASCADE_CANCEL_REASONS = [
  "상위 작업이 취소됨",
  "상위 대화가 중단됨",
  STALL_CANCEL_REASON,
] as const;

/** 이 잡이 **연쇄로** 취소됐나(사용자가 직접 고른 게 아니라). */
export const isCascadeCancelled = (job: {
  status: WorkerJobStatus;
  error?: string;
}): boolean =>
  job.status === "cancelled" &&
  job.error !== undefined &&
  (CASCADE_CANCEL_REASONS as readonly string[]).includes(job.error);

export const markCancelled = (jobId: string, reason: string): void => {
  const job = jobs.get(jobId);
  if (job === undefined) return;
  job.status = "cancelled";
  job.error = reason;
  job.finishedAt = Date.now();
  persistSafe("markCancelled", () =>
    updateWorkerJobStatus(jobId, "cancelled", job.finishedAt!),
  );
  dropCheckinEvidence(jobId);
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
  /**
   * **이 세션이 띄운 잡만** (잡 좌표는 원 세션으로 환원 — 손자 포함).
   *
   * ★왜 필요한가 (2026-07-29 사용자 신고): 잡 레코드에는 띄운 세션의 threadKey 가
   *  처음부터 실려 있는데 **읽는 쪽이 그걸 안 썼다.** 그래서 `list_workers` 가 전 세션의
   *  잡을 돌려줬고, 메인 비서는 다른 세션에서 도는 general 매니저를 보고 "이전 매니저가 실행
   *  중" 이라고 판단했다. 게다가 비서는 자기 세션 id 조차 몰라(컨텍스트 블록에 없었다)
   *  남의 것인지 구분할 수단도 없었다. 미지정 = 전체(대시보드·브리지는 전역이 맞다).
   */
  ownerThreadKey?: string;
}

/**
 * 잡 좌표(`worker:`/`agent:<jobId>`)를 **원 세션 threadKey** 로 환원. 이미 세션 키면 그대로.
 *
 * ★서버가 환원한다 (2026-07-28). 서브에이전트의 threadKey 는 자기를 띄운 *부모 잡 좌표*라
 *  세션 키가 아니다. 종전엔 대시보드가 자기 화면에 렌더된 카드 지도만 보고 부모를 거슬러
 *  올라갔는데, 그 지도는 부분집합이라(부모 카드가 안 그려졌거나 replay 창 밖이면 없음)
 *  환원 실패 → "소속 미상" → 미상을 노출로 처리해 **다른 세션에서도 진행 중으로 보였다**
 *  (사용자 신고 2회). 여기 `jobs` 는 런타임 진실 소스(전체)라 환원이 정확하다.
 *
 * 부모 체인을 따라 올라가며(서브에이전트가 서브에이전트를 띄운 경우) 자기참조·순환은 끊는다.
 * 못 찾으면 ""(미상) — 호출자가 정책을 정한다. jobs 는 수십 개 규모라 조회 비용 무시.
 */
/**
 * **직속 소환자**의 jobId — 이 좌표에서 도는 것을 누가 띄웠나. 세션이 띄웠으면 `undefined`.
 *
 * ★필드가 아니라 **파생**이다. 잡이 실행되는 좌표(`worker:<부모>` / `agent:<부모>`)가 곧
 *  부모 기록이므로, `parentJobId` 컬럼을 따로 두면 같은 사실의 두 번째 소유자가 생겨
 *  갈릴 수 있다(손으로 관리하는 목록과 같은 부류). 규약을 읽는 자리를 하나로 모은다 —
 *  종전엔 `resolveOwnerThreadKey`·`directChildJobs` 가 **같은 정규식을 각자** 갖고 있었다.
 */
export const parentJobIdOf = (threadKey: string): string | undefined => {
  if (typeof threadKey !== "string") return undefined;
  const m = /^(?:worker|agent):(.+)$/.exec(threadKey);
  return m === null ? undefined : m[1];
};

// ─── 잡 점검(check-in) — **증거를 모아 소환자에게 넘긴다** (2026-08-22) ─────────────
//
// ★두 번 뒤집힌 자리다. ①원래는 wall-clock **kill** 이었다(2시간이면 죽인다). ②그걸
//  "죽이지 않고 침묵을 보고" 로 바꿨다. ③그런데 그것도 여전히 **코어가 판정**하고 있었다 —
//  `침묵 2회 = 죽인다` 는 정적 규칙을 내가 새로 만든 것이고, 그건 사용자가 소환자에게
//  맡기라고 한 판단을 코드가 가로챈 것이다([[feedback_capability_not_routing]]).
//
//  사용자: *"시간제한을 걸으라는 건 소환자가 소환 대상이 별문제가 없는지 확인해보는
//  시간이면 어떨까"* · *"재개는 소환자가 선택"* · *"감사 주체는 언제나 소환자"*.
//
// ★그리고 **침묵은 '잘 돌고 있는지'의 답이 아니다.** 그건 기계가 움직이는지만 본다:
//   · 3시간짜리 정상 도구 → 조용하다 → 정체로 **오판**
//   · 같은 일을 반복하는 런어웨이 → 시끄럽다 → 건강하다고 **오판**(이 레포가 겪은 사고다)
//  그래서 여기서는 판정하지 않는다. **증거를 모아서 넘긴다** — 무슨 도구를 몇 번 썼나,
//  지금 진행 중인 도구가 있나(있으면 몇 분째), 마지막 산출물이 뭔가, 얼마나 조용한가.
//  긴 도구 오판도 휴리스틱 면제 없이 사라진다: 증거에 "Bash 3시간째 진행 중" 이 실리면
//  소환자가 읽고 "정상, 계속" 이라고 판단한다. 추측하던 것을 **보여주고 판단시킨다**.
//
// ★자동 종료가 남는 자리는 하나다: **판단할 소환자가 아무도 없을 때.** 매니저도 없고
//  (배달 실패) 완전 침묵인 채로 두 주기가 지나면 그건 "애매" 가 아니라 "아무도 안 거두는
//  잡" 이라 근거가 선다. 그 외에 죽이는 수단은 소환자에게 있다(`cancel_worker`).

/** 한 주기 동안 그 잡이 무엇을 했나 — 점검이 넘기는 **증거**. */
interface CheckinEvidence {
  /** 이번 주기의 도구 활동 건수(phase start+end 각각 1건이라 실제 도구 수의 ~2배). */
  toolEvents: number;
  /** 이번 주기의 텍스트 산출 건수. */
  textEvents: number;
  /** 마지막으로 본 도구 이름. */
  lastTool?: string;
  /**
   * 아직 안 끝난 도구 — **호출 단위** 키(`seq`, 없으면 이름 폴백) → `{tool, at}`.
   *
   * ★종전엔 **도구 이름**으로 키잉했다. 그러면 같은 도구를 병렬로 부를 때(흔하다) 하나만
   *  끝나도 항목이 통째로 지워져 `inFlight` 가 빈다 — 실측: `Bash` 2개 중 1개 종료 →
   *  `inFlight=[]`. 그 결과 점검 증거에 **"이번 주기에 아무 활동도 없었습니다"** 가 실려
   *  소환자에게 가고, 소환자는 **돌고 있는 자식을 취소한다.**
   *  이 릴리스의 전제가 "판정 말고 증거를 넘긴다" 인데 그 증거가 조용히 거짓이었다.
   *  `seq` 는 어댑터가 도구 start/end 를 잇는 호출 식별자다(claude `timing.seq`,
   *  codex `callIdToSeq`) — 그게 곧 호출의 정체다.
   */
  inFlight: Map<string, { tool: string; at: number }>;
  /** 마지막 활동 시각. */
  lastActivityAt: number;
  /** 다음 점검까지 미룬 시각(주기 계산 기준). */
  lastCheckinAt: number;
  /** 점검 회차. */
  rounds: number;
}

const evidence = new Map<string, CheckinEvidence>();

/**
 * 잡이 터미널(done/failed/cancelled)로 가면 증거를 버린다.
 *
 * ★없으면 샌다 (2026-08-23 발견). 종전엔 지우는 곳이 자동 종료 경로 하나뿐이었고, 틱은
 *  `running` 잡만 훑으니 끝난 잡의 항목을 다시 볼 일이 없었다. 유일한 정리 시점이
 *  `stopCheckinScanner` 의 `clear()` 인데 그건 **돌고 있는 잡이 0** 이어야 온다 — 잡이
 *  끊이지 않는 인스턴스에선 영영 안 온다. `jobs` 맵엔 `pruneTerminalJobsSafe` 캡이 있는데
 *  이쪽만 없었다([[project_hotpath_bound_preserve_record]] — 바운드 없는 자리는 결국 샌다).
 *  dev 는 잡이 띄엄띄엄이라 자주 clear 돼 안 드러났고, 회귀 프로브도 짧아 못 잡았다.
 *
 * ★터미널 전이 **단일 지점**(`pruneTerminalJobsSafe` 옆)에 붙인다 — 마킹 함수마다 따로
 *  적으면 넷째가 생길 때 빠진다.
 */
const dropCheckinEvidence = (jobId: string): void => {
  evidence.delete(jobId);
};

/** 잡 등록 시 증거 레코드를 연다 — 점검 기준 시각 = 잡 시작. */
const seedCheckinEvidence = (jobId: string, startedAt: number): void => {
  evidence.set(jobId, freshEvidence(startedAt));
};

const freshEvidence = (now: number): CheckinEvidence => ({
  toolEvents: 0,
  textEvents: 0,
  inFlight: new Map(),
  lastActivityAt: now,
  lastCheckinAt: now,
  rounds: 0,
});

/** 점검 시계 — 잡이 하나라도 돌 때만 산다(유휴 타이머 0). */
let checkinTimer: ReturnType<typeof setInterval> | undefined;
/** 활동 구독 해제자 — 시계와 생명주기를 같이 한다. */
let activityUnsub: (() => void) | undefined;

/**
 * 점검 틱 간격 — 주기의 1/4(최소 1s, 최대 60s). 주기 자체로 틱하면 최대 2배까지 늦게
 * 발견하므로 잘게 본다. unref 라 프로세스 종료를 막지 않는다.
 */
const checkinTickMs = (): number =>
  Math.max(1_000, Math.min(60_000, Math.floor(asFiniteTimeoutMs(JOB_CHECKIN_INTERVAL_MS) / 4)));

/** 증거를 사람이·모델이 읽는 한 문단으로. 판정 문장은 **넣지 않는다**(그건 소환자 몫). */
const describeEvidence = (job: WorkerJobRecord, ev: CheckinEvidence, now: number): string => {
  const lines: string[] = [];
  lines.push(`· 시작 이후: ${formatDurationKo(now - job.startedAt)}`);
  lines.push(
    `· 마지막 활동 이후: **${formatDurationKo(now - ev.lastActivityAt)}** (점검 주기 ${formatDurationKo(JOB_CHECKIN_INTERVAL_MS)})`,
  );
  lines.push(
    `· 직전 주기 활동: 도구 이벤트 ${ev.toolEvents}건 · 텍스트 ${ev.textEvents}건`,
  );
  if (ev.lastTool !== undefined) lines.push(`· 마지막 도구: \`${ev.lastTool}\``);
  if (ev.inFlight.size > 0) {
    const items = [...ev.inFlight.values()]
      .map((f) => `\`${f.tool}\`(${formatDurationKo(now - f.at)}째)`)
      .join(", ");
    lines.push(`· **진행 중인 도구**: ${items} — 안 끝났을 뿐 멈춘 게 아닐 수 있습니다`);
  } else if (ev.toolEvents === 0 && ev.textEvents === 0) {
    lines.push(`· **이번 주기에 아무 활동도 없었습니다**`);
  }
  return lines.join("\n");
};

/**
 * 점검 한 건을 **소환자에게** 넘긴다 — 직속 소환자가 먼저, 없으면 위로.
 *
 * ★사용자 지적: *"1회차 무활동을 측정했다는 건 그 측정한 주체가 소환자인 거잖아."* 그래서
 *  배달도 소환 관계를 탄다. 처음엔 전역 스캐너가 사용자에게 직접 쐈는데, 그러면 `worker:<id>`
 *  좌표가 미배달로 떨어지거나 남의 집 사정이 사용자에게 간다.
 *
 * @returns **판단할 소환자**(도는 매니저 또는 메인 비서)가 받았으면 true.
 *          아무도 못 받으면(핸들러 부재·재주입 실패 → raw 직행) false.
 *
 * ★이 값의 뜻을 오해하면 안 된다 (2026-08-23 적대 검토 F3). false 는 "아무도 판단할 수
 *  없다" 가 **아니다** — 사용자가 직접 시킨 백그라운드 작업은 부모가 세션이라 **항상**
 *  false 이고(가장 흔한 경로), 그건 사람이 보고를 받았다는 뜻이다. 종전엔 이 값을 그대로
 *  자동 종료 조건으로 써서, 사용자에게 "판단해 주세요" 라고 물어놓고 두 주기 뒤
 *  **"판단을 넘길 소환자도 없었습니다"** 라며 죽였다 — 방금 물어본 상대에게 하는 거짓말이다.
 */
const deliverCheckin = async (
  job: WorkerJobRecord,
  body: string,
): Promise<boolean> => {
  const parentId = parentJobIdOf(job.threadKey);
  if (parentId !== undefined) {
    const parent = jobs.get(parentId);
    if (parent !== undefined && parent.status === "running") {
      // ★`resetStallClock: false` — 이건 **개입이 아니라 시스템 독백**이다 (2026-08-23
      //  2라운드 F2). 종전엔 배달 성공이 곧 부모의 `stallReports=0` + 앵커 리셋이라,
      //  자식이 하나라도 붙어 있으면 **부모의 무활동 시계가 영구히 0에 고정**됐다(실측:
      //  자식 있으면 5주기 내내 parent stall=0 / 없으면 2주기에 정리). 굳은 매니저 +
      //  굳은 자식 조합이 그물을 통째로 빠져나갔다. 시계를 미룰 권리는 **판단을 준 쪽**
      //  (`steer_worker` 도구)에만 있다.
      const r = steerJob(
        parentId,
        { text: body, raw: body, ts: Date.now() },
        { resetStallClock: false },
      );
      if (r === "delivered") {
        console.log(
          `worker-jobs: '${job.label}' 점검을 소환자 매니저 ${parentId} 에게 전달 — 다음 model-call 경계에서 판단`,
        );
        return true;
      }
      console.warn(
        `worker-jobs: '${job.label}' 점검을 소환자 ${parentId} 에게 못 넣음(${r}) — 상위로 올린다`,
      );
    }
  }
  // ② 소환자가 **메인 비서**면 메인 비서에게 (2026-08-23 사용자 지적으로 고침).
  //
  //  ★"세션이 띄운 잡은 말 그대로 메인 비서가 소환자 아니야?" — 맞다. `run_in_background`
  //   를 부른 게 그 비서다. 그런데 종전엔 이 경로가 `notifyJobOwner`(LLM 미경유 raw)로
  //   **사용자에게 직행**해서, 자기가 띄운 잡의 점검을 정작 소환자가 보지 못했다.
  //   "감사 주체는 언제나 소환자" 라는 원칙이 이 자리에서만 깨져 있었다.
  //  완료 통지(`onWorkerComplete`)가 이미 같은 판단을 한다 — done 은 메인 재주입, 실패는
  //  raw 직행. 점검도 그 배관을 그대로 쓴다(새 경로 0).
  const owner = resolveOwnerThreadKey(job.threadKey);
  const reportJob =
    owner !== "" && owner !== job.threadKey ? { ...job, threadKey: owner } : job;
  //  ★그런데 "그 배관을 쓴다" 고 적어놓고 **실제로는 안 썼다** (2026-08-23 2라운드 F1).
  //   종전엔 `{channel, channelUserId, threadKey, text}` 넉 장만 넘기고 `as never` 로
  //   컴파일러를 눌렀다. 라이브 귀결을 프로브로 재현하면 이렇다:
  //     ⓐ `synthetic` 이 없어 점검 전문이 `channel.message.in` 으로 발행 → chat_log 에
  //        **사용자가 친 말**로 영속(대시보드에 "나" 버블로 남는다)
  //     ⓑ LLM 턴이 실제로 돌고(비용·도구), 끝에서 `msg.reply` 가 없어 TypeError →
  //        **모델의 판단이 통째로 버려진다**
  //     ⓒ 그 throw 를 여기서 잡아 raw 로 직행하며 `false` 를 반환 → 자동 종료가 여전히
  //        무장 → 두 주기 뒤 "중단했습니다". 사용자에겐 같은 일로 알림이 **세 번** 간다
  //   `as never` 를 떼면 `tsc` 가 즉시 `receivedAt`·`reply` 누락을 짚는다 — 그게 이 결함을
  //   처음부터 막았을 검사다. 계약을 눌러 끄지 말고 **채운다**.
  const dest = destForJob(reportJob);
  // ★완료 통지는 여기서 `delivered` 를 추적해 **raw 안전망**을 건다. 점검엔 그게 없다 —
  //  일부러다. 점검은 "계속 둘 만하면 아무 말도 안 해도 된다" 가 설계이므로 침묵이 정상
  //  이고, 안전망을 걸면 소환자가 침묵을 택할 때마다 사용자에게 raw 가 나간다.
  //  종전엔 `delivered` 플래그와 래퍼가 있었지만 **읽는 곳이 없었다**(2026-08-23 3라운드)
  //  — 안전망이 있는 것처럼 읽히는 죽은 코드다. 없앤다. 없는 것은 없다고 적는다.
  const reinjectReply = reacquireReply(dest, { observe: false });
  // 세션-정체성 정규화 — 완료 재주입(`onWorkerComplete`)과 같은 규칙. 없으면 telegram發 잡의
  // 점검 턴이 사용자 실세션과 다른 정체성으로 돌아 resume/transcript 가 갈린다.
  const idChannel = canonicalSessionChannel(reportJob.threadKey, reportJob.channel);
  const handler = mainHandler;
  if (handler !== undefined) {
    try {
      await handler({
        channel: reportJob.channel,
        channelUserId: reportJob.channelUserId,
        threadKey: reportJob.threadKey,
        ...(idChannel !== reportJob.channel
          ? {
              session: {
                explicitSessionId: reportJob.threadKey,
                ...(dest.target !== null ? { channelAddress: dest.target } : {}),
              },
            }
          : {}),
        // ★`synthetic: true` 가 두 가지를 동시에 닫는다: ①관측 발행 스킵(가짜 "나" 버블)
        //  ②`steerable(msg)` 가 false — 없으면 점검이 사용자의 **진행 중 턴에 끼어드는**
        //  steering 메시지가 된다(F1b). 같은 커밋 주석이 매니저 경로에서 금지한 그 동작을
        //  세션 경로에서 새로 만들 뻔했다. 게다가 "사용자가 마침 턴 중인가" 로 갈려
        //  비결정적이었다.
        synthetic: true,
        receivedAt: Date.now(),
        reply: reinjectReply,
        // ★점검 재주입도 같은 좌표로 나간다 — 중복 차단 대상.
        replyTarget: { channel: dest.channel, target: dest.target ?? null },
        text:
          `[백그라운드 작업 점검] 당신이 띄운 작업의 상태입니다. 그대로 옮기지 말고, 맥락을 ` +
          `아는 당신이 판단해 **필요할 때만** 당신 인격으로 알리세요 — 계속 둘 만하면 아무 말도 ` +
          `안 해도 됩니다. 그만둘 값이면 \`cancel_worker\`, 방향을 바꿀 거면 \`steer_worker\` ` +
          `(지시를 주면 점검 시계가 초기화됩니다).\n\n${body}`,
      });
      return true; // 메인 비서가 판단 중 — 코어는 안 죽인다.
    } catch (e) {
      console.error(
        `worker-jobs: 점검 재주입 실패 (job='${job.label}' ${job.jobId}): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }
  // ③ 메인 핸들러조차 없다(부팅 전·재주입 실패) → raw 안전망. 여기까지 오면 판단할 상대가
  //    **실제로** 없다는 뜻이라, 자동 종료 판정의 입력이 된다.
  await notifyJobOwner(reportJob, body);
  return false;
};

/**
 * 한 틱 — 주기가 된 잡마다 **증거를 모아 소환자에게 넘긴다.** 잡이 없으면 시계를 끈다.
 *
 * 여기서 하는 판정은 딱 하나뿐이고 그것도 좁다: 완전 침묵 + 판단할 소환자 없음 + 2주기 →
 * 종료. 나머지는 전부 소환자가 정한다.
 */
const checkinTick = (): void => {
  const now = Date.now();
  const running = [...jobs.values()].filter((j) => j.status === "running");
  if (running.length === 0) {
    stopCheckinScanner();
    return;
  }
  if (!Number.isFinite(JOB_CHECKIN_INTERVAL_MS)) return; // 점검 꺼짐(env=off).
  for (const job of running) {
    let ev = evidence.get(job.jobId);
    if (ev === undefined) {
      // 재시작 복구 등으로 레코드가 없으면 지금부터 센다(오탐 0 — 곧바로 점검하지 않는다).
      ev = freshEvidence(now);
      evidence.set(job.jobId, ev);
      continue;
    }
    // ★마감의 기준은 **마지막 활동**이지 마지막 점검이 아니다 (2026-08-23 사용자 결정).
    //  점검 시점으로 잡으면 잘 돌고 있는 잡도 주기마다 깨운다 — 그리고 소환자가 매니저면
    //  그 보고가 steering 큐로 들어가 **하던 일을 끊는다**(알림이 아니라 개입이 된다).
    //  정상 작업을 시계로 죽이는 걸 없앴는데 정상 작업의 흐름을 시계로 끊으면 같은 부류다.
    //  활동이 있으면 마감이 계속 밀리므로 **건강한 잡은 점검에 아예 안 걸린다.**
    //  사용자: *"잘 돌고 있는 상황을 이상하게 판단하면 안 되잖아 … 문제가 없으면 마지막
    //  시간 기준으로 다시 잡을 수 있는 거 아니야?"*
    if (now - ev.lastActivityAt < JOB_CHECKIN_INTERVAL_MS) continue;

    ev.rounds += 1;
    const silent = ev.toolEvents === 0 && ev.textEvents === 0 && ev.inFlight.size === 0;
    const detail = describeEvidence(job, ev, now);
    const kindLabel = job.kind === "agent" ? "서브에이전트" : "매니저";
    const name = job.kind === "agent" ? (job.agentName ?? job.label) : job.label;

    const idleMs = now - ev.lastActivityAt;
    job.lastActivityAt = ev.lastActivityAt;
    job.stallReports = silent ? (job.stallReports ?? 0) + 1 : 0;
    // 다음 주기 시작 — 카운터만 접고 진행 중 도구는 **이월**한다(아직 안 끝났으므로).
    // ★앵커(`lastActivityAt`)는 **now 로 민다**. 안 그러면 조용한 잡이 매 틱마다 조건을
    //  다시 만족해 같은 보고를 60초마다 쏟는다(배경소음). 실제 활동이 오면 구독이
    //  다시 갱신하므로 정보를 잃지도 않는다.
    const carried = new Map(ev.inFlight);
    const next = freshEvidence(now);
    next.inFlight = carried;
    next.rounds = ev.rounds;
    next.lastTool = ev.lastTool;
    evidence.set(job.jobId, next);

    console.log(
      `[job-checkin] '${job.label}' (${job.kind}:${job.jobId}) ${ev.rounds}회차 · ` +
        `도구 ${ev.toolEvents} 텍스트 ${ev.textEvents} 진행중 ${ev.inFlight.size} · ` +
        `무활동 ${formatDurationKo(now - ev.lastActivityAt)} · thread=${job.threadKey}`,
    );

    void (async (): Promise<void> => {
      const body =
        `🔎 **점검** — ${kindLabel} \`${name}\` 가 ${formatDurationKo(now - job.startedAt)} 돌고 있습니다 (${ev.rounds}회차).\n` +
        `작업: ${job.task.slice(0, 200)}\n${detail}\n` +
        `계속 둘지, 지시를 더 줄지, 그만둘지(\`cancel_worker\`) 판단해 주세요.\n` +
        `그대로 두고 계속 조용하면 다음 점검에서 중단합니다 — **지시를 한 번 주면 그 시계가 초기화됩니다.**`;
      const summonerJudging = await deliverCheckin(job, body);

      // ★자동 종료 조건 (2026-08-23 적대 검토 F3 으로 고침).
      //  ①완전 침묵 ②**돌고 있는 매니저가 판단 중이 아님** ③N주기.
      //
      //  ★②의 뜻이 바뀌었다. 종전엔 "소환자 없음" 으로 읽고 사람에게 올라간 경우까지
      //   포함시켰는데, 사용자가 직접 시킨 작업은 부모가 세션이라 **항상** 그 경우다 —
      //   즉 가장 흔한 경로에서 자동 종료가 무장돼 있었고, "판단을 넘길 소환자도
      //   없었습니다" 라는 **거짓 문구**까지 나갔다(방금 그 사람에게 물어봤으면서).
      //   이제 매니저가 자기 턴에서 판단 중이면 코어는 안 죽이고, 그 외엔 죽이되
      //   **사실대로 말한다**(누가 없어서가 아니라 그동안 아무 일도 없어서).
      //  ★사용자가 개입하면(`steer_worker`) 카운터가 리셋된다 — 아래 `steerJob` 참조.
      //   종전엔 "계속 둬" 라고 답해도 되돌릴 수단이 없었다.
      if (
        !summonerJudging &&
        silent &&
        (job.stallReports ?? 0) >= STALL_KILL_AFTER_CHECKINS &&
        job.status === "running"
      ) {
        const quiet = formatDurationKo((job.stallReports ?? 0) * JOB_CHECKIN_INTERVAL_MS);
        console.warn(
          `[job-checkin] '${job.label}' (${job.jobId}) — 완전 침묵 ${job.stallReports}주기(${quiet}) → **자동 종료**`,
        );
        cancelDescendants(job.jobId, new Set([job.jobId]));
        markCancelled(job.jobId, STALL_CANCEL_REASON);
        const hook = cancelHooks.get(job.jobId);
        if (hook !== undefined) hook();
        evidence.delete(job.jobId);
        await notifyJobOwner(
          job,
          `🛑 ${kindLabel} \`${name}\` 를 **중단했습니다** — ${quiet} 동안 아무 활동이 없었습니다.\n` +
            `작업: ${job.task.slice(0, 200)}\n` +
            `이어서 할지, 처음부터 다시 할지 알려주시면 그대로 하겠습니다.`,
        );
      }
    })().catch((e: unknown) => {
      console.error(
        `worker-jobs: 점검 처리 실패 (job='${job.label}' ${job.jobId}): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    });
  }
};

/** 점검 시계 기동 — 멱등. 첫 잡 등록 때 불린다. */
const startCheckinScanner = (): void => {
  if (checkinTimer !== undefined) return;
  if (!Number.isFinite(JOB_CHECKIN_INTERVAL_MS)) return; // 점검 꺼짐 — 시계 자체를 안 만든다.
  activityUnsub = getEventBus().subscribe((ev) => {
    if (ev.type !== "llm.activity") return;
    const p = ev.payload as
      | { threadKey?: unknown; kind?: unknown; phase?: unknown; label?: unknown; seq?: unknown }
      | undefined;
    if (typeof p?.threadKey !== "string") return;
    const id = parentJobIdOf(p.threadKey);
    if (id === undefined) return;
    const job = jobs.get(id);
    if (job === undefined || job.status !== "running") return;
    const now = Date.now();
    job.lastActivityAt = now;
    let rec = evidence.get(id);
    if (rec === undefined) {
      rec = freshEvidence(now);
      evidence.set(id, rec);
    }
    rec.lastActivityAt = now;
    if (p.kind === "tool") {
      rec.toolEvents += 1;
      const label = typeof p.label === "string" ? p.label : "(이름 없음)";
      rec.lastTool = label;
      // ★진행 중 도구를 센다 — 이게 "조용한데 정상" 을 구별해 주는 유일한 신호다.
      //  start 만 오고 end 가 안 오면 그 도구를 **하는 중**이다(멈춘 게 아니다).
      //  ★키는 **호출 식별자**(`seq`)다 — 이름이면 병렬 동일 도구가 서로를 지운다.
      const callKey = typeof p.seq === "number" ? `#${p.seq}` : `name:${label}`;
      if (p.phase === "start") rec.inFlight.set(callKey, { tool: label, at: now });
      else if (p.phase === "end") rec.inFlight.delete(callKey);
    } else if (p.kind === "text") {
      rec.textEvents += 1;
    }
  });
  checkinTimer = setInterval(checkinTick, checkinTickMs());
  (checkinTimer as { unref?: () => void }).unref?.();
};

/** 점검 시계 정지 — 돌고 있는 잡이 0이 되면 스스로 끈다(유휴 타이머·구독 누수 0). */
const stopCheckinScanner = (): void => {
  if (checkinTimer !== undefined) clearInterval(checkinTimer);
  checkinTimer = undefined;
  if (activityUnsub !== undefined) {
    try {
      activityUnsub();
    } catch {
      /* best-effort */
    }
  }
  activityUnsub = undefined;
  evidence.clear();
};

/**
 * 이 잡이 지금 무엇을 하고 있나 — **사용자가 물어볼 때** 답할 재료.
 *
 * ★점검(check-in)은 이제 조용한 잡에만 나간다(마감이 마지막 활동 기준). 그래서 "잘 돌고
 *  있나?" 를 사용자가 궁금해하는 순간엔 아무 통지도 없다 — 그때 답할 것이 필요하다.
 *  점검이 쓰는 것과 **같은 증거**를 읽는다(두 번째 계측을 만들지 않는다).
 */
export const getJobActivity = (
  jobId: string,
): { lastActivityAt: number; inFlight: { tool: string; since: number }[] } | undefined => {
  const ev = evidence.get(jobId);
  if (ev === undefined) return undefined;
  return {
    lastActivityAt: ev.lastActivityAt,
    // 호출 단위 키는 내부 사정이라 밖으로 안 낸다 — 소비처가 원하는 건 "무슨 도구가 언제부터".
    inFlight: [...ev.inFlight.values()].map((f) => ({ tool: f.tool, since: f.at })),
  };
};

/** 검사 전용 — 증거 맵 크기(누수 검사). */
export const __checkinEvidenceSizeForTest = (): number => evidence.size;

/** 검사 전용 — 틱을 즉시 한 번 돌린다(시계를 기다리지 않게). */
export const __checkinTickForTest = (): void => checkinTick();

export const resolveOwnerThreadKey = (
  threadKey: string,
  seen?: Set<string>,
): string => {
  if (typeof threadKey !== "string" || threadKey === "") return "";
  const id = parentJobIdOf(threadKey);
  if (id === undefined) return threadKey; // 세션 키 — 환원 끝.
  const s = seen ?? new Set<string>();
  if (s.has(id)) return ""; // 자기참조/순환 — 미상으로 닫는다.
  s.add(id);
  const parent = jobs.get(id);
  return parent !== undefined ? resolveOwnerThreadKey(parent.threadKey, s) : "";
};

/**
 * 잡 목록 — list_workers 도구(region)가 사용. startedAt 내림차순(최신 먼저).
 * 레코드 복사본 반환(외부 변조 방지, 레지스트리 단일 진실).
 */
/**
 * `cancel_worker` / `steer_worker` 의 **대상 선택** — 지금 돌고 있는 detached 잡 중 하나.
 *
 * ★함수로 뽑은 이유: 이 판정이 두 도구에 **6번 복제**돼 있었다(label 조회 · 다른 세션
 *  확인 · job_id 조회 × 2도구). 복제된 판정은 갈린다 — 실제로 `detached` 축을 도입하면서
 *  6곳을 전부 고쳐야 했고, 하나라도 빠졌으면 "취소는 되는데 스티어는 안 되는" 식으로
 *  조용히 어긋났을 것이다. 겸해서 **검사 가능**해진다: 종전엔 판정이 MCP 핸들러 안에만
 *  있어서 회귀가 필터를 스스로 재구현할 수밖에 없었고, 그 검사는 진짜 코드를 안 지켰다
 *  (변이 검사에서 그대로 생존했다).
 *
 * @param scope 소환자 세션 — 지정 시 그 세션 소속만. `""` = 전역(다른 세션 확인용).
 */
export const findTargetableJob = (q: {
  label?: string;
  jobId?: string;
  scope?: string;
}): WorkerJobRecord | undefined => {
  const running = listJobs({
    runningOnly: true,
    ...(q.scope !== undefined && q.scope !== "" ? { ownerThreadKey: q.scope } : {}),
  });
  // ★`detached` 로 고른다(`kind === "worker"` 아님). 근거는 "독립 백그라운드 잡인가" 이고,
  //  백그라운드 서브에이전트가 바로 그것이다 — 부모 턴이 없으니 직접 멈춰야 한다.
  //  awaited 서브는 제외가 맞다: 진행 중인 대화를 멈추는 게 그쪽의 정상 경로다.
  if (q.label !== undefined && q.label !== "") {
    const byLabel = running.find((j) => j.detached && j.label === q.label);
    if (byLabel !== undefined) return byLabel;
  }
  if (q.jobId !== undefined && q.jobId !== "") {
    // job_id 는 사용자가 카드에서 직접 집은 정확한 좌표 — 세션 밖이라도 존중한다
    // (label 과 달리 오인 여지가 없다). 그래서 scope 필터를 안 탄 전역 조회를 쓴다.
    const j = jobs.get(q.jobId);
    if (j !== undefined && j.detached && j.status === "running") return { ...j };
  }
  return undefined;
};

export const listJobs = (opts?: ListJobsOpts): WorkerJobRecord[] => {
  let all = [...jobs.values()];
  if (opts?.runningOnly === true) {
    all = all.filter((j) => j.status === "running");
  }
  const owner = opts?.ownerThreadKey;
  if (owner !== undefined && owner !== "") {
    all = all.filter((j) => jobBelongsToSession(j, owner));
  }
  all.sort((a, b) => b.startedAt - a.startedAt);
  if (opts?.limit !== undefined && opts.limit > 0) {
    all = all.slice(0, opts.limit);
  }
  return all.map((j) => ({ ...j }));
};

/**
 * 이 스레드에 **살아있는 자식 잡**(매니저·서브에이전트)이 있는가.
 *
 * ★용도: 부모의 도구 wall-clock 타임아웃이 "무응답"을 판정할 때 쓴다(2026-07-27).
 *  자식이 running 이라는 건 *관측된 사실* 이므로 무응답이 아니다 — 그 상태에서 부모가
 *  시계만 보고 끊으면, 자식은 계속 돌면서(부모 abort 가 자식에 전파되지 않는다) 결과만
 *  버려진다. 실측: 서브에이전트 138건 중 5건이 8분을 넘겼고 **전부 done** 이었다
 *  (627·582·563·499·496초). 일은 다 하고 돈도 쓰고 결과만 잃은 셈.
 *  자식은 자기 상한(WORKER_TIMEOUT_MS)·자기 타임아웃·사용자 취소를 이미 갖고 있으므로
 *  부모가 이중으로 감시할 이유가 없다(경계 중복 제거).
 *
 * jobs 는 in-memory 레지스트리 — 조회 비용 무시(수십 개 규모).
 */
export const hasLiveChildJob = (threadKey: string): boolean => {
  if (threadKey === "") return false;
  for (const j of jobs.values()) {
    if (j.status !== "running") continue;
    if (j.threadKey === threadKey) return true;
    // ★손자까지 본다 (2026-07-28). 종전엔 **직계 자식(정확 일치)** 만 봤다. 서브에이전트가
    //  또 서브를 띄우면 손자의 threadKey 는 `agent:<자식jobId>` 라 이 비교에 안 걸린다 —
    //  그래서 "자식이 끝났지만 손자가 아직 일하는" 창에서 부모가 무응답으로 오판해 끊었고,
    //  모델은 그 에러를 보고 **같은 일을 매니저로 다시 돌렸다**(사용자 신고: 중복 실행).
    //  판정 기준은 "이 대화가 띄운 잡이 살아있나" 이므로 원 세션으로 환원해 비교한다.
    if (resolveOwnerThreadKey(j.threadKey) === threadKey) return true;
  }
  return false;
};

/**
 * 이 대화가 띄워 **지금 돌고 있는** 잡 목록. hasLiveChildJob 과 같은 기준(손자 포함).
 *
 * 용도: 턴 컨텍스트에 "진행 중인 백그라운드 작업" 을 넣어, 메인이 자기가 띄운 걸 모른 채
 * 같은 일을 또 띄우는 것을 막는다(2026-07-29 실측: 매니저가 도는 중에 매니저 재발사).
 * 규칙으로 훈계하는 대신 **사실을 준다** — 판단 근거를 가진 쪽이 판단한다.
 */
/**
 * 이 잡이 그 세션 것인가 — 소속 판정 **단일 규칙**.
 * 잡의 threadKey 가 세션 키 그대로거나, 잡 좌표를 환원했을 때 그 세션이면 소속(손자 포함).
 */
export const jobBelongsToSession = (
  job: { threadKey: string },
  sessionThreadKey: string,
): boolean => {
  if (sessionThreadKey === "") return false;
  if (job.threadKey === sessionThreadKey) return true;
  return resolveOwnerThreadKey(job.threadKey) === sessionThreadKey;
};

export const listLiveChildJobs = (
  threadKey: string,
): Array<{ jobId: string; label: string; kind: string; startedAt: number }> => {
  if (threadKey === "") return [];
  const out: Array<{ jobId: string; label: string; kind: string; startedAt: number }> = [];
  for (const j of jobs.values()) {
    if (j.status !== "running") continue;
    if (!jobBelongsToSession(j, threadKey)) continue;
    out.push({
      jobId: j.jobId,
      label: j.label,
      kind: j.kind ?? "worker",
      startedAt: j.startedAt,
    });
  }
  return out.sort((a, b) => a.startedAt - b.startedAt);
};

/**
 * 진단용 스냅샷 — "왜 자식이 없다고 봤나"를 로그로 설명하기 위한 최소 정보.
 * 끊는 판정은 되돌릴 수 없으므로(모델이 곧 다른 행동을 한다) 근거를 남긴다.
 */
export const describeChildJobs = (threadKey: string): string => {
  const rows: string[] = [];
  for (const j of jobs.values()) {
    const owner = resolveOwnerThreadKey(j.threadKey);
    if (j.threadKey !== threadKey && owner !== threadKey) continue;
    rows.push(`${j.kind ?? "worker"}:${j.jobId.slice(0, 8)}=${j.status}`);
  }
  return rows.length === 0 ? "(이 대화에 귀속된 잡 없음)" : rows.join(", ");
};

/** 테스트 전용 — 레지스트리 비움 (프로덕션 경로 미사용). */
export const __resetJobsForTest = (): void => {
  jobs.clear();
  cancelHooks.clear();
  pendingTurnIds.clear();
};

// ─── 매니저 전용 타임아웃 (architect §5, W-I6) ─────────────────────────────────
// 매니저는 2층 턴 타임아웃(480s) *제외* — 길게 도는 게 정상. 대신 매니저 전용 상한을
// 기존 abortSignal 메커니즘(turn-timeout.ts 동형)으로 주입. 1층 idle/first 는 전 턴
// 면제(idleConfigExempt, 어댑터 wrap — 2026-06-24)라 매니저도 당연히 면제다. 긴 배치의
// 무이벤트 구간이 정상이라 idle 오살이 없다. 매니저의 hung 방어는 이 매니저 전용 상한이 담당.
// 값은 상수+env override (매직넘버 금지, turn-timeout.ts 정책 답습).

/**
 * 양의 정수 env 파서 — 미지정이면 fallback.
 *
 * ★`"0"`·`"off"`·`"infinite"` = **상한 없음**(`Infinity`). 잡 상한이 무한이 될 수 있게
 *  되면서(아래) 그걸 env 로도 표현할 수 있어야 한다. 반대로 유한값을 주면 그 값이 산다.
 */
const parseTimeoutEnv = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined || raw === "") return fallback;
  if (/^(0|off|none|infinite|infinity)$/i.test(raw.trim())) return Number.POSITIVE_INFINITY;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

/**
 * 기본 잡 상한 (ms) — **없음(무한)**. 2026-08-22 사용자 결정.
 *
 * 연혁: 2시간 → 4시간 → **무한**. 이 값은 성능 튜닝이 아니라 **오살 비용 vs 방치 비용**의
 * 저울이었고, 실측이 한쪽으로 기울었다 — dev 이력상 역대 최장 잡 54.9분, 2시간 상한이
 * 발화한 적 **0회**. 즉 이 시계는 정상 작업을 자를 위험만 지고 실효는 0이었다. 상한에 걸린
 * 작업은 "멈춘 것"이 아니라 **돌고 있었는데 잘린 것**이라(humanizeWorkerError 참조) 되돌릴
 * 수 없다.
 *
 * ★대신 잃은 것을 정확히 알아야 한다: 이건 "잊혀진 hung 잡" 의 **유일한 자동 종료 경로**
 *  였다. 이제 굳은 잡을 닫는 것은 **사용자의 명시적 취소**(`cancel_worker` · 대시보드 중지
 *  버튼 · `POST /cancel-worker`)뿐이다. 그래서 같은 커밋에서 **침묵**을 닫았다 —
 *  `startDetachedAgent` 에 없던 하드 백스톱(worker-registry 와 대칭)이 그것이다. 상한이
 *  무한이면 그 백스톱도 안 걸리므로, 굳은 잡은 **카드에 계속 진행 중으로 보인다**(관측은
 *  살아 있다 = 조용한 죽음 아님).
 *
 * env `WORKER_TIMEOUT_MS`(=`"0"`/`"off"` 도 무한) 로 유한값 복원 가능.
 */
const DEFAULT_WORKER_TIMEOUT_MS = Number.POSITIVE_INFINITY;

/**
 * 잡을 소유하는 도구(spawn_agent 등)의 **바깥 경계** — 잡 상한보다 넉넉해야 한다.
 *
 * ★경계 순서 불변식 (2026-07-28): 안쪽(잡 자신의 상한·취소) → 바깥(MCP callTool) 순으로
 *  느슨해져야, 진짜 경계인 안쪽이 먼저 발화한다. 반대로 바깥이 더 조이면 정상 진행 중인
 *  작업이 "무응답"으로 잘리고, 모델은 그 에러를 보고 같은 일을 다시 띄운다(작업 충돌).
 *  실제로 그랬다 — 어댑터 8분 시계 · MCP 11분 천장 < 잡 상한(WORKER_TIMEOUT_MS).
 *
 * ★잡 상한이 무한이면 이 천장도 무한이다(`Infinity + n === Infinity`) — 불변식이 자동으로
 *  유지된다. 유한 천장을 남기면 그게 **가장 안쪽**이 되어 정확히 위 사고가 재발한다.
 */
export const JOB_OWNING_TOOL_CALL_TIMEOUT_MS = (): number => WORKER_TIMEOUT_MS + 5 * 60_000;

/**
 * `setTimeout` 이 표현할 수 있는 최대 지연 (2^31-1 ms ≈ 24.8일). 이보다 크면 32-bit 오버플로로
 * **즉시 발화**한다 — `Infinity` 도 같은 함정(Node 가 1ms 로 클램프).
 */
export const MAX_TIMER_MS = 2_147_483_647;

/**
 * 무한 상한을 **유한 수를 요구하는 자리**에 넘길 때 환산한다(무한 → 24.8일).
 *
 * ★왜 그냥 `Infinity` 를 못 넘기나 (2026-08-22 전수 확인): 소비처마다 무한이 **정반대로**
 *  뒤집힌다.
 *   · `setTimeout(fn, Infinity)` → Node 가 1ms 로 클램프 = 즉시 타임아웃
 *   · `_mcp-bridge` 의 `Number.isFinite` 가드 → 폴백 **11분** = 바깥이 가장 조이는 경계가
 *     되어 2026-07-28 사고(정상 작업을 바깥이 자름)가 그대로 재현
 *   · `String(Infinity)` = `"Infinity"` → SDK env 파싱에서 NaN
 *  그래서 "무한" 은 **경로**로 표현하고(타이머를 아예 안 건다), 유한 수가 강제되는 자리에만
 *  이걸 쓴다.
 */
export const asFiniteTimeoutMs = (ms: number): number =>
  Number.isFinite(ms) ? Math.min(ms, MAX_TIMER_MS) : MAX_TIMER_MS;

/**
 * 잡 **점검(check-in) 주기** (ms) — 기본 2시간. env `JOB_CHECKIN_INTERVAL_MS`.
 *
 * ★시계의 역할을 뒤집은 자리다 (2026-08-22 사용자 결정): 종전 `WORKER_TIMEOUT_MS` 는 이
 *  시간이 되면 잡을 **죽였다**. 그런데 상한에 걸린 작업은 "멈춘 것" 이 아니라 **돌고
 *  있었는데 잘린 것**이라(humanizeWorkerError) 되돌릴 수 없다 — dev 실측상 정당하게
 *  발화한 적도 0회였다(역대 최장 잡 54.9분). 사용자 말: *"소환자가 소환 대상이 별문제가
 *  없는지 확인해보는 시간이면 어떨까? 이걸 그냥 냅다 끊는 건 좀 아닌 것 같아서."*
 *
 *  그래서 이제 이 주기는 **확인하는 시간**이다: 주기가 되면 그 잡이 무엇을 했는지
 *  **증거를 모아 소환자에게 넘기고**, 계속 둘지·지시를 더 줄지·그만둘지는 소환자가 정한다.
 *  코어는 판정하지 않는다 — 침묵 몇 회 같은 정적 규칙을 여기 두면 그게 곧 소환자의 판단을
 *  가로채는 분기다([[feedback_capability_not_routing]]).
 *
 *  [[project_self_observation_sweep]] 의 기준 그대로다 — 자동으로 하는 건 **되돌릴 수
 *  있거나 최악이 사소한 것**뿐이고, 죽이기는 둘 다 아니다. 관측·보고는 둘 다 맞다.
 *
 *  강제 종료가 필요하면 `WORKER_TIMEOUT_MS` 에 유한값을 주면 종전 동작이 살아난다(기본 무한).
 */
/**
 * **이 스레드를 잡 점검이 지키는가** (2026-08-31).
 *
 * ★codex 도구 한도에서 «잘라야 하나 이어가야 하나» 를 가르는 판정이다. 이어가도 되는
 *  이유는 위 점검이 **활동 기준**으로 런어웨이를 잡기 때문인데, 그 보호는 매니저·에이전트
 *  스레드에만 있다. 사용자가 기다리는 대화는 그 방어가 없으므로 이어가면 안 된다.
 *
 * ★**여기 두는 이유**: 판정의 근거가 점검이므로 소유자가 점검을 가진 이 파일이다. 그리고
 *  어댑터 안 인라인 조건으로 두면 그 분기를 **실행으로 잴 수가 없다** — 실측으로 조건을
 *  `false` 로 바꿔도 회귀가 초록이었다(검사가 문장의 존재만 보고 도달을 못 봤다).
 * ★`health-sweep` 에도 비슷한 접두사 검사가 있지만 **질문이 다르다** — 거기는 *"내 대화가
 *  아닌가"* 라 엔드포인트·게이트웨이도 센다. 이름이 같다고 합치지 않는다(SYSTEM.md §통합).
 */
export const isCheckinGuardedThread = (threadKey: string): boolean =>
  threadKey.startsWith("worker:") || threadKey.startsWith("agent:");

export const JOB_CHECKIN_INTERVAL_MS = parseTimeoutEnv(
  process.env.JOB_CHECKIN_INTERVAL_MS,
  2 * 60 * 60_000,
);

/**
 * **아무도 판단할 수 없는** 잡을 자동 종료하기까지의 연속 침묵 주기. 기본 2.
 *
 * ★이건 "정체하면 죽인다" 가 아니다. 종료 조건은 셋이 **동시에** 참일 때뿐이다:
 *   ① 그 주기에 활동이 완전히 0(진행 중 도구도 없음)
 *   ② 점검을 넘길 **소환자가 없다**(도는 매니저가 없어 상위로 올라갔다)
 *   ③ 그 상태로 이만큼의 주기가 지났다
 *  ①만으로는 안 죽인다 — 오래 걸리는 정상 도구와 구별되지 않기 때문이고, 그래서 그 판단은
 *  증거를 실어 소환자에게 넘긴다. ②가 핵심이다: 판단할 사람이 있으면 코드가 정하지 않는다
 *  ([[feedback_capability_not_routing]]). 아무도 없을 때만 "안 거두는 잡" 으로 닫는다.
 */
export const STALL_KILL_AFTER_CHECKINS = 2;

/** 매니저 1잡 전체 wall-clock 상한 (ms). env `WORKER_TIMEOUT_MS` override. */
export const WORKER_TIMEOUT_MS = parseTimeoutEnv(
  process.env.WORKER_TIMEOUT_MS,
  DEFAULT_WORKER_TIMEOUT_MS,
);

/** 하드 백스톱 grace (ms) — index.ts TURN_HARD_GRACE_MS 동형. 기본 60s. */
const DEFAULT_WORKER_HARD_GRACE_MS = 60_000;

/**
 * 매니저 하드 백스톱 grace (ms). createJobAbort 의 abort 가 hung MCP callTool 을
 * 못 끊는 경우(MCP 한계), abort 시점(WORKER_TIMEOUT_MS) 이후 이만큼 더 기다려도
 * runRegionA 가 안 settle 하면 runner 가 WorkerTimeoutError 로 *강제* 종료해 통지를
 * 정시 발화시킨다. env `WORKER_HARD_GRACE_MS` override (매직넘버 금지, 채널 백스톱 동형).
 */
/**
 * 서브에이전트 1잡 상한 (ms). env `SUBAGENT_TIMEOUT_MS`. 기본 = 매니저 상한과 동일.
 *
 * ★없었다 (2026-07-29 검토가 잡음). 매니저는 `createJobAbort(jobId, {timeoutMs})` 로 상한을
 *  받는데 서브에이전트는 `createJobAbort(jobId)`(cancel-only)라 **자체 상한이 0** 이었다.
 *  그 상태에서 부모의 도구 wall-clock 을 폐기(0cffeb7)했으니, 멈춘 서브에이전트는 브리지
 *  천장(잡상한+5분)까지 부모 턴을 잡는다 — 없앤 8분의 15배. "안쪽이 먼저 끝난다" 는
 *  경계 순서가 서브에이전트에선 성립하지 않았다(내가 그렇다고 단정하고 시계를 없앴다).
 *  이제 안쪽(이 상한) < 바깥(브리지 천장 = 상한+5분)이 실제로 성립한다.
 */
export const SUBAGENT_TIMEOUT_MS = parseTimeoutEnv(
  process.env.SUBAGENT_TIMEOUT_MS,
  WORKER_TIMEOUT_MS,
);

export const WORKER_HARD_GRACE_MS = parseTimeoutEnv(
  process.env.WORKER_HARD_GRACE_MS,
  DEFAULT_WORKER_HARD_GRACE_MS,
);

/**
 * 매니저 상한 타임아웃 에러.
 *
 * TurnTimeoutError 와 동형 — message 에 "모델 거부 아님" 토큰을 박아 facade
 * `MODEL_REJECTED_PATTERNS` 비매칭 보장 (멀쩡한 모델이 깨진 것으로 오제거되는 것 방지).
 */
export class WorkerTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(timeoutMs: number = WORKER_TIMEOUT_MS) {
    super(
      `매니저 처리 시간 초과 (${timeoutMs}ms wall-clock 상한) — 모델 거부 아님`,
    );
    this.name = "WorkerTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/**
 * 매니저 사용자 취소 에러 — 타임아웃과 *구분*(통지 문구 "취소됨" vs "시간 초과").
 * abort reason 으로 운반되거나 cancelJob 이 직접 마킹. WorkerTimeoutError 처럼
 * "모델 거부 아님" 토큰을 박아 facade MODEL_REJECTED_PATTERNS 오매칭을 막는다.
 */
export class WorkerCancelledError extends Error {
  constructor() {
    super("매니저가 사용자 요청으로 취소됨 — 모델 거부 아님");
    this.name = "WorkerCancelledError";
  }
}

// ─── 외부 취소 레지스트리 (cancel_worker 도구 — 2026-06-20, U-I4 개정 2026-07-17) ──
// jobId → "이 잡을 취소하라" 콜백 매핑을 daemon 경계(본 모듈)에 둔다. cancelJob(jobId) 이
// 이 훅을 불러 실제 abort 를 발화한다. 훅의 *내용*(무엇을 abort 하는지)은 등록 주체가 정한다:
//  - createJobAbort 발급자(worker·spawn_agent MCP 경로): 자기 AbortController 를 abort.
//  - claude native Task 경로(claude-agent-sdk.ts): 부모 턴 effectiveAc 를 abort(coarse,
//    턴 단위 — SDK 가 per-Task abort 를 안 주는 한계상 정당). setCancelHook 를 직접 쓴다.
// 어느 경로든 취소는 이 단일 레지스트리로 수렴한다(어댑터 분기 0, LLM-agnostic).
const cancelHooks = new Map<string, () => void>();

/**
 * jobId 의 취소 콜백을 등록 — cancelJob(jobId) 이 이 fn 을 호출해 실제 abort 를 발화한다.
 * createJobAbort 내부와, 자체 abort 레버(effectiveAc)를 가진 claude native Task 경로가 쓴다.
 * 같은 jobId 재등록은 덮어쓴다(멱등적 최신 훅 우선).
 */
export const setCancelHook = (jobId: string, fn: () => void): void => {
  cancelHooks.set(jobId, fn);
};

/** jobId 의 취소 콜백 해제 — 잡 정상/throw 종료 시 호출(누수·오발화 0). 멱등. */
export const clearCancelHook = (jobId: string): void => {
  cancelHooks.delete(jobId);
};

// ─── 매니저 스티어 레지스트리 (2026-07-29) ─────────────────────────────────────
// jobId → 그 매니저 턴의 SteeringChannel. 위 cancelHooks 의 **자매**다(같은 데몬 경계, 같은
// 생명주기: 잡 시작 시 등록 → finally 해제).
//
// ★왜 매니저엔 원래 없었나: steering 소비층(3어댑터)은 `input.steering` 하나만 보고 채널·매니저를
//  구분하지 않는다 — 즉 배관은 처음부터 LLM-agnostic 이었다. 매니저가 못 받은 이유는 단 하나,
//  매니저 runner 가 steering 을 안 넘기고 아무도 `worker:<jobId>` 키로 채널을 만들지 않아서다
//  (채널 핸들러의 steeringChannels 는 세션 threadKey 전용). 버퍼 키 불일치가 아니라 부재.
//
// 그래서 여기 두는 이유: index.ts(데몬)와 worker-registry(region)가 **둘 다 이미 import 하는
// 유일한 경계 모듈**. 취소가 cancelJob 단일 레지스트리로 수렴하듯, 스티어도 여기로 수렴한다.
const steerChannels = new Map<string, SteeringChannel>();

/** 기본 on. 문제 시 끌 수 있게 — 채널 경로의 STEERING_ENABLED 와 동형(하드 게이트 금지). */
export const WORKER_STEERING_ENABLED = process.env.WORKER_STEERING_ENABLED !== "0";

/** 매니저 턴의 steering 채널 등록 — runner 가 잡 시작 시 1회. 같은 jobId 재등록은 덮어쓴다. */
export const setSteerChannel = (jobId: string, ch: SteeringChannel): void => {
  steerChannels.set(jobId, ch);
};

/** 해제 — 잡 종료 시(정상·실패 무관) 반드시. 멱등. */
/**
 * 이 잡의 **다음 턴용 스티어 채널**로 교체한다 (2026-08-19).
 *
 * ★왜 필요한가 — 라이브에서만 드러난 것: 채널의 수명은 **턴 단위**다.
 *  claude 어댑터는 첫 result 에서 `input.steering.close()` 를 부른다(스트리밍 입력
 *  데드락 수정). 그런데 잡의 스티어 **정체성**은 턴을 가로지른다 — 매니저가 자식을
 *  거두려고 턴을 이어 돌 때, 닫힌 채널을 재사용하면 `stream()` 이 즉시 끝나
 *  "기다렸다" 고 착각하고 그냥 빠져나온다(실측: 거두기 루프가 로그만 찍고 0초 만에
 *  탈출, 매니저가 자식보다 먼저 done). 그래서 라운드마다 **새 채널**로 간다.
 *
 *  이전 채널의 잔여는 **버리지 않고 반환**한다 — 교체 순간 도착한 결과가 조용히
 *  사라지면 거두기의 의미가 없다.
 *
 * @returns 새 채널과, 이전 채널에 남아 있던 메시지(호출자가 이어받아야 한다).
 */
export const rotateSteerChannel = (
  jobId: string,
): { channel: SteeringChannel; leftover: SteeringInput[] } => {
  const prev = steerChannels.get(jobId);
  const channel = createSteeringChannel();
  // ★새 채널을 **먼저** 등록한다 — 등록 전에 drain 하면 그 사이 도착분이 닫힌 채널로 간다.
  steerChannels.set(jobId, channel);
  const leftover = prev !== undefined ? prev.drain() : [];
  return { channel, leftover };
};

/**
 * 잡의 **결과 수신함** — 자식이 돌려주는 결과 전용. 사용자 개입(steering)과 **다른 큐**다.
 *
 * ★왜 갈랐나 (라이브 3차 실측, 2026-08-19): 같은 큐에 넣으면 결과가 매니저의 *진행 중인*
 *  턴으로 들어가고, claude 어댑터가 그걸 SDK 에 먹여 **새 턴**이 열린다. 그런데 어댑터의
 *  턴 경계 가드는 "첫 result 이후 메시지 = 남의 턴" 으로 보고 그 답을 버린다(그 가드는
 *  2026-08-09 실사고 — 빈 말풍선 — 에서 태어난 것이라 옳다). 결과: 매니저가 합계를
 *  **계산했는데 그 답이 버려졌다**(로그: turn-boundary 경고 뒤 assistant 2건, FINALIZE 31자).
 *
 *  두 큐는 소비자도 목적도 다르다:
 *   - 개입(steering) → 어댑터가 진행 중 턴에 끼워넣는다. "그만해" 는 즉시 닿아야 한다.
 *   - 결과(result)  → **거두기 루프**만 읽고, 이어지는 턴의 입력이 된다.
 *  갈라두면 경합이 사라진다 — 결과가 언제 도착하든 항상 같은 경로로 처리된다.
 */
const jobResultChannels = new Map<string, SteeringChannel>();

/**
 * 결과 수신함 조회 — **배선 검사용**. 적대 검토(2026-08-20 B2)에서 러너가 자기 것이 아닌
 * 채널을 등록해도 초록이었다(린트가 호출 *문자열*만 봤다). 그러면 자식 결과가 고아 채널로
 * 가고 매니저는 상한까지 매달린다.
 */
export const getJobResultChannel = (jobId: string): SteeringChannel | undefined =>
  jobResultChannels.get(jobId);

export const setJobResultChannel = (jobId: string, ch: SteeringChannel): void => {
  jobResultChannels.set(jobId, ch);
};
export const clearJobResultChannel = (jobId: string): void => {
  jobResultChannels.delete(jobId);
};

/** 이 잡의 **현재** 스티어 채널 — 소유자(러너)가 stale 참조를 들지 않게 레지스트리를 본다. */
export const getSteerChannel = (jobId: string): SteeringChannel | undefined =>
  steerChannels.get(jobId);

export const clearSteerChannel = (jobId: string): void => {
  steerChannels.delete(jobId);
};

/**
 * 스티어 **시도**의 결과 — 전달된 것과 유실된 것을 같은 어휘로 센다.
 *  - delivered : 적재 성공(다음 model-call 경계에서 반영)
 *  - closed    : 매니저 턴이 막 닫힘(간발의 차 유실)
 *  - absent    : 그런 매니저 없음·스티어 비활성
 *  - no-target : 호출부가 대상을 못 고름(이미 끝난 매니저·이름 오타 — steerJob 도달 전)
 *  - other-session: 대상이 **다른 대화**의 매니저라 의도적으로 거절(오주입 방지)
 */
export type SteerOutcome =
  | "delivered"
  | "closed"
  | "absent"
  | "no-target"
  | "other-session";

/**
 * 스티어 시도를 관측면에 남긴다 (2026-08-05, ADR `docs/decisions/2026-08-03-steer-observability.md`).
 *
 * ★종전엔 스티어가 **어디에도 안 남았다** — 이벤트 0건·DB 0건·대시보드 표시 없음. 그 턴의 도구
 *  반환값이 유일한 흔적이라 사용자는 전달 여부를 확인할 수단이 없었고, 사후에 "이 매니저가 왜
 *  저렇게 했지" 를 볼 때 **스티어가 있었다는 사실 자체를 몰랐다**(로그가 1차 진단면이라는 원칙
 *  정면 위반). 이름(label)을 덮어쓰는 대신 타임라인에 쌓는 이유도 같다 — 원래 의도(label·task)와
 *  변경(스티어)이 **둘 다** 보존된다.
 *
 * 발행자가 여기 하나인 이유: 잡 좌표가 있는 결과(delivered/closed/absent)는 steerJob 이 직접
 * 부르고, 대상을 못 고른 결과(no-target/other-session)는 **steerJob 에 도달조차 못 하므로**
 * 호출부(steer_worker 도구)가 같은 함수를 부른다 — 경로는 둘, 발행 지점은 하나(중복 판단 0).
 *
 * best-effort: publishWorkerLifecycle 동형으로, 관측 발행 실패가 스티어를 무르지 않는다.
 */
export const publishSteerAttempt = (info: {
  /** 사용자 원문(framing 없는 raw) — 무엇을 얹으려 했는지. */
  message: string;
  outcome: SteerOutcome;
  /** 대상 잡 — 못 고른 경우(no-target) 생략. */
  jobId?: string;
  /** 호출부가 지목에 쓴 이름. 생략 시 잡 레코드의 label 로 채운다. */
  label?: string;
}): void => {
  try {
    const job = info.jobId !== undefined && info.jobId !== "" ? getJob(info.jobId) : undefined;
    getEventBus().publish({
      type: "worker.steered",
      ts: Date.now(),
      payload: {
        jobId: info.jobId ?? "",
        label: info.label ?? job?.label ?? "",
        outcome: info.outcome,
        // 지시 원문 — 길이 컷(이벤트/버퍼 바운드, worker.* 의 task/result 컷과 동형).
        message: info.message.slice(0, 500),
        ...(job !== undefined
          ? {
              threadKey: job.threadKey,
              // 원 세션 — 대시보드 세션 스코프 필터가 worker.* 와 같은 근거로 판정.
              ownerThreadKey: resolveOwnerThreadKey(job.threadKey),
              kind: job.kind ?? "worker",
            }
          : {}),
      },
    });
  } catch {
    /* noop — 관측 발행 실패가 스티어를 무르지 않는다. */
  }
};

/**
 * 돌고 있는 매니저에 지시를 얹는다.
 *
 * @returns "delivered"=적재 성공(다음 model-call 경계에서 반영) /
 *          "closed"=턴이 이미 닫힘(막 끝났다) / "absent"=그런 매니저 없음·스티어 비활성.
 *
 * ★반영 시점은 **다음 model-call 경계**다 — 매니저가 10분짜리 Bash 안이면 그때까지 대기한다
 *  (선점 없음). 호출부가 이 사실을 사용자에게 정직하게 고지해야 한다(cancel_worker 가
 *  "즉시는 아닐 수 있음" 을 고지하는 것과 같은 이유).
 *
 * 결과와 무관하게 `worker.steered` 를 발행한다 — 유실(closed/absent)이야말로 사후에 세어야
 * 하는 값이다(publishSteerAttempt 주석 참조).
 */
export const steerJob = (
  jobId: string,
  msg: SteeringInput,
  /**
   * `resetStallClock: false` = 이 배달은 **판단이 아니다**. 기본은 true(사람·모델의 개입).
   * 시스템이 자기 점검 보고를 부모에게 넣는 경로만 false 를 준다 — 안 그러면 시스템이
   * 자기 시계를 스스로 미루고 굳은 잡이 영원히 안 죽는다(2026-08-23 2라운드 F2 실측).
   */
  opts?: { resetStallClock?: boolean },
): "delivered" | "closed" | "absent" => {
  const outcome = ((): "delivered" | "closed" | "absent" => {
    if (!WORKER_STEERING_ENABLED) return "absent";
    const ch = steerChannels.get(jobId);
    if (ch === undefined) return "absent";
    if (ch.push(msg)) return "delivered";
    // ★채널이 닫혔다 — 그런데 **잡이 아직 돌면** 그건 "못 받는다" 가 아니라 *이 턴의*
    //  채널이 닫혔을 뿐이다. claude 어댑터는 첫 result 에서 steering 을 닫는데(스트리밍
    //  데드락 수정), 그 뒤로도 잡은 살아서 다음 턴을 돌 수 있다. 그 창에 도착한 것을
    //  "closed" 로 처리하면 조용히 갈라진다 — 실측(2026-08-19): 매니저가 띄운 자식 셋 중
    //  **하나만** 그 창에 끝나서 매니저를 못 만나고 세션으로 새어, 지휘자의 합계가 틀렸다.
    //  채널 수명은 턴 단위지만 잡의 스티어 **정체성**은 턴을 가로지른다 — 갈아끼우고 넣는다.
    const job = jobs.get(jobId);
    if (job === undefined || job.status !== "running") return "closed";
    const rot = rotateSteerChannel(jobId);
    for (const m of rot.leftover) rot.channel.push(m); // 이전 잔여 보존(순서 유지).
    return rot.channel.push(msg) ? "delivered" : "closed";
  })();
  // ★개입은 곧 "이 잡을 계속 두겠다" 는 판단이다 — 점검 시계를 되돌린다 (2026-08-23).
  //  종전엔 사용자가 "계속 둬" 라고 답해도 되돌릴 수단이 없었다: 진짜 굳은 잡은 활동이
  //  안 나므로 앵커가 안 밀리고, `stallReports` 는 `checkinTick` 만 쓰기 때문에 카운터가
  //  계속 올라가 결국 죽었다. 점검 문구가 "지시를 한 번 주면 초기화됩니다" 라고 말하므로
  //  **여기서 그 말을 참으로 만든다**(문구만 고치면 거짓말이 된다).
  if (outcome === "delivered" && opts?.resetStallClock !== false) {
    const job = jobs.get(jobId);
    if (job !== undefined && job.status === "running") {
      job.stallReports = 0;
      job.lastActivityAt = Date.now();
      const ev = evidence.get(jobId);
      if (ev !== undefined) ev.lastActivityAt = Date.now();
    }
  }
  publishSteerAttempt({ jobId, message: msg.raw, outcome });
  return outcome;
};

export interface WorkerAbort {
  /** runRegionA(input.abortSignal) 로 운반할 signal — 어댑터가 1층 idle 과 OR 결합. */
  signal: AbortSignal;
  /** 잡 정상/throw 종료 시 호출 — 타이머 해제 + 취소 레지스트리 해제(누수·오발화 0). 멱등. */
  done(): void;
}

/**
 * 잡 전용 abortSignal 발급 (2026-07-17 통합 — 기존 createWorkerAbort·createAgentAbort 일원화).
 * region 의 runWorkerJob(매니저)·spawn_agent 핸들러(서브에이전트)가 호출해
 * `RegionASdkInput.abortSignal` 로 주입한다(새 메커니즘 0, 값만 잡별 — architect §5).
 *
 * `opts.timeoutMs` 지정 시(매니저): 그 ms 에 WorkerTimeoutError 로 자동 abort(무한 매니저 봉쇄,
 * W-I6). 생략 시(서브에이전트): **타이머 없음 = cancel-only** — 서브는 부모 턴에 종속(awaited)
 * 되어 부모 턴 타임아웃/생명주기를 이미 따르므로 별도 상한이 부적절(이중·불일치 자동종료 방지).
 *
 * ★`timeoutMs` 가 **유한하지 않으면 타이머를 안 건다** (2026-08-22, 상한 무한화). 이 가드가
 *  없으면 정반대로 동작한다: `setTimeout(fn, Infinity)` 은 Node 가 **1ms 로 클램프**해서
 *  모든 잡이 시작하자마자 타임아웃으로 죽는다. "상한을 없앴다" 가 "상한을 1ms 로 만들었다"
 *  가 되는 부류라, 값이 아니라 **경로**를 나눈다.
 *
 * 어느 경우든 jobId 의 취소 훅을 setCancelHook 로 등록 → cancelJob(jobId) 이 WorkerCancelledError
 * 로 abort 가능(외부 취소). done() 이 타이머(있으면)+취소 훅을 clearCancelHook 로 해제한다.
 */
export const createJobAbort = (
  jobId: string,
  opts?: { timeoutMs?: number },
): WorkerAbort => {
  const ac = new AbortController();
  const ms = opts?.timeoutMs;
  let handle: ReturnType<typeof setTimeout> | undefined;
  if (ms !== undefined && Number.isFinite(ms)) {
    // ★`setTimeout` 은 2^31-1 을 넘으면 32-bit 오버플로로 **즉시 발화**한다. 무한만 막고
    //  큰 유한값을 그대로 넘기면 같은 함정에 빠진다 — 실측: `WORKER_TIMEOUT_MS=2147483647`
    //  (코드가 "안전한 최대치" 로 정의한 그 값!)을 주면 **모든 매니저가 11ms 에 실패**하고
    //  에러엔 "24.8일 상한 초과" 가 찍혀 원인 추적이 사실상 불가능했다(2026-08-23 검토 F2).
    handle = setTimeout(() => {
      if (!ac.signal.aborted) ac.abort(new WorkerTimeoutError(ms));
    }, asFiniteTimeoutMs(ms));
    (handle as { unref?: () => void }).unref?.();
  }
  setCancelHook(jobId, () => {
    if (!ac.signal.aborted) ac.abort(new WorkerCancelledError());
  });
  return {
    signal: ac.signal,
    done(): void {
      if (handle !== undefined) clearTimeout(handle);
      clearCancelHook(jobId);
    },
  };
};

/**
 * 진행 중 매니저/서브에이전트 취소(best-effort) — cancel_worker 도구(worker)·백그라운드
 * 잡 카드 중지 버튼(worker·agent 공통, U-I4 개정 2026-07-17)이 호출. abort 를 부르고 취소
 * 상태로 마킹한다. abort 는 LLM 스트림은 끊지만 hung MCP callTool 은 signal 미수신
 * (MCP 한계)이라 *다음 도구 경계*(최대 MCP_CALL_TIMEOUT)에서 멈춤 — 도구가 그 점 안내.
 *
 * @returns true=취소 신호 발사(running 잡 존재), false=대상이 없거나 이미 종료.
 */
/**
 * 이 잡의 **직계 자식**들 — threadKey 규약(`worker:<부모jobId>` / `agent:<부모jobId>`)이
 * 곧 부모 좌표다(resolveOwnerThreadKey 와 같은 규칙, 이름 열거 0).
 */
const directChildJobs = (parentJobId: string): WorkerJobRecord[] => {
  const out: WorkerJobRecord[] = [];
  for (const j of jobs.values()) {
    if (parentJobIdOf(j.threadKey) === parentJobId) out.push(j);
  }
  return out;
};

/**
 * 취소를 **자손 전체로** 전파한다 (2026-07-31 전체검토 P1).
 *
 * ★사고: `cancelJob` 이 그 jobId 의 훅 **하나만** 불렀다. 실측 재현 —
 *   `cancelJob(parent)=true / parent=cancelled / child=running / child abort 훅 호출 false`
 *  매니저를 중지시켜도 그 밑 서브에이전트가 자기 상한(SUBAGENT_TIMEOUT_MS)까지 모델을 계속 태우고,
 *  결과는 부모가 이미 abort 돼 폐기된다(돈만 나감). 더 나쁜 건 프롬프트의
 *  "진행 중인 백그라운드 작업" 줄이 **취소된 작업을 계속 진행 중이라고 메인에게 보고**한 것.
 *  `listLiveChildJobs`·`jobBelongsToSession` 라는 소속 판정이 이미 있는데 취소만 안 썼다.
 *
 * 깊이 우선으로 자식부터 취소한다(부모가 먼저 죽으면 자식이 고아가 된다). `seen` 으로
 * 순환을 닫는다 — threadKey 가 손상돼 자기참조가 생겨도 무한 재귀하지 않는다.
 */
const cancelDescendants = (parentJobId: string, seen: Set<string>): number => {
  let n = 0;
  for (const child of directChildJobs(parentJobId)) {
    if (seen.has(child.jobId)) continue;
    seen.add(child.jobId);
    n += cancelDescendants(child.jobId, seen);
    if (child.status !== "running") continue;
    markCancelled(child.jobId, CASCADE_CANCEL_REASONS[0]);
    const h = cancelHooks.get(child.jobId);
    if (h !== undefined) h();
    n += 1;
  }
  return n;
};

/**
 * **세션 턴이 끊길 때** 그 턴이 띄운 잡들을 같이 끊는다 (2026-08-19).
 *
 * ★잡↔잡 전파는 이미 있었다(`cancelDescendants`, 2026-07-31). 빠진 건 **세션 → 잡** 방향이다:
 *  `/stop` 은 `inflightTurns` 의 AbortController 만 abort 하고, 그 턴이 띄운 서브에이전트·
 *  매니저 잡은 **계속 돈다**. awaited 서브라면 부모는 이미 손을 뗐는데 자식은 자기 상한
 *  (SUBAGENT_TIMEOUT_MS)까지 살아서, 사용자는 "중단했습니다" 를 받고도 모델 호출이 계속 나간다.
 *  ★고아 잡은 조용하다 — 부모가 없으니 결과를 보고할 곳도 없고, 사용자는 끝난 줄 안다.
 *
 * 자식 판정은 `directChildJobs` 와 **같은 근거**(잡이 기록한 소환자 좌표 = `job.threadKey`)를
 * 쓴다. 세션 키는 접두사가 없으므로 정확히 일치하는 것만 고른다 — 다른 세션 잡을 건드리지
 * 않는다. 손자는 `cancelDescendants` 가 이어서 처리한다(같은 재귀 재사용, 중복 구현 0).
 *
 * @returns 끊은 잡 수(0 = 그 세션이 띄운 실행 중 잡 없음).
 */
export const cancelJobsForThread = (threadKey: string): number => {
  if (typeof threadKey !== "string" || threadKey === "") return 0;
  let n = 0;
  for (const job of [...jobs.values()]) {
    if (job.threadKey !== threadKey || job.status !== "running") continue;
    // 자손부터 — 부모를 먼저 죽이면 손자가 고아가 된다(cancelJob 과 같은 순서).
    n += cancelDescendants(job.jobId, new Set([job.jobId]));
    markCancelled(job.jobId, CASCADE_CANCEL_REASONS[1]);
    const h = cancelHooks.get(job.jobId);
    if (h !== undefined) h();
    n += 1;
  }
  return n;
};

export const cancelJob = (jobId: string): boolean => {
  const job = jobs.get(jobId);
  if (job === undefined || job.status !== "running") return false;
  // 개정(U-I4, 2026-07-17): worker·agent 모두 취소 가능. 이전엔 kind==='worker' 만 통과시켜
  // awaited 서브에이전트를 하드 게이트했으나, 이제 agent 도 cancelHooks 에 훅이 등록된다:
  //  - spawn_agent MCP 경로(codex/openai + claude path=): createJobAbort(cancel-only).
  //  - claude native Task 경로: claude-agent-sdk.ts 가 setCancelHook 로 부모 턴 effectiveAc
  //    abort 훅을 등록(coarse, 턴 단위 — SDK per-Task abort 한계).
  // 따라서 코어에서 kind 로 막을 이유가 없다. WorkerJobKind 가 "worker"|"agent" 뿐이라 아래는
  // 사실상 항상 통과(방어적 명시 — 향후 kind 추가 대비).
  if (job.kind !== "worker" && job.kind !== "agent") return false;
  // 취소 상태를 먼저 마킹 — 이후 abort 가 runRegionA 를 reject 시키면 runner 의 catch 가
  // onWorkerComplete(error) 를 부르는데, 그 시점엔 이미 status="cancelled" 라 통지 문구가
  // 취소로 나간다(타임아웃과 구분). markCancelled 는 멱등(재호출 무해).
  // ★자식부터(깊이 우선) — 부모를 먼저 죽이면 자식이 고아가 된다.
  const cancelledChildren = cancelDescendants(jobId, new Set([jobId]));
  markCancelled(jobId, "사용자 요청으로 취소됨");
  const hook = cancelHooks.get(jobId);
  if (hook !== undefined) hook();
  if (cancelledChildren > 0) {
    console.log(
      `worker-jobs: '${job.label}' 취소 — 하위 작업 ${cancelledChildren}건 함께 중단(전파)`,
    );
  }
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
 * mid-turn steering 이 진행 턴에 append 됐음을 알리는 sentinel — CANCELLED_TURN_RESULT 의
 * 자매(둘 다 "POST /messages 핸들러 응답 마커"). steering 개입점(src/index.ts serializedHandler)
 * 은 새 턴을 만들지 않고 진행 턴에 메시지를 끼워넣은 뒤 *즉시* 이 값으로 resolve 한다 —
 * `channelHandler(msg)` 를 await 하는 POST /messages 가 **원래 턴 종료 전에** 반환하기 때문에,
 * 이 마커가 없으면 대시보드 클라가 그 200-반환을 "턴 완료"로 오인해 `setChatWorking(false)` →
 * 긴 codex 턴이 계속 도는데도 '작업 중'이 조기에 꺼진다(steering 조기-off 버그, 2026-07-20).
 * 마커를 받은 POST 핸들러는 `{replyText:"", steered:true}` 로 응답하고, 클라는 작업중을 유지한다
 * (실제 종료 = 원래 턴의 SSE channel.message.out/turn_done). 어댑터는 이 값을 읽지 않는다(#2).
 */
export const STEERED_TURN_RESULT: unique symbol = Symbol(
  "tiguclaw.steeredIntoActiveTurn",
);

/** serializedHandler 결과가 steering-append no-op 인지 판정 — http-bridge POST 응답 분기용. */
export const isSteeredTurnResult = (v: unknown): boolean =>
  v === STEERED_TURN_RESULT;

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
// 매니저는 원 turn 의 reply 클로저를 안 들고 있다(원 turn 종료). 재주입 turn 의 reply 를
// 채널명→send 매핑으로 재구성. dispatcher.ts 의 telegram/cli 분기와 *동일 의미* —
// 단 dispatcher 는 결과 텍스트 직접 push 였고, 여기선 핸들러 재진입의 reply 통로.
// (telegram threadKey "tg:<chatId>" → chatId 복원, cli → console.log.)

import { deliverOutbound } from "./outbound.js";
import type { ReplyOptions } from "../channels/types.js";
import {
  canonicalSessionChannel,
  notifySessionThreadKey,
} from "../store/sessions.js";
// 통지 문구는 판정과 같은 자리(tool-watchdog)에서 만든다 — 두 곳에 두면 한쪽만 늙는다.
import { formatToolSlowNotice } from "./llm-runtime/tool-watchdog.js";

/**
 * notifyDest 없는 매니저(텔레그램 직접 발화 등)의 *폴백* target 도출 — 기존 telegram threadKey
 * slice 로직을 그대로 추출. 텔레그램 직접 매니저는 notifyDest 미주입이므로 이 폴백이 현행과
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
 * 동일 로직 — 같은 걸 두 번 구현 X). 덕분에 매니저 완료 통지도 대시보드 chat_log 에 뜬다
 * (예전엔 raw 발송이라 안 보였음). 미지원 채널·발송 실패는 deliverOutbound 가 정직 처리.
 */
const reacquireReply = (
  dest: WorkerNotifyDest,
  opts?: { observe?: boolean; sessionThreadKey?: string },
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
      // 관측 세션 = 발원 세션(dashboard:*) 또는 기본(내부 파생·물리 채널). 배달 좌표와 독립.
      ...(opts?.sessionThreadKey !== undefined
        ? { observeThreadKey: opts.sessionThreadKey }
        : {}),
    });
  };
};

/**
 * 잡의 notifyDest(있으면) 또는 channel/threadKey 폴백으로 통지 dest 를 도출 — onWorkerComplete·
 * recoverInterruptedJobs 공용. notifyDest 미지정 매니저(텔레그램 직접 발화)는 폴백이 현행 동작
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
// 매니저 완료 시 원 잡의 threadKey 로 *합성 user-turn* 을 주입해 메인 핸들러를 재진입 →
// 메인(같은 SYSTEM/AGENT 인격 + 그 thread history)이 결과를 받아 맥락 입혀 채널 보고.
// 채널로 나가는 텍스트는 *항상 메인 출력* (매니저 텍스트 직행 절대 금지, W-I1).

/**
 * daemon 부팅 시 1회 주입되는 핸들러 핸들. index.ts 가 메인 MessageHandler 를
 * registerWorkerHandler 로 등록 → onWorkerComplete 가 재주입 시 호출.
 * (index.ts → worker-jobs 순환을 피하려 setter 주입. region 의 lazy import 와 동형.)
 */
let mainHandler: MessageHandler | undefined;

/**
 * 메인 핸들러 등록 — index.ts 가 부팅 시 1회 호출.
 * 등록 전 onWorkerComplete 가 불리면(이론상 매니저가 핸들러보다 먼저 끝날 일 없음) 경고.
 */
// 매니저 스트림 스톨 → 유저 통지 (ADR 2026-07-02). codex 어댑터는 llm.stream_stall 만
// publish(채널 무결합) — 여기서 매니저 dest 로 "이어서 재개 중" 핑을 보낸다(deliverOutbound
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
      notice: true, // 인프라 통지 — 비서 발화 아님(렌더 구분).
      observeThreadKey: notifySessionThreadKey(job.threadKey),
    }).catch(() => {
      /* 통지 실패는 재개에 영향 0 */
    });
  });
};

// 매니저 도구 조기-경고 → 유저 통지 (2026-07-03). codex 어댑터가 `llm.tool_slow` 발행(도구가
// CODEX_TOOL_SLOW_WARN_MS 초과 실행). 매니저면 dest 로 "멈춤 — Mac 권한 확인" 핑을
// *잡당 1회*(스팸 방지) 보낸다. 권한요청/hung/느림 구분은 못 하나 "확인해봐"가 actionable —
// 실측: 매니저가 macOS 권한 다이얼로그에 조용히 막혀 30분+ 헤맴. 부팅 1회 구독. 통지 실패 무해.

/**
 * 이 도구의 지연을 **사용자에게 푸시**할 가치가 있는가.
 *
 * ★기준은 "느린가" 가 아니라 **사용자만 풀 수 있는 종류인가** (2026-07-27).
 *  이 통지의 존재 이유는 macOS 권한 다이얼로그·외부 앱 미실행처럼 *사람이 클릭해야*
 *  풀리는 막힘이다(Bash·외부 MCP). 그 경우 알리지 않으면 30분+ 날린다.
 *  반대로 서브에이전트(spawn_agent)는 (a) 원래 오래 걸리고(실측 평균 124초·최대 627초)
 *  (b) 진행 스텝이 백그라운드 드로어에 실시간으로 보인다 — 사용자가 할 조치가 없는데
 *  대화에 *비서 발화와 같은 모양으로* 끼어들어 "응답인 줄 알았다" 는 혼선만 만들었다.
 *  그래서 채널 푸시에서만 뺀다 — 로그·EventBus(관측)는 그대로라 진단 능력은 안 잃는다.
 */
export const shouldNotifyToolSlow = (tool: string): boolean =>
  // ★서브에이전트류는 푸시하지 않는다 — 오래 걸리는 게 정상이고 드로어에 스텝이 보인다.
  //  `Task`(claude 의 서브에이전트 도구)가 빠져 있어 claude 경로만 노이즈가 살아났다
  //  (2026-07-29 검토). 임계는 tool-watchdog 이 이미 같은 계층으로 묶고 있다.
  !isSubagentTool(tool);

const toolSlowNotified = new Set<string>();
/** 메인 턴 지연 통지 — threadKey 당 1회. 턴이 끝나면 아래 구독이 지운다(다음 턴엔 다시 알림). */
const mainTurnSlowNotified = new Set<string>();
let toolSlowNotifySubscribed = false;
const subscribeWorkerToolSlowNotify = (): void => {
  if (toolSlowNotifySubscribed) return;
  toolSlowNotifySubscribed = true;
  getEventBus().subscribe((event) => {
    // 턴이 끝나면 그 세션의 1회 마커를 푼다 — 다음 턴에서 또 멈추면 다시 알려야 한다.
    if (event.type === "llm.turn_done" || event.type === "llm.turn_error") {
      const doneTk =
        typeof event.payload.threadKey === "string" ? event.payload.threadKey : "";
      if (doneTk !== "") mainTurnSlowNotified.delete(doneTk);
      return;
    }
    if (event.type !== "llm.tool_slow") return;
    const tk =
      typeof event.payload.threadKey === "string" ? event.payload.threadKey : "";
    const tool =
      typeof event.payload.tool === "string" ? event.payload.tool : "도구";
    // ★메인 턴도 알린다 (2026-08-06) — 종전엔 매니저만이라, 대화 중 도구가 멈추면 사용자에게
    //  **아무 신호도 안 갔다**(경고는 로그에만). 회사 PC 실측: 39분 동안 화면엔 "작업 중"
    //  만 돌고 있었고, 느린 건지 멈춘 건지 알 방법이 없었다. 대시보드는 SSE 로 이 이벤트를
    //  직접 받아 그리므로(js/sse.js), 여기선 **화면을 안 보고 있는 채널**(텔레그램)만 민다.
    //  턴당 1회(스팸 방지) — 잡당 1회 규칙과 동형.
    if (!tk.startsWith("worker:")) {
      if (!shouldNotifyToolSlow(tool)) return;
      if (mainTurnSlowNotified.has(tk)) return;
      const chatId = extractTelegramChatId(tk);
      if (chatId === null) return; // 대시보드·CLI 는 화면에서 보므로 푸시 안 함(중복 방지).
      if (mainTurnSlowNotified.size > 500) mainTurnSlowNotified.clear();
      mainTurnSlowNotified.add(tk);
      const secs = Math.round(
        (typeof event.payload.ms === "number" ? event.payload.ms : 180_000) / 1000,
      );
      void deliverOutbound({
        channel: "telegram",
        target: chatId,
        text: formatToolSlowNotice({ tool, secs }),
        label: "tool-slow",
        notice: true, // 인프라 통지 — 비서 발화 아님.
        observeThreadKey: tk,
      }).catch(() => {
        /* 통지 실패는 턴에 영향 0 */
      });
      return;
    }
    const jobId = tk.slice("worker:".length);
    // ★게이트는 "잡당 1회" 마커보다 **앞** — 뒤에 두면 서브에이전트 지연이 그 잡의 1회
    //  슬롯을 먹어치워, 뒤이어 진짜 막힌 Bash 가 영영 통지되지 않는다.
    if (!shouldNotifyToolSlow(tool)) return;
    if (toolSlowNotified.has(jobId)) return; // 잡당 1회.
    const job = getJob(jobId);
    if (job === undefined) return;
    if (toolSlowNotified.size > 500) toolSlowNotified.clear(); // 누수 가드.
    toolSlowNotified.add(jobId);
    const dest = destForJob(job);
    const sec = Math.round(
      (typeof event.payload.ms === "number" ? event.payload.ms : 180_000) / 1000,
    );
    void deliverOutbound({
      channel: dest.channel,
      target: dest.target ?? null,
      text: formatToolSlowNotice({ tool, secs: sec, jobLabel: job.label }),
      label: "worker",
      notice: true, // 인프라 통지 — 비서 발화 아님(렌더 구분).
      observeThreadKey: notifySessionThreadKey(job.threadKey),
    }).catch(() => {
      /* 통지 실패는 작업에 영향 0 */
    });
  });
};

export const registerWorkerHandler = (handler: MessageHandler): void => {
  mainHandler = handler;
  subscribeWorkerStallNotify(); // 부팅 1회 — 매니저 스톨 재개 유저 통지 구독.
  subscribeWorkerToolSlowNotify(); // 부팅 1회 — 매니저 도구 멈춤(권한 등) 조기 통지 구독.
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
  // ★공용 판정·파서를 쓴다 (2026-07-30 검토 지적). 종전 정규식은 claude 의
  //  "You've hit your limit · resets 2:20am" 에 false → "모든 어댑터 실패" 분기로 떨어져
  //  **"잠시 후 다시 시켜주세요"** 를 출력했다. 실제론 수 시간 계정 한도라 적극적 오해였다
  //  (어젯밤 윈도우 인스턴스에서 실제로 그 문구가 나갔다).
  if (isRateLimited(raw)) {
    const ms = parseCooldownMs(raw);
    if (ms !== null) {
      // 문구는 `formatResetAt` 한 곳에서 — 여기서 다시 만들면 한쪽만 늙는다.
      return `LLM 사용량 한도 도달(429) — ${formatResetAt(ms)}에 풀립니다. 그 뒤 다시 시켜주세요.`;
    }
    return "LLM 사용량 한도 도달(429) — 잠시 후 한도가 리셋되면 다시 시켜주세요.";
  }
  // ── 시간 관련 종료 — **원인을 뭉치지 않는다** (2026-08-12, 사용자: "무슨 에러가 난 건지
  //    정확하게 알려주는 게 중요하지"). 종전엔 아래 셋을 한 정규식으로 묶어 전부
  //    **"LLM 응답이 멈춰(타임아웃)"** 라고 말했다. 그런데 실제로는 서로 다른 사건이다:
  //     · wall-clock 상한 = 작업이 **돌고 있었는데** 시계에 잘린 것(멈춘 게 아니다)
  //     · 도구 상한      = 도구 하나가 오래 걸린 것(모델은 멀쩡했다)
  //     · 유휴/첫토큰    = 진짜로 **아무것도 안 온** 것 — 이것만 "멈췄다" 가 맞다
  //    "멈췄다" 고 들으면 모델·백엔드를 의심하게 되는데, 앞의 둘은 그쪽이 아니다.
  //    ★1층 유휴는 현재 전 턴 면제(idleConfigExempt)라 사실상 안 온다 — 그래도 분류는 남긴다.
  if (/wall-clock 상한|매니저 처리 시간 초과/i.test(raw)) {
    const ms = /\((\d+)ms/.exec(raw);
    const hours = ms === null ? null : Math.round((Number(ms[1]) / 3_600_000) * 10) / 10;
    return (
      `작업이 ${hours === null ? "설정된" : `${hours}시간`} wall-clock 상한에 도달해 중단됐습니다 — ` +
      `**모델이 멈춘 게 아니라 진행 중이었을 수 있습니다.** 이어서 하거나 더 작은 단위로 나눠 시키면 상한에 안 걸립니다.`
    );
  }
  if (/도구 .*안 끝나|tool-hang/i.test(raw)) {
    return `도구 실행이 상한을 넘겨 턴이 중단됐습니다(${raw.slice(0, 160)}). 모델 문제가 아니라 그 도구가 오래 걸린 것입니다.`;
  }
  if (/유휴 타임아웃|idle timeout|first timeout/i.test(raw)) {
    return "모델이 정해진 시간 동안 **아무 응답도 보내지 않아** 중단됐습니다(유휴 타임아웃). 백엔드 상태를 의심할 자리입니다.";
  }
  if (/timeout|시간 초과/i.test(raw)) {
    // 분류 못 한 타임아웃 — **원문을 그대로 실어 보낸다.** 뭉뚱그린 문구로 덮으면
    // 사용자가 엉뚱한 곳을 뒤진다(그게 이 수정의 이유다).
    return `시간 관련 중단이 발생했습니다 — 원문: ${raw.slice(0, 200)}`;
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
 * 매니저 종료를 *LLM 무경유* 로 결정 전달하는 raw 아웃바운드 문구(done/failed/cancelled).
 *
 * 안전망 전용 — 정상 경로(LLM 재주입)가 메인 인격으로 자연스럽게 보고하지만, 모델 풀이
 * 죽어 재주입 turn 마저 실패하면(매니저 실패의 흔한 원인과 동일 — codex 429+claude idle)
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
  // 부분 진행 힌트 — daemon 경계엔 정확한 처리 건수가 없다(매니저 thread 의 부수효과로만
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
  // ★취소도 메인을 거친다 (2026-08-15, 사용자 확정: "티구클로에서는 메인 비서가 아는 게 맞다").
  //
  //  종전엔 `failed` 와 한 분기로 묶여 LLM 무경유 raw 통지로 직행했다. 그 분기의 근거 셋 중
  //  결정적인 것은 **모델 풀 소진**(codex 429 + claude idle)이었다 — 같은 죽은 풀로 재주입
  //  turn 을 돌리면 통지마저 침묵한다. 그런데 **취소엔 그 전제가 안 걸린다**: 사용자가 방금
  //  스스로 한 행동이고 그 순간 대화가 살아 있다. 나머지 근거도 안 맞는다 — 실패는 원인
  //  문자열이 전부지만 취소는 비서가 보탤 게 있다(대안 제시·계획 수정).
  //
  //  ★그래서 `failed` 와 묶은 것이 **과잉 일반화**였다. 취소를 메인이 모르면 이후 턴에서
  //   "그 작업 진행 중" 이라 말하거나 그 결과를 전제로 얘기를 잇는다.
  //
  //  ★raw 안전망은 그대로다 — `done` 과 같은 delivered 추적을 타므로 재주입이 침묵해도
  //   `buildRawNotice` 가 도착한다(그게 원래 근거가 지키던 것). 통지 미도착 0 유지.
  if (job.status === "cancelled") {
    return (
      `〔백그라운드 작업 취소 알림 — 사용자에게 짧게 확인해 주세요〕\n` +
      `작업: "${job.label}"\n` +
      `사용자가 이 작업을 취소했습니다(실패가 아닙니다).\n` +
      `〔/알림〕\n\n` +
      `취소됐음을 한 줄로 알리고, 이 작업에 걸려 있던 후속이 있으면 어떻게 할지 물어보세요. ` +
      `이미 한 일을 되돌리거나 새로 시작하지 마세요.`
    );
  }
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
 *  2-failed) LLM *무경유* raw 아웃바운드 직행(reacquireReply + buildRawNotice).
 *     매니저 실패의 흔한 원인이 모델 풀 소진(429+idle)이라, 같은 죽은 풀로 통지 turn 을 돌리면
 *     통지마저 침묵하기 때문(2026-06-22 실측). humanizeWorkerError 로 actionable. 메인 thread/
 *     직렬 큐 미경유(폴러 차단 0). recoverInterruptedJobs 의 raw 통지와 동형.
 *  2-done/cancelled) 합성 user-turn 으로 메인 핸들러 재주입(W-I1 — 결과는 맥락 입혀 보고).
 *     ★취소가 여기 있는 이유(2026-08-15): raw 직행의 근거는 "모델 풀이 죽어 통지마저 침묵"
 *     인데 취소엔 그 전제가 없다(사용자가 방금 한 행동). 메인이 모르면 이후 턴에서 "진행 중"
 *     이라 말한다. 안전망은 delivered 추적으로 그대로 붙는다. 재주입을
 *     await 해 delivered(실제 send 성공) 추적 → 미도달 시 raw 안전망(buildRawNotice)으로
 *     결과를 결정 전달. mainHandler(serializedHandler)가 *자체* enqueueThreadTurn 단일 직렬화
 *     하므로 직접 호출(이중 enqueue deadlock 0, 60d1777 유지).
 *
 * 본 함수는 매니저의 분리(fire-and-forget) promise 안에서 await 되므로 done 재주입을 await 해도
 * 채널 폴러·데몬 메인루프를 막지 않는다. 내부 try/catch 로 throw 0(데몬 생존, 원칙 3).
 *
 * @param outcome 성공이면 {result}, 실패면 {error}. error 는 호출자가 redact 후 전달 권장
 *                (방어로 본 모듈도 한 번 더 redact 통과시킨다).
 */
/**
 * 백그라운드 잡의 결과를 **소환자에게** 돌려준다 (ADR 2026-08-19 §4).
 *
 * 소환자가 둘이라 자리도 둘인데, **같은 기제를 쓰면 안 된다**:
 *
 * | 소환자 | 어디로 | 왜 |
 * |---|---|---|
 * | 돌고 있는 매니저 | 그 잡의 **steering 큐** | 매니저는 사용자에게 스트리밍하지 않으므로 "루프 계속" 이 안전하다. 다음 model-call 경계에서 이어받는다 |
 * | 세션(메인 비서) | **새 턴**(`onWorkerComplete`) | 메인은 이미 말을 끝내고 전송한 뒤다. 같은 턴에 이어붙이면 한 턴이 두 번 발화한다(U-I1 이 막으려던 것) |
 *
 * ★"돌고 있는" 이 조건이다 — 매니저가 이미 끝났으면 steering 채널이 없거나 닫혀 있고,
 *  그때는 새 턴 경로로 떨어져야 결과가 사라지지 않는다. `steerJob` 이 그 셋을
 *  (`delivered`/`closed`/`absent`) 구분해 주므로 판정을 여기서 다시 하지 않는다.
 *
 * @returns 매니저 큐로 전달했으면 true(호출자는 새 턴을 열지 않는다).
 */
const deliverToSummoner = (
  job: WorkerJobRecord,
  outcome: { result: string } | { error: string },
): boolean => {
  const parentId = parentJobIdOf(job.threadKey);
  if (parentId === undefined) return false; // 소환자가 세션 — 새 턴 경로.
  const parent = jobs.get(parentId);
  if (parent === undefined || parent.status !== "running") return false;
  // ★세 가지를 **구분**한다 (ADR 위험 목록 "취소 결과의 의미"). 종전엔 취소도
  //  `[… 완료] 실패했습니다: 사용자 요청으로 취소되었습니다.` 로 나갔다 — 한 문장에
  //  거짓이 둘이다(완료도 실패도 아니다). 매니저가 그걸 고장으로 읽으면 **사용자가 방금
  //  멈춘 작업을 다시 띄운다** — 명시적 사용자 행위를 모델이 되돌리는 셈이라, 사용자는
  //  멈췄는데 계속 도는 걸 보게 된다.
  // ★취소를 **가장 먼저** 본다 (2026-08-20 적대 검토 A5). `onWorkerComplete` 는 취소 직후
  //  매니저가 마지막 도구를 끝내고 결과를 낸 경우에도 취소 상태를 보존한다(코드가 명시적으로
  //  다루는 실재 경로) — 그때 `{result}` 가 들어오므로, `"result" in outcome` 을 먼저 보면
  //  **사용자가 멈춘 작업을 "완료 · 결과" 로 보고**하게 된다. 이 함수가 막으려던 그 오독이다.
  const head =
    job.status === "cancelled"
      ? `[백그라운드 서브에이전트 '${job.label}' **중지됨**] 사용자가 이 작업을 멈췄습니다 — ` +
        `고장이 아닙니다. **다시 띄우지 마세요.** 남은 작업만 이어가고, 이 몫이 꼭 필요하면 ` +
        `사용자에게 먼저 물어보세요.`
      : "result" in outcome
        ? `[백그라운드 서브에이전트 '${job.label}' 완료] 결과:\n${outcome.result}`
        : `[백그라운드 서브에이전트 '${job.label}' 실패] ${outcome.error}`;
  // raw 는 **사용자 원문** 자리다(steering.ts 주석) — 여기엔 사용자가 친 게 없으므로
  // 둘을 같은 값으로 둔다. 서로 다른 문구를 넣으면 미소비 재주입 때 사용자 화면에
  // 우리 framing 이 "사용자가 보낸 메시지" 로 노출된다(2026-07-27 실사고와 같은 창).
  const text = head;
  // ★개입 큐가 아니라 **결과 수신함**으로 (위 jobResultChannels 주석의 실측 근거).
  const box = jobResultChannels.get(parentId);
  if (box === undefined) return false;
  const ok = box.push({ text, raw: text, ts: Date.now(), source: "job" });
  publishSteerAttempt({
    jobId: parentId,
    message: text,
    outcome: ok ? "delivered" : "closed",
  });
  return ok;
};

export const onWorkerComplete = async (
  jobId: string,
  outcome: { result: string } | { error: string },
): Promise<void> => {
  // 1) 레지스트리 마킹. 단 이미 cancelled 면(cancelJob 이 abort 전 마킹) 그 status 보존 —
  //    abort 가 runRegionA 를 reject 시켜 여기로 error 가 와도 "실패" 아닌 "취소"로 통지.
  const existing = jobs.get(jobId);
  if ("result" in outcome) {
    // 취소 직후 매니저가 마지막 도구를 끝내고 결과를 낸 희귀 경우 — 취소 의도 보존(통지 일관).
    if (existing?.status !== "cancelled") markDone(jobId, outcome.result);
  } else if (existing?.status === "cancelled") {
    // 이미 취소 마킹됨 — 재마킹 불요(멱등). buildCompletionPrompt 가 취소 문구로 분기.
  } else {
    // 시크릿 누수 0 — redactSecrets 통과 후 기록 (architect §7).
    const { redactSecrets } = await import("./outbound-sanitize.js");
    markFailed(jobId, redactSecrets(outcome.error));
  }

  const found = jobs.get(jobId);
  if (found === undefined) {
    console.error(`worker-jobs: onWorkerComplete unknown jobId=${jobId}`);
    return;
  }
  // ─── ① 소환자가 **돌고 있는 매니저**면 그 턴의 steering 큐로 (ADR 2026-08-19 §4) ────
  // 새 턴을 여는 아래 경로보다 **먼저** 본다: 매니저 좌표(`worker:<id>`)로 합성 유저턴을
  // 열면 그 턴은 돌고 있는 매니저에게 안 닿고(매니저는 핸들러가 아니라 runRegionA 안이다)
  // 별개 턴으로 새 나간다. 소환자가 세션이거나 매니저가 이미 끝났으면 false 로 떨어져
  // 아래 종전 경로로 간다(회귀 0).
  if (deliverToSummoner(found, outcome)) {
    console.log(
      `worker-jobs: '${found.label}'(${jobId}) 결과를 소환자 매니저 ` +
        `${parentJobIdOf(found.threadKey) ?? "?"} 의 steering 큐로 전달 — 다음 model-call 경계에서 반영`,
    );
    return;
  }

  // ─── ①-b 연쇄 취소는 **부모 알림 하나로** 닫는다 (2026-08-19) ───────────────────
  //  사용자가 매니저를 중지하면 그 밑 자식이 전부 같이 끊긴다(cancelDescendants). 그런데
  //  자식마다 완료 통지가 나가면 **한 번 누른 중지에 알림이 잡 수만큼** 온다(실측: 자식 2 →
  //  알림 3번). `wait:false` 이전엔 서브가 이 경로를 안 타서 1번이었으니 내가 만든 회귀다.
  //  ★잡 기록·대시보드 이벤트는 그대로 남는다(publishWorkerLifecycle 은 markCancelled 안).
  //   지우는 게 아니라 **말하지 않는** 것이다 — 사용자가 이미 아는 사실이라서.
  if (isCascadeCancelled(found)) {
    console.log(
      `worker-jobs: '${found.label}'(${jobId}) 연쇄 취소 — 상위 알림으로 갈음(개별 통지 생략)`,
    );
    return;
  }

  // ─── ② 보고 좌표 환원 — 소환자가 **잡인데 이미 끝난** 경우 (2026-08-19) ───────────
  //
  //  백그라운드 서브의 `threadKey` 는 소환자 좌표다. 소환자가 매니저면 `worker:<id>` 인데,
  //  그 매니저가 자식보다 **먼저 끝나면** 아래 재주입이 그 좌표로 합성 턴을 연다.
  //  `worker:<id>` 는 사용자 세션이 아니다 — 실측하면 발송 대상이 없어 "미배달 45자" 로
  //  떨어지고 결과는 **아무도 못 본다**(조용한 손실). 지휘자가 연주자보다 먼저 끝나는 건
  //  드문 일이 아니다: 매니저가 여럿을 `wait:false` 로 띄우고 자기 할 말을 끝내면 바로 이
  //  상황이다. `wait:false` 를 만들면서 내가 낸 구멍이라 여기서 닫는다.
  //
  //  `resolveOwnerThreadKey` 가 자식→부모→…→세션으로 환원한다(이미 있던 함수 — 대시보드
  //  세션 귀속이 같은 문제를 이미 풀어놨다). 소환자가 처음부터 세션이면 그대로다(회귀 0).
  //  ★반드시 ① **뒤**에 온다 — 먼저 하면 좌표가 세션으로 바뀌어 "돌고 있는 매니저" 를
  //   못 찾고 매니저 라우팅이 통째로 죽는다.
  const owner = resolveOwnerThreadKey(found.threadKey);
  const job =
    parentJobIdOf(found.threadKey) !== undefined &&
    owner !== "" &&
    owner !== found.threadKey
      ? ((): WorkerJobRecord => {
          console.log(
            `worker-jobs: '${found.label}'(${jobId}) 의 소환자(${found.threadKey})가 이미 끝나 ` +
              `보고 좌표를 소유 세션 ${owner} 로 환원`,
          );
          return { ...found, threadKey: owner };
        })()
      : found;

  if (mainHandler === undefined) {
    console.error(
      `worker-jobs: 메인 핸들러 미등록 — 매니저 '${job.label}'(${jobId}) 완료 보고 불가`,
    );
    return;
  }

  // notifyDest(스케줄 등이 주입한 generic 좌표) 우선, 없으면 channel/threadKey 폴백(회귀 0).
  // baseReply = 우회 통지용(관측 발행 O) — failed/cancelled 직행·done 안전망이 이걸 쓴다.
  const dest = destForJob(job);
  const baseReply = reacquireReply(dest, {
    sessionThreadKey: notifySessionThreadKey(job.threadKey),
  });

  // ─── 실패 — LLM 무경유 raw 통지로 *결정* 전달 (actionable, deadlock-free) ──────
  // failed 는 (a) 사용자가 *무조건* 알아야 하는 운영 사건이고, (b) LLM 이 실패
  // 원인에 보탤 material 이 없으며(원인 문자열이 곧 전부), (c) 매니저 실패의 흔한 원인이 모델 풀
  // 소진(codex 429 + claude idle, 2026-06-22 실측)이라 *같은 죽은 풀로 재주입 turn 을 돌리면
  // 통지마저 침묵* 한다. → recoverInterruptedJobs 와 동형으로 raw 아웃바운드 직행해 모델
  // 상태와 무관하게 결정적으로 전달한다(LLM-agnostic — 어댑터·모델 무관). humanizeWorkerError
  // 가 "왜·언제 다시"(예 429 → ~N분 후 리셋)를 담아 actionable(임무 §2). 채널 직행이라 메인
  // thread/직렬 큐를 안 타 폴러·메인루프 차단 0(fire-and-forget 격리 유지). 본 함수는 매니저의
  // 분리된 promise 안에서 await 되므로 데몬 메인루프와 무관.
  // ★`failed` 만 raw 직행이다 (2026-08-15). `cancelled` 는 아래 재주입 경로로 간다 —
  //  근거는 buildCompletionPrompt 의 취소 분기 주석에.
  if (job.status !== "done" && job.status !== "cancelled") {
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

  // ─── 성공(done)·취소(cancelled) — 메인 인격 재주입 + raw 안전망 ──────────────────
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
  // threadKey(dashboard:*)이면서 job.channel 이 canonical 과 다를 때만(telegram/cli發 매니저)
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
    // ★이 답이 실제로 나가는 좌표 — egress fan-out 이 같은 곳에 또 보내지 않게.
    replyTarget: { channel: dest.channel, target: dest.target ?? null },
  };

  // 메인 핸들러로 재주입 (유저 interim turn 과 직렬). ★ mainHandler(=serializedHandler)
  // 가 *자체적으로* enqueueThreadTurn 으로 직렬화하므로 여기서 또 enqueueThreadTurn 으로
  // 감싸면 같은 thread 에 이중 enqueue → 재진입 deadlock(외부 task 가 내부 task 를 await 하는데
  // 내부 task 는 외부 tail 을 기다림) → 통지 턴이 영영 실행 안 됨(2026-06-20 발견). 직접 호출해
  // 단일 enqueue 로 닫는다. 재주입을 *await* 해 delivered 를 본 뒤 안전망을 결정한다 — 이
  // await 은 매니저의 분리 promise 안이라 데몬 메인루프·폴러를 막지 않는다(매니저는 fire-and-forget).
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
// 재시작/크래시로 중단된 매니저(DB status='running')를 사용자에게 정직 통지. index.ts 가
// 채널 start 직후 1회 호출. 통지는 *raw 아웃바운드*(LLM 무경유) — 모델 풀이 죽어 있어도
// 결정적으로 전달된다. 통지 후 status='interrupted' 전이 → 다음 부팅 재통지 0(멱등).

/**
 * 중단 사실을 **관측자에게 알린다** (2026-07-29).
 *
 * ★사고: 재시작하면 DB status 만 조용히 running→interrupted 로 바뀌고 **이벤트가 안 나갔다.**
 *  started/done/failed/cancelled 는 전부 발행하는데 이 전이만 빠져 있었다. 그래서 이벤트
 *  스트림만 보는 관측자(대시보드 SSE replay 등)는 "시작"만 알고 "끝"을 영영 못 배웠고,
 *  재시작 후에도 매니저·서브에이전트가 진행 중으로 남았다(사용자 신고). 실측: dev events 에
 *  종료 이벤트가 아예 없는 worker.started 6건.
 *  대시보드는 이걸 클라이언트 폴링(/api/worker-jobs 대조)으로 덮고 있었는데, 그건 부팅·
 *  재연결 시점에만 도는 **부분 보정**이다 — 사실을 안 알리는 쪽이 근본이다.
 *  발행 실패가 부팅을 막지 않게 조용히 삼킨다(복구 자체는 DB 전이로 이미 끝났다).
 */
const publishInterrupted = (
  job: ReturnType<typeof listInterruptedWorkerJobs>[number],
): void => {
  try {
    publishWorkerLifecycle("worker.interrupted", { ...job, status: "interrupted" }, {
      error: "데몬 재시작으로 중단",
      task: (job as { task?: string }).task,
    });
  } catch {
    // 관측 발행 실패는 복구를 되돌리지 않는다.
  }
};

/**
 * 잡 소유 대화로 **raw 통지**(LLM 무경유). 매니저 잔여 steer 고지처럼, 모델 턴을 새로 태우지
 * 않고 사실만 결정적으로 전달해야 하는 곳이 쓴다 — recoverInterruptedJobs 의 중단 통지와 동형.
 * 발송 실패는 호출부가 흡수한다(통지 실패가 매니저 종료를 되돌리지 않는다).
 */
export const notifyJobOwner = async (
  job: {
    jobId: string;
    label: string;
    threadKey: string;
    channel: string;
    notifyDest?: WorkerNotifyDest;
  },
  text: string,
): Promise<void> => {
  const reply = reacquireReply(
    destForJob({
      channel: job.channel as ChannelName,
      threadKey: job.threadKey,
      notifyDest: job.notifyDest,
    }),
    { sessionThreadKey: notifySessionThreadKey(job.threadKey) },
  );
  await reply(text);
};

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
    // U-I5: **awaited** 서브에이전트는 부모 turn 에 종속 — 재시작 시 부모도 사라져 통지
    // 대상이 없다(고아 통지 방지). status='interrupted' 마킹만 하고 통지는 생략.
    //
    // ★판정을 `kind === "agent"` 에서 `!detached` 로 바꿨다 (2026-08-19). 종전 판정의
    //  근거는 "부모 turn 에 종속" 인데, `spawn_agent(wait:false)` 로 띄운 서브는 부모 턴을
    //  이미 놓았고 **소환자(세션·매니저)는 재시작 후에도 살아 있다.** 그런데도 kind 로
    //  거르면 그 결과는 아무에게도 안 가고 사용자는 시킨 일이 사라진 걸 모른다 —
    //  조용한 손실이라 신고조차 안 들어온다. 근거가 실행 축이었으니 판정도 실행 축으로 한다.
    if (!job.detached) {
      persistSafe("recover-agent", () =>
        updateWorkerJobStatus(job.jobId, "interrupted", Date.now()),
      );
      publishInterrupted(job);
      continue;
    }
    const text =
      `⚠️ 이전에 맡긴 백그라운드 작업 '${job.label}'이 데몬 재시작으로 중단됐어요. ` +
      `결과를 받지 못했으니, 필요하면 다시 시켜주세요.`;
    try {
      // 영속된 notifyDest(store 가 미러)가 있으면 그걸로, 없으면 channel/threadKey 폴백 →
      // 재시작 후에도 스케줄 매니저 통지가 올바른 chatId 로 도달(정직 통지 강화). store 가
      // notifyDest 컬럼을 아직 안 실어도 폴백이 현행 동작 재현(회귀 0). job.notifyDest 는
      // PersistedWorkerJob 에 additive 라 미존재 시 undefined → 폴백 분기.
      const reply = reacquireReply(
        destForJob({
          channel: job.channel as ChannelName,
          threadKey: job.threadKey,
          notifyDest: (job as { notifyDest?: WorkerNotifyDest }).notifyDest,
        }),
        { sessionThreadKey: notifySessionThreadKey(job.threadKey) },
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
    publishInterrupted(job);
  }
  // 터미널 전이(interrupted) 배치 종료 후 1회만 prune — 루프 안에서 N번 부르지 않음(§5 얇게).
  if (interrupted.length > 0) pruneTerminalJobsSafe();
  if (interrupted.length > 0) {
    console.log(
      `worker-jobs: 재시작으로 중단된 매니저 ${interrupted.length}건 정직 통지`,
    );
  }
};

// ─── region 이 호출할 발사 API 경계 (architect §9-a/§9-b) ─────────────────────
// startWorkerJob = (a) registerJob (b) region 의 runWorkerJob 을 fire-and-forget 호출.
// 단 runWorkerJob(매니저 실행 본체 = runRegionA on worker:<jobId>)은 region 파트 →
// 본 모듈은 그 함수를 *주입* 받아 호출만 한다(경계 명확, 순환은 region 이 lazy import).

/**
 * region 이 구현·주입하는 매니저 실행 본체 시그니처.
 *  - job: 본 모듈이 registerJob 으로 만든 레코드 (jobId·task·threadKey 등).
 *  - 매니저는 `worker:<jobId>` thread 에서 runRegionA 실행(메인 history 청결, §3).
 *  - workerDepth:1 가드 + createJobAbort().signal 주입은 region 책임(daemon 헬퍼 제공).
 *  - 완료/실패 시 onWorkerComplete(jobId, ...) 를 부른다 (await 불필요).
 *  - fire-and-forget — 반환 즉시(매니저는 백그라운드). throw 금지(내부에서 onComplete 로 닫음).
 */
export type WorkerRunner = (job: WorkerJobRecord) => void;

let workerRunner: WorkerRunner | undefined;

/**
 * region 의 worker-registry 가 부팅 시(또는 lazy) 매니저 실행 본체를 주입.
 * 미주입 상태에서 startWorkerJob 호출 시 명시 에러(사일런트 실패 회피).
 */
export const registerWorkerRunner = (runner: WorkerRunner): void => {
  workerRunner = runner;
};

/**
 * 등록된 러너 조회 — **배선 검사용**. 적대 검토(2026-08-20 B3)에서
 * `registerWorkerRunner(runWorkerJob)` 을 `registerWorkerRunner(() => {})` 로 바꿔도
 * 스위트가 초록이었다(검사들이 러너를 *직접* 부르기 때문). 그러면 `run_in_background` 가
 * jobId 만 주고 아무것도 안 돌며 잡은 영원히 running 이다 — 조용히, 전 사용자에게.
 */
export const getRegisteredWorkerRunner = (): WorkerRunner | undefined => workerRunner;

export interface StartWorkerJobInput {
  label: string;
  task: string;
  /**
   * **부르는 쪽**의 workerDepth — 0=메인, ≥1=매니저 안 (2026-08-21 적대 검토 A-F2).
   *
   * ★W-I5("매니저는 새 매니저를 못 띄운다")의 집행점이 종전엔 **어댑터 게이트 셋뿐**이었다.
   *  셋 다 풀어도 회귀 1,461건이 초록이었고 코어엔 재발사 가드가 아예 없었다 — 무한 백그라운드
   *  팬아웃이 조용히 가능했다는 뜻이다. 형제 불변식인 손자 금지(subagentDepth)는 코어가 막는데
   *  이쪽만 비대칭으로 비어 있었다.
   *  게다가 이 배치가 매니저에게 "새 매니저는 띄울 수 없습니다" 라고 **문장으로 단언**하기
   *  시작해서, 게이트가 풀리면 역할 문구가 거짓말을 하는 경로까지 생겼다.
   *
   * ★필수 필드다 — 빼면 타입체크가 막는다(이미 도는 게이트를 그물로 쓴다).
   */
  callerWorkerDepth: number;
  /** 완료 재주입이 합류할 원 thread (메인 turn 의 threadKey). */
  threadKey: string;
  channel: ChannelName;
  channelUserId: string;
  /**
   * 완료/실패 통지 generic 목적지 (additive). 매니저 발사 도구(run_in_background)가
   * parentInput.notifyDest 를 읽어 채운다 — 스케줄이 dest(telegram/chatId)를 주입하는 경로.
   * 미지정(텔레그램 직접 발화 등)이면 channel/threadKey 폴백(회귀 0).
   */
  notifyDest?: WorkerNotifyDest;
  /**
   * 실행 cwd(관측+동작) — run_in_background(path=X) 가 프로젝트 스코프 위임 시 그 폴더.
   * registerJob 으로 흘러 잡 레코드·SSE 에 실리고(대시보드 프로젝트 귀속), runner 가
   * 이 값을 childInput.cwd 로 써 매니저의 file-ops 상대경로가 그 폴더 기준(3b). 미지정=home 폴백.
   */
  cwd?: string;
  /**
   * 매니저 모델 등급(high/mid/low/nano 또는 provider:model). run_in_background(tier=X) 가
   * 채운다 — registerJob 이 레코드로 흘려 runner 가 resolveTier→specs 로 그 티어 풀 사용
   * (미지정 시 기본 모델). 서브에이전트 model 등급과 동일 경로. 대시보드 관측에도 실림.
   */
  modelTier?: string;
}

/**
 * spawn_worker 도구가 호출하는 발사 API (즉시 jobId 반환 — W-I2 메인 안 갇힘).
 *  1) registerJob → jobId.
 *  2) region 이 주입한 workerRunner 를 fire-and-forget 호출 (매니저는 백그라운드 진행).
 *  3) jobId 즉시 반환 → 도구는 {jobId, status:"started"} 로 응답.
 *
 * runner 미등록(부팅 순서 이상)이면 잡을 즉시 failed 마킹 + throw 없이 jobId 반환
 * (도구가 정직 보고하도록 — 단 보통은 등록 보장됨).
 */
export const startWorkerJob = (input: StartWorkerJobInput): string => {
  // ★코어 가드 (W-I5) — 어댑터 게이트가 풀려도 여기서 막힌다. 조용히 무시하지 않고 **던진다**:
  //  부른 쪽(도구 핸들러)이 잡아서 모델에게 이유를 돌려줘야, 모델이 다른 길을 고른다.
  if (input.callerWorkerDepth > 0) {
    throw new Error(
      "매니저 안에서는 새 매니저를 띄울 수 없습니다(W-I5). " +
        "필요한 병렬 작업은 spawn_agent 로 서브에이전트를 띄우거나 직접 처리하세요.",
    );
  }
  const jobId = registerJob(input);
  if (workerRunner === undefined) {
    markFailed(jobId, "매니저 실행기 미등록(부팅 순서 이상)");
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
