      // ── 프로젝트 뷰(왼쪽 nav 1급 destination — 축3 마스터-디테일) ──────────────
      // GET /api/projects → 그리드 카드(name·status 배지·설명 일부). 카드 클릭 → 뷰 내부
      // 오른쪽 상세 패널에 GET /api/projects/detail?path= 를 렌더(설명 본문 마크다운 +
      // 전용 스킬/에이전트 + related 클릭 이동). 새 프레임워크 0 — 기존 fetch/renderMarkdown 재사용.
      const PROJECT_STATUS_LABEL = { active: "진행 중", paused: "보류", done: "완료" };
      let projectsCache = [];
      let selectedProjectPath = null;

      // 프로젝트 카드 ⋯ 메뉴 — "폴더 열기"(데몬 호스트의 OS 파일 탐색기로 프로젝트 폴더 열기).
      // 1회 등록(모듈 로드 시). bridge 가 등록 프로젝트 경로만 허용(검증). 브라우저가 아니라
      // 데몬(tiguclaw 호스트)에서 열리므로 폰에서 눌러도 호스트 Mac 의 Finder 가 열린다.
      registerMenuItems("project", () => [
        { id: "open-folder", label: "폴더 열기", icon: "📂", action: { kind: "builtin", handler: "project.openFolder" } },
      ]);
      registerBuiltinHandler("project.openFolder", async (ctx) => {
        if (!ctx || !ctx.path) return;
        try {
          const r = await fetch("/api/open-path", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: ctx.path }),
          });
          showToast(r.ok ? "폴더를 열었습니다" : "폴더 열기 실패", r.ok ? "good" : "bad");
        } catch {
          showToast("폴더 열기 실패", "bad");
        }
      });

      const showProjects = () => {
        setActiveNav("projects");
        setChatPanel("chat");
        document.getElementById("workbench").classList.remove("show-providers");
        document.getElementById("workbench").classList.remove("show-capabilities");
        const root = document.getElementById("detail-panel");
        root.innerHTML = "";
        const wrap = document.createElement("div");
        wrap.className = "page-view projects-view";
        wrap.innerHTML =
          '<div class="detail-head"><div class="detail-accent active"></div><div class="detail-name">프로젝트</div><span class="detail-kind">레지스트리</span></div>' +
          '<p class="developer-copy">등록된 프로젝트(폴더 + PROJECT.md)를 카드로 봅니다. 카드를 누르면 오른쪽에 설명·전용 스킬/에이전트·연관 프로젝트가 열립니다.</p>' +
          '<div class="projects-split no-detail" id="projects-split">' +
          '<div class="projects-grid" id="projects-grid"><div class="empty">불러오는 중…</div></div>' +
          '</div>';
        root.appendChild(wrap);
        selectedProjectPath = null;
        fetchProjects();
      };

      const fetchProjects = async () => {
        try {
          const r = await fetch("/api/projects");
          const data = await r.json();
          projectsCache = Array.isArray(data) ? data : [];
        } catch (e) {
          projectsCache = [];
        }
        const nav = document.getElementById("nav-project-count");
        if (nav) nav.textContent = String(projectsCache.length);
        if (currentView === "projects") renderProjectsGrid();
        renderContextTags(); // 입력창 위 컨텍스트 태그 바 갱신.
      };

      // ── 컨텍스트 태그 바 ─────────────────────────────────────────────────
      // 등록 프로젝트를 칩으로. 클릭 시 `#<이름>` 태그를 입력창에 껴넣어 "그 프로젝트 얘기"임을
      // 티구클로가 바로 알게 한다(SYSTEM.md 텍스트 컨벤션 — 채널·LLM 무관). 최근 클릭 순 정렬.
      const CTX_RECENT_KEY = "tgctx_recent";
      const ctxRecent = () => { try { return JSON.parse(localStorage.getItem(CTX_RECENT_KEY) || "[]"); } catch { return []; } };
      const ctxBumpRecent = (name) => {
        try { const r = ctxRecent().filter((n) => n !== name); r.unshift(name); localStorage.setItem(CTX_RECENT_KEY, JSON.stringify(r.slice(0, 30))); } catch {}
      };
      const ctxUnlearn = (name) => { // 학습 칩 제거 — recent 에서 뺀다.
        try { localStorage.setItem(CTX_RECENT_KEY, JSON.stringify(ctxRecent().filter((n) => n !== name))); } catch {}
        renderContextTags();
      };
      // 해석 가능한 태그 이름 집합 = 등록 프로젝트 ∪ 인벤토리 스킬·에이전트. 실제 뭔가를 가리키는지 표시용.
      const resolvableNames = () => {
        const s = new Set();
        for (const p of (Array.isArray(projectsCache) ? projectsCache : [])) if (p && p.name) s.add(p.name);
        const inv = inventoryCache || {};
        for (const cat of ["skill", "agent"]) for (const it of (inv[cat] || [])) if (it && it.name) s.add(it.name);
        return s;
      };
      // 칩 클릭 = 입력창에서 그 태그 토글(없으면 삽입, 있으면 제거 → "현재 걸린 태그도 지움").
      const insertContextTag = (name) => {
        const ta = document.getElementById("chat-input");
        if (!ta) return;
        const core = "#" + name;
        if (ta.value.includes(core)) {
          // 제거 — "#name " 우선, 없으면 "#name". 이중 공백 정리.
          ta.value = ta.value.split(core + " ").join("").split(core).join("").replace(/[ \t]{2,}/g, " ").replace(/^\s+/, "");
        } else {
          const tag = core + " ";
          const s = ta.selectionStart != null ? ta.selectionStart : ta.value.length;
          const e = ta.selectionEnd != null ? ta.selectionEnd : ta.value.length;
          ta.value = ta.value.slice(0, s) + tag + ta.value.slice(e);
          const pos = s + tag.length; ta.setSelectionRange(pos, pos);
          ctxBumpRecent(name);
        }
        ta.focus();
        ta.dispatchEvent(new Event("input", { bubbles: true })); // autogrow.
        renderContextTags();
      };
      // 타이핑한 태그 학습 — 보낸 메시지에서 `#태그` 를 뽑아 recent 에 기록(다음부터 칩으로 뜸).
      const recordTypedTags = (text) => {
        if (typeof text !== "string" || text.indexOf("#") === -1) return;
        let t = text;
        for (const p of (Array.isArray(projectsCache) ? projectsCache : [])) {
          if (p && p.name && t.includes("#" + p.name)) { ctxBumpRecent(p.name); t = t.split("#" + p.name).join(" "); }
        }
        const m = t.match(/#([^\s#]{1,40})/g) || [];
        for (const tag of m) ctxBumpRecent(tag.slice(1));
        renderContextTags();
      };
      // 입력창의 현재 값 기준으로 각 칩의 활성(걸림) 표시만 갱신(재렌더 없이 저비용).
      const updateActiveChips = () => {
        const ta = document.getElementById("chat-input");
        const val = ta ? ta.value : "";
        document.querySelectorAll("#chat-context .ctx-chip").forEach((chip) => {
          const n = chip.dataset.tag;
          chip.classList.toggle("active", !!n && val.includes("#" + n));
        });
      };
      const CTX_EXPANDED_KEY = "tgctx_expanded";
      const ctxBarExpanded = () => { try { return localStorage.getItem(CTX_EXPANDED_KEY) === "1"; } catch { return false; } };
      const setCtxBarExpanded = (v) => { try { localStorage.setItem(CTX_EXPANDED_KEY, v ? "1" : "0"); } catch {} renderContextTags(); };
      const renderContextTags = () => {
        const bar = document.getElementById("chat-context");
        if (!bar) return;
        bar.innerHTML = "";
        const projs = Array.isArray(projectsCache) ? projectsCache.filter((p) => p && p.name) : [];
        const projByName = new Map(projs.map((p) => [p.name, p]));
        const resolvable = resolvableNames();
        // 후보 = 최근 사용 태그 ∪ 등록 프로젝트(시드). 최근 먼저.
        const names = []; const seen = new Set();
        for (const n of ctxRecent()) { if (n && !seen.has(n)) { seen.add(n); names.push(n); } }
        for (const p of projs) { if (!seen.has(p.name)) { seen.add(p.name); names.push(p.name); } }
        if (names.length === 0) { bar.classList.remove("expanded"); return; } // 없으면 바 숨김(:empty).
        const expanded = ctxBarExpanded();
        bar.classList.toggle("expanded", expanded);
        // 토글 — 접힘 1줄 / 펼침 다줄+스크롤. caret + "컨텍스트" + 개수.
        const toggle = document.createElement("button");
        toggle.type = "button"; toggle.className = "ctx-toggle";
        toggle.title = expanded ? "컨텍스트 태그 접기" : "컨텍스트 태그 펼치기(" + names.length + ")";
        const caret = document.createElement("span");
        caret.className = "ctx-tcaret"; caret.textContent = expanded ? "▾" : "▸";
        toggle.appendChild(caret); toggle.appendChild(document.createTextNode(" 컨텍스트 "));
        const cnt = document.createElement("span");
        cnt.className = "ctx-count"; cnt.textContent = String(names.length);
        toggle.appendChild(cnt);
        toggle.addEventListener("click", () => setCtxBarExpanded(!expanded));
        bar.appendChild(toggle);
        // 칩 컨테이너
        const chipWrap = document.createElement("div");
        chipWrap.className = "ctx-chips";
        for (const name of names.slice(0, 50)) {
          const p = projByName.get(name);
          const status = p && ["active", "paused", "done"].includes(p.status) ? p.status : null;
          const isResolved = p || resolvable.has(name);
          const chip = document.createElement("span");
          chip.className = "ctx-chip" + (p ? " s-" + status : " ctx-generic") + (isResolved ? "" : " ctx-unresolved");
          chip.dataset.tag = name;
          chip.title = (p ? "프로젝트" : isResolved ? "스킬/에이전트" : "태그(미해석)") + " → 클릭: #" + name + " 넣기/빼기";
          const hash = document.createElement("span");
          hash.className = "ctx-hash"; hash.textContent = "#";
          chip.appendChild(hash); chip.appendChild(document.createTextNode(name));
          chip.addEventListener("click", () => insertContextTag(name));
          // 학습 칩(프로젝트 시드 아님)은 × 로 제거 가능. 프로젝트는 registry 관리라 × 없음.
          if (!p) {
            const x = document.createElement("span");
            x.className = "ctx-x"; x.textContent = "×"; x.title = "이 태그 칩 제거";
            x.addEventListener("click", (e) => { e.stopPropagation(); ctxUnlearn(name); });
            chip.appendChild(x);
          }
          chipWrap.appendChild(chip);
        }
        bar.appendChild(chipWrap);
        updateActiveChips();
      };

      const renderProjectsGrid = () => {
        const grid = document.getElementById("projects-grid");
        if (!grid) return;
        grid.innerHTML = "";
        if (projectsCache.length === 0) {
          grid.innerHTML = '<div class="empty">등록된 프로젝트가 없습니다. ' + assistantName + ' 에게 "이거 프로젝트로 만들어줘"라고 말해보세요.</div>';
          return;
        }
        for (const p of projectsCache) {
          const status = ["active", "paused", "done"].includes(p.status) ? p.status : "active";
          const card = document.createElement("button");
          card.type = "button";
          card.className = "project-card s-" + status + (p.path === selectedProjectPath ? " selected" : "");
          const head = document.createElement("div");
          head.className = "project-card-head";
          const name = document.createElement("span");
          name.className = "project-card-name";
          name.textContent = p.name || "(이름 없음)";
          head.appendChild(name);
          // 상태 뱃지 — active(기본)는 모든 카드에 붙어 노이즈라 생략. 보류/완료만 표시(의미 신호).
          if (status !== "active") {
            const st = document.createElement("span");
            st.className = "project-status " + status;
            st.textContent = PROJECT_STATUS_LABEL[status] || status;
            head.appendChild(st);
          }
          // 실행 중 에이전트 배지 — "지금 어디가 바쁜지" 한눈에(브리지 runningAgents).
          if (p.runningAgents > 0) {
            const rb = document.createElement("span");
            rb.className = "project-run-badge";
            rb.textContent = "🤖 " + p.runningAgents + " 실행 중";
            head.appendChild(rb);
          }
          const summary = document.createElement("div");
          summary.className = "project-card-summary";
          summary.textContent = p.description || "설명 없음";
          const pathEl = document.createElement("div");
          pathEl.className = "project-card-path";
          pathEl.textContent = p.path;
          card.appendChild(head); card.appendChild(summary); card.appendChild(pathEl);
          card.addEventListener("click", () => openProjectDetail(p.path));
          // ⋯ 메뉴 + 우클릭 + 롱프레스(카드류 3경로 동일). ctx 에 path 를 실어 "폴더 열기"가 씀.
          const projectCtx = () => ({ type: "project", targetId: p.path, label: p.name || "(이름 없음)", path: p.path });
          attachKebab(card, "project", projectCtx);
          attachContextMenu(card, "project", projectCtx);
          attachLongPress(card, "project", projectCtx);
          grid.appendChild(card);
        }
      };

      const closeProjectDetail = () => {
        selectedProjectPath = null;
        projectAgentsBox = null; // 라이브 재렌더 훅 중단.
        const split = document.getElementById("projects-split");
        if (split) {
          split.classList.add("no-detail");
          const existing = document.getElementById("project-detail");
          if (existing) existing.remove();
        }
        renderProjectsGrid();
      };

      const openProjectDetail = async (projectPath) => {
        selectedProjectPath = projectPath;
        renderProjectsGrid();
        const split = document.getElementById("projects-split");
        if (!split) return;
        split.classList.remove("no-detail");
        let panel = document.getElementById("project-detail");
        if (!panel) {
          panel = document.createElement("aside");
          panel.id = "project-detail";
          panel.className = "project-detail";
          split.appendChild(panel);
        }
        panel.innerHTML = '<div class="empty">불러오는 중…</div>';
        let detail;
        try {
          const r = await fetch("/api/projects/detail?path=" + encodeURIComponent(projectPath));
          if (!r.ok) {
            const err = await r.json().catch(() => ({}));
            panel.innerHTML = '';
            const msg = document.createElement("div");
            msg.className = "empty";
            msg.textContent = r.status === 404
              ? "PROJECT.md 를 찾을 수 없습니다 (폴더/파일 부재)."
              : ("상세를 불러오지 못했습니다: " + (err.error || r.status));
            panel.appendChild(msg);
            return;
          }
          detail = await r.json();
        } catch (e) {
          panel.innerHTML = '';
          const msg = document.createElement("div");
          msg.className = "empty";
          msg.textContent = "상세를 불러오지 못했습니다.";
          panel.appendChild(msg);
          return;
        }
        // 현재 선택이 바뀌었으면(빠른 연속 클릭) 렌더 폐기.
        if (selectedProjectPath !== projectPath) return;
        renderProjectDetail(panel, projectPath, detail);
      };

      // ── 프로젝트 상세: 라이브 에이전트 섹션(에이전트 뷰 카드 재사용) ──────────────
      let projectAgentsBox = null;               // 현재 열린 상세의 에이전트 컨테이너.
      const projectAgentElapsedEls = new Map();  // jobId -> elapsed span (상세 틱용).
      const pathNorm = (s) => String(s || "").replace(/\/+$/, "");
      const renderProjectAgentSections = (box, projectPath) => {
        box.innerHTML = "";
        projectAgentElapsedEls.clear();
        const now = Date.now();
        const target = pathNorm(projectPath);
        const mine = [...jobCards.entries()].filter(([, e]) => e.cwd && pathNorm(e.cwd) === target);
        const running = mine.filter(([, e]) => e.status === "running");
        const rest = mine.filter(([, e]) => e.status !== "running")
          .sort((a, b) => (b[1].startTs || 0) - (a[1].startTs || 0));
        const section = (title, entries, emptyMsg) => {
          if (entries.length === 0 && !emptyMsg) return; // 최근 섹션은 비면 생략.
          const sec = document.createElement("div");
          sec.className = "pd-section";
          const t = document.createElement("div"); t.className = "pd-section-title"; t.textContent = title;
          sec.appendChild(t);
          if (entries.length === 0) {
            const e = document.createElement("div"); e.className = "pd-empty"; e.textContent = emptyMsg;
            sec.appendChild(e);
          } else {
            const grid = document.createElement("div"); grid.className = "pd-agents-grid";
            for (const [jobId, e] of entries) grid.appendChild(buildAgentCard(jobId, e, now, projectAgentElapsedEls));
            sec.appendChild(grid);
          }
          box.appendChild(sec);
        };
        section("진행 중 에이전트 (" + running.length + ")", running, "지금 이 프로젝트에서 작업 중인 에이전트가 없습니다.");
        section("최근 에이전트 (" + rest.length + ")", rest, null);
      };
      let projectAgentsRenderQueued = false;
      const scheduleProjectAgentsRender = () => {
        if (!projectAgentsBox || !selectedProjectPath || projectAgentsRenderQueued) return;
        projectAgentsRenderQueued = true;
        requestAnimationFrame(() => {
          projectAgentsRenderQueued = false;
          if (projectAgentsBox && selectedProjectPath) renderProjectAgentSections(projectAgentsBox, selectedProjectPath);
        });
      };

      const renderProjectDetail = (panel, projectPath, detail) => {
        const meta = detail.meta || {};
        const status = ["active", "paused", "done"].includes(meta.status) ? meta.status : "active";
        panel.innerHTML = "";

        const head = document.createElement("div");
        head.className = "project-detail-head";
        const name = document.createElement("div");
        name.className = "project-detail-name";
        name.textContent = meta.name || "(이름 없음)";
        const st = document.createElement("span");
        st.className = "project-status " + status;
        st.textContent = PROJECT_STATUS_LABEL[status] || status;
        const close = document.createElement("button");
        close.type = "button";
        close.className = "project-detail-close";
        close.setAttribute("aria-label", "닫기");
        close.textContent = "✕";
        close.addEventListener("click", closeProjectDetail);
        head.appendChild(name); head.appendChild(st); head.appendChild(close);
        panel.appendChild(head);

        const pathEl = document.createElement("div");
        pathEl.className = "project-detail-path";
        pathEl.textContent = projectPath;
        panel.appendChild(pathEl);

        // ★라이브 에이전트 — 에이전트 뷰와 *동일한* 라이브 카드(buildAgentCard)를 이 프로젝트
        // (cwd) 로 필터해 재사용(단일 소스·일관). 컨테이너를 보관해 SSE 이벤트마다 이 섹션만
        // 재렌더(경과·현재 스텝 라이브). 진행 중 / 최근 섹션 분리.
        const agentsBox = document.createElement("div");
        agentsBox.id = "project-agents-box";
        panel.appendChild(agentsBox);
        projectAgentsBox = agentsBox;
        renderProjectAgentSections(agentsBox, projectPath);

        // 설명 본문(마크다운 렌더). body 비면 description 폴백.
        const bodySrc = (meta.body && meta.body.trim() !== "") ? meta.body : (meta.description || "");
        const bodySec = document.createElement("div");
        bodySec.className = "pd-section";
        const bodyInner = document.createElement("div");
        bodyInner.className = "pd-body";
        if (bodySrc.trim() === "") {
          bodyInner.classList.add("pd-empty");
          bodyInner.textContent = "설명이 없습니다.";
        } else if (typeof window.marked !== "undefined") {
          try { bodyInner.innerHTML = renderMarkdown(bodySrc); bodyInner.classList.add("md"); }
          catch (e) { bodyInner.textContent = bodySrc; }
        } else {
          bodyInner.textContent = bodySrc;
        }
        bodySec.appendChild(bodyInner);
        panel.appendChild(bodySec);

        const listSection = (title, items) => {
          const sec = document.createElement("div");
          sec.className = "pd-section";
          const t = document.createElement("div");
          t.className = "pd-section-title";
          t.textContent = title;
          sec.appendChild(t);
          if (!Array.isArray(items) || items.length === 0) {
            const e = document.createElement("div");
            e.className = "pd-empty";
            e.textContent = "없음";
            sec.appendChild(e);
          } else {
            const list = document.createElement("div");
            list.className = "pd-list";
            for (const it of items) {
              const row = document.createElement("div");
              row.className = "pd-item";
              const n = document.createElement("div");
              n.className = "pd-item-name";
              n.textContent = it.name || "(이름 없음)";
              // 모델 티어(에이전트 명세) — 있으면 이름 옆 뱃지. 스킬·MCP 는 없어 생략.
              if (it.model) {
                const m = document.createElement("span");
                m.className = "pd-item-model";
                m.textContent = it.model;
                n.appendChild(m);
              }
              row.appendChild(n);
              if (it.description) {
                const d = document.createElement("div");
                d.className = "pd-item-desc";
                d.textContent = it.description;
                row.appendChild(d);
              }
              list.appendChild(row);
            }
            sec.appendChild(list);
          }
          panel.appendChild(sec);
        };

        listSection("전용 스킬", detail.skills);
        listSection("전용 에이전트", detail.agents);
        // 전용 MCP — 이 프로젝트로 위임할 때만 노출되는 프로젝트 스코프 MCP(<project>/.mcp.json).
        listSection(
          "전용 MCP",
          (detail.mcp || []).map((m) => ({ name: m.name, description: m.desc })),
        );

        // 연관 프로젝트 — path 있으면 클릭 이동, 없으면 텍스트 칩.
        const relSec = document.createElement("div");
        relSec.className = "pd-section";
        const relTitle = document.createElement("div");
        relTitle.className = "pd-section-title";
        relTitle.textContent = "연관 프로젝트";
        relSec.appendChild(relTitle);
        const related = Array.isArray(detail.related) ? detail.related : [];
        if (related.length === 0) {
          const e = document.createElement("div");
          e.className = "pd-empty";
          e.textContent = "없음";
          relSec.appendChild(e);
        } else {
          const chips = document.createElement("div");
          chips.className = "pd-related";
          for (const rel of related) {
            const chip = document.createElement("span");
            chip.className = "pd-related-chip" + (rel.path ? " link" : "");
            chip.textContent = rel.name || rel.path || "(연관)";
            if (rel.path) {
              chip.title = rel.path;
              chip.addEventListener("click", () => openProjectDetail(rel.path));
            }
            chips.appendChild(chip);
          }
          relSec.appendChild(chips);
        }
        panel.appendChild(relSec);

      };

