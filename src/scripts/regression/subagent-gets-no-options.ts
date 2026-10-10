/**
 * 회귀: **서브에이전트에는 선택지 띄우기(presentOptions)를 넘기지 않는다** (2026-10-09 전체 적대 검토 P3).
 *
 * 사고: 2026-07-17 부터 부모의 `presentOptions` 를 자식에게 그대로 물려줬다. 자식 어댑터는 그 보기의 대기 답을
 *  `agent:<jobId>` 좌표로 기억하는데, 사용자가 고른 답은 **사람의 세션**으로 들어온다 — 받을 자리가 없어서 보기만 뜨고
 *  고른 값은 아무에게도 안 갔다. 서브는 물을 게 생기면 부모에게 보고하고, 묻는 것은 사람과 대화 중인 부모가 한다.
 *
 * ★등급: 동작 — 진짜 `startDetachedAgent` 를 돌려 자식이 받은 입력을 본다(모델 호출만 갈아끼운다).
 */
import {
  __resetJobsForTest,
  createJobAbort,
  getJob,
  registerJob,
} from "../../core/worker-jobs.js";
import { startDetachedAgent } from "../../core/llm-runtime/capabilities/agent-registry.js";
import type { RegionASdkInput, RegionASdkOutput } from "../../core/llm-runtime/types.js";
import { assert, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "subagent-gets-no-options",
  guards: "서브에이전트에 부모의 선택지 띄우기를 물려줘 보기는 뜨는데 고른 답이 아무에게도 안 가던 것",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    __resetJobsForTest();
    const child = registerJob({ channel: "dashboard", channelUserId: "u", task: "t", kind: "agent", label: "probe", threadKey: "dashboard:opts", detached: true });
    const abort = createJobAbort(child, {});
    let seen: RegionASdkInput | undefined;
    const parentOptions = (async () => undefined) as unknown as NonNullable<RegionASdkInput["presentOptions"]>;
    startDetachedAgent({
      jobId: child,
      agent: { name: "probe", description: "d", filePath: "/x/probe.md", source: "user" } as never,
      def: "정의",
      prompt: "해라",
      targetCwd: "/tmp",
      parentInput: { text: "", threadKey: "dashboard:opts", channel: "dashboard", presentOptions: parentOptions } as RegionASdkInput,
      abort,
      __runForTest: async (input): Promise<RegionASdkOutput> => {
        seen = input;
        return { text: "끝" } as RegionASdkOutput;
      },
    });
    const end = Date.now() + 4000;
    while (Date.now() < end && getJob(child)?.status === "running") await new Promise((r) => setTimeout(r, 10));
    return [
      assert("자식이 실제로 실행됐다(빈손 통과 금지)", seen !== undefined, seen ? `threadKey=${seen.threadKey}` : "★미실행"),
      assert(
        "★부모에게 선택지 띄우기가 있어도 자식 입력엔 없다(답을 받을 자리가 없으므로)",
        seen !== undefined && seen.presentOptions === undefined,
        `자식 presentOptions=${seen?.presentOptions === undefined ? "없음" : "있음(부모 것 상속)"}`,
      ),
    ];
  },
};
