/**
 * 회귀: **마무리 단계 실패에서 원결과(완성된 본 보고)와 원오류가 섞이지 않는다** (2026-10-31 완료 보고 복구 설계 §4-1 · 증분 1).
 *
 * 사고(진단 2026-10-31 기제 B): 매니저 본 작업이 끝난 뒤 마무리(거두기) 턴이 실패하면 «원오류 + 꼬리표 + 본 보고» 가 한 오류 문자열로
 * 접혔다. 그래서 ①분류가 본 보고 낱말에 흔들렸고(진단 S5) ②부모·점호·조회가 각자 그 문자열을 다르게 읽었다.
 *
 * 지키는 것:
 *  ① 분류는 원오류만 읽는다 — 본 보고 낱말을 바꿔도 원오류·분류가 같다.
 *  ② 부모 매니저가 받는 실패 문구에 본 보고가 남는다(종전에 부모가 받던 것을 잃지 않는다) · «완료» 로 내지 않는다.
 *  ③ 점호(`takeUndeliveredChildResults`)가 실패+원결과를 «완료 · 결과» 로 내지 않는다.
 *
 * 등급: **동작** — 레지스트리·러너를 실제로 돌린다. 모델 호출 0 · 실제 발송 0.
 */
import { markReplayBlocked, withFailureNotice, withPartialReport } from "../../core/llm-runtime/partial-failure.js";
import { registerChannelOutbound, unregisterChannelOutbound } from "../../core/channel-outbound.js";
import { startDetachedAgent } from "../../core/llm-runtime/capabilities/agent-registry.js";
import { runWorkerJob } from "../../core/llm-runtime/capabilities/worker-registry.js";
import {
  __resetJobsForTest,
  createJobAbort,
  renderJobNotice,
  failureKind,
  getJob,
  getJobResultChannel,
  markDone,
  onWorkerComplete,
  registerJob,
  registerWorkerHandler,
  setJobResultChannel,
  takeUndeliveredChildResults,
} from "../../core/worker-jobs.js";
import { createSteeringChannel } from "../../core/steering.js";
import type { RegionASdkOutput } from "../../core/llm-runtime/types.js";
import { assert, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";

const until = async (cond: () => boolean, ms = 8000): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end && !cond()) await new Promise((r) => setTimeout(r, 10));
  return cond();
};

/** 본 턴은 `report` 를 내고 자식 하나를 완주시켜 거두기 턴을 만든다 — 거두기 턴은 `fetch failed` 로 던진다. */
const wrapUpFails = async (report: string): Promise<{ status?: string; error?: string; errorName?: string; result?: string }> => {
  __resetJobsForTest();
  registerWorkerHandler((async () => ({ text: "" })) as never);
  const base = { channel: "cli" as const, channelUserId: "u", task: "조사" };
  const jid = registerJob({ ...base, kind: "worker", label: "마무리실패", threadKey: "cli:wrapup-split" });
  const child = registerJob({ ...base, kind: "agent", label: "자식", threadKey: `worker:${jid}`, detached: true });
  let turns = 0;
  runWorkerJob(getJob(jid) as never, async (): Promise<RegionASdkOutput> => {
    turns += 1;
    if (turns === 1) {
      setTimeout(() => {
        markDone(child, "끝");
        getJobResultChannel(jid)?.push({ text: "끝", raw: "[자식] 결과", ts: 2, source: "job" });
      }, 20);
      return { text: report } as RegionASdkOutput;
    }
    throw new TypeError("fetch failed");
  });
  await until(() => getJob(jid)?.status !== "running");
  const j = getJob(jid);
  return { status: j?.status, error: j?.error, errorName: j?.errorName, result: j?.result };
};

export const check: RegressionCheck = {
  name: "completion-report-wrapup-split",
  guards:
    "매니저 마무리(거두기) 턴이 실패하면 원오류에 본 보고가 섞여 분류가 본 보고 낱말에 흔들리고, 부모·점호가 실패를 «완료» 로 읽던 것(2026-10-31 진단 기제 B)",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const out: Assertion[] = [];

    // First turn, harvest and detached subagent must all stay failed with partial evidence.
    for (const lane of ["first", "harvest", "agent"] as const) {
      __resetJobsForTest();
      registerWorkerHandler((async () => ({ text: "" })) as never);
      const base = { channel: "cli" as const, channelUserId: "u", task: "failure contract" };
      const parent = registerJob({ ...base, kind: "worker", label: "parent", threadKey: "cli:partial-parent" });
      const box = createSteeringChannel();
      setJobResultChannel(parent, box);
      const jid = registerJob({ ...base, kind: lane === "agent" ? "agent" : "worker", label: lane, threadKey: `worker:${parent}`, detached: true });
      const secret = ["sk", "regrSecret1234567890abcdef"].join("-");
      const error = withPartialReport(new TypeError("fetch failed"), `[PARTIAL] rate limit 429 timed out — unfinished ${secret}`);
      withFailureNotice(error, `try again in a moment ${secret}`);
      markReplayBlocked(error, `unsafe replay after add_memory ${secret}`);
      let turns = 0;
      const run = async (): Promise<RegionASdkOutput> => {
        turns++;
        if (lane === "harvest" && turns === 1) {
          const child = registerJob({ ...base, kind: "agent", label: "child", threadKey: `worker:${jid}`, detached: true });
          setTimeout(() => { markDone(child, "child done"); getJobResultChannel(jid)?.push({ text: "child done", raw: "child done", ts: 2, source: "job" }); }, 20);
          return { text: "[COMPLETE] first report" } as RegionASdkOutput;
        }
        throw error;
      };
      if (lane === "agent") startDetachedAgent({ jobId: jid,
        agent: { name: "probe", description: "d", filePath: "/x/probe.md", source: "user" } as never,
        def: "probe", prompt: "probe", targetCwd: process.cwd(),
        parentInput: { text: "", threadKey: `worker:${parent}`, channel: "cli", turnOrigin: "worker" } as never,
        abort: createJobAbort(jid, {}), __runForTest: run });
      else runWorkerJob(getJob(jid) as never, run);
      await until(() => getJob(jid)?.status !== "running");
      const j = getJob(jid);
      const delivered = box.drain().map(m => m.text).join("\n");
      const notice = renderJobNotice({ status: "failed", label: lane, error: j?.error, errorName: j?.errorName, result: j?.result });
      out.push(assert(`${lane}: failure and original classification survive partial report`,
        j?.status === "failed" && j.error === "fetch failed" && j.errorName === "TypeError" && failureKind(j.error, j.errorName) !== "limit", j));
      out.push(assert(`${lane}: incomplete report survives storage, delivery and replayable notice`,
        (j?.result ?? "").includes("[PARTIAL]") && delivered.includes("[PARTIAL]") && notice.includes("[PARTIAL]") && !delivered.includes("본 작업은 끝났") && !notice.includes("본 작업은 끝났"), { result: j?.result, delivered, notice }));
      out.push(assert(`${lane}: transient/replay guidance survives storage/parent/notice, all partial and notice secrets redacted`,
        [j?.result ?? "", delivered, notice].every(text => text.includes("try again in a moment") && text.includes("unsafe replay after add_memory") && text.includes("[REDACTED]") && !text.includes(secret)), { result: j?.result, delivered, notice }));
      if (lane === "harvest") out.push(assert("harvest: complete first report and partial harvest are both preserved", (j?.result ?? "").includes("[COMPLETE]"), j?.result));
    }

    // First failure through real worker/agent registries: actual first raw notice (fake outbound),
    // plus parent delivery without a partial report. No live channel/model is registered here.
    for (const kind of ["worker", "agent"] as const) {
      for (const target of ["parent", "notice"] as const) {
        for (const hasPartial of target === "parent" ? [false] : [false, true]) {
          __resetJobsForTest();
          let mainTurns = 0;
          registerWorkerHandler((async () => { mainTurns += 1; }) as never);
          const channel = "regr-wrapup-first-failure";
          const sent: string[] = [];
          registerChannelOutbound(channel, {
            deliver: async (_target: string | null, text: string) => { sent.push(text); return { messageIds: [1] }; },
          } as never);
          try {
            const base = { channel: "cli" as const, channelUserId: "u", task: "first failure delivery" };
            const parent = registerJob({ ...base, kind: "worker", label: "parent", threadKey: "cli:first-failure-parent" });
            const box = createSteeringChannel();
            setJobResultChannel(parent, box);
            const threadKey = target === "parent" ? `worker:${parent}` : "cli:first-failure-notice";
            const jid = registerJob({ ...base, kind, label: `${kind}-${target}`, threadKey, detached: true,
              notifyDest: { channel, target: "synthetic-only" } });
            const secret = ["sk", "regrSecret1234567890abcdef"].join("-");
            const error = new TypeError("fetch failed");
            if (hasPartial) withPartialReport(error, `[FIRST-PARTIAL] unfinished ${secret}`);
            withFailureNotice(error, `try again in a moment ${secret}`);
            markReplayBlocked(error, `unsafe replay after add_memory ${secret}`);
            let calls = 0;
            const run = async (): Promise<RegionASdkOutput> => { calls += 1; throw error; };
            if (kind === "agent") startDetachedAgent({ jobId: jid,
              agent: { name: "probe", description: "d", filePath: "/x/probe.md", source: "user" } as never,
              def: "probe", prompt: "probe", targetCwd: process.cwd(),
              parentInput: { text: "", threadKey, channel: "cli", turnOrigin: "worker" } as never,
              abort: createJobAbort(jid, {}), __runForTest: run });
            else runWorkerJob(getJob(jid) as never, run);
            const settled = await until(() => getJob(jid)?.status === "failed" &&
              (target === "parent" ? getJob(jid)?.resultDelivered === true : sent.length > 0));
            const j = getJob(jid);
            const received = target === "parent" ? box.drain().map(m => m.text).join("\n") : sent.join("\n");
            const label = `${kind}/${target}/${hasPartial ? "partial" : "no-partial"}`;
            out.push(assert(`${label}: first failure stays failed, raw cause unmixed, runner once and no completion LLM`,
              settled && j?.status === "failed" && j.error === "fetch failed" && j.errorName === "TypeError" && calls === 1 && mainTurns === 0,
              { status: j?.status, error: j?.error, calls, mainTurns }));
            out.push(assert(`${label}: storage and actual delivery retain guidance/replay with secrets redacted, never success`,
              [j?.result ?? "", received].every(text => text.includes("try again in a moment") &&
                text.includes("unsafe replay after add_memory") && text.includes("[REDACTED]") && !text.includes(secret)) &&
                !received.includes("본 작업은 끝났") && !received.includes("' 완료]") &&
                (target === "parent" ? sent.length === 0 : sent.length === 1),
              { result: j?.result, received, sends: sent.length }));
            out.push(assert(`${label}: partial presence is preserved without inventing a report`,
              [j?.result ?? "", received].every(text => text.includes("[FIRST-PARTIAL]") === hasPartial &&
                text.includes("[Incomplete partial report]") === hasPartial), { result: j?.result, received }));
          } finally {
            unregisterChannelOutbound(channel);
          }
        }
      }
    }

    // ── ① 분류는 원오류만 — 본 보고 낱말(한도·시간 초과)을 바꿔도 같다 ─────────────────────
    const plain = await wrapUpFails("[REPORT] 조사 결과: 특이사항 없음.");
    const noisy = await wrapUpFails("[REPORT] 조사 결과: 이 API 는 rate limit 초과 시 429, 오래 걸리면 timed out 을 낸다.");
    out.push(
      assert(
        "마무리 실패는 실패로 닫히고 본 보고는 원결과 칸에 있다(전제)",
        plain.status === "failed" && noisy.status === "failed" && (noisy.result ?? "").includes("rate limit"),
        `${plain.status}/${noisy.status} · 원결과 ${(noisy.result ?? "").length}자`,
      ),
      assert(
        "★원오류는 원인 문장뿐이다 — 본 보고·꼬리표가 섞이지 않는다",
        plain.error === "fetch failed" && noisy.error === "fetch failed",
        `${JSON.stringify(plain.error)} / ${JSON.stringify(noisy.error)}`,
      ),
      assert(
        "★본 보고 낱말을 바꿔도 분류가 같다(원오류 기준 — 진단 S5)",
        failureKind(plain.error ?? "", plain.errorName) === failureKind(noisy.error ?? "", noisy.errorName) &&
          failureKind(noisy.error ?? "", noisy.errorName) !== "limit",
        `${failureKind(plain.error ?? "", plain.errorName)} / ${failureKind(noisy.error ?? "", noisy.errorName)}`,
      ),
    );

    // ── ② 부모 매니저가 받는 실패 문구에 본 보고가 남는다 ─────────────────────────────────
    {
      __resetJobsForTest();
      const parent = registerJob({ channel: "cli", channelUserId: "u", task: "지휘", kind: "worker", label: "부모", threadKey: "cli:wrapup-parent" });
      const box = createSteeringChannel();
      setJobResultChannel(parent, box);
      const child = registerJob({ channel: "cli", channelUserId: "u", task: "하위", kind: "worker", label: "하위매니저", threadKey: `worker:${parent}`, detached: true });
      await onWorkerComplete(child, { error: "fetch failed", errorName: "TypeError", completedReport: "[CHILD-REPORT] 하위 본 보고 전문" });
      const got = box.drain().map((m) => m.text).join("\n");
      out.push(
        assert(
          "★부모 결과함 문구에 완성된 본 보고가 있고 «실패(보고 보존)» 로 말한다 — «완료» 가 아니다",
          got.includes("[CHILD-REPORT] 하위 본 보고 전문") && got.includes("실패(보고 보존)") && !got.includes("' 완료]"),
          JSON.stringify(got.slice(0, 160)),
        ),
        assert("자식 잡 상태는 failed · 원결과는 본 보고", getJob(child)?.status === "failed" && getJob(child)?.result === "[CHILD-REPORT] 하위 본 보고 전문", `${getJob(child)?.status}`),
      );
    }

    // ── ③ 점호가 실패+원결과를 «완료» 로 내지 않는다 ────────────────────────────────────
    {
      __resetJobsForTest();
      registerWorkerHandler((async () => ({ text: "" })) as never);
      const parent = registerJob({ channel: "cli", channelUserId: "u", task: "지휘", kind: "worker", label: "부모2", threadKey: "cli:wrapup-roll" });
      const child = registerJob({ channel: "cli", channelUserId: "u", task: "하위", kind: "agent", label: "하위2", threadKey: `worker:${parent}`, detached: true });
      // 결과함이 없다 — 배달은 결과함을 못 거쳐 점호가 다시 줘야 한다.
      const { markFailed } = await import("../../core/worker-jobs.js");
      markFailed(child, "fetch failed", "TypeError", "[ROLL-REPORT] 본 보고");
      const roll = takeUndeliveredChildResults(`worker:${parent}`);
      const text = roll.map((r) => r.text).join("\n");
      out.push(
        assert(
          "★점호가 실패+원결과를 «완료 · 결과» 로 내지 않는다 — 실패(보고 보존)와 본 보고",
          roll.length === 1 && text.includes("실패(보고 보존)") && text.includes("[ROLL-REPORT] 본 보고") && !text.includes("' 완료]"),
          JSON.stringify(text.slice(0, 160)),
        ),
      );
    }
    __resetJobsForTest();
    return out;
  },
};
