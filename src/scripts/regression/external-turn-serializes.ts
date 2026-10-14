/**
 * 회귀: **핸들러를 우회하는 턴(스케줄·파일감시)도 같은 스레드의 줄에 선다** (2026-10-14).
 *
 * 사고(돌쇠 아침 뉴스 두 번): 스케줄 턴이 스레드 줄을 거치지 않아, 그 턴이 띄운 매니저의 완료 재주입이 «줄이 비었다» 고 보고
 *  즉시 시작했다 — 같은 스레드에서 두 턴이 30초 동안 동시에 돌며 웹을 다시 읽고 위키 저장소에 git 을 돌리고 각자 뉴스를 보냈다.
 *
 * 재는 것:
 *  ① 외부 턴이 도는 동안 같은 스레드에 들어온 턴(완료 재주입과 같은 입구 `enqueueThreadTurn`)은 **그 뒤에** 시작한다
 *  ② 다른 스레드는 막지 않는다(병렬 유지)
 *  ③ 진행 중 등록은 **실제로 도는 동안만**(줄에서 기다리는 동안은 등록 안 됨) — 배포 가드가 보는 값
 *  ④ 배선: 파일감시 기본 실행기는 이 경로를, 스케줄은 실행기(`runner.ts`)가 줄을 세운다(기본 실행기는 등록만 — 두 번 서면 교착)
 *  ⑦ `/stop` 으로 멈춘 스케줄 턴은 실패로 기록·통지되지 않는다 · ⑧ 줄에서 기다리는 사이 꺼지면 안 돌고, 목적지가 바뀌면 새 목적지로
 *  ⑤ ★스케줄 이력 정책은 **줄 안에서** 적용된다(2026-10-14 적대 검토 P3) — 줄 앞 턴이 끝나며 이어가기를 되살려도 «매번 새로» 가 남는다
 *
 * 등급: **동작**(④만 배선).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, assertIsolated, loadPluginModule, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export const check: RegressionCheck = {
  name: "external-turn-serializes",
  guards: "스케줄 턴이 스레드 줄을 거치지 않아 완료 재주입 턴과 같은 스레드에서 동시에 돌고 뉴스가 두 번 나가던 것",
  run: async (): Promise<Assertion[]> => {
    const { runExternalTurn } = await import("../../core/external-turn.js");
    const { enqueueThreadTurn } = await import("../../core/worker-jobs.js");
    const { listExternalTurns } = await import("../../core/inflight-turns.js");

    const log: string[] = [];
    let releaseA: () => void = () => {};
    const gateA = new Promise<void>((r) => (releaseA = r));
    const ac = new AbortController();
    const turn = { ac, channel: "scheduler", target: null };

    // ① 같은 스레드: 외부 턴 A 가 도는 중 재주입 B 가 들어온다
    const a = runExternalTurn("scheduler:regr-serial", turn, async () => {
      log.push("A시작");
      await gateA;
      log.push("A끝");
    });
    await sleep(20);
    const registeredWhileRunning = listExternalTurns().some(([k]) => k === "scheduler:regr-serial");
    const b = enqueueThreadTurn("scheduler:regr-serial", async () => {
      log.push("B시작");
    });
    // ② 다른 스레드는 바로 돈다
    const c = enqueueThreadTurn("scheduler:regr-other", async () => {
      log.push("C시작");
    });
    await sleep(40);
    const beforeRelease = [...log];
    releaseA();
    await Promise.all([a, b, c]);
    const after = [...log];

    // ③ 줄에서 기다리는 외부 턴은 아직 진행 중이 아니다
    let releaseD: () => void = () => {};
    const gateD = new Promise<void>((r) => (releaseD = r));
    const d = enqueueThreadTurn("scheduler:regr-wait", async () => {
      await gateD;
    });
    const e = runExternalTurn("scheduler:regr-wait", { ac, channel: "scheduler", target: null }, async () => {
      log.push("E시작");
    });
    await sleep(20);
    const registeredWhileQueued = listExternalTurns().some(([k]) => k === "scheduler:regr-wait");
    releaseD();
    await Promise.all([d, e]);
    const unregisteredAfter = !listExternalTurns().some(([k]) => k.startsWith("scheduler:regr-"));

    // ⑥ `/stop` 이 끊을 대상 — 이 대화의 안 끊긴 외부 턴(줄 앞에서 도는 파일감시·스케줄)
    const { activeExternalTurn } = await import("../../core/inflight-turns.js");
    let releaseS: () => void = () => {};
    const gateS = new Promise<void>((r) => (releaseS = r));
    const acS = new AbortController();
    const sTurn = runExternalTurn("file-watch:regr-stop", { ac: acS, channel: "file-watch", target: null }, async () => {
      await gateS;
    });
    await sleep(20);
    const foundRunning = activeExternalTurn("file-watch:regr-stop") !== undefined;
    acS.abort();
    const foundAfterAbort = activeExternalTurn("file-watch:regr-stop") !== undefined;
    releaseS();
    await sTurn;

    // ⑦ `/stop` 으로 멈춘 스케줄 턴 — 실패로 기록하지 않고 scheduler.error 도 안 낸다(자가 진단이 «실패» 로 되보고하던 것)
    const { UserCancelledError } = await import("../../core/steering.js");
    const { addSchedule: addSch, updateSchedule } = await import("../../store/schedules.js");
    const { getEventBus: bus2 } = await import("../../core/eventbus.js");
    const { runScheduleFiring: fire2 } = await loadPluginModule<{
      runScheduleFiring: (row: unknown, bus: unknown, deps: unknown) => Promise<void>;
    }>("../../../plugins/scheduler/src/runner.ts");
    const errs: unknown[] = [];
    const unsub = bus2().subscribe((ev) => {
      if (ev.type === "scheduler.error") errs.push(ev.payload);
    });
    const stopRow = addSch({ label: "regr-중지", cronExpr: "0 8 * * *", prompt: "p", destChannel: "regr" } as never) as { id: number };
    const stopRecords: unknown[] = [];
    await fire2(stopRow, bus2(), {
      cwd: REPO,
      recordFiring: (_id: number, v: unknown) => stopRecords.push(v),
      dispatch: async () => {},
      runClaude: async () => {
        throw new UserCancelledError();
      },
    });
    unsub();
    const userStop = { 기록: stopRecords.length, 오류이벤트: errs.length };

    // ⑧ 줄에서 기다리는 사이 바뀐 스케줄 — 꺼지면 안 돌고, 목적지가 바뀌면 새 목적지로
    const runs: string[] = [];
    const sentTo: string[] = [];
    const runQueued = async (mutate: (id: number) => void): Promise<void> => {
      const r = addSch({ label: "regr-줄대기", cronExpr: "0 8 * * *", prompt: "p", destChannel: "regr", destTarget: "A" } as never) as { id: number };
      let rel: () => void = () => {};
      const g = new Promise<void>((x) => (rel = x));
      const headQ = enqueueThreadTurn(`scheduler:${r.id}`, async () => {
        await g;
      });
      const f = fire2(r, bus2(), {
        cwd: REPO,
        recordFiring: () => {},
        dispatch: async (v: { destTarget?: unknown }) => {
          sentTo.push(String(v.destTarget));
        },
        runClaude: async () => {
          runs.push(String(r.id));
          return { text: "결과" };
        },
      });
      await sleep(20);
      mutate(r.id);
      rel();
      await Promise.all([headQ, f]);
    };
    await runQueued((id) => updateSchedule(id, { enabled: false }));
    const ranWhenDisabled = runs.length;
    await runQueued((id) => updateSchedule(id, { destTarget: "B" }));

    // ④ 배선
    const strip = (f: string): string => readFileSync(path.join(REPO, f), "utf8").replace(/\/\/.*$/gm, "");
    const fw = strip("plugins/file-watch/src/index.ts");
    const schIndex = strip("plugins/scheduler/src/index.ts");
    const schRunner = strip("plugins/scheduler/src/runner.ts");
    const wiring = {
      파일감시_줄: /runExternalTurn\(/.test(fw) && !/withExternalTurn\(/.test(fw),
      스케줄_실행기가_줄: /enqueueThreadTurn\(/.test(schRunner),
      스케줄_기본실행기는_등록만: /withExternalTurn\(/.test(schIndex) && !/runExternalTurn\(|enqueueThreadTurn\(/.test(schIndex),
    };

    // ⑤ 스케줄 이력 정책은 줄 안에서 — 실제 실행기 + 실제 세션 저장(어댑터가 턴 끝에 부르는 것)
    assertIsolated();
    const { initStore, saveSession, getSession, canonicalSessionChannel } = await import("../../store/sessions.js");
    initStore();
    const { addSchedule } = await import("../../store/schedules.js");
    const { getEventBus } = await import("../../core/eventbus.js");
    const { runScheduleFiring } = await loadPluginModule<{
      runScheduleFiring: (row: unknown, bus: unknown, deps: unknown) => Promise<void>;
    }>("../../../plugins/scheduler/src/runner.ts");
    const row = addSchedule({ label: "regr-줄안정책", cronExpr: "0 8 * * *", prompt: "회귀 발화", destChannel: "regr", keepRuns: 0 } as never) as { id: number };
    const stk = `scheduler:${row.id}`;
    const sch = canonicalSessionChannel(stk, "scheduler");
    saveSession({ channel: sch, threadKey: stk, claudeSessionId: "S-old", model: null, systemPromptHash: "H" } as never);
    let releaseHead: () => void = () => {};
    const headGate = new Promise<void>((r) => (releaseHead = r));
    const head = enqueueThreadTurn(stk, async () => {
      await headGate;
      // 앞 턴(완료 재주입 등)이 끝나며 이어가기를 저장한다 — 어댑터가 하는 일 그대로.
      saveSession({ channel: sch, threadKey: stk, claudeSessionId: "S-head", model: null, systemPromptHash: "H" } as never);
    });
    let atStart: { hash: unknown; sid: unknown } | undefined;
    const firing = runScheduleFiring(row, getEventBus(), {
      cwd: REPO,
      recordFiring: () => {},
      dispatch: async () => {},
      runClaude: async () => {
        const s = getSession(sch, stk) as { systemPromptHash?: unknown; claudeSessionId?: unknown } | undefined;
        atStart = { hash: s?.systemPromptHash ?? null, sid: s?.claudeSessionId ?? null };
        return { text: "ok" };
      },
    });
    await sleep(30);
    const startedBeforeHead = atStart !== undefined;
    releaseHead();
    await Promise.all([head, firing]);

    return [
      assert(
        "★① 외부 턴이 도는 동안 같은 스레드에 들어온 턴은 그 뒤에 시작한다",
        !beforeRelease.includes("B시작") && after.indexOf("A끝") < after.indexOf("B시작"),
        { 풀기전: beforeRelease, 끝: after },
      ),
      assert("② 다른 스레드는 막지 않는다", beforeRelease.includes("C시작"), beforeRelease),
      assert(
        "③ 진행 중 등록은 실제로 도는 동안만 — 줄에서 기다리는 동안은 아니고, 끝나면 해제",
        registeredWhileRunning && !registeredWhileQueued && unregisteredAfter,
        { 도는중: registeredWhileRunning, 대기중: registeredWhileQueued, 끝난뒤해제: unregisteredAfter },
      ),
      assert(
        "④ 파일감시는 runExternalTurn · 스케줄은 실행기가 줄을 세우고 기본 실행기는 등록만(두 번 서지 않는다)",
        Object.values(wiring).every(Boolean),
        wiring,
      ),
      assert(
        "⑥ `/stop` 대상 — 도는 외부 턴은 찾고, 끊긴 뒤엔 안 찾는다",
        foundRunning && !foundAfterAbort,
        { 도는중: foundRunning, 끊긴뒤: foundAfterAbort },
      ),
      assert(
        "★⑦ `/stop` 으로 멈춘 스케줄 턴은 실패로 기록되지 않고 scheduler.error 도 안 난다",
        userStop.기록 === 0 && userStop.오류이벤트 === 0,
        userStop,
      ),
      assert(
        "★⑧ 줄에서 기다리는 사이 꺼진 스케줄은 안 돌고, 목적지가 바뀌면 새 목적지로 보낸다",
        ranWhenDisabled === 0 && runs.length === 1 && sentTo.length === 1 && sentTo[0] === "B",
        { 꺼진뒤실행: ranWhenDisabled, 실행: runs.length, 보낸곳: sentTo },
      ),
      assert(
        "★⑤ 스케줄 «매번 새로» 는 줄 안에서 적용된다 — 앞 턴이 끝나며 이어가기를 되살려도 발화 시작 땐 끊겨 있다",
        !startedBeforeHead && atStart !== undefined && atStart.hash === null,
        { 앞턴전에시작: startedBeforeHead, 발화시작: atStart },
      ),
    ];
  },
};

export default check;
