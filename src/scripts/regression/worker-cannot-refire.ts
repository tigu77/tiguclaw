/**
 * 회귀: **매니저는 새 매니저를 못 띄운다 — 코어가 막는다** (2026-08-21 적대 검토 A-F2).
 *
 * 사고: W-I5 의 집행점이 **어댑터 게이트 셋뿐**이었다. `claude-agent-sdk` ·
 * `openai-codex-oauth` · `openai-agents-sdk` 에서 `workerDepth === 0` 조건을 셋 다 지워도
 * 회귀 1,461건이 초록이었다 — 코어엔 재발사 가드가 아예 없었고, 무한 백그라운드 팬아웃이
 * 조용히 가능했다.
 *
 * ★비대칭이 곧 그물의 공백이었다: 형제 불변식인 **손자 금지**(`subagentDepth`)는 코어가
 *  막고 회귀가 잡는데, 이쪽만 비어 있었다.
 *
 * ★게다가 같은 배치가 매니저에게 *"새 매니저는 띄울 수 없습니다"* 라고 **문장으로 단언**하기
 *  시작했다(`roleContextBlock`). 게이트가 풀리면 그 문장이 거짓말이 된다 — 헌법이 제품보다
 *  앞서 나가면, 틀리는 건 헌법이다.
 *
 * 지키는 것:
 *  ①메인(depth 0)은 정상적으로 띄운다 — 가드가 기능을 막지 않는다
 *  ②매니저 안(depth ≥1)은 **던진다** — 조용히 무시하지 않는다(부른 쪽이 모델에게 이유를 준다)
 *  ③거절은 **잡을 만들지 않는다** — 등록만 하고 실패로 남기면 대시보드에 유령 잡이 쌓인다
 *  ④역할 문구가 말하는 것과 코어가 하는 것이 **같다**
 */
import { roleContextBlock } from "../../core/prompt-assembly.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "worker-cannot-refire",
  guards:
    "매니저가 새 매니저를 띄우는 것을 어댑터 게이트 셋만 막고 있어, 셋 다 풀어도 스위트가 초록이던 것(무한 백그라운드 팬아웃)",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const { startWorkerJob, listJobs, registerWorkerRunner, getRegisteredWorkerRunner } =
      await import("../../core/worker-jobs.js");

    // 실행기는 스텁 — 우리가 보려는 건 **발사 가드**지 실행이 아니다.
    // ★검사들은 **한 프로세스**를 공유한다. 등록기를 갈아끼우고 안 돌려놓으면 뒤에 도는
    //  `worker-runner-runs-for-real` 이 "다른 함수가 등록돼 있다"로 빨간불이 된다(실제로
    //  이 검사를 넣자마자 그렇게 났다). 전역을 건드리는 검사는 **자기가 되돌린다.**
    const prevRunner = getRegisteredWorkerRunner();
    const started: string[] = [];
    registerWorkerRunner((job) => {
      started.push(job.jobId);
    });
    const restore = (): void => {
      if (prevRunner !== undefined) registerWorkerRunner(prevRunner);
    };

    const base = {
      label: "검토",
      task: "무엇을 해봐",
      threadKey: "regr-refire:main",
      channel: "cli" as const,
      channelUserId: "regr-refire:main",
    };

    // ① 메인은 정상 발사 — 가드가 기능을 막지 않는다.
    let mainId: string | null = null;
    let mainErr = "";
    try {
      mainId = startWorkerJob({ ...base, callerWorkerDepth: 0 });
    } catch (e) {
      mainErr = e instanceof Error ? e.message : String(e);
    }
    out.push(
      assert(
        "메인(workerDepth 0)은 매니저를 정상적으로 띄운다 — 가드가 기능을 막지 않는다",
        mainId !== null && started.includes(mainId),
        mainId === null ? `★막힘: ${mainErr}` : `jobId=${mainId} 발사됨`,
      ),
    );

    const before = listJobs().length;

    // ② 매니저 안은 던진다.
    let threw = false;
    let msg = "";
    try {
      startWorkerJob({ ...base, threadKey: "worker:x", callerWorkerDepth: 1 });
    } catch (e) {
      threw = true;
      msg = e instanceof Error ? e.message : String(e);
    }
    out.push(
      assert(
        "★매니저 안(workerDepth ≥1)에서는 **코어가 던진다** — 어댑터 게이트가 풀려도 막힌다",
        threw,
        threw ? `throw: ${msg.slice(0, 60)}…` : "★조용히 발사됨 = 무한 팬아웃 가능",
      ),
    );

    // ③ 거절이 유령 잡을 남기지 않는다.
    out.push(
      assert(
        "★거절은 잡을 만들지 않는다(등록 후 실패로 남기면 대시보드에 유령 잡이 쌓인다)",
        listJobs().length === before,
        `잡 수 ${before} → ${listJobs().length}`,
      ),
    );

    // 에러 문구가 **다음 길**을 알려준다 — 막기만 하면 모델이 같은 시도를 반복한다.
    out.push(
      assert(
        "거절 문구가 대안을 알려준다(spawn_agent 또는 직접 처리)",
        msg.includes("spawn_agent"),
        `"${msg.slice(0, 80)}"`,
      ),
    );

    // ④ 역할 문구와 코어가 같은 말을 한다.
    const managerText = roleContextBlock({ workerDepth: 1 });
    out.push(
      assert(
        "★매니저에게 하는 말과 코어가 하는 일이 같다(헌법이 제품보다 앞서 나가지 않는다)",
        managerText.includes("새 매니저") && threw,
        `역할 문구가 금지를 단언=${managerText.includes("새 매니저")} · 코어가 실제로 막음=${threw}`,
      ),
    );
    restore();
    return out;
  },
};
