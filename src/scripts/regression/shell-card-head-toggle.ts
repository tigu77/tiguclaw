/** 실제 셸 카드 머리줄: 잡 카드와 같은 클릭/드래그 관례, 키보드·자식 액션 분리. */
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";
import { bootBgPanel } from "./_bg-panel-fixture.js";
import { dispatch, jsonResponse, makeEvent } from "./_mini-dom.js";

export const check: RegressionCheck = {
  name: "shell-card-head-toggle",
  guards: "셸의 별도 접기 버튼을 없애며 머리줄 클릭/키보드가 안 되거나 이름·상태·경과를 숨기고 드래그·Kill·출력토글을 접기로 오인하는 것",
  async run(): Promise<Assertion[]> {
    const out: Assertion[] = [], kills: unknown[] = [];
    const b = bootBgPanel(async (url, init) => {
      if (url === "/api/kill-shell") { kills.push(JSON.parse(init?.body ?? "{}")); return jsonResponse({ ok: true }); }
      if (url.startsWith("/api/shell-output")) return jsonResponse({ stdout: "output\nlast" });
      return jsonResponse({}, 404);
    });
    await b.clock.advance(20);
    b.R('upsertShellEntry("s", {command:"printf hello",description:"검증 작업",cwd:"/tmp",startedAt:Date.now()-10000,threadKey:"dashboard:default",ownerTk:"dashboard:default"}, {visible:true}); renderShellsView()');
    const card = () => b.dash.document.querySelector('.shell-card[data-shell-id="s"]')!;
    const head = () => card().querySelector(".shell-card-head")!;
    const body = () => card().querySelector(".shell-card-body")!;
    const isOpen = () => b.R('shellRegistry.get("s").cardOpen') === true;
    const key = (name: string, repeat = false, target = head()) => { const e = makeEvent("keydown", { key: name, repeat, bubbles: true }); dispatch(target, e); return e; };
    out.push(assert("기본 접힘 · 펼치기 버튼·캐럿 없음 · 머리줄 role/tab/ARIA/body 연결",
      !isOpen() && body().hidden && head().getAttribute("role") === "button" && head().tabIndex === 0 &&
      head().getAttribute("aria-expanded") === "false" && head().getAttribute("aria-controls") === body().id &&
      !card().querySelector(".shell-card-collapse") && !card().querySelector(".card-caret") &&
      !Array.from(head().querySelectorAll("button")).some((x) => !x.classList.contains("shell-card-kill")),
      { aria: head().getAttribute("aria-expanded"), body: body().hidden }));
    head().click();
    out.push(assert("머리줄 클릭 → 펼침(aria=true·본문 보임)", isOpen() && !body().hidden && head().getAttribute("aria-expanded") === "true",
      { aria: head().getAttribute("aria-expanded"), body: body().hidden }));
    const elapsed = head().querySelector(".agent-card-elapsed")?.textContent;
    card().querySelector(".shell-card-label")!.click();
    out.push(assert("머리줄 자식 이름 클릭 → 접기 · 이름/상태/경과/중지는 헤더에 남고 명령/출력은 body 안",
      !isOpen() && body().hidden && head().getAttribute("aria-expanded") === "false" &&
      head().querySelector(".shell-card-label")?.textContent === "검증 작업" && !!head().querySelector(".agent-card-status") &&
      !!elapsed && head().querySelector(".agent-card-elapsed")?.textContent === elapsed && !!head().querySelector(".shell-card-kill") &&
      !!body().querySelector(".shell-card-command") && !!body().querySelector(".shell-card-toggle") && !body().querySelector(".agent-card-elapsed"),
      { elapsed, hidden: body().hidden }));
    const enter = key("Enter"), afterEnter = isOpen();
    const space = key(" "), afterSpace = !isOpen();
    const repeat = key(" ", true); key("Escape");
    await b.clock.advance(30);
    out.push(assert("Enter/Space 한 번씩 토글·기본동작 방지 · 반복키/다른키 무시 · rAF 재렌더 뒤 헤더 focus 유지",
      afterEnter && afterSpace && enter.defaultPrevented && space.defaultPrevented && repeat.defaultPrevented && !isOpen() && b.dash.document.activeElement === head(),
      { afterEnter, afterSpace, focus: b.dash.document.activeElement?.className }));
    b.R('upsertShellEntry("s", {lastLine:"갱신 꼬리",description:"갱신 작업",startedAt:Date.now()-20000}); renderShellsView();');
    await b.clock.advance(1100);
    out.push(assert("SSE식 갱신/경과 틱에도 접힘·헤더focus 유지, 이름·경과는 현재 값",
      !isOpen() && body().hidden && b.dash.document.activeElement === head() && head().querySelector(".shell-card-label")?.textContent === "갱신 작업" &&
      head().querySelector(".agent-card-elapsed")?.textContent !== elapsed, { elapsed: head().querySelector(".agent-card-elapsed")?.textContent }));
    key("Enter");
    b.R(`window.selectionText = "";
      window.getSelection = () => ({isCollapsed: !window.selectionText, rangeCount:1,
        toString:()=>window.selectionText, getRangeAt:()=>({commonAncestorContainer:document.querySelector(".shell-card-label")})});`);
    dispatch(head(), makeEvent("mousedown", { bubbles: true }));
    b.R('window.selectionText = "작업 이름 드래그"');
    card().querySelector(".shell-card-label")!.click();
    const dragKept = isOpen();
    dispatch(head(), makeEvent("mousedown", { bubbles: true }));
    card().querySelector(".shell-card-label")!.click();
    out.push(assert("새 텍스트 드래그 클릭은 무시 · 이전 선택이 남은 평범한 다음 클릭은 접기", dragKept && !isOpen(), { dragKept, open: isOpen() }));
    b.R('window.selectionText=""'); key("Enter");
    body().querySelector(".shell-card-toggle")!.click(); await b.clock.advance(30);
    out.push(assert("출력보기 토글은 카드 접기를 건드리지 않고 기존 출력의도만 펼침",
      isOpen() && b.R('shellRegistry.get("s").expanded') === true && body().querySelector(".shell-card-output")?.textContent === "output\nlast",
      { open: isOpen(), output: body().querySelector(".shell-card-output")?.textContent }));
    head().click();
    b.R('window.confirmCount=0; window.confirm=()=>{window.confirmCount++; return false}');
    const childKey = key("Enter", false, head().querySelector(".shell-card-kill")!);
    head().querySelector(".shell-card-kill")!.click(); await b.clock.advance(30);
    out.push(assert("접힌 헤더 Kill의 자식 키/거절 클릭은 카드를 안 펴고 기존 확인만 요청 · API 0",
      !isOpen() && !childKey.defaultPrevented && b.R('window.confirmCount') === 1 && kills.length === 0,
      { open: isOpen(), confirms: b.R('window.confirmCount'), kills }));
    b.R('window.confirm=()=>{window.confirmCount++; return true}');
    head().querySelector(".shell-card-kill")!.click(); await b.clock.advance(30);
    out.push(assert("접힌 헤더 Kill 승인 클릭은 해당 id 단 1요청 · 토글 없이 기존 낙관 중지상태",
      !isOpen() && kills.length === 1 && JSON.stringify(kills[0]) === JSON.stringify({shellId:"s"}) &&
      b.R('shellRegistry.get("s").killRequested') === true && head().querySelector(".shell-card-kill")?.disabled === true,
      { open: isOpen(), kills }));
    // 자식 액션이 stopPropagation을 빠뜨려도 헤더 경계가 이를 토글로 오인하지 않는다.
    const action = b.dash.document.createElement("button"); action.textContent = "합성 기존액션"; head().appendChild(action); action.click();
    out.push(assert("버블링하는 자식 버튼도 헤더 토글과 분리", !isOpen(), isOpen()));
    b.R('handleShellExited({shellId:"s",command:"printf hello",cwd:"/tmp",threadKey:"dashboard:default",ownerThreadKey:"dashboard:default",status:"exited",exitCode:0,finishedAt:Date.now()}, ""); setShellsFilter("done"); renderShellsView()');
    out.push(assert("종료카드도 접힘 유지 · 경과/exit code 헤더 보존 · Kill 제거 · 명령 fallback 보존",
      !isOpen() && body().hidden && !!head().querySelector(".shell-card-exitcode") && !head().querySelector(".shell-card-kill") && !!head().querySelector(".agent-card-elapsed"),
      head().textContent));
    out.push(assert("제품 비동기 오류 없음", b.clock.errors.length === 0, b.clock.errors));
    return out;
  },
};
