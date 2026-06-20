/**
 * 백그라운드 워커 — region 파트 (발사 도구 MCP 서버 + 워커 실행 본체 WorkerRunner).
 *
 * 진실 소스: architect contract `_workspace/background-worker_architect.md`
 * (§2 발사 도구, §9-a region 구현, 불변식 W-I1~W-I8). daemon 인프라(잡 레지스트리·
 * 완료 재주입·thread 직렬 큐·reply 재획득·워커 전용 abortSignal)는 `core/worker-jobs.ts`
 * 가 *이미* 제공 — 본 모듈은 그 깨끗한 API 를 써서 두 가지만 올린다:
 *
 *  1) 워커 실행 본체 (WorkerRunner) — `runRegionA` 를 `worker:<jobId>` 격리 thread 에서
 *     workerDepth:1 로 *fire-and-forget* 실행, settle 시 daemon 의 `onWorkerComplete`
 *     콜백. 모듈 import 시 `registerWorkerRunner(runner)` self-register.
 *  2) 발사 도구 MCP 서버 `createWorkerMcpServer(parentInput)` (spawn_agent 팩토리 동형):
 *     - `run_in_background({task, label})` → `startWorkerJob(...)` 즉시 jobId 반환(블로킹 0).
 *     - `list_workers({})` → `listJobs(...)` 포맷.
 *
 * 경계 (누가 뭘 부르나):
 *  - 도구 `run_in_background` → daemon `startWorkerJob` (registerJob + workerRunner 발사).
 *  - daemon `startWorkerJob` → 본 모듈 `workerRunner(job)` (fire-and-forget).
 *  - `workerRunner` settle → daemon `onWorkerComplete(jobId, {result}|{error})` (메인 재주입).
 *  - 채널로 나가는 텍스트는 *항상* 메인 재주입 turn 출력 (W-I1). 워커 출력 직행 0.
 *
 * LLM-agnostic (W-I3): 발사 도구는 claude/codex/openai *동일 의미* 등록(어댑터 분기 0).
 *   spawn_agent 의 createSpawnAgentMcpServer 등록 지점과 동형.
 */
import { z } from "zod";
import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import {
  cancelJob,
  createWorkerAbort,
  getJob,
  listJobs,
  onWorkerComplete,
  registerWorkerRunner,
  startWorkerJob,
  WorkerTimeoutError,
  WORKER_TIMEOUT_MS,
  WORKER_HARD_GRACE_MS,
  type WorkerJobRecord,
} from "../../worker-jobs.js";
import { getLastWorkerActivity } from "../../../store/events.js";
import type { RegionASdkInput } from "../types.js";

// ─── 워커 실행 본체 (WorkerRunner — architect §9-a) ───────────────────────────
// runRegionA 로 메인 동급 full capability. await 하지 않고 fire-and-forget — runner 는
// 즉시 반환하고(startWorkerJob 즉시 jobId), 워커는 백그라운드 Promise 로 진행한다.
//
// 워커 작업 turn input:
//  - threadKey: `worker:<jobId>` (메인 thread 와 분리 — 워커 중간 도구 turn 이 메인
//    history 를 오염시키지 않게. 최종 결과만 daemon 이 메인 thread 로 재주입, §3·§12-1).
//  - workerDepth: 1 (어댑터가 run_in_background/list_workers 미등록 → 재발사 차단, W-I5).
//  - subagentDepth: 0 (미설정) — 워커 안 spawn_agent 블로킹 위임은 허용(§2, W-I5 직교).
//  - abortSignal: createWorkerAbort() 의 signal (워커 전용 상한 30분, §5·W-I6).
//    어댑터가 1층 idle 과 OR 결합 — 새 메커니즘 0, 값만 워커 전용.
//  - channel/cwd: 원 잡 상속 (메인과 동일 작업 환경).

const okText = (text: string) => ({
  content: [{ type: "text" as const, text }],
});
const errText = (text: string) => ({
  content: [{ type: "text" as const, text }],
  isError: true,
});

/**
 * 워커 1잡 실행 — daemon `startWorkerJob` 이 fire-and-forget 호출.
 * 본 함수는 *동기 반환* (워커는 백그라운드 Promise). throw 금지 — 모든 종료는
 * onWorkerComplete 로 닫고 항상 abort 타이머를 done() 으로 해제(누수 0).
 */
const runner = (job: WorkerJobRecord): void => {
  // 워커 전용 상한 — 만료 시 WorkerTimeoutError 로 abort (무한 워커 봉쇄, W-I6).
  // jobId 등록 → cancel_worker 가 외부에서 이 워커의 abort 를 부를 수 있다(취소 컨트롤).
  const abort = createWorkerAbort(job.jobId);

  // lazy import — capabilities → llm-runtime/index circular 회피 (spawn_agent 동형).
  void (async () => {
    let hardTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const { runRegionA } = await import("../index.js");
      const runRegionAP = runRegionA({
        text: job.task,
        threadKey: `worker:${job.jobId}`,
        channel: job.channel,
        cwd: undefined, // 원 잡엔 cwd 없음 — 어댑터 home 폴백(메인과 동일 기본 작업 위치).
        workerDepth: 1,
        abortSignal: abort.signal,
      });

      // 하드 백스톱 (2026-06-20) — index.ts 채널 백스톱(Promise.race) 동형. abort.signal 은
      // LLM 스트림은 끊지만 hung MCP callTool(signal 미수신 = MCP 한계)은 못 끊어 워커가
      // 상한을 넘겨 실행(실측: 20s 워커가 273s). WORKER_TIMEOUT_MS + grace 후에도 runRegionA
      // 미settle 시 WorkerTimeoutError 로 *강제* 종료 → onWorkerComplete 가 정시 발화(통지 옴).
      // 버려진 runRegionAP 의 늦은 reject 는 흡수(unhandledRejection→crash-fast 오발 방지,
      // 어제 채널 fix 와 동일 패턴). 정상 워커는 상한 전 settle 이라 영향 0.
      const hardDeadline = new Promise<never>((_resolve, reject) => {
        hardTimer = setTimeout(
          () => reject(new WorkerTimeoutError(WORKER_TIMEOUT_MS)),
          WORKER_TIMEOUT_MS + WORKER_HARD_GRACE_MS,
        );
        (hardTimer as { unref?: () => void }).unref?.();
      });
      void runRegionAP.catch(() => {});

      const out = await Promise.race([runRegionAP, hardDeadline]);
      // settle(성공) → daemon 메인 재주입. await 불필요(직렬 큐가 비동기 관리)지만
      // 여기선 await 로 onComplete 예외도 catch 범위에 둔다(데몬 생존, throw 0).
      await onWorkerComplete(job.jobId, { result: out.text });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      await onWorkerComplete(job.jobId, { error: reason });
    } finally {
      // 타이머 해제 — 정상/실패 무관 항상(누수·오발화 0, 멱등).
      if (hardTimer !== undefined) clearTimeout(hardTimer);
      abort.done();
    }
  })();
};

// 모듈 import 시 self-register — daemon 이 startWorkerJob 에서 이 runner 를 발사.
// (index.ts 가 부팅 시 본 모듈을 import 하면 등록 — region/daemon 경계 명확.)
registerWorkerRunner(runner);

// ─── 발사 도구 MCP 서버 (architect §2 — spawn_agent 팩토리 동형) ──────────────
// run_in_background: 비차단 발사(즉시 jobId). list_workers: 상태 조회(MVP 포함, §6·§12-2).
// 양 어댑터(claude/codex/openai) 동일 의미 등록 — 어댑터 분기 0(W-I3). 어댑터는
// depth0 + workerDepth0 turn 에만 이 서버를 등록(워커 안 미등록 = W-I5).

/** ms 경과를 사람이 읽는 짧은 문자열로 (list_workers 포맷용). */
const formatElapsed = (fromMs: number, toMs: number): string => {
  const sec = Math.max(0, Math.floor((toMs - fromMs) / 1000));
  if (sec < 60) return `${sec}초`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}분`;
  const hr = Math.floor(min / 60);
  return `${hr}시간 ${min % 60}분`;
};

const STATUS_LABEL: Record<WorkerJobRecord["status"], string> = {
  running: "진행 중",
  done: "완료",
  failed: "실패",
  cancelled: "취소됨",
};

/**
 * 발사 도구 MCP server 팩토리 — codex 어댑터는 mcpServers(bridge)로, claude 어댑터는
 * 동일 SDK server 를 mcpServers 맵에 직접 등록(spawn_agent createSpawnAgentMcpServer 동형).
 *
 * @param parentInput 현 메인 turn input — 워커가 합류할 원 thread/channel/사용자 파생.
 *                    `channelUserId` 는 RegionASdkInput 에 없으므로 threadKey 로 대체
 *                    (telegram threadKey "tg:<chatId>" 가 곧 사용자 식별 — daemon 재주입
 *                    reacquireReply 가 threadKey 로 채널 복원하므로 일관).
 */
export const createWorkerMcpServer = (
  parentInput: RegionASdkInput,
): McpSdkServerConfigWithInstance => {
  const runInBackground = tool(
    "run_in_background",
    "오래 걸리는 작업을 백그라운드 워커로 비차단 실행합니다. 즉시 시작 확인(jobId)을 반환하고 워커는 백그라운드에서 진행하므로, 호출 후 사용자에게 바로 '시작했어요'라고 답하고 대화를 이어가세요 (워커를 기다리지 마세요). 워커는 당신과 동급의 모든 도구를 쓸 수 있습니다. 작업이 끝나면 별도 알림으로 결과를 받아 당신이 사용자에게 보고하게 됩니다. task 에는 사용자 원문 + 워커가 단독으로 작업하는 데 필요한 맥락을 충분히 적으세요(워커는 이 대화 history 를 보지 못합니다). 워커 안에서는 다시 백그라운드 워커를 발사할 수 없습니다.",
    {
      task: z
        .string()
        .min(1)
        .describe("워커가 수행할 자연어 작업 지시 (필요한 맥락 포함)."),
      label: z
        .string()
        .min(1)
        .describe("사람이 읽는 짧은 작업 이름 (예 '월간 리포트 생성')."),
    },
    async (args) => {
      try {
        // 비차단 발사 — startWorkerJob 이 registerJob 후 workerRunner 를 fire-and-forget
        // 호출하고 jobId 를 *즉시* 반환(블로킹 0, W-I2). 워커 결과는 절대 여기로 안 옴 —
        // daemon 의 onWorkerComplete 가 메인 thread 로 재주입한다(W-I1).
        const jobId = startWorkerJob({
          label: args.label,
          task: args.task,
          threadKey: parentInput.threadKey,
          channel: parentInput.channel,
          // channelUserId — RegionASdkInput 에 없음. 재주입 reply 는 threadKey 로
          // 채널 복원하므로(reacquireReply) threadKey 를 사용자 식별로 운반.
          channelUserId: parentInput.threadKey,
        });
        return okText(
          `🛠️ '${args.label}' 백그라운드 작업을 시작했습니다 (jobId: ${jobId}). ` +
            `끝나면 결과를 알려드릴게요.`,
        );
      } catch (e) {
        return errText(e instanceof Error ? e.message : String(e));
      }
    },
  );

  const listWorkers = tool(
    "list_workers",
    "현재 백그라운드 워커들의 상태를 조회합니다. 사용자가 '지금 뭐 돌고 있어?' 류로 물을 때 사용하세요. running_only=true 면 진행 중인 워커만 반환합니다.",
    {
      running_only: z
        .boolean()
        .optional()
        .describe("true 면 진행 중(running)인 워커만. 미지정 = 전체."),
    },
    async (args) => {
      try {
        const now = Date.now();
        const jobs = listJobs({ runningOnly: args.running_only === true });
        if (jobs.length === 0) {
          return okText(
            args.running_only === true
              ? "진행 중인 백그라운드 워커가 없습니다."
              : "백그라운드 워커가 없습니다.",
          );
        }
        const lines = jobs.map((j) => {
          const end = j.finishedAt ?? now;
          const elapsed = formatElapsed(j.startedAt, end);
          const status = STATUS_LABEL[j.status];
          if (j.status === "running") {
            // 최근 활동 1건(events 의 region.a.activity, threadKey=`worker:<jobId>`) →
            // "마지막: <도구> N분 전". 활동이 오래됐으면 stuck 신호. 워커당 1회 조회(워커
            // 수 적어 OK). 조회 실패는 활동 생략(데몬 생존 — 목록 자체는 항상 나간다).
            let activity = "";
            try {
              const last = getLastWorkerActivity(`worker:${j.jobId}`);
              if (last !== null) {
                activity = `, 마지막: ${last.label} ${formatElapsed(last.ts, now)} 전`;
              }
            } catch {
              // 활동 조회 실패 — 목록은 그대로, 활동만 생략.
            }
            return `- '${j.label}' — ${status} (${elapsed} 경과${activity})`;
          }
          return `- '${j.label}' — ${status} (${elapsed} 소요)`;
        });
        return okText(`## 백그라운드 워커\n\n${lines.join("\n")}`);
      } catch (e) {
        return errText(e instanceof Error ? e.message : String(e));
      }
    },
  );

  const cancelWorker = tool(
    "cancel_worker",
    "진행 중인 백그라운드 워커를 취소합니다. label(작업 이름) 또는 job_id 중 하나로 식별하세요(label 우선). 사용자가 '그 작업 그만해/멈춰' 류로 요청할 때 사용합니다. 취소는 best-effort — 워커가 지금 도구(예: 오래 걸리는 Bash·웹요청)를 실행 중이면 그 도구가 끝나는 대로 멈춥니다(즉시는 아닐 수 있음).",
    {
      label: z
        .string()
        .optional()
        .describe("취소할 워커의 작업 이름(run_in_background 의 label). 우선 식별."),
      job_id: z
        .string()
        .optional()
        .describe("취소할 워커의 jobId. label 미지정 시 사용."),
    },
    async (args) => {
      try {
        if (
          (args.label === undefined || args.label === "") &&
          (args.job_id === undefined || args.job_id === "")
        ) {
          return errText("label 또는 job_id 중 하나로 취소할 워커를 지정하세요.");
        }
        // label 우선 매칭(running 중에서) → 없으면 job_id. 같은 label 의 running 이
        // 여럿이면 가장 최근(listJobs 가 startedAt 내림차순)을 취소.
        let target: WorkerJobRecord | undefined;
        if (args.label !== undefined && args.label !== "") {
          target = listJobs({ runningOnly: true }).find(
            (j) => j.label === args.label,
          );
        }
        if (target === undefined && args.job_id !== undefined && args.job_id !== "") {
          target = getJob(args.job_id);
        }
        if (target === undefined) {
          const ident = args.label ?? args.job_id ?? "";
          return okText(
            `취소할 진행 중인 워커를 찾지 못했습니다 ('${ident}'). ` +
              `list_workers 로 현재 진행 중인 워커를 확인하세요.`,
          );
        }
        if (target.status !== "running") {
          return okText(
            `'${target.label}' 워커는 이미 ${STATUS_LABEL[target.status]} 상태라 취소할 게 없습니다.`,
          );
        }
        const ok = cancelJob(target.jobId);
        if (!ok) {
          // 식별과 cancelJob 사이 race 로 막 종료된 경우 — 정직 안내.
          return okText(
            `'${target.label}' 워커가 막 종료되어 취소할 게 없습니다.`,
          );
        }
        return okText(
          `🛑 '${target.label}' 워커 취소를 요청했습니다. ` +
            `워커가 지금 실행 중인 도구가 있으면 그게 끝나는 대로 중단되고, 취소 알림을 받게 됩니다.`,
        );
      } catch (e) {
        return errText(e instanceof Error ? e.message : String(e));
      }
    },
  );

  return createSdkMcpServer({
    name: "workers",
    version: "1.0.0",
    tools: [runInBackground, listWorkers, cancelWorker],
  });
};
