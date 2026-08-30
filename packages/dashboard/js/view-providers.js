      // ── 모듈 뷰 = 프로바이더 + 채널 통합 + 3패널 마스터-디테일 (ADR 2026-07-17 §5·§7 P0+P1) ──
      // 갭(ADR §1): 채널 플러그인(telegram·cli)은 /api/channels 로만 노출되고 /api/providers
      // (collectProviders)엔 안 떠서 컴포넌트 목록에서 빠져 있었다. P0 슬라이스는 코어 리네임
      // (Provider→Module 타입) 없이, 대시보드 렌더 레벨에서만 두 소스를 한 목록으로 합친다 —
      // (채널 항목은 views/actions 가 비어 있어 디테일 패널이 자연히 "상태/kind" 최소형으로 렌더됨).
      // P1(이 슬라이스, §5): 레이아웃을 `사이드바 nav | 모듈 리스트(서브패널, kind 그룹) | 디테일`
      // 3패널로 정돈. #providers-panel(리스트)+#detail-panel(디테일)을 동시에 보이는 진짜 두 컬럼으로
      // 만들고(app.css #workbench.show-providers), 리스트를 kind 값으로 그룹핑(kindLabel 폴백 →
      // §5.5 선언형/제네릭, 새 kind 값도 코드변경0으로 새 그룹). 클릭 시 디테일에 그 모듈의
      // ViewSpec[]/ActionSpec[] 을 기존 renderProviderView 제네릭 렌더러로 그대로 표시.
      const CHANNEL_STATUS_TO_MODULE_STATUS = { up: "active", disabled: "inactive" };

      const channelToModuleItem = (c) => {
        const status = CHANNEL_STATUS_TO_MODULE_STATUS[c.status] || "unknown";
        const bits = [status === "inactive" ? i18n("modules.group.inactiveChannel") : i18n("modules.group.liveChannel")];
        if (c.canDeliver) bits.push(i18n("modules.cap.egress"));
        return {
          id: "channel." + (c.name || "unknown"),
          kind: "channel",
          name: c.name || i18n("common.unnamed"),
          status,
          summary: bits.join(" · "),
          capabilities: [],
          views: [],
          actions: [],
        };
      };

      // 프로바이더/채널 중복 방지 — 같은 컴포넌트가 provider export 로도 이미 잡혀 있으면(예:
      // 미래에 채널이 provider manifest 도 함께 등록) 채널 파생 항목을 또 추가하지 않는다.
      const mergeProvidersAndChannels = (providers, channels) => {
        const list = providers.slice();
        const seen = new Set();
        for (const p of providers) {
          if (typeof p.id === "string") seen.add(p.id.toLowerCase());
          { const nm = resolveText(p.name); if (nm !== "") seen.add(nm.toLowerCase()); }
        }
        for (const c of channels || []) {
          const name = (c.name || "").toLowerCase();
          if (name === "" || seen.has(name) || seen.has("channel." + name)) continue;
          seen.add(name);
          list.push(channelToModuleItem(c));
        }
        return list;
      };

      // 모듈 리스트 그룹 순서(ADR §5 mock "채널/어댑터/트리거/옵저버/서비스/코어") — 지금 실제
      // kind 값은 core|plugin|channel 뿐이라 대부분 폴백(§5.5)으로 떨어지지만, type 필드가 생기는
      // P3 이후에도 코드 변경 없이 같은 순서를 그대로 쓰도록 어댑터/트리거/옵저버/서비스도 미리 둔다.
      // 목록에 없는(미지) kind 는 등장 순서대로 뒤에 붙는다 — 새 모듈 kind 도 코드변경0으로 그룹 생성.
      const MODULE_GROUP_ORDER = ["channel", "adapter", "llm-adapter", "trigger", "observer", "service", "core", "plugin"];
      // 카테고리 아이콘 — 그룹 헤더 전용(항목 kind 배지는 kindLabel 그대로, 깨끗이). 미지 kind=아이콘 없음.
      const MODULE_GROUP_ICON = { channel: "📡", adapter: "🧠", "llm-adapter": "🧠", trigger: "⏰", observer: "👁️", service: "🖥️", core: "⚙️", plugin: "🔌" };
      const moduleGroupLabel = (kind) => (MODULE_GROUP_ICON[kind] ? MODULE_GROUP_ICON[kind] + " " : "") + kindLabel(kind);
      const groupProvidersByKind = (providers) => {
        const buckets = new Map();
        for (const p of providers) {
          const kind = p.kind || "unknown";
          if (!buckets.has(kind)) buckets.set(kind, []);
          buckets.get(kind).push(p);
        }
        const orderedKinds = Array.from(buckets.keys()).sort((a, b) => {
          const ia = MODULE_GROUP_ORDER.indexOf(a);
          const ib = MODULE_GROUP_ORDER.indexOf(b);
          if (ia === -1 && ib === -1) return 0; // 미지 kind 둘 다면 등장(Map insertion) 순서 유지
          if (ia === -1) return 1;
          if (ib === -1) return -1;
          return ia - ib;
        });
        return orderedKinds.map((kind) => ({ kind, label: moduleGroupLabel(kind), items: buckets.get(kind) }));
      };

      // (검색+접이식 카테고리 — ADR §5·§5.5 마스터-디테일 통일) 그룹 헤더/검색 필터는
      // js/util.js 의 appendCollapsibleGroup·applyListSearchFilter 공용 헬퍼로 이관(능력 뷰와 재사용).

      // ── 모듈 활성/비활성 토글 (P4a-2 — ADR 2026-07-17-module-capability-model §5.6, 백엔드
      // P4a-1 commit 355b3fd) ───────────────────────────────────────────────────────────
      // GET /inventory(=/api/inventory) 의 channel·external_plugin 카테고리가 loadPlugins 스킵
      // 대상과 동일 모집단(plugins/*/package.json 의 tiguclaw.name)이자 POST /set-module-enabled
      // 가 받는 `name` 의 정답 소스. 그 이름이 대시보드가 이미 렌더 중인 provider/channel 항목의
      // 표시명과 항상 같지는 않다(예: cli 채널의 라이브 name="cli" ≠ 매니페스트 tiguclaw.name=
      // "cli-plugin" — 기존 불일치, 이 슬라이스 범위 밖) → "정확히 일치할 때만" 기존 항목에
      // moduleName 을 붙이고, 매치 안 되는 인벤토리 엔트리(dashboard·scheduler·file-watch 등 —
      // provider export 도 채널 presence 도 없어 지금 목록에 아예 없던 번들 플러그인들)는 합성
      // (synthetic) 모듈 아이템으로 새로 노출한다(§5 마이그레이션 P2 "번들 플러그인 전부 노출"
      // 을 이 프런트 슬라이스가 선반영). 토글 가시성은 문자 그대로의 `provider.kind==="plugin"`
      // 이 아니라 **moduleName 해석 성공 여부**로 게이트한다 — core.* 프로바이더(daemon·memory·
      // schedule·plugin-registry)는 인벤토리에 대응 엔트리가 없어 자연히 토글이 안 붙는다(가드1
      // 이 코드 분기 없이 그대로 유지됨), 반대로 채널 계열(http-bridge·cli-plugin)도 실제로
      // loadPlugins skip 대상이라 토글이 있어야 하므로 kind 리터럴 대신 이 방식을 쓴다.
      const normModuleKey = (s) => String(s || "").trim().toLowerCase().replace(/[\s_]+/g, "-");

      // ★손 목록 미러였다(2026-08-26 제거). `http-bridge` 는 이제 **manifest 선언**
      // (`tiguclaw.core`)을 인벤토리가 실어주므로 `item.core` 로 읽고, 코어면 토글 자체를
      // 안 그린다(서버도 거절한다 — 이중 방어). 남은 `dashboard` 는 의존이 아니라
      // **자기참조**(끄면 이 화면을 잃는다)라 유도할 수 없어 목록으로 남는다. 막지는 않고
      // 확인만 받는다(파괴적-행위 소프트 게이트).


      const findInventoryMatch = (item, invIndex) => {
        const candidates = [item.name, String(item.id || "").replace(/^(channel|plugin)\./, "")];
        for (const c of candidates) {
          const entry = invIndex.get(normModuleKey(c));
          if (entry) return entry;
        }
        return null;
      };

      // list(providers+channels 병합 결과)를 in-place 로 보강: 매치되는 항목엔 moduleName/
      // moduleEnabled 를 붙이고, 매치 안 되는 인벤토리 엔트리는 새 항목으로 push. 인벤토리 fetch
      // 실패(inv=null/undefined)는 no-op — 프로바이더 목록 자체는 항상 정상 렌더(§ fetchProviders
      // 의 기존 격리 원칙과 동형).
      /**
       * 인벤토리 행이 들고 오는 **판정 플래그** — 매치·합성 **두 경로가 같은 것**을 쓴다.
       *
       * ★사고(2026-08-30, 적대 검토 B조 P-1): 두 경로가 필드를 **각자 손으로 베꼈고**,
       *  `selfReferential` 을 매치 경로에만 넣었다. 그런데 `dashboard` 는 프로바이더와
       *  매치되지 않아 **반드시 합성 경로로** 그려진다 — 그래서 대시보드를 끌 때 뜨던
       *  확인창이 **조용히 사라졌다.** 손 목록을 선언으로 바꾸면서 돌던 안전장치를 깬 것이다.
       *  베끼는 자리가 둘이면 반드시 갈린다.
       */
      const moduleFlagsOf = (e) => ({
        ...(e.core === true ? { core: true } : {}),
        ...(e.selfReferential === true ? { selfReferential: true } : {}),
      });

      const mergeInventoryModuleInfo = (list, inv) => {
        if (!inv) return list;
        const invIndex = new Map();
        for (const e of [...(inv.channel || []), ...(inv.external_plugin || [])]) {
          if (typeof e.name === "string" && e.name !== "") invIndex.set(normModuleKey(e.name), e);
        }
        const seen = new Set();
        for (const item of list) {
          const match = findInventoryMatch(item, invIndex);
          if (match) {
            item.moduleName = match.name;
            item.moduleEnabled = match.enabled;
            Object.assign(item, moduleFlagsOf(match));
            seen.add(normModuleKey(match.name));
          }
        }
        const synthesize = (entries, kind) => {
          for (const e of entries || []) {
            if (typeof e.name !== "string" || e.name === "") continue;
            const key = normModuleKey(e.name);
            if (seen.has(key)) continue;
            seen.add(key);
            const kindHint = e.metadata && typeof e.metadata.kind === "string" ? e.metadata.kind : "";
            list.push({
              id: kind + "." + e.name,
              kind,
              name: e.name,
              status: e.enabled ? "active" : "inactive",
              summary: [e.description, kindHint].filter(Boolean).join(" · ") || i18n("modules.group.bundled"),
              capabilities: [],
              views: [],
              actions: [],
              moduleName: e.name,
              moduleEnabled: e.enabled,
              ...moduleFlagsOf(e),
            });
          }
        };
        // 인벤토리 channel 카테고리 → 기존 "채널" 그룹으로, external_plugin → 기존 "플러그인" 그룹으로.
        synthesize(inv.channel, "channel");
        synthesize(inv.external_plugin, "plugin");
        return list;
      };

      const setModuleEnabledRequest = async (name, enabled) => {
        const r = await fetch("/api/set-module-enabled", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, enabled }),
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.error || "HTTP " + r.status);
        return data;
      };

      const onModuleToggleClick = async (provider, btn) => {
        const nextEnabled = !provider.moduleEnabled;
        // ★손 목록이 아니라 **서버가 보낸 선언**을 본다 (2026-08-30, B-2). 사본이 두 벌
        //  있었고 둘 다 플러그인 화면엔 없었다 — 그래서 그쪽 문은 무방비였다.
        if (!nextEnabled && provider.selfReferential === true) {
          const proceed = window.confirm(
            i18n("modules.disable.confirm"),
          );
          if (!proceed) return; // 취소 → no-op(파괴적-행위 소프트 게이트).
        }
        btn.disabled = true;
        try {
          const data = await setModuleEnabledRequest(provider.moduleName, nextEnabled);
          showToast(
            i18n(nextEnabled ? "modules.toggled.on" : "modules.toggled.off", {
              name: provider.moduleName,
              critical: data.warning === "critical" ? i18n("modules.toggle.critical") : "",
            }),
            data.warning === "critical" ? "warn" : "good",
          );
          await fetchProviders(); // 재조회 → 버튼 라벨/배지가 새 enabled 값으로 갱신.
        } catch (e) {
          showToast(i18n("modules.toggleFailed", { err: e.message }), "bad");
          btn.disabled = false;
        }
      };

      const renderModuleToggleControls = (provider) => {
        const wrap = document.createElement("div");
        wrap.className = "module-toggle-row";
        if (provider.moduleEnabled === false) {
          const badge = document.createElement("span");
          badge.className = "module-disabled-badge";
          badge.textContent = i18n("modules.status.disabledPending");
          wrap.appendChild(badge);
        }
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "module-toggle-btn" + (provider.moduleEnabled === false ? " is-off" : "");
        btn.textContent = provider.moduleEnabled === false ? i18n("modules.enable") : i18n("modules.disable");
        btn.addEventListener("click", () => onModuleToggleClick(provider, btn));
        wrap.appendChild(btn);
        const hint = document.createElement("div");
        hint.className = "module-toggle-hint";
        hint.textContent = i18n("modules.toggle.note");
        wrap.appendChild(hint);
        return wrap;
      };

      const renderProviderListItem = (provider) => {
        const status = provider.status || "unknown";
        const item = document.createElement("div");
        item.className = "provider-item s-" + status + (provider.id === selectedProviderId ? " selected" : "");
        item.dataset.id = provider.id;
        item.dataset.searchText = [resolveText(provider.name), provider.id, kindLabel(provider.kind), resolveText(provider.summary)]
          .filter(Boolean).join(" ").toLowerCase();
        const head = document.createElement("div");
        head.className = "pi-head";
        const name = document.createElement("span");
        name.className = "pi-name"; name.textContent = resolveText(provider.name) || provider.id;
        const kind = document.createElement("span");
        kind.className = "pi-kind"; kind.textContent = kindLabel(provider.kind);
        const dot = document.createElement("span");
        dot.className = "pi-status-dot " + status;
        dot.title = status;
        head.appendChild(name); head.appendChild(kind); head.appendChild(dot);
        item.appendChild(head);
        {
          // 서버는 값·스펙만 보낸다 — 문장은 resolveText 가 만든다(util.js 주석 참조).
          const summaryText = resolveText(provider.summary);
          if (summaryText !== "") {
            const summary = document.createElement("div");
            summary.className = "pi-summary";
            summary.textContent = summaryText;
            item.appendChild(summary);
          }
        }
        // 서브 리스트에도 비활성 상태 표시(디테일 패널과 동일 뱃지, §4 — "가능하면 서브 리스트도").
        if (provider.moduleName && provider.moduleEnabled === false) {
          const badge = document.createElement("span");
          badge.className = "module-disabled-badge module-disabled-badge-sm";
          badge.textContent = i18n("modules.status.disabledPending");
          item.appendChild(badge);
        }
        item.addEventListener("click", () => selectProvider(provider.id, { userClick: true }));
        return item;
      };

      const showProviders = () => {
        setActiveNav("providers");
        setChatPanel("chat");
        // §5: 모듈 리스트 서브패널을 디테일과 나란히 노출(다른 뷰는 이 클래스를 안 붙여 detail-panel
        // 단일 컬럼 그대로 — 회귀 없음).
        document.getElementById("workbench").classList.remove("show-capabilities");
        document.getElementById("workbench").classList.add("show-providers");
        if (!selectedProviderId && providersCache.length > 0) selectedProviderId = providersCache[0].id;
        renderProviderHub();
      };

      const renderProviderDetailCard = (provider) => {
        const shell = document.createElement("section");
        shell.className = "subpanel detail-card";
        if (!provider) {
          shell.innerHTML = '<div class="subpanel-head"><div><h2 class="subpanel-title"></h2>' +
            '<p class="subpanel-desc"></p></div></div><div class="empty"></div>';
          shell.querySelector(".subpanel-title").textContent = i18n("stream.detail");
          shell.querySelector(".subpanel-desc").textContent = i18n("modules.detail.pickOne");
          shell.querySelector(".empty").textContent = i18n("modules.detail.none");
          return shell;
        }
        const status = provider.status || "unknown";
        const summaryGrid = document.createElement("div");
        summaryGrid.className = "summary-grid";
        const metricData = [
          [i18n("common.status"), statusLabel(status), resolveText(provider.summary) || i18n("common.moduleStatus")],
          [i18n("tab.view"), String((provider.views || []).length), i18n("modules.panels.head")],
          [i18n("common.task"), String((provider.actions || []).length), i18n("modules.cap.callable")],
        ];
        for (const [label, value, hint] of metricData) {
          const card = document.createElement("div");
          card.className = "summary-card";
          card.innerHTML = '<div class="summary-label">' + escHtml(label) + '</div><div class="summary-value">' + escHtml(value) + '</div><div class="summary-hint">' + escHtml(hint) + '</div>';
          summaryGrid.appendChild(card);
        }
        const head = document.createElement("div");
        head.className = "detail-head";
        head.innerHTML = '<div class="detail-accent ' + escHtml(status) + '"></div><div><div class="detail-name">' + escHtml(resolveText(provider.name) || provider.id) + '</div><div class="detail-summary" style="margin:4px 0 0">' + escHtml(resolveText(provider.summary) || i18n("common.moduleStatus")) + '</div></div><span class="detail-kind">' + escHtml(kindLabel(provider.kind)) + '</span><span class="detail-status ' + escHtml(status) + '">' + escHtml(statusLabel(status)) + '</span>';
        shell.appendChild(head);
        // 모듈 활성/비활성 토글(P4a-2) — moduleName 이 해석된(=인벤토리에서 이름이 발견된) 항목만.
        // 코어 프로바이더(daemon/memory/schedule/plugin-registry)는 moduleName 이 없어 토글이
        // 자연히 안 붙는다(가드1, 코드 분기 없이 유지).
        // ★코어 모듈은 토글을 그리지 않는다 — 끄기 대상이 아니다(서버도 거절한다).
        if (provider.moduleName && provider.core !== true) {
          shell.appendChild(renderModuleToggleControls(provider));
        }
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
          viewsWrap.appendChild(renderProviderView({ title: i18n("common.task"), kind: "action-panel", data: { actions: provider.actions } }));
        }
        if (views.length === 0 && (provider.actions || []).length === 0) {
          const e = document.createElement("div");
          e.className = "empty";
          e.textContent = i18n("modules.panels.empty");
          viewsWrap.appendChild(e);
        }
        shell.appendChild(viewsWrap);
        return shell;
      };

      // 디테일 패널 = 선택된 모듈 하나만(§5 3패널 — 리스트는 이제 #providers-list 서브패널이 전담,
      // 여기선 더 이상 목록을 함께 그리지 않는다). isCoreProvider/coreProviders 분기는 그룹 리스트로
      // 이관되어 여기선 불필요.
      const renderProviderHub = () => {
        const root = document.getElementById("detail-panel");
        root.innerHTML = "";
        const selected = providersCache.find((p) => p.id === selectedProviderId) || providersCache[0] || null;
        if (selected && !selectedProviderId) selectedProviderId = selected.id;
        root.appendChild(renderProviderDetailCard(selected));
      };

      const selectProvider = (id, opts) => {
        selectedProviderId = id;
        for (const child of document.querySelectorAll("#providers-list .provider-item")) {
          child.classList.toggle("selected", child.dataset.id === id);
        }
        // 리스트는 #providers-panel 이 보일 때만(모듈 뷰) 클릭 가능하므로 항상 detail-panel 렌더로
        // 충분 — currentView 분기(옛 renderDetail 폴백)는 도달 불가라 제거.
        renderProviderHub();
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

      // 모듈 리스트 서브패널(§5) — kind 로 그룹핑해 렌더. 선택(nextId)은 항목 생성 "전"에 정해서
      // 각 provider-item 이 처음부터 정확한 selected 클래스를 갖도록 한다(2차 DOM 패스 불필요).
      const renderProviders = (registry) => {
        const list = document.getElementById("providers-list");
        const countEl = document.getElementById("providers-count");
        list.innerHTML = "";
        const providers = registry.providers || [];
        providersCache = providers;
        countEl.textContent = i18n("home.stat.count", { n: providers.length });
        const navCount = document.getElementById("nav-provider-count");
        if (navCount) navCount.textContent = String(providers.length);
        if (providers.length === 0) {
          selectedProviderId = null;
          const e = document.createElement("div");
          e.className = "empty"; e.style.margin = "8px";
          e.textContent = i18n("modules.empty");
          list.appendChild(e);
          if (currentView === "providers") renderProviderHub();
          return;
        }
        // 선택 유지 (이전 선택 → URL hash → 첫번째)
        let nextId = selectedProviderId;
        if (!nextId) {
          const hash = (window.location.hash || "").match(/provider=([^&]+)/);
          if (hash) nextId = decodeURIComponent(hash[1]);
        }
        if (!nextId || !providers.some((p) => p.id === nextId)) {
          nextId = providers[0].id;
        }
        selectedProviderId = nextId;
        const groups = groupProvidersByKind(providers);
        for (const group of groups) {
          appendCollapsibleGroup(list, "mod-collapse", group.kind, group.label, group.items.length, (itemsWrap) => {
            for (const provider of group.items) itemsWrap.appendChild(renderProviderListItem(provider));
          });
        }
        // 검색어(있다면) 재적용 — 30s 폴 재렌더로 리스트가 통째로 재구성돼도 입력값 자체는
        // #providers-search(list 밖) 라 안 사라지지만, DOM 클래스(search-hidden 등)는 새로 만든
        // 노드에 없으므로 여기서 한 번 더 걸어준다(빈 문자열이면 no-op).
        const searchInput = document.getElementById("providers-search");
        applyListSearchFilter(list, searchInput ? searchInput.value : "");
        if (currentView === "providers") renderProviderHub();
        else if (currentView === "overview") showOverview();
      };

      const providersSearchInput = document.getElementById("providers-search");
      if (providersSearchInput) {
        providersSearchInput.addEventListener("input", () => {
          applyListSearchFilter(document.getElementById("providers-list"), providersSearchInput.value);
        });
      }

      const fetchProviders = async () => {
        // 채널은 보조 데이터 — /api/channels 가 실패해도 프로바이더 목록 자체는 정상 렌더한다
        // (내부 catch 로 항상 resolve, Promise.all 이 providers 실패에만 반응).
        const providersPromise = fetch("/api/providers").then((r) => {
          if (!r.ok) throw new Error("HTTP " + r.status);
          return r.json();
        });
        const channelsPromise = fetch("/api/channels")
          .then((r) => (r.ok ? r.json() : { channels: [] }))
          .catch(() => ({ channels: [] }));
        // 모듈 활성/비활성(P4a-2) — 인벤토리도 보조 데이터, 실패해도 프로바이더 목록은 정상
        // 렌더(토글 정보만 빠짐, mergeInventoryModuleInfo 가 inv=null 이면 no-op).
        const inventoryPromise = fetch("/api/inventory")
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null);
        try {
          const [providerRegistry, channelData, inv] = await Promise.all([
            providersPromise,
            channelsPromise,
            inventoryPromise,
          ]);
          const providers = Array.isArray(providerRegistry.providers) ? providerRegistry.providers : [];
          const channels = Array.isArray(channelData.channels) ? channelData.channels : [];
          if (inv) inventoryCache = inv; // 능력 뷰(view-inventory.js)와 공유 캐시(util.js 선언) — 재사용.
          const merged = mergeProvidersAndChannels(providers, channels);
          mergeInventoryModuleInfo(merged, inv);
          renderProviders({ providers: merged });
        } catch (e) {
          const list = document.getElementById("providers-list");
          list.innerHTML = "";
          const div = document.createElement("div");
          div.className = "empty"; div.style.margin = "8px";
          div.textContent = i18n("modules.loadFailed", { err: e.message });
          list.appendChild(div);
        }
      };

