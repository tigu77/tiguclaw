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
import type { ChannelName, MessageHandler } from "../channels/types.js";

// ─── 잡 레코드 (architect §6) ────────────────────────────────────────────────

export type WorkerJobStatus = "running" | "done" | "failed";

export interface WorkerJobRecord {
  jobId: string;
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
}

/**
 * 잡 등록 → jobId 반환. spawn_worker 도구가 fire-and-forget 발사 직전 호출.
 * status="running" / startedAt=now 로 시작.
 */
export const registerJob = (input: RegisterJobInput): string => {
  const jobId = randomUUID();
  jobs.set(jobId, {
    jobId,
    label: input.label,
    task: input.task,
    threadKey: input.threadKey,
    channel: input.channel,
    channelUserId: input.channelUserId,
    status: "running",
    startedAt: Date.now(),
  });
  return jobId;
};

/** 워커 성공 — 결과 기록. 재주입(채널 보고)은 onWorkerComplete 가 별도 수행. */
export const markDone = (jobId: string, result: string): void => {
  const job = jobs.get(jobId);
  if (job === undefined) return;
  job.status = "done";
  job.result = result;
  job.finishedAt = Date.now();
};

/** 워커 실패/타임아웃 — 원인 기록. */
export const markFailed = (jobId: string, error: string): void => {
  const job = jobs.get(jobId);
  if (job === undefined) return;
  job.status = "failed";
  job.error = error;
  job.finishedAt = Date.now();
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
};

// ─── 워커 전용 타임아웃 (architect §5, W-I6) ─────────────────────────────────
// 워커는 2층 턴 타임아웃(480s) *제외* — 길게 도는 게 정상. 대신 워커 전용 상한을
// 기존 abortSignal 메커니즘(turn-timeout.ts 동형)으로 주입. 1층 idle 은 어댑터가 그대로.
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

export interface WorkerAbort {
  /** runRegionA(input.abortSignal) 로 운반할 signal — 어댑터가 1층 idle 과 OR 결합. */
  signal: AbortSignal;
  /** 워커 정상/throw 종료 시 호출 — 타이머 해제 (누수·오발화 0). 멱등. */
  done(): void;
}

/**
 * 워커 전용 abortSignal 발급 — 만료 시 WorkerTimeoutError 로 abort.
 * region 의 runWorkerJob 이 호출해 `RegionASdkInput.abortSignal` 로 주입한다
 * (새 메커니즘 0, 값만 워커 전용 — architect §5).
 */
export const createWorkerAbort = (
  ms: number = WORKER_TIMEOUT_MS,
): WorkerAbort => {
  const ac = new AbortController();
  const handle = setTimeout(() => {
    if (!ac.signal.aborted) ac.abort(new WorkerTimeoutError(ms));
  }, ms);
  (handle as { unref?: () => void }).unref?.();
  return {
    signal: ac.signal,
    done(): void {
      clearTimeout(handle);
    },
  };
};

// ─── thread 별 turn 직렬 큐 (architect §4, W-I4 보강) ────────────────────────
// 현 핸들러에 turn 직렬화 락 없음 → 완료-turn 재주입이 유저 interim 메시지와 같은
// thread resume 을 동시에 건드려 race. `Map<threadKey, Promise>` chain 으로 threadKey
// 별 직렬화(전역 락 아님 — 다른 thread 는 병렬). scheduler inFlight 의 thread 단위 일반화.

const threadTails = new Map<string, Promise<unknown>>();

/**
 * 같은 threadKey 작업을 직렬화 — 앞 작업 settle(성공/실패 무관) 후 다음 시작.
 * 다른 threadKey 는 병렬. 작업 throw 가 체인을 끊지 않게 tail 은 항상 settle 로 잇는다.
 *
 * 반환 = 이 작업의 결과 Promise (호출자가 await 가능). chain 무결성은 내부 tail 이 보장.
 */
export const enqueueThreadTurn = <T>(
  threadKey: string,
  task: () => Promise<T>,
): Promise<T> => {
  const prev = threadTails.get(threadKey) ?? Promise.resolve();
  // 앞 작업이 reject 해도 다음이 실행되도록 catch 로 흡수한 prev 에 chain.
  const run = prev.then(() => task(), () => task());
  // tail 은 결과/에러 무관 settle 로 — chain 끊김 0. 최신 tail 만 추적(완료 후 정리).
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  threadTails.set(threadKey, tail);
  // tail 이 끝나고 그 사이 새 turn 이 안 들어왔으면 map 엔트리 정리 (누수 0).
  void tail.finally(() => {
    if (threadTails.get(threadKey) === tail) {
      threadTails.delete(threadKey);
    }
  });
  return run;
};

/** 테스트·진단용 — 현재 직렬 큐가 추적 중인 thread 수. */
export const pendingThreadCount = (): number => threadTails.size;

// ─── reply 클로저 재획득 (architect §3-b) ────────────────────────────────────
// 워커는 원 turn 의 reply 클로저를 안 들고 있다(원 turn 종료). 재주입 turn 의 reply 를
// 채널명→send 매핑으로 재구성. dispatcher.ts 의 telegram/cli 분기와 *동일 의미* —
// 단 dispatcher 는 결과 텍스트 직접 push 였고, 여기선 핸들러 재진입의 reply 통로.
// (telegram threadKey "tg:<chatId>" → chatId 복원, cli → console.log.)

import { sendOutgoing as telegramSendOutgoing } from "../channels/telegram.js";
import type { ReplyOptions } from "../channels/types.js";

/**
 * 원 잡의 channel/threadKey 로 reply 클로저 재획득.
 * 미지원 채널은 console.warn + no-op reply (사일런트 실패 회피 — dispatcher 동형).
 */
const reacquireReply = (
  channel: ChannelName,
  threadKey: string,
): ((text: string, opts?: ReplyOptions) => Promise<void>) => {
  if (channel === "telegram") {
    // threadKey "tg:<chatId>" → chatId. sendOutgoing 이 HTML→plain 폴백·분할 보유.
    const chatId = threadKey.startsWith("tg:")
      ? threadKey.slice("tg:".length)
      : threadKey;
    return async (text: string): Promise<void> => {
      await telegramSendOutgoing(chatId, text);
    };
  }
  if (channel === "cli") {
    return async (text: string): Promise<void> => {
      console.log(text);
    };
  }
  // 미지원 채널 — 완료 보고를 콘솔에만 (데몬 생존, W-I7 정직).
  return async (text: string): Promise<void> => {
    console.warn(
      `worker-jobs: reply 재획득 미지원 채널 "${channel}" (thread=${threadKey}) — 콘솔 출력만:\n${text}`,
    );
  };
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
export const registerWorkerHandler = (handler: MessageHandler): void => {
  mainHandler = handler;
};

/** redact 헬퍼 lazy import 캐시 (모듈 로드 순환 회피 — outbound-sanitize 는 안전하나 일관성). */
const buildCompletionPrompt = (job: WorkerJobRecord): string => {
  if (job.status === "done") {
    return (
      `〔백그라운드 작업 완료 알림 — 사용자에게 보고하세요〕\n` +
      `작업: "${job.label}"\n` +
      `결과:\n${job.result ?? ""}\n` +
      `〔/알림〕\n\n` +
      `위 결과를 사용자에게 자연스럽게 보고하세요.`
    );
  }
  return (
    `〔백그라운드 작업 '${job.label}' 실패 알림 — 사용자에게 정직히 알리세요〕\n` +
    `원인: ${job.error ?? "알 수 없는 오류"}\n` +
    `〔/알림〕\n\n` +
    `위 작업이 실패했음을 사용자에게 자연스럽게 알리세요.`
  );
};

/**
 * region 의 runWorkerJob 이 호출하는 *완료 훅* (인계 경계).
 *
 * 흐름:
 *  1) result/error 로 레지스트리 마킹 (markDone/markFailed).
 *  2) 합성 user-turn(IncomingMessage) 구성 — 원 잡 threadKey/channel/channelUserId,
 *     reply 는 reacquireReply 로 재획득.
 *  3) thread 직렬 큐(enqueueThreadTurn)에 합류 → 메인 핸들러 재진입.
 *     같은 thread 의 유저 interim turn 과 직렬화(race 0, W-I4).
 *  4) 채널로 나가는 텍스트는 메인 핸들러 출력뿐 (W-I1). 워커 출력은 prompt 안 스캐폴딩.
 *
 * region 측은 워커(runRegionA) settle 후 이 함수를 *await 없이* 부르면 된다
 * (재주입은 직렬 큐가 비동기 관리). 본 함수 자체는 throw 하지 않음(데몬 생존, 원칙 3).
 *
 * @param outcome 성공이면 {result}, 실패면 {error}. error 는 호출자가 redact 후 전달 권장
 *                (방어로 본 모듈도 한 번 더 redact 통과시킨다).
 */
export const onWorkerComplete = async (
  jobId: string,
  outcome: { result: string } | { error: string },
): Promise<void> => {
  // 1) 레지스트리 마킹.
  if ("result" in outcome) {
    markDone(jobId, outcome.result);
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

  // 2) 합성 user-turn 구성. text = 내부 스캐폴딩(메인이 echo 안 하도록 sysprompt +
  //    stripInternalRuntimeScaffolding 이중 방어). reply = 채널 재획득.
  const reply = reacquireReply(job.channel, job.threadKey);
  const synthetic = {
    channel: job.channel,
    channelUserId: job.channelUserId,
    threadKey: job.threadKey,
    text: buildCompletionPrompt(job),
    receivedAt: Date.now(),
    reply,
  };

  // 3) thread 직렬 큐 합류 — 유저 interim turn 과 같은 threadKey 면 직렬(race 0).
  //    재주입 자체 실패(채널 send throw 등)는 console.error 로 격리(데몬 생존, §7).
  const handler = mainHandler;
  enqueueThreadTurn(job.threadKey, async () => {
    await handler(synthetic);
  }).catch((e) => {
    const reason = e instanceof Error ? e.message : String(e);
    console.error(
      `worker-jobs: 완료 재주입 실패 (job='${job.label}' ${jobId} thread=${job.threadKey}): ${reason}`,
    );
  });
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
