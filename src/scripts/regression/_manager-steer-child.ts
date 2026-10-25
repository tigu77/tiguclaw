/**
 * `manager-steers-direct-child` 의 자식 — **소환자는 직속 자식에게 지시할 수 있다**(2026-10-25,
 * [설계](../../../docs/decisions/2026-10-25-summoner-steers-direct-child.md))를 실제 부품으로 돌린다:
 * 실제 `steer_worker` 핸들러(매니저 `agents` · 메인 `workers`) · 실제 `steerJob`/채널 · 실제 러너
 * (`runWorkerJob`·`startDetachedAgent`, 모델 호출만 주입) · 실제 완료 출구(`onWorkerComplete`).
 * 메인 핸들러·배달 채널만 대역이다.
 *
 * ★왜 자식인가: 메인 핸들러·배달 채널을 전역에 건다 — 스위트 프로세스에 걸면 뒤 검사가 그걸 본다.
 * 출력: 마지막 줄 JSON.
 */
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import path from "node:path";
import { assertIsolated } from "./_framework.js";

assertIsolated();
process.env.TIGUCLAW_HOME = mkdtempSync(path.join(process.env.TIGUCLAW_HOME!, "mgr-steer-"));

const { initStore } = await import("../../store/sessions.js");
initStore();
const { registerChannelOutbound } = await import("../../core/channel-outbound.js");
const wj = await import("../../core/worker-jobs.js");
const { getEventBus } = await import("../../core/eventbus.js");
const { createSpawnAgentMcpServer, startDetachedAgent } = await import("../../core/llm-runtime/capabilities/agent-registry.js");
const { createWorkerMcpServer, runWorkerJob, steerChildJob } = await import("../../core/llm-runtime/capabilities/worker-registry.js");
const { createSteeringChannel } = await import("../../core/steering.js");
const { translate } = await import("../../core/i18n.js");
/** 늦은 사용자 지시 통지의 머리 — 러너 로케일과 무관하게(영어로 돌 수 있다). */
const LATE_HEAD = translate("srv.job.late.head", { label: "" }).slice(0, 14);
type SteeringInput = import("../../core/steering.js").SteeringInput;
type RegionASdkInput = import("../../core/llm-runtime/types.js").RegionASdkInput;
type RegionASdkOutput = import("../../core/llm-runtime/types.js").RegionASdkOutput;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 5_000): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (cond()) return true; await sleep(10); }
  return cond();
};
const CH = "regr-mgr-steer";
const sent: string[] = [];
registerChannelOutbound(CH, { deliver: async (_t: unknown, text: string) => { sent.push(text); return { messageIds: [1] }; }, defaultOutboundTarget: async () => "c" } as never);
const reinjected: string[] = [];
wj.__setMainHandlerForTest(async (m) => { reinjected.push(m.text); await m.reply?.("보고"); });
const steered: Array<Record<string, unknown>> = [];
getEventBus().subscribe((ev) => { if (ev.type === "worker.steered") steered.push(ev.payload as Record<string, unknown>); });

const S = "dashboard:regr-mgr-steer-s";
const S2 = "dashboard:regr-mgr-steer-other";
const job = (label: string, threadKey: string, kind: "worker" | "agent" = "worker", detached = true): string =>
  wj.registerJob({ label, task: `${label} 지시`, threadKey, channel: CH as never, channelUserId: "u", notifyDest: { channel: CH as never, target: "c" }, kind, detached } as never);
const channels = new Map<string, ReturnType<typeof createSteeringChannel>>();
const withChannel = (id: string): string => { const ch = createSteeringChannel(); channels.set(id, ch); wj.setSteerChannel(id, ch); return id; };
const drain = (id: string): SteeringInput[] => channels.get(id)?.drain() ?? [];

type ToolResult = { content: Array<{ text?: string }>; isError?: boolean };
type Tool = { handler: (a: unknown, extra: unknown) => Promise<ToolResult>; description?: string; inputSchema?: unknown };
const toolsOf = (server: unknown): Record<string, Tool> => (server as { instance: { _registeredTools: Record<string, Tool> } }).instance._registeredTools;
const managerInput = (managerId: string) => ({ threadKey: `worker:${managerId}`, channel: CH, text: "", workerDepth: 1 }) as never;
const textOf = (r: ToolResult): string => r.content.map((c) => c.text ?? "").join("");
const out: Record<string, unknown> = {};

// ── ① 노출 — 매니저 `agents` 에만 · 메인 도구 면 불변(이름·설명·스키마) ───────────────────────────────
{
  const mainAgents = Object.keys(toolsOf(createSpawnAgentMcpServer({ threadKey: S, channel: CH, text: "" } as never)));
  const mgrAgents = Object.keys(toolsOf(createSpawnAgentMcpServer(managerInput("x"))));
  const mainWorkers = toolsOf(createWorkerMcpServer({ threadKey: S, channel: CH, text: "" } as never));
  const st = mainWorkers.steer_worker;
  const fp = createHash("sha256").update(JSON.stringify([st?.description, st?.inputSchema])).digest("hex").slice(0, 16);
  out.exposure = { mainAgents, mgrAgents, mainWorkers: Object.keys(mainWorkers), mainSteerFingerprint: fp };
}

// ── ② 직속 자식만 — 형제·형제의 자식(동명)·부모·다른 대화·끝난/취소·알고 있는 jobId ──────────────────
{
  wj.__resetJobsForTest(); steered.length = 0;
  const M = withChannel(job("지휘", S));
  const M2 = withChannel(job("옆지휘", S));
  const C = withChannel(job("조사", `worker:${M}`, "agent"));
  const C2 = withChannel(job("조사", `worker:${M2}`, "agent")); // 형제의 자식 — 같은 label
  const X = withChannel(job("남", S2));
  const D = job("중복", `worker:${M}`, "agent"); wj.markDone(D, "끝"); // 내 자식은 끝났고
  const D2 = withChannel(job("중복", `worker:${M2}`, "agent")); // 형제의 같은 이름은 돈다
  const E = job("취소된것", `worker:${M}`, "agent"); wj.markCancelled(E, "취소");
  const W = withChannel(job("합류중", `worker:${M}`, "agent", false)); // 실행 중인 **awaited** 직속 자식 — detached 가 아니다
  const steer = toolsOf(createSpawnAgentMcpServer(managerInput(M))).steer_worker!.handler;
  const r1 = textOf(await steer({ label: "조사", message: "B만 봐" }, {}));
  const got = drain(C); const gotC2 = drain(C2);
  const deliveredEv = steered.find((p) => p.jobId === C && p.outcome === "delivered");
  const r2 = textOf(await steer({ job_id: C, message: "id로" }, {}));
  const gotById = drain(C);
  steered.length = 0;
  const refused: Record<string, { text: string; leaked: number }> = {};
  for (const [name, a] of [
    ["형제 매니저 label", { label: "옆지휘" }], ["형제 매니저 id", { job_id: M2 }],
    ["형제의 자식 id", { job_id: C2 }], ["다른 대화 id", { job_id: X }], ["다른 대화 label", { label: "남" }],
    ["동명(내 것 끝남)", { label: "중복" }], ["끝난 자식 id", { job_id: D }], ["취소된 자식 id", { job_id: E }],
    ["자기 자신 id", { job_id: M }],
    ["awaited 직속 자식 label", { label: "합류중" }], ["awaited 직속 자식 id", { job_id: W }],
    // 조합 입력 — 없는 이름 + 남의 id 가 메인용 전역 조회로 떨어지면 안 된다(변이 사냥 M5).
    ["없는 이름 + 형제의 자식 id", { label: "없는이름", job_id: C2 }], ["없는 이름 + 다른 대화 id", { label: "없는이름", job_id: X }],
  ] as const) {
    const t = textOf(await steer({ ...a, message: "새면 안 됨" }, {}));
    refused[name] = { text: t.slice(0, 80), leaked: [M, M2, C2, X, D2, W].reduce((n, id) => n + drain(id).length, 0) + drain(C).length };
  }
  const refusedEvents = steered.map((p) => ({ jobId: p.jobId, outcome: p.outcome, fromJobId: p.fromJobId }));
  // 부모: 서브에이전트 좌표(`agent:C`)에서 자기 부모(M)로 — 같은 판정(서브는 자식이 없어 대상이 빈다).
  const parentText = textOf(await steerChildJob({ threadKey: `agent:${C}` }, { job_id: M, message: "부모로" }));
  const parentLeak = drain(M).length;
  // 호출자 작업이 실행 중이 아니면 거절 — 완료·실패·취소 셋 다(변이 사냥 M2: «완료만» 으로 좁혀도 초록이던 것).
  const deadCallers: Record<string, { text: string; leaked: number }> = {};
  for (const [how, end] of [
    ["완료", (id: string) => wj.markDone(id, "끝")],
    ["실패", (id: string) => wj.markFailed(id, "터짐")],
    ["취소", (id: string) => wj.markCancelled(id, "취소")],
  ] as const) {
    const P = job(`호출자-${how}`, S);
    const K = withChannel(job(`자식-${how}`, `worker:${P}`, "agent"));
    end(P);
    const t = textOf(await toolsOf(createSpawnAgentMcpServer(managerInput(P))).steer_worker!.handler({ job_id: K, message: "끝난 호출자" }, {}));
    deadCallers[how] = { text: t.slice(0, 40), leaked: drain(K).length };
  }
  out.direct = {
    r1: r1.slice(0, 60), r2: r2.slice(0, 60),
    head: got[0]?.text.slice(0, 40), userHead: got.some((m) => m.text.includes("[사용자 추가 지시]")), from: got[0]?.from, raw: got[0]?.raw,
    got: got.length, gotC2: gotC2.length, gotById: gotById.length,
    deliveredEv: deliveredEv === undefined ? null : { fromJobId: deliveredEv.fromJobId, fromLabel: deliveredEv.fromLabel },
    refused, refusedEvents, parentText: parentText.slice(0, 120), parentRefused: parentText.includes("찾지 못했어요"), parentLeak, deadCallers,
    M,
  };
}

// ── ③ 메인 규약은 종전 그대로 — 손자 label · 다른 대화 job_id · 다른 대화 동명 안내 · 사용자 머리 ───────────
{
  wj.__resetJobsForTest(); steered.length = 0;
  const M = withChannel(job("지휘", S));
  const G = withChannel(job("손자전용", `worker:${M}`, "agent"));
  const X = withChannel(job("남의것", S2));
  const steer = toolsOf(createWorkerMcpServer({ threadKey: S, channel: CH, text: "" } as never)).steer_worker!.handler;
  const g = textOf(await steer({ label: "손자전용", message: "메인이 손자에" }, {}));
  const gGot = drain(G);
  const x = textOf(await steer({ job_id: X, message: "메인이 다른 대화 id 로" }, {}));
  const xGot = drain(X);
  const other = textOf(await steer({ label: "남의것", message: "동명" }, {}));
  const otherGot = drain(X);
  out.main = {
    grandchild: gGot.length, gHead: gGot[0]?.text.slice(0, 12), gFrom: gGot[0]?.from ?? null, g: g.slice(0, 30),
    otherSessionId: xGot.length, x: x.slice(0, 30),
    otherSessionLabel: other.includes("다른 대화"), otherLeak: otherGot.length,
    events: steered.map((p) => ({ outcome: p.outcome, from: p.fromJobId ?? null })),
  };
}

// ── ④ 늦게 도착 — 실제 러너 연결: 자식이 안 읽고 끝남 → 보낸 매니저에게 반송 → 매니저도 안 읽고 끝남 ─────────
const MANAGER_TEXT = /매니저의 (이른|늦은) 지시|반영되지 않았습니다/;
const lateScenario = async (opts: { rotate: boolean; userControl: boolean; fail?: boolean }) => {
  wj.__resetJobsForTest(); steered.length = 0; sent.length = 0; reinjected.length = 0;
  const P = job("지휘", S);
  let C = "";
  let calls = 0;
  let rotated = false;
  let anchorBefore: number | undefined;
  let anchorAfter: number | undefined;
  runWorkerJob(wj.getJob(P) as never, async (_input: RegionASdkInput): Promise<RegionASdkOutput> => {
    calls += 1;
    if (calls > 1) return { text: "거두기 턴" } as RegionASdkOutput; // 거두기 턴 — 스티어를 읽지 않는다
    C = job("조사", `worker:${P}`, "agent");
    startDetachedAgent({
      jobId: C,
      agent: { name: "조사", description: "", filePath: "", source: "builtin" } as never,
      def: "", prompt: "조사", targetCwd: process.cwd(),
      parentInput: { threadKey: `worker:${P}`, channel: CH, text: "", workerDepth: 1 } as never,
      abort: wj.createJobAbort(C),
      __runForTest: async (input: RegionASdkInput): Promise<RegionASdkOutput> => {
        const steerAsManager = (message: string) => toolsOf(createSpawnAgentMcpServer(managerInput(P))).steer_worker!.handler({ label: "조사", message }, {});
        // 옛 채널에 갇히는 소환자 지시 — 어댑터 장부(`_steering-ledger.ts`)는 꺼냈다가 못 쓴 지시를 **자기가 들고 있던** 채널에
        //  되돌린다. 그 사이 교체됐으면 옛 채널이다(교체는 잔여를 새 채널로 옮기므로 이 길로만 남는다). 그것도 출처째 거둬야 한다
        //  (싱크 전 레드팀: 옛 채널 잔여에서 `from` 을 지워도 초록이던 것).
        let heldByAdapter: SteeringInput[] = [];
        if (opts.rotate) { await steerAsManager("매니저의 이른 지시"); heldByAdapter = input.steering?.drain() ?? []; }
        // claude 어댑터처럼 턴 끝에 채널을 닫으면 steerJob 이 갈아끼운다 — 교체된 채널의 잔여도 같이 거둬야 한다.
        if (opts.rotate) input.steering?.close();
        // 보낸 매니저의 점검 시계 앵커 — 반송은 판단이 아니라 시스템 글이라 이걸 밀면 안 된다(resetStallClock:false).
        anchorBefore = wj.getJob(P)?.lastActivityAt;
        await sleep(15);
        await steerAsManager("매니저의 늦은 지시");
        rotated = wj.getSteerChannel(C) !== input.steering; // 갈아끼운 채널로 들어갔나
        if (heldByAdapter.length > 0) input.steering?.restore(heldByAdapter); // 장부가 옛 채널에 되돌린다
        if (opts.userControl) {
          await toolsOf(createWorkerMcpServer({ threadKey: S, channel: CH, text: "" } as never)).steer_worker!.handler({ label: "조사", message: "사용자의 늦은 지시" }, {});
        }
        // 실패 종료도 같은 출구다 — 지시를 받은 뒤 읽기 전에 터져도 보낸 매니저에게 돌아가야 한다(싱크 전 레드팀: 성공 결과일 때만 반송해도 초록이던 것).
        if (opts.fail === true) throw new Error("자식이 지시를 읽기 전에 실패");
        return { text: "자식 결과" } as RegionASdkOutput; // 읽지 않고 끝난다
      },
    });
    await until(() => wj.getJob(C)?.status !== "running");
    anchorAfter = wj.getJob(P)?.lastActivityAt;
    return { text: "매니저 본 턴" } as RegionASdkOutput; // 반송을 읽지 않고 끝난다
  });
  await until(() => wj.getJob(P)?.status !== "running");
  await sleep(60);
  const bounce = steered.filter((p) => p.jobId === P && String(p.message).includes("반영되지 않았습니다"));
  return {
    rotated,
    anchorKept: anchorBefore !== undefined && anchorAfter === anchorBefore,
    pStatus: wj.getJob(P)?.status, cStatus: C === "" ? null : wj.getJob(C)?.status,
    bounce: bounce.map((p) => p.outcome),
    bouncedEarly: bounce.some((p) => String(p.message).includes("매니저의 이른 지시")),
    bouncedLate: bounce.some((p) => String(p.message).includes("매니저의 늦은 지시")),
    userLateNotices: sent.filter((t) => t.includes(LATE_HEAD)).length,
    managerTextToUser: sent.filter((t) => MANAGER_TEXT.test(t)).length + reinjected.filter((t) => MANAGER_TEXT.test(t)).length,
    userTextToUser: sent.filter((t) => t.includes("사용자의 늦은 지시")).length,
    sent: sent.map((t) => t.slice(0, 50)),
  };
};
out.late = await lateScenario({ rotate: false, userControl: false });
out.lateRotated = await lateScenario({ rotate: true, userControl: false });
out.lateUserControl = await lateScenario({ rotate: false, userControl: true });
out.lateFailed = await lateScenario({ rotate: false, userControl: false, fail: true });

// ── ⑥ 순서 — 반송은 완료 배달보다 **먼저**(설계 §3 «완료 배달 전, 동기»): 매니저가 완료를 받는 순간 반송이 이미 큐에 있다 ──
//  (싱크 전 레드팀: 두 호출의 순서를 바꿔도 초록이던 것 — 최종 큐만 보면 같다.)
{
  wj.__resetJobsForTest(); steered.length = 0;
  const P = withChannel(job("지휘", S));
  const C = job("조사", `worker:${P}`, "agent");
  const box = createSteeringChannel();
  wj.setJobResultChannel(P, box);
  let bounceQueuedAtCompletion: number | null = null;
  const push = box.push;
  box.push = (m) => { bounceQueuedAtCompletion ??= channels.get(P)!.pending(); return push(m); };
  await wj.onWorkerComplete(C, { result: "자식 결과" }, [], [{ text: "지시", raw: "매니저의 늦은 지시", ts: Date.now(), from: P }]);
  out.order = { bounceQueuedAtCompletion, completions: box.pending(), bounced: drain(P).filter((m) => m.source === "job").length };
  box.close();
}

for (const ch of channels.values()) ch.close();
console.log(JSON.stringify(out));
process.exit(0);
