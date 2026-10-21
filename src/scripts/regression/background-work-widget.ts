/**
 * 회귀: **«백그라운드 작업» 위젯 = 백그라운드 패널의 축약판** (2026-10-21, [설계](../../../docs/decisions/2026-10-21-running-work-widget-design.md)).
 *
 * 위젯이 패널과 같은 목록을 한 번 더 펼쳐 자리값을 못 하던 것(정태님 «빼도 되겠어» → «패널을 간략하게 보여 주는 위젯»)을 다시 짰다.
 * 지키는 것:
 *  ① 위젯: 묶음은 패널과 같은 셋·같은 순서(타이머 → 매니저/에이전트 → 셸) · 0개 묶음은 안 그린다 · 진행 중만 · 상한 없음 ·
 *     대화(탭)별(가장 오래 돈 것이 있는 대화부터) · 머리 줄로 접고 펴며 보는 사람별로 기억 · 누르면 `ctx.reveal({kind,id})` ·
 *     메뉴(패널 열기·모두 접기/펼치기) · 셋 다 비면 한 줄
 *  ② 패널: «그 카드로» 가 **가린 축만 푼다** — 다른 대화 → 범위 «전체 대화», 끝난 잡 → 필터 «완료», 접힌 묶음 → 펼침,
 *     못 찾으면 알림. 잡·셸·타이머가 같은 판정을 탄다
 *  ③ 잡 목록: **진행 중은 50개 상한 밖**(끝난 이벤트가 쌓여도 오래 도는 잡이 안 밀린다 — 아스트라 10-21)
 *  ④ 위젯 호스트: 메뉴 provider 는 **인스턴스 것** — 같은 종류 둘이 섞이지 않고, 칸을 치우면 함께 버려진다(아스트라 10-21)
 *  ⑤ 서버: «이 위젯 끄기» 는 **그 항목 하나** — 같은 종류 둘 중 하나만 사라지고, 기본 위젯이면 다음 부팅에 안 되살아난다
 *  ⑥ 화면 소유 리소스(`owned`): 같은 판정으로 배달되고, 이 리소스를 쓰는 파일보다 저장소가 먼저 실린다
 *
 * 등급: **동작** — ①②③④⑥ 은 실제 대시보드·플러그인 파일을 미니 DOM 에 싣고 돌린다. ⑤ 는 진짜 코어 함수로 격리 홈의 설정을 쓴다.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { Readable } from "node:stream";
import { assert, i18nForContext, loadPluginModule, type Assertion, type RegressionCheck } from "./_framework.js";
import { bootDashboard, dispatch, jsonResponse, makeClock, makeDomContext, makeEvent } from "./_mini-dom.js";
import { readHomeWidgets, removeHomeWidget, seedDefaultHomeWidgets, writeHomeWidgets } from "../../core/home-widgets.js";
import { getPaths } from "../../core/paths.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const WIDGET = readFileSync(path.join(REPO, "plugins/running-work/web/widget.js"), "utf8");
const KO = JSON.parse(readFileSync(path.join(REPO, "plugins/running-work/web/locales/ko.json"), "utf8")) as Record<string, string>;

/** 플러그인 위젯 하나를 가짜 `ctx` 로 마운트한다 — 구독·이동·메뉴를 손으로 잡는다. */
const mountWidget = (ls?: Map<string, string>, opts: { writeFails?: boolean } = {}) => {
  const clk = makeClock();
  const { document, window, ctx } = makeDomContext({ setInterval: clk.setInterval, clearInterval: clk.clearInterval, setTimeout: clk.setTimeout, clearTimeout: clk.clearTimeout });
  if (ls) ctx.localStorage = { getItem: (k: string) => ls.get(k) ?? null, setItem: (k: string, v: string) => void ls.set(k, String(v)), removeItem: (k: string) => void ls.delete(k) };
  if (opts.writeFails) ctx.localStorage = { getItem: () => null, setItem: () => { throw new Error("QuotaExceededError"); }, removeItem: () => {} };
  let builder: any = null;
  window.tiguWidgets = { register: (_id: string, b: any) => { builder = b; return true; } };
  vm.createContext(ctx);
  vm.runInContext(WIDGET, ctx, { filename: "widget.js" });
  const subs = new Map<string, (v: unknown) => void>();
  const reveals: unknown[] = [];
  let menu: (() => { label: string; run: () => void }[]) | null = null;
  const disposers: (() => void)[] = [];
  const root = document.createElement("div");
  document.body.appendChild(root);
  builder.mount(root, null, {
    onDispose: (fn: () => void) => disposers.push(fn),
    locale: "ko",
    resource: (name: string) => ({ subscribe: (fn: (v: unknown) => void) => { subs.set(name, fn); return () => {}; } }),
    reveal: (t: unknown) => reveals.push(t),
    menu: (p: typeof menu) => { menu = p; },
    sessionName: (tk: string) => (tk === "dashboard:a" ? "에이" : tk === "dashboard:b" ? "비" : ""),
    t: (k: string, p?: Record<string, unknown>) => (KO[k] ?? k).replace(/\{(\w+)\}/g, (m, x) => (p && p[x] !== undefined ? String(p[x]) : m)),
  });
  const push = (name: string, v: unknown): void => subs.get(name)?.(v);
  const text = (sel: string): string[] => root.querySelectorAll(sel).map((e: any) => String(e.textContent));
  return { root, push, text, reveals, menu: () => (menu ? menu() : []), subs, disposers };
};

export const check: RegressionCheck = {
  name: "background-work-widget",
  guards:
    "백그라운드 작업 위젯이 패널과 같은 목록을 한 번 더 펼쳐 자리값을 못 하던 것 — 축약판(묶음→대화→항목, 누르면 패널의 그 카드로)으로 다시 짜며 생길 것: 진행 중 잡이 목록 상한에 밀림 · 다른 대화 카드로 못 감 · 같은 종류 위젯 둘이 함께 꺼짐 · 메뉴가 마운트마다 쌓임",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const now = Date.now();

    // ── ① 위젯 ─────────────────────────────────────────────────────────────
    const w = mountWidget();
    const jobs = [
      { jobId: "j-new", label: "새 잡", status: "running", kind: "worker", startedAt: now - 2 * 60000, ownerThreadKey: "dashboard:a" },
      { jobId: "j-old", label: "오래된 잡", status: "running", kind: "agent", startedAt: now - 40 * 60000, ownerThreadKey: "dashboard:b" },
      { jobId: "j-done", label: "끝난 잡", status: "done", kind: "worker", startedAt: now - 50 * 60000, ownerThreadKey: "dashboard:a" },
      { jobId: "j-mid", label: "중간 잡", status: "running", kind: "worker", startedAt: now - 10 * 60000, ownerThreadKey: "dashboard:a" },
    ];
    w.push("running-work", jobs);
    w.push("bg-shells", [{ shellId: "s-exit", command: "끝난 셸", status: "exited", startedAt: now - 5000, ownerThreadKey: "dashboard:a" }]);
    w.push("bg-timers", [
      { id: 7, label: "빌드 확인", enabled: true, runAt: now + 3 * 60000, originThreadKey: "dashboard:a" },
      { id: 8, label: "꺼진 타이머", enabled: false, runAt: now + 60000, originThreadKey: "dashboard:a" },
    ]);
    // 이름을 모르는 대화 · 소속 미상 — 좌표를 이름처럼 그리지 않고 «대화 미상»
    const wu = mountWidget();
    wu.push("running-work", [
      { jobId: "u1", label: "이름 모름", status: "running", startedAt: now - 60000, ownerThreadKey: "dashboard:z" },
      { jobId: "u2", label: "소속 미상", status: "running", startedAt: now - 30000, ownerThreadKey: "" },
    ]);
    out.push(
      assert(
        "★대화 이름을 모르거나 소속이 미상이면 «대화 미상» — 좌표(`dashboard:…`)를 대화 이름처럼 그리지 않는다",
        JSON.stringify(wu.text(".rw-session")) === JSON.stringify([KO["session.unknown"], KO["session.unknown"]]),
        wu.text(".rw-session"),
      ),
    );
    const titles = w.text(".rw-title");
    const labels = w.text(".rw-label");
    const sessions = w.text(".rw-session");
    out.push(
      assert(
        "★★묶음 = 패널과 같은 순서(타이머 → 매니저/에이전트) · 0개 묶음(끝난 셸뿐)은 안 그린다 · 진행 중만(끝난 잡·꺼진 타이머 없음) · 대화는 가장 오래 돈 잡이 있는 대화부터, 대화 안도 오래된 것부터",
        JSON.stringify(titles) === JSON.stringify([KO["group.timers"], KO["group.jobs"]]) &&
          JSON.stringify(labels) === JSON.stringify(["빌드 확인", "오래된 잡", "중간 잡", "새 잡"]) &&
          JSON.stringify(sessions) === JSON.stringify(["에이", "비", "에이"]),
        { titles, labels, sessions },
      ),
    );
    // 상한 없음
    w.push("running-work", Array.from({ length: 70 }, (_, i) => ({ jobId: "x" + i, label: "잡" + i, status: "running", startedAt: now - i * 1000, ownerThreadKey: "dashboard:a" })));
    out.push(assert("상한 없음 — 진행 중 잡 70개가 70줄", w.text(".rw-row").length === 70 + 1, { rows: w.text(".rw-row").length }));
    w.push("running-work", jobs);
    // 누르면 그 카드로
    const rowOld = w.root.querySelectorAll(".rw-row").find((e: any) => String(e.textContent).includes("오래된 잡"));
    rowOld?.click();
    const rowTimer = w.root.querySelectorAll(".rw-row").find((e: any) => String(e.textContent).includes("빌드 확인"));
    rowTimer?.click();
    out.push(
      assert(
        "★항목을 누르면 `ctx.reveal({ kind, id })` — 잡은 jobId, 타이머는 id(문자열)",
        JSON.stringify(w.reveals) === JSON.stringify([{ kind: "job", id: "j-old" }, { kind: "timer", id: "7" }]),
        w.reveals,
      ),
    );
    // 접고 펴기 + 기억
    const ls = new Map<string, string>();
    const w2 = mountWidget(ls);
    w2.push("running-work", jobs);
    const head = w2.root.querySelectorAll(".rw-head")[0];
    head?.click();
    const collapsedRows = w2.text(".rw-row").length;
    const w3 = mountWidget(ls); // 같은 브라우저에서 다시 연다
    w3.push("running-work", jobs);
    out.push(
      assert(
        "기본 펼침 · 머리 줄로 접으면 그 묶음 항목이 사라지고(개수는 보인다) · 다시 열어도 접힌 채(보는 사람별 기억)",
        w2.text(".rw-row").length === 0 && collapsedRows === 0 && w3.text(".rw-row").length === 0 && w3.text(".rw-count")[0] === "3",
        { collapsedRows, reopened: w3.text(".rw-row").length, count: w3.text(".rw-count") },
      ),
    );
    // ★저장소 쓰기가 실패해도 지금 화면은 접히고 펴진다(아스트라 10-21 — 종전엔 저장소만 읽어 아무 일도 안 했다)
    const wf = mountWidget(undefined, { writeFails: true });
    wf.push("running-work", jobs);
    const aria = (): string => String(wf.root.querySelectorAll(".rw-head")[0]?.getAttribute("aria-expanded"));
    const wfBefore = { rows: wf.text(".rw-row").length, aria: aria() };
    wf.root.querySelectorAll(".rw-head")[0]?.click();
    const wfHead = { rows: wf.text(".rw-row").length, aria: aria() };
    wf.root.querySelectorAll(".rw-head")[0]?.click();
    const wfReopen = { rows: wf.text(".rw-row").length, aria: aria() };
    wf.menu()[1]?.run();
    const wfMenu = { rows: wf.text(".rw-row").length, aria: aria() };
    out.push(
      assert(
        "★저장소 쓰기가 실패해도 지금 화면은 바뀐다 — 머리 줄로 접기·다시 펴기, «모두 접기» 가 항목 수와 aria-expanded 를 바꾼다",
        wfBefore.rows === 3 && wfBefore.aria === "true" && wfHead.rows === 0 && wfHead.aria === "false" &&
          wfReopen.rows === 3 && wfReopen.aria === "true" && wfMenu.rows === 0 && wfMenu.aria === "false",
        { wfBefore, wfHead, wfReopen, wfMenu },
      ),
    );
    // 메뉴
    const m1 = w.menu().map((x) => x.label);
    w.menu()[1]?.run();
    const afterCollapse = w.text(".rw-row").length;
    const m2 = w.menu().map((x) => x.label);
    w.menu()[0]?.run();
    out.push(
      assert(
        "메뉴 = «백그라운드 패널 열기»(reveal panel) + «모두 접기» → 접은 뒤엔 «모두 펼치기»",
        JSON.stringify(m1) === JSON.stringify([KO["menu.openPanel"], KO["menu.collapseAll"]]) &&
          afterCollapse === 0 && m2[1] === KO["menu.expandAll"] &&
          JSON.stringify(w.reveals[w.reveals.length - 1]) === JSON.stringify({ kind: "panel" }),
        { m1, m2, afterCollapse },
      ),
    );
    const w4 = mountWidget();
    w4.push("running-work", []);
    w4.push("bg-shells", null);
    out.push(
      assert(
        "셋 다 비면 한 줄(빈 상자는 «고장인가» 로 읽힌다) · 1분마다 다시 그리는 타이머는 치울 때 풀린다",
        JSON.stringify(w4.text(".rw-idle")) === JSON.stringify([KO.idle]) && w4.disposers.length === 1,
        { idle: w4.text(".rw-idle"), disposers: w4.disposers.length },
      ),
    );

    // ── ②③⑥ 패널 ───────────────────────────────────────────────────────────
    const clock = makeClock();
    // 화면 코드의 `Date.now()` 도 이 시계를 따르게 — 강조 만료(«1초 뒤 걷힘»)를 실제로 잰다.
    const BASE = Date.now();
    const ClockDate = class extends Date { static now(): number { return BASE + clock.now(); } };
    const dash = bootDashboard({
      clock,
      i18n: i18nForContext,
      upTo: "tabs.js",
      allIds: true,
      extra: { Date: ClockDate },
      fetch: async (url: string) => {
        if (url.startsWith("/api/timers")) return jsonResponse({ timers: [{ id: 11, label: "남의 타이머", enabled: true, runAt: Date.now() + 600000, originThreadKey: "dashboard:other" }] });
        return jsonResponse({}, 404);
      },
    });
    await clock.advance(20);
    const R = (code: string): any => dash.run(code);
    R(`handleWorkerEvent({ jobId: "o1", status: "running", threadKey: "dashboard:other", ownerThreadKey: "dashboard:other", label: "남의 잡", kind: "worker" }, Date.now())`);
    R(`handleWorkerEvent({ jobId: "d1", status: "running", threadKey: "dashboard:default", ownerThreadKey: "dashboard:default", label: "끝날 잡", kind: "worker" }, Date.now())`);
    R(`handleWorkerEvent({ jobId: "d1", status: "done", threadKey: "dashboard:default", ownerThreadKey: "dashboard:default", label: "끝날 잡", kind: "worker" }, Date.now())`);
    const scope0 = R(`bgSessionScope`);
    const filter0 = R(`bgFilter`);
    R(`document.getElementById("bg-jobs-head").click()`); // 묶음 접기
    const collapsed0 = R(`document.getElementById("bg-jobs-head").classList.contains("collapsed")`);
    R(`window.dispatchEvent(new CustomEvent("tigu:reveal", { detail: { kind: "job", id: "o1" } }))`);
    await clock.advance(30);
    const scope1 = R(`bgSessionScope`);
    const expanded1 = !R(`document.getElementById("bg-jobs-head").classList.contains("collapsed")`);
    const flash1 = R(`jobCards.get("o1").el.classList.contains("bg-flash")`);
    R(`window.dispatchEvent(new CustomEvent("tigu:reveal", { detail: { kind: "job", id: "d1" } }))`);
    await clock.advance(30);
    const filter1 = R(`bgFilter`);
    out.push(
      assert(
        "★★«그 카드로» 는 가린 축만 푼다 — 다른 대화 잡 → 범위 «전체 대화» · 접힌 묶음 → 펼침 · 그 카드 강조 / 끝난 잡 → 필터 «완료»",
        scope0 === "session" && scope1 === "all" && collapsed0 === true && expanded1 && flash1 === true &&
          filter0 === "running" && filter1 === "done",
        { scope0, scope1, collapsed0, expanded1, flash1, filter0, filter1 },
      ),
    );
    R(`document.getElementById("toast").textContent = ""`);
    R(`window.dispatchEvent(new CustomEvent("tigu:reveal", { detail: { kind: "job", id: "없는-잡" } }))`);
    await clock.advance(30);
    const toast = String(R(`document.getElementById("toast").textContent`));
    out.push(assert("못 찾으면 알린다(조용히 실패하지 않는다)", toast === i18nForContext("bg.reveal.notFound"), toast));
    // 셸·타이머도 같은 판정
    R(`setBgSessionScope("session")`);
    R(`upsertShellEntry("sh1", { command: "npm run dev", status: "running", threadKey: "dashboard:other", ownerTk: "dashboard:other" }, { visible: true }); renderShellsView();`);
    const shellHiddenBefore = R(`document.querySelector('#bg-shells-list .shell-card[data-shell-id="sh1"]') === null`);
    R(`window.dispatchEvent(new CustomEvent("tigu:reveal", { detail: { kind: "shell", id: "sh1" } }))`);
    await clock.advance(30);
    const shellScope = R(`bgSessionScope`);
    const shellCard = R(`(() => { const c = document.querySelector('#bg-shells-list .shell-card[data-shell-id="sh1"]'); return c ? c.classList.contains("bg-flash") : null; })()`);
    const shellOpen = R(`shellRegistry.get("sh1").expanded`);
    // ★셸 목록은 출력이 올 때마다 통째로 다시 그린다 — 강조가 노드에만 붙어 있으면 바로 사라졌다(헤드리스 10-21). 다시 그려도 남는다.
    R(`renderShellsView()`);
    const shellFlashAfterRerender = R(`(() => { const c = document.querySelector('#bg-shells-list .shell-card[data-shell-id="sh1"]'); return c ? c.classList.contains("bg-flash") : null; })()`);
    R(`setBgSessionScope("session")`);
    const timerHiddenBefore = R(`bgTimersList.querySelector('.bg-timer[data-timer-id="11"]') === null`);
    R(`window.dispatchEvent(new CustomEvent("tigu:reveal", { detail: { kind: "timer", id: "11" } }))`);
    await clock.advance(30);
    // ★패널을 열면 타이머를 다시 받아 목록을 통째로 다시 그린다 — 강조가 줄에만 붙어 있으면 0.45초 만에 사라졌다(적대 검토 10-21).
    //  0.5초 뒤 다시 그려도 남고, 1초 넘으면 걷힌다(영구 강조도 안 된다 — 재검토 10-21).
    const timerRow = `(() => { const r = bgTimersList.querySelector('.bg-timer[data-timer-id="11"]'); return r ? r.classList.contains("bg-flash") : null; })()`;
    await clock.advance(470);
    R(`renderBgTimers()`);
    const timerFlash = R(timerRow);
    await clock.advance(600);
    const timerFlashGone = R(timerRow);
    // 소속을 못 푼 셸(부모 잡이 사라짐) — 잡 좌표(`worker:…`)를 대화로 내지 않는다(패널 카드처럼 «미상»).
    R(`upsertShellEntry("sg", { command: "orphan", status: "running", threadKey: "worker:gone", ownerTk: "" }, { visible: true }); renderShellsView();`);
    const orphanOwner = R(`(() => { let got = null; window.resourceStore.resource("bg-shells").subscribe((v) => { got = (v || []).find((x) => x.shellId === "sg"); }); return got ? got.ownerThreadKey : "없음"; })()`);
    R(`shellRegistry.delete("sg"); renderShellsView();`);
    R(`handleWorkerEvent({ jobId: "pj", status: "running", threadKey: "dashboard:mine", ownerThreadKey: "dashboard:mine", label: "부모", kind: "worker" }, Date.now())`);
    R(`upsertShellEntry("sk", { command: "child", status: "running", threadKey: "worker:pj", ownerTk: "" }, { visible: true }); renderShellsView();`);
    const resolvedOwner = R(`(() => { let got = null; window.resourceStore.resource("bg-shells").subscribe((v) => { got = (v || []).find((x) => x.shellId === "sk"); }); return got ? got.ownerThreadKey : "없음"; })()`);
    R(`shellRegistry.delete("sk"); renderShellsView();`);
    out.push(assert("부모 잡을 알면 셸 소속은 그 잡의 원 세션(잡 좌표를 원 세션으로 환원 — 패널 카드와 같은 규칙)", resolvedOwner === "dashboard:mine", { resolvedOwner }));
    out.push(assert("소속을 못 푼 셸은 소속 «미상»(빈 값)으로 낸다 — 잡 좌표를 대화 이름처럼 쓰지 않는다", orphanOwner === "", { orphanOwner }));
    // 위젯이 받는 값 — 패널이 셸·타이머 목록을 리소스로도 낸다(범위와 무관한 전체).
    const fed = R(`(() => { const got = {}; for (const n of ["bg-shells", "bg-timers"]) window.resourceStore.resource(n).subscribe((v) => { got[n] = v; }); return got; })()`);
    await clock.advance(5);
    const fedNow = R(`(() => { const got = {}; for (const n of ["bg-shells", "bg-timers"]) window.resourceStore.resource(n).subscribe((v) => { got[n] = (v || []).map((x) => String(x.shellId || x.id)); }); return got; })()`);
    out.push(
      assert(
        "★패널이 셸·타이머 목록을 리소스로 낸다 — 위젯이 패널을 안 열어도 받는다(다른 대화 것 포함)",
        JSON.stringify(fedNow) === JSON.stringify({ "bg-shells": ["sh1"], "bg-timers": ["11"] }),
        { fedNow, first: fed },
      ),
    );
    out.push(
      assert(
        "★셸·타이머도 같은 판정 — 다른 대화 것이라 가려져 있던 카드가 범위를 풀고 강조된다 · 셸은 펼친다(타이머엔 펼칠 상세가 없다)",
        shellHiddenBefore === true && shellScope === "all" && shellCard === true && shellOpen === true && shellFlashAfterRerender === true &&
          timerHiddenBefore === true && timerFlash === true && timerFlashGone === false,
        { shellHiddenBefore, shellScope, shellCard, shellOpen, shellFlashAfterRerender, timerHiddenBefore, timerFlash, timerFlashGone },
      ),
    );
    // ③ 진행 중은 상한 밖
    const kept = R(`(() => {
      let list = [];
      list = applyJobEvent(list, { jobId: "long", status: "running", startedAt: 1 });
      for (let i = 0; i < 80; i++) list = applyJobEvent(list, { jobId: "e" + i, status: "done" });
      for (let i = 0; i < 60; i++) list = applyJobEvent(list, { jobId: "r" + i, status: "running" });
      return { long: list.some((j) => j.jobId === "long"), running: list.filter((j) => j.status === "running").length, ended: list.filter((j) => j.status !== "running").length };
    })()`);
    out.push(
      assert(
        "★★진행 중은 상한 밖 — 끝난 이벤트 80개 뒤에도 오래 도는 잡이 남고, 진행 중 61개 전부 · 끝난 것만 50개",
        kept.long === true && kept.running === 61 && kept.ended === 50,
        kept,
      ),
    );
    // ⑥ owned
    const owned = R(`(() => {
      const o = window.resourceStore.owned("regr-owned");
      const same = window.resourceStore.owned("regr-owned") === o;
      o.set([1]);
      let got = null;
      window.resourceStore.resource("regr-owned").subscribe((v) => { got = v; });
      return { same };
    })()`);
    await clock.advance(5);
    const ownedAfter = R(`(() => { let got = "unset"; window.resourceStore.resource("regr-owned").subscribe((v) => { got = v; }); const o = window.resourceStore.owned("regr-owned"); o.set([1, 2]); const first = got; return { first: JSON.stringify(first) }; })()`);
    const html = readFileSync(path.join(REPO, "packages/dashboard/index.html"), "utf8");
    const order = (f: string): number => html.indexOf(`src="/js/${f}"`);
    const manifest = JSON.parse(readFileSync(path.join(REPO, "packages/dashboard/js/_manifest.json"), "utf8")) as string[];
    const users = manifest.filter((f) => f !== "resource-store.js" && /resourceStore\.(owned|resource)\(/.test(readFileSync(path.join(REPO, "packages/dashboard/js", f), "utf8")));
    const late = users.filter((f) => order(f) < order("resource-store.js"));
    out.push(
      assert(
        "화면 소유 리소스: 같은 이름은 같은 소유자 · 값을 바꾸면 구독자가 받는다 · ★저장소를 쓰는 파일이 전부 저장소 **뒤에** 실린다(앞이면 등록 때 `resourceStore` 가 없다)",
        owned.same === true && ownedAfter.first === "[1,2]" && users.length >= 3 && late.length === 0 && order("resource-store.js") > 0,
        { owned, ownedAfter, users, late },
      ),
    );

    // ── ④ 위젯 호스트: 메뉴는 인스턴스 것 ─────────────────────────────────────
    const c2 = makeClock();
    const host = bootDashboard({ clock: c2, i18n: i18nForContext, upTo: "history-render.js", allIds: true, fetch: async () => jsonResponse({}, 404) });
    const H = (code: string): any => host.run(code);
    H(`window.tiguWidgets.register("regr/menu", { mount(el, _d, ctx) { ctx.menu(() => [{ label: "칸 " + el.id, run() {} }]); }, unmount() {} })`);
    H(`(() => { for (const id of ["ma", "mb"]) { const b = document.createElement("div"); b.id = id; b.dataset.widget = "regr/menu"; document.body.appendChild(b); widgetHost.mount(b, { widget: "regr/menu", data: null }); } })()`);
    await c2.advance(5);
    const ma = H(`widgetHost.menuFor(document.getElementById("ma")).map((x) => x.label)`);
    const mb = H(`widgetHost.menuFor(document.getElementById("mb")).map((x) => x.label)`);
    H(`window.__ma = document.getElementById("ma"); window.__ma.remove();`);
    await c2.advance(5);
    const maAfter = H(`widgetHost.menuFor(window.__ma).length`);
    const menus = H(`widgetHost.state().menus`);
    out.push(
      assert(
        "★메뉴 provider 는 인스턴스 것 — 같은 종류 둘이 자기 것만 · 칸을 치우면 함께 버려져 다시 안 불린다(전역 등록소에 쌓이지 않는다)",
        JSON.stringify(ma) === JSON.stringify(["칸 ma"]) && JSON.stringify(mb) === JSON.stringify(["칸 mb"]) && maAfter === 0 && menus === 1,
        { ma, mb, maAfter, menus },
      ),
    );

    // ── ⑦ 이음매 — 부품끼리가 아니라 **실제 파일끼리** (적대 검토 10-21: 위젯은 가짜 ctx, 패널은 이벤트를 직접 쏴서,
    //  호스트의 이벤트 이름을 바꿔도·끄기 본문을 종류 단위로 바꿔도 전부 초록이었다) ─────────────────────────────
    const c3 = makeClock();
    const posts: unknown[] = [];
    const layout = { widgets: [{ id: "w1", type: "running-work/live", size: "wide", config: {} }, { id: "w2", type: "running-work/live", size: "wide", config: {} }], dataRoutes: [] };
    const seam = bootDashboard({
      clock: c3,
      i18n: i18nForContext,
      upTo: "tabs.js",
      allIds: true,
      fetch: async (url: string, init?: { method?: string; body?: string }) => {
        if (url === "/api/home-widgets" && init?.method === "POST") {
          const b = JSON.parse(String(init.body ?? "{}")) as { id?: string };
          posts.push(b);
          layout.widgets = layout.widgets.filter((x) => x.id !== b.id); // 서버가 그 항목을 뺀 것처럼
          return jsonResponse({ ok: true });
        }
        if (url.startsWith("/api/home-widgets")) return jsonResponse(layout);
        return jsonResponse({}, 404);
      },
    });
    const S = (code: string): any => seam.run(code);
    S(WIDGET); // 진짜 플러그인 위젯 — 진짜 호스트(`window.tiguWidgets`)에 등록된다
    S(`upsertShellEntry("sx", { command: "npm run seam", status: "running", threadKey: "dashboard:far", ownerTk: "dashboard:far" }, { visible: true }); renderShellsView();`);
    S(`sessionDisplayNames.set("dashboard:far", "빌드 대화")`);
    const numsBefore = S(`localStorage.getItem(SESSION_NUM_LS)`);
    S(`widgetPanel.open()`);
    await c3.advance(50);
    const seamRows = S(`[...document.querySelectorAll("#wg-list .rw-row")].length`);
    const seamSession = S(`[...document.querySelectorAll('#wg-list .wg-item[data-id="w1"] .rw-session')].map((e) => e.textContent)`);
    const numsAfter = S(`localStorage.getItem(SESSION_NUM_LS)`);
    out.push(
      assert(
        "★위젯의 대화 이름 = 패널 잡 카드와 같은 함수(서버가 준 이름) · 이름을 고르느라 탭 번호를 새로 매기지 않는다(저장소 그대로)",
        JSON.stringify(seamSession) === JSON.stringify(["빌드 대화"]) && numsBefore === numsAfter,
        { seamSession, numsBefore, numsAfter },
      ),
    );
    S(`(() => { const r = [...document.querySelectorAll('#wg-list .wg-item[data-id="w1"] .rw-row')].find((e) => e.textContent.includes("npm run seam")); if (r) r.click(); })()`);
    await c3.advance(30);
    const seamReveal = S(`({ scope: bgSessionScope, flash: (() => { const c = document.querySelector('#bg-shells-list .shell-card[data-shell-id="sx"]'); return c ? c.classList.contains("bg-flash") : null; })() })`);
    out.push(
      assert(
        "★★이음매: 진짜 위젯의 항목을 누르면 진짜 호스트(`ctx.reveal`)를 거쳐 패널이 그 카드로 간다(다른 대화 → 범위 «전체», 강조)",
        seamRows === 2 && seamReveal.scope === "all" && seamReveal.flash === true,
        { seamRows, seamReveal },
      ),
    );
    // 우클릭 메뉴 — 그 칸 위젯의 항목 + 공통 «이 위젯 끄기». 끄기는 **그 항목 id** 로.
    S(`setBgSessionScope("session")`);
    S(`widgetPanel.open()`);
    await c3.advance(50);
    S(`(() => { const t = document.querySelector('#wg-list .wg-item[data-id="w2"] .rw'); t.dispatchEvent({ type: "contextmenu", bubbles: true, _stopped: false, defaultPrevented: false, clientX: 10, clientY: 10, stopPropagation() { this._stopped = true; }, preventDefault() { this.defaultPrevented = true; } }); })()`);
    const menuLabels = S(`[...document.querySelectorAll(".ctx-menu .cm-item .cm-label")].map((e) => e.textContent)`) as string[];
    S(`(() => { const r = [...document.querySelectorAll(".ctx-menu .cm-item")].find((e) => e.querySelector(".cm-label").textContent === ${JSON.stringify(i18nForContext("wg.menu.off"))}); if (r) r.click(); })()`);
    await c3.advance(30);
    S(`widgetPanel.open()`);
    await c3.advance(50);
    const afterOff = S(`[...document.querySelectorAll("#wg-list .wg-item")].map((e) => e.dataset.id)`) as string[];
    // 두 번째 항목(«모두 접기»)을 눌러 그 위젯이 접히는지 — 누른 그 항목이 실행된다(첫 항목으로 고정되면 안 된다)
    S(`(() => { const t = document.querySelector('#wg-list .wg-item[data-id="w1"] .rw'); t.dispatchEvent({ type: "contextmenu", bubbles: true, _stopped: false, defaultPrevented: false, clientX: 10, clientY: 10, stopPropagation() { this._stopped = true; }, preventDefault() { this.defaultPrevented = true; } }); })()`);
    S(`(() => { const r = [...document.querySelectorAll(".ctx-menu .cm-item")].find((e) => e.querySelector(".cm-label").textContent === "menu.collapseAll"); if (r) r.click(); })()`);
    await c3.advance(20);
    const rowsAfterCollapse = S(`document.querySelectorAll('#wg-list .wg-item[data-id="w1"] .rw-row').length`);
    S(`(() => { const t = document.querySelector('#wg-list .wg-item[data-id="w1"] .rw'); t.dispatchEvent({ type: "contextmenu", bubbles: true, _stopped: false, defaultPrevented: false, clientX: 10, clientY: 10, stopPropagation() { this._stopped = true; }, preventDefault() { this.defaultPrevented = true; } }); })()`);
    S(`(() => { const r = [...document.querySelectorAll(".ctx-menu .cm-item")].find((e) => e.querySelector(".cm-label").textContent === "menu.openPanel"); if (r) r.click(); })()`);
    await c3.advance(30);
    const bgOpened = S(`document.body.classList.contains("bg-open")`);
    out.push(
      assert(
        "★★이음매: 위젯 패널 우클릭 = 그 칸 위젯의 항목(패널 열기·모두 접기) + «이 위젯 끄기» · 끄기는 **그 항목 id 하나**(`{id}` — 종류 단위면 같은 종류가 전부 꺼진다)이고 끈 뒤 목록을 다시 받아 그 위젯이 사라진다 · 누른 그 항목이 실행된다",
        JSON.stringify(menuLabels) === JSON.stringify(["menu.openPanel", "menu.collapseAll", i18nForContext("wg.menu.off")]) &&
          JSON.stringify(posts) === JSON.stringify([{ id: "w2" }]) && JSON.stringify(afterOff) === JSON.stringify(["w1"]) &&
          rowsAfterCollapse === 0 && bgOpened === true,
        { menuLabels, posts, afterOff, rowsAfterCollapse, bgOpened },
      ),
    );
    // 라우트 — `{id}` 갈래가 종류 단위 검사보다 **앞**에서 그 항목 하나를 뺀다(뒤로 가면 끄기가 늘 400 이었다 — 정규식 게이트는 «있다» 만 봤다)
    const routes = await loadPluginModule<{ handleHomeWidgetToggle: (c: unknown) => Promise<void> }>("../../../plugins/http-bridge/routes-inventory.ts");
    const callToggle = async (body: unknown): Promise<{ status: number; body: any }> => {
      const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { headers: {} });
      const res = { status: 0, text: "", writeHead(st: number) { res.status = st; return res; }, setHeader() {}, end(b?: string) { res.text = b ?? ""; } };
      await routes.handleHomeWidgetToggle({ req, res } as never);
      return { status: res.status, body: JSON.parse(res.text || "{}") };
    };
    writeHomeWidgets([
      { id: "r1", type: "running-work/live", size: "wide", config: {} },
      { id: "r2", type: "running-work/live", size: "wide", config: {} },
    ] as never);
    const rOk = await callToggle({ id: "r1" });
    const rLeft = readHomeWidgets(new Set(["running-work"])).widgets.map((x) => x.id);
    const rMissing = await callToggle({ id: "없음" });
    writeHomeWidgets([] as never);
    out.push(
      assert(
        "★라우트: `{id}` → 200·그 항목 하나만 빠짐 · 없는 id → 404(«이미 없습니다» 를 조용히 성공으로 내지 않는다)",
        rOk.status === 200 && JSON.stringify(rLeft) === JSON.stringify(["r2"]) && rMissing.status === 404,
        { rOk, rLeft, rMissing },
      ),
    );

    // ── ⑧ 이름이 늦게 온다 — 부팅 직후 이름 지도가 비어 «대화 미상» 으로 그린 뒤, 대화 목록이 오면 **다시 그린다**(재검토 10-21: 최대 1분 «미상»)
    const c4 = makeClock();
    let sessionsBody: unknown = { sessions: [] };
    const lateDash = bootDashboard({
      clock: c4,
      i18n: i18nForContext,
      upTo: "chat-search.js",
      allIds: true,
      // tabs.js 가 부팅 끝에 실시간 연결을 연다 — 이 검사는 연결이 필요 없다(대역).
      extra: { EventSource: class { onmessage = null; onerror = null; onopen = null; addEventListener() {} close() {} } },
      fetch: async (url: string) => {
        if (url.startsWith("/api/sessions")) return jsonResponse(sessionsBody);
        if (url.startsWith("/api/home-widgets")) return jsonResponse({ widgets: [{ id: "w1", type: "running-work/live", size: "wide", config: {} }], dataRoutes: [] });
        return jsonResponse({}, 404);
      },
    });
    const L = (code: string): any => lateDash.run(code);
    L(WIDGET);
    L(`upsertShellEntry("sl", { command: "npm run late", status: "running", threadKey: "dashboard:late", ownerTk: "dashboard:late" }, { visible: true }); renderShellsView();`);
    const numsLate0 = L(`localStorage.getItem(SESSION_NUM_LS)`);
    L(`widgetPanel.open()`);
    await c4.advance(50);
    const lateBefore = L(`[...document.querySelectorAll("#wg-list .rw-session")].map((e) => e.textContent)`);
    const numsLate1 = L(`localStorage.getItem(SESSION_NUM_LS)`);
    sessionsBody = { sessions: [{ threadKey: "dashboard:late", displayName: "늦은 대화" }] };
    L(`refreshSessionPreviews()`);
    await c4.advance(50);
    const lateAfter = L(`[...document.querySelectorAll("#wg-list .rw-session")].map((e) => e.textContent)`);
    out.push(
      assert(
        "★★이름이 늦게 와도 위젯이 바로 다시 그린다(1분 틱을 기다리지 않는다) · 이름을 모르는 동안 «미상» 이고 탭 번호를 새로 매기지 않는다",
        JSON.stringify(lateBefore) === JSON.stringify(["session.unknown"]) && numsLate0 === numsLate1 &&
          JSON.stringify(lateAfter) === JSON.stringify(["늦은 대화"]),
        { lateBefore, lateAfter, numsLate0, numsLate1 },
      ),
    );

    // ── ⑤ 서버: 항목 하나 끄기 ────────────────────────────────────────────────
    const known = new Set(["running-work", "weather"]);
    const AV = [{ type: "running-work/live", size: "wide" as const, default: true }];
    // ★«물어봄» 기록(seeded)을 비우고 시작한다 — 남아 있으면 «끄기가 seeded 를 적는가» 가 안 보인다(변이로 확인했다).
    const settingsFile = getPaths().settings;
    const root = existsSync(settingsFile) ? (JSON.parse(readFileSync(settingsFile, "utf8")) as Record<string, any>) : {};
    if (root.dashboard?.home) delete root.dashboard.home.seeded;
    writeFileSync(settingsFile, JSON.stringify(root));
    writeHomeWidgets([
      { id: "w1", type: "running-work/live", size: "wide", config: {} },
      { id: "w2", type: "running-work/live", size: "wide", config: {} },
    ] as never);
    const r1 = removeHomeWidget("w1");
    const left = readHomeWidgets(known).widgets.map((x) => x.id);
    removeHomeWidget("w2");
    const reseeded = seedDefaultHomeWidgets(AV as never); // 다 끈 뒤의 다음 부팅
    const reseeded2 = seedDefaultHomeWidgets(AV as never);
    const afterAll = readHomeWidgets(known).widgets.length;
    const missing = removeHomeWidget("없음");
    writeHomeWidgets([] as never);
    out.push(
      assert(
        "★★«이 위젯 끄기» = 그 항목 하나 — 같은 종류 둘 중 하나만 사라진다 · 다 꺼도 기본 위젯이 다음 부팅(자동 편입)에 안 되살아난다 · 없는 항목은 거절",
        r1.ok === true && JSON.stringify(left) === JSON.stringify(["w2"]) && reseeded.length === 0 && reseeded2.length === 0 &&
          afterAll === 0 && missing.ok === false,
        { r1, left, reseeded, reseeded2, afterAll, missing },
      ),
    );
    void dispatch; void makeEvent;
    return out;
  },
};

export default check;
