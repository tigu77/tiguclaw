/**
 * 회귀: **스케줄이 타이머까지 — 한 번 울리는 타이머 · 만든 대화에서 처리 · 놓친 실행 보충** (2026-10-20 정태님 — 설계 docs/decisions/2026-10-20-schedule-timers-design.md).
 *
 * 정태님: *«스케쥴이 다 커버한다»* · *«일회성은 그냥 사라지는 게 낫다»* · *«반복타이머가 없는게 나으려나?»* · *«최소 1분 이상이어야지»*.
 * 지키는 것:
 *  ① 도구: `once` 는 지금부터 1분 이상 · 등록 대화는 **서버가** 적는다 · 대화 스케줄엔 keep_runs 거절 · 목록에 kind·runs_in · 타이머 시각·종류는 못 바꾼다 · move_here
 *  ② 실행기: 타이머는 울린 뒤 **지운다**(성공·실패 모두) · 만든 대화면 그 문으로(답 재배달 0) · 기다리는 사이 옮겨졌으면 새 자리에서 다시 한 번
 *  ③ 플러그인: 타이머가 시각에 울린다 · 꺼져 있던 동안 지난 것은 **24시간 안 마지막 한 번만**(늦게 표식) · 그보다 오랜 타이머는 지운다
 *  ④ 저장: 옛 표(`cron`·`reboot` 만 허용)를 다시 만들어 `once` 를 받는다 — 행·순번 보존
 *  ⑤ 맥락 줄: 타이머는 «한 번 울리고 지워진다 · 아직이면 다음 한 번을 다시 걸어라» · 늦은 실행은 «늦게» · ⑥ 인벤토리는 타이머를 안 센다(배선)
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { listOutboundChannels } from "../../core/channel-outbound.js";
import { triggerRunLine } from "../../core/prompt-assembly.js";
import { getDb, initStore } from "../../store/sessions.js";
import { addSchedule, deleteSchedule, getSchedule, markSchedulerAlive, updateSchedule } from "../../store/schedules.js";
import { readSourceSync } from "./_wiring.js";
import { assert, assertIsolated, loadPluginModule, type Assertion, type RegressionCheck } from "./_framework.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const ORIGIN = "dashboard:regr-timer";
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 3000): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(20);
  }
  return cond();
};

type Tools = Record<string, { handler: (a: unknown, e: unknown) => Promise<{ content: { text: string }[] }> }>;
type RunInput = { text: string; threadKey: string; channel: string; triggerRun?: Record<string, unknown>; originThreadKey?: string | null; notifyDest?: unknown };
type Runner = { runScheduleFiring: (row: unknown, bus: unknown, deps: unknown, opts?: unknown) => Promise<void> };

export const check: RegressionCheck = {
  name: "schedule-timers",
  guards:
    "«10분 뒤 확인해 줘» 를 하려면 매일 cron 을 만들었다 지워야 했고, 스케줄은 맥락 없는 전용 세션에서 돌았고, 꺼져 있던 동안 지난 실행은 그냥 사라지던 것",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    initStore();
    const out: Assertion[] = [];
    const made: number[] = [];
    const bus = { publish: () => {}, subscribe: () => () => {} };

    // ── ① 도구(진짜 저장소) ──────────────────────────────────────────────
    const mcp = await loadPluginModule<{ createSchedulerMcpServer: (h?: unknown) => { instance: unknown } }>("../../../plugins/scheduler/src/mcp.js");
    const toolsAt = (session: string | null): Tools =>
      (mcp.createSchedulerMcpServer({ turnSession: () => session }).instance as { _registeredTools: Tools })._registeredTools;
    const call = async (t: Tools, name: string, args: unknown) => {
      const text = (await t[name]!.handler(args, {})).content[0]!.text;
      try { return JSON.parse(text) as Record<string, unknown>; } catch { return { raw: text } as Record<string, unknown>; }
    };
    // 목적지 채널 검증(등록된 채널만) — 스위트 안에선 앞 검사들이 등록한 채널이 있어, 있으면 그중 하나를 쓴다.
    const base = { label: "regr-타이머", prompt: "빌드 확인", dest_channel: listOutboundChannels()[0] ?? "http-bridge", dest_target: ORIGIN };
    const t0 = Date.now();
    const inChat = await call(toolsAt(ORIGIN), "add_schedule", { ...base, trigger_type: "once", in_minutes: 1 });
    const fromNowhere = await call(toolsAt(null), "add_schedule", { ...base, trigger_type: "once", run_at: new Date(Date.now() + 5 * 60_000).toISOString() });
    const tooSoon = await call(toolsAt(ORIGIN), "add_schedule", { ...base, trigger_type: "once", run_at: new Date(Date.now() + 30_000).toISOString() });
    const noWhen = await call(toolsAt(ORIGIN), "add_schedule", { ...base, trigger_type: "once" });
    const keepRefused = await call(toolsAt(ORIGIN), "add_schedule", { ...base, cron_expr: "0 8 * * *", keep_runs: 0 });
    for (const r of [inChat, fromNowhere]) if (typeof r.id === "number") made.push(r.id);
    const row = getSchedule(inChat.id as number);
    out.push(
      assert(
        "★★`once` 는 **지금부터 1분 이상** — in_minutes 1 은 받고 30초 뒤는 거절 · 시각이 없으면 거절 · 등록 대화는 **서버가** 적는다(사람 없는 자리면 전용 세션) · 대화 스케줄엔 keep_runs 거절",
        inChat.ok === true && row?.triggerType === "once" && row.originThreadKey === ORIGIN && row.runAt !== null &&
          row.runAt >= t0 + 60_000 && row.runAt <= Date.now() + 60_000 && inChat.runs_in === "this_conversation" &&
          fromNowhere.ok === true && fromNowhere.runs_in === "own_session" && getSchedule(fromNowhere.id as number)?.originThreadKey === null &&
          tooSoon.error === "too_soon" && noWhen.error === "missing_when" && keepRefused.error === "keep_runs_with_origin",
        JSON.stringify({ inChat, row: { t: row?.triggerType, o: row?.originThreadKey, in: row?.runAt === null || row?.runAt === undefined ? null : row.runAt - t0 }, fromNowhere, tooSoon: tooSoon.error, noWhen: noWhen.error, keepRefused: keepRefused.error }),
      ),
    );
    const listed = ((await call(toolsAt(ORIGIN), "list_schedules", {})).schedules ?? (await call(toolsAt(ORIGIN), "list_schedules", {})).items) as Array<Record<string, unknown>> | undefined;
    const mine = listed?.find((s) => s.id === inChat.id);
    const fixed = await call(toolsAt(ORIGIN), "update_schedule", { id: inChat.id, trigger_type: "cron", cron_expr: "0 8 * * *" });
    const moved = await call(toolsAt("dashboard:regr-other"), "update_schedule", { id: fromNowhere.id, move_here: true });
    const moveNowhere = await call(toolsAt(null), "update_schedule", { id: inChat.id, move_here: true });
    out.push(
      assert(
        "목록이 kind(timer)·runs_in·울릴 시각을 보여 준다(멈추려면 알아야 한다) · 타이머의 시각·종류는 못 바꾼다 · move_here 는 이 수정을 부른 대화로만",
        mine?.kind === "timer" && mine.runs_in === ORIGIN && typeof mine.next_run === "string" && fixed.error === "timer_fixed" &&
          getSchedule(inChat.id as number)?.triggerType === "once" && moved.ok === true &&
          getSchedule(fromNowhere.id as number)?.originThreadKey === "dashboard:regr-other" && moveNowhere.error === "no_conversation",
        JSON.stringify({ mine, fixed: fixed.error, moved: moved.ok, moveNowhere: moveNowhere.error }),
      ),
    );

    // ── ② 실행기(진짜 실행기 + 진짜 저장소) ──────────────────────────────
    const runner = await loadPluginModule<Runner>("../../../plugins/scheduler/src/runner.ts");
    const fireWith = async (r: unknown, runClaude: (i: RunInput) => Promise<Record<string, unknown>>, opts?: unknown) => {
      const seen = { inputs: [] as RunInput[], dispatched: 0, records: [] as Array<{ ok: boolean }> };
      await runner.runScheduleFiring(r, bus, {
        cwd: repo,
        recordFiring: (_id: number, v: { ok: boolean }) => seen.records.push(v),
        dispatch: async () => { seen.dispatched += 1; },
        runClaude: async (i: RunInput) => { seen.inputs.push(i); return runClaude(i); },
      }, opts);
      return seen;
    };
    const timerRow = (origin: string | null) => addSchedule({ label: "regr-울림", cronExpr: "", prompt: "확인", destChannel: "telegram", destTarget: "c", triggerType: "once", runAt: Date.now() + 60_000, originThreadKey: origin });
    const own = timerRow(null);
    const ownSeen = await fireWith(own, async () => ({ text: "끝났습니다" }));
    const ownFail = timerRow(null);
    const failSeen = await fireWith(ownFail, async () => { throw new Error("합성 실패"); });
    out.push(
      assert(
        "★★타이머는 울려서 끝나면 **지운다** · 실패면 **꺼 둔 채 남긴다**(last_status=error — 자가 진단이 알리고 사용자가 지운다, 적대 검토 #2) · 전용 세션 타이머의 답은 실행기가 목적지로 보낸다 · 표식 once",
        getSchedule(own.id) === undefined && getSchedule(ownFail.id)?.enabled === false && failSeen.records[0]?.ok === false && ownSeen.dispatched === 1 &&
          ownSeen.inputs[0]?.threadKey === `scheduler:${own.id}` && ownSeen.inputs[0]?.triggerRun?.once === true,
        JSON.stringify({ ownLeft: getSchedule(own.id) !== undefined, fail: { enabled: getSchedule(ownFail.id)?.enabled, records: failSeen.records }, dispatched: ownSeen.dispatched, input: ownSeen.inputs[0] }),
      ),
    );
    const inO = timerRow(ORIGIN);
    const lateFrom = Date.now() - 3_600_000;
    const oSeen = await fireWith(inO, async () => ({ text: "", inOrigin: { replied: 12 } }), { lateFrom });
    const oi = oSeen.inputs[0];
    out.push(
      assert(
        "★★만든 대화 타이머는 그 대화 키·`originThreadKey` 로 파사드에 간다(이력 정책·전용 세션 줄 없음) · 답은 이미 나갔으니 **다시 안 보낸다** · 늦은 실행 표식 · 울린 뒤 지운다",
        oi?.threadKey === ORIGIN && oi.originThreadKey === ORIGIN && oi.triggerRun?.once === true && oi.triggerRun?.lateFrom === lateFrom &&
          oSeen.dispatched === 0 && oSeen.records[0]?.ok === true && getSchedule(inO.id) === undefined,
        JSON.stringify({ oi, dispatched: oSeen.dispatched, records: oSeen.records, left: getSchedule(inO.id) !== undefined }),
      ),
    );
    // 기다리는 사이 옮겨졌다 — 이 자리에선 안 돌고 새 자리에서 다시 한 번(그 뒤에 지운다).
    const mv = timerRow(ORIGIN);
    let calls = 0;
    const mvSeen = await fireWith(mv, async () => {
      calls += 1;
      if (calls === 1) { updateSchedule(mv.id, { originThreadKey: "dashboard:regr-new" } as never); return { text: "", skipped: "moved" }; }
      return { text: "", inOrigin: { replied: 3 } };
    });
    await until(() => calls >= 2 && getSchedule(mv.id) === undefined, 2000);
    out.push(
      assert(
        "기다리는 사이 처리 자리가 바뀌면(`moved`) **새 자리에서 다시 한 번** — 첫 시도에선 지우지 않는다(지우면 타이머가 사라진다)",
        mvSeen.inputs[0]?.threadKey === ORIGIN && calls === 2 && getSchedule(mv.id) === undefined,
        JSON.stringify({ calls, first: mvSeen.inputs[0]?.threadKey, left: getSchedule(mv.id) !== undefined }),
      ),
    );
    // 옮긴 자리에서도 또 «옮겨짐» 이면 **한 번만** 다시 돌고 멈춘다(두 갈래가 어긋나면 끝없이 돌던 것 — 변이 실측). 5번째에서 모의가 스스로 멈춰 검사가 매달리지 않게.
    const loop = timerRow(ORIGIN);
    let loopCalls = 0;
    const loopSeen = await fireWith(loop, async () => (++loopCalls >= 5 ? { text: "", inOrigin: { replied: 1 } } : { text: "", skipped: "moved" }));
    await sleep(150);
    out.push(
      assert(
        "★다시 도는 건 **한 번만** — 두 번째도 «옮겨짐» 이면 멈춘다(무한 재발화 0) · 그 타이머는 실패로 꺼 둔다(보이게)",
        loopCalls === 2 && getSchedule(loop.id)?.enabled === false && loopSeen.records.some((r) => r.ok === false),
        JSON.stringify({ loopCalls, enabled: getSchedule(loop.id)?.enabled, records: loopSeen.records }),
      ),
    );
    const cronO = addSchedule({ label: "regr-대화정기", cronExpr: "0 8 * * *", prompt: "보고", destChannel: "telegram", destTarget: "c", originThreadKey: ORIGIN });
    made.push(cronO.id);
    const cSeen = await fireWith(cronO, async () => ({ text: "", inOrigin: { replied: 5 } }));
    out.push(
      assert(
        "대화에서 처리되는 **정기** 스케줄은 울려도 남는다(지우는 건 타이머만) · 표식에 once 없음",
        getSchedule(cronO.id) !== undefined && cSeen.inputs[0]?.threadKey === ORIGIN && cSeen.inputs[0]?.triggerRun?.once === undefined,
        JSON.stringify({ left: getSchedule(cronO.id) !== undefined, run: cSeen.inputs[0]?.triggerRun }),
      ),
    );

    // ── ③ 플러그인 — 시각에 울림 · 놓친 실행 보충 ───────────────────────────
    const now = Date.now();
    const backdate = (id: number, createdAt: number, lastFiredAt: number | null): void => {
      getDb().prepare(`UPDATE schedules SET created_at = ?, last_fired_at = ? WHERE id = ?`).run(createdAt, lastFiredAt, id);
    };
    const hourly = addSchedule({ label: "regr-놓친정기", cronExpr: "0 * * * *", prompt: "놓친 정기", destChannel: "telegram", destTarget: "c" });
    backdate(hourly.id, now - 3 * 3_600_000, null);
    const ranAlready = addSchedule({ label: "regr-이미돈정기", cronExpr: "0 * * * *", prompt: "이미 돈 정기", destChannel: "telegram", destTarget: "c" });
    backdate(ranAlready.id, now - 3 * 3_600_000, now);
    const yearly = addSchedule({ label: "regr-오래된정기", cronExpr: "0 0 1 1 *", prompt: "오래된 정기", destChannel: "telegram", destTarget: "c" });
    backdate(yearly.id, now - 800 * 86_400_000, null);
    const pastDue = addSchedule({ label: "regr-지난타이머", cronExpr: "", prompt: "지난 타이머", destChannel: "telegram", destTarget: "c", triggerType: "once", runAt: now - 2 * 3_600_000 });
    const tooOld = addSchedule({ label: "regr-오랜타이머", cronExpr: "", prompt: "오랜 타이머", destChannel: "telegram", destTarget: "c", triggerType: "once", runAt: now - 25 * 3_600_000 });
    const soon = addSchedule({ label: "regr-곧타이머", cronExpr: "", prompt: "곧 타이머", destChannel: "telegram", destTarget: "c", triggerType: "once", runAt: now + 300 });
    made.push(hourly.id, ranAlready.id, yearly.id);
    const ours = new Set([hourly.id, ranAlready.id, yearly.id, pastDue.id, tooOld.id, soon.id]);
    const fired: RunInput[] = [];
    let onEvent: ((e: { type: string; payload?: unknown }) => void) | undefined;
    const pbus = { publish: () => {}, subscribe: (fn: typeof onEvent) => { onEvent = fn; return () => {}; } };
    const Plugin = (await loadPluginModule<{ default: new () => { startTrigger: (b: unknown, d?: unknown) => Promise<void>; stop: () => Promise<void> } }>("../../../plugins/scheduler/src/index.ts")).default;
    const plugin = new Plugin();
    // 직전 생존 = 2시간 전 → 그 뒤의 예정 시각만 «놓친 것»(적대 검토 #5·#6). 이번 정시는 그 안에 있다.
    markSchedulerAlive(now - 2 * 3_600_000);
    try {
      await plugin.startTrigger(pbus, {
        cwd: repo,
        recordFiring: () => {},
        dispatch: async () => {},
        runClaude: async (i: RunInput) => {
          const id = (i.triggerRun as { id?: number } | undefined)?.id;
          if (id !== undefined && ours.has(id)) fired.push(i);
          return { text: "" };
        },
      });
      onEvent?.({ type: "daemon.boot" });
      await until(() => fired.length >= 3 && getSchedule(soon.id) === undefined, 3000);
      await sleep(100);
    } finally {
      await plugin.stop();
    }
    const firedOf = (id: number) => fired.filter((f) => (f.triggerRun as { id?: number }).id === id);
    const h = firedOf(hourly.id);
    const pd = firedOf(pastDue.id);
    const sn = firedOf(soon.id);
    const topOfHour = new Date(now); topOfHour.setMinutes(0, 0, 0);
    out.push(
      assert(
        "★★꺼져 있던 동안 놓친 정기 실행은 **켜진 뒤 한 번만**(원래 시각을 늦게 표식으로) · 이미 돈 것·24시간보다 오랜 것은 보충 안 함",
        h.length === 1 && (h[0]!.triggerRun as { lateFrom?: number }).lateFrom === topOfHour.getTime() &&
          firedOf(ranAlready.id).length === 0 && firedOf(yearly.id).length === 0,
        JSON.stringify({ hourly: h.map((f) => f.triggerRun), ranAlready: firedOf(ranAlready.id).length, yearly: firedOf(yearly.id).length }),
      ),
    );
    out.push(
      assert(
        "★★타이머가 시각에 울리고 지워진다 · 지난 타이머는 24시간 안이면 **늦게 한 번**(늦게 표식) · 24시간보다 오래면 울리지 않고 지운다",
        sn.length === 1 && (sn[0]!.triggerRun as { lateFrom?: number }).lateFrom === undefined && getSchedule(soon.id) === undefined &&
          pd.length === 1 && (pd[0]!.triggerRun as { lateFrom?: number }).lateFrom === pastDue.runAt && getSchedule(pastDue.id) === undefined &&
          firedOf(tooOld.id).length === 0 && getSchedule(tooOld.id) === undefined,
        JSON.stringify({ soon: sn.map((f) => f.triggerRun), soonLeft: getSchedule(soon.id) !== undefined, pastDue: pd.map((f) => f.triggerRun), tooOld: firedOf(tooOld.id).length, tooOldLeft: getSchedule(tooOld.id) !== undefined }),
      ),
    );

    // ── ④ 저장 — 옛 제약 표를 다시 만든다(별도 프로세스·별도 홈) ─────────────────
    const mig = mkdtempSync(path.join(tmpdir(), "tiguclaw-regression-sched-mig-"));
    let migOut: Record<string, unknown> = {};
    try {
      mkdirSync(path.join(mig, "data"), { recursive: true });
      const db = new Database(path.join(mig, "data", "tiguclaw.db"));
      db.exec(`
        CREATE TABLE schedules (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL, cron_expr TEXT NOT NULL, timezone TEXT NOT NULL DEFAULT 'Asia/Seoul',
          prompt TEXT NOT NULL, dest_channel TEXT NOT NULL, dest_target TEXT, enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL, last_fired_at INTEGER, last_status TEXT, last_error TEXT
        , trigger_type TEXT NOT NULL DEFAULT 'cron' CHECK(trigger_type IN ('cron','reboot')), keep_runs INTEGER);
        INSERT INTO schedules (id, label, cron_expr, prompt, dest_channel, created_at, updated_at) VALUES (3, '옛 스케줄', '0 8 * * *', 'p', 'telegram', 1, 1);
        UPDATE sqlite_sequence SET seq = 40 WHERE name = 'schedules';
      `);
      db.close();
      const code = `
        const { initStore } = await import(${JSON.stringify(pathToFileURL(path.join(repo, "src/store/sessions.ts")).href)});
        const s = await import(${JSON.stringify(pathToFileURL(path.join(repo, "src/store/schedules.ts")).href)});
        initStore(); initStore();
        const t = s.addSchedule({ label: "t", cronExpr: "", prompt: "p", destChannel: "telegram", triggerType: "once", runAt: Date.now() + 120000 });
        console.log(JSON.stringify({ old: s.getSchedule(3)?.label, newId: t.id, type: t.triggerType }));
      `;
      const raw = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
        env: { ...process.env, TIGUCLAW_HOME: mig }, encoding: "utf8", timeout: 60_000,
      });
      migOut = JSON.parse(raw.trim().split("\n").pop() ?? "{}") as Record<string, unknown>;
    } catch (e) {
      migOut = { error: e instanceof Error ? e.message.slice(0, 300) : String(e) };
    } finally {
      rmSync(mig, { recursive: true, force: true });
    }
    out.push(
      assert(
        "★옛 표(`cron`·`reboot` 만 허용)를 **다시 만들어** `once` 를 받는다 — 옛 행 그대로 · 순번 보존(지운 id 재사용 = 옛 전용 세션 이력 상속 방지) · 두 번 불러도 같다",
        migOut.old === "옛 스케줄" && migOut.newId === 41 && migOut.type === "once",
        JSON.stringify(migOut),
      ),
    );

    // ── ⑤ 맥락 줄 ─────────────────────────────────────────────────────────
    const lineTimer = triggerRunLine({ kind: "schedule", id: 9, once: true });
    const lineLate = triggerRunLine({ kind: "schedule", id: 9, lateFrom: Date.UTC(2026, 9, 20, 8) });
    const lineCron = triggerRunLine({ kind: "schedule", id: 9 });
    out.push(
      assert(
        "맥락 줄: 타이머는 «한 번 울리고 지워진다 · 아직이면 다음 한 번(`once`)을 다시 걸어라» · 늦은 실행은 원래 시각과 «늦게» · 평소 정기 스케줄 줄은 그대로",
        lineTimer.includes("타이머(#9)") && lineTimer.includes("지워진다") && lineTimer.includes("다시 걸어라") && lineTimer.includes("add_schedule") && lineTimer.includes("once") &&
          lineLate.includes("늦게") && lineLate.includes("2026-10-20T08:00:00.000Z") &&
          lineCron === "- 이 턴은 등록된 **정기 스케줄(#9)의 실행**이다 — 지시문은 그 스케줄의 지시다.",
        JSON.stringify({ lineTimer, lineLate, lineCron }),
      ),
    );

    // ── ⑥ 인벤토리는 오래 사는 것만(배선) ───────────────────────────────────
    const inv = readSourceSync("plugins/http-bridge/routes-inventory.ts");
    const prov = readSourceSync("src/core/plugins/providers.ts");
    out.push(
      assert(
        "인벤토리(스케줄 화면·모듈 요약)는 한 번 타이머를 **안 센다** — 건 대화에만 보인다(«인벤토리에 쌓이는 게 별로»)",
        /listSchedules\(\)\.filter\(\(r\) => !isTimer\(r\)\)/.test(inv) && /listSchedules\(\)\.filter\(\(s\) => !isTimer\(s\)\)/.test(prov),
        JSON.stringify({ inv: /!isTimer/.test(inv), prov: /!isTimer/.test(prov) }),
      ),
    );

    for (const id of [...made, ownFail.id, loop.id]) deleteSchedule(id);
    return out;
  },
};
