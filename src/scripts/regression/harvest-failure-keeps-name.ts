/**
 * 회귀: 매니저의 **거두기 턴이 실패하면 오류 이름이 원인 분류까지 간다** (2026-10-05 적대 검토 F1).
 *
 * 거두기 실패 outcome 에는 원문 + **완성된 보고서 전문**이 실린다(보고서를 잃지 않으려고). 그런데 이름이
 * 빠져 분류가 문자열로 떨어졌고, 문자열 분류는 한도를 시간 종료보다 먼저 본다 — 보고서에 «rate limit» 이
 * 한 번만 나와도(API 조사 보고서면 흔하다) 실제 원인(시간 상한)이 «사용량 한도» 로 통지·로그됐다.
 *
 * 등급: **동작** — 레지스트리를 실제로 돌리고 거두기 턴에서 던진다. 모델 호출 0.
 */
import { runWorkerJob } from "../../core/llm-runtime/capabilities/worker-registry.js";
import {
  __resetJobsForTest,
  failureKind,
  getJob,
  getJobResultChannel,
  markDone,
  registerJob,
  registerWorkerHandler,
  WorkerTimeoutError,
} from "../../core/worker-jobs.js";
import { ToolHangError } from "../../core/llm-runtime/tool-watchdog.js";
import type { RegionASdkOutput } from "../../core/llm-runtime/types.js";
import { assert, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "harvest-failure-keeps-name",
  guards:
    "매니저 거두기 턴이 시간 상한으로 실패했는데 오류 이름이 빠져, 보고서 본문의 «rate limit» 한 마디로 원인이 «사용량 한도» 로 통지되던 것",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    // 시간 상한 하나만 재면 «WorkerTimeoutError 일 때만 이름을 싣는» 좁힘이 통과한다 — 이름 운반은 오류 종류와 무관해야 한다.
    const wall = await harvestFails(() => new WorkerTimeoutError(60_000));
    const tool = await harvestFails(() => new ToolHangError("mcp__ext__fetch", 60_000));
    return [
      ...wall.map((a) => ({ ...a, name: `[시간 상한] ${a.name}` })),
      assert("[도구 멈춤] 실패에 이름이 실리고 분류는 «도구» 다", tool.errorName === "ToolHangError" && tool.kind === "tool", `errorName=${tool.errorName} · 분류=${tool.kind}`),
    ];
  },
};

/** 거두기 턴에서 `makeErr()` 를 던지고, 잡이 닫힌 결과를 단언 묶음 + 이름·분류로 돌려준다. */
const harvestFails = async (makeErr: () => Error): Promise<Assertion[] & { errorName?: string; kind?: string }> => {
  {
    __resetJobsForTest();
    registerWorkerHandler((async () => ({ text: "" })) as never);
    const base = { channel: "cli" as const, channelUserId: "u", task: "API 한도 조사" };
    const jid = registerJob({ ...base, kind: "worker", label: "거두기실패", threadKey: "cli:hf1" });
    const child = registerJob({ ...base, kind: "agent", label: "자식", threadKey: `worker:${jid}`, detached: true });

    let turns = 0;
    runWorkerJob(getJob(jid) as never, async (): Promise<RegionASdkOutput> => {
      turns += 1;
      if (turns === 1) {
        setTimeout(() => {
          markDone(child, "끝");
          getJobResultChannel(jid)?.push({ text: "끝", raw: "[자식] 결과", ts: 2, source: "job" });
        }, 20);
        // 본 보고서 — 조사 주제 자체가 한도라 «rate limit · 429» 가 본문에 있다.
        return { text: "조사 결과: 이 API 는 rate limit 초과 시 429 를 돌려준다." } as RegionASdkOutput;
      }
      throw makeErr();
    });

    const end = Date.now() + 8000;
    while (Date.now() < end && getJob(jid)?.status === "running") {
      await new Promise((r) => setTimeout(r, 10));
    }
    const job = getJob(jid);
    const kind = job?.error !== undefined ? failureKind(job.error, job.errorName) : undefined;
    const out: Assertion[] & { errorName?: string; kind?: string } = [
      assert("거두기 턴까지 돌고 실패로 닫혔다(전제)", turns >= 2 && job?.status === "failed", `턴 ${turns} · ${job?.status}`),
      assert("보고서는 실패 안에 남는다(전제 — 문자열엔 «rate limit» 이 있다)", /rate limit/.test(job?.error ?? ""), `실패 문자열 ${(job?.error ?? "").length}자`),
      assert(
        "★실패에 오류 이름이 실리고, 분류는 «시간 종료» 다(«사용량 한도» 아님)",
        job?.errorName === "WorkerTimeoutError" && kind === "wall",
        `errorName=${job?.errorName} · 분류=${kind}`,
      ),
    ];
    out.errorName = job?.errorName;
    out.kind = kind;
    return out;
  }
};
