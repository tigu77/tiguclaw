/** 타이머 묶음은 기존 작업/셸 묶음처럼 접힌다. 실제 패널 마크업·제품 JS를 함께 싣는다. */
import { assert, i18nForContext, type Assertion, type RegressionCheck } from "./_framework.js";
import { bootDashboard, dispatch, jsonResponse, makeClock, makeEvent } from "./_mini-dom.js";
import { bgPanelHtml } from "./_bg-panel-fixture.js";

const KEY = "bg-cat-collapse:bg-timers-head";
const timer = (id: number, owner = "dashboard:default") => ({ id, label: `타이머 ${id}`, enabled: true, runAt: Date.now() + 600000, originThreadKey: owner });

const boot = async (store = new Map<string, string>(), failStorage = false) => {
  const clock = makeClock();
  let timers = [timer(1), timer(2), timer(3, "dashboard:other")];
  const cancels: number[] = [];
  const dash = bootDashboard({
    clock, i18n: i18nForContext, html: bgPanelHtml(), allIds: true, upTo: "tabs.js",
    extra: { localStorage: {
      getItem: (k: string) => { if (failStorage) throw new Error("SecurityError"); return store.get(k) ?? null; },
      setItem: (k: string, v: string) => { if (failStorage) throw new Error("QuotaExceededError"); store.set(k, String(v)); },
      removeItem: (k: string) => { store.delete(k); },
    } },
    fetch: async (url: string, init?: { body?: string }) => {
      if (url === "/api/timers") return jsonResponse({ timers });
      if (url === "/api/cancel-timer") {
        const id = JSON.parse(init?.body ?? "{}").id as number;
        cancels.push(id); timers = timers.filter((t) => t.id !== id);
        return jsonResponse({ ok: true });
      }
      return jsonResponse({}, 404);
    },
  });
  await clock.advance(20);
  const head = dash.document.getElementById("bg-timers-head")!;
  const list = dash.document.getElementById("bg-timers-list")!;
  const box = dash.document.getElementById("bg-timers")!;
  const count = () => dash.document.getElementById("bg-timers-count")?.textContent;
  const collapsed = () => head.classList.contains("collapsed") && head.getAttribute("aria-expanded") === "false";
  const expanded = () => !head.classList.contains("collapsed") && head.getAttribute("aria-expanded") === "true";
  const click = () => dispatch(head, makeEvent("click"));
  const key = (key: string) => { const e = makeEvent("keydown", { key }); dispatch(head, e); return e; };
  const refresh = async (next: typeof timers) => { timers = next; dash.run("window.resyncTimers()"); await clock.advance(500); };
  return { dash, clock, store, head, list, box, count, collapsed, expanded, click, key, refresh, cancels };
};

export const check: RegressionCheck = {
  name: "bg-timers-collapse",
  guards: "타이머 제목으로 접기·개수·키보드·브라우저 기억을 추가하면서 갱신에 접힘이 풀리거나 위젯 이동이 숨은 카드로 향하는 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const b = await boot();
    out.push(assert("기본 펼침 · 현재 범위 2개 · 머리줄은 키보드/ARIA로 목록과 연결",
      b.expanded() && b.count() === "· 2개" && !b.box.hidden && b.list.children.length === 2 &&
      b.head.getAttribute("role") === "button" && b.head.getAttribute("tabindex") === "0" && b.head.getAttribute("aria-controls") === b.list.id &&
      b.head.classList.contains("bg-group-head") && b.head.nextElementSibling === b.list && b.list.classList.contains("bg-group-body"),
      { count: b.count(), aria: b.head.getAttribute("aria-expanded") }));
    b.click();
    out.push(assert("제목 클릭 → 접힘 · 목록/멈추기는 지우지 않고 상태만 저장", b.collapsed() && b.store.get(KEY) === "1" && b.list.children.length === 2 && b.cancels.length === 0, b.store.get(KEY)));
    const enter = b.key("Enter");
    const enterExpanded = b.expanded();
    const space = b.key(" ");
    const spaceCollapsed = b.collapsed();
    b.key("Escape");
    out.push(assert("Enter로 펴고 Space로 접기 · 스크롤 기본동작 방지 · 다른 키는 무시",
      enterExpanded && enter.defaultPrevented && spaceCollapsed && space.defaultPrevented && b.collapsed(), { enterExpanded, spaceCollapsed }));
    const restored = await boot(b.store);
    out.push(assert("새 화면 부팅도 같은 브라우저의 접힘 기억 복원", restored.collapsed() && restored.count() === "· 2개", restored.head.getAttribute("aria-expanded")));
    await b.refresh([timer(1), timer(2), timer(4), timer(3, "dashboard:other")]);
    const refreshOk = b.collapsed() && b.count() === "· 3개";
    b.dash.run('setBgSessionScope("all")');
    const allOk = b.collapsed() && b.count() === "· 4개";
    b.dash.run('setBgSessionScope("session"); activeThreadKey = "dashboard:none"; renderBgTimers()');
    const zeroOk = b.box.hidden && b.count() === "· 0개" && b.list.children.length === 0;
    b.dash.run('activeThreadKey = "dashboard:default"; renderBgTimers()');
    out.push(assert("목록 갱신·범위·세션 변경은 개수만 갱신 · 0개면 숨기고 재등장에도 접힘 유지",
      refreshOk && allOk && zeroOk && !b.box.hidden && b.collapsed() && b.count() === "· 3개", { refreshOk, allOk, zeroOk, count: b.count() }));
    b.dash.run('window.dispatchEvent(new CustomEvent("tigu:reveal", {detail:{kind:"timer",id:3}}))');
    await b.clock.advance(30);
    const row = b.list.querySelector('.bg-timer[data-timer-id="3"]');
    out.push(assert("위젯의 다른 세션 타이머 보여주기 → 범위와 접힌 묶음을 풀고 해당 카드 강조 · 펼침도 저장",
      b.expanded() && b.dash.run("bgSessionScope") === "all" && row?.classList.contains("bg-flash") === true && b.store.get(KEY) === "0", { aria: b.head.getAttribute("aria-expanded"), count: b.count() }));
    const stop = b.list.querySelector(".bg-timer-stop")!;
    dispatch(stop, makeEvent("click"));
    await b.clock.advance(40);
    out.push(assert("펼친 뒤 멈추기는 기존 id만 취소 · 개수 갱신 · 머리줄 토글로 전파되지 않음",
      b.expanded() && b.cancels.length === 1 && b.cancels[0] === 1 && b.count() === "· 3개", { cancels: b.cancels, count: b.count() }));
    const failed = await boot(new Map(), true);
    failed.click();
    const failedCollapsed = failed.collapsed();
    failed.key("Enter");
    out.push(assert("브라우저 저장 읽기·쓰기 모두 실패해도 기본 펼침·클릭·키보드 사용 가능",
      failedCollapsed && failed.expanded() && failed.count() === "· 2개" && failed.clock.errors.length === 0,
      { failedCollapsed, errors: failed.clock.errors }));
    out.push(assert("제품 스크립트 비동기 오류 없음", b.clock.errors.length === 0 && restored.clock.errors.length === 0, { first: b.clock.errors, restored: restored.clock.errors }));
    return out;
  },
};
