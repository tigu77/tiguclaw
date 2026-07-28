/**
 * 회귀: "이 대화가 띄운 작업이 살아있나" 판정이 **손자까지** 본다 (2026-07-28).
 *
 * 사고: 도구 wall-clock 상한(8분)이 지나도 자식 잡이 running 이면 끊지 않고 기다린다.
 * 그런데 판정이 **직계 자식(threadKey 정확 일치)** 만 봤다. 서브에이전트가 또 서브를
 * 띄우면 손자의 threadKey 는 `agent:<자식jobId>` 라 안 걸린다 → 자식이 끝나고 손자가
 * 아직 일하는 창에서 부모가 "무응답"으로 오판해 끊었고, 모델은 그 에러를 보고 **같은
 * 작업을 워커로 다시 돌렸다**(사용자 신고: "또 워커 돌리네" — 중복 실행·중복 과금).
 */
import {
  registerJob,
  markDone,
  hasLiveChildJob,
  describeChildJobs,
  __resetJobsForTest,
} from "../../core/worker-jobs.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const SESSION = "dashboard:live-child-regression";

export const check: RegressionCheck = {
  name: "live-child-job",
  guards: "손자만 살아있을 때 부모가 무응답으로 오판해 끊고, 모델이 같은 일을 다시 돌리던 것",
  run: async (): Promise<Assertion[]> => {
    __resetJobsForTest();
    const mk = (threadKey: string, label: string): string =>
      registerJob({
        label,
        threadKey,
        channel: "dashboard",
        channelUserId: "regression",
        task: "regression",
        kind: "agent",
      });

    const child = mk(SESSION, "자식 서브에이전트");
    const out: Assertion[] = [
      assert("직계 자식이 돌면 살아있다", hasLiveChildJob(SESSION), describeChildJobs(SESSION)),
    ];

    // 손자 — 자식이 띄웠으므로 threadKey 가 자식의 잡 좌표다(세션 키가 아니다).
    const grandchild = mk(`agent:${child}`, "손자 서브에이전트");
    markDone(child, "자식 완료"); // 자식만 끝나고 손자는 계속 일하는 창.
    out.push(
      assert(
        "자식이 끝나도 손자가 돌면 살아있다(핵심)",
        hasLiveChildJob(SESSION),
        describeChildJobs(SESSION),
      ),
    );

    markDone(grandchild, "손자 완료");
    out.push(
      assert("전부 끝나면 비로소 없다", !hasLiveChildJob(SESSION), describeChildJobs(SESSION)),
    );
    out.push(
      assert(
        "남의 세션 잡은 세지 않는다",
        !hasLiveChildJob("dashboard:someone-else"),
        describeChildJobs("dashboard:someone-else"),
      ),
    );
    __resetJobsForTest();
    return out;
  },
};
