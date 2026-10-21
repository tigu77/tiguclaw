/**
 * 회귀: **한 번 타이머는 건 대화의 백그라운드 패널에 보이고, 거기서 멈춘다** (2026-10-20 — 설계 docs/decisions/2026-10-20-schedule-timers-design.md §2.3).
 *
 * 정태님 *«인벤토리에 쌓이는 게 별로»* — 타이머는 인벤토리에서 뺐으니 **보이는 곳이 따로 있어야** 멈출 수 있다.
 * 지키는 것:
 *  ① 서버: `/timers` 는 타이머만(정기 스케줄 제외) · `/cancel-timer` 는 **타이머만** 지우고(정기 스케줄 id 면 404) 플러그인에 내림 통보
 *  ② 화면: «현재 세션» 이면 이 대화가 건 것만, 이른 순서로 · 남은 시간 · 없으면 숨는다 · «전체 세션» 이면 전부 · 세션을 옮기면 그 대화의 것
 *  ③ 멈추기 → 서버에 그 id 로 · 목록에서 빠짐 · 실패면 버튼을 되살리고 알린다
 *  ④ 늦은 옛 응답이 새 목록을 덮지 않는다 · 울릴 시각이 지나면 다시 받는다
 *
 * 등급: **동작** — ① 은 진짜 라우트 함수 + 격리 홈 저장소, ②~④ 는 진짜 `bg-timers.js` 를 `_mini-dom` 에 싣고 시계를 손으로 돌린다.
 */
import { Readable } from "node:stream";
import { bootDashboard, dashSource, dispatch, jsonResponse, makeClock, makeEvent } from "./_mini-dom.js";
import { assert, assertIsolated, i18nForContext, loadPluginModule, type Assertion, type RegressionCheck } from "./_framework.js";
import { initStore } from "../../store/sessions.js";
import { addSchedule, deleteSchedule, getSchedule, recordFiring, updateSchedule } from "../../store/schedules.js";
import { readSourceSync } from "./_wiring.js";

type Deferred = { promise: Promise<unknown>; resolve: (v: unknown) => void };
const deferred = (): Deferred => {
  let resolve: (v: unknown) => void = () => {};
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

const fakeRes = () => {
  const r = { status: 0, body: "" as string, writeHead(s: number) { r.status = s; return r; }, setHeader() {}, end(b?: string) { r.body = b ?? ""; } };
  return r;
};
const fakeReq = (body: unknown) => Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { headers: {} });

export const check: RegressionCheck = {
  name: "bg-timers-panel",
  guards: "인벤토리에서 뺀 한 번 타이머가 어디에도 안 보여, 건 대화에서 남은 시간을 보거나 멈출 수 없던 것",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    initStore();
    const out: Assertion[] = [];

    // ── ① 서버 라우트(진짜 함수 + 진짜 저장소) ─────────────────────────────
    const routes = await loadPluginModule<{
      handleTimers: (c: unknown) => Promise<void>;
      handleCancelTimer: (c: unknown) => Promise<void>;
    }>("../../../plugins/http-bridge/routes-work.ts");
    // 실패로 꺼 둔 타이머 — 라우트가 그 사실(lastStatus·lastError)을 싣는가(재검토 G2: 빠지면 패널의 «실패» 가 영영 안 나온다)
    const failedT = addSchedule({ label: "regr-패널실패", cronExpr: "", prompt: "p", destChannel: "telegram", destTarget: "c", triggerType: "once", runAt: Date.now() - 60_000, originThreadKey: "dashboard:regr-a" });
    recordFiring(failedT.id, { ok: false, error: "합성 실패" });
    updateSchedule(failedT.id, { enabled: false });
    const timer = addSchedule({ label: "regr-패널타이머", cronExpr: "", prompt: "빌드 확인", destChannel: "telegram", destTarget: "c", triggerType: "once", runAt: Date.now() + 600_000, originThreadKey: "dashboard:regr-a" });
    const cron = addSchedule({ label: "regr-패널정기", cronExpr: "0 8 * * *", prompt: "보고", destChannel: "telegram", destTarget: "c" });
    const published: Array<{ type: string; payload: unknown }> = [];
    const bus = { publish: (e: { type: string; payload: unknown }) => published.push(e), subscribe: () => () => {} };
    const resList = fakeRes();
    await routes.handleTimers({ res: resList, bus });
    const listed = (JSON.parse(resList.body) as { timers: Array<{ id: number; originThreadKey: string | null; runAt: number; enabled?: boolean; lastStatus?: string | null; lastError?: string | null }> }).timers;
    const failedListed = listed.find((x) => x.id === failedT.id);
    deleteSchedule(failedT.id);
    const resCron = fakeRes();
    await routes.handleCancelTimer({ req: fakeReq({ id: cron.id }), res: resCron, bus });
    const resTimer = fakeRes();
    await routes.handleCancelTimer({ req: fakeReq({ id: timer.id }), res: resTimer, bus });
    out.push(
      assert(
        "★★`/timers` 는 타이머만(정기 스케줄 제외) · `/cancel-timer` 는 **타이머만** 지운다(정기 스케줄 id 면 404, 그대로 남음) · 지우면 플러그인에 내림 통보",
        listed.some((x) => x.id === timer.id && x.originThreadKey === "dashboard:regr-a") && !listed.some((x) => x.id === cron.id) &&
          failedListed?.enabled === false && failedListed.lastStatus === "error" && failedListed.lastError === "합성 실패" &&
          resCron.status === 404 && getSchedule(cron.id) !== undefined &&
          resTimer.status === 200 && getSchedule(timer.id) === undefined &&
          published.some((e) => e.type === "scheduler.toggle" && JSON.stringify(e.payload) === JSON.stringify({ id: timer.id, action: "delete" })),
        JSON.stringify({ listed: listed.map((x) => x.id), cronStatus: resCron.status, cronLeft: getSchedule(cron.id) !== undefined, timerStatus: resTimer.status, published }),
      ),
    );
    deleteSchedule(cron.id);

    // ── ②~④ 화면(진짜 bg-timers.js) ─────────────────────────────────────
    const clock = makeClock();
    const now = Date.now();
    // 화면의 «지금» 을 손 시계에 묶는다 — 남은 시간·«시각이 지났나» 판정이 시계를 따라가게.
    const FakeDate = class extends Date { static now(): number { return now + clock.now(); } };
    let timers = [
      { id: 2, label: "나중", prompt: "p2", runAt: now + 3 * 3_600_000 + 5 * 60_000, originThreadKey: "dashboard:default", enabled: true },
      { id: 1, label: "빌드 확인", prompt: "p1", runAt: now + 3 * 60_000, originThreadKey: "dashboard:default", enabled: true },
      { id: 3, label: "다른 대화", prompt: "p3", runAt: now + 10 * 60_000, originThreadKey: "dashboard:other", enabled: true },
    ];
    let hold: Deferred | null = null;
    let listCalls = 0;
    const cancels: unknown[] = [];
    let cancelStatus = 200;
    const dash = bootDashboard({
      clock,
      i18n: i18nForContext,
      upTo: "side-panels.js",
      ids: ["bg-timers", "bg-timers-list", "toast"],
      fetch: async (url: string, init?: { body?: string }) => {
        if (url === "/api/timers") {
          listCalls += 1;
          const snap = timers;
          if (hold !== null) await hold.promise;
          return jsonResponse({ timers: snap });
        }
        if (url === "/api/cancel-timer") {
          const body = JSON.parse(String(init?.body ?? "{}")) as { id: number };
          cancels.push(body);
          if (cancelStatus === 200) timers = timers.filter((x) => x.id !== body.id); // 서버에서 지워졌다
          return jsonResponse(cancelStatus === 200 ? { ok: true } : { error: "x" }, cancelStatus);
        }
        return jsonResponse({}, 404);
      },
      stubs: 'let bgSessionScope = "session"; document.visibilityState = "visible";',
      extra: { Date: FakeDate },
    });
    dash.run(dashSource("bg-timers.js"), "bg-timers.js");
    await clock.advance(50);
    const doc = dash.document;
    const box = doc.getElementById("bg-timers");
    const rows = () => (doc.getElementById("bg-timers-list")?.querySelectorAll(".bg-timer") ?? []).map((r) => r.textContent);
    const first = rows();
    out.push(
      assert(
        "★★«현재 세션» 이면 **이 대화가 건 것만**, 울릴 순서로 — 남은 시간 · 이름 · 멈추기 · 상자가 보인다",
        first.length === 2 && first[0]!.includes("3분 뒤") && first[0]!.includes("빌드 확인") && first[1]!.includes("3시간 5분 뒤") &&
          first.every((t) => t.includes("멈추기")) && box?.hidden === false,
        JSON.stringify({ first, hidden: box?.hidden }),
      ),
    );
    dash.run('bgSessionScope = "all"; renderBgTimers();');
    const all = rows().length;
    dash.run('bgSessionScope = "session"; activeThreadKey = "dashboard:other"; renderBgTimers();');
    const other = rows();
    dash.run('activeThreadKey = "dashboard:none"; renderBgTimers();');
    const none = rows().length;
    const hiddenWhenNone = box?.hidden;
    dash.run('activeThreadKey = "dashboard:default"; renderBgTimers();');
    out.push(
      assert(
        "«전체 세션» 이면 전부 · 세션을 옮기면 그 대화의 것 · 없으면 상자가 숨는다",
        all === 3 && other.length === 1 && other[0]!.includes("다른 대화") && none === 0 && hiddenWhenNone === true,
        JSON.stringify({ all, other, none, hiddenWhenNone }),
      ),
    );

    // ③ 멈추기
    const stopBtn = () => doc.getElementById("bg-timers-list")?.querySelectorAll(".bg-timer-stop")[0];
    cancelStatus = 500;
    const b1 = stopBtn();
    if (b1) dispatch(b1, makeEvent("click"));
    await clock.advance(50);
    const afterFail = { rows: rows().length, disabled: stopBtn()?.disabled, toast: doc.getElementById("toast")?.textContent ?? "" };
    cancelStatus = 200;
    const b2 = stopBtn();
    if (b2) dispatch(b2, makeEvent("click"));
    await clock.advance(50);
    out.push(
      assert(
        "★멈추기 → 서버에 **그 id** 로 · 성공하면 목록에서 빠진다 · 실패면 그대로 두고 버튼을 되살리고 알린다",
        JSON.stringify(cancels) === JSON.stringify([{ id: 1 }, { id: 1 }]) && afterFail.rows === 2 && afterFail.disabled === false &&
          afterFail.toast.includes("멈추지 못했습니다") && rows().length === 1 && rows()[0]!.includes("나중"),
        JSON.stringify({ cancels, afterFail, after: rows() }),
      ),
    );

    // ③'' 아스트라 P2 — 멈추기 **전에** 떠난 목록 조회가 멈춘 **뒤에** 오면 멈춘 타이머를 되살리지 않는다
    timers = [{ id: 21, label: "멈출 것", prompt: "", runAt: now + 600_000, originThreadKey: "dashboard:default", enabled: true }];
    dash.run("window.resyncTimers()");
    await clock.advance(500);
    const staleSnap = timers;
    hold = deferred();
    const staleHold = hold;
    dash.run("window.resyncTimers()");
    await clock.advance(500); // 이 조회는 붙잡혔다(멈추기 전 목록)
    hold = null;
    const b3 = stopBtn();
    if (b3) dispatch(b3, makeEvent("click"));
    await clock.advance(50); // 멈추기 성공 → 서버에서 지워짐
    staleHold.resolve(undefined); // 옛 조회가 이제 온다
    await clock.advance(50);
    out.push(
      assert(
        "★아스트라 P2 멈추기 전에 떠난 옛 목록 조회가 늦게 와도 멈춘 타이머가 **화면에 돌아오지 않는다**(멈추면 세대를 올리고 다시 받는다)",
        staleSnap.length === 1 && rows().every((r) => !r.includes("멈출 것")),
        JSON.stringify({ rows: rows() }),
      ),
    );

    // ③' 실패한 타이머 — 실행기가 꺼 둔 채 남긴 것(적대 검토 #2)은 «실패» 로, 사유는 툴팁으로
    timers = [
      { id: 7, label: "실패한 것", prompt: "", runAt: now + 60_000, originThreadKey: "dashboard:default", enabled: false, lastStatus: "error", lastError: "합성 실패" } as never,
      { id: 8, label: "끈 것", prompt: "", runAt: now + 120_000, originThreadKey: "dashboard:default", enabled: false, lastStatus: null, lastError: null } as never,
    ];
    dash.run("window.resyncTimers()");
    await clock.advance(500);
    const failedRows = rows();
    const failedTitle = doc.getElementById("bg-timers-list")?.querySelectorAll(".bg-timer-when")[0]?.title ?? "";
    out.push(
      assert(
        "실행기가 실패로 꺼 둔 타이머는 «실패»(사유는 툴팁) · 사용자가 끈 것은 «꺼짐» — 둘 다 멈추기로 지울 수 있다",
        failedRows.length === 2 && failedRows[0]!.includes("실패") && failedTitle === "합성 실패" && failedRows[1]!.includes("꺼짐"),
        JSON.stringify({ failedRows, failedTitle }),
      ),
    );

    // ④ 늦은 옛 응답 · 시각이 지나면 다시 받기
    timers = [{ id: 9, label: "옛 목록", prompt: "", runAt: now + 60 * 60_000, originThreadKey: "dashboard:default", enabled: true }];
    hold = deferred();
    const heldHold = hold;
    dash.run("window.resyncTimers()");
    await clock.advance(500); // 첫 요청(옛 목록)이 붙잡혔다
    hold = null;
    timers = [{ id: 10, label: "새 목록", prompt: "", runAt: now + clock.now() + 40_000, originThreadKey: "dashboard:default", enabled: true }];
    dash.run("window.resyncTimers()");
    await clock.advance(500);
    heldHold.resolve(undefined);
    await clock.advance(50);
    const afterRace = rows();
    const callsBefore = listCalls;
    await clock.advance(31_000); // 40초 뒤 시각 → «곧» · 아직 안 지남
    const soonText = rows()[0] ?? "";
    timers = [];
    await clock.advance(30_000); // 시각이 지났다 → 다시 받는다 → 서버에서 지워졌으니 숨는다
    out.push(
      assert(
        "★늦게 온 옛 응답이 새 목록을 덮지 않는다 · 30초마다 남은 시간을 다시 그리고 울릴 시각이 지나면 **다시 받는다**(울리면 서버에서 지워진다)",
        afterRace.length === 1 && afterRace[0]!.includes("새 목록") && soonText.includes("곧") && listCalls > callsBefore && rows().length === 0 && box?.hidden === true,
        JSON.stringify({ afterRace, soonText, calls: listCalls - callsBefore, end: rows(), hidden: box?.hidden }),
      ),
    );
    // ⑤ 배선 — 다시 받는 계기가 실제로 걸려 있나(패널 열기·세션 이동·탭 복귀 = resyncBackground, 턴 끝 = sse)
    const act = readSourceSync("packages/dashboard/js/activity.js");
    const sse = readSourceSync("packages/dashboard/js/sse.js");
    out.push(
      assert(
        "다시 받는 계기가 걸려 있다 — `resyncBackground`(패널 열기·세션 이동·탭 복귀)와 턴 끝(`llm.turn_done`)이 타이머 목록을 다시 받는다",
        /const resyncBackground = \(\) => \{[\s\S]{0,400}window\.resyncTimers\(\)/.test(act) &&
          /ev\.type === "llm\.turn_done" \|\| ev\.type === "llm\.turn_error"[\s\S]{0,900}window\.resyncTimers\(\)/.test(sse),
        JSON.stringify({ act: /resyncTimers/.test(act), sse: /resyncTimers/.test(sse) }),
      ),
    );
    return out;
  },
};
