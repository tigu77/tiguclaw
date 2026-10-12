// 끼워넣기가 꺼진 매니저(WORKER_STEERING_ENABLED=0)도 자식 결과를 거둔다 — 부모 프로세스가 env 를 끄고 띄운다(모듈 상수라 프로세스 단위).
import { runWorkerJob } from "../../core/llm-runtime/capabilities/worker-registry.js";
import * as wj from "../../core/worker-jobs.js";
import { assertIsolated } from "./_framework.js";
import type { RegionASdkInput, RegionASdkOutput } from "../../core/llm-runtime/types.js";
assertIsolated();
const log = console.log.bind(console);
console.log = () => {};
console.warn = () => {};
const waitUntil = async (cond: () => boolean, ms: number): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (cond()) return true; await new Promise((r) => setTimeout(r, 10)); }
  return cond();
};
wj.registerWorkerHandler((async () => ({ text: "" })) as never);
const base = { channel: "cli" as const, channelUserId: "u", task: "회귀 과제" };
const jid = wj.registerJob({ ...base, kind: "worker", label: "끼워넣기꺼짐", threadKey: "cli:steer-off" });
const child = wj.registerJob({ ...base, kind: "agent", label: "자식", threadKey: `worker:${jid}`, detached: true });
const texts: string[] = [];
runWorkerJob(wj.getJob(jid) as never, async (input: RegionASdkInput): Promise<RegionASdkOutput> => {
  texts.push(input.text);
  return { text: `턴${texts.length}` } as RegionASdkOutput;
});
await waitUntil(() => texts.length === 1, 2000);
await new Promise((r) => setTimeout(r, 50));
wj.markDone(child, "결과");
wj.getJobResultChannel(jid)?.push({ text: "결과", raw: "[자식] 회귀-꺼짐결과", ts: 1, source: "job" });
await waitUntil(() => wj.getJob(jid)?.status !== "running", 3000);
log("STEER_OFF " + JSON.stringify({ enabled: wj.WORKER_STEERING_ENABLED, turns: texts.length, resultSeen: texts.some((t) => t.includes("회귀-꺼짐결과")), status: wj.getJob(jid)?.status }));
process.exit(0);
