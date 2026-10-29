/** R3: 실제 view-shells.js의 카드 접힘/DOM 부착/출력 세대 소유권을 deferred fetch로 실행. */
import { assert as baseAssert, i18nForContext, type Assertion, type RegressionCheck } from "./_framework.js";
import { bootDashboard, makeClock, jsonResponse } from "./_mini-dom.js";
import { bgPanelHtml, bootBgPanel } from "./_bg-panel-fixture.js";
const assert = (name: string, ok: boolean, detail: unknown = ""): Assertion => baseAssert(name, ok, detail);

const make = async () => {
  const pending: Array<{ resolve: (v: any) => void; reject: (v: any) => void; connected: boolean; visible: boolean; at:number }> = [];
  let read: (() => { connected: boolean; visible: boolean; at:number }) | undefined;
  const b = bootBgPanel((url) => {
    if (!url.startsWith("/api/shell-output")) return Promise.resolve(jsonResponse({}, 404));
    return new Promise((resolve, reject) => pending.push({ resolve, reject, ...read!() }));
  });
  read = () => ({at:b.clock.now(), ...b.R(`(() => { const o = shellOutputEls.get("s"), e = shellRegistry.get("s");
    return {connected: !!o && document.body.contains(o), visible: !!o && !o.closest(".shell-card-body").hidden && e.cardOpen && e.expanded}; })()`) });
  await b.clock.advance(20);
  const add = (patch = "") => b.R(`upsertShellEntry("s", {command:"printf hello",cwd:"/tmp",threadKey:"dashboard:default",ownerTk:"dashboard:default",status:"running",${patch}}, {visible:true}); renderShellsView()`);
  const snapshot = () => b.R(`(() => { const e=shellRegistry.get("s"), c=document.querySelector('.shell-card[data-shell-id="s"]'), o=shellOutputEls.get("s");
    return { cardOpen:e.cardOpen, expanded:e.expanded, tail:e.lastLine, output:o && o.textContent,
      hidden:c && c.querySelector(".shell-card-body").hidden, aria:c && c.querySelector(".shell-card-collapse").getAttribute("aria-expanded"),
      focused:!!c && document.activeElement===c.querySelector(".shell-card-collapse"), timers:shellPollTimers.size,
      timer:shellPollTimers.get("s")?.timer, label:c?.querySelector(".shell-card-label")?.textContent }; })()`);
  return { ...b, add, pending, snapshot };
};

export const check: RegressionCheck = {
  name: "shell-card-collapse-output",
  guards: "전체접기와 출력펼침 혼동/숨은 카드 GET/늦은 A 응답이 새 B 출력·lastLine·timer를 건드리는 것",
  async run(): Promise<Assertion[]> {
    const out: Assertion[] = [];
    {
      // view-shells는 background-drawer보다 먼저 로드된다. seed→rAF도 그 사이에 실행시킨다.
      const clock = makeClock();
      const dash = bootDashboard({html:bgPanelHtml(), clock, upTo:"background-drawer.js", allIds:true, i18n:i18nForContext,
        fetch:async () => jsonResponse({shells:[{shellId:"early",command:"early",status:"running",threadKey:"dashboard:default",ownerThreadKey:"dashboard:default"}]})});
      await clock.advance(40);
      out.push(assert("★★background-drawer 로드 전 shell seed→rAF도 ReferenceError 없이 보이는 카드 부착", dash.run(`!!document.querySelector('.shell-card[data-shell-id="early"]')`)));
    }
    {
      const t = await make(); t.add();
      let s = t.snapshot();
      out.push(assert("★★새 카드 cardOpen=true/expanded=false 별개, 최초 GET 0", s.cardOpen === true && s.expanded === false && !s.hidden && t.pending.length === 0, s));
      t.R(`scheduleShellsRender(); document.querySelector(".shell-card-collapse").click()`);
      s = t.snapshot();
      out.push(assert("★★전체접기: 본문 hidden/aria=false, 명령 fallback과 재생성 버튼 focus", !s.cardOpen && !s.expanded && s.hidden && s.aria === "false" && s.label === "printf hello" && s.focused && t.pending.length === 0, s));
      await t.clock.advance(20);
      out.push(assert("★★접기 뒤 이미 예약된 rAF 재렌더에도 새 접기 버튼 포커스 보존", t.snapshot().focused && t.snapshot().hidden, t.snapshot()));
      t.R(`upsertShellEntry("s", {lastLine:"remember",description:"작업"}); renderShellsView(); setShellsFilter("done"); setShellsFilter("running"); setBgSessionScope("all"); setBgSessionScope("session");`);
      s = t.snapshot();
      out.push(assert("★재렌더/SSE식 갱신·필터·범위 변경에도 접힘과 lastLine 보존", !s.cardOpen && !s.expanded && s.tail === "remember" && s.hidden, s));
      t.R(`toggleShellCard("s")`);
      out.push(assert("★카드만 재열면 출력 의도 false 유지/GET 0", t.snapshot().cardOpen && !t.snapshot().expanded && t.pending.length === 0, t.snapshot()));
      t.R(`toggleShellExpand("s")`); await t.clock.advance(20);
      s = t.snapshot();
      out.push(assert("★★출력 최초 GET은 실제 보이는 DOM 부착 뒤, running timer 1개", t.pending.length === 1 && t.pending[0].connected && t.pending[0].visible && s.timers === 1 && s.timer != null, s));
      if (!t.pending[0]) throw new Error("최초 GET 미발행 " + JSON.stringify({snapshot:s, scope:t.R(`({activeThreadKey,bgSessionScope,shellsFilter})`)}));
      t.pending[0].resolve(jsonResponse({stdout:"first\nlast"})); await t.clock.advance(0);
      out.push(assert("★실제 출력·lastLine 적용", t.snapshot().output === "first\nlast" && t.snapshot().tail === "last", t.snapshot()));
      await t.clock.advance(t.pending[0].at + 1500 - t.clock.now() - 1);
      const n = t.pending.length;
      await t.clock.advance(1);
      // 최초 부착 GET 시각으로부터 정확히 1500ms 경계.
      out.push(assert("★★running 1500ms cadence (그 전 요청 없음/그때 1개)", n === 1 && t.pending.length === 2, {before:n, after:t.pending.length}));
      t.R(`toggleShellCard("s")`);
      out.push(assert("★★전체접기는 expanded 의도 보존하며 timer 즉시 0", !t.snapshot().cardOpen && t.snapshot().expanded && t.snapshot().timers === 0, t.snapshot()));
      await t.clock.advance(3000);
      out.push(assert("★접힌 동안 timer GET 없음", t.pending.length === 2, t.pending.length));
    }
    {
      const t = await make(); t.add(); t.R(`toggleShellCard("s")`);
      t.R(`window.dispatchEvent(window.EV("tigu:reveal", {detail:{kind:"shell",id:"s"}}))`); await t.clock.advance(20);
      out.push(assert("★★위젯 reveal은 그룹만 열고 개별 cardOpen/expanded/hidden 보존, hold 설정", !t.snapshot().cardOpen && !t.snapshot().expanded && t.snapshot().hidden && t.pending.length === 0 && t.R(`!bgStick && bgRevealHold`), t.snapshot()));
    }
    for (const status of ["exited", "killed"]) {
      const t = await make(); t.R(`setShellsFilter("done")`); t.add(`status:${JSON.stringify(status)},expanded:true`);
      out.push(assert(`★★이미 끝난 ${status}: 부착 뒤 최초 1회, interval 없음`, t.pending.length === 1 && t.pending[0].connected && t.snapshot().timer === null, t.snapshot()));
      t.pending[0].resolve(jsonResponse({stdout:"finished"})); await t.clock.advance(3001);
      out.push(assert(`★${status} 응답 후 소유권 해제/timer0/GET1`, t.pending.length === 1 && t.snapshot().timers === 0 && t.snapshot().output === "finished", t.snapshot()));
    }
    {
      const t = await make(); t.add('owner:"sdk",killable:false,expanded:true');
      out.push(assert("★★SDK는 GET/timer/출력토글/Kill 0, 소유자 안내 유지", t.pending.length === 0 && t.snapshot().timers === 0 && t.R(`!document.querySelector(".shell-card-toggle") && !document.querySelector(".shell-card-kill") && !!document.querySelector(".shell-card-owner") && !!document.querySelector(".shell-card-kill-disabled")`)));
    }
    // A 발행→가시성 이탈→새 DOM/B→B 성공→늦은 A. A의 catch도 새 세대 timer를 멈추면 안 됨.
    const transitions = [
      {name:"전체접기", leave:'toggleShellCard("s")', enter:'toggleShellCard("s")'},
      {name:"활성스레드갱신", leave:'activeThreadKey="dashboard:other"; refreshBgScope()', enter:'activeThreadKey="dashboard:default"; refreshBgScope()'},
      {name:"상태필터", leave:'setShellsFilter("done")', enter:'setShellsFilter("running")'},
      {name:"세션범위", leave:'setBgSessionScope("session")', enter:'setBgSessionScope("all")', foreign:true},
      {name:"그룹접기", leave:'document.getElementById("bg-shells-head").click()', enter:'document.getElementById("bg-shells-head").click()'},
    ];
    for (const x of transitions) for (const result of ["success", "api-error", "reject"]) {
      const t = await make();
      if (x.foreign) t.R(`setBgSessionScope("all")`);
      t.add(`expanded:true,${x.foreign ? 'threadKey:"dashboard:other",ownerTk:"dashboard:other"' : ''}`);
      const a = t.pending[0];
      t.R(x.leave); await t.clock.advance(20);
      const stopped = t.snapshot().timers === 0;
      t.R(x.enter); await t.clock.advance(20);
      const b = t.pending[1];
      if (!a || !b) throw new Error(`${x.name}: A/B GET 미발행 (${t.pending.length})`);
      b.resolve(jsonResponse({stdout:"B current\nB tail"})); await t.clock.advance(0);
      const owner = t.R(`shellPollTimers.get("s")`), before = t.snapshot();
      if (result === "reject") a.reject(new Error("late A"));
      else a.resolve(jsonResponse(result === "success" ? {stdout:"A stale"} : {error:"A error"}));
      await t.clock.advance(0);
      const after = t.snapshot();
      out.push(assert(`★★${x.name} A→닫기→B→늦은A ${result}: 새 출력/tail/timer 소유자 영향0`,
        stopped && before.output === "B current\nB tail" && after.output === before.output && after.tail === "B tail" && after.timers === 1 && t.R(`shellPollTimers.get("s")`) === owner,
        {stopped,before,after}));
    }
    for (const x of transitions) for (const result of ["success", "api-error", "reject"]) {
      const t = await make();
      if (x.foreign) t.R(`setBgSessionScope("all")`);
      t.add(`expanded:true,${x.foreign ? 'threadKey:"dashboard:other",ownerTk:"dashboard:other"' : ''}`);
      const a = t.pending[0], oldOut = t.R(`shellOutputEls.get("s")`), oldText = oldOut.textContent;
      t.R(x.leave); // 의도적으로 rAF를 진행시키지 않는다.
      const immediate = t.snapshot().timers === 0;
      if (!a) throw new Error(`${x.name}: 즉시 무효검사 A 없음`);
      if (result === "reject") a.reject(new Error("A before rAF"));
      else a.resolve(jsonResponse(result === "success" ? {stdout:"A before rAF"} : {error:"A before rAF"}));
      await t.clock.advance(0);
      const after = t.snapshot();
      out.push(assert(`★★${x.name} 직후/rAF전 A ${result}: owner 즉시0·out/lastLine 변경0`,
        immediate && after.timers === 0 && after.tail === "" && oldOut.textContent === oldText,
        {immediate,after,oldText,afterText:oldOut.textContent}));
    }
    for (const result of ["success", "api-error"]) {
      const t = await make(); t.add("expanded:true");
      t.R(`handleWorkerEvent({jobId:"tail-anchor",status:"running",ownerThreadKey:"dashboard:default"}, "");
        jobCards.get("tail-anchor").el.getBoundingClientRect = () => ({top:1000-bgScroll.scrollTop,bottom:1100-bgScroll.scrollTop,height:100});
        bgStick=false; bgRevealHold=true; bgScroll.scrollTop=200; bgGeometryChanged(); updateBgJump();
        bgScroll.dispatchEvent(window.EV("wheel"));`);
      t.pending[0].resolve(jsonResponse(result === "success" ? {stdout:"tail changes geometry"} : {error:"tail-error"})); await t.clock.advance(0);
      t.R(`bgScroll.scrollTop=700; bgScroll.dispatchEvent(window.EV("scroll"))`);
      out.push(assert(`★★tail ${result} textContent 반영은 pending 손입력 폐기: 후속 프로그램 outer scroll이 hold 해제 안 함`,
        (result === "success" ? t.snapshot().output === "tail changes geometry" : t.snapshot().output?.includes("tail-error")) && t.R(`!bgStick && bgRevealHold && bgScroll.scrollTop === 700`), t.snapshot()));
    }
    // 동일 카드 반복 render에서도 새로 부착된 DOM 세대만 1개 유지.
    {
      const t = await make(); t.add("expanded:true");
      t.R(`renderShellsView(); renderShellsView()`);
      out.push(assert("★반복 render에도 현재 부착된 출력 세대 timer는 1개", t.pending.length === 3 && t.snapshot().timers === 1 && t.pending.every(p=>p.connected && p.visible), t.snapshot()));
    }
    return out;
  },
};
