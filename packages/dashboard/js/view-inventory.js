      // ── 능력 뷰(ADR 2026-07-17 §5·§7 P2, ←"런타임 인벤토리" 리네임) ──────────────────────────
      // 축B(데이터) = 스킬·에이전트(명세)·커맨드·메모리(§2). 모듈(코드축, view-providers.js)과
      // 명확히 분리 — /api/inventory 가 아직 주는 channel·external_plugin 카테고리는 모듈 축이라
      // 여기서는 노출하지 않는다(모듈 뷰가 이미 channel 을 흡수해 보여줌, §5 "능력…모듈과 명확히
      // 분리(중복 걱정 해소)"). mcp 카테고리는 "능력이 호출 가능한 도구/명령" 이라 커맨드 그룹에
      // 매핑 — 슬래시 커맨드 자체(/api/commands)는 이 슬라이스 범위 밖(★파일 제약: /api/inventory
      // 만 소비). "메모리" 그룹은 현재 엔드포인트에 대응 카테고리가 없어 항상 빈 안내로 렌더(§8.2
      // 오픈이슈 — 데이터 소스 생기면 CAPABILITY_GROUPS 에 srcKey 만 추가하면 자동 편입).
      //
      // 3패널(모듈 뷰와 동형, P1/P2 재사용) — 리스트 서브패널(#capabilities-list)은 provider-item/
      // pi-*/module-group-* 클래스를 그대로 재사용(시각 동형), 디테일은 renderProviderDetailCard 와
      // 같은 결의 renderCapabilityDetailCard 로 메타(설명·경로·layer·enabled·metadata) 를 kv 로
      // 렌더 — 읽기 전용(편집은 대화로, 모델 프로파일·모듈과 동형). 풀 명세 본문(스킬 SKILL.md/
      // 에이전트 .md 전문)은 /api/inventory 에 없어 이 슬라이스 범위 밖 — 디테일에 안내 문구만.

      const CAP_LAYER_LABEL = { meta_infra: "메타 인프라", in_tree: "in-tree", discovered: "발견됨" };

      const CAPABILITY_GROUPS = [
        { key: "skill", srcKey: "skill", label: "🛠️ 스킬", emptyNote: null },
        { key: "agent", srcKey: "agent", label: "🤖 에이전트", emptyNote: null },
        { key: "mcp", srcKey: "mcp", label: "🧩 도구 (MCP)", emptyNote: null },
        // 커맨드 = 슬래시 명령 모음(빌트인 /models·/update … + 유저 <home>/commands/*.md).
        // /api/inventory 가 command[] 를 주므로 srcKey 만 추가(엔드포인트와 동형, 신규 렌더코드 0).
        { key: "command", srcKey: "command", label: "⌨️ 커맨드", emptyNote: null },
        // P4c(ADR 2026-07-17 § 2축모델) — 엔드포인트(<home>/endpoints/*.md, 슬래시 명령의
        // HTTP 판)도 능력(데이터) 축. /api/inventory 가 endpoint[] 를 주므로 srcKey 만 추가
        // — 정의 0건 홈은 빈 카테고리 자동 숨김(위 렌더 로직, 신규 코드 0).
        { key: "endpoint", srcKey: "endpoint", label: "🔌 엔드포인트", emptyNote: null },
        // 스케줄(cron/reboot 트리거) — /api/inventory 가 schedules[] 를 주므로 srcKey 만 추가
        // (엔드포인트와 동형, 신규 렌더코드 0). 스케줄 아이템은 layer 없음 → renderCapabilityListItem
        // 의 pi-kind 는 빈 문자열 폴백(entry.layer || ""), 정렬은 LAYERS.indexOf(-1)→99 로 안전.
        // 읽기 전용(디테일은 제네릭 renderCapabilityDetailCard). 스케줄 0건 홈은 빈 카테고리 자동 숨김.
        { key: "schedules", srcKey: "schedules", label: "⏰ 스케줄", emptyNote: null },
        // 훅(settings.json hooks[event], daemon-engineer PROJECT.md 2026-07-24) — 채널·
        // 플러그인·스킬과 동형 1급 능력. /api/inventory 가 hook[] 을 주므로 srcKey 만 추가
        // (스케줄과 동형, 신규 렌더코드 0). 0건 홈은 빈 카테고리 자동 숨김.
        { key: "hook", srcKey: "hook", label: "🪝 훅", emptyNote: null },
        {
          key: "memory",
          srcKey: null,
          label: "💭 메모리",
          emptyNote: "메모리 항목은 아직 이 화면에 연동되지 않았습니다 — 대화로 확인하세요(예: \"기억나는 거 있어?\").",
        },
      ];

      let capabilitiesCache = []; // 평탄화 [{id, entry, group}] — 클릭 선택·디테일 조회용.
      let selectedCapabilityId = null;

      const capabilityDescription = (entry) => {
        // 설명 — description(frontmatter/manifest). MCP 는 없으면 command/url.
        let desc = entry.description || "";
        if (!desc && entry.category === "mcp") {
          const md = entry.metadata || {};
          desc = md.url || (md.command ? md.command + (Array.isArray(md.args) && md.args.length ? " " + md.args.join(" ") : "") : "");
        }
        return desc;
      };

      const renderCapabilityListItem = (id, entry, group) => {
        const enabled = entry.enabled !== false;
        const item = document.createElement("div");
        item.className = "provider-item" + (enabled ? " s-active" : "") + (id === selectedCapabilityId ? " selected" : "");
        item.dataset.id = id;
        const head = document.createElement("div");
        head.className = "pi-head";
        const name = document.createElement("span");
        name.className = "pi-name"; name.textContent = entry.name || "?"; name.title = entry.name || "";
        const kind = document.createElement("span");
        kind.className = "pi-kind"; kind.textContent = CAP_LAYER_LABEL[entry.layer] || entry.layer || "";
        const dot = document.createElement("span");
        dot.className = "pi-status-dot" + (enabled ? " active" : "");
        dot.title = enabled ? "활성" : "비활성";
        head.appendChild(name); head.appendChild(kind); head.appendChild(dot);
        item.appendChild(head);
        const desc = capabilityDescription(entry);
        item.dataset.searchText = [entry.name, group.label, CAP_LAYER_LABEL[entry.layer] || entry.layer, desc]
          .filter(Boolean).join(" ").toLowerCase();
        if (desc) {
          const summary = document.createElement("div");
          summary.className = "pi-summary"; summary.textContent = desc;
          item.appendChild(summary);
        }
        item.addEventListener("click", () => selectCapability(id, { userClick: true }));
        return item;
      };

      const updateCapabilityNavCount = (inv) => {
        const total = CAPABILITY_GROUPS.reduce(
          (sum, g) => sum + (g.srcKey ? (inv[g.srcKey] || []).length : 0),
          0,
        );
        const el = document.getElementById("nav-capability-count");
        if (el) el.textContent = String(total);
      };

      const renderInventory = (inv) => {
        inventoryCache = inv;
        renderContextTags(); // 스킬·에이전트 로드됨 → 태그 해석/미해석 구분 갱신.
        const list = document.getElementById("capabilities-list");
        if (!list) return;
        // ★30s 폴 재렌더가 선택·스크롤을 초기화하던 인벤토리 시절 버그와 동일 픽스 — 렌더 대상
        // 데이터(그룹 srcKey 들)만으로 sig 계산, 무변 시 리스트 DOM 재구성 스킵.
        const sig = JSON.stringify(CAPABILITY_GROUPS.map((g) => (g.srcKey ? inv[g.srcKey] || [] : [])));
        if (list.dataset.sig === sig && list.childElementCount > 0) {
          updateCapabilityNavCount(inv);
          return;
        }
        list.dataset.sig = sig;
        list.innerHTML = "";
        capabilitiesCache = [];
        // 그룹 헤더+아이템 컨테이너는 js/util.js appendCollapsibleGroup(모듈 뷰와 공유, ADR §5
        // 마스터-디테일 통일) — 빈 그룹도 emptyNote 를 itemsWrap 안에 넣어 헤더/아이템쌍 구조를
        // 통일한다(applyListSearchFilter 가 header.nextElementSibling 을 itemsWrap 으로 가정).
        for (const group of CAPABILITY_GROUPS) {
          const items = group.srcKey ? inv[group.srcKey] || [] : [];
          if (items.length === 0) continue; // 빈 카테고리는 숨긴다(존재하지 않는 그룹 미표시, 2026-07-17).
          const sorted = items.slice().sort((a, b) => {
            const la = LAYERS.indexOf(a.layer); const lb = LAYERS.indexOf(b.layer);
            return (la === -1 ? 99 : la) - (lb === -1 ? 99 : lb);
          });
          appendCollapsibleGroup(list, "cap-collapse", group.key, group.label, sorted.length, (itemsWrap) => {
            for (const entry of sorted) {
              const id = group.key + ":" + entry.name;
              capabilitiesCache.push({ id, entry, group });
              itemsWrap.appendChild(renderCapabilityListItem(id, entry, group));
            }
          });
        }
        if (list.childElementCount === 0) {
          list.innerHTML = '<div class="empty" style="margin:10px">표시할 능력이 없습니다.</div>';
        }
        updateCapabilityNavCount(inv);
        if (!selectedCapabilityId && capabilitiesCache.length > 0) {
          selectedCapabilityId = capabilitiesCache[0].id;
        } else if (selectedCapabilityId && !capabilitiesCache.some((c) => c.id === selectedCapabilityId)) {
          selectedCapabilityId = capabilitiesCache.length > 0 ? capabilitiesCache[0].id : null;
        }
        for (const child of list.querySelectorAll(".provider-item")) {
          child.classList.toggle("selected", child.dataset.id === selectedCapabilityId);
        }
        // 검색어 재적용 — sig 가 바뀌어 리스트가 실제로 재구성된 경우만 여기 도달(sig 불변 early
        // return 은 위에서 이미 처리돼 기존 DOM 의 필터 상태가 그대로 유지됨).
        const capSearchInput = document.getElementById("capabilities-search");
        applyListSearchFilter(list, capSearchInput ? capSearchInput.value : "");
        if (currentView === "inventory") renderCapabilityHub();
      };

      const capabilitiesSearchInput = document.getElementById("capabilities-search");
      if (capabilitiesSearchInput) {
        capabilitiesSearchInput.addEventListener("input", () => {
          applyListSearchFilter(document.getElementById("capabilities-list"), capabilitiesSearchInput.value);
        });
      }

      const renderCapabilityDetailCard = (item) => {
        const shell = document.createElement("section");
        shell.className = "subpanel detail-card";
        if (!item) {
          shell.innerHTML = '<div class="subpanel-head"><div><h2 class="subpanel-title">상세</h2><p class="subpanel-desc">왼쪽에서 능력 항목을 선택하세요.</p></div></div><div class="empty">선택된 항목이 없습니다.</div>';
          return shell;
        }
        const { entry, group } = item;
        const enabled = entry.enabled !== false;
        const status = enabled ? "active" : "inactive";
        const summaryGrid = document.createElement("div");
        summaryGrid.className = "summary-grid";
        const metricData = [
          ["카테고리", group.label, "능력 그룹"],
          ["레이어", CAP_LAYER_LABEL[entry.layer] || entry.layer || "-", "발견 위치"],
          ["상태", enabled ? "활성" : "비활성", "enabled 플래그"],
        ];
        for (const [label, value, hint] of metricData) {
          const card = document.createElement("div");
          card.className = "summary-card";
          card.innerHTML = '<div class="summary-label">' + label + '</div><div class="summary-value">' + value + '</div><div class="summary-hint">' + hint + '</div>';
          summaryGrid.appendChild(card);
        }
        const desc = capabilityDescription(entry);
        const head = document.createElement("div");
        head.className = "detail-head";
        head.innerHTML = '<div class="detail-accent ' + status + '"></div><div><div class="detail-name">' + (entry.name || "?") + '</div><div class="detail-summary" style="margin:4px 0 0">' + (desc || "설명 없음") + '</div></div><span class="detail-kind">' + group.label + '</span><span class="detail-status ' + status + '">' + (enabled ? "활성" : "비활성") + '</span>';
        shell.appendChild(head);
        shell.appendChild(summaryGrid);
        // 메타(경로+metadata 원문) — 모듈 상세와 같은 kv 그리드로.
        const meta = {};
        if (entry.source) meta["경로"] = entry.source;
        const md = entry.metadata || {};
        for (const k of Object.keys(md)) meta[k] = md[k];
        if (Object.keys(meta).length > 0) {
          const viewsWrap = document.createElement("div");
          viewsWrap.className = "views";
          const view = document.createElement("div");
          view.className = "view";
          const title = document.createElement("div");
          title.className = "view-title"; title.textContent = "메타데이터";
          view.appendChild(title);
          appendKv(view, meta);
          viewsWrap.appendChild(view);
          shell.appendChild(viewsWrap);
        }
        // ★MCP 서버는 "제공 도구"를 펼쳐 보여준다 (2026-07-29 사용자 요청). 종전엔 메타데이터
        //  kv 에 이름만 한 줄로 나열돼 눌러도 더 볼 게 없었다. 여기서 실제 서버에 물어본
        //  결과(설명·파라미터)를 렌더한다 — 지연 조회라 이 항목을 열 때만 요청이 나간다.
        if (entry.category === "mcp") {
          const capturedMcpId = item.id;
          const sec = document.createElement("div");
          sec.className = "views";
          const v = document.createElement("div");
          v.className = "view";
          const t = document.createElement("div");
          t.className = "view-title"; t.textContent = "제공 도구";
          const body = document.createElement("div");
          body.textContent = "불러오는 중…";
          v.appendChild(t); v.appendChild(body); sec.appendChild(v); shell.appendChild(sec);
          fetch("/api/mcp-tools?name=" + encodeURIComponent(entry.name || ""))
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status))))
            .then((d) => {
              if (selectedCapabilityId !== capturedMcpId) return; // 그 사이 선택이 바뀜 — 스테일 무시.
              const tools = Array.isArray(d.tools) ? d.tools : [];
              body.textContent = "";
              if (tools.length === 0) {
                body.className = "developer-copy";
                body.textContent = d.note || "노출된 도구가 없습니다.";
                return;
              }
              for (const tool of tools) {
                const row = document.createElement("div");
                row.className = "provider-item s-active";
                const h = document.createElement("div");
                h.className = "pi-head";
                const nm = document.createElement("span");
                nm.className = "pi-name"; nm.textContent = tool.name || "?";
                h.appendChild(nm);
                if (Array.isArray(tool.params) && tool.params.length > 0) {
                  const kd = document.createElement("span");
                  kd.className = "pi-kind";
                  // 필수 인자는 * 로 구분 — 호출 형태를 한 줄로 가늠하게.
                  kd.textContent = tool.params
                    .map((k) => ((tool.required || []).includes(k) ? k + "*" : k))
                    .join(", ");
                  h.appendChild(kd);
                }
                row.appendChild(h);
                if (tool.description) {
                  const ds = document.createElement("div");
                  ds.className = "pi-summary"; ds.textContent = tool.description;
                  row.appendChild(ds);
                }
                body.appendChild(row);
              }
            })
            .catch(() => {
              if (selectedCapabilityId !== capturedMcpId) return;
              body.className = "developer-copy";
              body.textContent = "도구 목록을 불러오지 못했습니다.";
            });
        }
        const note = document.createElement("p");
        note.className = "developer-copy";
        note.textContent = entry.source
          ? "전체 정의 본문(스킬/에이전트 전문)은 위 경로의 파일에서 확인할 수 있습니다 — 이 화면은 메타 정보까지만 보여줍니다(읽기 전용, 편집은 대화로)."
          : "이 항목은 메타 정보만 보여줍니다(읽기 전용, 편집은 대화로).";
        shell.appendChild(note);

        // 정의 본문(파일 source) — bridge GET /api/inventory-item?source= 로 파일을 재-Read 해
        // 마크다운 렌더(view-projects.js:396 의 renderMarkdown+`.md` 패턴 재사용, 읽기 전용).
        // 공용 카드라 인벤토리·모듈·모델프로파일 상세 전부 자동 적용 — 파일 source 없는 항목
        // (in-process:/builtin:/schedule: 또는 source 부재)은 fetch 스킵, 위 안내 유지(회귀 0).
        // 실패(403 allowlist 거부·404 부재·네트워크)도 안내 유지(graceful). 선택이 바뀌면 스테일
        // 응답 무시. 로딩/성공 시에만 본문 섹션이 뜨고, 성공하면 안내 문구는 제거(본문이 대체).
        const src = entry.source || "";
        const isFileSource = src !== "" && !/^(in-process|builtin|schedule):/.test(src);
        if (isFileSource) {
          const capturedId = item.id;
          const bodySec = document.createElement("div");
          bodySec.className = "views";
          const view = document.createElement("div");
          view.className = "view";
          const title = document.createElement("div");
          title.className = "view-title"; title.textContent = "정의 본문";
          const bodyInner = document.createElement("div");
          bodyInner.className = "cap-body-inner";
          bodyInner.style.maxHeight = "50vh";
          bodyInner.style.overflowY = "auto";
          bodyInner.textContent = "본문 불러오는 중…";
          view.appendChild(title);
          view.appendChild(bodyInner);
          bodySec.appendChild(view);
          shell.appendChild(bodySec);
          (async () => {
            try {
              const r = await fetch("/api/inventory-item?source=" + encodeURIComponent(src));
              if (!r.ok) throw new Error("HTTP " + r.status);
              const data = await r.json();
              const body = (data && typeof data.body === "string") ? data.body : "";
              // 선택이 바뀌었거나(스테일) 카드가 떨어져나갔으면 무시.
              if (!bodyInner.isConnected || selectedCapabilityId !== capturedId) return;
              if (body.trim() === "") { bodySec.remove(); return; } // 빈 본문 — 안내 유지.
              note.remove(); // 실제 본문을 보여주므로 "파일에서 확인" 안내 제거.
              if (typeof window.marked !== "undefined") {
                try {
                  bodyInner.innerHTML = renderMarkdown(body);
                  bodyInner.classList.add("md");
                } catch (e) {
                  bodyInner.textContent = body; // 렌더 실패 — 평문 폴백.
                }
              } else {
                bodyInner.textContent = body; // marked 미로드 — 평문.
              }
            } catch (e) {
              // 403/404/네트워크 — 본문 섹션 제거, 안내 유지(graceful, 크래시 X).
              if (bodyInner.isConnected) bodySec.remove();
            }
          })();
        }
        return shell;
      };

      const renderCapabilityHub = () => {
        const root = document.getElementById("detail-panel");
        root.innerHTML = "";
        const item = capabilitiesCache.find((c) => c.id === selectedCapabilityId) || null;
        root.appendChild(renderCapabilityDetailCard(item));
      };

      const selectCapability = (id, opts) => {
        selectedCapabilityId = id;
        for (const child of document.querySelectorAll("#capabilities-list .provider-item")) {
          child.classList.toggle("selected", child.dataset.id === id);
        }
        renderCapabilityHub();
        // mobile: 사용자 클릭 시 메인 화면에 상세를 유지(모듈 뷰 selectProvider 와 동형).
        if (opts && opts.userClick && window.matchMedia("(max-width: 900px)").matches) {
          setActiveTab("main");
        }
      };

      // 능력 뷰 진입(nav 클릭·개요 바로가기) — 3패널 그리드를 켜고(show-capabilities) 선택 유지.
      const showInventory = () => {
        setActiveNav("inventory");
        setChatPanel("chat");
        document.getElementById("workbench").classList.remove("show-providers");
        document.getElementById("workbench").classList.add("show-capabilities");
        if (!selectedCapabilityId && capabilitiesCache.length > 0) selectedCapabilityId = capabilitiesCache[0].id;
        renderCapabilityHub();
      };

      const fetchInventory = async () => {
        try {
          const r = await fetch("/api/inventory");
          if (!r.ok) throw new Error("HTTP " + r.status);
          renderInventory(await r.json());
        } catch (e) {
          const list = document.getElementById("capabilities-list");
          if (list) list.innerHTML =
            '<div class="empty" style="font-size:11px;padding:10px">능력 목록 불러오기 실패: ' + e.message + "</div>";
        }
      };
