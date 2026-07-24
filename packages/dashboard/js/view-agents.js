      // 열려 있으면) 목록을 jobCards 스냅샷으로 다시 그린다. capBgList 로 카드가 정리되면 여기서도 사라진다.
      let agentsFilter = "running"; // "running" | "all" — 오른쪽 드로어 필터와 독립(각자 뷰).
      const agentElapsedEls = new Map(); // jobId -> elapsed span (틱 갱신용, 뷰 재렌더마다 재구성).
      const AGENT_KIND_BADGE = { agent: "🤖 서브에이전트", worker: "📦 워커" };
      // 카운트/빈상태 동기화 — refreshBgBadge 가 매 이벤트마다 호출(뷰 안 열려도 안전).
      const syncAgentsCounts = (running, total) => {
        const rc = document.getElementById("agents-count-running");
        const ac = document.getElementById("agents-count-all");
        if (rc) rc.textContent = String(running);
        if (ac) ac.textContent = String(total);
      };
      // 잡 카드 1개 빌드(공유) — 에이전트 뷰 + 프로젝트 상세가 동일 카드를 재사용(단일 소스).
      // elapsedRegistry 에 running 카드의 경과 span 을 등록(호출자별 틱 맵). jobCards entry(e)
      // 를 그대로 읽어 상태·티어·작업요약·현재 스텝·펼침 상세까지 동일 렌더.
      // opts.compact = 인라인 상세 생략(카드 작게 유지) + 카드 클릭 시 opts.onOpen(jobId) 호출
      //   (프로젝트 상세에서 "자세히는 백그라운드 패널로" 용). 미지정 = 기존 인라인 펼침 동작.
      const buildAgentCard = (jobId, e, now, elapsedRegistry, opts) => {
        opts = opts || {};
        const card = document.createElement("div");
        card.className = "agent-card " + (e.status || "running") + (e.kind === "agent" ? " agent" : "");
        card.dataset.jobId = jobId;
        const top = document.createElement("div"); top.className = "agent-card-top";
        const kind = document.createElement("span"); kind.className = "agent-card-kind";
        kind.textContent = AGENT_KIND_BADGE[e.kind === "agent" ? "agent" : "worker"];
        top.appendChild(kind);
        if (e.modelTier) {
          const tier = String(e.modelTier).trim();
          if (tier !== "" && tier.toLowerCase() !== "default") {
            const tierEl = document.createElement("span");
            tierEl.className = "agent-card-tier";
            tierEl.dataset.tier = tier.toLowerCase();
            tierEl.textContent = tier;
            top.appendChild(tierEl);
          }
        }
        const st = document.createElement("span"); st.className = "agent-card-status";
        st.textContent = BG_STATUS[e.status] || e.status || "";
        top.appendChild(st);
        const name = document.createElement("div"); name.className = "agent-card-name";
        name.textContent = (e.labelEl && e.labelEl.textContent) || "(작업)";
        card.appendChild(top); card.appendChild(name);
        if (e.task) {
          const summary = document.createElement("div"); summary.className = "agent-card-summary";
          summary.textContent = e.task;
          card.appendChild(summary);
        }
        const meta = document.createElement("div"); meta.className = "agent-card-meta";
        const el = document.createElement("span"); el.className = "agent-card-elapsed";
        el.textContent = fmtElapsed(now - (e.startTs || now));
        if (e.status === "running" && elapsedRegistry) elapsedRegistry.set(jobId, el);
        meta.appendChild(el);
        const hasDetail = !!(e.task || e.result || e.errorText || e.stepCount > 0);
        let chev = null;
        if (hasDetail) {
          chev = document.createElement("span"); chev.className = "agent-card-chev";
          chev.textContent = opts.compact ? "자세히 ↗" : (e.expanded ? "▾ 접기" : "▸ 자세히");
          meta.appendChild(chev);
        }
        card.appendChild(meta);
        if (e.lastStep) {
          const step = document.createElement("div"); step.className = "agent-card-step";
          const lbl = document.createElement("span"); lbl.className = "lbl"; lbl.textContent = "지금";
          const val = document.createElement("span"); val.textContent = e.lastStep;
          step.appendChild(lbl); step.appendChild(val);
          card.appendChild(step);
        }
        if (hasDetail && opts.compact) {
          // compact: 인라인 상세 생략 — 카드 클릭 시 백그라운드 패널로 위임(작게 유지).
          card.style.cursor = "pointer";
          card.addEventListener("click", () => { if (opts.onOpen) opts.onOpen(jobId); });
        } else if (hasDetail) {
          const detail = document.createElement("div"); detail.className = "agent-card-detail";
          if (e.task) {
            const t = document.createElement("div"); t.className = "agent-card-detail-block";
            const h = document.createElement("div"); h.className = "acd-label"; h.textContent = "작업";
            const b = document.createElement("div"); b.className = "acd-body"; b.textContent = e.task;
            t.appendChild(h); t.appendChild(b); detail.appendChild(t);
          }
          if (e.result) {
            const r = document.createElement("div"); r.className = "agent-card-detail-block";
            const h = document.createElement("div"); h.className = "acd-label"; h.textContent = "결과";
            const b = document.createElement("div"); b.className = "acd-body result"; b.textContent = e.result;
            r.appendChild(h); r.appendChild(b); detail.appendChild(r);
          }
          if (e.errorText) {
            const er = document.createElement("div"); er.className = "agent-card-detail-block";
            const h = document.createElement("div"); h.className = "acd-label"; h.textContent = "에러";
            const b = document.createElement("div"); b.className = "acd-body error"; b.textContent = e.errorText;
            er.appendChild(h); er.appendChild(b); detail.appendChild(er);
          }
          if (e.stepCount > 0 && e.stepsEl) {
            const s = document.createElement("div"); s.className = "agent-card-detail-block";
            const h = document.createElement("div"); h.className = "acd-label"; h.textContent = "단계 (" + e.stepCount + ")";
            const stepsClone = e.stepsEl.cloneNode(true);
            s.appendChild(h); s.appendChild(stepsClone); detail.appendChild(s);
          }
          card.appendChild(detail);
          if (e.expanded) card.classList.add("open");
          card.style.cursor = "pointer";
          card.addEventListener("click", () => {
            e.expanded = !e.expanded;
            card.classList.toggle("open", e.expanded);
            if (chev) chev.textContent = e.expanded ? "▾ 접기" : "▸ 자세히";
          });
        }
        return card;
      };

      // jobCards → 에이전트 그리드 렌더. 뷰가 열려 있지 않으면 즉시 반환(no-op).
      const renderAgentsView = () => {
        if (currentView !== "agents") return;
        const grid = document.getElementById("agents-grid");
        const empty = document.getElementById("agents-empty");
        if (!grid) return;
        grid.innerHTML = "";
        agentElapsedEls.clear();
        const now = Date.now();
        let running = 0, total = 0, shown = 0;
        // 최신 먼저(삽입 순서 역순) — jobCards 는 삽입 순. 진행 중을 위로 정렬(진행 중 우선).
        const entries = [...jobCards.entries()];
        entries.sort((a, b) => {
          const ra = a[1].status === "running" ? 0 : 1;
          const rb = b[1].status === "running" ? 0 : 1;
          if (ra !== rb) return ra - rb;
          return (b[1].startTs || 0) - (a[1].startTs || 0);
        });
        for (const [jobId, e] of entries) {
          total += 1;
          if (e.status === "running") running += 1;
          if (agentsFilter === "running" && e.status !== "running") continue;
          shown += 1;
          const card = buildAgentCard(jobId, e, now, agentElapsedEls);
          grid.appendChild(card);
        }
        syncAgentsCounts(running, total);
        if (empty) {
          empty.style.display = shown === 0 ? "" : "none";
          empty.textContent = agentsFilter === "running"
            ? "진행 중인 에이전트가 없습니다."
            : "실행된 에이전트가 없습니다.";
        }
      };
      // 렌더 throttle — llm.activity/lifecycle 이 초당 여러 개 쏟아질 때 renderAgentsView 가
      // 매번 grid 전체를 innerHTML="" 후 재구성하면 버벅인다. requestAnimationFrame 으로
      // 프레임당 1회로 coalesce(스트림 폭주 → 부드럽게). 뷰 닫혀있으면 큐잉도 안 함.
      let agentsRenderQueued = false;
      const scheduleAgentsRender = () => {
        if (currentView !== "agents" || agentsRenderQueued) return;
        agentsRenderQueued = true;
        requestAnimationFrame(() => {
          agentsRenderQueued = false;
          renderAgentsView();
        });
      };
      const setAgentsFilter = (mode) => {
        agentsFilter = mode === "all" ? "all" : "running";
        const bar = document.getElementById("agents-filter");
        if (bar) for (const b of bar.querySelectorAll(".bg-fbtn")) {
          const on = b.dataset.filter === agentsFilter;
          b.classList.toggle("active", on);
          b.setAttribute("aria-pressed", on ? "true" : "false");
        }
        // ★ grid 의 filter-running CSS 클래스도 토글해야 함 — 안 그러면 "전체" 로 바꿔도
        // CSS `.filter-running .agent-card:not(.running){display:none}` 가 done 카드를 계속
        // 숨겨 카운트만 나오고 화면은 빈다(버그). renderAgentsView 의 JS 필터와 CSS 를 일치.
        const grid = document.getElementById("agents-grid");
        if (grid) grid.classList.toggle("filter-running", agentsFilter === "running");
        renderAgentsView();
      };
      const showAgents = () => {
        setActiveNav("agents");
        setChatPanel("chat");
        document.getElementById("workbench").classList.remove("show-providers");
        document.getElementById("workbench").classList.remove("show-capabilities");
        const root = document.getElementById("detail-panel");
        root.innerHTML = "";
        const wrap = document.createElement("div");
        wrap.className = "page-view agents-view";
        wrap.innerHTML =
          '<div class="detail-head"><div class="detail-accent active"></div><div class="detail-name">에이전트</div><span class="detail-kind">실시간</span></div>' +
          '<p class="developer-copy">지금 돌고 있는 백그라운드 작업(워커 📦 + 서브에이전트 🤖)을 한눈에. 종류·이름·경과시간·현재 스텝을 실시간으로 표시합니다.</p>' +
          '<div class="agents-toolbar"><div class="bg-filter" id="agents-filter">' +
          '<button class="bg-fbtn active" type="button" data-filter="running" aria-pressed="true">진행 중 <span class="bg-fcount" id="agents-count-running">0</span></button>' +
          '<button class="bg-fbtn" type="button" data-filter="all" aria-pressed="false">전체 <span class="bg-fcount" id="agents-count-all">0</span></button>' +
          '</div><span class="agents-hint">라이브 · 오른쪽 드로어와 동일 소스</span></div>' +
          '<div class="agents-grid filter-running" id="agents-grid"></div>' +
          '<div class="empty" id="agents-empty">진행 중인 에이전트가 없습니다.</div>';
        root.appendChild(wrap);
        // filter=running 클래스는 CSS 보조(카드 렌더 자체가 필터). 토글 버튼 바인딩.
        const bar = wrap.querySelector("#agents-filter");
        for (const b of bar.querySelectorAll(".bg-fbtn")) {
          b.addEventListener("click", () => setAgentsFilter(b.dataset.filter));
        }
        agentsFilter = "running";
        renderAgentsView();
      };

