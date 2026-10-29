/**
 * `job-notice` 의 자식 둘째 — **막 끝나는 창 (다)**: 매니저가 거두기 대기 중 시한(`WORKER_TIMEOUT_MS`)으로 끝나는 순간 자식의 알림이
 * 매니저 지시 채널에 남는 경우(설계 §5.5 · §14 ④b-2 · ④c). 시한은 모듈 로드 때 읽으므로 **별도 프로세스**에서 짧게 건다.
 *
 * 메인 핸들러는 **실제 `enqueueThreadTurn` 줄**을 쓴다 — 줄 서는 순서(«완료 → 알림»)와 `beforeTurn` 건너뛰기를 실물로 잰다.
 * 출력: 마지막 줄 JSON.
 */
import { mkdtempSync } from "node:fs";
import path from "node:path";
import { assertIsolated } from "./_framework.js";

assertIsolated();
process.env.TIGUCLAW_HOME = mkdtempSync(path.join(process.env.TIGUCLAW_HOME!, "job-notice-to-"));
process.env.WORKER_TIMEOUT_MS = "1500";

const { initStore } = await import("../../store/sessions.js");
initStore();
const { registerChannelOutbound } = await import("../../core/channel-outbound.js");
const wj = await import("../../core/worker-jobs.js");
const jn = await import("../../core/job-notice.js");
const { getEventBus } = await import("../../core/eventbus.js");
const { createSpawnAgentMcpServer } = await import("../../core/llm-runtime/capabilities/agent-registry.js");
const { runWorkerJob } = await import("../../core/llm-runtime/capabilities/worker-registry.js");
type RegionASdkInput = import("../../core/llm-runtime/types.js").RegionASdkInput;
type RegionASdkOutput = import("../../core/llm-runtime/types.js").RegionASdkOutput;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type R = Record<string, any>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 8_000): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (cond()) return true; await sleep(10); }
  return cond();
};
const CH = "regr-job-notice-to";
registerChannelOutbound(CH, { deliver: async () => ({ messageIds: [1] }), defaultOutboundTarget: async () => "c" } as never);
const notices: R[] = [];
getEventBus().subscribe((ev) => { if (ev.type === "worker.notice") notices.push(ev.payload as R); });
type ToolResult = { content: Array<{ text?: string }>; isError?: boolean };
type Tool = { handler: (a: unknown, extra: unknown) => Promise<ToolResult> };
const toolsOf = (server: unknown): Record<string, Tool> => (server as { instance: { _registeredTools: Record<string, Tool> } }).instance._registeredTools;
const textOf = (r: ToolResult): string => r.content.map((c) => c.text ?? "").join("");
const job = (label: string, threadKey: string, kind: "worker" | "agent" = "worker"): string =>
  wj.registerJob({ label, task: `${label} 지시`, threadKey, channel: CH as never, channelUserId: "u", notifyDest: { channel: CH as never, target: "c" }, kind, detached: true } as never);
/**
 * 코어 `notifyOwner()` 를 **동기로** 부른다 — abort 리스너 안에서 부르려고. ★이번 릴리스 보류로 도구 서버가 없다
 * (`docs/decisions/2026-10-29-notify-owner-release-hold.md`) — 핸들러 본문과 같은 호출이다. 옛 `srv !== undefined` 분기는 지웠다
 * (남기면 알림 없이 조용히 지나간다).
 */
const notifyNow = (id: string, message: string): void => {
  wj.notifyOwner(`agent:${id}`, message);
};

/** 메인 핸들러 — 실제 줄. 완료 턴의 동작만 시나리오가 정한다. */
let completionTask: (threadKey: string) => Promise<void> = () => new Promise<void>(() => {});
const order: string[] = [];
const ran: Array<{ origin?: string; skip: string | null }> = [];
wj.__setMainHandlerForTest((m) => {
  order.push(String(m.turnOrigin));
  return wj.enqueueThreadTurn(m.threadKey, async () => {
    const skip = m.beforeTurn?.() ?? null;
    ran.push({ origin: m.turnOrigin, skip });
    if (skip !== null) return;
    if (m.turnOrigin === "worker-completion") await completionTask(m.threadKey);
  });
});

/**
 * 매니저 P 의 본 턴이 도는 자식 C 를 남기고 끝난다 → 거두기 대기 → 시한 abort.
 * `abortNotice` = 시한 abort 리스너 **안에서**(대기 루프가 깨기 전, 동기) C 가 알린다 — P 는 아직 running 이라 지시 채널로 들어가고,
 *  대기는 그걸 꺼내지 못한 채 끝나 러너 `finally` 가 회수한다. `earlyNotice` = 시한 전에 알린다(정상 소비 대조군).
 */
const scenario = async (o: { session: string; abortNotice: boolean; earlyNotice: boolean }) => {
  wj.__resetJobsForTest(); jn.__resetNoticesForTest(); order.length = 0; ran.length = 0; notices.length = 0;
  const P = job("시한지휘", o.session);
  let C = "";
  const harvests: string[] = [];
  let calls = 0;
  runWorkerJob(wj.getJob(P) as never, async (input: RegionASdkInput): Promise<RegionASdkOutput> => {
    calls += 1;
    if (calls === 1) {
      C = job("조사", `worker:${P}`, "agent"); // 끝나지 않는 자식 — 거두기 대기를 남긴다
      if (o.abortNotice) input.abortSignal?.addEventListener("abort", () => notifyNow(C, "시한 직전 알림"), { once: true });
      return { text: "본 턴" } as RegionASdkOutput;
    }
    harvests.push(input.text);
    if (input.abortSignal?.aborted === true) throw new Error("aborted"); // 어댑터처럼 — 끊긴 턴은 던진다
    return { text: "거두기" } as RegionASdkOutput;
  });
  await until(() => C !== "");
  if (o.earlyNotice) { await sleep(200); notifyNow(C, "시한 전 알림"); }
  await until(() => wj.getJob(P)?.status !== "running");
  await sleep(150);
  return { P, C, harvests };
};

const out: R = {};
// ④b-2 대조군 — 시한 전 알림은 거두기 턴이 소비 · 재배달 0
{
  const r = await scenario({ session: "dashboard:regr-to-ctl", abortNotice: false, earlyNotice: true });
  out.control = {
    pStatus: wj.getJob(r.P)?.status, consumed: r.harvests.some((h) => h.includes("〔작업자 알림〕") && h.includes("시한 전 알림")),
    noticeTurns: order.filter((x) => x === "worker-notice").length, inbox: jn.__noticeInboxSizeForTest(),
  };
}
// ④b-2 — 시한 abort 와 러너 finally 사이 · 끝나지 않는 완료 턴(실제 줄)에서도 수신함 1 · 줄 순서 «완료 → 알림»
{
  completionTask = () => new Promise<void>(() => {});
  const r = await scenario({ session: "dashboard:regr-to-a", abortNotice: true, earlyNotice: false });
  out.window = {
    pStatus: wj.getJob(r.P)?.status, cStatus: wj.getJob(r.C)?.status, harvests: r.harvests.length,
    order: [...order], inbox: jn.__noticeInboxSizeForTest(),
    events: notices.filter((n) => n.jobId === r.C).map((n) => `${n.outcome}${n.route !== undefined ? `/${n.route}` : ""}${n.redelivery === true ? "*" : ""}`),
  };
}
// ④c — 완료 턴이 그 자식을 합류하면 그 합류가 즉시 꺼낸다(≤1초) · 뒤의 알림 턴은 `beforeTurn` 사유로 건너뛴다
{
  let join: { ms: number; top: boolean } | undefined;
  completionTask = async (threadKey: string) => {
    const C = [...wj.listJobs({ runningOnly: true })].find((j) => j.label === "조사")?.jobId ?? "";
    const t0 = Date.now();
    const res = textOf(await toolsOf(createSpawnAgentMcpServer({ threadKey, channel: CH, text: "" } as never)).wait_for_worker!.handler({ job_ids: [C], timeout_seconds: 5 }, {}));
    join = { ms: Date.now() - t0, top: res.startsWith("📣 기다리는 동안 작업자 알림") };
  };
  await scenario({ session: "dashboard:regr-to-b", abortNotice: true, earlyNotice: false });
  await until(() => ran.length >= 2, 8_000);
  out.joinTakes = { join, ran: ran.map((x) => ({ origin: x.origin, skipped: x.skip !== null })), inbox: jn.__noticeInboxSizeForTest() };
}

console.log(JSON.stringify(out));
process.exit(0);
