      const setActiveNav = (view) => {
        currentView = view;
        document.body.dataset.view = view;
        document.body.dataset.main = view === "chat" ? "stream" : view === "activity" ? "activity" : "workbench";
        // 워크벤치 3패널 모드 클래스 중앙 초기화 — 각 뷰가 setActiveNav 후 자기 모드만 add.
        // (모듈=show-providers / 능력=show-capabilities / 프로젝트=show-projects. 나머지=없음).
        const wb = document.getElementById("workbench");
        if (wb) wb.classList.remove("show-providers", "show-capabilities", "show-projects");
        for (const btn of document.querySelectorAll(".nav-button")) {
          btn.classList.toggle("active", btn.dataset.view === view);
        }
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
        const healthText = errors > 0 ? "오류" : degraded > 0 ? "주의" : "정상";
        const healthDesc = providersCache.length === 0
          ? "모듈 정보를 불러오는 중입니다."
          : degraded > 0
            ? "점검이 필요한 모듈이 " + degraded + "개 있습니다."
            : "모든 모듈이 정상 상태입니다.";
        root.innerHTML = "";
        const wrap = document.createElement("div");
        wrap.className = "page-view overview";

        const hero = document.createElement("div");
        hero.className = "hero-card";
        hero.innerHTML = '<h1>오늘의 운영 상태</h1><p>자주 보는 상태와 다음 행동만 모았습니다. 자세한 런타임 정보는 모듈과 능력에서 확인하세요.</p>';
        wrap.appendChild(hero);

        const quick = document.createElement("div");
        quick.className = "quick-grid";
        const metrics = [
          ["상태", healthText, healthDesc],
          ["모듈", String(providersCache.length), active + "개 정상"],
          ["이벤트", String(evCount), "채팅의 활동 로그에서 확인"],
        ];
        for (const [label, value, hint] of metrics) {
          const card = document.createElement("div");
          card.className = "quick-card";
          card.innerHTML = '<div class="quick-label">' + label + '</div><div class="quick-value">' + value + '</div><div class="quick-hint">' + hint + '</div>';
          quick.appendChild(card);
        }
        wrap.appendChild(quick);

        const layout = document.createElement("div");
        layout.className = "overview-layout";
        const statusPanel = document.createElement("section");
        statusPanel.className = "subpanel";
        statusPanel.innerHTML = '<div class="subpanel-head"><div><h2 class="subpanel-title">상태 요약</h2><p class="subpanel-desc">지금 확인해야 할 운영 신호입니다.</p></div><span class="health-pill ' + healthClass + '">' + healthText + '</span></div>';
        const statusList = document.createElement("div");
        statusList.className = "status-list";
        const rows = [
          [healthClass, "모듈 상태", healthDesc, active + "/" + providersCache.length],
          [localChatCount > 0 ? "good" : "warn", "대화", localChatCount > 0 ? "최근 대화가 대화 탭에 표시됩니다." : "아직 대화가 없습니다.", localChatCount + "개"],
          [inventoryCache ? "good" : "warn", "능력", inventoryCache ? "스킬·에이전트·MCP 등 능력을 불러왔습니다." : "능력 목록을 불러오는 중입니다.", String(invTotal)],
        ];
        for (const [tone, title, desc, meta] of rows) {
          const row = document.createElement("div");
          row.className = "status-row";
          row.innerHTML = '<span class="status-dot ' + tone + '"></span><div class="status-main"><div class="status-title">' + title + '</div><div class="status-desc">' + desc + '</div></div><span class="health-pill ' + tone + '">' + meta + '</span>';
          statusList.appendChild(row);
        }
        statusPanel.appendChild(statusList);
        layout.appendChild(statusPanel);

        const actionPanel = document.createElement("section");
        actionPanel.className = "subpanel";
        actionPanel.innerHTML = '<div class="subpanel-head"><div><h2 class="subpanel-title">빠른 이동</h2><p class="subpanel-desc">자주 쓰는 화면으로 바로 들어갑니다.</p></div></div>';
        const actions = document.createElement("div");
        actions.className = "home-actions";
        const actionData = [
          ["providers", "📦", "모듈 보기", "채널·어댑터 등 카테고리별 패널과 상세 상태 확인"],
          ["chat", "💬", assistantName + "와 대화", "대화와 활동 로그를 한 화면에서 확인"],
          ["inventory", "📚", "능력", "스킬·에이전트(명세)·MCP 등 설치·발견된 capability 점검"],
          ["restart", "🔄", "데몬 재시작", "멈춘 작업까지 정리하고 자동 복귀"],
        ];
        for (const [view, icon, title, desc] of actionData) {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "home-action" + (view === "restart" ? " danger" : "");
          const iconCls = view === "restart" ? "ic warn" : "ic";
          btn.innerHTML = '<span class="' + iconCls + '">' + icon + '</span><span><strong>' + title + '</strong><span>' + desc + '</span></span>';
          btn.addEventListener("click", () => {
            if (view === "providers") showProviders();
            else if (view === "chat") { setActiveNav("chat"); setChatPanel("chat"); setActiveTab("chat"); scrollChatToNewest(); document.getElementById("chat-input").focus(); }
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
      };

      // showInventory (능력 뷰 진입) — view-inventory.js 로 이관(ADR 2026-07-17 §5·§7 P2, 3패널화
      // 로직이 리스트 서브패널·선택 상태를 함께 다루므로 그 파일에 정의를 모음). 이 파일에서의
      // 호출부(overview 액션 버튼 등)는 call-time 해석이라 로드 순서(view-inventory.js 는 이
      // 파일 다음에 로드)에 영향받지 않는다.

      // ── 모델 프로파일 뷰(표시 전용) ──────────────────────────────────────────
      // settings.json models.profiles 를 카드로 렌더. /models 슬래시와 동일 정보(이름·설명·
      // 풀·폴백)를 시각적으로. 편집 없음 — 설정은 대화로(비서가 settings.json 편집). LLM/채널 무관.
