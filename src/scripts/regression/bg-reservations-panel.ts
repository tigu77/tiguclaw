/** 타이머/반복 예약 실제 JS+마크업 계약. 미니 DOM은 레이아웃/진짜 포인터·CSS 검증을 대신하지 않는다. */
import { readFileSync } from "node:fs";
import { bgPanelHtml } from "./_bg-panel-fixture.js";
import assert from "node:assert/strict";
import { bootDashboard, dispatch as dispatchEvent, jsonResponse, makeClock, makeEvent } from "./_mini-dom.js";
import { assert as record, i18nForContext, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "bg-reservations-panel",
  guards: "예약 두 줄(날짜/주기·세션·⋮ / 내용)·⋮ 메뉴(이동·타이머 멈추기)·상세·반복/꺼짐·focus·필터·경합 보존",
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
    // 날짜/주기·내용·세션·⋮ 는 같은 copy 열 안에 있다. DOM 순서(날짜→내용→세션→⋮)가 Tab 순서(내용→세션→⋮)를 정하고,
    // 세션·⋮ 의 «첫 줄 오른쪽» 위치는 아래 CSS grid 배치가 정한다(2026-11-12 정태님 «정확히 두 줄 · 우상단 끝 ⋮ · 그 왼쪽 세션»).
    for (const row of [timerRow, rows('[data-schedule-id="21"]')[0]]) {
      const info = row.querySelector(".bg-timer-info")!;
      const when = row.querySelector(".bg-timer-when, .bg-schedule-when")!;
      assert.ok(when.parentNode === info, "날짜/주기는 내용과 같은 가용 폭을 쓴다");
      // 노드 equal 은 실패 시 DOM 전체를 직렬화해 OOM(137)으로 끝난다 — 동일성은 불리언으로 본다.
      assert.ok(info.children[0] === when, "첫 행 날짜/주기");
      assert.ok(info.children[1] === label(row), "둘째 행 예약내용");
      assert.ok(info.children[2] === row.querySelector(".bg-timer-session"), "세션은 내용 뒤(Tab: 내용 → 세션 → ⋮)");
      assert.ok(info.children[3] === row.querySelector(".bg-timer-menu") && info.children.length === 4, "⋮ 는 DOM 마지막");
      assert.ok(row.children.length === 1 && row.children[0] === info, "카드 밖 독립 열(옛 멈추기) 없음");
      const menuBtn = row.querySelector(".bg-timer-menu")!;
      assert.ok(menuBtn.textContent === "⋮" && menuBtn.getAttribute("role") === "button" && menuBtn.tabIndex === 0 && menuBtn.getAttribute("aria-haspopup") === "menu", "⋮ 는 키보드로 닿는 메뉴 버튼");
      assert.ok(menuBtn.classList.contains("cm-kebab"), "기존 ⋯ 메뉴 프리미티브(attachKebab)를 쓴다");
      assert.ok(row.querySelector(".bg-timer-stop") === null, "멈추기는 카드가 아니라 ⋮ 메뉴 안");
    }
    assertIncludes(rows('[data-schedule-id="21"]')[0].querySelector(".bg-schedule-when")!.textContent, current.cronExpr);

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
    // keyed DOM: 이름뿐 아니라 ⋮/배지와 native details summary/open까지 보존.
    const stop = timerRow.querySelector(".bg-timer-menu")!;
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
    // ── ⋮ 메뉴(2026-11-12): 카드에 원래 있던 동작만 — 상세 보기 · 세션 이동(이름을 아는 세션만) · 타이머만 멈추기.
    //    반복 스케줄엔 멈추기·삭제 없음. 메뉴 수명은 대상 카드와 묶인다(사라지거나 접히면 닫고 포커스를 보이는 자리로).
    const menuOf = () => d.querySelector(".ctx-menu");
    const menuLabels = () => (menuOf() ? menuOf()!.querySelectorAll(".cm-item").map((r: any) => r.querySelector(".cm-label")!.textContent + (r.classList.contains("cm-disabled") ? "(꺼짐)" : "")) : []);
    const menuItem = (text: string) => menuOf()!.querySelectorAll(".cm-item").find((r: any) => r.querySelector(".cm-label")!.textContent === text)!;
    const timerMenu = timerRow.querySelector(".bg-timer-menu")!;
    const scheduleMenu = scheduleRow.querySelector(".bg-timer-menu")!;
    R(`window.__cancels = []; fetch = async (url, init) => { if (url === "/api/cancel-timer") { window.__cancels.push(JSON.parse(init.body).id); return window.__cancelOk === false ? {ok:false,status:500} : {ok:true,status:200,json:async()=>({})}; } return {ok:true,json:async()=>(${payload()})}; };`);
    dispatch(label(timerRow), "click");
    assert.equal(detail.hidden, false);
    dispatch(timerMenu, "click");
    assert.equal(detail.hidden, true, "⋮ 를 열면 떠 있던 상세를 닫는다");
    assert.deepEqual(menuLabels(), ["상세 보기", "세션으로 이동", "멈추기"], "타이머 메뉴 = 상세 · 이동 · 멈추기");
    dispatch(scheduleMenu, "click");
    assert.equal(d.querySelectorAll(".ctx-menu").length, 1, "여러 카드라도 메뉴는 하나");
    assert.deepEqual(menuLabels(), ["상세 보기", "세션으로 이동"], "반복 스케줄 메뉴엔 멈추기·삭제를 새로 만들지 않는다");
    // «상세 보기» = 내용 누르기와 같은 고정 상세(말줄임된 날짜·주기·내용 전체).
    dispatch(menuItem("상세 보기"), "click");
    assert.ok(menuOf() === null && detail.hidden === false && detail.textContent.includes(current.cronExpr) && detail.textContent.includes(current.label), "메뉴 «상세 보기»가 전체 상세를 고정해 연다");
    dispatch(d.body, "pointerdown");
    assert.equal(detail.hidden, true);
    // Esc → 닫고 ⋮ 로 포커스 복귀.
    scheduleMenu.focus();
    dispatch(scheduleMenu, "keydown", { key: "Enter" });
    assert.ok(menuOf() !== null && d.activeElement !== scheduleMenu, "Enter 로 열고 첫 항목으로");
    dispatch(d, "keydown", { key: "Escape" });
    assert.ok(menuOf() === null && d.activeElement === scheduleMenu, "Esc 로 닫고 ⋮ 로 포커스 복귀");
    // 바깥 누르기 닫기.
    dispatch(timerMenu, "click");
    dispatch(d.body, "pointerdown");
    assert.equal(menuOf(), null, "바깥 누르면 닫힘");
    // 메뉴가 열린 채 목록이 다시 그려지고 순서가 바뀌어도 메뉴는 연 때의 id 를 겨눈다.
    dispatch(timerMenu, "click");
    R(`fetch = async (url, init) => { if (url === "/api/cancel-timer") { window.__cancels.push(JSON.parse(init.body).id); return window.__cancelOk === false ? {ok:false,status:500} : {ok:true,status:200,json:async()=>({})}; } return {ok:true,json:async()=>(${payload(list, [{ ...timer, id: 9, runAt: timer.runAt - 5000, label: "earlier" }, timer])})}; }; renderBgTimers(); loadBgTimers();`);
    await flush();
    assert.ok(timers()[0] !== timerRow && timers()[1] === timerRow, "앞에 새 타이머가 끼어 순서가 바뀜");
    assert.ok(menuOf() !== null, "다시 그려도(행이 남아 있으면) 열린 메뉴는 그대로");
    R(`window.__cancelOk = false;`);
    dispatch(menuItem("멈추기"), "click");
    assert.equal(menuOf(), null, "항목 실행 시 닫힘");
    assert.equal(d.activeElement, timerMenu, "항목 실행 뒤 ⋮ 로 포커스 복귀");
    assert.equal(R(`JSON.stringify(window.__cancels)`), JSON.stringify([timer.id]), "열 때의 id 만 멈춘다(순서가 바뀐 뒤에도)");
    // 멈추는 중 다시 연 메뉴: 멈추기는 꺼져 있고, 실패 응답이 오면 그 메뉴를 닫는다(꺼진 채 굳지 않게) — 다시 열면 켜져 있다.
    dispatch(timerMenu, "click");
    assert.deepEqual(menuLabels(), ["상세 보기", "세션으로 이동", "멈추기(꺼짐)"], "멈추는 중에는 멈추기를 끈다");
    menuItem("상세 보기").focus();
    await flush();
    assertIncludes(el("toast").textContent, "멈추지 못했습니다");
    assert.equal(timers()[1], timerRow, "실패면 그대로 둔다");
    assert.ok(menuOf() === null && d.activeElement === timerMenu, "실패하면 멈추는 중에 연 메뉴를 닫고 ⋮ 로 포커스를 돌린다");
    dispatch(timerMenu, "click");
    assert.deepEqual(menuLabels(), ["상세 보기", "세션으로 이동", "멈추기"], "실패하면 멈추기를 되살린다");
    dispatch(d, "keydown", { key: "Escape" });
    R(`window.__cancelOk = true; window.__cancels.length = 0;`);
    await load();
    // 메뉴가 열린 카드가 목록에서 사라지면: 메뉴를 닫고, 포커스가 메뉴 안이었으면 보이는 타이머 머리줄로.
    const earlier = { ...timer, id: 9, runAt: timer.runAt - 5000, label: "earlier" };
    await load(list, [earlier, timer]);
    const earlierMenu = timers()[0].querySelector(".bg-timer-menu")!;
    earlierMenu.focus();
    dispatch(earlierMenu, "keydown", { key: "Enter" });
    assert.ok(menuOf() !== null && d.activeElement !== earlierMenu);
    await load(list, [timer]);
    assert.ok(menuOf() === null, "대상 카드가 사라지면 메뉴를 닫는다");
    assert.ok(d.activeElement === el("bg-timers-head"), "포커스는 보이는 타이머 머리줄로(사라진 버튼에 남지 않는다)");
    // 메뉴가 열린 반복 스케줄이 꺼져 접힌 «꺼짐» 영역으로 옮겨지면: 메뉴를 닫고 포커스는 꺼짐 요약으로.
    (el("bg-schedules-off") as any).open = false;
    scheduleMenu.focus();
    dispatch(scheduleMenu, "keydown", { key: "Enter" });
    assert.ok(menuOf() !== null);
    await load([{ ...current, enabled: false }, off, reboot], [timer]);
    assert.ok(el("bg-schedules-off-list").contains(scheduleRow), "꺼진 스케줄은 꺼짐 영역으로 옮겨진다");
    assert.ok(menuOf() === null, "접힌 영역으로 옮겨지면 메뉴를 닫는다");
    assert.ok(d.activeElement === el("bg-schedules-off-summary"), "포커스는 꺼짐 요약으로");
    await load();
    // 메뉴를 연 뒤 세션 이름을 잃으면(목록 갱신 등) 이미 보이는 «세션으로 이동»도 실행 때 다시 막는다.
    {
      const activeBefore = R(`activeThreadKey`);
      R(`sessionDisplayNames.set('cli:current','Changed title'); window.refreshBgSessionBadges();`);
      dispatch(scheduleMenu, "click");
      assert.ok(menuLabels().includes("세션으로 이동"));
      R(`activeThreadKey = 'cli:elsewhere'; sessionDisplayNames.delete('cli:current'); openTabs = openTabs.filter(t => t.threadKey !== 'cli:current');`);
      dispatch(menuItem("세션으로 이동"), "click");
      assert.equal(R(`activeThreadKey`), "cli:elsewhere", "연 뒤 이름을 잃은 세션으로는 이동하지 않는다(실행 때 재확인)");
      R(`activeThreadKey = ${JSON.stringify(activeBefore)}; sessionDisplayNames.set('cli:current','Changed title'); window.refreshBgSessionBadges(); renderBgTimers();`);
    }
    // 이름을 모르는 세션(원시 좌표 · scheduler:<id>)은 배지처럼 이동을 주지 않는다.
    const scopeBefore = R(`bgSessionScope`);
    R(`setBgSessionScope("all");`);
    for (const id of ["25", "26"]) {
      dispatch(rows(`[data-schedule-id="${id}"]`)[0].querySelector(".bg-timer-menu")!, "click");
      assert.deepEqual(menuLabels(), ["상세 보기"], `이름 미상 세션(${id})엔 «세션으로 이동» 없음`);
      dispatch(d, "keydown", { key: "Escape" });
    }
    R(`setBgSessionScope(${JSON.stringify(scopeBefore)});`);
    await load();
    // DOM 배치가 바뀌어도 같은 id 컨트롤은 재생성하지 않는다.
    timerLabel.focus();
    await load(list, [{ ...timer, id: 2, runAt: timer.runAt - 1000 }, timer]);
    // 노드 equal 은 실패 시 DOM 전체를 직렬화해 OOM(137)으로 끝난다 — 동일성은 불리언으로 본다.
    assert.ok(timers()[1] === timerRow, "같은 id 행은 재생성하지 않는다");
    assert.ok(d.activeElement === timerLabel, "재배치 뒤에도 focus 유지");
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
    // 마지막 예약이 사라져 두 묶음이 숨어도 포커스는 보이는 패널 컨트롤(닫기)로.
    {
      await load([], [timer]);
      const lastMenu = timers()[0].querySelector(".bg-timer-menu")!;
      lastMenu.focus();
      dispatch(lastMenu, "keydown", { key: "Enter" });
      assert.ok(menuOf() !== null);
      await load([], []);
      assert.ok(menuOf() === null && el("bg-timers").hidden === true && el("bg-schedules").hidden === true);
      assert.ok(d.activeElement === el("bg-close"), "두 묶음이 모두 숨으면 포커스는 패널 닫기 버튼으로");
    }
    // 시각·말줄임·축소 화면 실제 geometry는 독립 browser QA 인계.
    const css = readFileSync(new URL("../../../packages/dashboard/app.css", import.meta.url), "utf8");
    assert.ok(/\.bg-timer-label\s*\{[^}]*text-overflow:ellipsis[^}]*white-space:nowrap/.test(css));
    assert.ok(/\.bg-timer-label\s*\{[^}]*min-width:0/.test(css));
    // 첫 줄 = 날짜(1열) + 세션(2열 오른쪽), 둘째 줄 = 내용(두 열 걸침). 실제 좌표·겹침은 브라우저 QA.
    assert.ok(/\.bg-timer-info\s*\{[^}]*display:grid[^}]*grid-template-columns:minmax\(0, max-content\) minmax\(min\(6em, 35%\), 1fr\) auto/.test(css), "예약 copy 열은 grid · 날짜/세션/⋮ 세 칸");
    assert.ok(/\.bg-timer-info > \.bg-timer-menu\s*\{[^}]*grid-area:1 \/ 3/.test(css), "⋮ 는 첫 줄 오른쪽 끝");
    assert.ok(/\.bg-timer-info > \.bg-timer-when, \.bg-timer-info > \.bg-schedule-when\s*\{[^}]*white-space:nowrap[^}]*text-overflow:ellipsis/.test(css), "날짜/주기는 줄바꿈 대신 말줄임(정확히 두 줄)");
    assert.ok(/\.bg-timer-info > \.bg-timer-session\s*\{[^}]*grid-area:1 \/ 2[^}]*justify-self:end/.test(css), "세션은 첫 줄 오른쪽");
    assert.ok(/\.bg-timer-info > \.bg-timer-label\s*\{[^}]*grid-area:2 \/ 1 \/ 3 \/ 4/.test(css), "내용은 둘째 줄 전체 폭");
    assert.ok(/\.bg-timer-info > \.bg-timer-when, \.bg-timer-info > \.bg-schedule-when\s*\{[^}]*grid-area:1 \/ 1/.test(css), "날짜/주기는 첫 줄 왼쪽");
    assert.equal(clock.errors.length, 0, JSON.stringify(clock.errors));
    return [record("실제 예약 JS/패널 계약", true, "날짜/주기 첫행·세션·⋮ 첫행 오른쪽·내용 둘째행·⋮ 메뉴(이동·타이머 멈추기·Esc 복귀·id 고정·실패 복구), safe label 상세·첫 tap/hover/키보드·focus/summary/open 보존, 반복/꺼짐/필터/원시 좌표/이동, 실행중 집계 불변, stale/resync. 실제 pointer geometry는 별도 QA")];
  },
};
