import { fileURLToPath } from "node:url";
import { assert, spawnWithin, type Assertion, type RegressionCheck } from "./_framework.js";
import type { RegionAActivityPayload, RegionASdkOutput } from "../../core/llm-runtime/types.js";

type Result = {
  requests: number; activities: RegionAActivityPayload[]; error: string;
  outputs: Array<{ call_id: string; output: string }>;
  external?: RegionASdkOutput["externalToolCalls"];
};
export const check: RegressionCheck = {
  name: "codex-tool-execution-activity",
  guards: "Codex 가 경계에서 버린 tool batch·외부 반환에도 가짜 시작을 남기고 실행시간 끝과 짝이 끊기던 결함",
  run: async () => {
    const assertions: Assertion[] = [];
    for (const mode of ["cap", "before-batch", "parallel-cancel", "errors", "hook-block", "passthrough"]) {
      const r = await spawnWithin(30_000, `Codex 실행 활동 ${mode}`, ["--import", "tsx", fileURLToPath(new URL("./_codex-tool-execution-activity-child.ts", import.meta.url)), mode]);
      const line = r.out.split(/\r?\n/).find(l => l.startsWith("TOOL_ACTIVITY_RESULT "));
      assertions.push(assert(`${mode}: 실제 어댑터 자식이 끝난다`, !r.timedOut && line !== undefined, line ?? r.err.slice(-1800)));
      if (!line) continue;
      const v = JSON.parse(line.slice("TOOL_ACTIVITY_RESULT ".length)) as Result;
      const starts = v.activities.filter(a => a.kind === "tool" && a.phase !== "end");
      const ends = v.activities.filter(a => a.kind === "tool" && a.phase === "end");
      const count = mode === "errors" ? 4 : mode === "before-batch" || mode === "passthrough" ? 0 : 1;
      assertions.push(assert(`${mode}: 실행 시도만 start/end 같은 seq 로 남긴다`,
        starts.length === count && ends.length === count && new Set(starts.map(a => a.seq)).size === count &&
        starts.every(s => ends.some(e => e.seq === s.seq && e.label === s.label && Number.isFinite(e.durationMs) && e.durationMs! >= 0)), v));
      if (mode === "cap") assertions.push(assert("hardcap 미실행 batch 시작 0, 실행 결과와 경계 거절 보존", v.requests === 3 && v.outputs.some(o => o.call_id === "first" && o.output.includes("synthetic activity fixture")) && !v.outputs.some(o => o.call_id === "discarded"), v));
      if (mode === "before-batch" || mode === "parallel-cancel") assertions.push(assert(`${mode}: 취소를 성공으로 바꾸지 않는다`, v.error.includes("synthetic cancellation") && v.requests === 1, v));
      if (mode === "errors") {
        assertions.push(assert("정상 Read 의 경로·상세·출력 프리뷰를 보존", starts[0]?.detail?.includes("fixture.txt") === true && starts[0]?.file?.path === "fixture.txt" && ends.some(e => e.output?.text.includes("synthetic activity fixture")), v));
        assertions.push(assert("bad JSON·unknown tool·실행 실패가 각각 결과로 남는다", ["json", "unknown", "missing"].every(id => v.outputs.some(o => o.call_id === id && /Error|error|ENOENT/.test(o.output))), v));
      }
      if (mode === "hook-block") assertions.push(assert("hook 거절도 실행 시도이며 실제 Read 출력은 없다", ends[0]?.output?.isError === true && !ends[0]?.output?.text.includes("synthetic activity fixture"), v));
      if (mode === "passthrough") assertions.push(assert("외부 함수 반환은 tiguclaw 실행 활동·집계가 아니다", v.external?.[0]?.name === "synthetic_external" && v.outputs.length === 0 && v.requests === 1, v));
    }
    return assertions;
  },
};
