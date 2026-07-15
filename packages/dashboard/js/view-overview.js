      const setActiveNav = (view) => {
        currentView = view;
        document.body.dataset.view = view;
        document.body.dataset.main = view === "chat" ? "stream" : view === "activity" ? "activity" : "workbench";
        for (const btn of document.querySelectorAll(".nav-button")) {
          btn.classList.toggle("active", btn.dataset.view === view);
        }
      };

      const showOverview = () => {
        setActiveNav("overview");
        setChatPanel("chat");
        document.getElementById("workbench").classList.remove("show-providers");
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
          ? "프로바이더 정보를 불러오는 중입니다."
          : degraded > 0
            ? "점검이 필요한 프로바이더가 " + degraded + "개 있습니다."
            : "모든 프로바이더가 정상 상태입니다.";
        root.innerHTML = "";
        const wrap = document.createElement("div");
        wrap.className = "page-view overview";

        const hero = document.createElement("div");
        hero.className = "hero-card";
        hero.innerHTML = '<h1>오늘의 운영 상태</h1><p>자주 보는 상태와 다음 행동만 모았습니다. 자세한 런타임 정보는 프로바이더와 인벤토리에서 확인하세요.</p>';
        wrap.appendChild(hero);

        const quick = document.createElement("div");
        quick.className = "quick-grid";
        const metrics = [
          ["상태", healthText, healthDesc],
          ["프로바이더", String(providersCache.length), active + "개 정상"],
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
          [healthClass, "프로바이더 상태", healthDesc, active + "/" + providersCache.length],
          [localChatCount > 0 ? "good" : "warn", "대화", localChatCount > 0 ? "최근 대화가 대화 탭에 표시됩니다." : "아직 대화가 없습니다.", localChatCount + "개"],
          [inventoryCache ? "good" : "warn", "런타임 인벤토리", inventoryCache ? "채널·플러그인·스킬·에이전트를 불러왔습니다." : "인벤토리를 불러오는 중입니다.", String(invTotal)],
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
          ["providers", "📦", "프로바이더 보기", "카테고리별 패널과 상세 상태 확인"],
          ["chat", "💬", assistantName + "와 대화", "대화와 활동 로그를 한 화면에서 확인"],
          ["inventory", "🧩", "런타임 인벤토리", "설치·발견된 capability 점검"],
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

      const showInventory = () => {
        setActiveNav("inventory");
        setChatPanel("chat");
        document.getElementById("workbench").classList.remove("show-providers");
        const root = document.getElementById("detail-panel");
        root.innerHTML = "";
        const wrap = document.createElement("div");
        wrap.className = "page-view";
        wrap.innerHTML = '<div class="detail-head"><div class="detail-accent active"></div><div class="detail-name">런타임 인벤토리</div><span class="detail-kind">관리</span></div><p class="developer-copy">설치/발견된 채널, 플러그인, 스킬, 에이전트, MCP를 확인하는 관리용 레지스트리입니다. 평소 작업 흐름에서는 숨겨둡니다.</p><div id="inventory" class="inventory-shell"><div class="empty">불러오는 중…</div></div>';
        root.appendChild(wrap);
        if (inventoryCache) renderInventory(inventoryCache);
      };

      // ── 모델 프로파일 뷰(표시 전용) ──────────────────────────────────────────
      // settings.json models.profiles 를 카드로 렌더. /models 슬래시와 동일 정보(이름·설명·
      // 풀·폴백)를 시각적으로. 편집 없음 — 설정은 대화로(돌쇠가 settings.json 편집). LLM/채널 무관.
