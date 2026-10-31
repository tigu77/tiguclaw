/**
 * `completion-report-recovery` 의 자식 — 완료 보고 복구(2026-10-31 설계 §11 증분 2~4)를 **진짜 부품**으로 돌린다: 작업 레지스트리(`onWorkerComplete`·
 * `recoverInterruptedJobs`)·저장소(이주 포함)·조회 도구 핸들러(`read_worker_result`·`list_workers`)·대시보드 단건 라우트·발송 통로(`deliverOutbound`)·
 * 회수 입구(`recoverUndeliveredNotices`)·한도 재개 저장소·대화 기록 영속. 채널만 가짜 전송기다(실제 발송 0 · 모델 호출 0).
 *
 * ★재시작은 **진짜 프로세스 경계**다 — 같은 하위 홈(`CRR_HOME`)을 단계마다 새 프로세스가 연다. 메모리 잡이 비어 있는 상태에서 읽힌다.
 * ★«발송 도중 종료» 는 보내는 promise 가 안 끝난 채 `process.exit` 한다(강제 종료와 같은 효과 — finally·정리 안 돈다).
 * 출력: 마지막 줄 JSON.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assertIsolated, loadPluginModule } from "./_framework.js";

assertIsolated();
const phase = process.argv[2] ?? "";
const home = process.env.CRR_HOME ?? "";
if (!/tiguclaw-regression-/.test(home)) throw new Error(`격리 하위 홈이 아니다: ${home}`);
process.env.TIGUCLAW_HOME = home;
process.env.DATA_DIR = path.join(home, "data"); // 명시 — 레거시 이주(./data) 경로를 타지 않는다.
mkdirSync(process.env.DATA_DIR, { recursive: true });
if (!existsSync(path.join(home, "settings.json"))) writeFileSync(path.join(home, "settings.json"), JSON.stringify({ locale: "ko" }));

const out: Record<string, unknown> = {};
const logs: string[] = [];
for (const k of ["log", "warn", "error"] as const) {
  const orig = console[k].bind(console);
  console[k] = (...a: unknown[]) => {
    logs.push(a.map(String).join(" "));
    orig(...a);
  };
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 5000): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(10);
  }
  return cond();
};
/** 결과 JSON 을 **다 비운 뒤** 종료 — 파이프에 큰 글을 쓰고 곧바로 `process.exit` 하면 잘린다(25만 자 원문 두 개). */
const emitAndExit = (): Promise<never> => {
  process.stdout.write(`\n${JSON.stringify(out)}\n`, () => process.exit(0));
  return new Promise<never>(() => {}); // 종료까지 아래로 흘러가지 않는다
};
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

// ── 구버전 스키마(이번 판 이전의 worker_jobs)를 **먼저** 만든다 — persist-a 만 ───────────────────────────
if (phase === "persist-a") {
  const Database = (await import("better-sqlite3")).default;
  const db = new Database(path.join(process.env.DATA_DIR, "tiguclaw.db"));
  db.exec(`CREATE TABLE worker_jobs (job_id TEXT PRIMARY KEY, label TEXT NOT NULL, thread_key TEXT NOT NULL, channel TEXT NOT NULL,
    channel_user_id TEXT NOT NULL, status TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER,
    notify_channel TEXT, notify_target TEXT, kind TEXT NOT NULL DEFAULT 'worker', agent_name TEXT, detached INTEGER NOT NULL DEFAULT 0)`);
  const ins = db.prepare(`INSERT INTO worker_jobs (job_id,label,thread_key,channel,channel_user_id,status,started_at,finished_at,detached) VALUES (?,?,?,?,?,?,?,?,1)`);
  ins.run("legacy-done", "옛 완료", "dashboard:crr-p", "http-bridge", "u", "done", 1000, 2000);
  ins.run("legacy-failed", "옛 실패", "dashboard:crr-p", "http-bridge", "u", "failed", 1000, 2000);
  db.close();
}

const sessions = await import("../../store/sessions.js");
sessions.initStore();
const wj = await import("../../core/worker-jobs.js");
const store = await import("../../store/worker-jobs.js");
const delivery = await import("../../core/job-report-delivery.js");
const { registerChannelOutbound } = await import("../../core/channel-outbound.js");
const { getEventBus } = await import("../../core/eventbus.js");
const { createSpawnAgentMcpServer } = await import("../../core/llm-runtime/capabilities/agent-registry.js");
const { createWorkerMcpServer } = await import("../../core/llm-runtime/capabilities/worker-registry.js");

type ToolReg = { handler: (args: unknown, extra: unknown) => Promise<{ content: Array<{ type: string; text?: string }> }> };
const toolOf = (srv: unknown, name: string): ToolReg => {
  const t = (srv as { instance: { _registeredTools: Record<string, ToolReg> } }).instance._registeredTools[name];
  if (t === undefined) throw new Error(`도구 없음: ${name}`);
  return t;
};
const textOf = (r: { content: Array<{ type: string; text?: string }> }): string => r.content.map((c) => c.text ?? "").join("\n");
const readTool = (fromSession: string): ToolReg =>
  toolOf(createSpawnAgentMcpServer({ text: "x", threadKey: fromSession, channel: "http-bridge" } as never), "read_worker_result");
const read = async (fromSession: string, args: Record<string, unknown>): Promise<string> => textOf(await readTool(fromSession).handler(args, {}));
const listWorkers = async (session: string): Promise<string> =>
  textOf(await toolOf(createWorkerMcpServer({ text: "x", threadKey: session, channel: "http-bridge" } as never), "list_workers").handler({}, {}));
const dashOne = async (jobId: string): Promise<Record<string, unknown>> => {
  // ★리터럴 지정자로 plugins/ 를 import 하지 않는다(`src-stays-inside-src` — rootDir=src 빌드가 죽는다). 공용 우회 `loadPluginModule`.
  const { handleWorkerJobs } = await loadPluginModule<{ handleWorkerJobs: (ctx: never) => Promise<void> }>("../../../plugins/http-bridge/routes-work.js");
  let body = "";
  const res = { writeHead: () => res, end: (b: string) => { body = b; } };
  await handleWorkerJobs({ url: new URL(`http://x/api/worker-jobs?jobId=${encodeURIComponent(jobId)}`), res } as never);
  return JSON.parse(body) as Record<string, unknown>;
};
const row = (id: string): ReturnType<typeof store.getWorkerJobRow> => store.getWorkerJobRow(id);
const live = (k: string): void =>
  sessions.saveSession({ channel: "http-bridge", threadKey: k, claudeSessionId: `crr-${k}`, model: null, systemPromptHash: null } as never);

// ── 가짜 채널 — 텔레그램(물리 발송) · 대시보드(관측 전용) ───────────────────────────────────────────────
type Mode = "ok" | "fail" | "hang" | "gate" | "partial" | "readonly";
let tgMode: Mode = "ok";
let gate: (() => void) | undefined;
let mid = 100;
const tgSends: Array<{ target: string | null; text: string; ok: boolean; labelSession?: string }> = [];
registerChannelOutbound("telegram", {
  deliver: async (target: string | null, text: string, opts?: { labelSession?: string }) => {
    const m = tgMode;
    if (m === "hang") {
      tgSends.push({ target, text, ok: false });
      await new Promise<void>(() => {}); // 영원히 — 이 단계는 발송 도중 종료한다.
    }
    if (m === "gate") {
      await new Promise<void>((r) => { gate = r; });
    }
    if (m === "partial") {
      // 앞 청크는 갔고 뒤 청크가 끝내 실패 — 채널 계약(`throwOnFail`)대로 던진다.
      tgSends.push({ target, text: text.slice(0, 20), ok: true });
      throw new Error("chunk 2/2 failed (synthetic)");
    }
    if (m === "readonly") {
      // 발송은 성공시키고, 그 직후의 상태 기록을 실패시킨다(DB 쓰기 금지).
      sessions.getDb().pragma("query_only = 1");
    }
    const ok = m !== "fail";
    tgSends.push({ target, text, ok, ...(opts?.labelSession !== undefined ? { labelSession: opts.labelSession } : {}) });
    if (!ok) throw new TypeError("fetch failed (synthetic transport)");
    mid += 1;
    return { messageIds: [mid] };
  },
  defaultOutboundTarget: async () => "999",
} as never);
registerChannelOutbound("http-bridge", {} as never);
registerChannelOutbound("fake-nodest", { deliver: async () => ({ messageIds: [1] }) } as never);
const observed: Array<{ threadKey: string; text: string }> = [];
getEventBus().subscribe((e: { type: string; payload?: unknown }) => {
  if (e.type === "channel.message.out") {
    const p = e.payload as { threadKey: string; text: string };
    observed.push({ threadKey: p.threadKey, text: p.text });
  }
});
const msgFrom = (channel: string, session: string, address?: string) => {
  const replies: string[] = [];
  return {
    msg: {
      channel,
      channelUserId: "u",
      threadKey: session,
      text: "결과 어떻게 됐어?",
      ...(address !== undefined ? { channelAddress: address } : {}),
      session: { explicitSessionId: session, ...(address !== undefined ? { channelAddress: address } : {}) },
      reply: async (t: string) => { replies.push(t); },
    },
    replies,
  };
};
const recover = (channel: string, session: string, address?: string) => {
  const m = msgFrom(channel, session, address);
  return { p: delivery.recoverUndeliveredNotices(m.msg), replies: m.replies };
};

const S = "dashboard:crr-s"; // 사람 대화(살아 있음)
const mk = (label: string, threadKey: string, extra: Record<string, unknown> = {}): string =>
  wj.registerJob({ kind: "worker", label, task: `${label} 임무`, threadKey, channel: "http-bridge", channelUserId: "u", ...extra } as never);
const TG = { notifyDest: { channel: "telegram", target: "111" } };

// ════════════════════════════════════════════════════════════════════════════════════════════════════
if (phase === "persist-a") {
  const P = "dashboard:crr-p";
  const ids: Record<string, string> = {};
  ids.D = mk("이모지완료", P);
  wj.markDone(ids.D, "결과 ✅ 이모지 포함 🎉 끝");
  ids.F1 = mk("마무리실패", P);
  wj.markFailed(ids.F1, "fetch failed", "TypeError", "[F1 본 보고] 완성됨");
  ids.F0 = mk("그냥실패", P);
  wj.markFailed(ids.F0, "plain failure");
  ids.C = mk("취소", P);
  wj.markCancelled(ids.C, "사용자 요청");
  ids.BIG = mk("큰결과", P);
  // 상한(256,000) 바로 앞 자리(255,999)가 이모지(서로게이트 쌍)의 앞 단위다.
  wj.markDone(ids.BIG, `${"a".repeat(255_999)}😀b`);
  ids.BIGERR = mk("큰오류", P);
  wj.markFailed(ids.BIGERR, `${"e".repeat(299_999)}😀`);
  out.ids = ids;
  out.capLogs = logs.filter((l) => l.includes("저장 상한 초과")).length;
  const r = row(ids.D);
  out.doneRowHasText = r?.resultText === "결과 ✅ 이모지 포함 🎉 끝"; // REPLACE 로 날아갔으면 비었다
}

if (phase === "persist-b") {
  const P = "dashboard:crr-p";
  const ids = JSON.parse(process.env.CRR_IDS ?? "{}") as Record<string, string>;
  out.memEmpty = wj.getJob(ids.D!) === undefined;
  out.readD = await read(P, { job_id: ids.D });
  out.readF1 = await read(P, { job_id: ids.F1 });
  out.readF0 = await read(P, { job_id: ids.F0 });
  out.readC = await read(P, { job_id: ids.C });
  out.readBIG = (await read(P, { job_id: ids.BIG })).slice(0, 300);
  out.readBIGERR = (await read(P, { job_id: ids.BIGERR })).slice(0, 200) + "…" + (await read(P, { job_id: ids.BIGERR })).slice(-200);
  out.readLegacyDone = await read(P, { job_id: "legacy-done" });
  out.readLegacyFailed = await read(P, { job_id: "legacy-failed" });
  out.readUnknown = await read(P, { job_id: "no-such-id" });
  out.list = await read(P, {});
  out.listWorkers = await listWorkers(P);
  const big = wj.getJobForRead(ids.BIG!);
  out.big = { len: big?.result?.length, capped: big?.resultCapped, lone: LONE.test(big?.result ?? ""), endsA: big?.result?.endsWith("a") };
  const bigErr = wj.getJobForRead(ids.BIGERR!);
  out.bigErr = { len: bigErr?.error?.length, capped: bigErr?.errorCapped, lone: LONE.test(bigErr?.error ?? "") };
  const d = wj.getJobForRead(ids.D!);
  out.emoji = { capped: d?.resultCapped, result: d?.result };
  out.dashF1 = await dashOne(ids.F1!);
  out.dashLegacy = await dashOne("legacy-done");
  out.dashBIG = await dashOne(ids.BIG!);
  out.dashBIGERR = await dashOne(ids.BIGERR!);
  // 보관 상한 정리 — 미전달 행이 상한 밖으로 나가면 상태별로 센다.
  sessions.getDb().prepare(`UPDATE worker_jobs SET notice_state='undelivered', notice_session=? WHERE job_id=?`).run(P, ids.F0);
  sessions.getDb().prepare(`UPDATE worker_jobs SET finished_at = 1 WHERE job_id=?`).run(ids.F0); // 가장 오래된 행
  const before = logs.length;
  for (let i = 0; i < 1001; i += 1) wj.markDone(mk(`채움${i}`, "dashboard:crr-fill"), "x");
  out.pruneLog = logs.slice(before).filter((l) => l.includes("전달 미확인 통지가 보관 상한 밖으로")).slice(0, 2);
  out.f0Gone = row(ids.F0!) === undefined;
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════
if (phase === "delivery-a") {
  for (const k of [S, "dashboard:crr-arch", "dashboard:crr-s2", "dashboard:crr-s3", "dashboard:crr-s4", "dashboard:crr-s5", "dashboard:crr-s6", "dashboard:crr-s7", "dashboard:crr-s8", "dashboard:crr-s9"]) live(k);
  // 재주입 턴은 모델이 죽은 것처럼 던진다 — done·cancelled 는 안전망으로 간다.
  wj.registerWorkerHandler((async () => { throw new TypeError("fetch failed (synthetic model)"); }) as never);
  const ids: Record<string, string> = {};
  const fail = async (label: string, threadKey: string, extra: Record<string, unknown> = TG, error = "fetch failed"): Promise<string> => {
    const id = mk(label, threadKey, extra);
    await wj.onWorkerComplete(id, { error });
    return id;
  };
  tgMode = "fail";
  ids.A = await fail("A실패", S);
  ids.K = await fail("K실패", S);
  // done — 재주입 실패 → 안전망도 실패
  ids.G = mk("G완료", S, TG);
  await wj.onWorkerComplete(ids.G, { result: "[G 결과 전문]" });
  ids.C = await fail("C스케줄", "scheduler:7");
  ids.ARCH = await fail("보관대화", "dashboard:crr-arch");
  ids.S2 = await fail("S2", "dashboard:crr-s2");
  ids.S3 = await fail("S3", "dashboard:crr-s3");
  ids.S4 = await fail("S4", "dashboard:crr-s4");
  ids.S5 = await fail("S5", "dashboard:crr-s5");
  ids.L1 = await fail("한도대기", "dashboard:crr-s6", TG, "429 usage limit reached — rate limit");
  ids.L2 = await fail("한도진행", "dashboard:crr-s6", TG, "429 usage limit reached — rate limit");
  ids.L3 = await fail("한도없음", "dashboard:crr-s6", TG, "429 usage limit reached — rate limit");
  ids.L4 = await fail("한도옮김", "dashboard:crr-s6", TG, "429 usage limit reached — rate limit");
  ids.S7 = await fail("S7", "dashboard:crr-s7");
  ids.S8 = await fail("S8", "dashboard:crr-s8");
  ids.S9a = await fail("S9a", "dashboard:crr-s9");
  // 성공 → delivered
  tgMode = "ok";
  ids.B = await fail("B성공", S);
  out.firstTarget = tgSends.filter((s) => s.ok).map((s) => s.target); // 첫 통지 좌표 = 종전 그대로(destForJob)
  // 정상 경로 — NULL 이어야 한다.
  {
    const parent = mk("부모", S, TG);
    wj.setJobResultChannel(parent, (await import("../../core/steering.js")).createSteeringChannel());
    ids.childBox = mk("결과함자식", `worker:${parent}`, { detached: true });
    await wj.onWorkerComplete(ids.childBox, { result: "자식 결과" });
    const gone = mk("끝난부모", S, TG);
    wj.markDone(gone, "끝");
    ids.cascade = mk("연쇄취소", `worker:${gone}`, { detached: true });
    wj.markCancelled(ids.cascade, "상위 작업이 취소됨");
    await wj.onWorkerComplete(ids.cascade, { error: "cancelled" });
    ids.joined = mk("합류", `worker:${parent}`, { detached: true });
    const claim = wj.claimJobJoin(ids.joined, `worker:${parent}`);
    await wj.onWorkerComplete(ids.joined, { result: "합류 결과" });
    wj.releaseJobJoin(claim, { handedOff: true });
    await sleep(50);
    wj.markDone(parent, "끝"); // 아래 재시작 복구가 «도는 중» 으로 잡지 않게(이 프로세스의 진짜 running 행이다)
  }
  // 재시작 중단 통지 — 이전 프로세스의 running 행
  tgMode = "fail";
  ids.H = "crr-interrupted";
  store.upsertWorkerJob({ jobId: ids.H, label: "중단작업", threadKey: S, channel: "http-bridge", channelUserId: "u", status: "running", startedAt: Date.now() - 5000, notifyDest: { channel: "telegram", target: "111" }, kind: "worker", detached: true });
  await wj.recoverInterruptedJobs();
  sessions.setThreadArchived("dashboard:crr-arch", Date.now());
  out.ids = ids;
  out.states = Object.fromEntries(Object.entries(ids).map(([k, id]) => [k, { state: row(id)?.noticeState ?? null, session: row(id)?.noticeSession ?? null, status: row(id)?.status }]));
  // 마지막 — 첫 통지가 보내는 도중 종료(J): sending 으로 남긴다.
  tgMode = "hang";
  ids.J = mk("J보내다끊김", S, TG);
  void wj.onWorkerComplete(ids.J, { error: "fetch failed" });
  await until(() => tgSends.some((s) => s.text.includes("J보내다끊김")));
  out.jState = row(ids.J)?.noticeState;
  out.ids = ids;
  await emitAndExit(); // ★발송 도중 종료 — 정리 없이(출력만 다 비운 뒤).
}

if (phase === "delivery-b") {
  const ids = JSON.parse(process.env.CRR_IDS ?? "{}") as Record<string, string>;
  const { startEventPersistence } = await import("../../core/event-persist.js");
  startEventPersistence(getEventBus());
  delivery.reconcileNoticeStatesAtBoot(); // 부팅 잔여 정리(채널 시작 전 자리)
  wj.registerWorkerHandler((async () => { throw new TypeError("fetch failed (synthetic model)"); }) as never);
  out.jAfterBoot = row(ids.J!)?.noticeState;
  out.memEmpty = wj.getJob(ids.A!) === undefined;

  // ── 조회 도구 출력(§4-3) — 재시작 뒤 · 다른 대화에서 단건 ───────────────────────────────────────
  out.readA = await read(S, { job_id: ids.A });
  out.readAOther = await read("dashboard:crr-other", { job_id: ids.A });
  out.readARCH = await read("dashboard:crr-arch", { job_id: ids.ARCH });
  out.readC = await read("scheduler:7", { job_id: ids.C });
  out.readB = await read(S, { job_id: ids.B });
  out.readChild = await read(S, { job_id: ids.childBox });
  out.listS = await read(S, {});
  out.listWorkersS = await listWorkers(S);
  out.dashA = (await dashOne(ids.A!)).notice;
  out.dashC = (await dashOne(ids.C!)).notice;

  // ── 회수 — 다른 세션 · 목적지 미확정 · 보관 ─────────────────────────────────────────────────────────
  const attemptsOf = (id: string): number => row(id)?.noticeAttempts ?? -1;
  out.otherSession = { p: recover("http-bridge", "dashboard:crr-other", "dashboard:crr-other").p === undefined, aAttempts: attemptsOf(ids.A!) };
  out.unregistered = { p: recover("no-such-channel", S, "x").p === undefined, aAttempts: attemptsOf(ids.A!) };
  const tgBefore = tgSends.length;
  out.noAddress = { p: recover("fake-nodest", S).p === undefined, aAttempts: attemptsOf(ids.A!), tgDelta: tgSends.length - tgBefore };
  out.archived = { p: recover("http-bridge", "dashboard:crr-arch", "dashboard:crr-arch").p === undefined, attempts: attemptsOf(ids.ARCH!) };
  sessions.setThreadArchived("dashboard:crr-arch", null);
  {
    const r = recover("http-bridge", "dashboard:crr-arch", "dashboard:crr-arch");
    await r.p;
    out.unarchived = { state: row(ids.ARCH!)?.noticeState, attempts: attemptsOf(ids.ARCH!) };
  }
  // 스케줄 소유 — 어느 메시지로도 안 된다(세션 NULL).
  out.schedOwned = { p: recover("http-bridge", "scheduler:7", "scheduler:7").p === undefined, state: row(ids.C!)?.noticeState };

  // ── ⑩ 대시보드 메시지가 텔레그램 소유 작업을 회수 — 5건 중 3건 · 관측 · 대화 기록 · 텔레그램 0 ───────
  {
    const tg0 = tgSends.length;
    const ob0 = observed.length;
    const r = recover("http-bridge", S, S);
    const { formatConversationContext } = await import("../../core/prompt-assembly.js");
    out.line = formatConversationContext({ channel: "http-bridge", threadKey: S });
    out.lineAgain = formatConversationContext({ channel: "http-bridge", threadKey: S });
    await r.p;
    const sent = observed.slice(ob0).filter((o) => o.threadKey === S);
    out.dash = {
      tgDelta: tgSends.length - tg0,
      observed: sent.length,
      texts: sent.map((o) => o.text.slice(0, 400)),
      replies: r.replies.length,
      states: [ids.A, ids.K, ids.G, ids.H, ids.J, ids.B].map((id) => `${row(id!)?.noticeState}/${row(id!)?.noticeAttempts}`),
    };
    await sleep(100);
    const chat = sessions.getDb().prepare(`SELECT COUNT(*) AS n FROM chat_log WHERE thread_key = ? AND text LIKE '↻%'`).get(S) as { n: number };
    out.chatRows = chat.n;
  }
  // ── ⑩' 텔레그램 답글 메시지(같은 세션) — 그 chatId 로 · 세션 라벨 · 답장 매핑 ─────────────────────────
  {
    tgMode = "ok";
    const tg0 = tgSends.length;
    const r = recover("telegram", S, "222");
    await r.p;
    const sent = tgSends.slice(tg0);
    const { findSessionForOutboundMessage } = await import("../../store/outbound-messages.js");
    out.tgReply = {
      sent: sent.length,
      targets: sent.map((s) => s.target),
      labels: sent.map((s) => s.labelSession),
      mapped: findSessionForOutboundMessage("telegram", "222", mid),
      replies: r.replies.length,
      leftAuto: [ids.A, ids.K, ids.G, ids.H, ids.J].filter((id) => row(id!)?.noticeState === "undelivered").length,
      texts: sent.map((x) => x.text.slice(0, 300)),
    };
  }
  // ── ① 같은 세션 메시지 둘을 같은 틱에 → 발송 1회 ──────────────────────────────────────────────────
  {
    tgMode = "gate";
    const tg0 = tgSends.length;
    const a = recover("telegram", "dashboard:crr-s2", "222");
    const b = recover("telegram", "dashboard:crr-s2", "222");
    await until(() => gate !== undefined);
    (gate as (() => void) | undefined)?.();
    gate = undefined;
    await a.p;
    tgMode = "ok";
    out.sameTick = { secondNone: b.p === undefined, sends: tgSends.length - tg0, state: row(ids.S2!)?.noticeState };
  }
  // ── ⑩''' 서로 다른 채널 같은 틱 — 먼저 잡은 쪽 채널로만 · 실패면 다음 메시지가 자기 채널로 ────────────────
  {
    tgMode = "fail";
    const tg0 = tgSends.length;
    const ob0 = observed.length;
    const t = recover("telegram", "dashboard:crr-s3", "333");
    const d = recover("http-bridge", "dashboard:crr-s3", "dashboard:crr-s3");
    await t.p;
    const afterFail = { state: row(ids.S3!)?.noticeState, attempts: attemptsOf(ids.S3!), dashNone: d.p === undefined, tgTries: tgSends.length - tg0 };
    const d2 = recover("http-bridge", "dashboard:crr-s3", "dashboard:crr-s3");
    await d2.p;
    out.crossChannel = {
      ...afterFail,
      finalState: row(ids.S3!)?.noticeState,
      finalAttempts: attemptsOf(ids.S3!),
      dashObserved: observed.slice(ob0).filter((o) => o.threadKey === "dashboard:crr-s3").length,
    };
    tgMode = "ok";
  }
  // ── ⑤ 3회 실패 → gave_up · 4번째 → 0 ───────────────────────────────────────────────────────────────
  {
    tgMode = "fail";
    const seq: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      await recover("telegram", "dashboard:crr-s4", "444").p;
      seq.push(`${row(ids.S4!)?.noticeState}/${attemptsOf(ids.S4!)}`);
    }
    const fourth = recover("telegram", "dashboard:crr-s4", "444").p === undefined;
    tgMode = "ok";
    out.gaveUp = { seq, fourth, read: await read("dashboard:crr-s4", { job_id: ids.S4 }) };
    const giveUpLog = logs.filter((l) => l.includes("회수 포기") && l.includes(ids.S4!)).length;
    out.gaveUp = { ...(out.gaveUp as object), giveUpLog };
  }
  // ── ⑩⁗ 뒤 청크 실패 → 실패로 센다(빈 반환을 성공으로 안 읽는다) · 다음엔 **전문** ─────────────────────────
  {
    tgMode = "partial";
    const r = recover("telegram", "dashboard:crr-s5", "555");
    await r.p;
    const mid1 = `${row(ids.S5!)?.noticeState}/${attemptsOf(ids.S5!)}`;
    tgMode = "ok";
    const tg0 = tgSends.length;
    await recover("telegram", "dashboard:crr-s5", "555").p;
    const full = tgSends.slice(tg0)[0]?.text ?? "";
    out.partial = { afterPartial: mid1, final: `${row(ids.S5!)?.noticeState}/${attemptsOf(ids.S5!)}`, fullHasHead: full.startsWith("↻"), fullHasLabel: full.includes("S5"), replies: r.replies.length };
  }
  // ── ⑭~⑯' 한도 재개 — 재시작 뒤(메모리 없음) 현재 상태로 문구를 고른다 ─────────────────────────────────────
  {
    const { addSchedule, updateSchedule, deleteSchedule } = await import("../../store/schedules.js");
    const { putLimitResume } = await import("../../store/limit-resumes.js");
    const S6 = "dashboard:crr-s6";
    const item = (jobId: string) => ({ kind: "job" as const, at: Date.now(), label: "x", jobId });
    const sched = addSchedule({ label: "재개", cronExpr: "", prompt: "p", destChannel: "telegram", destTarget: "111", triggerType: "once", runAt: Date.now() + 10 * 60_000, originThreadKey: S6 });
    // 대기 중(L1) — 그 사이 다른 실패가 합쳐 시각을 늦췄다.
    putLimitResume({ threadKey: S6, scheduleId: sched.id, items: [item(ids.L1!)], claimedItems: [item(ids.L2!)], arms: 1, claimed: true });
    updateSchedule(sched.id, { runAt: Date.now() + 90 * 60_000 });
    const render = (id: string): string => delivery.renderRedelivery(row(id)!);
    out.limit = {
      waiting: render(ids.L1!),
      resuming: render(ids.L2!),
      none: render(ids.L3!),
      scheduleId: sched.id,
    };
    // 회수 경로로 실제로 한 번(대기 중 L1 포함 — 발송 직전 렌더)
    tgMode = "ok";
    const tg0 = tgSends.length;
    await recover("telegram", S6, "666").p;
    (out.limit as Record<string, unknown>).sentTexts = tgSends.slice(tg0).map((s) => s.text);
    // 옮긴 타이머 — 이 대화 것이 아니다 → none → 한도 실패면 unknown
    const moved = addSchedule({ label: "옮김", cronExpr: "", prompt: "p", destChannel: "telegram", triggerType: "once", runAt: Date.now() + 60_000, originThreadKey: "dashboard:elsewhere" });
    putLimitResume({ threadKey: S6, scheduleId: moved.id, items: [item(ids.L4!)], claimedItems: [], arms: 1, claimed: false });
    (out.limit as Record<string, unknown>).moved = render(ids.L4!);
    // /stop 으로 지워진 뒤 — none
    deleteSchedule(moved.id);
    (out.limit as Record<string, unknown>).deleted = render(ids.L4!);
    // 지난 해제 시각 — 대기 중인데 runAt 이 이미 지났다
    const past = addSchedule({ label: "지남", cronExpr: "", prompt: "p", destChannel: "telegram", triggerType: "once", runAt: Date.now() - 30 * 60_000, originThreadKey: S6 });
    putLimitResume({ threadKey: S6, scheduleId: past.id, items: [item(ids.L4!)], claimedItems: [], arms: 1, claimed: false });
    (out.limit as Record<string, unknown>).pastWaiting = render(ids.L4!);
    // 조회 예외 — 대기가 살아 있는데 저장소가 던진다 → unreadable
    sessions.getDb().exec(`ALTER TABLE limit_resumes RENAME TO limit_resumes_hidden`);
    (out.limit as Record<string, unknown>).unreadable = render(ids.L4!);
    (out.limit as Record<string, unknown>).nonLimitUnreadable = render(ids.S7!);
    sessions.getDb().exec(`ALTER TABLE limit_resumes_hidden RENAME TO limit_resumes`);
    (out.limit as Record<string, unknown>).nonLimit = render(ids.S7!);
  }
  // ── 발송 직전 렌더 — 앞 알림 발송을 기다리는 사이 예약이 지워지면 뒤 알림은 «예약 없음» 으로(선점 때 미리 렌더하면 낡는다 — 독립 사냥 U2) ───
  {
    const S12 = "dashboard:crr-s12";
    live(S12);
    const { addSchedule, deleteSchedule } = await import("../../store/schedules.js");
    const { putLimitResume } = await import("../../store/limit-resumes.js");
    tgMode = "fail";
    const first = mk("앞알림", S12, TG);
    await wj.onWorkerComplete(first, { error: "fetch failed" });
    await sleep(5);
    const lim = mk("뒤한도알림", S12, TG);
    await wj.onWorkerComplete(lim, { error: "429 usage limit reached — rate limit" });
    const sched = addSchedule({ label: "재개", cronExpr: "", prompt: "p", destChannel: "telegram", triggerType: "once", runAt: Date.now() + 10 * 60_000, originThreadKey: S12 });
    putLimitResume({ threadKey: S12, scheduleId: sched.id, items: [{ kind: "job", at: Date.now(), label: "x", jobId: lim }], claimedItems: [], arms: 1, claimed: false });
    tgMode = "gate";
    const tg0 = tgSends.length;
    const r = recover("telegram", S12, "1212");
    await until(() => gate !== undefined);
    const release = gate as (() => void) | undefined;
    gate = undefined;
    deleteSchedule(sched.id); // `/stop` 처럼 — 대기 중 예약이 사라졌다
    putLimitResume({ threadKey: S12, scheduleId: null, items: [], claimedItems: [], arms: 1, claimed: false });
    tgMode = "ok";
    release?.();
    await r.p;
    const texts = tgSends.slice(tg0).map((x) => x.text);
    out.renderAtSend = { n: texts.length, last: texts[texts.length - 1] ?? "" };
  }
  // ── ⑳ 발송 뒤 상태 기록 실패 → 같은 프로세스에선 재선점 0 · 재시작(부팅 정리) 뒤 한 번 더 ─────────────────
  {
    tgMode = "readonly";
    const tg0 = tgSends.length;
    await recover("telegram", "dashboard:crr-s8", "888").p;
    sessions.getDb().pragma("query_only = 0");
    tgMode = "ok";
    const stuck = row(ids.S8!)?.noticeState;
    const again = recover("telegram", "dashboard:crr-s8", "888").p === undefined;
    const sendsBefore = tgSends.length - tg0;
    delivery.reconcileNoticeStatesAtBoot(); // 재시작의 부팅 정리 자리
    await recover("telegram", "dashboard:crr-s8", "888").p;
    out.recordFail = { stuck, again, sendsBefore, sendsAfter: tgSends.length - tg0, final: row(ids.S8!)?.noticeState, log: logs.some((l) => l.includes("전달 상태 기록 실패") && l.includes(ids.S8!)) };
  }
  // ── ⑲ 정리 경합 — 재전달 중(recovering) 행이 보관 상한 밖으로 · 첫 통지 중(sending) 행도 ───────────────────
  {
    // 같은 세션에 미전달 2건을 더 둔다 — 3건을 한 번에 선점한 뒤 첫 발송을 붙잡은 채 정리가 셋 다 지워도, 발송은 스냅숏으로 셋 다 가야 한다(독립 사냥 U1).
    tgMode = "fail";
    for (const l of ["S7b", "S7c"]) await wj.onWorkerComplete(mk(l, "dashboard:crr-s7", TG), { error: "fetch failed" });
    const s7Before = tgSends.filter((x) => x.target === "777").length;
    tgMode = "gate";
    const r = recover("telegram", "dashboard:crr-s7", "777");
    await until(() => gate !== undefined);
    const releaseRecover = gate as (() => void) | undefined; // 클로저가 채운 값 — TS 좁히기 해제
    gate = undefined;
    // 첫 통지 중(sending) — 새 작업 실패 통지를 붙잡는다.
    const sendingId = mk("보내는중", "dashboard:crr-s9", TG);
    const firstP = wj.onWorkerComplete(sendingId, { error: "fetch failed" });
    await until(() => gate !== undefined);
    const releaseFirst = gate as (() => void) | undefined;
    gate = undefined;
    const before = logs.length;
    tgMode = "ok";
    for (let i = 0; i < 1001; i += 1) wj.markDone(mk(`채움${i}`, "dashboard:crr-fill"), "x");
    const pruneLogs = logs.slice(before).filter((l) => l.includes("전달 미확인 통지가 보관 상한 밖으로"));
    const gone = { recovering: row(ids.S7!) === undefined, sending: row(sendingId) === undefined };
    let threw = false;
    try {
      releaseRecover?.();
      releaseFirst?.();
      await r.p;
      await firstP;
    } catch {
      threw = true;
    }
    out.pruneRace = {
      sends777: tgSends.filter((x) => x.target === "777").length - s7Before,
      pruneLogRecovering: pruneLogs.some((l) => l.includes("재전달 중 1")),
      pruneLogSending: pruneLogs.some((l) => l.includes("보내는 중 1")),
      gone,
      threw,
      recreated: row(ids.S7!) !== undefined || row(sendingId) !== undefined,
      skipLogs: logs.filter((l) => l.includes("전달 상태 전이 생략") && (l.includes(ids.S7!) || l.includes(sendingId))).length,
    };
  }
  // ── 다음 단계: 재전달 도중 종료(recovering) — 시도 1 과 시도 3 ────────────────────────────────────────────
  {
    const S10 = "dashboard:crr-s10";
    live(S10);
    tgMode = "fail";
    const r1 = mk("재전달중종료", S10, TG);
    await wj.onWorkerComplete(r1, { error: "fetch failed" });
    const r3 = mk("재전달중종료3", S10, TG);
    await wj.onWorkerComplete(r3, { error: "fetch failed" });
    sessions.getDb().prepare(`UPDATE worker_jobs SET notice_attempts = 2 WHERE job_id = ?`).run(r3);
    tgMode = "hang";
    void recover("telegram", S10, "1010").p;
    await until(() => row(r1)?.noticeState === "recovering" && row(r3)?.noticeState === "recovering");
    out.crash = { r1, r3, r1Attempts: row(r1)?.noticeAttempts, r3Attempts: row(r3)?.noticeAttempts };
    await emitAndExit(); // ★재전달 도중 종료(출력을 다 비운 뒤)
  }
}

if (phase === "delivery-c") {
  const c = JSON.parse(process.env.CRR_IDS ?? "{}") as { r1: string; r3: string };
  delivery.reconcileNoticeStatesAtBoot();
  out.afterBoot = { r1: `${row(c.r1)?.noticeState}/${row(c.r1)?.noticeAttempts}`, r3: `${row(c.r3)?.noticeState}/${row(c.r3)?.noticeAttempts}` };
}

await emitAndExit();
