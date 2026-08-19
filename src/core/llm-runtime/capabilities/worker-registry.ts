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
import path from "node:path";
import { z } from "zod";
import {
  createSteeringChannel,
  partitionSteering,
  shouldKeepReaping,
  type SteeringInput,
} from "../../steering.js";
import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import {
  cancelJob,
  createJobAbort,
  getJob,
  listJobs,
  onWorkerComplete,
  registerWorkerRunner,
  startWorkerJob,
  WorkerTimeoutError,
  WORKER_TIMEOUT_MS,
  WORKER_HARD_GRACE_MS,
  type WorkerJobRecord,
  listLiveChildJobs,
  findTargetableJob,
  resolveOwnerThreadKey,
  jobBelongsToSession,
  WORKER_STEERING_ENABLED,
  getSteerChannel,
  rotateSteerChannel,
  setJobResultChannel,
  clearJobResultChannel,
  setSteerChannel,
  clearSteerChannel,
  notifyJobOwner,
  steerJob,
  publishSteerAttempt,
}
from "../../worker-jobs.js";
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
//  - abortSignal: createJobAbort(jobId, {timeoutMs}) 의 signal (워커 전용 상한, §5·W-I6).
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
  // 워커 전용 상한 — timeoutMs 만료 시 WorkerTimeoutError 로 abort (무한 워커 봉쇄, W-I6).
  // jobId 등록 → cancel_worker·대시보드 중지 버튼이 외부에서 이 워커의 abort 를 부를 수 있다.
  const abort = createJobAbort(job.jobId, { timeoutMs: WORKER_TIMEOUT_MS });

  // 워커 스티어 채널 (2026-07-29) — 돌고 있는 워커에 지시를 얹을 수 있게 한다.
  // 소비층(3어댑터)은 `input.steering` 하나만 보므로 어댑터 변경 0 — 여기서 넘기기만 하면 된다.
  // 비활성(WORKER_STEERING_ENABLED=0)이면 채널 자체를 만들지 않는다: steering 주입 여부가
  // claude 의 실행 경로(string-prompt ↔ streaming-input)를 바꾸므로, 끄면 종전 경로 그대로다.
  // ★`let` 이다 — 거두기 라운드마다 **새 채널로 교체**한다. 어댑터가 턴 끝에 닫기 때문
  //  (claude 데드락 수정). 자세한 근거는 rotateSteerChannel 주석.
  let steerCh = WORKER_STEERING_ENABLED ? createSteeringChannel() : undefined;
  if (steerCh !== undefined) setSteerChannel(job.jobId, steerCh);
  // ★자식 결과 전용 수신함 — 어댑터에 **넘기지 않는다**. 넘기면 진행 중 턴에 섞여
  //  SDK 가 새 턴을 열고, 어댑터의 턴 경계 가드가 그 답을 버린다(라이브 실측).
  //  이건 거두기 루프만 읽는다. steering 과 달리 어댑터가 닫지 않으므로 교체도 불필요.
  const resultBox = createSteeringChannel();
  setJobResultChannel(job.jobId, resultBox);

  // lazy import — capabilities → llm-runtime/index circular 회피 (spawn_agent 동형).
  void (async () => {
    let hardTimer: ReturnType<typeof setTimeout> | undefined;
    // 워커 본체(runRegionA) settle 결과를 먼저 확정하고, 워커 전용 자원(abort 타이머·취소
    // 훅·하드 타이머)을 *재주입 통지 전에* 해제한다. 통지(onWorkerComplete)는 done 의 경우
    // 메인 재주입 LLM 턴까지 await 하므로(통지 보장), 그 동안 워커 타임아웃이 남아있지 않게
    // 본체 settle 즉시 해제 — 늦은 워커-timeout abort 의 무의미 발화·자원 누수 0.
    let outcome: { result: string } | { error: string };
    /** 워커가 끝나는 순간 도착해 반영 못 한 지시(원문). 완료 통지 뒤 소유 세션에 알린다. */
    let pendingSteerNotice: string[] = [];
    try {
      const { runRegionA, resolveModelChain } = await import("../index.js");
      // 잡에 modelTier 가 있으면 그 풀 체인을 넘긴다(서브에이전트 동형) — 프로파일이면
      // .fallback 체인까지(예 high→default), 레거시 티어/직접 spec 이면 단일 풀. 미지정·빈 체인
      // 이면 undefined → runRegionA 가 기본 모델 풀 사용.
      const workerChain =
        job.modelTier !== undefined && job.modelTier !== ""
          ? resolveModelChain(job.modelTier, job.cwd)
          : [];
      const runRegionAP = runRegionA(
        {
          text: job.task,
          threadKey: `worker:${job.jobId}`,
          channel: job.channel,
          // run_in_background(path=X) 로 스코프됐으면 그 폴더 cwd, 아니면 undefined=home 폴백.
          // 워커 file-ops 상대경로가 그 폴더 기준(3b) + 대시보드 프로젝트 귀속(cwd 기록).
          cwd: job.cwd,
          workerDepth: 1,
          abortSignal: abort.signal,
          ...(steerCh !== undefined ? { steering: steerCh } : {}),
        },
        workerChain.length > 0 ? { chain: workerChain } : undefined,
      );

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

      let out = await Promise.race([runRegionAP, hardDeadline]);

      // ─── ★소환자는 **거두고** 끝난다 (ADR 2026-08-19, 사용자 확정 §b) ──────────────
      //  "소환해놓고 끝날 수는 없지. 당장은 안 기다리더라도 결과를 받고 마무리해야지."
      //  그리고 그건 **시스템적으로 안 거둘 수 없게** 해야 한다 — 프롬프트로 부탁하면
      //  모델이 안 지키는 날이 오고, 그날은 조용하다(결과가 아무에게도 안 간다).
      //
      //  그래서 매니저가 `wait:false` 로 띄운 자식이 아직 돌면 **턴을 안 닫는다.**
      //  자식 결과는 deliverToSummoner 가 이 잡의 steering 큐로 넣으므로, 그걸 기다렸다가
      //  이어지는 턴에 실어 매니저가 실제로 **쓰게** 한다(받아만 두고 못 쓰면 거둔 게 아니다).
      //
      //  ★메인 비서엔 이걸 못 한다 — 메인은 이미 사용자에게 말을 끝내고 전송한 뒤라
      //   루프를 이으면 한 턴이 두 번 발화한다. 매니저는 사용자에게 스트리밍하지 않아서
      //   안전하다. 이 비대칭이 설계의 핵심이다.
      //
      //  종료 보장: ①자식이 다 끝나면 루프 탈출 ②abort(WORKER_TIMEOUT_MS·취소)면 즉시 탈출
      //  ③채널이 닫히면 탈출. 자식은 스스로 또 자식을 못 띄운다(depth 게이트).
      // ★게이트는 **결과 수신함**이다 (2026-08-19 적대 검토 F2). 종전엔 `steerCh` 였는데,
      //  수신함은 무조건 만들면서 루프만 steering 플래그에 묶여 있어 `WORKER_STEERING_ENABLED=0`
      //  이면 **읽는 사람이 없는 함**에 결과가 쌓이고, deliverToSummoner 는 push 성공을
      //  "전달됨"으로 보고해 새 턴 폴백까지 막았다 → 결과 완전 유실인데 로그엔 성공 문장만.
      //  개입(steering)은 꺼도 되지만 **결과 거두기는 끌 수 있는 기능이 아니다.**
      {
        let rounds = 0;
        // ★턴이 끝나는 **순간** 자식이 끝난 경우 — 자식은 이미 done 이라 아래 live 조건이
        //  0이지만 결과는 큐에 남아 있다. 그대로 두면 finally 가 그걸 *사용자 지시*로 오해해
        //  "⚠️ 방금 보내신 지시는 반영되지 않았어요" 를 보낸다(자식 결과인데). 먼저 걷는다.
        let arrived: SteeringInput[] = resultBox.drain();
        while (
          shouldKeepReaping({
            aborted: abort.signal.aborted,
            pendingResults: arrived.length,
            liveChildren: listLiveChildJobs(`worker:${job.jobId}`).length,
          })
        ) {
          // ★다음 턴을 위해 **개입** 채널만 갈아끼운다 — 어댑터가 턴 끝에 닫기 때문
          //  (claude 데드락 수정). 결과 수신함은 어댑터가 안 건드리므로 그대로 쓴다.
          if (steerCh !== undefined) {
            const rot = rotateSteerChannel(job.jobId);
            steerCh = rot.channel;
            for (const m of rot.leftover) steerCh.push(m); // 미소비 사용자 지시 보존.
          }
          if (arrived.length === 0) {
            const live = listLiveChildJobs(`worker:${job.jobId}`);
            console.log(
              `worker-registry: '${job.label}' 턴이 끝났지만 백그라운드 자식 ${live.length}건이 ` +
                `아직 진행 중 — 거두고 마무리합니다 (${live.map((j: { label: string }) => j.label).join(", ")})`,
            );
            // 다음 결과를 **이벤트로** 기다린다(폴링 아님) — deliverToSummoner 가 큐에 넣으면
            // stream 이 깨어난다. close/abort 면 제너레이터가 끝나 arrived 가 비고 탈출한다.
            for await (const m of resultBox.stream(abort.signal)) {
              arrived.push(m);
              break; // 첫 도착으로 깨어난 뒤, 같은 순간 도착분은 아래 drain 으로 합류.
            }
            arrived.push(...resultBox.drain());
          }
          if (arrived.length === 0) break; // 채널 종료·취소 — 안전망(유령좌표 환원)이 받는다.
          rounds += 1;
          const { runRegionA: rerun } = await import("../index.js");
          out = await rerun(
            {
              text:
                `[백그라운드 작업 결과 도착 — 아래를 반영해 작업을 마무리하세요]\n\n` +
                arrived.map((m) => m.raw).join("\n\n"),
              threadKey: `worker:${job.jobId}`,
              channel: job.channel,
              cwd: job.cwd,
              workerDepth: 1,
              abortSignal: abort.signal,
              ...(steerCh !== undefined ? { steering: steerCh } : {}),
            },
            workerChain.length > 0 ? { chain: workerChain } : undefined,
          );
          // 이번 라운드 소비분 비우고, 그 사이 또 도착한 자식 결과가 있으면 이어서 돈다.
          arrived = resultBox.drain();
        }
        if (rounds > 0) {
          console.log(
            `worker-registry: '${job.label}' 자식 결과 ${rounds}회 이어받아 마무리 — ` +
              `남은 자식 ${listLiveChildJobs(`worker:${job.jobId}`).length}건`,
          );
        }
      }
      outcome = { result: out.text };
    } catch (e) {
      outcome = { error: e instanceof Error ? e.message : String(e) };
    } finally {
      // 워커 전용 자원 해제 — 본체 settle 즉시(통지 전). 정상/실패 무관 항상(누수·오발화 0, 멱등).
      if (hardTimer !== undefined) clearTimeout(hardTimer);
      abort.done();
      // 스티어 채널 종료 + **잔여 회수**. 메인 턴은 미소비 steering 을 새 턴으로 재주입하지만
      // (index.ts) 워커엔 다음 턴이 없다 — 그냥 close 하면 막 도착한 지시가 조용히 사라진다
      // (project_steering_endturn_skip 과 같은 손실창). 사용자 확정(2026-07-29): **소유 세션에
      // 정직 통지**. 원문(raw)을 쓴다 — framing 문구가 사용자 화면에 노출된 실사고가 있었다.
      // 수신함은 steering 플래그와 무관하게 항상 만들었으므로 항상 해제한다
      //  (적대 검토 F3 — clearJobResultChannel 이 import 만 되고 호출 0회였다 = 맵 누수).
      clearJobResultChannel(job.jobId);
      resultBox.close();
      if (steerCh !== undefined) {
        clearSteerChannel(job.jobId);
        steerCh.close();
        // ★**사용자 지시만** 통지한다 (2026-08-19). 같은 큐에 백그라운드 자식의 결과도
        //  들어오는데, 그걸 "방금 보내신 지시" 로 되읽어주면 사용자는 자기가 안 보낸 문장을
        //  자기 것으로 통보받는다. 자식 결과는 위 거두기 루프가 소비하고, 거기서 놓친
        //  잔여는 완료 보고에 이미 담긴다(소환자가 거둔다는 계약).
        const leftover = partitionSteering(steerCh.drain()).userMessages;
        if (leftover.length > 0) {
          pendingSteerNotice = leftover.map((m: SteeringInput) => m.raw).filter((t: string) => t !== "");
        }
      }
    }

    // 완료/실패 통지 — daemon 이 done 은 메인 재주입(+raw 안전망), failed/cancelled 는 raw
    // 직행으로 *반드시* 전달한다. await 로 onComplete 예외도 본 IIFE 가 흡수(throw 0, 데몬
    // 생존). 본 IIFE 자체가 fire-and-forget(detached)이라 이 await 은 채널 폴러·메인루프를
    // 막지 않는다(워커 격리 유지).
    try {
      await onWorkerComplete(job.jobId, outcome);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      console.error(
        `worker-registry: onWorkerComplete 예외 흡수 (job=${job.jobId}): ${reason}`,
      );
    }

    // 반영 못 한 지시 정직 통지 — 결과 보고 *뒤*에 보내야 "그 작업 끝났는데 이건 못 받았다"
    // 순서가 맞는다. raw 아웃바운드(LLM 무경유) — 모델 풀이 죽어 있어도 결정적으로 전달된다
    // (recoverInterruptedJobs 의 중단 통지와 동형).
    if (pendingSteerNotice.length > 0) {
      try {
        await notifyJobOwner(
          job,
          `⚠️ 방금 보내신 지시는 '${job.label}' 매니저가 **이미 끝난 뒤** 도착해서 반영되지 않았어요:\n` +
            pendingSteerNotice.map((t) => `· ${t}`).join("\n") +
            `\n필요하면 위 결과를 보고 다시 시켜주세요.`,
        );
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        console.error(`worker-registry: 잔여 steer 통지 실패 (job=${job.jobId}): ${reason}`);
      }
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
    "**일을 통째로 맡기는 곳입니다** — 매니저는 당신(메인 비서)과 **동급의 전권**으로 작업을 끝까지 책임집니다. 고르는 기준은 난이도가 아니라 **시간**입니다: 오래 걸리는 일이면 쉬워도 매니저, 결과를 *이번 답변 안에서* 써야 하면 어려워도 spawn_agent. 필요하면 매니저가 **지휘자**가 되어 spawn_agent 로 에이전트를 붙일 수 있습니다(매니저가 또 매니저를 띄우는 것만 불가). 발사 후에도 steer_worker 로 지시를 더 얹을 수 있지만 반영은 매니저의 다음 판단 시점이므로(즉시 아님) 범위·판단기준은 task 에 최대한 담아 보내세요. 즉시 시작 확인(jobId)을 반환하고 매니저는 백그라운드에서 진행하므로, 호출 후 사용자에게 바로 '시작했어요'라고 답하고 대화를 이어가세요 (매니저를 기다리지 마세요). 매니저는 당신과 동급의 모든 도구를 쓸 수 있습니다. 작업이 끝나면 별도 알림으로 결과를 받아 당신이 사용자에게 보고하게 됩니다. task 에는 사용자 원문 + 매니저가 단독으로 작업하는 데 필요한 맥락을 충분히 적으세요(매니저는 이 대화 history 를 보지 못합니다). **`path`(폴더 경로)를 주면 매니저가 그 폴더 컨텍스트로 실행됩니다 — 그 폴더 전용 스킬/파일작업(상대경로)이 그 폴더 기준이고, 대시보드 그 프로젝트에 귀속되어 보입니다.** 품질이 결과를 좌우하는 작업(코드리뷰·설계·복잡 추론)은 `tier: 'high'`, 단순·대량 작업은 `tier: 'low'` 로 매니저 모델 등급을 지정하세요(미지정 시 기본 모델). 매니저 안에서는 다시 백그라운드 매니저를 발사할 수 없습니다.",
    {
      task: z
        .string()
        .min(1)
        .describe("매니저가 수행할 자연어 작업 지시 (필요한 맥락 포함)."),
      label: z
        .string()
        .min(1)
        .describe("사람이 읽는 짧은 작업 이름 (예 '월간 리포트 생성')."),
      path: z
        .string()
        .optional()
        .describe("선택 — 매니저를 실행할 폴더(프로젝트) 경로. 지정 시 그 폴더 기준."),
      tier: z
        .string()
        .optional()
        .describe(
          "선택 — 매니저 모델 프로파일. settings.json 의 프로파일 이름(default/high/mid/low 또는 커스텀)을 쓰면 그 프로파일의 풀+폴백으로 실행되고, `provider:model` 직접 지정도 가능합니다(가용 프로파일은 작동 컨텍스트의 `## 모델 프로파일` 섹션 참고). 품질 중요(코드리뷰·설계)=high, 구현=mid, 단순·대량·요약=low. 미지정 시 기본 모델. 서브에이전트 model 과 동일 해석(resolveModelChain).",
        ),
    },
    async (args) => {
      try {
        // path 지정 시 그 폴더로 스코프(상대경로는 부모 cwd 기준). spawn_agent(path) 동형.
        const workerCwd =
          args.path !== undefined
            ? path.resolve(parentInput.cwd ?? process.cwd(), args.path)
            : undefined;
        // 비차단 발사 — startWorkerJob 이 registerJob 후 workerRunner 를 fire-and-forget
        // 호출하고 jobId 를 *즉시* 반환(블로킹 0, W-I2). 워커 결과는 절대 여기로 안 옴 —
        // daemon 의 onWorkerComplete 가 메인 thread 로 재주입한다(W-I1).
        const jobId = startWorkerJob({
          label: args.label,
          task: args.task,
          threadKey: parentInput.threadKey,
          channel: parentInput.channel,
          cwd: workerCwd,
          // channelUserId — RegionASdkInput 에 없음. 재주입 reply 는 threadKey 로
          // 채널 복원하므로(reacquireReply) threadKey 를 사용자 식별로 운반.
          channelUserId: parentInput.threadKey,
          // 워커 모델 등급 — 지정 시 runner 가 resolveTier→specs 로 그 티어 풀 사용
          // (미지정 시 기본 모델). 서브에이전트 model 등급과 동일 경로.
          modelTier: args.tier,
          // 워커 완료/실패 통지 dest — parentInput.notifyDest 가 있으면(예 스케줄 발화)
          // 그 generic 좌표를 잡에 박아 워커가 그 dest 로 통지하게 한다.
          // ★채널/세션 분리(ADR 2026-07-15 §D3): notifyDest 미지정(텔레그램 등 채널 직접
          //   발화)이어도 parentInput.channelAddress(캡처된 배달 좌표)가 있으면 (실채널,
          //   그 좌표)로 dest 를 **스폰 시점 캡처**한다. 세션 id 가 채널 무관(dashboard:*)이
          //   되면 job.threadKey 파싱(deriveTargetFromThreadKey)으로는 telegram chatId 를
          //   못 얻으므로, 파싱 의존을 캡처로 승격(§1.3). 둘 다 없으면 undefined →
          //   onWorkerComplete 의 channel/threadKey 폴백(회귀 0, 폴백 보존).
          // (이 도구만 notifyDest 를 읽는다 — 어댑터는 LLM-agnostic 으로 미독해.)
          notifyDest:
            parentInput.notifyDest ??
            (parentInput.channelAddress !== undefined
              ? {
                  channel: parentInput.channel,
                  target: parentInput.channelAddress,
                }
              : undefined),
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
    "**지금 이 대화(세션)가 띄운** 백그라운드 매니저의 상태를 조회합니다. 사용자가 '지금 뭐 돌고 있어?' 류로 물을 때 사용하세요. 다른 대화의 매니저는 건수만 덧붙습니다(전체 목록이 필요하면 list_all_workers). running_only=true 면 진행 중인 매니저만.",
    {
      running_only: z
        .boolean()
        .optional()
        .describe("true 면 진행 중(running)인 매니저만. 미지정 = 전체."),
    },
    async (args) => {
      try {
        const now = Date.now();
        // ★세션 스코프 (2026-07-29 사용자 신고) — 종전엔 **전 세션 통합**이라, 다른 대화에서
        //  도는 워커를 보고 메인이 "이전 워커가 실행 중" 이라고 판단해 새 작업을 안 띄웠다.
        //  잡에는 띄운 세션이 처음부터 실려 있었는데 읽는 쪽이 안 썼던 것 = 데이터가 아니라
        //  질의의 결함. 소속 미상(부모 잡이 정리된 경우)은 전역으로 열어 둔다 — 읽기 도구라
        //  숨기는 쪽이 더 나쁘다.
        const ownSession = resolveOwnerThreadKey(parentInput.threadKey);
        const scoped = ownSession !== "";
        const running = args.running_only === true;
        const jobs = listJobs({
          runningOnly: running,
          ...(scoped ? { ownerThreadKey: ownSession } : {}),
        });
        // 다른 세션에서 도는 건수 — 숨기지 않되 내 것과 섞지 않는다.
        const otherRunning = scoped
          ? listJobs({ runningOnly: true }).filter(
              (j) => !jobBelongsToSession(j, ownSession),
            ).length
          : 0;
        const otherNote =
          otherRunning > 0
            ? `\n(다른 대화에서 ${otherRunning}건이 진행 중입니다 — 이 대화와 무관하니 같은 작업으로 오해하지 마세요. 전체 목록은 list_all_workers.)`
            : "";
        if (jobs.length === 0) {
          return okText(
            (running
              ? "이 대화에서 진행 중인 백그라운드 매니저가 없습니다."
              : "이 대화의 백그라운드 매니저가 없습니다.") + otherNote,
          );
        }
        const lines = jobs.map((j) => {
          const end = j.finishedAt ?? now;
          const elapsed = formatElapsed(j.startedAt, end);
          const status = STATUS_LABEL[j.status];
          if (j.status === "running") {
            // 최근 활동 1건(events 의 llm.activity, threadKey=`worker:<jobId>`) →
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
        const header = scoped ? "## 백그라운드 매니저 (이 대화)" : "## 백그라운드 매니저 (전체 대화)";
        return okText(`${header}\n\n${lines.join("\n")}${otherNote}`);
      } catch (e) {
        return errText(e instanceof Error ? e.message : String(e));
      }
    },
  );

  /**
   * 전체 세션 워커 — **별도 도구**로 분리 (2026-07-29, 사용자 확정).
   *
   * 원래는 list_workers 에 `all_sessions` 플래그로 붙였는데, 그건 footgun 이다: 모델이
   * "혹시 모르니 전체로" 켜는 순간 이번 사고(다른 대화 워커를 자기 것으로 오인)가 그대로
   * 재발한다. 도구를 나누면 **호출하는 순간 의도가 확정**되고, list_workers 는 어떤 인자
   * 조합에서도 세션을 넘지 않는다. 비용은 능력 인덱스 한 줄.
   */
  const listAllWorkers = tool(
    "list_all_workers",
    "**모든 대화(세션)** 의 백그라운드 매니저를 조회합니다. 사용자가 '전체'·'다른 대화 것까지'·'서버에서 도는 거 전부' 처럼 **명시적으로** 물을 때만 쓰세요. 평소 '지금 뭐 돌고 있어?' 는 list_workers(이 대화) 입니다.",
    {
      running_only: z
        .boolean()
        .optional()
        .describe("true 면 진행 중(running)인 매니저만. 미지정 = 전체."),
    },
    async (args) => {
      try {
        const now = Date.now();
        const ownSession = resolveOwnerThreadKey(parentInput.threadKey);
        const all = listJobs({ runningOnly: args.running_only === true });
        if (all.length === 0) {
          return okText(
            args.running_only === true
              ? "진행 중인 백그라운드 매니저가 (어느 대화에도) 없습니다."
              : "백그라운드 매니저가 (어느 대화에도) 없습니다.",
          );
        }
        // 내 것/남의 것을 **줄 단위로 표시** — 통합 목록이라도 오인하지 않게.
        const lines = all.map((j) => {
          const end = j.finishedAt ?? now;
          const elapsed = formatElapsed(j.startedAt, end);
          const mine =
            ownSession !== "" && jobBelongsToSession(j, ownSession)
              ? "이 대화"
              : "다른 대화";
          return `- '${j.label}' — ${STATUS_LABEL[j.status]} (${elapsed}, ${mine})`;
        });
        return okText(`## 백그라운드 매니저 (전체 대화)\n\n${lines.join("\n")}`);
      } catch (e) {
        return errText(e instanceof Error ? e.message : String(e));
      }
    },
  );

  /**
   * 돌고 있는 워커에 지시를 얹는다 (2026-07-29).
   *
   * cancel_worker 와 **같은 지목 규약**을 쓴다: label 우선·job_id 보조, kind='worker' 게이트,
   * label 매칭은 이 대화 안에서만(남의 대화 워커에 오주입 = 되돌릴 수 없다).
   */
  const steerWorker = tool(
    "steer_worker",
    "**진행 중인 백그라운드 매니저에 지시를 추가로 전달**합니다. 사용자가 돌고 있는 작업에 대해 '거기에 ~도 해줘'·'~는 빼고'·'방향 바꿔' 처럼 말할 때 쓰세요(작업을 새로 띄우지 말고 이걸로). 반영은 **매니저의 다음 판단 시점**에 일어납니다 — 지금 오래 걸리는 도구(빌드·대량 처리)를 실행 중이면 그게 끝난 뒤에 반영되니 즉시가 아닐 수 있습니다. 이미 끝난 매니저에는 전달되지 않으며 그 사실을 알려드립니다.",
    {
      message: z
        .string()
        .min(1)
        .describe("매니저에게 전달할 지시 — 사용자 원문을 그대로 싣는 것을 권장."),
      label: z
        .string()
        .optional()
        .describe("대상 매니저의 작업 이름(run_in_background 의 label). 우선 식별."),
      job_id: z.string().optional().describe("대상 매니저의 jobId. label 미지정 시 사용."),
    },
    async (args) => {
      try {
        if (
          (args.label === undefined || args.label === "") &&
          (args.job_id === undefined || args.job_id === "")
        ) {
          return errText("label 또는 job_id 중 하나로 대상 매니저를 지정하세요.");
        }
        const scope = resolveOwnerThreadKey(parentInput.threadKey);
        let target = findTargetableJob({
          ...(args.label !== undefined ? { label: args.label } : {}),
          ...(args.job_id !== undefined ? { jobId: args.job_id } : {}),
          scope,
        });
        if (
          target === undefined &&
          args.label !== undefined &&
          args.label !== "" &&
          scope !== ""
        ) {
          // 다른 대화에 같은 이름이 있으면 조용히 넘기지 말고 사실을 알린다.
          const elsewhere = findTargetableJob({ label: args.label });
          if (elsewhere !== undefined) {
            // 거절도 관측면에 남긴다 — 사용자 입장에선 "보냈는데 안 갔다"라 유실과 같다.
            publishSteerAttempt({
              jobId: elsewhere.jobId,
              label: args.label,
              message: args.message,
              outcome: "other-session",
            });
            return okText(
              `'${args.label}' 매니저는 **다른 대화**에서 돌고 있어요. 이 대화에서는 지시를 전달하지 않았습니다 — 그 대화에서 보내주세요.`,
            );
          }
        }
        if (target === undefined) {
          // ★가장 흔한 유실이 여기다 — "스티어했는데 이미 끝난 매니저였다". steerJob 에
          //  도달하지 못하는 경로라 여기서 직접 발행해야 사후에 셀 수 있다(ADR 2026-08-03 §4).
          publishSteerAttempt({
            ...(args.job_id !== undefined && args.job_id !== "" ? { jobId: args.job_id } : {}),
            ...(args.label !== undefined && args.label !== "" ? { label: args.label } : {}),
            message: args.message,
            outcome: "no-target",
          });
          return okText(
            `지정하신 매니저를 찾지 못했어요(이미 끝났거나 이름이 다를 수 있습니다). list_workers 로 확인해 주세요. 지시는 전달되지 않았습니다.`,
          );
        }
        const now = Date.now();
        const outcome = steerJob(target.jobId, {
          text: `[사용자 추가 지시] ${args.message}\n\n하던 작업을 이어가되 위 지시를 반영하세요.`,
          raw: args.message,
          ts: now,
        });
        if (outcome === "delivered") {
          return okText(
            `'${target.label}' 매니저에 지시를 전달했어요. 매니저의 다음 판단 시점에 반영됩니다(지금 오래 걸리는 도구를 실행 중이면 그게 끝난 뒤).`,
          );
        }
        if (outcome === "closed") {
          return okText(
            `'${target.label}' 매니저가 방금 끝나서 지시가 반영되지 않았어요. 결과를 보고 필요하면 다시 시켜주세요.`,
          );
        }
        return okText(
          `'${target.label}' 매니저에 지시를 전달할 수 없었어요(매니저 스티어 비활성 또는 이미 종료). 지시는 반영되지 않았습니다.`,
        );
      } catch (e) {
        return errText(e instanceof Error ? e.message : String(e));
      }
    },
  );

  const cancelWorker = tool(
    "cancel_worker",
    "진행 중인 백그라운드 매니저를 취소합니다. label(작업 이름) 또는 job_id 중 하나로 식별하세요(label 우선). 사용자가 '그 작업 그만해/멈춰' 류로 요청할 때 사용합니다. 취소는 best-effort — 매니저가 지금 도구(예: 오래 걸리는 Bash·웹요청)를 실행 중이면 그 도구가 끝나는 대로 멈춥니다(즉시는 아닐 수 있음).",
    {
      label: z
        .string()
        .optional()
        .describe("취소할 매니저의 작업 이름(run_in_background 의 label). 우선 식별."),
      job_id: z
        .string()
        .optional()
        .describe("취소할 매니저의 jobId. label 미지정 시 사용."),
    },
    async (args) => {
      try {
        if (
          (args.label === undefined || args.label === "") &&
          (args.job_id === undefined || args.job_id === "")
        ) {
          return errText("label 또는 job_id 중 하나로 취소할 매니저를 지정하세요.");
        }
        // label 우선 매칭(running 중에서) → 없으면 job_id. 같은 label 의 running 이
        // 여럿이면 가장 최근(listJobs 가 startedAt 내림차순)을 취소.
        // ★U-I4 — 이 LLM-대면 cancel_worker 도구의 대상은 kind='worker' 전용(유지). 서브
        // 에이전트(kind='agent')는 아래 안내처럼 부모 대화를 멈추면 함께 정리되는 게 자연스러워
        // 이 도구에선 배타한다. (별건: 대시보드 중지 버튼 → /api/cancel-worker → 코어 cancelJob
        // 은 U-I4 개정으로 worker·agent 모두 취소함 — 그건 사용자가 카드에서 명시 지목한 경우라
        // 경로가 다르다.) agent 잡이 같은 레지스트리에 running 으로 상주하므로 필터 필수.
        let target: WorkerJobRecord | undefined;
        // ★label 매칭은 **이 대화의 워커 안에서만** (2026-07-29). label 은 사람이 붙인
        //  이름이라 세션 간 충돌이 흔하다("리서치", "정리"…). 전역에서 최신 것을 집으면
        //  사용자가 의도하지 않은 **남의 대화 작업을 취소**할 수 있다 — 되돌릴 수 없는 행위라
        //  범위를 좁히는 쪽이 옳다. 소속 미상이면 종전대로 전역(부모 잡이 정리된 예외).
        const cancelScope = resolveOwnerThreadKey(parentInput.threadKey);
        target = findTargetableJob({
          ...(args.label !== undefined ? { label: args.label } : {}),
          ...(args.job_id !== undefined ? { jobId: args.job_id } : {}),
          scope: cancelScope,
        });
        if (
          target === undefined &&
          args.label !== undefined &&
          args.label !== "" &&
          cancelScope !== ""
        ) {
          // 다른 대화에 같은 이름이 있으면 조용히 넘기지 말고 사실을 알린다.
          const elsewhere = findTargetableJob({ label: args.label });
          if (elsewhere !== undefined) {
            return okText(
              `'${args.label}' 매니저는 **다른 대화**에서 돌고 있어요. 이 대화에서는 취소하지 않았습니다 — ` +
                `그 대화에서 멈추거나, 대시보드 작업 카드에서 직접 중지해 주세요.`,
            );
          }
        }
        if (target === undefined) {
          // 대상은 없지만 같은 식별자의 **awaited** 서브에이전트가 있으면 취지를 안내.
          // ★`!j.detached` 다 (2026-08-19). 종전엔 `kind === "agent"` 여서 백그라운드
          //  서브(`wait:false`)까지 이 분기로 떨어졌고, 아래 문구가 **거짓 안내**를 했다:
          //  "부모 작업을 멈추면 함께 정리됩니다" — detached 엔 멈출 부모 턴이 없다.
          //  detached 서브는 위 target 선택에서 정상적으로 잡혀 실제로 취소된다.
          const agentMatch = listJobs({ runningOnly: true }).find(
            (j) =>
              j.kind === "agent" &&
              !j.detached &&
              (j.label === args.label || j.jobId === args.job_id),
          );
          if (agentMatch !== undefined) {
            return okText(
              `'${agentMatch.label}'은(는) 백그라운드 매니저가 아니라 지금 대화 중 실행 중인 ` +
                `서브에이전트예요. 서브에이전트는 따로 취소하지 않고, 진행 중인 대화(부모 작업)를 ` +
                `멈추면 함께 정리됩니다.`,
            );
          }
          const ident = args.label ?? args.job_id ?? "";
          return okText(
            `취소할 진행 중인 매니저를 찾지 못했습니다 ('${ident}'). ` +
              `list_workers 로 현재 진행 중인 매니저를 확인하세요.`,
          );
        }
        if (target.status !== "running") {
          return okText(
            `'${target.label}' 매니저는 이미 ${STATUS_LABEL[target.status]} 상태라 취소할 게 없습니다.`,
          );
        }
        const ok = cancelJob(target.jobId);
        if (!ok) {
          // 식별과 cancelJob 사이 race 로 막 종료된 경우 — 정직 안내.
          return okText(
            `'${target.label}' 매니저가 막 종료되어 취소할 게 없습니다.`,
          );
        }
        return okText(
          `🛑 '${target.label}' 매니저 취소를 요청했습니다. ` +
            `매니저가 지금 실행 중인 도구가 있으면 그게 끝나는 대로 중단되고, 취소 알림을 받게 됩니다.`,
        );
      } catch (e) {
        return errText(e instanceof Error ? e.message : String(e));
      }
    },
  );

  return createSdkMcpServer({
    name: "workers",
    version: "1.0.0",
    tools: [runInBackground, listWorkers, listAllWorkers, steerWorker, cancelWorker],
  });
};
