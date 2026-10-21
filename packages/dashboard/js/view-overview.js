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
      // ★주소의 `?view=` 가 있으면 그것이 먼저다 (2026-10-18, 깨끗한 윈도우 실기) — onboard 의 도착점은 «첫 대화» 인데
      //  첫 방문엔 저장값이 없어 홈이 떴다. 한 번 쓰고 주소에서 뗀다(새로고침은 다시 마지막 본 화면을 따른다).
      let viewHint = null;
      try {
        const q = new URLSearchParams(location.search);
        viewHint = q.get("view");
        if (viewHint !== null) {
          q.delete("view");
          const rest = q.toString();
          history.replaceState(null, "", location.pathname + (rest ? "?" + rest : "") + location.hash);
        }
      } catch {
        viewHint = null;
      }
      try {
        window.__dashBootView = viewHint || localStorage.getItem(VIEW_LS);
      } catch {
        window.__dashBootView = viewHint; // 프라이빗 모드·quota — 복원 없이 기존 동작.
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
        //  (같은 이유로 「마지막 본 페이지」 저장도 여기 있다).
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
        setWorkbenchLayout();
        for (const btn of document.querySelectorAll(".nav-button")) {
          btn.classList.toggle("active", btn.dataset.view === view);
        }
      };

      // ── 홈 위젯 → 위젯 패널 (2026-10-20) ────────────────────────────────────
      // ★홈의 위젯 영역은 **없앴다** — 위젯은 어디서나 열리는 오른쪽 위젯 패널(`widget-panel.js`)에 뜬다
      //  (정태님: «홈이 굳이 의미가 없다, 채팅이 거의 메인»). 홈엔 코어 카드(요약·상태·빠른 이동)만 남는다.

      // ── 홈 갱신 합치기 (2026-10-09 적대 검토) ─────────────────────────────────
      //
      // ★홈은 **SSE 이벤트마다** «다시 그려라» 를 받는다(sse.js·token-delta.js·channel-hints.js
      //  등이 `if (currentView === "overview") setTimeout(showOverview, 0)`). 종전엔 그때마다
      //  `root.innerHTML` 을 통째로 갈아 **위젯을 떼었다 다시 붙이고 위젯 값(plugin-data)을 다시
      //  부르고 타이머를 새로 걸었다** — 스트리밍 중엔 초당 수십 번이다.
      // ★고침은 부르는 쪽(열 곳)을 고치는 게 아니라 **받는 쪽 한 곳**이다: 이미 홈이면 그 호출은
      //  이동이 아니라 갱신이므로 짧은 창으로 합치고(창 안의 요청은 한 번이 된다 — 마지막 상태로),
      //  갱신은 **숫자 부분만** 바꾼다.
      const OVERVIEW_REFRESH_MS = 250;
      let overviewRefreshTimer = null;

      const showOverview = () => {
        if (currentView === "overview") {
          if (overviewRefreshTimer === null) {
            overviewRefreshTimer = setTimeout(() => {
              overviewRefreshTimer = null;
              if (currentView === "overview") renderOverview(false);
            }, OVERVIEW_REFRESH_MS);
          }
          return;
        }
        setActiveNav("overview");
        setChatPanel("chat");
        setWorkbenchLayout();
        renderOverview(true);
      };

      /** @param {boolean} enter 홈으로 **들어오는** 그림인가(위젯을 새로 붙인다). 거짓이면 갱신. */
      const renderOverview = (enter) => {
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
        const hero = document.createElement("div");
        hero.className = "hero-card";
        hero.innerHTML = "<h1></h1><p></p>";
        hero.querySelector("h1").textContent = i18n("home.hero.title");
        hero.querySelector("p").textContent = i18n("home.hero.desc");

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

        // ── 갱신이면 **숫자 부분만** 갈아 끼운다(홈 그림이 없으면 — 누가 패널을 비웠다 — 아래 전체 그리기) ──
        const live = root.firstElementChild;
        if (!enter && live && live.classList.contains("overview")) {
          for (const node of [hero, quick, layout]) {
            const old = [...live.children].find((c) => c.className === node.className);
            if (old) old.replaceWith(node);
            else live.appendChild(node);
          }
          return;
        }

        root.innerHTML = "";
        const wrap = document.createElement("div");
        wrap.className = "page-view overview";
        wrap.appendChild(hero);
        wrap.appendChild(quick);
        wrap.appendChild(layout);
        root.appendChild(wrap);
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
