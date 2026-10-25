/**
 * `join-contract-behaves` 의 자식 — 합류 보고 억제 권리의 **경합**을 진짜 부품으로 돌린다(2026-10-23,
 * [설계](../../../docs/decisions/2026-10-23-join-owner-claim-fix.md) §5). 실제 `wait_for_worker` 핸들러(`createSpawnAgentMcpServer`)·
 * 실제 브리지(`adaptClaudeMcpServer` — codex·openai 가 쓰는 신호 없는 callTool)·실제 완료 출구(`onWorkerComplete`)·실제 배달 레지스트리.
 * 메인 핸들러만 대역이다(완료 재주입을 세고 답을 한 번 보낸다 — 안전망 raw 가 안 나가게).
 *
 * ★왜 자식인가: 메인 핸들러·배달 채널을 전역에 건다 — 스위트 프로세스에 걸면 뒤 검사가 그걸 본다.
 * 출력: 마지막 줄 JSON.
 */
import { mkdtempSync } from "node:fs";
import path from "node:path";
import { assertIsolated } from "./_framework.js";

assertIsolated();
process.env.TIGUCLAW_HOME = mkdtempSync(path.join(process.env.TIGUCLAW_HOME!, "join-claim-"));

const { initStore } = await import("../../store/sessions.js");
initStore();
const { registerChannelOutbound } = await import("../../core/channel-outbound.js");
const wj = await import("../../core/worker-jobs.js");
const { createSpawnAgentMcpServer } = await import("../../core/llm-runtime/capabilities/agent-registry.js");
const { adaptClaudeMcpServer } = await import("../../core/llm-runtime/adapters/_mcp-bridge.js");
const { createSteeringChannel } = await import("../../core/steering.js");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const CH = "regr-join";
const sent: string[] = [];
registerChannelOutbound(CH, { deliver: async (_t: unknown, text: string) => { sent.push(text); return { messageIds: [1] }; }, defaultOutboundTarget: async () => "c" } as never);
const reinjected: string[] = [];
let reinjectDelayMs = 0;
wj.__setMainHandlerForTest(async (m) => {
  reinjected.push(m.text);
  if (reinjectDelayMs > 0) await sleep(reinjectDelayMs);
  await m.reply?.("보고");
});

const S = "dashboard:regr-join-s"; // 메인 대화
let seq = 0;
const job = (label: string, threadKey: string, kind: "worker" | "agent" = "worker"): string =>
  wj.registerJob({ label, task: `${label} 지시`, threadKey, channel: CH as never, channelUserId: "u", notifyDest: { channel: CH as never, target: "c" }, kind } as never);
/** 그 라벨의 완료 재주입 수(메인 완료 턴) · raw 통지 수. */
const reinjectOf = (label: string): number => reinjected.filter((t) => t.includes(`"${label}"`) || t.includes(`'${label}'`)).length;
const sentOf = (needle: string): number => sent.filter((t) => t.includes(needle)).length;
type ToolResult = { content: Array<{ text?: string }>; isError?: boolean };
type Handler = (a: unknown, extra: unknown) => Promise<ToolResult>;
const server = (threadKey: string, abortSignal?: AbortSignal) =>
  createSpawnAgentMcpServer({ threadKey, channel: CH, text: "", ...(abortSignal ? { abortSignal } : {}) } as never);
const handlerOf = (threadKey: string, abortSignal?: AbortSignal): Handler =>
  (server(threadKey, abortSignal) as unknown as { instance: { _registeredTools: Record<string, { handler: Handler }> } }).instance._registeredTools.wait_for_worker!.handler;
const waitAs = (threadKey: string, ids: string[], sec: number, o: { abortSignal?: AbortSignal; extraSignal?: AbortSignal } = {}): Promise<ToolResult> =>
  handlerOf(threadKey, o.abortSignal)({ job_ids: ids, timeout_seconds: sec }, o.extraSignal ? { signal: o.extraSignal } : {});
const textOf = (r: ToolResult): string => r.content.map((c) => c.text ?? "").join("");
const done = (id: string, body: string, late: string[] = []) => wj.onWorkerComplete(id, { result: body }, late);
const settle = () => sleep(60); // 떼어 낸 보류 배달(비동기)이 끝날 시간
const out: Record<string, unknown> = {};
// ★권리가 걸릴 때까지 **조건으로, 유한하게** 기다린다(2026-10-23). 핸들러는 `await import` 를 지난 뒤에야 권리를 거는데,
//  종전엔 고정 `sleep(30)` 으로 «이미 걸렸다» 고 가정해 무거운 실행과 겹치면 시나리오 1 이 간헐 빨강이었다(기제 재현됨).
//  시한을 넘기면 그 시나리오 이름이 `notReady` 에 남고 부모 검사가 빨갛게 된다 — 대기를 늘려 실패를 숨기지 않는다.
const notReady: string[] = [];
const ready = async (name: string, cond: () => boolean, ms = 2_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() >= end) { notReady.push(name); return; }
    await sleep(5);
  }
};
const joined = (id: string) => () => wj.isJobJoined(id);
const claimsNow = (): number => wj.__joinStateForTest().claims;

// 1 · 직속 소환자 정상 대기 — 결과 수신 · 재주입 0
{
  const A = job(`정상${++seq}`, S);
  const p = waitAs(S, [A], 5);
  await ready("owner", joined(A));
  await done(A, "본문-정상");
  const r = await p;
  await settle();
  out.owner = { got: textOf(r).includes("본문-정상"), reinject: reinjectOf(`정상${seq}`), state: wj.__joinStateForTest() };
}
// 2 · 무관한 대기자(형제 매니저 좌표) — 결과 수신 · 재주입 1
{
  const A = job(`관찰${++seq}`, S);
  const p = waitAs("worker:sibling", [A], 5);
  await sleep(30);
  const claimedByObserver = wj.isJobJoined(A);
  await done(A, "본문-관찰");
  const r = await p;
  await settle();
  out.observer = { got: textOf(r).includes("본문-관찰"), claimedByObserver, reinject: reinjectOf(`관찰${seq}`), state: wj.__joinStateForTest() };
}
// 3 · 소환자 + 관찰자 — 관찰자 시한·finally 가 소환자 권리를 안 푼다 / 둘 다 기다리는 중 완료도 소환자 인계
{
  const A = job(`동시${++seq}`, S);
  const owner = waitAs(S, [A], 5);
  await ready("ownerAndObserver", joined(A));
  await waitAs("worker:sibling", [A], 1); // 관찰자 시한 초과 → finally
  const stillOwner = wj.isJobJoined(A);
  const obs2 = waitAs("worker:sibling", [A], 5);
  await sleep(30);
  await done(A, "본문-동시");
  const [ro, rs] = await Promise.all([owner, obs2]);
  await settle();
  out.ownerAndObserver = { stillOwner, ownerGot: textOf(ro).includes("본문-동시"), observerGot: textOf(rs).includes("본문-동시"), reinject: reinjectOf(`동시${seq}`), state: wj.__joinStateForTest() };
}
// 4 · 소환자 중첩 대기 — 먼저 끝난 호출(시한)이 나머지 권리를 안 지운다
{
  const A = job(`중첩${++seq}`, S);
  const w2 = waitAs(S, [A], 5);
  await ready("nested", joined(A));
  await waitAs(S, [A], 1);
  const stillJoined = wj.isJobJoined(A);
  await done(A, "본문-중첩");
  const r2 = await w2;
  await settle();
  out.nested = { stillJoined, got: textOf(r2).includes("본문-중첩"), reinject: reinjectOf(`중첩${seq}`), state: wj.__joinStateForTest() };
}
// 5 · 취소된 소환자 대기 — 턴 신호만 / 도구 호출 신호만 / 진입 전 취소 / 둘 다 있는데 도구 호출 쪽만 취소(사냥 구멍)
for (const mode of ["turn", "extra", "pre", "bothExtra"] as const) {
  const label = `취소-${mode}${++seq}`;
  const A = job(label, S);
  const ac = new AbortController();
  const liveTurn = new AbortController(); // bothExtra: 살아 있는 턴 신호
  if (mode === "pre") ac.abort();
  let t0 = Date.now();
  const p = waitAs(S, [A], 5,
    mode === "extra" ? { extraSignal: ac.signal } : mode === "bothExtra" ? { abortSignal: liveTurn.signal, extraSignal: ac.signal } : { abortSignal: ac.signal });
  if (mode === "pre") await sleep(30);
  else await ready(`cancel_${mode}`, joined(A));
  const before = wj.isJobJoined(A);
  if (mode !== "pre") t0 = Date.now(); // 반환 시간은 **취소부터** 잰다(권리 대기 시간을 섞지 않는다)
  ac.abort();
  const afterAbort = wj.isJobJoined(A);
  const r = await p;
  const returnedMs = Date.now() - t0;
  await done(A, "본문-취소");
  await settle();
  out[`cancel_${mode}`] = { before, afterAbort, isError: r.isError === true, returnedMs, reinject: reinjectOf(label), state: wj.__joinStateForTest() };
}
// 6 · 같은 tick abort → 완료(핸들러 finally 전, 고아 핸들러 모사) — 재주입 1(두 번 아님)
{
  const label = `동시틱${++seq}`;
  const A = job(label, S);
  const ac = new AbortController();
  const p = waitAs(S, [A], 5, { abortSignal: ac.signal });
  await ready("sameTick", joined(A));
  ac.abort();
  const c = done(A, "본문-동시틱");
  await Promise.all([p, c]);
  await settle();
  out.sameTick = { reinject: reinjectOf(label), state: wj.__joinStateForTest() };
}
// 7 · R1-1 — [A,B] 중 A 완료(보류) 후 B 대기 중 취소 → A 는 소환자 보고 1, B 는 나중 완료에 1
{
  const la = `묶음A${++seq}`, lb = `묶음B${seq}`;
  const A = job(la, S), B = job(lb, S);
  const ac = new AbortController();
  const p = waitAs(S, [A, B], 5, { abortSignal: ac.signal });
  await ready("partialCancel", joined(A));
  await done(A, "본문-A");
  const parkedMid = wj.__joinStateForTest().parked;
  const reinjectMid = reinjectOf(la);
  ac.abort();
  const r = await p;
  await settle();
  const aAfter = reinjectOf(la);
  await done(B, "본문-B");
  await settle();
  out.partialCancel = { parkedMid, reinjectMid, isError: r.isError === true, a: aAfter, b: reinjectOf(lb), state: wj.__joinStateForTest() };
}
// 8 · R1-2 — 권리가 있는 채 «진행 중» 으로 기록된 작업이 끝나면(보류) 넘겨받지 못한 것 → 해제에 배달 1
{
  const label = `시한기록${++seq}`;
  const A = job(label, S);
  const claim = wj.claimJobJoin(A, S);
  const stillStatus = (await wj.awaitJobOutcome(A, 0))?.status; // 레코드는 같은 객체라 즉시 읽는다
  await done(A, "본문-시한");
  const parked = wj.__joinStateForTest().parked;
  wj.releaseJobJoin(claim, { handedOff: false });
  await settle();
  // 핸들러 쪽: 시한으로 «진행 중» 을 돌려준 뒤 끝나면 소환자 보고가 간다
  const label2 = `시한핸들러${seq}`;
  const A2 = job(label2, S);
  const r = await waitAs(S, [A2], 1);
  await done(A2, "본문-시한2");
  await settle();
  // 핸들러 쪽 틈: [A3,B3] — A3 가 시한으로 «진행 중» 기록된 뒤 B3 를 보는 순간(같은 호출의 finally 전) A3 가 끝난다 → 보류 →
  //  응답엔 «진행 중» 이니 넘겨받지 못한 것 → 해제에 배달 1. B3 의 상태를 두 번째로 읽는 때(첫째는 권리 걸기)에 완료를 끼운다 — 결정적.
  const label3 = `시한틈${seq}`;
  const A3 = job(label3, S), B3 = job(`시한틈B${seq}`, S);
  const recB = wj.getJob(B3)! as unknown as { status: string };
  let reads = 0, real = "running";
  Object.defineProperty(recB, "status", {
    configurable: true,
    get: () => { reads += 1; if (reads === 2) void done(A3, "본문-틈"); return real; },
    set: (v: string) => { real = v; },
  });
  const r3 = await waitAs(S, [A3, B3], 1);
  await settle();
  const gapReinject = reinjectOf(label3);
  const gapSaysRunning = !textOf(r3).includes("본문-틈");
  await done(B3, "본문-틈B");
  await settle();
  out.timedOut = { gapReads: reads >= 2, gapSaysRunning, gapReinject, stillRunning: stillStatus === "running", parked, reinject: reinjectOf(label), handlerSaysRunning: !textOf(r).includes("본문-시한2"), handlerReinject: reinjectOf(label2), state: wj.__joinStateForTest() };
}
// 9 · 이미 끝난 작업 관찰 · 대기자 좌표 없음 — 권리 없음, 다른 권리 영향 없음
{
  const X = job(`끝남${++seq}`, S);
  await done(X, "본문-끝남");
  const Y = job(`다른${seq}`, S);
  const yClaim = wj.claimJobJoin(Y, S);
  const r = await waitAs(S, [X], 1);
  const finishedClaim = wj.claimJobJoin(X, S);
  const noWaiter = [wj.claimJobJoin(Y, undefined), wj.claimJobJoin(Y, "")];
  out.edges = { got: textOf(r).includes("본문-끝남"), finishedClaim: finishedClaim === undefined, noWaiter: noWaiter.every((c) => c === undefined), yStill: wj.isJobJoined(Y) };
  wj.releaseJobJoin(yClaim, { handedOff: false });
  await done(Y, "본문-다른");
  await settle();
}
// 10 · 브리지 경계 — 신호 없는 callTool 로 불러도 턴 신호(클로저)가 닿는다
{
  const label = `브리지${++seq}`;
  const A = job(label, S);
  const ac = new AbortController();
  const bridge = await adaptClaudeMcpServer(server(S, ac.signal), "agents");
  const p = bridge.callTool("wait_for_worker", { job_ids: [A], timeout_seconds: 5 });
  await ready("bridge", joined(A));
  const before = wj.isJobJoined(A);
  const t0 = Date.now(); // 반환 시간은 **취소부터** 잰다
  ac.abort();
  const afterAbort = wj.isJobJoined(A);
  await p;
  const returnedMs = Date.now() - t0;
  await done(A, "본문-브리지");
  await settle();
  await (bridge as unknown as { close?: () => Promise<void> }).close?.();
  out.bridge = { before, afterAbort, returnedMs, reinject: reinjectOf(label), state: wj.__joinStateForTest() };
}
// 11 · 늦은 지시 — 넘겨받음 · 못 넘겨받음(메인 재주입 / 실패 raw / 결과 수신함)
{
  const LATE = ["늦은지시-정확히"];
  // 넘겨받음 → 늦은 지시 별도 통지 1
  const la = `늦은인계${++seq}`;
  const A = job(la, S);
  const p = waitAs(S, [A], 5);
  await ready("late.handed", joined(A));
  await done(A, "본문", LATE);
  await p;
  await settle();
  const handedLate = sentOf(la) ;
  // 못 넘겨받음 + done(소환자 = 세션) → 완료 턴에 실림 · 별도 통지 0
  const lb = `늦은재주입${seq}`;
  const B = job(lb, S);
  const acB = new AbortController();
  const pb = waitAs(S, [B], 5, { abortSignal: acB.signal });
  await ready("late.reinject", joined(B));
  await done(B, "본문", LATE);
  acB.abort();
  await pb;
  await settle();
  const carriedInTurn = reinjected.some((t) => t.includes(`"${lb}"`) && t.includes(LATE[0]!));
  // 못 넘겨받음 + 실패 → raw 1 · 늦은 지시 별도 1
  const lc = `늦은실패${seq}`;
  const C = job(lc, S);
  const acC = new AbortController();
  const pc = waitAs(S, [C], 5, { abortSignal: acC.signal });
  await ready("late.failed", joined(C));
  await wj.onWorkerComplete(C, { error: "실패원인" }, LATE);
  acC.abort();
  await pc;
  await settle();
  // 못 넘겨받음 + 소환자 = 돌고 있는 매니저(결과 수신함) → 수신함 1 · 늦은 지시 별도 1
  const M = job(`매니저${seq}`, S);
  const box = createSteeringChannel();
  wj.setJobResultChannel(M, box);
  const ld = `늦은수신함${seq}`;
  const D = job(ld, `worker:${M}`, "agent");
  const acD = new AbortController();
  const pd = waitAs(`worker:${M}`, [D], 5, { abortSignal: acD.signal });
  await ready("late.inbox", joined(D));
  await done(D, "본문", LATE);
  const inboxMid = box.drain().length;
  acD.abort();
  await pd;
  await settle();
  const inbox = box.drain().length;
  wj.clearJobResultChannel(M);
  out.late = {
    handed: { lateNotices: handedLate, reinject: reinjectOf(la) },
    reinjectPath: { carriedInTurn, separate: sentOf(lb) },
    failedPath: { raw: sent.filter((t) => t.includes(lc) && t.includes("실패원인")).length, separate: sent.filter((t) => t.includes(lc) && t.includes(LATE[0]!)).length },
    inboxPath: { inboxMid, inbox, separate: sentOf(ld) },
    state: wj.__joinStateForTest(),
  };
}
// 12 · 같은 소환자 T1·T2 중 T1 만 취소 → T1 finally 전 완료(보류) → T1 해제가 T2 를 안 지움 → T2 인계
{
  const label = `한쪽취소${++seq}`;
  const A = job(label, S);
  const ac1 = new AbortController();
  const base = claimsNow();
  const w1 = waitAs(S, [A], 5, { abortSignal: ac1.signal });
  const w2 = waitAs(S, [A], 5);
  await ready("oneCancelled", () => claimsNow() >= base + 2); // T1·T2 둘 다
  ac1.abort();
  const c = done(A, "본문-T2");
  const parkedAfterComplete = wj.__joinStateForTest().parked;
  await w1;
  const stillJoined = wj.isJobJoined(A);
  const r2 = await w2;
  await c;
  await settle();
  out.oneCancelled = { parkedAfterComplete, stillJoined, t2Got: textOf(r2).includes("본문-T2"), reinject: reinjectOf(label), state: wj.__joinStateForTest() };
}
// 13 · 보류 닫기는 정확히 한 번 — T1·T2 둘 다 취소 · 메인 핸들러 지연 · 두 finally 가 겹친다
{
  const label = `한번${++seq}`;
  const A = job(label, S);
  const ac1 = new AbortController(), ac2 = new AbortController();
  const base = claimsNow();
  const w1 = waitAs(S, [A], 5, { abortSignal: ac1.signal });
  const w2 = waitAs(S, [A], 5, { abortSignal: ac2.signal });
  await ready("exactlyOnce", () => claimsNow() >= base + 2);
  reinjectDelayMs = 200;
  const c = done(A, "본문-한번", ["늦은지시-한번"]);
  ac1.abort();
  ac2.abort();
  await Promise.all([w1, w2, c]);
  await sleep(400);
  reinjectDelayMs = 0;
  out.exactlyOnce = { reinject: reinjectOf(label), lateCarried: reinjected.filter((t) => t.includes(`"${label}"`) && t.includes("늦은지시-한번")).length, lateSeparate: sentOf(label), state: wj.__joinStateForTest() };
}
// 14 · 보류 중 잡이 맵에서 빠져도(보관 상한 정리) 배달 1
{
  const label = `정리됨${++seq}`;
  const A = job(label, S);
  const ac = new AbortController();
  const p = waitAs(S, [A], 5, { abortSignal: ac.signal });
  await ready("pruned", joined(A));
  const c = done(A, "본문-정리");
  wj.__forgetJobForTest(A);
  ac.abort();
  await Promise.all([p, c]);
  await settle();
  out.pruned = { reinject: reinjectOf(label), state: wj.__joinStateForTest() };
}

// 15 · 핸들러 예외 — [A,B] 중 A 완료(보류·수집) 뒤 B 를 보다 예외 → 오류 응답 · A 보고 1 · B 는 나중 완료에 1 · 잔류 0
{
  const la = `예외A${++seq}`, lb = `예외B${seq}`;
  const A = job(la, S), B = job(lb, S);
  const recB = wj.getJob(B)! as unknown as { status: string };
  // A 완료가 끝난 **뒤에** 켜고 한 번만 터진다(완료 경로의 보관 정리도 모든 잡 상태를 훑는다 — 거기서 터지면 다른 것을 잰다).
  let armed = false, fired = false;
  Object.defineProperty(recB, "status", {
    configurable: true,
    get: () => { if (armed && !fired) { fired = true; throw new Error("주입된 핸들러 예외"); } return "running"; },
    set: () => {},
  });
  const p = waitAs(S, [A, B], 5);
  await ready("handlerThrows", joined(A));
  await done(A, "본문-예외A");
  armed = true;
  const r = await p;
  await settle();
  Object.defineProperty(recB, "status", { configurable: true, writable: true, value: "running" });
  const aReinject = reinjectOf(la);
  await done(B, "본문-예외B");
  await settle();
  out.handlerThrows = { fired, isError: r.isError === true, threw: textOf(r).includes("주입된 핸들러 예외"), a: aReinject, b: reinjectOf(lb), state: wj.__joinStateForTest() };
}
// 16 · 먼저 넘겨받은 호출(T1 [A]) 뒤 같은 소환자의 다른 호출(T2 [A,B])이 B 를 기다리다 취소 → A 는 이미 넘겨받음: 보고 0 · B 는 나중에 1
{
  const la = `먼저인계A${++seq}`, lb = `먼저인계B${seq}`;
  const A = job(la, S), B = job(lb, S);
  const ac2 = new AbortController();
  const base = claimsNow();
  const t1 = waitAs(S, [A], 5);
  const t2 = waitAs(S, [A, B], 5, { abortSignal: ac2.signal });
  await ready("handedThenCancelled", () => claimsNow() >= base + 3); // T1[A] · T2[A,B]
  await done(A, "본문-먼저");
  const r1 = await t1;
  const parkedAfterT1 = wj.__joinStateForTest().parked;
  await sleep(250); // T2 가 A 를 거두고 B 를 기다리는 중
  ac2.abort();
  const r2 = await t2;
  await settle();
  const aReinject = reinjectOf(la);
  await done(B, "본문-먼저B");
  await settle();
  out.handedThenCancelled = { t1Got: textOf(r1).includes("본문-먼저"), parkedAfterT1, t2Error: r2.isError === true, a: aReinject, b: reinjectOf(lb), state: wj.__joinStateForTest() };
}

out.notReady = notReady;
console.log(JSON.stringify(out));
process.exit(0);
