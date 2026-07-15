      const showProviders = () => {
        setActiveNav("providers");
        setChatPanel("chat");
        document.getElementById("workbench").classList.remove("show-providers");
        if (!selectedProviderId && providersCache.length > 0) selectedProviderId = providersCache[0].id;
        renderProviderHub();
      };

      const renderProviderCard = (provider) => {
        const status = provider.status || "unknown";
        const card = document.createElement("button");
        card.type = "button";
        card.className = "provider-card s-" + status + (provider.id === selectedProviderId ? " selected" : "");
        const caps = Array.isArray(provider.capabilities) ? provider.capabilities : [];
        card.innerHTML = '<div class="provider-card-head"><span class="provider-card-name">' + (provider.name || provider.id) + '</span><span class="provider-card-kind">' + kindLabel(provider.kind) + '</span><span class="pi-status-dot ' + status + '"></span></div><div class="provider-card-summary">' + (provider.summary || "상태 정보 없음") + '</div>';
        const meta = document.createElement("div");
        meta.className = "provider-card-meta";
        meta.innerHTML = '<span class="provider-chip">화면 ' + ((provider.views || []).length) + '</span><span class="provider-chip">작업 ' + ((provider.actions || []).length) + '</span>' + caps.slice(0, 2).map((cap) => '<span class="provider-chip">' + cap + '</span>').join("");
        card.appendChild(meta);
        card.addEventListener("click", () => selectProvider(provider.id, { userClick: true }));
        return card;
      };

      const renderProviderSection = (title, desc, list) => {
        const section = document.createElement("section");
        section.className = "subpanel";
        section.innerHTML = '<div class="subpanel-head"><div><h2 class="subpanel-title">' + title + '</h2><p class="subpanel-desc">' + desc + '</p></div><span class="subpanel-count">' + list.length + '개</span></div>';
        const grid = document.createElement("div");
        grid.className = "provider-grid";
        if (list.length === 0) {
          const e = document.createElement("div");
          e.className = "empty";
          e.textContent = "표시할 항목이 없습니다.";
          grid.appendChild(e);
        }
        for (const provider of list) grid.appendChild(renderProviderCard(provider));
        section.appendChild(grid);
        return section;
      };

      const renderProviderDetailCard = (provider) => {
        const shell = document.createElement("section");
        shell.className = "subpanel detail-card";
        if (!provider) {
          shell.innerHTML = '<div class="subpanel-head"><div><h2 class="subpanel-title">상세</h2><p class="subpanel-desc">왼쪽 카드에서 프로바이더를 선택하세요.</p></div></div><div class="empty">선택된 프로바이더가 없습니다.</div>';
          return shell;
        }
        const status = provider.status || "unknown";
        const summaryGrid = document.createElement("div");
        summaryGrid.className = "summary-grid";
        const metricData = [
          ["상태", statusLabel(status), provider.summary || "프로바이더 상태"],
          ["화면", String((provider.views || []).length), "사용 가능한 패널"],
          ["작업", String((provider.actions || []).length), "호출 가능한 기능"],
        ];
        for (const [label, value, hint] of metricData) {
          const card = document.createElement("div");
          card.className = "summary-card";
          card.innerHTML = '<div class="summary-label">' + label + '</div><div class="summary-value">' + value + '</div><div class="summary-hint">' + hint + '</div>';
          summaryGrid.appendChild(card);
        }
        const head = document.createElement("div");
        head.className = "detail-head";
        head.innerHTML = '<div class="detail-accent ' + status + '"></div><div><div class="detail-name">' + (provider.name || provider.id) + '</div><div class="detail-summary" style="margin:4px 0 0">' + (provider.summary || "프로바이더 상태") + '</div></div><span class="detail-kind">' + kindLabel(provider.kind) + '</span><span class="detail-status ' + status + '">' + statusLabel(status) + '</span>';
        shell.appendChild(head);
        shell.appendChild(summaryGrid);
        const caps = Array.isArray(provider.capabilities) ? provider.capabilities : [];
        if (caps.length > 0) {
          const meta = document.createElement("div");
          meta.className = "detail-meta";
          for (const cap of caps) {
            const c = document.createElement("span");
            c.className = "detail-cap"; c.textContent = cap;
            meta.appendChild(c);
          }
          shell.appendChild(meta);
        }
        const views = (provider.views || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
        const viewsWrap = document.createElement("div");
        viewsWrap.className = "views";
        for (const view of views) viewsWrap.appendChild(renderProviderView(view));
        if ((provider.actions || []).length > 0) {
          viewsWrap.appendChild(renderProviderView({ title: "작업", kind: "action-panel", data: { actions: provider.actions } }));
        }
        if (views.length === 0 && (provider.actions || []).length === 0) {
          const e = document.createElement("div");
          e.className = "empty";
          e.textContent = "표시할 세부 패널이 없습니다.";
          viewsWrap.appendChild(e);
        }
        shell.appendChild(viewsWrap);
        return shell;
      };

      const renderProviderHub = () => {
        const root = document.getElementById("detail-panel");
        root.innerHTML = "";
        const wrap = document.createElement("div");
        wrap.className = "page-view content-stack";
        const active = providersCache.filter((p) => (p.status || "unknown") === "active").length;
        const degraded = providersCache.filter((p) => ["degraded", "error"].includes(p.status || "unknown")).length;
        const head = document.createElement("div");
        head.className = "detail-head";
        head.innerHTML = '<div class="detail-accent active"></div><div><div class="detail-name">프로바이더</div><div class="detail-summary" style="margin:4px 0 0">카테고리별 기능 패널과 선택한 프로바이더 상세를 한 화면에서 봅니다.</div></div><span class="detail-status active">' + providersCache.length + '개</span>';
        wrap.appendChild(head);
        const summaryGrid = document.createElement("div");
        summaryGrid.className = "summary-grid";
        const metricData = [["전체", String(providersCache.length), "등록된 프로바이더"], ["정상", String(active), "활성 상태"], ["주의", String(degraded), "점검 필요"]];
        for (const [label, value, hint] of metricData) {
          const card = document.createElement("div");
          card.className = "summary-card";
          card.innerHTML = '<div class="summary-label">' + label + '</div><div class="summary-value">' + value + '</div><div class="summary-hint">' + hint + '</div>';
          summaryGrid.appendChild(card);
        }
        wrap.appendChild(summaryGrid);
        const layout = document.createElement("div");
        layout.className = "provider-layout";
        const sections = document.createElement("div");
        sections.className = "provider-sections";
        const coreProviders = providersCache.filter(isCoreProvider);
        const pluginProviders = providersCache.filter((p) => !isCoreProvider(p));
        sections.appendChild(renderProviderSection("코어 프로바이더", "데몬, 메모리, 스케줄처럼 기본 런타임을 구성하는 패널입니다.", coreProviders));
        sections.appendChild(renderProviderSection("플러그인 프로바이더", "플러그인이나 외부 확장이 제공하는 패널입니다.", pluginProviders));
        layout.appendChild(sections);
        const selected = providersCache.find((p) => p.id === selectedProviderId) || providersCache[0] || null;
        if (selected && !selectedProviderId) selectedProviderId = selected.id;
        layout.appendChild(renderProviderDetailCard(selected));
        wrap.appendChild(layout);
        root.appendChild(wrap);
      };

      const renderDetail = (provider) => {
        setActiveNav("providers");
        document.getElementById("workbench").classList.remove("show-providers");
        const root = document.getElementById("detail-panel");
        root.innerHTML = "";
        if (!provider) {
          const e = document.createElement("div");
          e.id = "detail-empty";
          e.textContent = "목록에서 프로바이더를 선택하세요.";
          root.appendChild(e);
          return;
        }
        const status = provider.status || "unknown";
        const summaryGrid = document.createElement("div");
        summaryGrid.className = "summary-grid";
        const metricData = [
          ["상태", statusLabel(status), provider.summary || "프로바이더 상태"],
          ["화면", String((provider.views || []).length), "사용 가능한 패널"],
          ["작업", String((provider.actions || []).length), "호출 가능한 기능"],
        ];
        for (const [label, value, hint] of metricData) {
          const card = document.createElement("div");
          card.className = "summary-card";
          const l = document.createElement("div");
          l.className = "summary-label"; l.textContent = label;
          const v = document.createElement("div");
          v.className = "summary-value"; v.textContent = value;
          const h = document.createElement("div");
          h.className = "summary-hint"; h.textContent = hint;
          card.appendChild(l); card.appendChild(v); card.appendChild(h);
          summaryGrid.appendChild(card);
        }
        root.appendChild(summaryGrid);
        const head = document.createElement("div");
        head.className = "detail-head";
        const accent = document.createElement("div");
        accent.className = "detail-accent " + status;
        const name = document.createElement("div");
        name.className = "detail-name"; name.textContent = provider.name || provider.id;
        const kind = document.createElement("span");
        kind.className = "detail-kind"; kind.textContent = kindLabel(provider.kind);
        const statusEl = document.createElement("span");
        statusEl.className = "detail-status " + status; statusEl.textContent = statusLabel(status);
        head.appendChild(accent); head.appendChild(name); head.appendChild(kind); head.appendChild(statusEl);
        root.appendChild(head);
        if (provider.summary) {
          const summary = document.createElement("div");
          summary.className = "detail-summary"; summary.textContent = provider.summary;
          root.appendChild(summary);
        }
        const caps = Array.isArray(provider.capabilities) ? provider.capabilities : [];
        if (caps.length > 0) {
          const meta = document.createElement("div");
          meta.className = "detail-meta";
          for (const cap of caps) {
            const c = document.createElement("span");
            c.className = "detail-cap"; c.textContent = cap;
            meta.appendChild(c);
          }
          root.appendChild(meta);
        }
        const views = (provider.views || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
        const viewsWrap = document.createElement("div");
        viewsWrap.className = "views";
        for (const view of views) viewsWrap.appendChild(renderProviderView(view));
        if ((provider.actions || []).length > 0) {
          viewsWrap.appendChild(renderProviderView({ title: "작업", kind: "action-panel", data: { actions: provider.actions } }));
        }
        root.appendChild(viewsWrap);
      };

      const selectProvider = (id, opts) => {
        selectedProviderId = id;
        for (const child of document.querySelectorAll("#providers-list .provider-item")) {
          child.classList.toggle("selected", child.dataset.id === id);
        }
        const p = providersCache.find((x) => x.id === id) || null;
        if (currentView === "providers") renderProviderHub();
        else renderDetail(p);
        if (id) {
          try { history.replaceState(null, "", "#provider=" + encodeURIComponent(id)); } catch (e) { /* ignore */ }
        }
        // mobile: provider 사용자 클릭 시 메인 화면에 상세를 유지합니다.
        if (opts && opts.userClick && window.matchMedia("(max-width: 900px)").matches) {
          setActiveTab("main");
        }
      };

      const setActiveTab = (name) => {
        document.body.dataset.tab = name;
        for (const btn of document.querySelectorAll("#tab-bar .tab")) {
          btn.classList.toggle("active", btn.dataset.tab === name);
        }
      };
      for (const btn of document.querySelectorAll("#tab-bar .tab")) {
        btn.addEventListener("click", () => setActiveTab(btn.dataset.tab));
      }

      const renderProviders = (registry) => {
        const list = document.getElementById("providers-list");
        const countEl = document.getElementById("providers-count");
        list.innerHTML = "";
        const providers = registry.providers || [];
        providersCache = providers;
        countEl.textContent = providers.length + "개";
        const navCount = document.getElementById("nav-provider-count");
        if (navCount) navCount.textContent = String(providers.length);
        if (providers.length === 0) {
          const e = document.createElement("div");
          e.className = "empty"; e.style.margin = "8px";
          e.textContent = "프로바이더가 없습니다.";
          list.appendChild(e);
          renderDetail(null);
          return;
        }
        for (const provider of providers) {
          const status = provider.status || "unknown";
          const item = document.createElement("div");
          item.className = "provider-item s-" + status;
          item.dataset.id = provider.id;
          const head = document.createElement("div");
          head.className = "pi-head";
          const name = document.createElement("span");
          name.className = "pi-name"; name.textContent = provider.name || provider.id;
          const kind = document.createElement("span");
          kind.className = "pi-kind"; kind.textContent = kindLabel(provider.kind);
          const dot = document.createElement("span");
          dot.className = "pi-status-dot " + status;
          dot.title = status;
          head.appendChild(name); head.appendChild(kind); head.appendChild(dot);
          item.appendChild(head);
          if (provider.summary) {
            const summary = document.createElement("div");
            summary.className = "pi-summary"; summary.textContent = provider.summary;
            item.appendChild(summary);
          }
          item.addEventListener("click", () => selectProvider(provider.id, { userClick: true }));
          list.appendChild(item);
        }
        // 선택 유지 (URL hash → 이전 선택 → 첫번째)
        let nextId = selectedProviderId;
        if (!nextId) {
          const hash = (window.location.hash || "").match(/provider=([^&]+)/);
          if (hash) nextId = decodeURIComponent(hash[1]);
        }
        if (!nextId || !providers.some((p) => p.id === nextId)) {
          nextId = providers[0].id;
        }
        selectedProviderId = nextId;
        if (currentView === "providers") renderProviderHub();
        else if (currentView === "overview") showOverview();
      };

      const fetchProviders = async () => {
        try {
          const r = await fetch("/api/providers");
          if (!r.ok) throw new Error("HTTP " + r.status);
          renderProviders(await r.json());
        } catch (e) {
          const list = document.getElementById("providers-list");
          list.innerHTML = "";
          const div = document.createElement("div");
          div.className = "empty"; div.style.margin = "8px";
          div.textContent = "불러오기 실패: " + e.message;
          list.appendChild(div);
        }
      };

