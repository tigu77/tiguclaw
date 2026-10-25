/**
 * `limit-resume-flow` 의 자식 — 한도 자동 이어가기의 **흐름**을 진짜 부품으로 돌린다: 재개 모듈(`core/limit-resume.ts`)·작업 레지스트리 실패 출구
 * (`onWorkerComplete`)·진짜 스케줄러 플러그인과 실행기·`runTriggerInSession`·저장소. 메인 핸들러만 얇은 대역이다 — `src/index.ts` 클로저라 import 로
 * 못 뽑는다. 대역은 핸들러가 이 기능에 대해 하는 **두 줄**(줄에서 `beforeTurn` 통과 직후 `claimLimitResume` · 실패 출구의
 * `withResumeNote(…, noteTurnLimitStop(e, msg))`)만 그대로 하고, 그 배선 자체는 부모가 소스로 대조한다.
 *
 * ★왜 자식인가: 옵션(`limitResume.enabled`)을 홈 settings.json 으로 켜고 끈다 — 스위트 홈에 쓰면 뒤 검사가 그 설정을 본다.
 * 시각: 실제로 2분을 기다리지 않는다 — 계산한 `wakeAt` 은 그대로 재고, 울리는 것만 `runAt` 을 당겨 확인한다(시간이 흐른 것과 같은 효과).
 * 출력: 마지막 줄 JSON.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assertIsolated, loadPluginModule } from "./_framework.js";

assertIsolated();
const home = mkdtempSync(path.join(process.env.TIGUCLAW_HOME!, "limit-flow-"));
process.env.TIGUCLAW_HOME = home;
const settingsPath = path.join(home, "settings.json");
const setEnabled = (on: boolean | undefined, locale = "ko"): void =>
  writeFileSync(settingsPath, JSON.stringify({ locale, ...(on === undefined ? {} : { limitResume: { enabled: on } }) }));
setEnabled(undefined);

const { initStore, saveSession, getDb, setThreadArchived } = await import("../../store/sessions.js");
initStore();
const { getEventBus } = await import("../../core/eventbus.js");
const { registerChannelOutbound } = await import("../../core/channel-outbound.js");
const lr = await import("../../core/limit-resume.js");
const { markLimitResume } = await import("../../core/llm-runtime/resume-signal.js");
const wj = await import("../../core/worker-jobs.js");
const { getSchedule, updateSchedule, listSchedules, recordFiring } = await import("../../store/schedules.js");
const { getLimitResume } = await import("../../store/limit-resumes.js");
const { translate } = await import("../../core/i18n.js");

const bus = getEventBus();
const sent: Array<{ target: unknown; text: string }> = [];
registerChannelOutbound("regr-lr", { deliver: async (target: unknown, text: string) => { sent.push({ target, text }); return { messageIds: [1] }; }, defaultOutboundTarget: async () => "c" } as never);
const S = "dashboard:regr-lr-a";
const S2 = "dashboard:regr-lr-b";
const S3 = "dashboard:regr-lr-archived";
for (const k of [S, S2, S3]) saveSession({ channel: "http-bridge", threadKey: k, claudeSessionId: `regr-${k}`, model: null, systemPromptHash: null } as never);
let live = true;
lr.setLimitResumeRuntime({ schedulerLive: () => live });
const errors: number[] = [];
bus.subscribe((e: { type: string; payload?: { scheduleId?: number } }) => { if (e.type === "scheduler.error" && typeof e.payload?.scheduleId === "number") errors.push(e.payload.scheduleId); });

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 4000): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (cond()) return true; await sleep(20); }
  return cond();
};
const LIMIT_MSG = '429 usage_limit_reached {"resets_in_seconds": 600}';
const limitErr = (resumeAt: number, partial?: string): Error => {
  const e = new Error(LIMIT_MSG);
  markLimitResume(e, resumeAt, partial);
  return e;
};
const timersOf = (s: string): number[] => listSchedules().filter((r) => r.triggerType === "once" && r.originThreadKey === s).map((r) => r.id);
const rowsOf = (): number => (getDb().prepare("SELECT COUNT(*) AS n FROM limit_resumes").get() as { n: number }).n;
const fireNow = (id: number): void => { updateSchedule(id, { runAt: Date.now() + 30 }); bus.publish({ type: "scheduler.toggle", ts: Date.now(), payload: { id, action: "enable" } }); };

// 핸들러 대역 — 이 기능에 대해 핸들러가 하는 두 줄만.
type Plan = { kind: "ok" } | { kind: "limit"; resumeAt: () => number; during?: () => Promise<void> };
const plans: Plan[] = [];
const turns: Array<{ text: string; id?: number }> = [];
const failTexts: string[] = [];
let beforeClaim: (() => Promise<void>) | undefined;
/** ok 계획의 턴 도중에 할 일(한 번). */
let okDuring: (() => Promise<void>) | undefined;
/** 재개 턴이 내려놓은 **뒤**, 핸들러가 돌아가기 전(= 실행기 정산 전)에 할 일(한 번). */
let afterRelease: (() => Promise<void>) | undefined;
wj.__setMainHandlerForTest(async (m) => {
  if (m.triggerRun === undefined) return; // 완료 재주입(성공 작업) — 이 검사의 대상 아님
  const pre = beforeClaim;
  beforeClaim = undefined;
  await pre?.();
  const skip = m.beforeTurn?.() ?? null;
  if (skip !== null) return;
  const runId = m.triggerRun?.kind === "schedule" ? m.triggerRun.id : undefined;
  if (runId !== undefined) lr.claimLimitResume(runId, lr.turnSessionOf(m));
  try { await turnBody(m); } finally {
    if (runId !== undefined) lr.releaseLimitResume(runId, lr.turnSessionOf(m));
    const ar = afterRelease;
    afterRelease = undefined;
    await ar?.();
  }
});
type Msg = import("../../channels/types.js").IncomingMessage;
const turnBody = async (m: Msg): Promise<void> => {
  turns.push({ text: m.text, id: m.triggerRun?.kind === "schedule" ? m.triggerRun.id : undefined });
  const plan = plans.shift() ?? { kind: "ok" };
  if (plan.kind === "ok") {
    const d = okDuring;
    okDuring = undefined;
    await d?.();
    await m.reply("이어서 처리했습니다");
    return;
  }
  await plan.during?.();
  const failText = lr.withResumeNote("⚠️ 한도", lr.noteTurnLimitStop(limitErr(plan.resumeAt()), m));
  failTexts.push(failText);
  await m.reply(failText, { turnFailed: true });
};
const Plugin = (await loadPluginModule<{ default: new () => { startTrigger: (b: unknown, d?: unknown) => Promise<void>; stop: () => Promise<void> } }>("../../../plugins/scheduler/src/index.ts")).default;
const plugin = new Plugin();
await plugin.startTrigger(bus, { cwd: process.cwd(), recordFiring: (id: number, r: { ok: boolean; error?: string }) => recordFiring(id, r), dispatch: async () => {} });

const job = (label: string, threadKey = S, modelTier = "mid"): string =>
  wj.registerJob({ label, task: `${label} 지시`, threadKey, channel: "regr-lr" as never, channelUserId: "u", notifyDest: { channel: "regr-lr" as never, target: "c" }, kind: "worker", modelTier } as never);
const failJob = async (id: string, resumeAt: number): Promise<string> => {
  const before = sent.length;
  await wj.onWorkerComplete(id, wj.failureOutcome(limitErr(resumeAt)));
  return sent.slice(before).map((x) => x.text).join("\n---\n");
};
const out: Record<string, unknown> = {};
const msgOf = (threadKey: string, text: string): { channel: string; threadKey: string; text: string } => ({ channel: "regr-lr", threadKey, text });

// ── R1 꺼짐(기본) — 행 0 · 문구 바이트 동일 ─────────────────────────────────
{
  const schedulesBefore = listSchedules().length;
  const note = lr.noteTurnLimitStop(limitErr(Date.now() + 600_000), msgOf(S, "꺼짐 턴"));
  const jid = job("꺼짐작업");
  const text = await failJob(jid, Date.now() + 600_000);
  const rec = wj.getJob(jid)!;
  const expected = translate("srv.job.failed", { label: "꺼짐작업", cause: wj.humanizeWorkerError(rec.error ?? "", rec.errorName) });
  out.off = { note: note ?? null, rows: rowsOf(), schedulesDelta: listSchedules().length - schedulesBefore, jobTextSame: text === expected, base: lr.withResumeNote("X", undefined) === "X" };
}
// 명시적으로 false 도 같다
setEnabled(false);
{
  const note = lr.noteTurnLimitStop(limitErr(Date.now() + 600_000), msgOf(S, "끈 턴"));
  out.offExplicit = { note: note ?? null, rows: rowsOf() };
}

// ── 켬 ────────────────────────────────────────────────────────────────────
setEnabled(true);
// R7·R4 — 메인 턴: wakeAt = 해제 + 2분 · 같은 메시지에 «{when} 이어서 · /schedule delete id»
const t0 = Date.now();
const mainNote = lr.noteTurnLimitStop(limitErr(t0 + 600_000, "'send_file' had already started running"), msgOf(S, "첫 질문 원문입니다"));
const mainText = lr.withResumeNote("⚠️ 한도", mainNote);
const sid = mainNote?.kind === "armed" ? mainNote.scheduleId : -1;
out.main = { note: mainNote ?? null, wakeRel: mainNote?.kind === "armed" ? Math.round((mainNote.wakeAt - t0) / 1000) : null, text: mainText, hasDelete: mainText.includes(`/schedule delete ${sid}`), oneMessage: mainText.startsWith("⚠️ 한도\n") };
// R3 — 같은 세션 작업 둘이 더 늦은/이른 해제로 → 한 행·항목 셋·runAt = 가장 늦은 wakeAt
const jB = job("작업B", S, "high");
const jBText = await failJob(jB, t0 + 1_200_000);
const jC = job("작업C", S, "low");
await failJob(jC, t0 + 300_000);
const sRow = getSchedule(sid);
out.merge = {
  timers: timersOf(S).length, items: getLimitResume(S)?.items.length ?? 0, arms: getLimitResume(S)?.arms ?? 0,
  runAtRel: sRow?.runAt == null ? null : Math.round((sRow.runAt - t0) / 1000),
  jobText: jBText, jobHasDelete: jBText.includes(`/schedule delete ${sid}`),
  jobNoRetryAsk: !jBText.includes("그 뒤 다시 시켜주세요") && !jBText.includes("알려주시면"),
  jobIsLimitResumeForm: jBText.startsWith(translate("srv.job.failedLimitResume", { label: "작업B", cause: "", resume: "" }).split("\n")[0]!),
};
// 다른 세션은 따로
const jD = job("작업D", S2);
await failJob(jD, t0 + 600_000);
out.otherSession = { timersS2: timersOf(S2).length, timersS: timersOf(S).length };
// 합류(wait_for_worker)가 선점한 실패 — 통지 대신 합류 결과가 같은 칸을 읽는다
const jJ = job("합류작업", S);
const jClaim = wj.claimJobJoin(jJ, S); // 소환자(이 세션)의 대기 — 권리는 직속 소환자에게만(2026-10-23)
const joinedSent = await failJob(jJ, t0 + 60_000);
wj.releaseJobJoin(jClaim, { handedOff: true }); // 합류가 결과를 받아 갔다
out.join = { rawSent: joinedSent, line: wj.jobLimitResumeLine(wj.getJob(jJ)!), items: getLimitResume(S)?.items.length ?? 0 };
// 하위 작업(소환자 = 돌고 있는 매니저) · 취소된 작업 — 항목 아님
const mgr = job("매니저M", S);
const child = job("하위작업", `worker:${mgr}`);
await failJob(child, t0 + 60_000);
const cj = job("취소작업", S);
wj.markCancelled(cj, "사용자 취소");
await wj.onWorkerComplete(cj, wj.failureOutcome(limitErr(t0 + 60_000)));
out.notItems = { items: getLimitResume(S)?.items.length ?? 0, childNote: wj.getJob(child)?.limitResume ?? null, cancelledNote: wj.getJob(cj)?.limitResume ?? null };

// R5 — 울림: 그 세션에 합성 턴 1 · 글에 항목(작업 label·jobId·프로파일, 메인 원문, 부분 실행 사유) · 끝나면 지움
fireNow(sid);
await until(() => turns.length >= 1 && getSchedule(sid) === undefined);
const wake = turns[0];
out.wake = {
  turns: turns.length, id: wake?.id ?? null,
  hasJobB: (wake?.text ?? "").includes('작업 "작업B"') && (wake?.text ?? "").includes(jB) && (wake?.text ?? "").includes("프로파일 high"),
  hasMain: (wake?.text ?? "").includes("첫 질문 원문입니다"), hasPartial: (wake?.text ?? "").includes("send_file"),
  noChild: !(wake?.text ?? "").includes("하위작업"), noCancelled: !(wake?.text ?? "").includes("취소작업"),
  rowGone: getSchedule(sid) === undefined, claimed: getLimitResume(S)?.claimed ?? null,
};

// R3′ⓐ — 울린 발화가 차례 직전, 더 늦게 풀리는 실패가 합쳐진다 → 옛 차례로 안 돌고(rescheduled) 새 시각에 합친 목록으로 한 번
{
  const turnsBefore = turns.length;
  lr.resetLimitResumeArms(S);
  const n1 = lr.noteTurnLimitStop(limitErr(Date.now()), msgOf(S, "합침 앞 항목"));
  const id = n1?.kind === "armed" ? n1.scheduleId : -1;
  let firedAt = 0;
  beforeClaim = async () => {
    // 차례가 오기 직전(아직 넘겨받기 전) — 다른 작업이 더 늦은 해제로 실패해 합쳐진다.
    firedAt = Date.now();
    const jx = job("늦은작업", S);
    await wj.onWorkerComplete(jx, wj.failureOutcome(limitErr(Date.now() + 5_000)));
  };
  fireNow(id);
  await until(() => firedAt > 0 && (getSchedule(id)?.runAt ?? 0) > firedAt + 60_000, 3000);
  await sleep(100);
  const mergedRunAt = getSchedule(id)?.runAt ?? 0;
  const ranEarly = turns.length - turnsBefore;
  const items = getLimitResume(S)?.items.map((i) => i.label ?? i.text ?? "") ?? [];
  fireNow(id); // 새 시각이 왔다
  await until(() => getSchedule(id) === undefined);
  const last = turns[turns.length - 1];
  out.queuedMerge = { ranEarly, items, mergedAhead: mergedRunAt - firedAt > 60_000, finalTurns: turns.length - turnsBefore, both: (last?.text ?? "").includes("합침 앞 항목") && (last?.text ?? "").includes("늦은작업"), gone: getSchedule(id) === undefined };
}

// R6 — 재개 턴 자신이 한도 → 같은 행 제자리 다시 걸기 · 정산 0 · 상한 3 뒤 걸지 않고 capped + 행 삭제 · 사람 메시지면 다시 3번
{
  lr.resetLimitResumeArms(S);
  const n = lr.noteTurnLimitStop(limitErr(Date.now()), msgOf(S, "상한 시험 원문"));
  const id = n?.kind === "armed" ? n.scheduleId : -1;
  const errBefore = errors.length;
  const trace: Array<{ arms: number; runAtAhead: boolean; enabled: boolean; lastStatus: string | null; items: string[] }> = [];
  // 처음 건 것이 1회 — 재개 턴 1·2 의 실패는 제자리 다시 걸기(2·3), 재개 턴 3 의 실패가 상한(자동 재개 = 3번).
  for (let k = 0; k < 2; k += 1) {
    const turnsBefore = turns.length;
    plans.push({ kind: "limit", resumeAt: () => Date.now() });
    fireNow(id);
    await until(() => turns.length > turnsBefore && failTexts.length > 0 && (getSchedule(id)?.runAt ?? 0) > Date.now() + 60_000, 3000);
    await sleep(80);
    const r = getSchedule(id);
    trace.push({ arms: getLimitResume(S)?.arms ?? -1, runAtAhead: (r?.runAt ?? 0) > Date.now() + 60_000, enabled: r?.enabled ?? false, lastStatus: r?.lastStatus ?? null, items: getLimitResume(S)?.items.map((i) => i.text ?? i.label ?? "") ?? [] });
  }
  // 세 번째 재개 턴의 실패 — 상한
  const turnsBefore = turns.length;
  plans.push({ kind: "limit", resumeAt: () => Date.now() });
  fireNow(id);
  await until(() => turns.length > turnsBefore && getSchedule(id) === undefined, 3000);
  await sleep(150);
  const cappedText = failTexts[failTexts.length - 1] ?? "";
  out.cap = {
    sameRow: trace.every((t) => t.runAtAhead && t.enabled), arms: trace.map((t) => t.arms), lastStatus: trace.map((t) => t.lastStatus),
    itemsKept: trace.every((t) => JSON.stringify(t.items) === JSON.stringify(["상한 시험 원문"])),
    cappedLine: cappedText.includes(translate("srv.limitResume.capped", { n: 3 })), rowGone: getSchedule(id) === undefined, schedulerErrors: errors.length - errBefore,
  };
  // 사람 메시지 → 다시 건다
  lr.resetLimitResumeArms(S);
  const again = lr.noteTurnLimitStop(limitErr(Date.now()), msgOf(S, "사람이 돌아왔다"));
  out.capReset = { kind: again?.kind ?? null, arms: getLimitResume(S)?.arms ?? -1 };
  if (again?.kind === "armed") lr.cancelLimitResume(S);
}

// 보존 — 재개 턴 도중 재시작(넘겨받은 뒤 끊김) → 부팅 뒤 다시 울기 전 다른 실패 → 항목 둘 다
{
  lr.resetLimitResumeArms(S);
  const n = lr.noteTurnLimitStop(limitErr(Date.now()), msgOf(S, "재시작 전 항목"));
  const id = n?.kind === "armed" ? n.scheduleId : -1;
  lr.claimLimitResume(id, S); // 재개 턴이 시작했다 — 그리고 데몬이 죽었다
  lr.resetLimitResumeClaims(); // 부팅
  const jr = job("재시작뒤작업", S);
  await failJob(jr, Date.now());
  out.restart = { items: getLimitResume(S)?.items.map((i) => i.label ?? i.text ?? "") ?? [], sameRow: timersOf(S).includes(id) && timersOf(S).length === 1 };
  // /stop — 대기 중 재개를 지운다 · 시각을 돌려준다 · 다른 세션 것은 그대로 · 두 번째는 없음
  const s2Before = timersOf(S2).length;
  const c1 = lr.cancelLimitResume(S);
  const c2 = lr.cancelLimitResume(S);
  out.stop = { cancelled: c1 !== undefined, again: c2 ?? null, rowGone: getSchedule(id) === undefined, s2Kept: timersOf(S2).length === s2Before && s2Before === 1, line: translate("srv.limitResume.cancelledByStop", { when: "X" }) };
}

// GPT R1 ② — 재개 턴 A 가 도는 사이 작업 B 가 한도로 실패(같은 행을 다시 건다) → 그 뒤 A 자신도 한도 → A 의 목록이 대기로 돌아오고, 시각은 늦은 쪽, 횟수는 두 번 안 센다
{
  lr.resetLimitResumeArms(S);
  const n = lr.noteTurnLimitStop(limitErr(Date.now()), msgOf(S, "A항목"));
  const id = n?.kind === "armed" ? n.scheduleId : -1;
  let midArms = -1;
  plans.push({
    kind: "limit",
    resumeAt: () => Date.now(),
    during: async () => {
      const jb = job("B작업", S);
      await wj.onWorkerComplete(jb, wj.failureOutcome(limitErr(Date.now() + 20 * 60_000)));
      midArms = getLimitResume(S)?.arms ?? -1;
    },
  });
  const turnsBefore = turns.length;
  const t1 = Date.now();
  fireNow(id);
  await until(() => turns.length > turnsBefore && (getLimitResume(S)?.items.length ?? 0) >= 2 && !(getLimitResume(S)?.claimed ?? true), 3000);
  await sleep(150);
  const st = getLimitResume(S);
  const r = getSchedule(id);
  out.overlap = {
    items: st?.items.map((i) => i.label ?? i.text ?? "") ?? [], claimed: st?.claimed ?? null, claimedItems: st?.claimedItems.length ?? -1,
    midArms, arms: st?.arms ?? -1, sameRow: timersOf(S).length === 1 && timersOf(S)[0] === id,
    runAtRel: r?.runAt == null ? null : Math.round((r.runAt - t1) / 60_000), enabled: r?.enabled ?? null,
  };
  lr.cancelLimitResume(S);
}

// GPT R2 — 재개 턴 A 가 도는 사이 B 가 한도로 실패(같은 행 다시 걸림) → A 는 **성공** → 재시작 → 대기엔 B 만(끝난 A 가 돌아오지 않는다)
{
  lr.resetLimitResumeArms(S);
  const n = lr.noteTurnLimitStop(limitErr(Date.now()), msgOf(S, "끝날A"));
  const id = n?.kind === "armed" ? n.scheduleId : -1;
  // A 의 재개 턴: 도중에 B 가 한도로 실패하고(같은 행을 다시 건다), A 자신은 성공한다.
  okDuring = async () => {
    const jb = job("남을B", S);
    await wj.onWorkerComplete(jb, wj.failureOutcome(limitErr(Date.now() + 20 * 60_000)));
  };
  plans.push({ kind: "ok" });
  const turnsBefore = turns.length;
  fireNow(id);
  await until(() => turns.length > turnsBefore && okDuring === undefined && (getLimitResume(S)?.items.length ?? 0) === 1 && !(getLimitResume(S)?.claimed ?? true), 3000);
  await sleep(150);
  const afterRun = { items: getLimitResume(S)?.items.map((i) => i.label ?? i.text ?? "") ?? [], claimed: getLimitResume(S)?.claimed ?? null, claimedItems: getLimitResume(S)?.claimedItems.length ?? -1 };
  lr.resetLimitResumeClaims(); // 재시작
  const afterBoot = getLimitResume(S)?.items.map((i) => i.label ?? i.text ?? "") ?? [];
  out.successRelease = { afterRun, afterBoot, prompt: (getSchedule(id)?.prompt ?? "").includes("끝날A"), rowKept: getSchedule(id) !== undefined };
  lr.cancelLimitResume(S);
}

// GPT R3 — 상한에 닿은 세 번째 재개 턴이 **성공**해 내려놓은 직후·실행기 정산 전에 다른 작업이 한도 → «합침» 으로 상한을 건너뛰지 않는다(capped · 새 예약 0)
{
  lr.resetLimitResumeArms(S);
  const n = lr.noteTurnLimitStop(limitErr(Date.now()), msgOf(S, "세번째"));
  const id = n?.kind === "armed" ? n.scheduleId : -1;
  // 횟수를 상한까지 올린다(같은 대화에서 두 번 더 건 셈).
  const st0 = getLimitResume(S)!;
  (await import("../../store/limit-resumes.js")).putLimitResume({ ...st0, arms: 3 });
  let late: unknown = "(안 옴)";
  let stopAfterRelease: unknown = "(안 봄)";
  afterRelease = async () => {
    // 내려놓은 직후의 /stop — 대기 세대가 없으니 «취소했습니다» 라고 하면 거짓이다.
    stopAfterRelease = lr.cancelLimitResume(S) ?? null;
    const jl = job("정산전작업", S);
    await wj.onWorkerComplete(jl, wj.failureOutcome(limitErr(Date.now() + 60_000)));
    late = wj.getJob(jl)?.limitResume ?? null;
  };
  plans.push({ kind: "ok" });
  const turnsBefore = turns.length;
  fireNow(id);
  await until(() => turns.length > turnsBefore && late !== "(안 옴)" && getSchedule(id) === undefined, 3000);
  await sleep(150);
  out.releaseCap = { late, stopAfterRelease, rowGone: getSchedule(id) === undefined, timers: timersOf(S).length, arms: getLimitResume(S)?.arms ?? -1 };
}

// GPT R4 — 상한 **미만**의 재개 턴이 성공해 내려놓은 직후·정산 전에 다른 작업이 한도 → 같은 행을 제자리에서 다시 건다(+1) · 정산 뒤에도 예약 하나 · 울리면 B 를 이어 간다
{
  lr.resetLimitResumeArms(S);
  const n = lr.noteTurnLimitStop(limitErr(Date.now()), msgOf(S, "끝난A2"));
  const id = n?.kind === "armed" ? n.scheduleId : -1;
  let late: unknown = "(안 옴)";
  let mid: unknown = null;
  afterRelease = async () => {
    const jl = job("정산전B2", S);
    await wj.onWorkerComplete(jl, wj.failureOutcome(limitErr(Date.now() + 60_000)));
    late = wj.getJob(jl)?.limitResume ?? null;
    const st = getLimitResume(S);
    mid = { arms: st?.arms ?? -1, items: st?.items.map((i) => i.label ?? i.text ?? "") ?? [], claimed: st?.claimed ?? null };
  };
  plans.push({ kind: "ok" });
  const turnsBefore = turns.length;
  fireNow(id);
  await until(() => turns.length > turnsBefore && late !== "(안 옴)", 3000);
  await sleep(200); // 실행기 정산(실행 도중 바뀜 → 정산 0 · 다시 걸기)
  const afterSettle = { timers: timersOf(S), row: getSchedule(id) === undefined ? null : { enabled: getSchedule(id)!.enabled, lastStatus: getSchedule(id)!.lastStatus } };
  const turns2 = turns.length;
  fireNow(id);
  await until(() => turns.length > turns2 && getSchedule(id) === undefined, 3000);
  const next = turns[turns.length - 1]?.text ?? "";
  out.releaseRearm = { late, mid, afterSettle, sameId: late !== null && typeof late === "object" && (late as { scheduleId?: number }).scheduleId === id, nextHasB: next.includes("정산전B2"), nextNoA: !next.includes("끝난A2"), gone: getSchedule(id) === undefined };
}

// GPT R1 ③ — 재개 타이머를 다른 대화로 옮겼다(`move_here`) → 옛 대화의 새 실패는 그 행에 합치지 않고 새로 건다 · 옛 대화의 /stop 은 옮긴 것을 못 지운다
{
  lr.resetLimitResumeArms(S);
  const n = lr.noteTurnLimitStop(limitErr(Date.now()), msgOf(S, "옮기기 전 항목"));
  const moved = n?.kind === "armed" ? n.scheduleId : -1;
  updateSchedule(moved, { originThreadKey: S2 }); // 사용자가 S2 에서 «이 대화로 옮겨 줘»
  const movedPrompt = getSchedule(moved)?.prompt ?? "";
  const stopBeforeNew = lr.cancelLimitResume(S); // 옮긴 직후 옛 대화의 /stop — 옮긴 것을 지우면 안 된다
  const jm = job("옮긴뒤작업", S);
  await failJob(jm, Date.now());
  const st = getLimitResume(S);
  const fresh = st?.scheduleId ?? -1;
  const c = lr.cancelLimitResume(S);
  out.moved = {
    stopBeforeNew: stopBeforeNew ?? null, movedAfterStop: true,
    newRow: fresh !== moved && fresh > 0, movedPromptSame: getSchedule(moved)?.prompt === movedPrompt, movedKeptOrigin: getSchedule(moved)?.originThreadKey === S2,
    sItems: st?.items.map((i) => i.label ?? i.text ?? "") ?? [], cancelHitFresh: c !== undefined && getSchedule(fresh) === undefined, movedAlive: getSchedule(moved) !== undefined,
  };
  // 옮긴 것은 이 검사가 치운다(울리기 전 — 시각이 2분 뒤다).
  (await import("../../store/schedules.js")).deleteSchedule(moved);
  bus.publish({ type: "scheduler.toggle", ts: Date.now(), payload: { id: moved, action: "delete" } });
}

// GPT R1 ① — 매니저의 거두기 턴이 한도로 실패해도 재개 시각이 이어진다(그 catch 만 문자열로 줄였다)
{
  lr.resetLimitResumeArms(S);
  const { runWorkerJob } = await import("../../core/llm-runtime/capabilities/worker-registry.js");
  const mid = wj.registerJob({ label: "거두기매니저", task: "조사", threadKey: S, channel: "regr-lr" as never, channelUserId: "u", notifyDest: { channel: "regr-lr" as never, target: "c" }, kind: "worker" } as never);
  const kid = wj.registerJob({ label: "거두기자식", task: "부분", threadKey: `worker:${mid}`, channel: "regr-lr" as never, channelUserId: "u", kind: "agent", detached: true } as never);
  let n = 0;
  runWorkerJob(wj.getJob(mid) as never, async () => {
    n += 1;
    if (n === 1) {
      setTimeout(() => { wj.markDone(kid, "끝"); wj.getJobResultChannel(mid)?.push({ text: "끝", raw: "[자식] 결과", ts: 2, source: "job" }); }, 20);
      return { text: "본 보고서" } as never;
    }
    throw limitErr(Date.now() + 5 * 60_000);
  });
  await until(() => wj.getJob(mid)?.status !== "running", 8000);
  await sleep(100);
  const j = wj.getJob(mid);
  out.harvest = { status: j?.status ?? null, turns: n, note: j?.limitResume?.kind ?? null, item: (getLimitResume(S)?.items ?? []).some((i) => i.label === "거두기매니저") };
  lr.cancelLimitResume(S);
}

// 하지 않는 경우 — 사람의 대화 아님 · 보관한 대화 · 스케줄러 없음 · 한도 아님(속성 없음)
{
  const notHuman = lr.noteLimitStop({ session: "scheduler:9", resumeAtMs: Date.now(), item: { kind: "turn", at: Date.now() }, dest: { channel: "regr-lr", target: "c" } });
  setThreadArchived(S3, Date.now());
  const archived = lr.noteLimitStop({ session: S3, resumeAtMs: Date.now(), item: { kind: "turn", at: Date.now() }, dest: { channel: "regr-lr", target: "c" } });
  live = false;
  const noScheduler = lr.noteLimitStop({ session: S2, resumeAtMs: Date.now(), item: { kind: "turn", at: Date.now() }, dest: { channel: "regr-lr", target: "c" } });
  live = true;
  const notLimit = lr.noteTurnLimitStop(new Error(LIMIT_MSG), msgOf(S2, "속성 없는 한도 문구"));
  out.skips = { notHuman: notHuman ?? null, archived: archived ?? null, noScheduler: noScheduler ?? null, notLimit: notLimit ?? null, s2Timers: timersOf(S2).length };
}
// en 문구도 같은 모양
setEnabled(true, "en");
out.en = { at: lr.resumeNoteLine({ kind: "armed", scheduleId: 42, wakeAt: Date.now() + 300_000 }), capped: lr.resumeNoteLine({ kind: "capped", arms: 3 }) };

await plugin.stop();
console.log(JSON.stringify(out));
process.exit(0);
