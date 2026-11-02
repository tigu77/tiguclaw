/**
 * `notice-report-contract` 의 자식 — **보고 기본 생략 계약의 코어 이음매**를 실제 함수로 돌린다(2026-11-01,
 * `docs/decisions/2026-11-01-notify-owner-report-contract.md`). 모델 호출·외부 송신 0(어댑터는 `__setAdapterForTest`, 채널은 가짜 배달).
 *
 *  producer — 코어 `notifyOwner()` 가 세운 알림 턴에만 `reportDefault:"omit"` · 같은 세션의 완료 재주입 턴엔 없다
 *  join     — 허용 턴의 `wait_for_worker` 는 결과를 **보기만** 하고 완료 배달을 보류·정산하지 않는다(재주입 턴 1) · 일반 턴은 넘겨받는다(0)
 *  route    — 라우터가 허용을 입력(`reportOmittable`)으로, 생략 증명을 결과(`reportOmitted`)로 옮긴다 · 허용 없는 메시지면 입력에 없다
 *  fallback — 모델 폴백 안내를 덧붙인 결과에선 생략 증명이 지워진다(`runRegionA`)
 *  decide   — 핸들러 판정(`omitsTurnReport`)·끼워넣기 판정(`turnTakesSteering`)·«내부 처리» 통지 모양
 *  context  — 허용 턴은 사람 턴 몫의 한 번짜리 «직전 질문» 줄을 꺼내지 않는다(다음 사람 턴이 받는다)
 *  persist  — «내부 처리» 통지는 대화 기록 행으로 남고 구조 표식(`data.audience`)을 단다 · 세션 미리보기는 그 행을 건너뛴다 · 같은 문구의 사용자 글·표식 없는 통지는 그대로(2026-11-02)
 * 출력: 마지막 줄 JSON 한 줄.
 */
import { mkdtempSync } from "node:fs";
import path from "node:path";
import { assertIsolated, loadPluginModule } from "./_framework.js";

assertIsolated();
process.env.TIGUCLAW_HOME = mkdtempSync(path.join(process.env.TIGUCLAW_HOME!, "notice-report-core-"));
// ★작업자 알림은 기본 꺼짐이다(2026-11-02 `jobs.notifyOwner.enabled`) — 이 자식은 «켜짐» 동작을 잰다: 임시 홈 설정 파일로 **명시해** 켠다(제품 기본을 덮지 않는다).
(await import("../../core/settings.js")).setNotifyOwnerEnabled(true);
const { initStore } = await import("../../store/sessions.js");
initStore();
const wj = await import("../../core/worker-jobs.js");
const { getEventBus } = await import("../../core/eventbus.js");
const { registerChannelOutbound } = await import("../../core/channel-outbound.js");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type R = Record<string, any>;
const out: R = {};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const CH = "regr-notice-report";
const sent: string[] = [];
registerChannelOutbound(CH, { deliver: async (_t: unknown, text: string) => { sent.push(text); return { messageIds: [1] }; }, defaultOutboundTarget: async () => "c" } as never);
type Msg = { threadKey: string; text: string; turnOrigin?: string; reportDefault?: string; synthetic?: boolean; hasBeforeTurn?: boolean };
const turns: Msg[] = [];
// ── 메인 핸들러 — 진입점과 **같은 함수들**로 조립한다: 들이기(`admitTurn` — 끼워넣기 게이트 → 진짜 직렬 줄 `enqueueThreadTurn` → 차례의 `beforeTurn`)
//  → 턴 입구(`openTurnSteering`) → [모델 결과 — 여기만 가짜] → 마지막 단계(`finishTurnOutput` → `deliverTurnReply` → 실제 `msg.reply`) → 출구(`endTurn`).
//  ★진입점 고유의 것(사본 좌표·제안 설정·로그)만 대역이다 — 사본·제안은 횟수만 센다.
const { admitTurn, openTurnSteering, endTurn } = await import("../../core/entry/turn-lifecycle.js");
const { finishTurnOutput: finishOut, deliverTurnReply } = await import("../../core/entry/reply-command.js");
const { enqueueThreadTurn } = wj;
const steerChans = new Map();
const inflight = new Map<string, object>();
const ctr = { steered: 0, fanOut: 0, suggest: 0, omitted: 0, delivered: 0 };
/** 턴 안에서 기다릴 일(검사가 그 턴을 붙잡아 둘 때) — 대화 키별. */
const holds = new Map<string, Promise<void>>();
/** 가짜 모델 결과 — 알림 턴은 «표시 없이 깨끗한 종료»(생략 증명), 그 밖은 평범한 답. */
const modelOut = (m: Msg & { reportDefault?: string }): R => (m.reportDefault === "omit" ? { text: "내부에서 답했습니다", reportOmitted: true } : { text: `답: ${m.text}` });
const STEERED = Symbol("steered");
const realishHandler = (m: never): Promise<unknown> =>
  admitTurn(m as never, {
    steeringEnabled: true,
    steerable: (x) => x.synthetic !== true,
    channels: steerChans,
    onSteered: () => { ctr.steered += 1; return STEERED; },
    onQueued: () => undefined,
    onSkipped: (x) => { turns.push({ threadKey: x.threadKey, text: "(skipped)", turnOrigin: x.turnOrigin, reportDefault: x.reportDefault }); },
    enqueue: enqueueThreadTurn,
    run: async (msg) => {
      turns.push({ threadKey: msg.threadKey, text: msg.text, turnOrigin: msg.turnOrigin, reportDefault: msg.reportDefault, synthetic: msg.synthetic, hasBeforeTurn: msg.beforeTurn !== undefined } as never);
      const ac = new AbortController();
      const entry = {};
      inflight.set(msg.threadKey, entry);
      const ch = openTurnSteering(msg, steerChans, ac.signal, true);
      try {
        await (holds.get(msg.threadKey) ?? Promise.resolve());
        const out = modelOut(msg as never);
        const fate = await finishOut({
          msg, out, appended: "", bus: getEventBus(),
          deliver: () => deliverTurnReply({ msg, out: out as never, replyText: out.text, bus: getEventBus(), turnMarkable: () => (ch?.pending() ?? 0) === 0, fanOut: async () => { ctr.fanOut += 1; }, suggest: () => { ctr.suggest += 1; } }),
        });
        ctr[fate] += 1;
      } finally {
        endTurn({ msg, entry, inflight, steering: ch, steeringChannels: steerChans, signal: ac.signal, reinject: (x) => realishHandler(x as never) });
      }
    },
  });
wj.__setMainHandlerForTest((m) => realishHandler(m as never) as Promise<void>);
const S = "dashboard:regr-notice-report";
const job = (label: string, threadKey = S): string =>
  wj.registerJob({ label, task: `${label} 지시`, threadKey, channel: CH as never, channelUserId: "u", notifyDest: { channel: CH as never, target: "c" }, kind: "worker", detached: true } as never);

// ── producer ──────────────────────────────────────────────────────────────────
{
  const W = job("잠금 작업");
  const sentBefore = sent.length, omittedBefore = ctr.omitted;
  const ret = wj.notifyOwner(`worker:${W}`, "스튜디오 플레이어가 잠금을 쥐고 있습니다 — 꺼 주면 이어서 합니다");
  await sleep(60);
  const notice = turns.filter((t) => t.turnOrigin === "worker-notice");
  out.noticeTurn = { sentDelta: sent.length - sentBefore, omittedDelta: ctr.omitted - omittedBefore };
  turns.length = 0;
  const C = job("완료 작업");
  await wj.onWorkerComplete(C, { result: "완료 결과 전문" });
  await sleep(30);
  const done = turns.filter((t) => t.turnOrigin === "worker-completion");
  // 무활동 점검 차례(같은 소환자 경로·같은 합성 턴 모양)는 허용 대상이 아니다(사용자 미결 U-B) — 시계를 당겨 한 번 울린다.
  const CK = job("조용한 작업");
  turns.length = 0;
  wj.__checkinTickForTest(Date.now() + 24 * 3600_000);
  await sleep(80);
  const checkins = turns.filter((t) => t.turnOrigin === "worker-checkin");
  void CK;
  out.producer = {
    checkin: checkins.map((t) => ({ rd: t.reportDefault ?? null })),
    ret: ret.slice(0, 80),
    notice: notice.map((t) => ({ rd: t.reportDefault ?? null, synthetic: t.synthetic, hasReportWord: t.text.includes("report_to_user"), noSilence: !t.text.includes("아무 말도 안 해도") })),
    completion: done.map((t) => ({ rd: t.reportDefault ?? null })),
  };
  turns.length = 0;
}

// ── join ──────────────────────────────────────────────────────────────────────
{
  const { createSpawnAgentMcpServer } = await import("../../core/llm-runtime/capabilities/agent-registry.js");
  type ToolResult = { content: Array<{ text?: string }> };
  type Tool = { handler: (a: unknown, extra: unknown) => Promise<ToolResult> };
  const waitOf = (pi: R): Tool =>
    (createSpawnAgentMcpServer(pi as never) as unknown as { instance: { _registeredTools: Record<string, Tool> } }).instance._registeredTools.wait_for_worker!;
  const runJoin = async (omittable: boolean): Promise<R> => {
    turns.length = 0;
    sent.length = 0;
    // ★다른 대화 — 위 producer 의 알림이 S 앞 수신함에 남아 있으면 합류가 그 알림으로 일찍 깬다(기존 계약). 여기선 완료만 본다.
    const J = `dashboard:regr-notice-join-${omittable ? "a" : "b"}`;
    const id = job(omittable ? "허용 턴이 기다린 작업" : "일반 턴이 기다린 작업", J);
    const pi: R = { threadKey: J, channel: CH, text: "", ...(omittable ? { reportOmittable: true } : {}) };
    const p = waitOf(pi).handler({ job_ids: [id], timeout_seconds: 5 }, {});
    await sleep(40);
    const joinedWhileWaiting = wj.isJobJoined(id);
    await wj.onWorkerComplete(id, { result: `결과-${omittable ? "허용" : "일반"}` });
    const r = await p;
    await sleep(40);
    const text = r.content.map((c) => c.text ?? "").join("");
    const { getWorkerJobNotices } = await import("../../store/worker-jobs.js");
    const row = getWorkerJobNotices([id]).get(id);
    return {
      // 재주입 턴에서 핸들러가 실제로 답했는가(이 자식의 핸들러는 허용 없는 메시지에 진짜 핸들러처럼 `msg.reply` 를 부른다) · CRR 전달 상태
      userGot: sent.some((x) => x.includes(`결과-${omittable ? "허용" : "일반"}`)),
      noticeState: row?.noticeState ?? null,
      joinedWhileWaiting,
      sawResult: text.includes(`결과-${omittable ? "허용" : "일반"}`),
      completionTurns: turns.filter((t) => t.turnOrigin === "worker-completion").length,
      text: text.slice(0, 160),
    };
  };
  out.join = { omittable: await runJoin(true), normal: await runJoin(false) };
  turns.length = 0;
}

// ── queue — 진짜 들이기·직렬 줄로: 알림 턴 진행 중 사람 메시지는 끼워지지 않고 새 턴 1(그 턴엔 알림의 표식 없음) · 일반 턴은 끼워짐(양성 대조) · 꼬리 창은 새 턴 ──
{
  const hold = (k: string): (() => void) => { let r!: () => void; holds.set(k, new Promise<void>((res) => { r = res; })); return () => { holds.delete(k); r(); }; };
  const mk = (k: string, text: string, extra: R = {}): never =>
    ({ channel: CH, channelUserId: "u", threadKey: k, text, reply: async (t: string) => { sent.push(`${k}|${t}`); }, ...extra }) as never;
  // ⓪ 차례에 `beforeTurn` 이 사유를 내면(알림을 이미 합류가 가져감 등) 모델 없이 건너뛴다 — 턴 0
  const SK = "dashboard:regr-notice-skip";
  turns.length = 0;
  await realishHandler(mk(SK, "[작업자 알림] 이미 꺼냄", { synthetic: true, turnOrigin: "worker-notice", reportDefault: "omit", beforeTurn: () => "이미 다른 자리로 전달돼 건너뜀" }));
  out.skip = turns.filter((t) => t.threadKey === SK).map((t) => t.text);
  // ① 알림 턴 진행 중
  const Q = "dashboard:regr-notice-queue";
  const outs: R[] = [];
  const unsubQ = getEventBus().subscribe((ev) => { if (ev.type === "channel.message.out" && String((ev.payload as R).threadKey ?? "").startsWith("dashboard:regr-notice-queue")) outs.push(ev.payload as R); });
  const c0 = { ...ctr };
  turns.length = 0;
  const st0 = ctr.steered;
  const relQ = hold(Q);
  const pN = realishHandler(mk(Q, "[작업자 알림] 회귀", { synthetic: true, turnOrigin: "worker-notice", reportDefault: "omit", beforeTurn: () => null }));
  await sleep(30);
  const pH = realishHandler(mk(Q, "사람 질문"));
  await sleep(30);
  const during = { steered: ctr.steered - st0, turns: turns.filter((t) => t.threadKey === Q).length };
  relQ();
  await pN; await pH; await sleep(30);
  const qt = turns.filter((t) => t.threadKey === Q);
  unsubQ?.();
  out.queue = {
    during, order: qt.map((t) => t.turnOrigin ?? "human"),
    // 이 대화 줄의 두 턴 — 알림(생략)·사람(전달): 사본·제안·답 기록은 전달된 턴에만 한 번씩, 통지는 생략된 턴에만
    counts: { delivered: ctr.delivered - c0.delivered, omitted: ctr.omitted - c0.omitted, fanOut: ctr.fanOut - c0.fanOut, suggest: ctr.suggest - c0.suggest,
      outAnswers: outs.filter((x) => x.threadKey === Q && x.notice !== true).length, outNotices: outs.filter((x) => x.threadKey === Q && x.notice === true).length },
    human: qt[1] === undefined ? null : { rd: qt[1].reportDefault ?? null, bt: qt[1].hasBeforeTurn === true },
    humanAnswered: sent.includes(`${Q}|답: 사람 질문`), noticeSent: sent.some((x) => x.startsWith(`${Q}|`) && x.includes("내부에서 답했습니다")),
  };
  // ② 양성 대조 — 일반 턴 진행 중 사람 메시지는 그 턴에 끼워진다(새 턴 아님)
  const P2 = "dashboard:regr-notice-queue-plain";
  const st1 = ctr.steered;
  const relP = hold(P2);
  const pA = realishHandler(mk(P2, "일반 요청"));
  await sleep(30);
  const pB = realishHandler(mk(P2, "끼어든 말"));
  await sleep(30);
  const plainDuring = { steered: ctr.steered - st1, turns: turns.filter((t) => t.threadKey === P2).length, steeredResult: (await Promise.race([pB, sleep(5).then(() => "pending")])) === STEERED };
  relP(); await pA; await sleep(40);
  // ③ 꼬리 창 — 일반 턴이 결과를 받아 통로를 닫은 뒤 온 말은 새 턴
  const P3 = "dashboard:regr-notice-queue-tail";
  const st2 = ctr.steered;
  const relT = hold(P3);
  const pC = realishHandler(mk(P3, "일반 요청"));
  await sleep(30);
  steerChans.get(P3)?.close(); // 결과 수신 = 통로 닫힘(어댑터가 그때 닫는다)
  const pD = realishHandler(mk(P3, "꼬리 창 말"));
  await sleep(20);
  relT(); await pC; await pD; await sleep(20);
  out.tail = { steered: ctr.steered - st2, turns: turns.filter((t) => t.threadKey === P3).map((t) => t.text) };
  out.plain = plainDuring;
}

// ── route · fallback ──────────────────────────────────────────────────────────
{
  const RT = await import("../../core/llm-runtime/index.js");
  const { route } = await import("../../core/router.js");
  const seenInputs: R[] = [];
  const undo = RT.__setAdapterForTest(async (_a, input) => {
    seenInputs.push({ reportOmittable: input.reportOmittable ?? null, turnOrigin: input.turnOrigin ?? null });
    return { text: "내부에서 답했습니다", reportOmitted: true, sessionId: `s-${seenInputs.length}` } as never;
  });
  try {
    const base = { channel: CH, channelUserId: "u", threadKey: "dashboard:regr-notice-route", text: "알림", synthetic: true, reply: async () => undefined } as R;
    const rOmit = await route({ ...base, turnOrigin: "worker-notice", reportDefault: "omit" } as never);
    const rPlain = await route({ ...base, threadKey: "dashboard:regr-notice-route2", turnOrigin: "worker-completion" } as never);
    out.route = { inputs: seenInputs.slice(0, 2), omit: rOmit.reportOmitted ?? null, plain: rPlain.reportOmitted ?? null };
  } catch (e) {
    out.route = { err: String(e).slice(0, 300) };
  } finally {
    undo();
  }
  // 모델 폴백 — 요청 풀은 실패, 다음 풀이 «생략 증명» 을 싣고 성공 → 폴백 안내가 붙고 증명은 지워져야 한다.
  let n = 0;
  const undo2 = RT.__setAdapterForTest(async () => {
    n += 1;
    if (n === 1) throw new Error("회귀: 요청 모델 거부 — 400 model_not_found"); // 구조적 실패(모델 부재)만 다음 풀로 간다
    return { text: "내부에서 답했습니다", reportOmitted: true, sessionId: "s-fb", model: "fallback-model" } as never;
  });
  try {
    const o = await RT.runRegionA(
      { channel: "http-bridge", threadKey: "dashboard:regr-notice-fb", text: "알림", reportOmittable: true } as never,
      { chain: [[{ adapter: "codex-oauth", model: "gpt-requested" } as never], [{ adapter: "codex-oauth", model: "gpt-fallback" } as never]] },
    );
    out.fallback = { omitted: o.reportOmitted ?? null, rejected: o.modelOverrideRejected !== undefined, appended: o.text.length > "내부에서 답했습니다".length, calls: n };
  } catch (e) {
    out.fallback = { err: String(e).slice(0, 300), calls: n };
  } finally {
    undo2();
  }
}

// ── decide ────────────────────────────────────────────────────────────────────
{
  const { omitsTurnReport, publishInternalHandled } = await import("../../core/entry/reply-command.js");
  const { turnTakesSteering } = await import("../../core/entry/turn-lifecycle.js");
  const omit = { reportDefault: "omit" as const };
  out.decide = {
    omit: omitsTurnReport(omit, { reportOmitted: true }, ""),
    noProof: omitsTurnReport(omit, {}, ""),
    noPolicy: omitsTurnReport({}, { reportOmitted: true }, ""),
    hookAppended: omitsTurnReport(omit, { reportOmitted: true }, "훅이 덧붙인 안내"),
    steerNotice: turnTakesSteering({ turnOrigin: "worker-notice", reportDefault: "omit" }),
    steerNoticeNoPolicy: turnTakesSteering({ turnOrigin: "worker-notice" }),
    steerInbound: turnTakesSteering({ turnOrigin: "inbound" }),
    steerFork: turnTakesSteering({ turnOrigin: "fork-carry" }),
  };
  const outs: R[] = [];
  const unsub = getEventBus().subscribe((ev) => { if (ev.type === "channel.message.out") outs.push(ev.payload as R); });
  publishInternalHandled(getEventBus(), { channel: CH, threadKey: S });
  await sleep(10);
  unsub?.();
  out.internalNotice = outs.map((p) => ({ notice: p.notice, unread: p.unread, audience: p.audience ?? null, text: p.text, turn: p.turn ?? null, threadKey: p.threadKey }));

  // 진입점의 마지막 단계 함수를 그대로 — 생략이면 `deliver`(채널 답·기록·사본·제안이 사는 곳) 0회 · 통지 1, 아니면 deliver 1 · 통지 0. 전송 실패는 그대로 던진다(생략으로 안 바뀜).
  const { finishTurnOutput } = await import("../../core/entry/reply-command.js");
  const fin = async (msg: R, o: R, appended: string, throwIt = false): Promise<R> => {
    const got: R[] = [];
    const u = getEventBus().subscribe((ev) => { if (ev.type === "channel.message.out") got.push(ev.payload as R); });
    let delivers = 0;
    let fate: string;
    try {
      fate = await finishTurnOutput({ msg: { channel: CH, threadKey: S, ...msg } as never, out: o, appended, bus: getEventBus(), deliver: async () => { delivers += 1; if (throwIt) throw new Error("전송 실패(회귀)"); } });
    } catch (e) {
      fate = `threw:${String(e).slice(0, 40)}`;
    }
    await sleep(5);
    u?.();
    return { fate, delivers, notices: got.filter((x) => x.notice === true).length };
  };
  out.finish = {
    omitted: await fin({ reportDefault: "omit" }, { reportOmitted: true }, ""),
    marked: await fin({ reportDefault: "omit" }, {}, ""),
    hook: await fin({ reportDefault: "omit" }, { reportOmitted: true }, "훅 안내"),
    completion: await fin({}, { reportOmitted: true }, ""),
    sendFail: await fin({ reportDefault: "omit" }, {}, "", true),
  };

  // 완료 턴 표식의 시점 — 채널 답을 보내는 동안 끼어든 입력이 있으면 표식을 싣지 않는다(판정은 답 뒤 기록 순간).
  {
    const { deliverTurnReply: dtr } = await import("../../core/entry/reply-command.js");
    const { createSteeringChannel, toSteeringInput } = await import("../../core/steering.js");
    const mark = async (arrive: boolean): Promise<R> => {
      const ch = createSteeringChannel();
      const got: R[] = [];
      const u = getEventBus().subscribe((ev) => { if (ev.type === "channel.message.out") got.push(ev.payload as R); });
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      const msg = { channel: CH, threadKey: "dashboard:regr-mark", reply: async () => { await gate; } } as never;
      const p = dtr({ msg, out: { text: "답", turn: { id: "saved-turn" } } as never, replyText: "답", bus: getEventBus(), turnMarkable: () => ch.pending() === 0, fanOut: async () => {}, suggest: () => {} });
      await sleep(5);
      const accepted = arrive ? ch.push(toSteeringInput({ channel: CH, channelUserId: "u", threadKey: "dashboard:regr-mark", text: "보내는 사이 끼어든 말", reply: async () => undefined } as never)) : false;
      release();
      await p;
      u?.();
      return { accepted, turn: got.find((x) => x.notice !== true)?.turn ?? null };
    };
    out.mark = { quiet: await mark(false), interrupted: await mark(true) };
  }

  // 끼워넣기 — 진입점이 쓰는 그 함수들로: 알림 턴은 채널을 안 열고, 그 사이 사람 메시지는 끼워지지 않는다(→ 새 턴) · 일반 턴은 끼워진다(양성 대조) · 끝난 뒤(닫힘)는 새 턴
  const { openTurnSteering, steerIntoTurn } = await import("../../core/entry/turn-lifecycle.js");
  const chans = new Map();
  const human = { channel: CH, channelUserId: "u", threadKey: S, text: "사람이 끼어든 질문", reply: async () => undefined } as never;
  const noticeCh = openTurnSteering({ threadKey: S, turnOrigin: "worker-notice", reportDefault: "omit" }, chans, new AbortController().signal, true);
  const duringNotice = steerIntoTurn(chans, human);
  const normalCh = openTurnSteering({ threadKey: S, turnOrigin: "inbound" }, chans, new AbortController().signal, true);
  const duringNormal = steerIntoTurn(chans, human);
  normalCh?.close();
  const afterClose = steerIntoTurn(chans, human);
  out.steer = { noticeOpened: noticeCh !== undefined, duringNotice, normalOpened: normalCh !== undefined, duringNormal, afterClose };
}

// ── context ───────────────────────────────────────────────────────────────────
{
  const { rememberPendingOptions } = await import("../../core/pending-options.js");
  const { formatConversationContext } = await import("../../core/prompt-assembly.js");
  const T = "dashboard:regr-notice-ctx";
  rememberPendingOptions(T, "배포할까요?", ["예", "아니요"]);
  const internal = formatConversationContext({ channel: "dashboard", threadKey: T, reportOmittable: true });
  const human = formatConversationContext({ channel: "dashboard", threadKey: T });
  const again = formatConversationContext({ channel: "dashboard", threadKey: T });
  out.context = { internalHasAsked: internal.includes("배포할까요?"), humanHasAsked: human.includes("배포할까요?"), againHasAsked: again.includes("배포할까요?") };
}

// ── history(서버 이력 투영) — 영속된 활동 행의 `audience` 가 이력 API 로 그대로 나간다(새로고침 뒤에도 «내부 기록») ─────────────
{
  const { getDb } = await import("../../store/sessions.js");
  // plugins/ 는 리터럴 지정자로 import 하지 않는다(`npm run build` rootDir=src — 회귀 `src-stays-inside-src`). 경로 기준은 `_framework.ts` 자리.
  const { historyActivities } = await loadPluginModule<{ historyActivities: (e: Array<{ ts: number }>, k?: string) => unknown[] }>("../../../plugins/http-bridge/history-activities.js");
  const H = "dashboard:regr-notice-hist";
  const t0 = Date.now() - 5000;
  const ins = getDb().prepare("INSERT INTO events (ts, type, payload) VALUES (?, ?, ?)");
  ins.run(t0 + 1, "llm.activity", JSON.stringify({ channel: "dashboard", threadKey: H, adapter: "codex", seq: 0, kind: "tool", label: "steer_worker", detail: "" }));
  ins.run(t0 + 2, "llm.activity", JSON.stringify({ channel: "dashboard", threadKey: H, adapter: "codex", seq: 1, kind: "text", audience: "internal", label: "text", text: "내부 메모" }));
  ins.run(t0 + 3, "llm.activity", JSON.stringify({ channel: "dashboard", threadKey: H, adapter: "codex", seq: 0, kind: "text", label: "text", text: "보통 답" }));
  const acts = historyActivities([{ ts: t0 }], H) as unknown as R[];
  out.history = acts.filter((a) => a.kind === "text").map((a) => ({ text: a.text, audience: a.audience ?? null }));
}

// ── persist(대화 기록 · 세션 미리보기) — «내부 처리» 통지는 행으로 **남고**(문구 그대로) 구조 표식(`data.audience`)을 단다 · 화면 판정은 그 표식만 본다(2026-11-02 §11) ─────────────
{
  const { startEventPersistence } = await import("../../core/event-persist.js");
  startEventPersistence(getEventBus()); // 진짜 적재 구독자(chat_log) — 데몬과 같은 함수.
  const { publishInternalHandled, publishReplyOut } = await import("../../core/entry/reply-command.js");
  const { getRecentChatLog, isInternalChatEntry } = await import("../../store/chat-log.js");
  const { translate } = await import("../../core/i18n.js");
  const { sessionPreview } = await loadPluginModule<{ sessionPreview: (r: unknown[]) => string | undefined }>("../../../plugins/http-bridge/routes-sessions.js");
  const bus = getEventBus();
  const phrase = translate("srv.notice.handledInternally");
  const userIn = (threadKey: string, text: string): void => bus.publish({ type: "channel.message.in", ts: Date.now(), payload: { channel: "dashboard", threadKey, text } });
  const P1 = "dashboard:regr-persist-1", P2 = "dashboard:regr-persist-2", P3 = "dashboard:regr-persist-3", P4 = "dashboard:regr-persist-4";
  // P1: 사람 → 보통 답 → 내부 처리(맨 끝)
  userIn(P1, "앞 대화"); await sleep(3);
  publishReplyOut(bus, { channel: "dashboard", threadKey: P1, text: "보통 답" }); await sleep(3);
  publishInternalHandled(bus, { channel: "dashboard", threadKey: P1 }); await sleep(3);
  // P2: 내부 처리만 셋(미리보기 창 3건이 전부 내부)
  for (let i = 0; i < 3; i++) { publishInternalHandled(bus, { channel: "dashboard", threadKey: P2 }); await sleep(3); }
  // P3: 내부 처리 → 사용자가 같은 문구를 직접 씀(숨기면 안 된다)
  publishInternalHandled(bus, { channel: "dashboard", threadKey: P3 }); await sleep(3);
  userIn(P3, phrase); await sleep(3);
  // P4: 표식 없는 시스템 통지(옛 통지 행과 같은 모양 — notice 만) 가 맨 끝
  publishReplyOut(bus, { channel: "dashboard", threadKey: P4, text: "보통 답" }); await sleep(3);
  publishReplyOut(bus, { channel: "dashboard", threadKey: P4, text: "스케줄 실패 통지", notice: true }); await sleep(10);
  const rows = (k: string): R[] => getRecentChatLog({ threadKey: k, limit: 50 }) as unknown as R[];
  out.persist = {
    phrase,
    p1: rows(P1).map((r) => ({ role: r.role, text: r.text, notice: r.notice === true, aud: r.data?.audience ?? null, internal: isInternalChatEntry(r as never) })),
    p3: rows(P3).map((r) => ({ role: r.role, text: r.text, notice: r.notice === true, aud: r.data?.audience ?? null, internal: isInternalChatEntry(r as never) })),
    p4: rows(P4).map((r) => ({ role: r.role, text: r.text, notice: r.notice === true, aud: r.data?.audience ?? null, internal: isInternalChatEntry(r as never) })),
    p2count: rows(P2).length,
    // 세션 목록과 같은 창(최근 3건)으로
    preview: Object.fromEntries([P1, P2, P3, P4].map((k, i) => [`p${i + 1}`, sessionPreview(getRecentChatLog({ threadKey: k, limit: 3 })) ?? null])),
  };
}

out.sent = sent.length;
console.log(JSON.stringify(out));
process.exit(0);
