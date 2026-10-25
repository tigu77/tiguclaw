/**
 * «백그라운드 작업» 위젯 — 백그라운드 패널의 **축약판** (2026-08-28 증분 5 → 2026-10-21 다시 기획).
 *
 * 설계: docs/decisions/2026-10-21-running-work-widget-design.md · docs/decisions/2026-10-23-background-panel-ux.md
 *  ★보기 둘(2026-10-23, 사용자): **세션별(기본)** = 대화 머리 줄 → 그 대화의 진행 중 항목(타이머 → 매니저/에이전트 → 셸), 종류는
 *   제목 줄 없이 아이콘과 «종류가 바뀌는 자리의 얇은 선» 으로만 가른다 / **종류별** = 묶음(패널과 같은 셋·같은 순서) → 대화 → 항목(종전 그대로).
 *   전환은 위젯 메뉴에서(패널엔 전환이 없다). 0개인 묶음·종류는 안 그린다 · 상한 없음.
 *  묶음·대화는 접고 편다(기본 펼침). 항목을 누르면 패널이 그 카드로 간다(`ctx.reveal`).
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
   * 보기 선택 — 브라우저 저장소 키 하나(값 하나라 쌓이지 않는다). 없거나 못 읽으면 세션별. 저장이 실패해도 지금 화면은 바뀐다(접힘과 같은 규칙).
   *  마운트 때 한 번 읽어 그 인스턴스 메모리에 둔다 — 같은 종류 위젯 둘은 다음 마운트부터 마지막 선택을 따른다.
   */
  const VIEW_LS = "rw.view.v1";
  const readView = () => {
    try { return localStorage.getItem(VIEW_LS) === "kind" ? "kind" : "session"; } catch { return "session"; }
  };
  const KIND_RANK = { timer: 0, job: 1, shell: 2 };

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
      .map((x) => {
        // ★이름 = Bash `description`(있을 때만, 2026-10-23) — 없으면 지금처럼 명령. 툴팁엔 설명이 있으면 명령도 같이.
        const desc = typeof x.description === "string" && x.description !== "" ? x.description : "";
        const label = desc || x.command || ctx.t("unnamed");
        return {
          kind: "shell", id: x.shellId, icon: "🖥️", label,
          tip: desc && x.command ? desc + "\n" + x.command : label,
          when: typeof x.startedAt === "number" ? ctx.t("since", { n: minsSince(x.startedAt) }) : "",
          owner: x.ownerThreadKey || "", order: typeof x.startedAt === "number" ? x.startedAt : 0,
        };
      });
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

  /**
   * 세션별 보기 — 같은 행을 대화로 묶는다. 대화마다 `{ key, owner, items }`.
   *  ★이름을 모르는 대화는 **«대화 미상» 하나로 모은다** — 키가 달라도 같은 제목이 여러 줄 서면 정보 없이 고장처럼 보인다(누르면 각 카드로
   *   정확히 간다 — 이동은 kind·id 로 한다). 이름이 늦게 오면 다시 그려 제자리로 간다.
   *  순서: 잡·셸의 가장 이른 시작 → 잡·셸이 없고 타이머만 있는 대화(가장 이른 울림) → «대화 미상» 맨 끝. 타이머의 울림 시각은 미래라
   *   시작 시각과 한 축에 섞지 않는다. 대화 안: 타이머 → 잡 → 셸(패널과 같은 순서), 종류 안은 이른 것부터.
   */
  const sessionsOf = (ctx, groups) => {
    const m = new Map();
    for (const g of groups) {
      for (const r of g.rows) {
        const known = r.owner && ctx.sessionName(r.owner);
        const key = known ? "s:" + r.owner : "s:?";
        if (!m.has(key)) m.set(key, { key, owner: known ? r.owner : "", items: [] });
        m.get(key).items.push(r);
      }
    }
    const list = [...m.values()];
    for (const s of list) {
      s.items.sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || a.order - b.order);
      const work = s.items.filter((r) => r.kind !== "timer");
      s.rank = s.key === "s:?" ? 2 : work.length ? 0 : 1;
      s.at = work.length ? Math.min(...work.map((r) => r.order)) : Math.min(...s.items.map((r) => r.order));
    }
    return list.sort((a, b) => a.rank - b.rank || a.at - b.at);
  };

  window.tiguWidgets.register("running-work/live", {
    mount(root, _data, ctx) {
      const box = el("div", "rw");
      root.appendChild(box);
      // ★`null` = **아직 모름**(첫 값 전 — 화면 소유 리소스는 패널이 처음 받기 전에도 `null` 을 준다). 빈 목록(`[]`)만 «없음» 이다.
      let jobs = null;
      let shells = null;
      let timers = null;
      let groups = [];
      let sessions = [];
      let view = readView();
      // 저장이 실패해도 지금 화면은 이미 바뀌었다(메모리를 먼저 바꾼다).
      const setView = (v) => {
        view = v;
        try { localStorage.setItem(VIEW_LS, v); } catch { return; }
      };
      // 세션별 보기의 접힘은 **화면 메모리만** — 대화 키는 끝없이 늘고 일이 끝나면 의미가 없어, 저장하면 지울 사람이 없는 키가 쌓인다.
      const sessCollapsed = new Map();

      const rowEl = (r) => {
        const row = el("button", "rw-row");
        row.type = "button";
        row.title = r.tip || r.label;
        row.append(el("span", "rw-ic", r.icon), el("span", "rw-label", r.label));
        if (r.when) row.appendChild(el("span", "rw-since", r.when));
        row.appendChild(el("span", "rw-go", "›"));
        row.addEventListener("click", () => ctx.reveal({ kind: r.kind, id: r.id }));
        return row;
      };
      const headEl = (title, count, collapsed, onToggle) => {
        const head = el("button", "rw-head");
        head.type = "button";
        head.setAttribute("aria-expanded", collapsed ? "false" : "true");
        head.append(el("span", "rw-chev", "▾"), el("span", "rw-title", title), el("span", "rw-count", String(count)));
        head.addEventListener("click", onToggle);
        return head;
      };
      const drawBySession = () => {
        sessions = sessionsOf(ctx, groups);
        for (const s of sessions) {
          const collapsed = sessCollapsed.get(s.key) === true;
          const sec = el("section", "rw-group rw-sess" + (collapsed ? " collapsed" : ""));
          sec.appendChild(headEl(s.owner ? ctx.sessionName(s.owner) : ctx.t("session.unknown"), s.items.length, collapsed, () => {
            sessCollapsed.set(s.key, !collapsed);
            draw();
          }));
          if (!collapsed) {
            s.items.forEach((r, i) => {
              const row = rowEl(r);
              // ★종류 제목 줄 없이 **종류가 바뀌는 자리에만** 얇은 선 — 빈 종류엔 선이 생길 수 없고, 대화 첫 행엔 없다.
              if (i > 0 && s.items[i - 1].kind !== r.kind) row.classList.add("rw-kind-break");
              sec.appendChild(row);
            });
          }
          box.appendChild(sec);
        }
      };

      const draw = () => {
        groups = groupsOf(ctx, jobs, shells, timers);
        box.replaceChildren();
        if (groups.length === 0) {
          // ★**없으면 없다고 말한다** — 빈 상자는 "고장인가" 로 읽힌다. 단 하나라도 아직 모르면 «없음» 이 아니다(10-23 — 첫 응답 전에 «없음» 이 잠깐 떴다).
          const unknown = jobs === null || shells === null || timers === null;
          box.appendChild(el("div", "rw-idle" + (unknown ? " rw-loading" : ""), ctx.t(unknown ? "loading" : "idle")));
          return;
        }
        // ★보기 분기는 로딩·빈 판정 **뒤**에서만 — 두 보기가 같은 «불러오는 중 → 없음» 을 지난다.
        if (view === "session") { drawBySession(); return; }
        for (const g of groups) {
          const collapsed = isCollapsed(g.key);
          const sec = el("section", "rw-group" + (collapsed ? " collapsed" : ""));
          sec.appendChild(headEl(g.title, g.rows.length, collapsed, () => { setCollapsed(g.key, !isCollapsed(g.key)); draw(); }));
          if (!collapsed) {
            for (const s of bySession(g.rows)) {
              // 이름을 모르면(소속 미상·이름 아직 모름) «미상» — 좌표(`worker:…`)를 대화 이름처럼 보이지 않는다.
              sec.appendChild(el("div", "rw-session", (s.owner && ctx.sessionName(s.owner)) || ctx.t("session.unknown")));
              for (const r of s.items) sec.appendChild(rowEl(r));
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
        const bySess = view === "session";
        const anyOpen = bySess ? sessions.some((s) => sessCollapsed.get(s.key) !== true) : groups.some((g) => !isCollapsed(g.key));
        return [
          { label: ctx.t("menu.openPanel"), run: () => ctx.reveal({ kind: "panel" }) },
          // ★지금 보기와 바꿀 보기를 **한 항목**에(메뉴 항목은 label·run 뿐 — 누를 수 없는 «지금» 줄을 따로 세우지 않는다).
          { label: ctx.t(bySess ? "menu.viewKind" : "menu.viewSession"), run: () => { setView(bySess ? "kind" : "session"); draw(); } },
          ...(groups.length > 0
            ? [{
                label: anyOpen ? ctx.t("menu.collapseAll") : ctx.t("menu.expandAll"),
                // «모두 접기/펼치기» 는 **지금 보기**의 묶음에 적용한다.
                run: () => {
                  if (bySess) for (const s of sessions) sessCollapsed.set(s.key, anyOpen);
                  else for (const g of groups) setCollapsed(g.key, anyOpen);
                  draw();
                },
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
