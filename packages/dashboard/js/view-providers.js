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
        const bits = [status === "inactive" ? "비활성 채널" : "라이브 채널"];
        if (c.canDeliver) bits.push("발신 가능");
        return {
          id: "channel." + (c.name || "unknown"),
          kind: "channel",
          name: c.name || "(이름 없음)",
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
          if (typeof p.name === "string") seen.add(p.name.toLowerCase());
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

      // 백엔드 CRITICAL_MODULE_NAMES 미러(plugins/http-bridge/index.ts) — 비활성화 클릭 시 *POST
      // 전* 확인 게이트용(파괴적-행위 소프트 게이트, feedback_destructive_actions_soft_enforcement:
      // 막지 않되 명시 확인). 서버가 이후에도 warning:"critical" 을 실어주면(이 미러가 드리프트된
      // 경우 대비) 성공 토스트에서 추가로 강조한다 — 이중 방어, 프런트가 막지는 않음.
      const CRITICAL_MODULE_NAMES = new Set(["dashboard", "http-bridge"]);

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
              summary: [e.description, kindHint].filter(Boolean).join(" · ") || "번들 플러그인",
              capabilities: [],
              views: [],
              actions: [],
              moduleName: e.name,
              moduleEnabled: e.enabled,
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
        if (!nextEnabled && CRITICAL_MODULE_NAMES.has(provider.moduleName)) {
          const proceed = window.confirm(
            "이 모듈을 끄면 대시보드/브리지 접근을 잃을 수 있습니다. 계속할까요?",
          );
          if (!proceed) return; // 취소 → no-op(파괴적-행위 소프트 게이트).
        }
        btn.disabled = true;
        try {
          const data = await setModuleEnabledRequest(provider.moduleName, nextEnabled);
          showToast(
            (nextEnabled ? "활성화됨: " : "비활성화됨: ") + provider.moduleName +
              " — 재시작 시 적용됩니다." + (data.warning === "critical" ? " (핵심 모듈)" : ""),
            data.warning === "critical" ? "warn" : "good",
          );
          await fetchProviders(); // 재조회 → 버튼 라벨/배지가 새 enabled 값으로 갱신.
        } catch (e) {
          showToast("모듈 전환 실패: " + e.message, "bad");
          btn.disabled = false;
        }
      };

      const renderModuleToggleControls = (provider) => {
        const wrap = document.createElement("div");
        wrap.className = "module-toggle-row";
        if (provider.moduleEnabled === false) {
          const badge = document.createElement("span");
          badge.className = "module-disabled-badge";
          badge.textContent = "비활성 · 재시작 시 적용";
          wrap.appendChild(badge);
        }
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "module-toggle-btn" + (provider.moduleEnabled === false ? " is-off" : "");
        btn.textContent = provider.moduleEnabled === false ? "활성화" : "비활성화";
        btn.addEventListener("click", () => onModuleToggleClick(provider, btn));
        wrap.appendChild(btn);
        const hint = document.createElement("div");
        hint.className = "module-toggle-hint";
        hint.textContent = "MVP: 재시작 시 적용됩니다(핫 토글 아님).";
        wrap.appendChild(hint);
        return wrap;
      };

      const renderProviderListItem = (provider) => {
        const status = provider.status || "unknown";
        const item = document.createElement("div");
        item.className = "provider-item s-" + status + (provider.id === selectedProviderId ? " selected" : "");
        item.dataset.id = provider.id;
        item.dataset.searchText = [provider.name, provider.id, kindLabel(provider.kind), provider.summary]
          .filter(Boolean).join(" ").toLowerCase();
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
        // 서브 리스트에도 비활성 상태 표시(디테일 패널과 동일 뱃지, §4 — "가능하면 서브 리스트도").
        if (provider.moduleName && provider.moduleEnabled === false) {
          const badge = document.createElement("span");
          badge.className = "module-disabled-badge module-disabled-badge-sm";
          badge.textContent = "비활성 · 재시작 시 적용";
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
          shell.innerHTML = '<div class="subpanel-head"><div><h2 class="subpanel-title">상세</h2><p class="subpanel-desc">왼쪽 카드에서 모듈을 선택하세요.</p></div></div><div class="empty">선택된 모듈이 없습니다.</div>';
          return shell;
        }
        const status = provider.status || "unknown";
        const summaryGrid = document.createElement("div");
        summaryGrid.className = "summary-grid";
        const metricData = [
          ["상태", statusLabel(status), provider.summary || "모듈 상태"],
          ["화면", String((provider.views || []).length), "사용 가능한 패널"],
          ["작업", String((provider.actions || []).length), "호출 가능한 기능"],
        ];
        for (const [label, value, hint] of metricData) {
          const card = document.createElement("div");
          card.className = "summary-card";
          card.innerHTML = '<div class="summary-label">' + escHtml(label) + '</div><div class="summary-value">' + escHtml(value) + '</div><div class="summary-hint">' + escHtml(hint) + '</div>';
          summaryGrid.appendChild(card);
        }
        const head = document.createElement("div");
        head.className = "detail-head";
        head.innerHTML = '<div class="detail-accent ' + escHtml(status) + '"></div><div><div class="detail-name">' + escHtml(provider.name || provider.id) + '</div><div class="detail-summary" style="margin:4px 0 0">' + escHtml(provider.summary || "모듈 상태") + '</div></div><span class="detail-kind">' + escHtml(kindLabel(provider.kind)) + '</span><span class="detail-status ' + escHtml(status) + '">' + escHtml(statusLabel(status)) + '</span>';
        shell.appendChild(head);
        // 모듈 활성/비활성 토글(P4a-2) — moduleName 이 해석된(=인벤토리에서 이름이 발견된) 항목만.
        // 코어 프로바이더(daemon/memory/schedule/plugin-registry)는 moduleName 이 없어 토글이
        // 자연히 안 붙는다(가드1, 코드 분기 없이 유지).
        if (provider.moduleName) shell.appendChild(renderModuleToggleControls(provider));
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
        countEl.textContent = providers.length + "개";
        const navCount = document.getElementById("nav-provider-count");
        if (navCount) navCount.textContent = String(providers.length);
        if (providers.length === 0) {
          selectedProviderId = null;
          const e = document.createElement("div");
          e.className = "empty"; e.style.margin = "8px";
          e.textContent = "모듈이 없습니다.";
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
          div.textContent = "불러오기 실패: " + e.message;
          list.appendChild(div);
        }
      };

