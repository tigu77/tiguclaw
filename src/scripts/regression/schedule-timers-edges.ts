/**
 * 회귀: **스케줄 타이머의 가장자리** — 적대 검토(2026-10-20, worktree)가 재현한 결함 8건과 그물 구멍 9건.
 *
 * 결함(P):
 *  #1 전송 실패한 타이머 — «5분 뒤 다시 보냄» 이라 알리고, 실행기가 행을 지워 재전송이 스스로 취소됐다
 *  #2 실패한 타이머가 지워져 자가 진단(health-sweep)에 안 잡혔다 → 이제 **꺼 둔 채 남긴다**
 *  #3 부팅 창(플러그인 시작 ~ 메인 핸들러 등록)에 온 대화 타이머가 «핸들러 없음» 으로 실패 → 이제 기다린다
 *  #4 종료 중 핸들러가 합성 메시지를 조용히 끝내면 «답 0자 성공» 으로 세어 안 돈 타이머가 지워졌다 → `not-run`
 *  #5·#6 `/stop` 한 실행·꺼 뒀다 켠 스케줄을 재시작 보충이 다시 돌렸다 → 보충은 **데몬이 꺼져 있던 구간**만
 *  #7 지난 타이머를 켜면 곧바로 «늦게» 울거나 말없이 지워졌다 → 켜기 거절
 *  #8 줄에서 기다리는 사이 **끈** 타이머가 지워졌다 → 꺼진 채 남긴다
 * 그물(G): 진짜 파사드(만든 대화 문) · 스케줄 쪽 차례 판정(꺼짐·옮겨짐) · 두 보충 길(부팅·재시작) 각각 · 지난 타이머는 부팅 뒤 ·
 *  만든 시각 기준 · 먼 타이머 상한 · 전용 세션 줄의 옮겨짐 · 켜기·수정의 타이머 갈래 · 도구 거절(keep_runs·cron_expr)·옮기면 keep_runs 비움 · 다시 돌 때 켜짐 확인.
 *
 * 등급: **동작** — 진짜 플러그인·실행기·파사드·코어 이음(`runTriggerInSession`)·저장소. 사람 대화의 «문»(메인 핸들러)만 가짜로 갈아 끼운다.
 */
import { listOutboundChannels, registerChannelOutbound, unregisterChannelOutbound } from "../../core/channel-outbound.js";
import { runHealthSweep } from "../../core/health-sweep.js";
import { enqueueThreadTurn, mainMessageHandler, __setMainHandlerForTest } from "../../core/worker-jobs.js";
import { getDb, initStore, isConversationLive, saveSession } from "../../store/sessions.js";
import { addSchedule, deleteSchedule, getSchedule, markSchedulerAlive, recordFiring, updateSchedule, type ScheduleRow } from "../../store/schedules.js";
import type { IncomingMessage } from "../../channels/types.js";
import { UserCancelledError } from "../../core/steering.js";
import { handleSchedule } from "../../core/entry/slash-commands.js";
import { schedulerLastAlive } from "../../store/schedules.js";
import { assert, assertIsolated, loadPluginModule, type Assertion, type RegressionCheck } from "./_framework.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 3000): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(20);
  }
  return cond();
};
type Plugin = { startTrigger: (b: unknown, d?: unknown) => Promise<void>; stop: () => Promise<void> };
type RunInput = { text: string; threadKey: string; triggerRun?: Record<string, unknown>; originThreadKey?: string | null };

export const check: RegressionCheck = {
  name: "schedule-timers-edges",
  guards:
    "타이머가 실패하면 흔적 없이 지워지고, 재전송은 스스로 취소되고, 부팅·종료 창에서 안 돈 채 «성공» 으로 지워지고, 재시작 보충이 살아 있던 동안의 실행까지 다시 돌리던 것(적대 검토 10-20)",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    initStore();
    const out: Assertion[] = [];
    const cleanup: number[] = [];
    const prevHandler = mainMessageHandler();
    const Plugin = (await loadPluginModule<{ default: new () => Plugin }>("../../../plugins/scheduler/src/index.ts")).default;
    const runner = await loadPluginModule<{ runScheduleFiring: (r: unknown, b: unknown, d: unknown, o?: unknown) => Promise<void> }>("../../../plugins/scheduler/src/runner.ts");
    const mcp = await loadPluginModule<{ createSchedulerMcpServer: (h?: unknown) => { instance: unknown } }>("../../../plugins/scheduler/src/mcp.js");
    type Tools = Record<string, { handler: (a: unknown, e: unknown) => Promise<{ content: { text: string }[] }> }>;
    const tools = (session: string | null): Tools => (mcp.createSchedulerMcpServer({ turnSession: () => session }).instance as { _registeredTools: Tools })._registeredTools;
    const call = async (t: Tools, name: string, args: unknown) => JSON.parse((await t[name]!.handler(args, {})).content[0]!.text) as Record<string, unknown>;
    const published: Array<{ type: string; payload: Record<string, unknown> }> = [];
    let onEvent: ((e: { type: string; payload?: unknown }) => void) | undefined;
    const bus = { publish: (e: { type: string; payload: Record<string, unknown> }) => published.push(e), subscribe: (fn: typeof onEvent) => { onEvent = fn; return () => {}; } };
    const timer = (label: string, runAtIn: number, origin: string | null, extra: Partial<ScheduleRow> = {}): ScheduleRow => {
      const r = addSchedule({ label, cronExpr: "", prompt: `${label} 지시`, destChannel: "regr-edge", destTarget: "c", triggerType: "once", runAt: Date.now() + runAtIn, originThreadKey: origin });
      cleanup.push(r.id);
      if (extra.enabled === false) updateSchedule(r.id, { enabled: false });
      return getSchedule(r.id)!;
    };
    // 사람 대화 둘 — `runTriggerInSession` 이 «대화가 살아 있나» 를 본다.
    const A = "dashboard:regr-edge-a";
    const B = "dashboard:regr-edge-b";
    // 답이 실제로 나가는 목적지 — 등록 안 된 채널이면 배달 실패로 «실패한 타이머» 가 된다.
    const delivered: Array<{ target: unknown; text: string }> = [];
    registerChannelOutbound("regr-edge", { deliver: async (target: unknown, text: string) => { delivered.push({ target, text }); return { messageIds: [1] }; }, defaultOutboundTarget: async () => "c" } as never);
    for (const k of [A, B]) saveSession({ channel: "http-bridge", threadKey: k, claudeSessionId: `regr-edge-${k}`, model: null, systemPromptHash: null } as never);

    try {
      // ── G1·G2·#4·#8 — 진짜 파사드로 만든 대화에 들어간다 ─────────────────────
      const behave = new Map<number, (m: IncomingMessage) => Promise<void>>();
      const seen: IncomingMessage[] = [];
      __setMainHandlerForTest(async (m) => {
        seen.push(m);
        const id = (m.triggerRun as { id?: number } | undefined)?.id;
        const b = id === undefined ? undefined : behave.get(id);
        if (b !== undefined) return b(m);
        if (m.beforeTurn?.() === null) await m.reply("답");
      });
      const records = new Map<number, Array<{ ok: boolean }>>();
      const rec = (id: number, v: { ok: boolean }) => { records.set(id, [...(records.get(id) ?? []), v]); recordFiring(id, v); };
      const normal = timer("regr-edge-보통", 250, A);
      const offWhileQueued = timer("regr-edge-줄에서꺼짐", 250, A);
      behave.set(offWhileQueued.id, async (m) => { updateSchedule(offWhileQueued.id, { enabled: false }); m.beforeTurn?.(); });
      const movedWhileQueued = timer("regr-edge-줄에서옮김", 250, A);
      behave.set(movedWhileQueued.id, async (m) => {
        if (m.threadKey === A) { updateSchedule(movedWhileQueued.id, { originThreadKey: B }); m.beforeTurn?.(); return; }
        if (m.beforeTurn?.() === null) await m.reply("옮긴 자리 답");
      });
      const closing = timer("regr-edge-종료중", 250, A);
      behave.set(closing.id, async () => { /* refuseWhileClosing — 차례 없이 조용히 끝 */ });
      markSchedulerAlive(Date.now());
      const p1 = new Plugin();
      await p1.startTrigger(bus, { cwd: process.cwd(), recordFiring: rec, dispatch: async () => {} });
      await until(() => getSchedule(normal.id) === undefined && seen.filter((m) => (m.triggerRun as { id?: number }).id === movedWhileQueued.id).length >= 2, 4000);
      await sleep(150);
      await p1.stop();
      const mN = seen.find((m) => (m.triggerRun as { id?: number }).id === normal.id);
      out.push(
        assert(
          "★★G1 진짜 파사드: 대화 타이머는 **만든 대화의 문**으로 간다(세션 지정·합성·표식 inOrigin·«타이머 #id 실행» 출처 표식) · 끝나면 지운다",
          mN !== undefined && mN.threadKey === A && (mN.session as { explicitSessionId?: string })?.explicitSessionId === A && mN.synthetic === true &&
            (mN.triggerRun as { inOrigin?: boolean; once?: boolean })?.inOrigin === true && (mN.triggerRun as { once?: boolean }).once === true &&
            String(mN.text).startsWith(`〔타이머 #${normal.id} 실행`) && getSchedule(normal.id) === undefined,
          JSON.stringify({ tk: mN?.threadKey, run: mN?.triggerRun, text: String(mN?.text ?? "").slice(0, 40), left: getSchedule(normal.id) !== undefined }),
        ),
      );
      const movedCalls = seen.filter((m) => (m.triggerRun as { id?: number }).id === movedWhileQueued.id).map((m) => m.threadKey);
      out.push(
        assert(
          "★G2·#8 차례 판정: 줄에서 기다리는 사이 **끈** 타이머는 안 돌고 **꺼진 채 남는다**(지우지 않는다) · **옮긴** 타이머는 새 대화에서 한 번 더 돌고 끝나면 지운다",
          getSchedule(offWhileQueued.id)?.enabled === false && records.get(offWhileQueued.id) === undefined &&
            JSON.stringify(movedCalls) === JSON.stringify([A, B]) && getSchedule(movedWhileQueued.id) === undefined,
          JSON.stringify({ off: getSchedule(offWhileQueued.id)?.enabled, offRec: records.get(offWhileQueued.id), movedCalls, movedLeft: getSchedule(movedWhileQueued.id) !== undefined }),
        ),
      );
      out.push(
        assert(
          "★#4 차례가 오기 전에 핸들러가 끝나면(종료 중) **«성공» 으로 세지 않는다** — 기록 0 · 타이머는 켜진 채 남아 다음 부팅에 늦게 운다",
          getSchedule(closing.id)?.enabled === true && records.get(closing.id) === undefined,
          JSON.stringify({ closing: getSchedule(closing.id)?.enabled, rec: records.get(closing.id) }),
        ),
      );

      // ── #3 부팅 창 — 핸들러가 아직 없을 때 온 대화 타이머는 기다렸다 들어간다 ──────────────
      __setMainHandlerForTest(undefined);
      const early = timer("regr-edge-부팅창", 150, A);
      const p2 = new Plugin();
      await p2.startTrigger(bus, { cwd: process.cwd(), recordFiring: rec, dispatch: async () => {} });
      await sleep(500); // 시각은 지났고 핸들러는 아직 없다
      const beforeHandler = getSchedule(early.id) !== undefined && records.get(early.id) === undefined;
      const lateSeen: string[] = [];
      __setMainHandlerForTest(async (m) => { lateSeen.push(m.threadKey ?? ""); if (m.beforeTurn?.() === null) await m.reply("늦게 들어감"); });
      await until(() => getSchedule(early.id) === undefined, 3000);
      await p2.stop();
      out.push(
        assert(
          "★#3 부팅 창: 핸들러 등록 전에 시각이 온 대화 타이머는 **실패로 끝나지 않고 기다렸다** 그 대화에 들어간다",
          beforeHandler && JSON.stringify(lateSeen) === JSON.stringify([A]) && getSchedule(early.id) === undefined,
          JSON.stringify({ beforeHandler, lateSeen, left: getSchedule(early.id) !== undefined }),
        ),
      );

      // ── #1·#2 전용 세션 타이머의 실패 ───────────────────────────────────
      let tries = 0;
      const retryRow = timer("regr-edge-재전송", 60_000, null);
      await runner.runScheduleFiring(retryRow, bus, {
        cwd: process.cwd(), retryDelayMs: 50, recordFiring: rec,
        runClaude: async () => ({ text: "결과" }),
        dispatch: async () => { tries += 1; if (tries === 1) throw new Error("telegram 502"); },
      });
      const keptForRetry = getSchedule(retryRow.id)?.enabled === false;
      await until(() => getSchedule(retryRow.id) === undefined, 2000);
      out.push(
        assert(
          "★★#1 전송 실패한 타이머: 실패로 꺼 둔 채 남기고(재전송을 기다림) **실제로 다시 보낸다** · 되살아나면 지운다 · recovered 이벤트",
          keptForRetry && tries === 2 && getSchedule(retryRow.id) === undefined &&
            published.some((e) => e.type === "scheduler.recovered" && e.payload.scheduleId === retryRow.id),
          JSON.stringify({ keptForRetry, tries, left: getSchedule(retryRow.id) !== undefined }),
        ),
      );
      const since = Date.now() - 1;
      const failing = timer("regr-edge-실패보고", 60_000, null);
      await runner.runScheduleFiring(failing, bus, { cwd: process.cwd(), recordFiring: rec, runClaude: async () => { throw new Error("합성 실패"); }, dispatch: async () => {} });
      const findings = runHealthSweep(since).map((f) => f.summary);
      out.push(
        assert(
          "★★#2 실패한 타이머는 **꺼 둔 채 남아** 자가 진단에 잡힌다(지워서 아무 데도 안 남던 것)",
          getSchedule(failing.id)?.enabled === false && getSchedule(failing.id)?.lastStatus === "error" && findings.some((f) => f.includes("regr-edge-실패보고")),
          JSON.stringify({ row: getSchedule(failing.id)?.lastStatus, findings }),
        ),
      );

      // ── #5·#6·G3·G4·G5 보충 — 데몬이 꺼져 있던 구간만 · 두 길 각각 ─────────────────
      const now = Date.now();
      const backdate = (id: number, createdAt: number, lastFiredAt: number | null): void => {
        getDb().prepare(`UPDATE schedules SET created_at = ?, last_fired_at = ? WHERE id = ?`).run(createdAt, lastFiredAt, id);
      };
      const mkCron = (label: string, createdAgo: number): ScheduleRow => {
        const r = addSchedule({ label, cronExpr: "0 * * * *", prompt: `${label} 지시`, destChannel: "telegram", destTarget: "c" });
        cleanup.push(r.id);
        backdate(r.id, now - createdAgo, null);
        return getSchedule(r.id)!;
      };
      const fired: Array<{ id: number; lateFrom?: number }> = [];
      const fireDeps = { cwd: process.cwd(), recordFiring: () => {}, dispatch: async () => {}, runClaude: async (i: RunInput) => { const t = i.triggerRun as { id: number; lateFrom?: number }; fired.push({ id: t.id, lateFrom: t.lateFrom }); return { text: "" }; } };
      const missed = mkCron("regr-edge-보충대상", 3 * 3_600_000);
      const justMade = mkCron("regr-edge-방금만듦", 0);
      const pastTimer = timer("regr-edge-지난타이머", -3_600_000, null);
      const firedOf = (id: number) => fired.filter((f) => f.id === id);
      const bootRun = async (alive: number | null, handlerAtStart: boolean): Promise<{ beforeBoot: number; afterBoot: number }> => {
        if (alive === null) getDb().prepare(`DELETE FROM scheduler_alive`).run(); else markSchedulerAlive(alive);
        __setMainHandlerForTest(handlerAtStart ? async () => {} : undefined);
        fired.length = 0;
        const p = new Plugin();
        await p.startTrigger(bus, fireDeps);
        await sleep(300);
        const beforeBoot = fired.length;
        __setMainHandlerForTest(async () => {});
        onEvent?.({ type: "daemon.boot" });
        await sleep(300);
        const afterBoot = fired.length;
        await p.stop();
        return { beforeBoot, afterBoot };
      };
      // 부팅: 직전 생존 2시간 전 · 핸들러 없음 → 부팅 전엔 아무것도 안 돌고(G4), daemon.boot 에서 보충(G3)
      const boot = await bootRun(now - 2 * 3_600_000, false);
      const missedFired = firedOf(missed.id);
      const topOfHour = new Date(now); topOfHour.setMinutes(0, 0, 0);
      out.push(
        assert(
          "★★G3·G4 부팅 길: 핸들러가 없으면 **부팅이 끝나기 전엔 보충하지 않고**(지난 타이머 포함) `daemon.boot` 에서 한다 · 꺼져 있던 구간의 정시 한 번(늦게 표식) · G5 직전 정시 뒤에 만든 것은 보충 안 함",
          boot.beforeBoot === 0 && missedFired.length === 1 && missedFired[0]!.lateFrom === topOfHour.getTime() && firedOf(justMade.id).length === 0 &&
            firedOf(pastTimer.id).length === 1,
          JSON.stringify({ boot, missed: missedFired, justMade: firedOf(justMade.id).length, past: firedOf(pastTimer.id) }),
        ),
      );
      // 재시작 길: 핸들러가 이미 있다(플러그인만 다시 시작) → daemon.boot 없이 바로 · 그러나 살아 있던 동안(직전 생존 = 방금)의 정시는 놓친 게 아니다
      backdate(missed.id, now - 3 * 3_600_000, null); // 위에서 돈 기록은 모의라 남지 않았다 — 같은 조건
      const restartAlive = await bootRun(Date.now() - 1000, true);
      const aliveFired = firedOf(missed.id).length;
      const noAlive = await bootRun(null, true);
      out.push(
        assert(
          "★★#5·#6 보충은 **데몬이 꺼져 있던 구간**만 — 직전까지 살아 있었으면(그 정시에 `/stop` 했거나 꺼 뒀던 것) 다시 돌리지 않는다 · 생존 기록이 없으면(업데이트 직후) 보충하지 않는다",
          aliveFired === 0 && noAlive.beforeBoot + noAlive.afterBoot === 0 && restartAlive.beforeBoot === 0,
          JSON.stringify({ restartAlive, aliveFired, noAlive }),
        ),
      );
      // M15 재시작 길 자체: 핸들러가 있고 꺼져 있던 구간에 정시가 있으면 daemon.boot 없이 바로 보충한다
      backdate(missed.id, now - 3 * 3_600_000, null);
      markSchedulerAlive(now - 2 * 3_600_000);
      __setMainHandlerForTest(async () => {});
      fired.length = 0;
      const p3 = new Plugin();
      await p3.startTrigger(bus, fireDeps);
      await sleep(300);
      const immediate = firedOf(missed.id).length;
      await p3.stop();
      out.push(
        assert(
          "G3' 플러그인만 다시 시작한 길(핸들러 이미 있음)은 `daemon.boot` 을 기다리지 않고 바로 보충한다",
          immediate === 1,
          JSON.stringify({ immediate }),
        ),
      );

      // ── G6 먼 타이머 — setTimeout 상한을 넘는 시각은 나눠 기다린다(회전 루프 0) ─────────────────
      const warnings: string[] = [];
      const onWarn = (w: Error) => { warnings.push(w.name); };
      process.on("warning", onWarn);
      const far = timer("regr-edge-먼타이머", 30 * 86_400_000, null);
      fired.length = 0;
      const p4 = new Plugin();
      await p4.startTrigger(bus, fireDeps);
      await sleep(300);
      await p4.stop();
      process.off("warning", onWarn);
      out.push(
        assert(
          "G6 30일 뒤 타이머: 울리지 않고, 타이머 상한 경고(TimeoutOverflowWarning)도 없다 — 상한을 넘기면 1ms 마다 다시 거는 회전 루프가 된다",
          firedOf(far.id).length === 0 && !warnings.includes("TimeoutOverflowWarning") && getSchedule(far.id) !== undefined,
          JSON.stringify({ fired: firedOf(far.id).length, warnings }),
        ),
      );

      // ── G7·G9 전용 세션 줄의 옮겨짐 · 다시 돌 때 켜짐 확인 ─────────────────────────
      const queued = async (mutate: (id: number) => void) => {
        const r = timer("regr-edge-전용줄", 60_000, null);
        const inputs: RunInput[] = [];
        let rel: () => void = () => {};
        const g = new Promise<void>((x) => (rel = x));
        const head = enqueueThreadTurn(`scheduler:${r.id}`, async () => { await g; });
        const f = runner.runScheduleFiring(r, bus, { cwd: process.cwd(), recordFiring: () => {}, dispatch: async () => {}, runClaude: async (i: RunInput) => { inputs.push(i); return { text: "", inOrigin: { replied: 1 } }; } });
        await sleep(30);
        mutate(r.id);
        rel();
        await Promise.all([head, f]);
        await sleep(100);
        return inputs;
      };
      const g7 = await queued((id) => updateSchedule(id, { originThreadKey: B } as never));
      const g9 = await queued((id) => { updateSchedule(id, { originThreadKey: B } as never); updateSchedule(id, { enabled: false }); });
      // 대화 갈래가 «옮겨짐» 을 돌려준 직후 사용자가 껐다 — 새 자리에서 다시 돌지 않는다.
      const raceRow = timer("regr-edge-옮긴뒤끔", 60_000, A);
      let raceCalls = 0;
      await runner.runScheduleFiring(raceRow, bus, { cwd: process.cwd(), recordFiring: () => {}, dispatch: async () => {}, runClaude: async () => {
        raceCalls += 1;
        if (raceCalls === 1) { updateSchedule(raceRow.id, { originThreadKey: B, enabled: false } as never); return { text: "", skipped: "moved" }; }
        return { text: "", inOrigin: { replied: 1 } };
      } });
      await sleep(100);
      out.push(
        assert(
          "G7 전용 세션 줄에서 기다리는 사이 «이 대화로 옮겨 줘» 를 받으면 그 줄에선 안 돌고 **옮긴 대화에서** 한 번 · G9 그새(옮긴 직후 포함) 꺼졌으면 다시 돌지 않는다",
          g7.length === 1 && g7[0]!.originThreadKey === B && g9.length === 0 && raceCalls === 1,
          JSON.stringify({ g7: g7.map((i) => i.originThreadKey), g9: g9.length, raceCalls }),
        ),
      );

      // ── G8·#7 켜기·수정의 타이머 갈래 ─────────────────────────────────────
      __setMainHandlerForTest(async () => {});
      markSchedulerAlive(Date.now());
      const offSoon = timer("regr-edge-켜면울림", 400, null, { enabled: false });
      const offSoon2 = timer("regr-edge-수정으로켬", 400, null, { enabled: false });
      const pastOff = timer("regr-edge-지난걸켬", -60_000, null, { enabled: false });
      fired.length = 0;
      const p5 = new Plugin();
      await p5.startTrigger(bus, fireDeps);
      updateSchedule(offSoon.id, { enabled: true });
      onEvent?.({ type: "scheduler.toggle", payload: { id: offSoon.id, action: "enable" } });
      const viaTool = await call(tools(null), "update_schedule", { id: offSoon2.id, enabled: true });
      const pastRefused = await call(tools(null), "update_schedule", { id: pastOff.id, enabled: true });
      await until(() => firedOf(offSoon.id).length > 0 && firedOf(offSoon2.id).length > 0, 2000);
      await p5.stop();
      out.push(
        assert(
          "G8 꺼 둔 타이머를 켜면(`/schedule enable` 토글·`update_schedule enabled`) **타이머로** 다시 걸려 시각에 운다 · #7 시각이 지난 타이머는 켜기를 거절한다",
          firedOf(offSoon.id).length === 1 && firedOf(offSoon2.id).length === 1 && viaTool.ok === true &&
            pastRefused.error === "timer_past" && getSchedule(pastOff.id)?.enabled === false,
          JSON.stringify({ toggle: firedOf(offSoon.id).length, tool: firedOf(offSoon2.id).length, viaTool: viaTool.ok, pastRefused: pastRefused.error }),
        ),
      );

      // ── G9 도구 거절·옮기면 keep_runs 비움 ───────────────────────────────
      const dest = listOutboundChannels()[0] ?? "http-bridge";
      const own = await call(tools(null), "add_schedule", { label: "regr-edge-도구", cron_expr: "0 8 * * *", prompt: "p", dest_channel: dest, keep_runs: 3 });
      if (typeof own.id === "number") cleanup.push(own.id);
      const moved = await call(tools(A), "update_schedule", { id: own.id, move_here: true });
      const keepAfterMove = getSchedule(own.id as number)?.keepRuns;
      const keepRefused = await call(tools(A), "update_schedule", { id: own.id, keep_runs: 2 });
      const tmr = timer("regr-edge-도구타이머", 600_000, A);
      const cronRefused = await call(tools(A), "update_schedule", { id: tmr.id, cron_expr: "0 9 * * *" });
      out.push(
        assert(
          "G9 도구: 옮기면 keep_runs 를 비운다 · 대화 스케줄에 keep_runs 를 다시 주면 거절 · 타이머의 cron_expr 변경 거절",
          own.ok === true && moved.ok === true && keepAfterMove === null && keepRefused.error === "keep_runs_with_origin" && cronRefused.error === "timer_fixed",
          JSON.stringify({ own: own.ok, moved: moved.ok, keepAfterMove, keepRefused: keepRefused.error, cronRefused: cronRefused.error }),
        ),
      );
      // ── 아스트라 P1 — 줄에서 기다리는 사이 바뀐 지시·목적지를 **그 턴이** 쓴다(진짜 파사드·공통 이음) ─────────────
      const changeWhileQueued = async (patch: Partial<ScheduleRow>) => {
        const r = timer("regr-edge-대기중변경", 200, A);
        updateSchedule(r.id, { prompt: "OLD PROMPT", destTarget: "OLD" } as never);
        const got: { text?: string; notify?: unknown; replyTarget?: unknown } = {};
        delivered.length = 0;
        __setMainHandlerForTest(async (m) => {
          updateSchedule(r.id, patch as never);
          if (m.beforeTurn?.() !== null) return;
          got.text = m.text;
          got.notify = m.notifyDest;
          got.replyTarget = m.replyTarget;
          await m.reply("합성 답");
        });
        const p = new Plugin();
        await p.startTrigger(bus, { cwd: process.cwd(), recordFiring: () => {}, dispatch: async () => {} });
        await until(() => getSchedule(r.id) === undefined, 3000);
        await p.stop();
        const firedEv = published.filter((e) => e.type === "scheduler.fired" && e.payload.scheduleId === r.id).map((e) => e.payload.destTarget);
        return { text: String(got.text ?? "").split("\n").slice(1).join("\n"), notify: got.notify, replyTarget: got.replyTarget, sentTo: delivered.map((d) => d.target), firedEv };
      };
      const onlyPrompt = await changeWhileQueued({ prompt: "NEW PROMPT" });
      const onlyDest = await changeWhileQueued({ destTarget: "NEW" });
      const both = await changeWhileQueued({ prompt: "NEW PROMPT", destTarget: "NEW" });
      const t = (x: { target?: unknown } | undefined) => (x as { target?: unknown } | undefined)?.target;
      out.push(
        assert(
          "★★아스트라 P1 줄에서 기다리는 사이 바뀐 **지시·목적지를 그 턴이 쓴다** — 지시만·목적지만·둘 다: 실행한 글·통지 좌표·답의 실제 좌표·실제 배달처·성공 기록의 목적지가 모두 새 값",
          onlyPrompt.text === "NEW PROMPT" && JSON.stringify(onlyPrompt.sentTo) === JSON.stringify(["OLD"]) &&
            onlyDest.text === "OLD PROMPT" && JSON.stringify(onlyDest.sentTo) === JSON.stringify(["NEW"]) && t(onlyDest.notify as never) === "NEW" && t(onlyDest.replyTarget as never) === "NEW" &&
            both.text === "NEW PROMPT" && JSON.stringify(both.sentTo) === JSON.stringify(["NEW"]) &&
            // 성공 기록(scheduler.fired)의 목적지도 **실제로 보낸 곳**(아스트라 재검토 10-20 — 넣기 전 스냅샷이 남던 것)
            JSON.stringify(onlyDest.firedEv) === JSON.stringify(["NEW"]) && JSON.stringify(onlyPrompt.firedEv) === JSON.stringify(["OLD"]),
          JSON.stringify({ onlyPrompt, onlyDest, both }),
        ),
      );

      // ── 재검토 G1 — `/stop` 한 타이머는 끝난 것(두 갈래 모두 지운다 — 남기면 다음 부팅에 다시 운다) ─────────────
      const stopIn = timer("regr-edge-중지대화", 60_000, A);
      await runner.runScheduleFiring(stopIn, bus, { cwd: process.cwd(), recordFiring: () => {}, dispatch: async () => {}, runClaude: async () => { throw new UserCancelledError(); } });
      const stopOwn = timer("regr-edge-중지전용", 60_000, null);
      await runner.runScheduleFiring(stopOwn, bus, { cwd: process.cwd(), recordFiring: () => {}, dispatch: async () => {}, runClaude: async () => { throw new UserCancelledError(); } });
      out.push(
        assert(
          "G1(재검토) `/stop` 으로 멈춘 타이머는 **끝난 것** — 대화 갈래·전용 갈래 모두 지운다(실패로 남기지도, 켜 둔 채 두지도 않는다)",
          getSchedule(stopIn.id) === undefined && getSchedule(stopOwn.id) === undefined,
          JSON.stringify({ inLeft: getSchedule(stopIn.id) !== undefined, ownLeft: getSchedule(stopOwn.id) !== undefined }),
        ),
      );

      // ── 재검토 G3·#7 — `/schedule enable` 을 실제로 부른다 ─────────────────────────
      const slashReply: string[] = [];
      const slashMsg = { channel: "cli", threadKey: "cli:regr-edge", reply: async (txt: string) => { slashReply.push(txt); } };
      const pastOff2 = timer("regr-edge-슬래시지난", -60_000, null, { enabled: false });
      const futureOff = timer("regr-edge-슬래시미래", 600_000, null, { enabled: false });
      await handleSchedule({ msg: slashMsg, args: `enable ${pastOff2.id}`, trimmed: "", sidChannel: "cli" } as never);
      await handleSchedule({ msg: slashMsg, args: `enable ${futureOff.id}`, trimmed: "", sidChannel: "cli" } as never);
      out.push(
        assert(
          "G3(재검토) `/schedule enable`: 시각이 지난 타이머는 **켜지 않고** 이유를 말한다 · 아직 안 온 타이머는 켠다",
          getSchedule(pastOff2.id)?.enabled === false && slashReply[0] !== undefined && slashReply[0].includes(String(pastOff2.id)) &&
            getSchedule(futureOff.id)?.enabled === true,
          JSON.stringify({ past: getSchedule(pastOff2.id)?.enabled, future: getSchedule(futureOff.id)?.enabled, slashReply }),
        ),
      );
      updateSchedule(futureOff.id, { enabled: false });

      // ── 재검토 R2 — 꺼진 스케줄은 «지금 실행» 을 거절한다 ─────────────────────────
      const runOff = await call(tools(null), "run_schedule", { id: pastOff2.id });
      out.push(
        assert(
          "R2(재검토) 꺼진(실패로 꺼 둔 것 포함) 스케줄에 `run_schedule` → «시작했다» 가 아니라 거절 + 다시 거는 법",
          runOff.ok === false && runOff.error === "disabled" && String(runOff.note ?? "").includes("add_schedule"),
          JSON.stringify(runOff),
        ),
      );

      // ── 재검토 G4·R1 — 생존 박동은 보충을 마친 뒤 시작하고, 도는 동안 전진하고, 멈출 때 적는다 ─────────────
      const OLD_ALIVE = Date.now() - 5 * 3_600_000;
      markSchedulerAlive(OLD_ALIVE);
      __setMainHandlerForTest(undefined);
      const p6 = new Plugin();
      await p6.startTrigger(bus, { ...fireDeps, aliveBeatMs: 40 });
      await sleep(200);
      const beforeCatchUp = schedulerLastAlive();
      await p6.stop();
      const afterStopNoBeat = schedulerLastAlive();
      __setMainHandlerForTest(async () => {});
      const p7 = new Plugin();
      await p7.startTrigger(bus, { ...fireDeps, aliveBeatMs: 40 });
      const a1 = schedulerLastAlive() ?? 0;
      await sleep(200);
      const a2 = schedulerLastAlive() ?? 0;
      await sleep(20);
      const stopAt = Date.now();
      await p7.stop();
      const a3 = schedulerLastAlive() ?? 0;
      out.push(
        assert(
          "★R1·G4(재검토) 보충 전(핸들러 없음·daemon.boot 전)엔 생존 시각을 **덮지 않는다**(그 부팅이 죽어도 다음 부팅이 보충 몫을 안 잃게) · 보충 뒤엔 박동이 **전진**하고 · 멈출 때 적는다",
          beforeCatchUp === OLD_ALIVE && afterStopNoBeat === OLD_ALIVE && a1 > OLD_ALIVE && a2 > a1 && a3 >= stopAt,
          JSON.stringify({ beforeCatchUp: beforeCatchUp === OLD_ALIVE, afterStopNoBeat: afterStopNoBeat === OLD_ALIVE, a1, a2, a3, stopAt }),
        ),
      );
      // ── 종류 판정 한 곳(2026-10-21, 외부 인스턴스 보고) — reboot 을 추가하면 `new Cron('')` 이 실패해 거짓 «스케줄 실행 실패» 알림이 나갔다 ─────
      published.length = 0;
      __setMainHandlerForTest(async () => {});
      const p8 = new Plugin() as Plugin & { startSchedule: (id: number) => boolean };
      fired.length = 0;
      await p8.startTrigger(bus, fireDeps);
      const addTools = tools(null);
      const rb = await call(addTools, "add_schedule", { label: "regr-edge-부팅", trigger_type: "reboot", prompt: "p", dest_channel: dest });
      const cr = await call(addTools, "add_schedule", { label: "regr-edge-정기", cron_expr: "0 8 * * *", prompt: "p", dest_channel: dest });
      for (const r of [rb, cr]) if (typeof r.id === "number") cleanup.push(r.id);
      const rbUpd = await call(addTools, "update_schedule", { id: rb.id, label: "regr-edge-부팅2" });
      const crToRb = await call(addTools, "update_schedule", { id: cr.id, trigger_type: "reboot" });
      const rbToCr = await call(addTools, "update_schedule", { id: rb.id, trigger_type: "cron", cron_expr: "0 9 * * *" });
      onEvent?.({ type: "scheduler.toggle", payload: { id: cr.id, action: "enable" } }); // cr 은 지금 reboot — 토글로도 cron('') 을 걸지 않는다
      const offT = timer("regr-edge-외부켜기", 300, null, { enabled: false });
      const viaStart = p8.startSchedule(offT.id);
      await until(() => firedOf(offT.id).length > 0, 2000);
      await p8.stop();
      const registerErrors = published.filter((e) => e.type === "scheduler.error" && e.payload.phase === "register");
      out.push(
        assert(
          "★reboot 을 추가·수정·토글해도, cron↔reboot 을 바꿔도 **등록 실패 이벤트 0건**(거짓 «스케줄 실행 실패» 0) · 외부용 `startSchedule` 로 켠 타이머는 cron 이 아니라 **타이머로** 걸려 운다",
          rb.ok === true && cr.ok === true && rbUpd.ok === true && crToRb.ok === true && rbToCr.ok === true &&
            registerErrors.length === 0 && viaStart === true && firedOf(offT.id).length === 1,
          JSON.stringify({ registerErrors: registerErrors.map((e) => e.payload), viaStart, fired: firedOf(offT.id).length, rb: rb.ok, cr: cr.ok, rbUpd: rbUpd.ok, crToRb: crToRb.ok, rbToCr: rbToCr.ok }),
        ),
      );
      void isConversationLive;
    } finally {
      __setMainHandlerForTest(prevHandler);
      unregisterChannelOutbound("regr-edge");
      for (const id of cleanup) deleteSchedule(id);
    }
    return out;
  },
};
