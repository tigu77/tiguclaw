      // ── 마지막 본 페이지 (2026-08-10, ★근본 수정 08-11) ──────────────────
      //
      // 종전엔 `applyView`(상단 nav 버튼 핸들러) 안에서 저장했다. 그런데 뷰로 들어가는
      // **문이 여럿**이다 — 홈 화면 액션 카드 · 컨텍스트 메뉴 · 뷰 안의 링크 · 뒤로가기.
      // 그 문들은 `showX()` 를 직접 부르므로 저장을 건너뛰었고, 그렇게 도달한 페이지는
      // 새로고침하면 **overview 로 돌아갔다**(사용자 신고, 헤드리스 실측으로 재현:
      // 홈 카드→인벤토리 이동 시 저장값 null).
      //
      // ★고침은 문마다 저장을 붙이는 게 아니다(문은 또 생긴다 — 손으로 관리하는 목록).
      //  `setActiveNav` 가 `document.body.dataset.view` 를 쓰는 **유일한 자리**이고
      //  모든 뷰가 여기로 모인다. 정의점에서 저장하면 새 문이 생겨도 자동으로 덮인다.
      //
      // ★부팅 순서 함정: 부팅은 `showOverview()` 로 시작하므로, 그때 이 저장이 돌면
      //  복원이 읽기도 전에 값이 "overview" 로 덮인다. 그래서 **모듈 로드 시점에** 값을
      //  얼려 두고(아래) 복원은 그 얼린 값을 본다. 읽는 시점이 쓰는 시점보다 먼저다.
      const VIEW_LS = "dash.activeView.v1";
      try {
        window.__dashBootView = localStorage.getItem(VIEW_LS);
      } catch {
        window.__dashBootView = null; // 프라이빗 모드·quota — 복원 없이 기존 동작.
      }

      /**
       * 홈 「상태 요약」의 **버전 행** — 순수 판정 (2026-08-21, 사용자 신고).
       *
       * ★왜 생겼나: 모바일 헤더는 46px 라 부제(`대시보드 · vX.Y.Z`)를 숨긴다(app.css @media).
       *  그래서 **모바일엔 버전을 볼 자리가 아예 없었다.** 헤더를 되살리는 대신 홈에 둔 이유는
       *  그 패널이 이미 *"지금 확인해야 할 운영 신호"* 이고, "어떤 빌드로 도는가" 가 정확히
       *  그것이기 때문이다.
       *
       * ★**여기서 업데이트 여부를 다시 판정하지 않는다.** `behind`·`dirty` 를 보는 순간
       *  칩(update-chip.js)과 판단이 **두 벌**이 되고 두 벌은 갈린다. 코어가 낸 `state` 를
       *  **문장으로 바꾸기만** 한다(가장자리는 표현만 한다).
       *
       * ★모르면 아무 말도 하지 않는다 — `unknown`·미도착·새 state 는 버전만 보여준다.
       *  칩이 `unknown` 에 조용한 것과 같은 규칙이고, 없는 업데이트를 있다고 하는 것보다 낫다.
       *
       * @returns {{tone:string, desc:string, meta:string}}
       */
      const versionStatusRow = (version, availability) => {
        const meta = version ? "v" + version : i18n("home.update.checking");
        const state = availability && availability.state;
        if (state === "available")
          return { tone: "warn", desc: i18n("home.update.available"), meta };
        if (state === "blocked")
          return {
            tone: "warn",
            desc: availability.blockedReason || i18n("upd.unavailable"),
            meta,
          };
        if (state === "up-to-date") return { tone: "good", desc: i18n("home.update.upToDate"), meta };
        return { tone: "good", desc: i18n("home.stat.versionTitle"), meta };
      };

      const setActiveNav = (view) => {
        // ★**문마다 붙이지 않는다** — 뷰로 들어가는 문은 여럿이지만 전부 여기로 모인다
        //  (같은 이유로 「마지막 본 페이지」 저장도 여기 있다). 홈을 떠나면 poll 을 끈다.
        if (view !== "overview") stopHomeWidgets();
        currentView = view;
        document.body.dataset.view = view;
        try {
          localStorage.setItem(VIEW_LS, view);
        } catch {
          /* quota·프라이빗 모드 — 복원만 안 될 뿐 이동은 정상 */
        }
        document.body.dataset.main = view === "chat" ? "stream" : view === "activity" ? "activity" : "workbench";
        // 워크벤치 3패널 모드 클래스 중앙 초기화 — 각 뷰가 setActiveNav 후 자기 모드만 add.
        // (모듈=show-providers / 능력=show-capabilities / 프로젝트=show-projects. 나머지=없음).
        const wb = document.getElementById("workbench");
        if (wb) wb.classList.remove("show-providers", "show-capabilities", "show-projects");
        for (const btn of document.querySelectorAll(".nav-button")) {
          btn.classList.toggle("active", btn.dataset.view === view);
        }
      };

      // ── 홈 위젯 (2026-08-28, 위젯 플랫폼 §J) ─────────────────────────────────
      //
      // ★**배치는 비서가 정한다.** 여기엔 드래그도, 크기 조절도, 저장 버튼도 없다 —
      //  화면은 `/api/home-widgets` 가 주는 순서대로 그릴 뿐이다(로드맵 A3: *"Layout 은
      //  비서가 읽고 쓸 수 있는 데이터"*). 손 배치는 탈출구라 나중이고, 이 길이 기본이다.
      //
      // ★**좌표를 안 받는다.** 서버가 주는 건 순서와 `size` 등급뿐이고 격자는 CSS 가 푼다.
      //  그래서 breakpoint 마다 레이아웃이 한 벌씩 생기지 않고, 모바일이 저절로 된다.
      //
      // ★**위젯 코드는 채팅과 같은 것을 쓴다** — `widgetHost.mount(el, {widget, data})`.
      //  플러그인의 `mount(root, data, ctx)` 는 데이터가 어디서 왔는지 모른다. 그게 §B 의
      //  *"하나의 계약, 두 데이터 모드"* 가 실제로 값을 내는 자리다(weather 수정 0줄).
      //
      // ★**데이터 라우트 이름 = 위젯 이름**이다(관례). `weather/forecast` 위젯은
      //  `/api/plugin-data/weather/forecast` 에서 값을 받는다. 별도 필드를 두지 않는 이유는
      //  두면 두 이름이 갈리고, 갈리면 조용히 빈 자리가 되기 때문이다.
      const HOME_WIDGET_POLL_MS = 5 * 60 * 1000;
      const HOME_LAYOUT_POLL_MS = 30 * 1000;
      /** 서버가 준 배치. null = 아직 못 받음(그리지 않는다). */
      let homeWidgets = null;
      /** 값을 받아올 수 있는 위젯(서버가 알려준다). 여기 없으면 poll 안 한다. */
      let homeDataRoutes = [];
      /** id → 마지막으로 받은 값. 다시 그릴 때 깜빡이지 않게 들고 있는다. */
      const homeWidgetData = new Map();
      /** 홈에 있는 동안만 도는 타이머들. */
      let homeTimers = [];

      /**
       * ★**홈을 떠나면 멈춘다.** 위젯 하나가 곧 주기적인 외부 호출 하나라, 안 보이는 화면이
       *  계속 부르면 그건 그냥 크롤러다(§J.9 ③). 위젯 자신의 타이머는 `ctx.onDispose` 로
       *  코어가 회수하고, **여기서 거는 poll 은 우리 것이라 우리가 회수한다.**
       */
      const stopHomeWidgets = () => {
        for (const t of homeTimers) clearInterval(t);
        homeTimers = [];
      };

      /** 위젯 하나를 그린다 — 값이 없으면 「받아오는 중」, 실패면 한 줄. */
      const paintHomeWidget = (card, w) => {
        const prev = card.querySelector(".home-widget-body");
        // ★**제거가 먼저**다 — 관측자가 그때 회수한다(타이머·구독). 새 노드를 먼저 붙이면
        //  같은 위젯이 잠깐 둘이 되고, 둘 중 하나가 회수 없이 사라질 수 있다.
        if (prev) prev.remove();
        const box = document.createElement("div");
        box.className = "home-widget-body";
        // ★`data-widget` 이 있어야 **조상이 통째로 지워질 때**도 회수된다(sweep 이 이 속성으로
        //  후손을 찾는다). 홈은 뷰를 옮길 때 `#detail-panel` 을 통째로 비운다.
        box.dataset.widget = w.type;
        card.appendChild(box);
        // ★**두 모드**(§B). 데이터 라우트가 있으면 값을 받아 그리고(poll), 없으면 값 없이
        //  그린다 — 그 위젯은 화면에서 `ctx.resource(...)` 로 스스로 구독한다(live).
        //  종전엔 무조건 받으러 가서, 라우트 없는 위젯이 404 를 맞고 "값을 못 받았습니다" 로
        //  떴다. 판정 근거는 서버가 준다(관례: 라우트 이름 = 위젯 이름).
        if (!homeDataRoutes.includes(w.type)) {
          void widgetHost.mount(box, { widget: w.type, data: null });
          return;
        }
        const state = homeWidgetData.get(w.id);
        if (state === undefined) {
          box.classList.add("home-widget-note");
          box.textContent = i18n("home.widget.loading");
          return;
        }
        if (state.error) {
          box.classList.add("home-widget-note");
          box.textContent = i18n("home.widget.failed");
          return;
        }
        void widgetHost.mount(box, { widget: w.type, data: state.data });
      };

      /** 값을 받아온다. ★외부는 데몬이 부른다 — 브라우저는 우리 오리진만 만진다(CSP). */
      const refreshHomeWidget = async (w) => {
        const slash = w.type.indexOf("/");
        const plugin = w.type.slice(0, slash);
        const route = w.type.slice(slash + 1);
        const qs = new URLSearchParams();
        for (const [k, v] of Object.entries(w.config || {})) qs.set(k, String(v));
        const url =
          "/api/plugin-data/" + encodeURIComponent(plugin) + "/" + encodeURIComponent(route) +
          (qs.toString() ? "?" + qs.toString() : "");
        try {
          const r = await fetch(url, { cache: "no-store" });
          const j = await r.json();
          if (!r.ok) throw new Error(j && j.error ? j.error : "HTTP " + r.status);
          homeWidgetData.set(w.id, { data: j.data });
        } catch (e) {
          // ★**하나가 실패해도 나머지는 산다**(§J.9 ⑥). 사유는 콘솔에, 화면엔 한 줄.
          console.warn("[home-widget] " + w.type + " 값을 못 받았습니다:", e);
          homeWidgetData.set(w.id, { error: true });
        }
        const card = document.querySelector('.home-widget[data-id="' + CSS.escape(w.id) + '"]');
        if (card) paintHomeWidget(card, w);
      };

      /**
       * 위젯 영역을 만든다. ★**0개면 아무것도 안 그린다** — 빈 상자를 두면 사용자가
       *  "여기 뭔가 있어야 하나" 를 새로 관리하게 된다(받을 게 없으면 행을 아예 안 그리는
       *  기존 규칙과 같다).
       */
      const buildHomeWidgets = () => {
        if (!Array.isArray(homeWidgets) || homeWidgets.length === 0) return null;
        const panel = document.createElement("section");
        panel.className = "subpanel home-widgets";
        panel.innerHTML = '<div class="subpanel-head"><div><h2 class="subpanel-title"></h2>' +
          '<p class="subpanel-desc"></p></div></div>';
        panel.querySelector(".subpanel-title").textContent = i18n("home.widgets.head");
        panel.querySelector(".subpanel-desc").textContent = i18n("home.widgets.desc");
        const grid = document.createElement("div");
        grid.className = "home-widget-grid";
        for (const w of homeWidgets) {
          const card = document.createElement("div");
          card.className = "home-widget";
          card.dataset.id = w.id;
          card.dataset.size = w.size === "wide" ? "wide" : "small";
          grid.appendChild(card);
        }
        panel.appendChild(grid);
        return panel;
      };

      /** 배치를 받아온다. 바뀌었을 때만 다시 그린다(가만히 있는 화면을 흔들지 않는다). */
      const loadHomeLayout = async (repaint) => {
        let next = [];
        try {
          const r = await fetch("/api/home-widgets", { cache: "no-store" });
          const j = await r.json();
          next = Array.isArray(j.widgets) ? j.widgets : [];
          homeDataRoutes = Array.isArray(j.dataRoutes) ? j.dataRoutes : [];
        } catch {
          return; // 못 받으면 지금 그림을 그대로 둔다 — 있던 위젯을 지우지 않는다.
        }
        const same = JSON.stringify(homeWidgets) === JSON.stringify(next);
        homeWidgets = next;
        // 사라진 위젯의 값은 버린다(캡 없는 Map 을 남기지 않는다).
        const ids = new Set(next.map((w) => w.id));
        for (const id of [...homeWidgetData.keys()]) {
          if (!ids.has(id)) homeWidgetData.delete(id);
        }
        if (!same && repaint && currentView === "overview") showOverview();
      };

      const showOverview = () => {
        setActiveNav("overview");
        setChatPanel("chat");
        document.getElementById("workbench").classList.remove("show-providers");
        document.getElementById("workbench").classList.remove("show-capabilities");
        const root = document.getElementById("detail-panel");
        const active = providersCache.filter((p) => (p.status || "unknown") === "active").length;
        const degraded = providersCache.filter((p) => ["degraded", "error"].includes(p.status || "unknown")).length;
        const errors = providersCache.filter((p) => (p.status || "unknown") === "error").length;
        const invTotal = inventoryCache
          ? CATEGORIES.reduce((sum, cat) => sum + ((inventoryCache[cat] || []).length), 0)
          : "…";
        const healthClass = errors > 0 ? "bad" : degraded > 0 ? "warn" : "good";
        const healthText = errors > 0 ? i18n("common.error") : degraded > 0 ? i18n("common.health.warn") : i18n("common.health.ok");
        const healthDesc = providersCache.length === 0
          ? i18n("home.modules.loading")
          : degraded > 0
            ? i18n("home.modules.degraded", { n: degraded })
            : i18n("home.modules.ok");
        root.innerHTML = "";
        const wrap = document.createElement("div");
        wrap.className = "page-view overview";

        const hero = document.createElement("div");
        hero.className = "hero-card";
        hero.innerHTML = "<h1></h1><p></p>";
        hero.querySelector("h1").textContent = i18n("home.hero.title");
        hero.querySelector("p").textContent = i18n("home.hero.desc");
        wrap.appendChild(hero);

        const quick = document.createElement("div");
        quick.className = "quick-grid";
        const metrics = [
          [i18n("common.status"), healthText, healthDesc],
          [i18n("common.kind.module"), String(providersCache.length), i18n("home.stat.activeCount", { n: active })],
          [i18n("home.stat.events"), String(evCount), i18n("home.card.activityDesc")],
        ];
        for (const [label, value, hint] of metrics) {
          const card = document.createElement("div");
          card.className = "quick-card";
          card.innerHTML = '<div class="quick-label">' + escHtml(label) + '</div><div class="quick-value">' + escHtml(value) + '</div><div class="quick-hint">' + escHtml(hint) + '</div>';
          quick.appendChild(card);
        }
        wrap.appendChild(quick);

        // ★위젯을 **여기** 둔다(요약 다음·상태 패널 위). 맨 아래에 두면 390×780 화면에서
        //  뷰포트 밖으로 밀린다 — 버전 행이 정확히 그래서 둘째 줄로 옮겨졌다. 사용자가
        //  "왼쪽 모니터에 띄워두는" 것이라 눈이 먼저 가는 자리여야 한다.
        stopHomeWidgets();
        const widgetPanel = buildHomeWidgets();
        if (widgetPanel) wrap.appendChild(widgetPanel);
        // ★**그리는 건 문서에 붙은 뒤**다(아래 `root.appendChild` 이후 — `paintHomeWidgets()`).
        //  붙기 전에 마운트하면 호스트가 그 노드를 **대기줄**에 넣는데, 값이 도착해 상자를
        //  갈아끼우면 그 대기분은 영영 안 붙어 관측자가 안 꺼진다(실측 5건).

        const layout = document.createElement("div");
        layout.className = "overview-layout";
        const statusPanel = document.createElement("section");
        statusPanel.className = "subpanel";
        statusPanel.innerHTML = '<div class="subpanel-head"><div><h2 class="subpanel-title"></h2>' +
          '<p class="subpanel-desc"></p></div><span class="health-pill ' + escHtml(healthClass) + '"></span></div>';
        statusPanel.querySelector(".subpanel-title").textContent = i18n("home.status.head");
        statusPanel.querySelector(".subpanel-desc").textContent = i18n("home.status.desc");
        statusPanel.querySelector(".health-pill").textContent = healthText;
        const statusList = document.createElement("div");
        statusList.className = "status-list";
        const rows = [
          [healthClass, i18n("common.moduleStatus"), healthDesc, active + "/" + providersCache.length],
          [localChatCount > 0 ? "good" : "warn", i18n("home.card.chat"), localChatCount > 0 ? i18n("home.chat.hint") : i18n("home.chat.empty"), i18n("home.stat.count", { n: localChatCount })],
          [inventoryCache ? "good" : "warn", i18n("home.card.inventory"), inventoryCache ? i18n("home.inventory.ok") : i18n("home.inventory.loading"), String(invTotal)],
        ];
        // ★자리: `모듈 상태`(지금 도는가) 바로 다음 = **둘째 줄**. 맨 끝에 뒀더니 390×780
        //  화면에서 top=811px 로 **뷰포트 밖**이었다(헤드리스 실측) — 모바일에서 보이게 하려고
        //  만든 행이 모바일에서만 안 보이면 고친 게 아니다. 나머지 둘은 개수라 밀려도 된다.
        const ver = versionStatusRow(appVersion, updateChip.state());
        rows.splice(1, 0, [ver.tone, i18n("home.stat.version"), ver.desc, ver.meta]);
        // (업데이트 판정이 **늦게** 도착하면 아래 onChange 등록이 이 화면을 다시 그린다.)
        for (const [tone, title, desc, meta] of rows) {
          const row = document.createElement("div");
          row.className = "status-row";
          row.innerHTML = '<span class="status-dot ' + escHtml(tone) + '"></span><div class="status-main"><div class="status-title">' + escHtml(title) + '</div><div class="status-desc">' + escHtml(desc) + '</div></div><span class="health-pill ' + escHtml(tone) + '">' + escHtml(meta) + '</span>';
          statusList.appendChild(row);
        }
        statusPanel.appendChild(statusList);
        layout.appendChild(statusPanel);

        const actionPanel = document.createElement("section");
        actionPanel.className = "subpanel";
        actionPanel.innerHTML = '<div class="subpanel-head"><div><h2 class="subpanel-title"></h2>' +
          '<p class="subpanel-desc"></p></div></div>';
        actionPanel.querySelector(".subpanel-title").textContent = i18n("home.quick.head");
        actionPanel.querySelector(".subpanel-desc").textContent = i18n("home.quick.desc");
        const actions = document.createElement("div");
        actions.className = "home-actions";
        const actionData = [
          ["providers", "📦", i18n("home.card.modules"), i18n("home.card.modulesDesc")],
          ["chat", "💬", i18n("home.card.chatWith", { name: assistantName }), i18n("home.card.chatDesc")],
          ["inventory", "📚", i18n("home.card.inventory"), i18n("home.card.inventoryDesc")],
          ["restart", "🔄", i18n("home.restart"), i18n("home.restartDesc")],
        ];
        for (const [view, icon, title, desc] of actionData) {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "home-action" + (view === "restart" ? " danger" : "");
          const iconCls = view === "restart" ? "ic warn" : "ic";
          btn.innerHTML = '<span class="' + escHtml(iconCls) + '">' + escHtml(icon) + '</span><span><strong>' + escHtml(title) + '</strong><span>' + escHtml(desc) + '</span></span>';
          btn.addEventListener("click", () => {
            if (view === "providers") showProviders();
            else if (view === "chat") { setActiveNav("chat"); setChatPanel("chat"); setActiveTab("chat"); scrollChatToNewest(); focusChatInput(); }
            else if (view === "inventory") showInventory();
            else if (view === "restart") { restartDaemon(); return; }
            if (window.matchMedia("(max-width: 900px)").matches && view !== "chat") setActiveTab("main");
          });
          actions.appendChild(btn);
        }
        actionPanel.appendChild(actions);
        layout.appendChild(actionPanel);
        wrap.appendChild(layout);
        root.appendChild(wrap);
        // 문서에 붙었다 — 이제 그린다(마운트가 항상 **연결된** 노드를 받는다).
        if (widgetPanel) {
          for (const w of homeWidgets) {
            const card = widgetPanel.querySelector('.home-widget[data-id="' + CSS.escape(w.id) + '"]');
            if (card) paintHomeWidget(card, w);
          }
        }

        // ★타이머는 **그린 뒤에** 건다. 배치를 아직 못 받았으면 그것부터 받아오고,
        //  받아오면 (바뀌었을 때만) 다시 그린다.
        if (homeWidgets === null) {
          void loadHomeLayout(true);
        } else if (homeWidgets.length > 0) {
          for (const w of homeWidgets) {
            // live 위젯(라우트 없음)은 받아올 게 없다 — 타이머도 안 건다.
            if (!homeDataRoutes.includes(w.type)) continue;
            void refreshHomeWidget(w);
            homeTimers.push(setInterval(() => void refreshHomeWidget(w), HOME_WIDGET_POLL_MS));
          }
        }
        // 배치 자체도 지켜본다 — "대화로 추가해줘" 가 화면에 반영되는 길이다.
        homeTimers.push(setInterval(() => void loadHomeLayout(true), HOME_LAYOUT_POLL_MS));
      };

      // showInventory (능력 뷰 진입) — view-inventory.js 로 이관(ADR 2026-07-17 §5·§7 P2, 3패널화
      // 로직이 리스트 서브패널·선택 상태를 함께 다루므로 그 파일에 정의를 모음). 이 파일에서의
      // 호출부(overview 액션 버튼 등)는 call-time 해석이라 로드 순서(view-inventory.js 는 이
      // 파일 다음에 로드)에 영향받지 않는다.

      // ── 모델 프로파일 뷰(표시 전용) ──────────────────────────────────────────
      // settings.json models.profiles 를 카드로 렌더. /models 슬래시와 동일 정보(이름·설명·
      // 풀·폴백)를 시각적으로. 편집 없음 — 설정은 대화로(비서가 settings.json 편집). LLM/채널 무관.

      // ── 업데이트 판정 도착 시 홈 갱신 (2026-08-21 적대 검토 F1) ──────────────
      // ★**여기서 등록한다** — `update-chip.js` 는 이 파일보다 먼저 로드되므로 거기서
      //  `showOverview` 를 이름으로 부르면 전방 참조이고, fetch 가 스크립트 배달보다 빠른
      //  순간 ReferenceError 로 **받을 업데이트가 조용히 사라졌다**(실측 재현). 늦게 로드되는
      //  쪽이 자기 파일에서 등록하면 순서에 무관하다.
      // 첫 렌더가 이 등록보다 빨라도 손실 없다 — 그때는 showOverview 가 updateChip.state() 를
      // 직접 읽는다(밀어주기와 당겨오기 둘 다 있고, 늦은 쪽이 이긴다).
      updateChip.onChange(() => {
        if (currentView === "overview") setTimeout(showOverview, 0);
      });
