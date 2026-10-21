/**
 * «백그라운드 작업» 위젯 — 백그라운드 패널의 **축약판** (2026-08-28 증분 5 → 2026-10-21 다시 기획).
 *
 * 설계: docs/decisions/2026-10-21-running-work-widget-design.md
 *  묶음(패널과 같은 셋·같은 순서: 타이머 → 매니저/에이전트 → 셸) → 대화(탭) → 진행 중 항목. 0개인 묶음은 안 그린다 · 상한 없음.
 *  묶음은 접고 편다(기본 펼침, 보는 사람별 기억). 항목을 누르면 패널이 그 카드로 간다(`ctx.reveal`).
 *
 * ★**특권이 없다.** 코어 데이터를 그리지만 등록·자산·수명이 전부 날씨·지도와 같은 길이다 — 코어 화면 함수를 직접 부르지 않고
 *  `ctx` 만 쓴다(값 = `ctx.resource`, 이동 = `ctx.reveal`, 메뉴 = `ctx.menu`, 대화 이름 = `ctx.sessionName`).
 * ★순서·재연결·스냅샷을 **모른다** — 구독이 값만 준다. 색을 쓰지 않고(토큰), 문장을 서버에서 받지 않는다(`ctx.t`).
 */
(() => {
  if (!document.getElementById("rw-css")) {
    const l = document.createElement("link");
    l.id = "rw-css"; l.rel = "stylesheet"; l.href = "/plugin-asset/running-work/widget.css";
    document.head.appendChild(l);
  }
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  /**
   * 접힘 — **지금 화면의 상태는 메모리**에 두고, 브라우저 저장소는 다시 열 때 복원하는 데만 쓴다(보는 사람별 편의).
   * ★저장이 실패해도 지금 화면은 바뀐다(아스트라 10-21 — 종전엔 저장소만 읽어, 쓰기가 실패하면 머리 줄·«모두 접기» 가 아무 일도 안 했다).
   *  못 읽으면 펼친 채(기본).
   */
  const LS = "rw.collapsed.v1:";
  const collapsedNow = new Map();
  const isCollapsed = (g) => {
    if (!collapsedNow.has(g)) {
      let saved = false;
      try { saved = localStorage.getItem(LS + g) === "1"; } catch { saved = false; }
      collapsedNow.set(g, saved);
    }
    return collapsedNow.get(g) === true;
  };
  const setCollapsed = (g, on) => {
    collapsedNow.set(g, on);
    try { localStorage.setItem(LS + g, on ? "1" : "0"); } catch { return; }
  };

  // ★아이콘도 **자기 카탈로그**에서 (2026-09-10). `ctx.t` 는 플러그인 것만 보므로 코어 키를 못 읽는다 — 그건 결함이 아니라
  //  격리다([[feedback_external_things_own_their_unit]]). 값은 패널과 맞춰 둔다.
  const ICON = (ctx, kind) => {
    const v = ctx.t("icon." + kind);
    return v && v !== "icon." + kind ? v : (kind === "agent" ? "🤖" : "🎖️");
  };
  const minsSince = (t) => Math.max(0, Math.round((Date.now() - t) / 60000));

  /**
   * 세 리소스 → 묶음 목록. 묶음마다 `{ key, title, rows: [{ kind, id, icon, label, when, owner, order }] }`.
   * ★진행 중인 것만(끝난 것은 패널의 «완료» 몫) · 대화 순서 = 그 대화에서 **가장 오래 돈 항목** 순(타이머는 가장 먼저 울릴 것 순).
   */
  const groupsOf = (ctx, jobs, shells, timers) => {
    const out = [];
    const timerRows = (Array.isArray(timers) ? timers : [])
      .filter((x) => x && x.enabled && typeof x.runAt === "number")
      .map((x) => {
        const left = Math.max(0, Math.round((x.runAt - Date.now()) / 60000));
        return {
          kind: "timer", id: String(x.id), icon: "⏱", label: x.label || ctx.t("unnamed"),
          when: left < 1 ? ctx.t("timer.now") : ctx.t("timer.in", { n: left }),
          owner: x.originThreadKey || "", order: x.runAt,
        };
      });
    const jobRows = (Array.isArray(jobs) ? jobs : [])
      .filter((j) => j && j.status === "running")
      .map((j) => ({
        kind: "job", id: j.jobId, icon: ICON(ctx, j.kind === "agent" ? "agent" : "worker"),
        label: j.label || j.agentName || ctx.t("unnamed"),
        when: typeof j.startedAt === "number" ? ctx.t("since", { n: minsSince(j.startedAt) }) : "",
        owner: j.ownerThreadKey || "", order: typeof j.startedAt === "number" ? j.startedAt : 0,
      }));
    const shellRows = (Array.isArray(shells) ? shells : [])
      .filter((x) => x && x.status === "running")
      .map((x) => ({
        kind: "shell", id: x.shellId, icon: "🖥️", label: x.command || ctx.t("unnamed"),
        when: typeof x.startedAt === "number" ? ctx.t("since", { n: minsSince(x.startedAt) }) : "",
        owner: x.ownerThreadKey || "", order: typeof x.startedAt === "number" ? x.startedAt : 0,
      }));
    for (const [key, rows] of [["timers", timerRows], ["jobs", jobRows], ["shells", shellRows]]) {
      if (rows.length === 0) continue; // ★0개인 묶음은 안 그린다(정태님 10-21)
      out.push({ key, title: ctx.t("group." + key), rows });
    }
    return out;
  };

  /** 묶음 안을 대화별로 — 대화 순서는 그 대화의 가장 이른 항목(`order`), 대화 안도 이른 것부터. */
  const bySession = (rows) => {
    const m = new Map();
    for (const r of rows) {
      if (!m.has(r.owner)) m.set(r.owner, []);
      m.get(r.owner).push(r);
    }
    const list = [...m].map(([owner, items]) => ({ owner, items: items.sort((a, b) => a.order - b.order) }));
    return list.sort((a, b) => a.items[0].order - b.items[0].order);
  };

  window.tiguWidgets.register("running-work/live", {
    mount(root, _data, ctx) {
      const box = el("div", "rw");
      root.appendChild(box);
      let jobs = null;
      let shells = null;
      let timers = null;
      let groups = [];

      const draw = () => {
        groups = groupsOf(ctx, jobs, shells, timers);
        box.replaceChildren();
        if (groups.length === 0) {
          // ★**없으면 없다고 말한다** — 빈 상자는 "고장인가" 로 읽힌다.
          box.appendChild(el("div", "rw-idle", ctx.t("idle")));
          return;
        }
        for (const g of groups) {
          const collapsed = isCollapsed(g.key);
          const sec = el("section", "rw-group" + (collapsed ? " collapsed" : ""));
          const head = el("button", "rw-head");
          head.type = "button";
          head.setAttribute("aria-expanded", collapsed ? "false" : "true");
          head.append(el("span", "rw-chev", "▾"), el("span", "rw-title", g.title), el("span", "rw-count", String(g.rows.length)));
          head.addEventListener("click", () => { setCollapsed(g.key, !isCollapsed(g.key)); draw(); });
          sec.appendChild(head);
          if (!collapsed) {
            for (const s of bySession(g.rows)) {
              // 이름을 모르면(소속 미상·이름 아직 모름) «미상» — 좌표(`worker:…`)를 대화 이름처럼 보이지 않는다.
              sec.appendChild(el("div", "rw-session", (s.owner && ctx.sessionName(s.owner)) || ctx.t("session.unknown")));
              for (const r of s.items) {
                const row = el("button", "rw-row");
                row.type = "button";
                row.title = r.label;
                row.append(el("span", "rw-ic", r.icon), el("span", "rw-label", r.label));
                if (r.when) row.appendChild(el("span", "rw-since", r.when));
                row.appendChild(el("span", "rw-go", "›"));
                row.addEventListener("click", () => ctx.reveal({ kind: r.kind, id: r.id }));
                sec.appendChild(row);
              }
            }
          }
          box.appendChild(sec);
        }
      };

      // 세 리소스는 따로 온다(셸은 SSE, 타이머는 재조회 — 시점이 엇갈려도 축약판엔 문제없다, 아스트라 10-21). 받은 것만 바꿔 다시 그린다.
      // 해지는 코어가 한다(`ctx.onDispose` 에 걸린다) — 위젯이 잊어도 안 샌다.
      ctx.resource("running-work").subscribe((v) => { jobs = v; draw(); });
      ctx.resource("bg-shells").subscribe((v) => { shells = v; draw(); });
      ctx.resource("bg-timers").subscribe((v) => { timers = v; draw(); });
      // 대화 이름이 (늦게) 오면 다시 그린다 — 부팅 직후엔 이름 지도가 비어 «대화 미상» 으로 그려진다.
      ctx.resource("session-names").subscribe(() => draw());
      // «N분째»·«N분 뒤» 는 값이 안 와도 흐른다 — 1분마다 다시 그린다.
      const tick = setInterval(draw, 60 * 1000);
      ctx.onDispose(() => clearInterval(tick));

      ctx.menu(() => {
        const anyOpen = groups.some((g) => !isCollapsed(g.key));
        return [
          { label: ctx.t("menu.openPanel"), run: () => ctx.reveal({ kind: "panel" }) },
          ...(groups.length > 0
            ? [{
                label: anyOpen ? ctx.t("menu.collapseAll") : ctx.t("menu.expandAll"),
                run: () => { for (const g of groups) setCollapsed(g.key, anyOpen); draw(); },
              }]
            : []),
        ];
      });
      draw();
    },
    unmount(root) {
      root.replaceChildren();
    },
  });
})();
