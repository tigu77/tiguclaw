/** 기존 상단 필터와 잡카드 이름/원시좌표·이동을 타이머도 그대로 쓴다. 실제 패널/JS 실행. */
import { assert, i18nForContext, type Assertion, type RegressionCheck } from "./_framework.js";
import { bootDashboard, dispatch, jsonResponse, makeClock, makeEvent } from "./_mini-dom.js";
import { bgPanelHtml } from "./_bg-panel-fixture.js";

const timer = (id: number, originThreadKey: string | null) => ({ id, originThreadKey, label: `timer-${id}`, enabled: true, runAt: Date.now() + 600000, destTarget: "dashboard:destination" });

export const check: RegressionCheck = {
  name: "bg-timers-session",
  guards: "타이머 실행 세션을 발송대상/최초 등록세션으로 혼동하거나 현재 범위에서 소속표시가 사라지고 표시 클릭이 Stop/묶음접기로 번지는 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const clock = makeClock();
    // dashboard:deleted는 이름 미상의 합성 좌표. 실제 서버 삭제/이름 캐시 무효화 실험은 아니다.
    let timers = [timer(1, "dashboard:default"), timer(2, "dashboard:other"), timer(3, "dashboard:deleted"), timer(4, null)];
    const cancels: number[] = [];
    const dash = bootDashboard({ clock, i18n: i18nForContext, html: bgPanelHtml(), allIds: true, upTo: "chat-search.js",
      extra: { EventSource: class { onmessage = null; onerror = null; onopen = null; addEventListener() {} close() {} } },
      fetch: async (url: string, init?: { body?: string }) => {
        if (url === "/api/timers") return jsonResponse({ timers });
        if (url === "/api/cancel-timer") { const id = JSON.parse(init?.body ?? "{}").id as number; cancels.push(id); timers = timers.filter((t) => t.id !== id); return jsonResponse({ ok: true }); }
        return jsonResponse({}, 404);
      },
    });
    await clock.advance(30);
    const R = (js: string): any => dash.run(js);
    const list = dash.document.getElementById("bg-timers-list")!;
    const head = dash.document.getElementById("bg-timers-head")!;
    const row = (id: number) => list.querySelector(`.bg-timer[data-timer-id="${id}"]`);
    const badge = (id: number) => row(id)?.querySelector(".bg-job-session");
    const raw = (id: number) => row(id)?.querySelector(".bg-job-rawtk");
    R('sessionDisplayNames.set("dashboard:default", "현재 이름"); sessionDisplayNames.set("dashboard:other", "다른 이름"); sessionDisplayNames.set("dashboard:destination", "발송 목적지"); window.refreshBgSessionBadges();');
    out.push(assert("현재 범위에서도 실행 세션 이름 배지가 항상 보임 · 발송 목적지와 다름",
      list.children.length === 1 && badge(1)?.textContent === "↪ 현재 이름" && badge(1)?.style.display === "" && raw(1)?.style.display === "none" && badge(1)?.title.includes("dashboard:default") === true,
      { text: row(1)?.textContent, title: badge(1)?.title }));
    R('setBgSessionScope("all")');
    out.push(assert("전체 범위도 같은 배지 · 이름 미상 세션은 원시좌표 · null은 전용 scheduler:<id> 좌표(추측 이름/발송대상 없음)",
      list.children.length === 4 && badge(2)?.textContent === "↪ 다른 이름" && badge(2)?.style.display === "" &&
      badge(3)?.style.display === "none" && raw(3)?.textContent === "dashboard:deleted" && raw(3)?.style.display === "" &&
      badge(4)?.style.display === "none" && raw(4)?.textContent === "scheduler:4" && raw(4)?.style.display === "" &&
      !list.textContent.includes("발송 목적지"), list.textContent));
    if (!raw(3) || !raw(4) || !badge(2)) return out; // 소속 표시 누락은 앞의 단언으로 보고한다.
    const before = R('activeThreadKey');
    const beforeTabs = R('JSON.stringify(openTabs)');
    dispatch(raw(3)!, makeEvent("click"));
    dispatch(raw(4)!, makeEvent("click"));
    out.push(assert("이름 모르는 원시좌표는 잡카드처럼 비클릭 · 없는 세션을 열거나 Stop하지 않음", R('activeThreadKey') === before && R('JSON.stringify(openTabs)') === beforeTabs && cancels.length === 0 && head.getAttribute("aria-expanded") === "true", { active: R('activeThreadKey'), cancels }));
    R('activeThreadKey = "scheduler:4"; setBgSessionScope("session"); renderBgTimers()');
    out.push(assert("null origin의 실제 전용 실행세션을 현재로 보면 해당 타이머만 표시 · 이름을 모르면 좌표 유지",
      list.children.length === 1 && !!row(4) && raw(4)?.textContent === "scheduler:4" && badge(4)?.style.display === "none", list.textContent));
    R('window.dispatchEvent(new CustomEvent("tigu:reveal", { detail: { kind: "timer", id: 4 } }))');
    await clock.advance(30);
    out.push(assert("null origin 전용세션 reveal은 같은 현재 범위를 전체로 바꾸지 않고 대상 강조",
      R('bgSessionScope') === "session" && list.children.length === 1 && row(4)?.classList.contains("bg-flash") === true, { scope: R('bgSessionScope'), text: list.textContent }));
    R('activeThreadKey = "dashboard:default"; setBgSessionScope("all"); renderBgTimers()');
    out.push(assert("null origin도 기존 전체 범위에 포함 · 세션 그룹/별도 필터 없음", list.children.length === 4 && !!row(4), list.textContent));
    R('sessionDisplayNames.set("scheduler:4", "전용 이름"); sessionDisplayNames.set("dashboard:other", "바뀐 이름"); window.refreshBgSessionBadges();');
    out.push(assert("기존 이름 새로고침 훅으로 늦게 온/변경된 표시명 반영 · 전용세션도 실제 이름만 표시",
      badge(2)?.textContent === "↪ 바뀐 이름" && badge(4)?.textContent === "↪ 전용 이름" && raw(4)?.style.display === "none", list.textContent));
    R('sessionDisplayNames.delete("scheduler:4"); window.refreshBgSessionBadges();');
    out.push(assert("이름을 더는 모르면 원시좌표로 복귀(배지 숨김)", badge(4)?.style.display === "none" && raw(4)?.style.display === "" && raw(4)?.textContent === "scheduler:4", list.textContent));
    // 실제 잡 배지와 타이머 배지는 같은 이동 함수. 미열린 탭은 이름을 보존해 열고 chat으로 이동한다.
    R('ensureJobCard("timer-session-compare", { threadKey: "dashboard:other" }); jobCards.get("timer-session-compare").ownerTk = "dashboard:other"; updateSessionBadge(jobCards.get("timer-session-compare"));');
    const job = R('jobCards.get("timer-session-compare").sessBadgeEl');
    const sameName = job.textContent === badge(2)?.textContent;
    R('setActiveNav("overview")');
    dispatch(badge(2)!, makeEvent("click"));
    out.push(assert("배지 클릭 → 실행 세션으로 이동 · 이름으로 미열린 탭 추가 · Stop/묶음토글 분리 · 잡카드와 같은 표시",
      sameName && dash.document.body.dataset.view === "chat" && R('activeThreadKey') === "dashboard:other" && R('openTabs.find(t => t.threadKey === "dashboard:other").name') === "바뀐 이름" &&
      cancels.length === 0 && head.getAttribute("aria-expanded") === "true", { active: R('activeThreadKey'), cancels }));
    R('switchToThread("dashboard:default"); setActiveNav("overview")');
    dispatch(job, makeEvent("click"));
    out.push(assert("공유 함수로 옮긴 기존 잡카드 배지도 같은 세션으로 이동하며 열린 탭 중복 없음",
      dash.document.body.dataset.view === "chat" && R('activeThreadKey') === "dashboard:other" && R('openTabs.filter(t => t.threadKey === "dashboard:other").length') === 1 && cancels.length === 0, { view: dash.document.body.dataset.view, active: R('activeThreadKey') }));
    R('setBgSessionScope("session"); renderBgTimers()');
    out.push(assert("세션 이동 후 기존 현재 필터는 새 실행세션 항목만 선정하고 그 소속 배지도 유지",
      list.children.length === 1 && !!row(2) && badge(2)?.style.display === "" && badge(2)?.textContent === "↪ 바뀐 이름", list.textContent));
    // 같은 타이머의 현재 origin이 바뀌면 최초 자리나 목적지에 매달리지 않는다.
    timers = [timer(1, "dashboard:other"), timer(2, "dashboard:default"), timer(4, null)];
    R('window.resyncTimers()'); await clock.advance(500);
    out.push(assert("서버가 준 현재 origin 변경을 그대로 사용 · 최초 id/발송 목적지로 필터하지 않음",
      list.children.length === 1 && !!row(1) && !row(2) && badge(1)?.textContent === "↪ 바뀐 이름", list.textContent));
    if (!row(1)) return out; // 앞의 이동/범위 단언이 실패한 변이에서도 그 실패를 보고한다.
    const stop = row(1)!.querySelector(".bg-timer-stop")!;
    dispatch(stop, makeEvent("click")); await clock.advance(50);
    out.push(assert("개별 Stop은 그 id만 취소하고 세션이동/묶음토글과 분리", cancels.length === 1 && cancels[0] === 1 && R('activeThreadKey') === "dashboard:other" && head.getAttribute("aria-expanded") === "true", cancels));
    out.push(assert("실제 제품 스크립트 비동기 오류 없음", clock.errors.length === 0, clock.errors));
    return out;
  },
};
