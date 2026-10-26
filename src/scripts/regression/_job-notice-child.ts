/**
 * `job-notice` 의 자식 — `notify_owner`(2026-10-25, [설계](../../../docs/decisions/2026-10-23-notify-owner-design.md) §14)를 실제 부품으로 돌린다:
 * 실제 `notify_owner` 도구 핸들러 · 실제 `wait_for_worker`/`steer_worker`(메인 `workers`·매니저 `agents`) · 실제 `steerJob`/채널 ·
 * 실제 매니저 러너(`runWorkerJob`, 모델 호출만 주입) · 실제 완료 출구 · 실제 셸 대기(`BashOutput`) · 실제 진행 알림 틱.
 * 메인 핸들러·배달 채널만 대역이다(외부 송신 0 — 등록한 가짜 채널이 문자열만 모은다).
 *
 * ★왜 자식인가: 메인 핸들러·배달 채널·진행 알림 설정을 전역에 건다 — 스위트 프로세스에 걸면 뒤 검사가 그걸 본다.
 * 출력: 마지막 줄 JSON.
 */
import { mkdtempSync } from "node:fs";
import path from "node:path";
import { assertIsolated, loadPluginModule } from "./_framework.js";

assertIsolated();
process.env.TIGUCLAW_HOME = mkdtempSync(path.join(process.env.TIGUCLAW_HOME!, "job-notice-"));

const { initStore } = await import("../../store/sessions.js");
initStore();
const { registerChannelOutbound } = await import("../../core/channel-outbound.js");
const wj = await import("../../core/worker-jobs.js");
const jn = await import("../../core/job-notice.js");
const { getEventBus } = await import("../../core/eventbus.js");
const { createSpawnAgentMcpServer } = await import("../../core/llm-runtime/capabilities/agent-registry.js");
const { createWorkerMcpServer, runWorkerJob, harvestTurnText } = await import("../../core/llm-runtime/capabilities/worker-registry.js");
const { createNotifyOwnerMcpServer } = await import("../../core/llm-runtime/capabilities/notify-owner-mcp.js");
const { createFileOpsMcpServer, killAllBgShells } = await import("../../core/llm-runtime/capabilities/file-ops-mcp.js");
const { createSteeringChannel } = await import("../../core/steering.js");
const jp = await import("../../core/job-progress.js");
const { setProgressNoticeSettings } = await import("../../core/settings.js");
type SteeringInput = import("../../core/steering.js").SteeringInput;
type RegionASdkInput = import("../../core/llm-runtime/types.js").RegionASdkInput;
type RegionASdkOutput = import("../../core/llm-runtime/types.js").RegionASdkOutput;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type R = Record<string, any>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 5_000): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (cond()) return true; await sleep(10); }
  return cond();
};
const CH = "regr-job-notice";
const sent: string[] = [];
registerChannelOutbound(CH, { deliver: async (_t: unknown, text: string) => { sent.push(text); return { messageIds: [1] }; }, defaultOutboundTarget: async () => "c" } as never);

/** 메인 핸들러에 들어온 합성 턴 — 차례(`beforeTurn`)는 검사가 직접 부른다. 기본은 **영원히 안 끝나는** 핸들러(도구가 기다리면 멈춘다). */
type Turn = { threadKey: string; text: string; turnOrigin?: string; synthetic?: boolean; beforeTurn?: () => string | null };
const turns: Turn[] = [];
wj.__setMainHandlerForTest((m) => {
  turns.push({ threadKey: m.threadKey, text: m.text, turnOrigin: m.turnOrigin, synthetic: m.synthetic, beforeTurn: m.beforeTurn });
  return new Promise<void>(() => {});
});
const notices: R[] = [];
const steered: R[] = [];
getEventBus().subscribe((ev) => {
  if (ev.type === "worker.notice") notices.push(ev.payload as R);
  if (ev.type === "worker.steered") steered.push(ev.payload as R);
});

const S = "dashboard:regr-notice-s";
const job = (label: string, threadKey: string, kind: "worker" | "agent" = "worker"): string =>
  wj.registerJob({ label, task: `${label} 지시`, threadKey, channel: CH as never, channelUserId: "u", notifyDest: { channel: CH as never, target: "c" }, kind, detached: true } as never);
const channels = new Map<string, ReturnType<typeof createSteeringChannel>>();
const withChannel = (id: string): string => { const ch = createSteeringChannel(); channels.set(id, ch); wj.setSteerChannel(id, ch); return id; };
const drain = (id: string): SteeringInput[] => channels.get(id)?.drain() ?? [];

type ToolResult = { content: Array<{ text?: string }>; isError?: boolean };
type Tool = { handler: (a: unknown, extra: unknown) => Promise<ToolResult>; description?: string; inputSchema?: unknown };
const toolsOf = (server: unknown): Record<string, Tool> => (server as { instance: { _registeredTools: Record<string, Tool> } }).instance._registeredTools;
const textOf = (r: ToolResult): string => r.content.map((c) => c.text ?? "").join("");
const coord = (id: string): string => (wj.getJob(id)?.kind === "agent" ? `agent:${id}` : `worker:${id}`);
/** 작업자 `id` 의 실제 `notify_owner` 도구로 보낸다 — 반환까지 걸린 시간도 잰다(영원히 안 끝나는 메인 핸들러로도 즉시 돌아와야 한다). */
const notify = async (id: string, message: string): Promise<{ text: string; ms: number }> => {
  const srv = createNotifyOwnerMcpServer({ threadKey: coord(id) });
  if (srv === undefined) return { text: "(도구 없음)", ms: 0 };
  const t0 = Date.now();
  const r = await Promise.race([toolsOf(srv).notify_owner!.handler({ message }, {}), sleep(3_000).then(() => ({ content: [{ text: "(3초 안에 안 돌아옴)" }] }))]);
  return { text: textOf(r as ToolResult), ms: Date.now() - t0 };
};
const mainInput = (signal?: AbortSignal) => ({ threadKey: S, channel: CH, text: "", ...(signal !== undefined ? { abortSignal: signal } : {}) }) as never;
const managerInput = (id: string, signal?: AbortSignal) => ({ threadKey: `worker:${id}`, channel: CH, text: "", workerDepth: 1, ...(signal !== undefined ? { abortSignal: signal } : {}) }) as never;
const reset = (): void => {
  wj.__resetJobsForTest(); jn.__resetNoticesForTest();
  turns.length = 0; notices.length = 0; steered.length = 0; sent.length = 0;
};
const outcomes = (jobId: string): string[] => notices.filter((n) => n.jobId === jobId).map((n) => `${n.outcome}${n.route !== undefined ? `/${n.route}` : ""}${n.redelivery === true ? "*" : ""}`);
const out: R = {};
/** 합류 등록을 기다린 결과 — 시나리오마다(실패하면 «등록 확인 뒤 알림» 이 성립 안 한 것이니 검사가 빨갛게 본다, GPT R4 선택 개선). */
const joinRegistered: Record<string, boolean> = {};
// ★플러그인 소스는 계산한 지정자로 싣는다 — 리터럴 import 는 `npm run build`(rootDir=src)를 TS6059 로 깬다(`loadPluginModule` 주석).
const { handleWorkerJobs } = await loadPluginModule<{ handleWorkerJobs: (ctx: unknown) => Promise<void> }>("../../../plugins/http-bridge/routes-work.js");
/** 실제 잡 목록 응답(`/api/worker-jobs`) 중 그 잡 — 카드 하이드레이션 재료. */
const listJob = async (id: string): Promise<R | null> => {
  let body = "";
  await handleWorkerJobs({ req: {}, res: { writeHead: () => {}, setHeader: () => {}, end: (x: string) => { body = x; } }, url: new URL("http://x/worker-jobs") });
  const items = (JSON.parse(body || "{}").items ?? []) as R[];
  return items.find((j) => j.jobId === id) ?? null;
};

// ── ① 소환자 = 세션 — 합성 턴 1 · 영원히 안 끝나는 핸들러로도 도구가 즉시 반환 · 차례가 오면 꺼낸다 ───────────────
{
  reset();
  const M = job("잠금대기", S);
  const r = await notify(M, "실화면 확인에 Unity 공통 잠금이 필요한데 스튜디오 플레이어가 쥐고 있습니다. 닫아도 되면 알려 주세요.");
  const t = turns[0];
  const took = t?.beforeTurn?.() ?? "(없음)";
  out.session = {
    ms: r.ms, ret: r.text.slice(0, 160), turns: turns.length, synthetic: t?.synthetic, origin: t?.turnOrigin, threadKey: t?.threadKey,
    hasText: t?.text.includes("Unity 공통 잠금") === true, hasIds: t?.text.includes(`job_id ${M}`) === true && t?.text.includes("notice_id n1") === true,
    took, inboxAfter: jn.__noticeInboxSizeForTest(), events: outcomes(M),
  };
}

// ── ② 소환자 = 도는 매니저 — 지시 채널에 1 · 작업 쪽 글 + noticeOf · 점검 시계 안 민다 · 메인 턴 0 ─────────────────
{
  reset();
  const P = withChannel(job("지휘", S));
  const C = job("조사", `worker:${P}`, "agent");
  wj.getJob(P)!.stallReports = 1;
  const anchor = wj.getJob(P)!.lastActivityAt;
  const r = await notify(C, "공유 DB 잠금을 다른 작업이 쥐고 있음");
  const got = drain(P);
  out.manager = {
    ret: r.text.slice(0, 120), got: got.length, source: got[0]?.source, noticeOf: got[0]?.noticeOf ?? null,
    head: got[0]?.text.slice(0, 60), hasAnswerHow: got[0]?.text.includes("steer_worker(job_id, message, notice_id)") === true,
    stall: wj.getJob(P)!.stallReports, anchorKept: wj.getJob(P)!.lastActivityAt === anchor, turns: turns.length, events: outcomes(C),
    steerEv: steered.filter((s) => s.jobId === P).map((s) => ({ outcome: s.outcome, source: s.source, noticeOf: s.noticeOf })),
  };
}

// ── ③ 소환자 매니저가 합류 중 — 1초 안에 돌아오고 맨 위 «📣» · 다른 id 는 안 기다림 · 스티어 0 · 메인 0 ──────────────────
{
  reset();
  const P = withChannel(job("지휘", S));
  const C1 = job("조사1", `worker:${P}`, "agent");
  const C2 = job("조사2", `worker:${P}`, "agent");
  const t0 = Date.now();
  const p = toolsOf(createSpawnAgentMcpServer(managerInput(P))).wait_for_worker!.handler({ job_ids: [C1, C2], timeout_seconds: 30 }, {});
  joinRegistered.join = await until(() => jn.isNoticeJoining(`worker:${P}`)); // 합류가 등록된 뒤에 알린다(부하에서 150ms 로는 모자라 시한까지 기다렸다 — 사냥 중 관측)
  const r = await notify(C1, "C1 이 막힘");
  const res = textOf(await p);
  out.join = {
    ms: Date.now() - t0, ret: r.text.slice(0, 100), top: res.startsWith("📣 기다리는 동안 작업자 알림"), hasId: res.includes(`notice_id n1`) && res.includes(`job_id ${C1}`),
    c2Running: res.includes("조사2") && res.includes("작업자 알림이 와서 일찍 돌아왔습니다"), steer: drain(P).length, turns: turns.length, events: outcomes(C1),
  };
}

// ── ③b 남의 합류 — 같은 대화의 매니저 Q 가 P 의 자식 C 를 합류해도 알림은 P 로(스티어) · Q 는 안 깨어난다 ─────────────────
{
  reset();
  const P = withChannel(job("지휘", S));
  const Q = withChannel(job("옆지휘", S));
  const C = job("조사", `worker:${P}`, "agent");
  const t0 = Date.now();
  const p = toolsOf(createSpawnAgentMcpServer(managerInput(Q))).wait_for_worker!.handler({ job_ids: [C], timeout_seconds: 1.2 }, {});
  joinRegistered.otherJoin = await until(() => jn.isNoticeJoining(`worker:${Q}`));
  await notify(C, "C 가 막힘");
  const res = textOf(await p);
  out.otherJoin = { ms: Date.now() - t0, toP: drain(P).length, toQ: drain(Q).length, qNotice: res.includes("📣"), turns: turns.length };
}

// ── ③c·③d 합류 중단 — 신호가 선 합류는 꺼내지 않는다 · 남은 알림은 받을 자리로 정확히 1건(매니저=스티어 · 세션=줄 선 턴) ──────
{
  reset();
  // 매니저 T — 중단 신호가 서는 **바로 그 순간**(대기가 깨기 전) 알림이 들어온다: 수신함에 놓였지만 합류는 꺼내지 않는다.
  const P = withChannel(job("지휘", S));
  const C = job("조사", `worker:${P}`, "agent");
  const ac = new AbortController();
  ac.signal.addEventListener("abort", () => { void notify(C, "중단 직전 알림"); }, { once: true });
  const t0 = Date.now();
  const p = toolsOf(createSpawnAgentMcpServer(managerInput(P, ac.signal))).wait_for_worker!.handler({ job_ids: [C], timeout_seconds: 30 }, {});
  joinRegistered.abortMgr = await until(() => jn.isNoticeJoining(`worker:${P}`));
  ac.abort();
  const res = await p;
  await sleep(30);
  const mgr = { ms: Date.now() - t0, cancelled: res.isError === true && textOf(res).includes("취소됨"), joinTook: textOf(res).includes("📣"), steer: drain(P).length, inbox: jn.__noticeInboxSizeForTest(), turns: turns.length, events: outcomes(C) };
  // 세션 T — 같은 순간 · 합류는 꺼내지 않고 줄 선 합성 턴이 꺼낸다(정확히 1).
  reset();
  const M = job("세션자식", S);
  const ac2 = new AbortController();
  ac2.signal.addEventListener("abort", () => { void notify(M, "중단 직전 세션 알림"); }, { once: true });
  const p2 = toolsOf(createSpawnAgentMcpServer(mainInput(ac2.signal))).wait_for_worker!.handler({ job_ids: [M], timeout_seconds: 30 }, {});
  joinRegistered.abortSession = await until(() => jn.isNoticeJoining(S));
  ac2.abort();
  const res2 = await p2;
  await sleep(30);
  const took = turns.map((t) => t.beforeTurn?.() ?? "(none)");
  out.joinAbort = { mgr, session: { joinTook: textOf(res2).includes("📣"), turns: turns.length, took, events: outcomes(M) } };
}

// ── ③e 세션 합류가 먼저 꺼낸다 — 줄 선 합성 턴은 `beforeTurn` 사유로 건너뛴다(모델 호출 0) ─────────────────────────────
{
  reset();
  const M = job("세션자식", S);
  const t0 = Date.now();
  const p = toolsOf(createSpawnAgentMcpServer(mainInput())).wait_for_worker!.handler({ job_ids: [M], timeout_seconds: 30 }, {});
  joinRegistered.sessionJoin = await until(() => jn.isNoticeJoining(S));
  await notify(M, "세션이 기다리는 중 알림");
  const res = textOf(await p);
  const skip = turns[0]?.beforeTurn?.() ?? null;
  out.sessionJoin = { ms: Date.now() - t0, top: res.startsWith("📣"), turns: turns.length, skip, events: outcomes(M) };
}

// ── ④ 소환자 매니저가 이미 끝남 — 소유 세션 합성 턴 · 본문에 부모 label ─────────────────────────────────────────
{
  reset();
  const P = job("먼저끝난지휘", S);
  const C = job("조사", `worker:${P}`, "agent");
  wj.markDone(P, "끝");
  const r = await notify(C, "부모가 끝난 뒤 알림");
  out.parentDone = { ret: r.text.slice(0, 80), turns: turns.length, threadKey: turns[0]?.threadKey, note: turns[0]?.text.includes("'먼저끝난지휘' 는 이미 끝나") === true };
}

// ── ④b-1 막 끝나는 창 (가) 본 턴 실패 — 러너 finally 가 회수 · 실패 마킹 직후 세션 수신함 1 · 알림 턴 줄 섬 · 자식이 끝났으면 0 ─────
const failScenario = async (childEnds: boolean) => {
  reset();
  const P = job(childEnds ? "지휘실패-자식끝" : "지휘실패", S);
  let C = "";
  runWorkerJob(wj.getJob(P) as never, async (_input: RegionASdkInput): Promise<RegionASdkOutput> => {
    C = job("조사", `worker:${P}`, "agent");
    await notify(C, "실패 직전 알림"); // P 는 아직 running·합류 아님 → P 의 지시 채널로
    if (childEnds) wj.markDone(C, "끝");
    throw new Error("본 턴 실패");
  });
  await until(() => wj.getJob(P)?.status !== "running");
  await sleep(50);
  const inbox = jn.__noticeInboxSizeForTest();
  const noticeTurns = turns.filter((t) => t.turnOrigin === "worker-notice");
  const took = noticeTurns.map((t) => t.beforeTurn?.() ?? null);
  return { pStatus: wj.getJob(P)?.status, inbox, noticeTurns: noticeTurns.length, took, note: noticeTurns[0]?.text.includes("이미 끝나 대화로 올렸습니다") === true, events: outcomes(C), raw: sent.length };
};
out.failWindow = { live: await failScenario(false), childEnded: await failScenario(true) };

// ── ⑤ 중복·상한·길이 ────────────────────────────────────────────────────────────────────────────────
{
  reset();
  const M = job("남발", S);
  const a1 = await notify(M, "A 가 막힘");
  const a2 = await notify(M, "  A   가 막힘 ");
  const b = await notify(M, "B 가 막힘");
  const c = await notify(M, "C 가 막힘");
  const d = await notify(M, "D 가 막힘");
  const N = job("길이", S);
  const ok300 = await notify(N, "가".repeat(300));
  const bad301 = await notify(N, "가".repeat(301));
  const empty = await notify(N, "   ");
  // ★«300자» 는 사람이 세는 글자(코드 포인트)다 — 보충 평면 문자(이모지)는 UTF-16 으로 두 칸이라, 길이를 UTF-16 으로 세면 승인 범위 안의 알림이
  //  거절된다(독립 변이 사냥 구멍 2). 300개는 통과 · 301개는 거절.
  const EM = job("이모지", S);
  const emoji300 = await notify(EM, "🙂".repeat(300));
  const EM2 = job("이모지2", S);
  const emoji301 = await notify(EM2, "🙂".repeat(301));
  out.limits = {
    turns: turns.filter((t) => t.text.includes(`job_id ${M}`)).length, notices: wj.getJob(M)?.notices?.length,
    a2: a2.text.slice(0, 40), d: d.text.slice(0, 40), events: outcomes(M), a1: a1.text.slice(0, 20), b: b.text.slice(0, 10), c: c.text.slice(0, 10),
    ok300: ok300.text.slice(0, 12), bad301: bad301.text.slice(0, 40), empty: empty.text.slice(0, 20), lenEvents: outcomes(N),
    emoji300: emoji300.text.slice(0, 12), emoji301: emoji301.text.slice(0, 40), emojiKept: wj.getJob(EM)?.notices?.length ?? 0,
  };
}

// ── ⑥ 노출 — 메인 턴엔 없다 · 실행 중인 매니저·서브 턴엔 있다 · 끝난 잡엔 없다 · 설명 600자 이내 ───────────────────
{
  reset();
  const M = job("노출매니저", S);
  const C = job("노출서브", `worker:${M}`, "agent");
  const E = job("끝난", S); wj.markDone(E, "끝");
  const mgr = createNotifyOwnerMcpServer({ threadKey: `worker:${M}` });
  out.exposure = {
    main: createNotifyOwnerMcpServer({ threadKey: S }) === undefined,
    endpoint: createNotifyOwnerMcpServer({ threadKey: "endpoint:x" }) === undefined,
    manager: mgr !== undefined && Object.keys(toolsOf(mgr)).join() === "notify_owner",
    sub: createNotifyOwnerMcpServer({ threadKey: `agent:${C}` }) !== undefined,
    ended: createNotifyOwnerMcpServer({ threadKey: `worker:${E}` }) === undefined,
    descLen: [...(toolsOf(mgr).notify_owner?.description ?? "")].length,
    mainSteerHasNoticeId: JSON.stringify(toolsOf(createWorkerMcpServer(mainInput())).steer_worker?.inputSchema ?? {}).includes("notice_id"),
    mgrSteerHasNoticeId: JSON.stringify(toolsOf(createSpawnAgentMcpServer(managerInput(M))).steer_worker?.inputSchema ?? {}).includes("notice_id"),
  };
}

// ── ⑧ 답 잇기 — id 일치 AND delivered 만 답 확정 · 실패한 답·틀린 id·id 없음은 미해결 · 둘 중 하나만 · 매니저 도구로도 ──────────
{
  reset();
  const C = withChannel(job("답받을작업", S));
  await notify(C, "첫 막힘");
  await notify(C, "둘째 막힘");
  const listBefore = await listJob(C);
  const mainSteer = toolsOf(createWorkerMcpServer(mainInput())).steer_worker!.handler;
  const plain = textOf(await mainSteer({ job_id: C, message: "무관한 지시" }, {}));
  const afterPlain = wj.getJob(C)?.notices?.map((n) => n.answeredAt !== undefined);
  const wrong = textOf(await mainSteer({ job_id: C, message: "틀린 id", notice_id: "n9" }, {}));
  const right = textOf(await mainSteer({ job_id: C, message: "닫아도 돼", notice_id: "n2" }, {}));
  const got = drain(C);
  const listAfter = await listJob(C);
  const answeredEv = notices.filter((n) => n.outcome === "answered" && n.jobId === C);
  const attempts = steered.filter((s) => s.jobId === C).map((s) => ({ outcome: s.outcome, answersNoticeId: s.answersNoticeId ?? null }));
  // 전달 실패한 답 — 채널 없는 작업(absent)
  const A = job("채널없음", S);
  await notify(A, "채널 없는 작업의 막힘");
  const failed = textOf(await mainSteer({ job_id: A, message: "답", notice_id: "n1" }, {}));
  // 매니저 도구로도 — 매니저 P 가 자식 K 의 알림에 답
  const P = withChannel(job("지휘", S));
  const K = withChannel(job("자식", `worker:${P}`, "agent"));
  await notify(K, "자식 막힘");
  drain(P);
  const mgrAns = textOf(await toolsOf(createSpawnAgentMcpServer(managerInput(P))).steer_worker!.handler({ job_id: K, message: "풀었어", notice_id: "n1" }, {}));
  // 이미 끝난 작업에 답 — 대상을 못 찾은 시도도 어느 알림에 대한 답이었는지 남는다(GPT R1 #3) · 답 확정은 없다. 메인·매니저 두 갈래.
  const Z = job("끝난답대상", S);
  await notify(Z, "끝나기 전 막힘");
  wj.markDone(Z, "끝");
  const zText = textOf(await mainSteer({ job_id: Z, message: "늦은 답", notice_id: "n1" }, {}));
  const ZK = job("끝난자식", `worker:${P}`, "agent");
  await notify(ZK, "끝나기 전 자식 막힘");
  wj.markDone(ZK, "끝");
  await toolsOf(createSpawnAgentMcpServer(managerInput(P))).steer_worker!.handler({ job_id: ZK, message: "늦은 답", notice_id: "n1" }, {});
  const lateAttempts = steered.filter((x) => x.outcome === "no-target" && x.message === "늦은 답").map((x) => ({ answersNoticeId: x.answersNoticeId ?? null, from: x.fromJobId === P }));
  const lateUnanswered = wj.getJob(Z)?.notices?.[0]?.answeredAt === undefined && wj.getJob(ZK)?.notices?.[0]?.answeredAt === undefined;
  // 다른 대화의 작업을 이름으로 짚은 답 — other-session 시도에도 어느 알림의 답이었는지 남는다 · 전달 0 · 답 확정 없음(GPT R2).
  const XO = withChannel(job("다른대화작업", "dashboard:regr-notice-other"));
  await notify(XO, "다른 대화의 막힘");
  const xoText = textOf(await mainSteer({ label: "다른대화작업", message: "다른 대화로 답", notice_id: "n1" }, {}));
  const otherSession = {
    attempts: steered.filter((x) => x.message === "다른 대화로 답").map((x) => ({ outcome: x.outcome, answersNoticeId: x.answersNoticeId ?? null })),
    delivered: drain(XO).length, unanswered: wj.getJob(XO)?.notices?.[0]?.answeredAt === undefined, text: xoText.slice(0, 40),
  };
  // 타임라인 대조용 — 같은 이벤트(`worker.steered`)의 다른 두 갈래도 실제 생산 경로로 낸다: 자식 결과 배달 · 반송.
  const P2 = withChannel(job("결과받는지휘", S));
  wj.setJobResultChannel(P2, createSteeringChannel());
  const K2 = job("결과자식", `worker:${P2}`, "agent");
  await wj.onWorkerComplete(K2, { result: "자식 결과" });
  wj.setJobResultChannel(P, createSteeringChannel()); // 결과는 결과함으로(메인 완료 턴을 열지 않게 — 그 핸들러는 끝나지 않는다)
  const K3 = withChannel(job("반송자식", `worker:${P}`, "agent"));
  await wj.onWorkerComplete(K3, { result: "끝" }, [], [{ text: "지시", raw: "매니저 지시", ts: Date.now(), from: P }]);
  out.answer = {
    plain: plain.slice(-30), afterPlain, wrong: wrong.slice(-80), right: right.slice(-80),
    states: wj.getJob(C)?.notices?.map((n) => n.answeredAt !== undefined),
    head: got.map((m) => m.text.slice(0, 22)), answeredEv: answeredEv.map((n) => ({ noticeId: n.noticeId, answeredAt: typeof n.answeredAt })),
    attempts, failed: failed.slice(-30), failedState: wj.getJob(A)?.notices?.[0]?.answeredAt === undefined,
    failedAttempt: steered.filter((s) => s.jobId === A).map((s) => ({ outcome: s.outcome, answersNoticeId: s.answersNoticeId })),
    mgrAns: mgrAns.slice(-30), mgrState: wj.getJob(K)?.notices?.[0]?.answeredAt !== undefined,
    payloads: { sent: notices.find((n) => n.jobId === C && n.outcome === "sent"), answered: answeredEv.at(-1) },
    activity: wj.getJobActivity(C)?.notice ?? null,
    list: { before: listBefore, after: listAfter },
    late: { attempts: lateAttempts, unanswered: lateUnanswered, text: zText.slice(0, 40) },
    otherSession,
    // 타임라인 다섯 갈래 — 실제 생산 payload(알림 배달 · 답 지시 · 실패한 답 · 결과 · 반송)를 화면 검사로 넘긴다.
    steeredAll: steered.map((x) => ({ ...x })),
  };
}

// ── ⑭ 비전달 상승 — 도는 부모에 지시 채널이 없으면(absent) 그 자리에서 소유 세션으로 ─────────────────────────────────────
{
  reset();
  const P = job("채널없는지휘", S); // running 이지만 setSteerChannel 안 함
  const C = job("조사", `worker:${P}`, "agent");
  const r = await notify(C, "부모가 못 받는 알림");
  out.absentUp = { ret: r.text.slice(0, 60), steer: steered.filter((s) => s.jobId === P).map((s) => s.outcome), turns: turns.length, threadKey: turns[0]?.threadKey };
}

// ── ⑫ 거두기 문구 — 실제 러너: 거두기 대기 중 자식 알림 → 거두기 턴 입력에 «〔작업자 알림〕» 묶음 · «지시» 묶음엔 없다 ─────────────
{
  reset();
  const P = job("거두는지휘", S);
  let C = "";
  const harvests: string[] = [];
  let calls = 0;
  runWorkerJob(wj.getJob(P) as never, async (input: RegionASdkInput): Promise<RegionASdkOutput> => {
    calls += 1;
    if (calls === 1) { C = job("조사", `worker:${P}`, "agent"); return { text: "본 턴" } as RegionASdkOutput; }
    harvests.push(input.text);
    if (calls === 2) wj.markDone(C, "끝"); // 남은 자식을 끝내 루프가 닫히게
    return { text: "거두기" } as RegionASdkOutput;
  });
  await until(() => C !== "");
  await sleep(60); // 거두기 대기에 들어간다
  await notify(C, "거두기 대기 중 알림");
  await until(() => wj.getJob(P)?.status !== "running");
  const h = harvests[0] ?? "";
  const pure = harvestTurnText("과제", [{ text: "[작업자 알림 — x] 막힘", raw: "막힘", ts: 1, source: "job", noticeOf: { jobId: "c", noticeId: "n1" } }], [{ text: "지시 본문", raw: "지시", ts: 2 }]);
  out.harvest = {
    rounds: harvests.length, hasBlock: h.includes("〔작업자 알림〕") && h.includes("거두기 대기 중 알림"), noticeHead: h.startsWith("[자식 작업을 기다리는 중 작업자 알림 도착"),
    inInstr: /〔기다리는 중 도착한 지시〕[\s\S]*거두기 대기 중 알림/.test(h), turns: turns.length, events: outcomes(C),
    pureSplit: pure.includes("〔작업자 알림〕\n[작업자 알림 — x] 막힘") && pure.includes("〔기다리는 중 도착한 지시〕\n지시 본문") && !/〔기다리는 중 도착한 지시〕[\s\S]*막힘/.test(pure),
  };
}

// ── 18-5 셸 대기 — 매니저의 BashOutput 대기가 자식 알림으로 **일찍 돌아온다**(셸은 계속) · 사유는 «작업자 알림» ─────────────
{
  reset();
  const P = withChannel(job("셸지휘", S));
  const C = job("조사", `worker:${P}`, "agent");
  type FTools = Record<string, { handler: (a: unknown, e: unknown) => Promise<{ content?: Array<{ text?: string }> }> }>;
  const ft = (createFileOpsMcpServer(process.cwd(), `worker:${P}`) as unknown as { instance: { _registeredTools: FTools } }).instance._registeredTools;
  const call = async (name: string, args: R): Promise<string> => ((await ft[name]!.handler(args, {})).content ?? []).map((c) => c.text ?? "").join("\n");
  const launched = await call("Bash", { command: `"${process.execPath}" -e "setTimeout(()=>{},20000)"`, run_in_background: true });
  const id = /bash_id: ([\w-]+)/.exec(launched)?.[1] ?? "";
  const t0 = Date.now();
  const p = call("BashOutput", { bash_id: id, wait_seconds: 10 });
  await sleep(300);
  await notify(C, "셸 대기 중 알림");
  const txt = await p;
  out.shell = { ms: Date.now() - t0, why: /깨운 이유: 작업자 알림이 들어옴/.test(txt), notInstr: !/새 지시/.test(txt), running: /status: running/.test(txt) };
  killAllBgShells?.();
}

// ── ⑨ 진행 알림 — 미해결은 머리줄 다음 첫 줄 · 답 확정은 없음 · 무관한 지시·실패한 답 뒤에도 실림 · 한 번만 · 요약 프롬프트에 없음 ─────
{
  reset();
  setProgressNoticeSettings({ enabled: true, intervalMinutes: 10 });
  const prompts: string[] = [];
  let hold: Promise<void> | undefined;
  let summarizing = false;
  jp.registerProgressSummarizer(async (prompt) => { prompts.push(prompt); summarizing = true; if (hold !== undefined) await hold; return "요약: 진행 중"; });
  const MIN = 60_000;
  const tool = (key: string, label: string): void => {
    getEventBus().publish({ type: "llm.activity", ts: Date.now(), payload: { threadKey: key, kind: "tool", label, seq: 1 } } as never);
    getEventBus().publish({ type: "llm.activity", ts: Date.now(), payload: { threadKey: key, kind: "tool", phase: "end", label, seq: 1 } } as never);
  };
  const M = withChannel(job("진행매니저", S));
  const t0 = Date.now();
  await notify(M, "미해결 막힘");
  await notify(M, "답받을 막힘");
  wj.getJob(M)!.notices![0]!.at = new Date(2026, 9, 23, 7, 46).getTime(); // 시각 표기 확인용(07:46)
  // n2 에 답(확정) · n1 엔 무관한 지시(답 아님) · n1 에 실패한 답은 아래 별도 작업에서
  const mainSteer = toolsOf(createWorkerMcpServer(mainInput())).steer_worker!.handler;
  await mainSteer({ job_id: M, message: "답", notice_id: "n2" }, {});
  await mainSteer({ job_id: M, message: "무관한 지시" }, {});
  drain(M);
  sent.length = 0;
  tool(`worker:${M}`, "Read");
  wj.__checkinTickForTest(t0 + 11 * MIN);
  await sleep(120);
  const first = sent.slice();
  // 두 번째 주기 — 활동 기록 시각이 첫 알림(가짜 시각 t0+11분) 뒤여야 «새 행동» 으로 센다: 그 동안만 시계를 12분 민다.
  const realNow = Date.now;
  Date.now = () => realNow() + 12 * MIN;
  tool(`worker:${M}`, "Read");
  Date.now = realNow;
  wj.__checkinTickForTest(t0 + 23 * MIN);
  await sleep(120);
  const second = sent.slice(first.length);
  // 전달 실패한 답 뒤에도 실린다 — 채널 없는 작업
  const F = job("진행실패답", S);
  const t1 = Date.now();
  await notify(F, "실패한 답의 막힘");
  await mainSteer({ job_id: F, message: "답", notice_id: "n1" }, {}); // absent
  sent.length = 0;
  tool(`worker:${F}`, "Read");
  wj.__checkinTickForTest(t1 + 11 * MIN);
  await sleep(120);
  const failed = sent.slice();
  // ★요약을 기다리는 사이 답이 도착하면 그 알림은 실리지 않는다(GPT R1 #1 — 미리 골라 두면 «막힘» 으로 나갔다).
  const RG = withChannel(job("진행경합", S));
  const t2 = Date.now();
  await notify(RG, "요약 중 답받는 막힘");
  let release: () => void = () => {};
  hold = new Promise<void>((r) => { release = r; });
  summarizing = false;
  sent.length = 0;
  tool(`worker:${RG}`, "Read");
  wj.__checkinTickForTest(t2 + 11 * MIN);
  await until(() => summarizing);
  await mainSteer({ job_id: RG, message: "답", notice_id: "n1" }, {});
  release();
  hold = undefined;
  await sleep(120);
  const raced = sent.slice();
  const lines = (first[0] ?? "").split("\n");
  out.progress = {
    raced: raced.map((t) => t.slice(0, 200)), racedAnswered: wj.getJob(RG)?.notices?.[0]?.answeredAt !== undefined,
    first: first.map((t) => t.slice(0, 200)), second: second.map((t) => t.slice(0, 200)), failed: failed.map((t) => t.slice(0, 200)),
    lineAfterHead: lines[1] ?? null,
    // 기대 줄은 카탈로그에서 — 러너가 영어로 돌 수 있다(서버 문구는 사용자 언어).
    expectedLine: (await import("../../core/i18n.js")).translate("srv.job.progress.notice", { time: "07:46", text: "미해결 막힘" }),
    answeredShown: first.some((t) => t.includes("답받을 막힘")),
    inPrompt: prompts.some((p) => p.includes("미해결 막힘") || p.includes("막힘(")),
  };
}

for (const ch of channels.values()) ch.close();
out.joinRegistered = joinRegistered;
console.log(JSON.stringify(out));
process.exit(0);
