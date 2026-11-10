/** 타이머/반복 예약 실제 JS+마크업 계약. 미니 DOM은 레이아웃/진짜 포인터·CSS 검증을 대신하지 않는다. */
import { readFileSync } from "node:fs";
import { bgPanelHtml } from "./_bg-panel-fixture.js";
import assert from "node:assert/strict";
import { bootDashboard, dispatch as dispatchEvent, jsonResponse, makeClock, makeEvent } from "./_mini-dom.js";
import { assert as record, i18nForContext, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "bg-reservations-panel",
  guards: "예약 날짜/주기·내용 행 분리·상세·반복/꺼짐·focus·필터·경합 보존",
  async run() {
    const clock = makeClock();
    const dom = bootDashboard({ html: bgPanelHtml(), clock, i18n: i18nForContext, allIds: true, upTo: "chat-search.js", extra: { EventSource: class { onmessage = null; onerror = null; onopen = null; addEventListener() {} close() {} } },
      fetch: async () => jsonResponse({ timers: [], schedules: [] }) });
    const R = (js: string): any => dom.run(js);
    const dispatch = (target: any, type: string, extra: any = {}) => dispatchEvent(target, makeEvent(type, { bubbles: true, ...extra }));
    R(`activeThreadKey = 'cli:current';`);
    const assertIncludes = (actual: string, expected: string) => assert.ok(actual.includes(expected), JSON.stringify({ actual, expected }));
    const d = dom.document;
    const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
    const el = (id: string) => d.getElementById(id)!;
    const timers = () => el("bg-timers-list").querySelectorAll(".bg-timer");
    const schedules = () => el("bg-schedules").querySelectorAll(".bg-schedule");
    const rows = (sel: string) => el("bg-schedules").querySelectorAll(sel);
    const label = (row: any) => row.querySelector(".bg-timer-label")!;
    const detail = el("bg-reservation-detail");
    const timer = { id: 1, label: 'long timer <unsafe> & label '.repeat(12), runAt: Date.now() + 60_000, enabled: true, originThreadKey: "cli:current", destChannel: "cli", destTarget: null, prompt: "PROMPT_PRIVATE_TIMER" };
    const current = { id: 21, label: "current cron <unsafe>", triggerType: "cron", cronExpr: "0 9 * * *", timezone: "Asia/Seoul", nextRun: Date.now() + 3600_000, enabled: true, originThreadKey: "cli:current", destChannel: "cli", destTarget: "current", prompt: "PROMPT_PRIVATE_SCHEDULE", lastError: "SCHEDULE_ERROR_PRIVATE" };
    const other = { ...current, id: 22, label: "other", nextRun: null, originThreadKey: "cli:other" };
    const off = { ...current, id: 23, label: "off cron", enabled: false };
    const reboot = { ...current, id: 24, label: "reboot", triggerType: "reboot", nextRun: null };
    const migrated = { ...current, id: 25, label: "null origin", originThreadKey: null, destChannel: "cli", destTarget: "current", nextRun: null };
    const broken = { ...current, id: 26, label: "orphan", originThreadKey: "cli:deleted" };
    const list = [current, other, off, reboot, migrated, broken];
    const payload = (s: any[] = list, t: any[] = [timer]) => JSON.stringify({ timers: t, schedules: s });
    const load = async (s: any[] = list, t: any[] = [timer]) => {
      R(`fetch = () => Promise.resolve({ok:true,json:async()=>(${payload(s, t)})}); loadBgTimers();`);
      await flush();
    };
    R(`sessionDisplayNames.set('cli:current','Current title'); sessionDisplayNames.set('cli:other','Other title');`);
    const runningBefore = R(`jobCards.size + ':' + bgCountRunning.textContent`);
    await load();
    assert.equal(timers().length, 1);
    assert.equal(schedules().length, 3, "current + off + reboot (null origin은 scheduler 전용)");
    assert.equal(el("bg-schedules-list").children.length, 2);
    assert.equal(el("bg-schedules-off-list").children.length, 1);
    assert.equal(R(`jobCards.size + ':' + bgCountRunning.textContent`), runningBefore, "예약으로 실행중 집계를 부풀리지 않는다");
    assert.equal(el("bg-schedules-count").textContent, "· 3개");
    assert.equal(rows('[data-schedule-id="24"]')[0].querySelector(".bg-schedule-when")!.textContent, "데몬 시작 시");
    assert.equal(rows('[data-schedule-id="25"]').length, 0, "발송 목적지를 실행세션으로 쓰지 않는다");
    const timerRow = timers()[0];
    const timerLabel = label(timerRow);
    // 날짜/주기와 내용은 가로 경쟁하지 않고 같은 copy 열 안의 독립 행이다.
    for (const row of [timerRow, rows('[data-schedule-id="21"]')[0]]) {
      const info = row.querySelector(".bg-timer-info")!;
      const when = row.querySelector(".bg-timer-when, .bg-schedule-when")!;
      assert.ok(when.parentNode === info, "날짜/주기는 내용과 같은 가용 폭을 쓴다");
      assert.equal(info.children[0], when, "첫 행 날짜/주기");
      assert.equal(info.children[1], label(row), "둘째 행 예약내용");
      assert.equal(info.children[2], row.querySelector(".bg-timer-session"), "대화 표시는 별도 작은 행");
    }
    assertIncludes(rows('[data-schedule-id="21"]')[0].querySelector(".bg-schedule-when")!.textContent, current.cronExpr);
    assert.equal(timerRow.children[timerRow.children.length - 1].className, "bg-timer-stop", "멈추기는 오른쪽 독립 열");

    assert.equal(timerLabel.tagName, "BUTTON", "키보드 Enter/Space와 mobile tap native control");
    assert.equal(timerLabel.textContent, timer.label, "전체 label은 textContent이고 잘라 저장하지 않는다");
    assert.equal(timerLabel.getAttribute("aria-label"), timer.label);
    assert.equal(timerLabel.getAttribute("title"), null, "prompt 포함 title 제거");
    assert.equal(timerRow.querySelector("unsafe"), null, "HTML로 해석하지 않는다");
    assert.equal(detail.getAttribute("role"), "tooltip");
    // 포인터가 이름→tooltip으로 이동하는 짧은 공백은 닫지 않고, 둘 다 떠나면 닫는다.
    d.body.focus();
    dispatch(timerLabel, "pointerenter", { pointerType: "mouse" });
    dispatch(timerLabel, "pointerleave");
    await clock.advance(80);
    dispatch(detail, "pointerenter");
    await clock.advance(80);
    assert.equal(detail.hidden, false, "tooltip hover 진입 허용");
    dispatch(detail, "pointerleave");
    await clock.advance(121);
    assert.equal(detail.hidden, true, "포인터가 두 영역을 모두 떠나면 preview 닫음");
    dispatch(timerLabel, "pointerenter", { pointerType: "touch" });
    assert.equal(detail.hidden, true, "touch hover 흉내로 선행 toggle하지 않음");
    // focus→click 첫 tap은 열린 채 pinned. 다음 tap은 닫는다.
    timerLabel.focus();
    dispatch(timerLabel, "focus");
    assert.equal(detail.hidden, false);
    dispatch(timerLabel, "click");
    assert.equal(detail.hidden, false, "focus가 먼저 왔다고 첫 click에서 닫지 않는다");
    assertIncludes(detail.textContent, timer.label);
    assert.equal(detail.textContent.includes("PROMPT_PRIVATE"), false);
    assert.equal(timerLabel.getAttribute("aria-describedby"), detail.id);
    dispatch(timerLabel, "click");
    assert.equal(detail.hidden, true);
    assert.equal(timerLabel.getAttribute("aria-describedby"), null);
    dispatch(timerLabel, "pointerenter", { pointerType: "mouse" });
    dispatch(timerLabel, "click");
    assert.equal(detail.hidden, false, "hover 후 첫 click도 pin");
    dispatch(d.body, "pointerdown");
    assert.equal(detail.hidden, true, "outside tap 닫기");
    // Escape는 패널을 닫지 않고 먼저 상세만 닫는다.
    R(`openBg();`);
    dispatch(timerLabel, "click");
    dispatch(d, "keydown", { key: "Escape" });
    assert.equal(detail.hidden, true);
    assert.equal(el("bg-panel").hidden, false);
    const scheduleRow = rows('[data-schedule-id="21"]')[0];
    const scheduleLabel = label(scheduleRow);
    dispatch(scheduleLabel, "click");
    assertIncludes(detail.textContent, current.label);
    assertIncludes(detail.textContent, current.cronExpr);
    assertIncludes(detail.textContent, current.timezone);
    assert.equal(detail.textContent.includes("PROMPT_PRIVATE"), false);
    assert.equal(detail.textContent.includes("SCHEDULE_ERROR_PRIVATE"), false);
    assert.equal(scheduleRow.querySelector(".bg-timer-stop"), null, "반복예약에 삭제/Stop 컨트롤 추가0");
    dispatch(el("bg-schedules-head"), "click");
    assert.equal(detail.hidden, true);
    assert.equal(el("bg-schedules-head").getAttribute("aria-expanded"), "false");
    assert.equal(R(`localStorage.getItem("bg-cat-collapse:bg-schedules-head")`), "1");
    dispatch(el("bg-schedules-head"), "keydown", { key: " " });
    assert.equal(el("bg-schedules-head").getAttribute("aria-expanded"), "true");
    dispatch(scheduleLabel, "click");
    dispatch(el("bg-scroll"), "scroll");
    assert.equal(detail.hidden, true, "스크롤 후 떠있는 상세 잔존0");
    dispatch(scheduleLabel, "click");
    R(`closeBg();`);
    assert.equal(detail.hidden, true);
    // keyed DOM: 이름뿐 아니라 Stop/배지와 native details summary/open까지 보존.
    const stop = timerRow.querySelector(".bg-timer-stop")!;
    const badge = timerRow.querySelector(".bg-job-session")!;
    const summary = el("bg-schedules-off-summary");
    const offDetails = el("bg-schedules-off");
    (offDetails as any).open = true;
    for (const control of [timerLabel, stop, badge, scheduleLabel, scheduleRow.querySelector(".bg-job-session")!, summary]) {
      control.focus();
      R(`sessionDisplayNames.set('cli:current','Changed title'); window.refreshBgSessionBadges(); renderBgTimers();`);
      await load();
      assert.equal(d.activeElement, control, "주기/배지/resync 갱신 focus 보존");
      assert.equal((offDetails as any).open, true, "native details 열림 유지");
      assert.equal(timers()[0], timerRow);
      assert.equal(rows('[data-schedule-id="21"]')[0], scheduleRow);
    }
    assert.equal(badge.textContent, "↪ Changed title");
    // DOM 배치가 바뀌어도 같은 id 컨트롤은 재생성하지 않는다.
    timerLabel.focus();
    await load(list, [{ ...timer, id: 2, runAt: timer.runAt - 1000 }, timer]);
    assert.equal(timers()[1], timerRow);
    assert.equal(d.activeElement, timerLabel);
    // 전체/현재 필터·세션 이동은 동일한 기존 경로.
    R(`setBgSessionScope(bgSessionScope === "all" ? "session" : "all");`);
    assert.equal(schedules().length, 6);
    const otherBadge = rows('[data-schedule-id="22"]')[0].querySelector(".bg-job-session")!;
    assert.equal(otherBadge.textContent, "↪ Other title");
    assertIncludes(rows('[data-schedule-id="22"]')[0].textContent, "다음 실행 미정");
    assertIncludes(rows('[data-schedule-id="25"]')[0].textContent, "scheduler:25");
    R(`activeThreadKey = 'scheduler:25'; setBgSessionScope("session"); renderBgTimers();`);
    assert.equal(schedules().length, 1);
    assert.equal(label(schedules()[0]).textContent, "null origin");
    R(`activeThreadKey = 'cli:current'; setBgSessionScope("all"); renderBgTimers();`);
    dispatch(otherBadge, "click");
    assert.equal(R(`activeThreadKey`), "cli:other");
    R(`setBgSessionScope(bgSessionScope === "all" ? "session" : "all");`);
    assert.equal(schedules().length, 1);
    assert.equal(label(schedules()[0]).textContent, "other");
    R(`activeThreadKey = 'cli:current'; renderBgTimers();`);
    // 재시작 응답·세션전환 중 late response는 timers/schedules 모두 stale로 버린다.
    R(`var oldReservations; fetch = () => new Promise(r => { oldReservations = r; }); loadBgTimers();`);
    await load([reboot], []);
    R(`oldReservations({ok:true,json:async()=>(${payload([other], [timer])})});`);
    await flush();
    assert.equal(schedules().length, 1);
    assert.equal(label(schedules()[0]).textContent, "reboot");
    assert.equal(timers().length, 0);
    // owner 삭제시 상세도 제거. off details는 비우되 DOM 자체는 재사용한다.
    dispatch(label(schedules()[0]), "click");
    await load([], []);
    assert.equal(detail.hidden, true);
    assert.equal(el("bg-schedules").hidden, true);
    assert.equal(el("bg-timers").hidden, true);
    assert.equal(el("bg-schedules-off"), offDetails);
    // 기존 resyncTimers 경로가 별도 schedule 요청 없이 함께 복원한다.
    R(`fetch = () => Promise.resolve({ok:true,json:async()=>(${payload([current], [timer])})}); window.resyncTimers();`);
    await clock.advance(500);
    assert.equal(schedules().length, 1);
    assert.equal(timers().length, 1);
    // 꺼짐만 있어도 그룹/숫자를 유지하고 새 응답에서 enabled→off 이동은 같은 노드다.
    const activeRow = schedules()[0];
    (offDetails as any).open = false;
    dispatch(label(activeRow), "click");
    await load([{ ...current, enabled: false }], []);
    assert.equal(el("bg-schedules").hidden, false);
    assert.equal(el("bg-schedules-list").children.length, 0);
    assert.equal(el("bg-schedules-off-list").children[0], activeRow);
    assert.equal(detail.hidden, true, "꺼진 접힌 영역에 숨겨진 owner 상세를 남기지 않는다");
    assert.equal(summary.textContent, "꺼짐 1");
    // 이전 서버는 schedules 없이 timers만 보내도 동작. 조회 실패는 유효 목록을 지우지 않는다.
    R(`fetch = async () => ({ok:true,json:async()=>({timers:[${JSON.stringify(timer)}]})}); loadBgTimers();`);
    await flush();
    assert.equal(el("bg-schedules").hidden, true);
    assert.equal(timers().length, 1);
    R(`fetch = async () => { throw new Error("offline"); }; loadBgTimers();`);
    await flush();
    assert.equal(timers().length, 1);
    // 기존 30초 tick/visibility 정책으로 반복 예약의 경과 nextRun도 재조회한다.
    R(`document.visibilityState = "visible";`);
    const overdue = { ...current, nextRun: Date.now() - 10_000 };
    R(`var reservationPolls = 0; fetch = async (url) => { if (url !== "/api/timers") return {ok:false}; reservationPolls++; return {ok:true,json:async()=>(${payload([overdue], [])})}; }; loadBgTimers();`);
    await flush();
    const beforePolls = R(`reservationPolls`);
    await clock.advance(30_000);
    assert.ok(R(`reservationPolls`) > beforePolls);
    R(`document.visibilityState = "hidden";`);
    const hiddenPolls = R(`reservationPolls`);
    await clock.advance(30_000);
    assert.equal(R(`reservationPolls`), hiddenPolls, "비활성 탭 polling0");
    const textAndAttrs = d.querySelectorAll("*").map((x: any) => x.textContent + [...x.attrs.values()].join(" ") + (x.title || "")).join("\n");
    assert.equal(textAndAttrs.includes("PROMPT_PRIVATE"), false, "DOM/title/aria에 prompt 노출0");
    // 시각·말줄임·축소 화면 실제 geometry는 독립 browser QA 인계.
    const css = readFileSync(new URL("../../../packages/dashboard/app.css", import.meta.url), "utf8");
    assert.ok(/\.bg-timer-label\s*\{[^}]*text-overflow:ellipsis[^}]*white-space:nowrap/.test(css));
    assert.ok(/\.bg-timer-label\s*\{[^}]*min-width:0/.test(css));
    assert.ok(/\.bg-timer-info\s*\{[^}]*display:flex[^}]*flex-direction:column/.test(css));
    assert.equal(clock.errors.length, 0, JSON.stringify(clock.errors));
    return [record("실제 예약 JS/패널 계약", true, "날짜/주기 첫행·내용 둘째행·대화 별도·Stop 오른쪽, safe label 상세·첫 tap/hover/키보드·focus/summary/open 보존, 반복/꺼짐/필터/원시 좌표/이동, 실행중 집계 불변, stale/resync. 실제 pointer geometry는 별도 QA")];
  },
};
