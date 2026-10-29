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
/** 매니저가 못 읽은 작업 쪽 글을 버렸다는 로그 — 시나리오마다 따로 센다(전체 출력에서 세면 한 경로가 빠져도 다른 경로 줄로 채워졌다, 독립 검토 10-25 C-6). */
let dropLogs = 0;
const origLog = console.log;
console.log = (...a: unknown[]) => {
  if (/가 끝나 읽지 못한 작업 쪽 글 1건\(반송 등\)을 버림/.test(a.map(String).join(" "))) dropLogs += 1;
  origLog(...a);
};
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
  // ★`notice_id` 를 뺀 지문 — 2026-10-25 `notify_owner` 가 메인 도구 면에 **선택 인자 하나만** 더했다(설계 §18-1, 의도된 계약 변경).
  //  그 하나를 빼면 변경 전 지문과 같아야 한다 = 설명·기존 인자 셋의 의미는 그대로다.
  const shape = ((st?.inputSchema as { shape?: Record<string, unknown> } | undefined)?.shape ?? {}) as Record<string, unknown>;
  const { notice_id: _added, ...rest } = shape;
  const fpWithoutNotice = createHash("sha256").update(JSON.stringify([st?.description, rest])).digest("hex").slice(0, 16);
  out.exposure = { mainAgents, mgrAgents, mainWorkers: Object.keys(mainWorkers), mainSteerFingerprint: fp, mainSteerFingerprintWithoutNotice: fpWithoutNotice, schemaKeys: Object.keys(shape) };
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
  const drop0 = dropLogs;
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
    // 반송의 표시 갈래 — «반송» 칸에 돌려보낸 작업이 실린다 · 보낸 쪽(`from`) 칸은 비어 있다(실리면 «'조사' 의 지시» — 자식이 매니저에게 지시한
    //  것처럼 그려진다 · 둘 다 없으면 사용자 «지시 추가», 독립 검토 10-25 두 번).
    bounceFromChild: bounce.length > 0 && bounce.every((p) => p.returnedByJobId === C && p.returnedByLabel === "조사" && p.fromJobId === undefined),
    // 작업 쪽 글 표식 — 반송·자식 결과 배달은 `source:"job"`(셸 대기가 «새 지시» 로 깨지 않게), 매니저가 자식에 낸 지시는 없음(지시다).
    jobSideMarked: bounce.every((p) => p.source === "job") &&
      (() => { const res = steered.filter((p) => p.jobId === P && String(p.message).startsWith("[백그라운드 서브에이전트 '조사'")); return res.length === 1 && res[0]!.source === "job"; })() &&
      steered.filter((p) => p.jobId === C && p.outcome === "delivered").every((p) => p.source === undefined && p.fromJobId === P),
    dropLogs: dropLogs - drop0,
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

// ── ⑥ 순서 — 실제 러너: 매니저가 **거두기 대기 중**에 자식이 소환자 지시를 못 읽고 끝난다(성공·실패·취소) ─────────────
//  판정은 «수신 순서» 가 아니라 **매니저의 첫 깨움이 그 자식의 결과를 갖고 있나**다. 반송이 결과보다 먼저 steer 로 닿으면 거두기 대기의
//  경주(결과함 vs 지시)에서 지시가 이겨, 결과 없이 «결과를 보고 다시 시키라» 는 턴을 한 번 돈다(독립 검토 10-25 — 실패 분기는 결과를
//  `await import` 뒤에 넣는다). 반송 글은 같은 깨움의 입력이거나 그 턴의 끼워넣기 채널에 있어야 한다(버려지지 않는다).
const reapScenario = async (how: "ok" | "fail" | "cancel") => {
  wj.__resetJobsForTest(); steered.length = 0; sent.length = 0; reinjected.length = 0;
  const P = job("지휘", S);
  let C = "";
  let childGo = false;
  const harvests: Array<{ text: string; steering: string[] }> = [];
  let calls = 0;
  runWorkerJob(wj.getJob(P) as never, async (input: RegionASdkInput): Promise<RegionASdkOutput> => {
    calls += 1;
    if (calls > 1) {
      harvests.push({ text: input.text, steering: (input.steering?.drain() ?? []).map((m) => m.text) });
      return { text: "거두기 턴" } as RegionASdkOutput;
    }
    C = job("조사", `worker:${P}`, "agent");
    startDetachedAgent({
      jobId: C,
      agent: { name: "조사", description: "", filePath: "", source: "builtin" } as never,
      def: "", prompt: "조사", targetCwd: process.cwd(),
      parentInput: { threadKey: `worker:${P}`, channel: CH, text: "", workerDepth: 1 } as never,
      abort: wj.createJobAbort(C),
      __runForTest: async (cin: RegionASdkInput): Promise<RegionASdkOutput> => {
        await until(() => childGo);
        if (how === "cancel") {
          wj.cancelJob(C);
          await until(() => cin.abortSignal?.aborted === true);
          throw new Error("취소됨");
        }
        if (how === "fail") throw new Error("자식이 지시를 읽기 전에 실패");
        return { text: "자식 결과" } as RegionASdkOutput; // 지시를 읽지 않고 끝난다
      },
    });
    return { text: "매니저 본 턴" } as RegionASdkOutput; // 자식이 도는 채로 끝난다 → 거두기 대기
  });
  // ★자식의 지시 채널이 붙을 때까지 기다린다 — 잡은 등록 때 이미 running 이고 채널은 그 뒤 비동기로 붙는다. 그 틈에 보내면 «전달 못 함»(absent)이라
  //  반송할 글이 없어 이 시나리오의 전제가 깨진다(2026-10-29 전체 실행에서만 빨강 — 30ms 대기를 0 으로 줄이면 같은 모양으로 재현).
  await until(() => C !== "" && wj.getJob(C)?.status === "running" && wj.getSteerChannel(C) !== undefined);
  await sleep(30); // 매니저가 본 턴을 끝내고 거두기 대기에 들어간다
  const steerText = textOf(await toolsOf(createSpawnAgentMcpServer(managerInput(P))).steer_worker!.handler({ label: "조사", message: "매니저의 늦은 지시" }, {}));
  childGo = true;
  await until(() => wj.getJob(P)?.status !== "running");
  const first = harvests[0];
  // 갈래마다 **그 갈래에만** 있는 문구 — 취소를 `'조사'` 로 재면 머리말에 늘 있어 취소 본문을 안 쟀다(독립 검토 10-25 C-7).
  const head = { ok: "완료] 결과", fail: "실패]", cancel: "**중지됨**" }[how];
  return {
    cStatus: wj.getJob(C)?.status, pStatus: wj.getJob(P)?.status, harvests: harvests.length,
    steerDelivered: steerText.includes("전달했어요"),
    firstHasResult: first !== undefined && first.text.includes("[백그라운드 서브에이전트 '조사'") && first.text.includes(head),
    bounceInFirst: first !== undefined && (first.text.includes("반영되지 않았습니다") || first.steering.some((t) => t.includes("반영되지 않았습니다"))),
    first: first === undefined ? null : { text: first.text.slice(-260), steering: first.steering.map((t) => t.slice(0, 60)) },
  };
};
out.reap = { ok: await reapScenario("ok"), fail: await reapScenario("fail"), cancel: await reapScenario("cancel") };

// ── ⑦ 반송 보존 — 합류가 결과를 선점(보류)해도 · 결과 배달이 던져도 반송은 간다 / 매니저 **옛 채널**에 남은 반송도 «버림» 이 로그에 ──
{
  const late = (from: string): SteeringInput => ({ text: "지시", raw: "매니저의 늦은 지시", ts: Date.now(), from });
  const bouncedTo = (P: string, C: string): number => drain(P).filter((m) => m.source === "job" && m.from === undefined && m.text.includes(`job_id ${C}`) && m.text.includes("반영되지 않았습니다")).length;
  // (a) 합류 보류 — 소환자가 wait_for_worker 로 권리를 쥔 채 자식이 끝난다(배달은 "parked")
  wj.__resetJobsForTest(); steered.length = 0; sent.length = 0; reinjected.length = 0;
  const P = withChannel(job("지휘", S));
  const C = job("조사", `worker:${P}`, "agent");
  const claim = wj.claimJobJoin(C, `worker:${P}`);
  await wj.onWorkerComplete(C, { result: "자식 결과" }, [], [late(P)]);
  const parked = bouncedTo(P, C);
  wj.releaseJobJoin(claim, { handedOff: true });
  // (b) 결과 배달이 던진다 — 결과함 push 실패를 주입
  wj.__resetJobsForTest(); steered.length = 0; sent.length = 0;
  const P2 = withChannel(job("지휘", S));
  const C2 = job("조사", `worker:${P2}`, "agent");
  const box = createSteeringChannel();
  box.push = () => { throw new Error("결과 배달 실패 주입"); };
  wj.setJobResultChannel(P2, box);
  const threw = await wj.onWorkerComplete(C2, { result: "자식 결과" }, ["사용자의 늦은 지시"], [late(P2)]).then(() => false, () => true);
  const thrown = bouncedTo(P2, C2);
  // 같은 출구의 사용자 늦은 지시 — 배달이 던져도 «반영 못 했다» 통지가 간다(반송만 보장하던 비대칭, 독립 검토 10-25 B-4).
  const thrownUserNotice = sent.filter((t) => t.includes(LATE_HEAD) && t.includes("사용자의 늦은 지시")).length;
  wj.clearJobResultChannel(P2);
  // (c) 매니저 옛 채널 — 어댑터가 반송을 꺼내 쥔 사이 채널이 교체되고, 장부가 옛 채널에 되돌린 뒤 매니저가 끝난다
  wj.__resetJobsForTest(); steered.length = 0; sent.length = 0; reinjected.length = 0;
  const P3 = job("지휘옛채널", S);
  let C3 = "";
  let rotatedOld = false;
  runWorkerJob(wj.getJob(P3) as never, async (input: RegionASdkInput): Promise<RegionASdkOutput> => {
    C3 = job("조사", S, "agent"); // 소환자가 세션인 자식 — 결과가 이 매니저 결과함으로 오지 않아 거두기 턴이 없다(반송만 이 매니저로)
    await wj.onWorkerComplete(C3, { result: "자식 결과" }, [], [late(P3)]);
    const held = input.steering?.drain() ?? [];
    input.steering?.close();
    wj.rotateSteerChannel(P3);
    rotatedOld = wj.getSteerChannel(P3) !== input.steering;
    input.steering?.restore(held);
    return { text: "매니저 본 턴" } as RegionASdkOutput; // 반송을 읽지 않고 끝난다
  });
  await until(() => wj.getJob(P3)?.status !== "running");
  await sleep(30);
  out.keep = {
    claimed: claim !== undefined, parked, threw, thrown, thrownUserNotice, rotatedOld,
    oldRebounce: steered.filter((p) => p.jobId === C3).length,
    oldToUser: sent.filter((t) => /반영되지 않았습니다|매니저의 늦은 지시/.test(t)).length + reinjected.filter((t) => /반영되지 않았습니다|매니저의 늦은 지시/.test(t)).length,
  };
}

// ── ⑧ 반송은 결과다 — 다른 자식을 기다리는 대기를 반송이 깨워도 «지시 도착» 턴으로 열지 않는다(독립 검토 10-25 B-3) ─────────────
//  재현: 거두기 턴 안에서 자식 C 에 지시를 얹고 합류(wait_for_worker)로 결과를 받는다 → C 는 지시를 못 읽고 끝나 반송은 매니저 지시 채널로,
//  결과함엔 없다 → 그 턴이 끝나고 다른 자식 D 를 기다리는 대기가 반송으로 깬다. 종전엔 그 턴이 «지시 도착 — 먼저 반영 · cancel_worker 로 정리» 였다.
{
  wj.__resetJobsForTest(); steered.length = 0;
  const P = job("지휘", S);
  let dGo = false;
  let calls = 0;
  const harvests: string[] = [];
  const spawn = (label: string, run: () => Promise<RegionASdkOutput>): string => {
    const id = job(label, `worker:${P}`, "agent");
    startDetachedAgent({
      jobId: id, agent: { name: label, description: "", filePath: "", source: "builtin" } as never, def: "", prompt: label, targetCwd: process.cwd(),
      parentInput: { threadKey: `worker:${P}`, channel: CH, text: "", workerDepth: 1 } as never, abort: wj.createJobAbort(id), __runForTest: run,
    });
    return id;
  };
  runWorkerJob(wj.getJob(P) as never, async (input: RegionASdkInput): Promise<RegionASdkOutput> => {
    calls += 1;
    if (calls === 1) {
      spawn("대기", async () => { await until(() => dGo); return { text: "D 결과" } as RegionASdkOutput; });
      spawn("빠름", async () => { await sleep(20); return { text: "E 결과" } as RegionASdkOutput; });
      return { text: "매니저 본 턴" } as RegionASdkOutput;
    }
    harvests.push(input.text);
    if (calls === 2) {
      const C = withChannel(job("조사", `worker:${P}`, "agent"));
      await toolsOf(createSpawnAgentMcpServer(managerInput(P))).steer_worker!.handler({ label: "조사", message: "매니저의 늦은 지시" }, {});
      const claim = wj.claimJobJoin(C, `worker:${P}`);
      await wj.onWorkerComplete(C, { result: "C 결과" }, [], drain(C));
      wj.releaseJobJoin(claim, { handedOff: true });
      return { text: "거두기 턴 1" } as RegionASdkOutput; // 지시 채널(반송)을 안 읽고 끝난다
    }
    dGo = true;
    return { text: "거두기 턴" } as RegionASdkOutput;
  });
  await until(() => wj.getJob(P)?.status !== "running");
  const woke = harvests[1];
  out.wake = {
    harvests: harvests.length, pStatus: wj.getJob(P)?.status,
    asResult: woke !== undefined && woke.startsWith("[백그라운드 작업 결과 도착]") && woke.includes("반영되지 않았습니다"),
    asInstruction: harvests.some((t) => t.includes("지시 도착") || t.includes("〔기다리는 중 도착한 지시〕")),
    head: woke?.slice(0, 60) ?? null,
  };
}

for (const ch of channels.values()) ch.close();
console.log(JSON.stringify(out));
process.exit(0);
