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
        { id: "rename", label: "이름 수정", icon: "✏️", action: { kind: "builtin", handler: "project.rename" } },
        { id: "remove", label: "제거", icon: "🗑", action: { kind: "builtin", handler: "project.remove" } },
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
      // 프로젝트 "제거" — ★비파괴: 레지스트리(인덱스)에서만 등록 해제, 폴더/PROJECT.md 는 안 지운다
      // (store forgetProject = DELETE FROM projects). 파괴적이지 않지만 사용자 명시 확인(confirm)
      // 후에만 실행(파괴적 행위 소프트 게이트 원칙과 동형 — "목록에서 제거" 의도 재확인).

      registerBuiltinHandler("project.rename", async (ctx) => {
        const currentName = String(ctx.name || ctx.title || "").trim();
        const nextName = prompt("새 프로젝트 이름", currentName);
        if (nextName === null) return;
        const name = nextName.trim();
        if (!name) return alert("프로젝트 이름을 입력하세요.");
        if (name === currentName) return;
        try {
          const r = await fetch("/api/project-rename", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: ctx.path, name }),
          });
          if (!r.ok) {
            const j = await r.json().catch(() => ({}));
            throw new Error(j.error || `HTTP ${r.status}`);
          }
          await fetchProjects();
          if (selectedProjectPath === ctx.path) await openProjectDetail(ctx.path);
        } catch (e) {
          alert(`프로젝트 이름 수정 실패: ${e.message || e}`);
        }
      });

      registerBuiltinHandler("project.remove", async (ctx) => {
        if (!ctx || !ctx.path) return;
        const label = ctx.label || ctx.path;
        if (!window.confirm(label + " 을 목록에서 제거할까요? 폴더는 삭제되지 않습니다.")) return;
        try {
          const r = await fetch("/api/project-forget", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: ctx.path }),
          });
          if (!r.ok) { showToast("제거 실패", "bad"); return; }
          // 열려 있던 프로젝트면 상세 닫기(closeProjectDetail 이 리스트 재렌더까지 수행).
          if (selectedProjectPath === ctx.path) closeProjectDetail();
          await fetchProjects(); // 레지스트리 재조회 → renderProjectsGrid + 컨텍스트 태그 갱신.
          if (currentView === "projects") renderProjectsGrid();
          showToast("목록에서 제거했습니다(폴더는 보존)", "good");
        } catch {
          showToast("제거 실패", "bad");
        }
      });

      // 모듈/능력 뷰와 완전 동형 3패널 — #projects-panel(리스트 서브패널) + #detail-panel(상세).
      // show-projects 모드는 setActiveNav 가 다른 모드를 지운 뒤 여기서 add. 리스트는 정적
      // #projects-list, 검색창(#projects-search)도 정적(index.html) — 재렌더에도 값 보존.
      const showProjects = () => {
        setActiveNav("projects");
        setChatPanel("chat");
        document.getElementById("workbench").classList.add("show-projects");
        selectedProjectPath = null;
        document.getElementById("detail-panel").innerHTML =
          '<div id="detail-empty">프로젝트를 선택하세요.</div>';
        const searchInput = document.getElementById("projects-search");
        if (searchInput && !searchInput.dataset.wired) {
          searchInput.dataset.wired = "1";
          searchInput.addEventListener("input", () => {
            applyListSearchFilter(document.getElementById("projects-list"), searchInput.value);
          });
        }
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
        const core = formatTagToken(name); // 공백 이름이면 #[...] — 모양은 util.js 한 곳.
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
      // 태그 학습 — 판정은 util.js `learnableTagNames` 하나. 여기선 재료(아는 이름)만 준다.
      {
        const ta = document.getElementById("chat-input");
        if (ta) {
          // ── `#` 스캐폴드 (2026-08-11 사용자 제안) ────────────────────────
          //
          // `#` 를 치면 `#[]` 를 깔고 커서를 안에 둔다 — 공백 있는 이름을 쓸 수 있다는 걸
          // **문법을 외우지 않아도** 알게 된다. `#단어` 와 `#[단어]` 는 같은 뜻이라
          // 의미가 달라지지 않는다.
          //
          // ★함정과 그 대응(자동 삽입은 잘못 쓰면 글쓰기를 방해한다):
          //  ·단어 경계에서만 — 문장 중간 `issue #123`·`C#` 은 안 건드린다(util 판정).
          //  ·`]` 를 치면 **건너뛴다** — 닫는 괄호가 두 개가 되지 않게.
          //  ·빈 `#[|]` 에서 Backspace 면 **괄호째** 지운다(한 번에 되돌리기).
          //  ·Escape 면 괄호를 벗겨 `#` 만 남긴다 — 스캐폴드에 갇히지 않는다.
          //  ·IME 조합 중(한글)에는 개입하지 않는다.
          let composing = false;
          ta.addEventListener("compositionstart", () => { composing = true; });
          ta.addEventListener("compositionend", () => { composing = false; });
          ta.addEventListener("beforeinput", (e) => {
            if (composing || e.inputType !== "insertText" || e.data !== "#") return;
            const v = ta.value, a = ta.selectionStart, b = ta.selectionEnd;
            if (a !== b || !shouldScaffoldTag(v.slice(0, a))) return;
            e.preventDefault();
            ta.value = v.slice(0, a) + "#[]" + v.slice(b);
            ta.setSelectionRange(a + 2, a + 2);
            ta.dispatchEvent(new Event("input", { bubbles: true })); // autogrow·활성칩 갱신.
          });
          ta.addEventListener("keydown", (e) => {
            if (composing) return;
            const v = ta.value, a = ta.selectionStart, b = ta.selectionEnd;
            if (a !== b) return;
            const inEmpty = v.slice(a - 2, a) === "#[" && v[a] === "]";
            if (e.key === "]" && v[a] === "]") {              // 건너뛰기.
              e.preventDefault(); ta.setSelectionRange(a + 1, a + 1); return;
            }
            if (e.key === "Backspace" && inEmpty) {            // 괄호째 되돌리기.
              e.preventDefault();
              ta.value = v.slice(0, a - 1) + v.slice(a + 1);   // "[" 와 "]" 제거 → "#" 만.
              ta.setSelectionRange(a - 1, a - 1);
              ta.dispatchEvent(new Event("input", { bubbles: true }));
              return;
            }
            if (e.key === "Escape" && v.lastIndexOf("#[", a) !== -1 && v.indexOf("]", a) !== -1) {
              const open = v.lastIndexOf("#[", a), close = v.indexOf("]", a);
              if (v.slice(open + 2, close).indexOf("\n") !== -1) return; // 여러 줄 = 내 것 아님.
              e.preventDefault();
              ta.value = v.slice(0, open + 1) + v.slice(open + 2, close) + v.slice(close + 1);
              const pos = a - 1; ta.setSelectionRange(pos, pos);
              ta.dispatchEvent(new Event("input", { bubbles: true }));
            }
          });
        }
      }

      // 보낸 메시지에서 **배울 태그**를 뽑아 recent 에 기록(다음부터 칩으로 뜸).
      // ★판정은 util.js 한 곳 — 여기선 "아는 이름" 집합만 만들어 넘긴다.
      //  아는 이름 = 등록 프로젝트 ∪ 인벤토리 스킬·에이전트 ∪ 이미 배운 칩.
      const recordTypedTags = (text) => {
        const known = resolvableNames();
        for (const n of ctxRecent()) known.add(n);
        const learned = learnableTagNames(text, known);
        if (learned.length === 0) return;
        for (const n of learned) ctxBumpRecent(n);
        renderContextTags();
      };
      // 입력창의 현재 값 기준으로 각 칩의 활성(걸림) 표시만 갱신(재렌더 없이 저비용).
      const updateActiveChips = () => {
        const ta = document.getElementById("chat-input");
        const val = ta ? ta.value : "";
        document.querySelectorAll("#chat-context .ctx-chip").forEach((chip) => {
          const n = chip.dataset.tag;
          chip.classList.toggle("active", !!n && val.includes(formatTagToken(n)));
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
        // ── ＋ 새 태그 (2026-08-11 사용자 요청: "첫머리 말고도 가능하게") ──────
        //
        // `#` 자동 스캐폴드는 **줄 첫머리에서만** 돈다. 넓히면 `issue #123` 이
        // `issue #[123]` 이 되는데, 대괄호는 명시형이라 **무조건 태그로 배운다** — 예전엔
        // 그냥 글자였던 것이 진짜 태그가 된다. 그리고 문장 중간의 `#` 이 태그인지 아닌지는
        // **모양으로 못 가린다**(`#` 은 여러 언어의 주석 문자다).
        //
        // ★그래서 추측을 넓히지 않고 **의도를 받는다.** 새 태그를 만드는 건 의도적인
        //  행동이므로 키 입력을 짐작하는 대신 버튼을 준다 — 커서가 어디 있든 그 자리에
        //  `#[]` 를 넣고 안으로 들어간다. 오탐 0, 예외 0.
        const addChip = document.createElement("button");
        addChip.type = "button";
        addChip.className = "ctx-chip ctx-generic ctx-add";
        addChip.textContent = "＋ 새 태그";
        addChip.title = "커서 자리에 #[] 를 넣습니다 (공백 있는 이름도 가능)";
        addChip.addEventListener("click", () => {
          const ta = document.getElementById("chat-input");
          if (!ta) return;
          const v = ta.value, a = ta.selectionStart, b = ta.selectionEnd;
          // 앞이 공백이 아니면 한 칸 띄운다 — 앞 단어에 붙어버리지 않게.
          const pad = a > 0 && !/\s$/.test(v.slice(0, a)) ? " " : "";
          ta.value = v.slice(0, a) + pad + "#[]" + v.slice(b);
          const pos = a + pad.length + 2;
          ta.focus();
          ta.setSelectionRange(pos, pos);
          ta.dispatchEvent(new Event("input", { bubbles: true }));
        });
        chipWrap.appendChild(addChip);
        bar.appendChild(chipWrap);
        updateActiveChips();
      };

      const renderProjectsGrid = () => {
        const grid = document.getElementById("projects-list");
        if (!grid) return;
        const countEl = document.getElementById("projects-count");
        if (countEl) countEl.textContent = String(projectsCache.length);
        grid.innerHTML = "";
        if (projectsCache.length === 0) {
          // ★등록하는 **두 경로**를 다 적는다 (2026-08-11). 종전엔 "이거 프로젝트로
          //  만들어줘" 하나뿐이라, 폴더 없이 새로 시작하는 길은 어디에도 안 적혀
          //  있었다(비서는 하는데 아무도 모름). 화면에 등록 버튼을 만드는 대신
          //  여기 한 줄로 — 등록은 평생 몇 번이고, 판단은 비서가 한다.
          grid.innerHTML =
            '<div class="empty"><b>등록된 프로젝트가 없습니다.</b><br>' +
            escHtml(assistantName) + ' 에게 이렇게 말해보세요 —<br>' +
            '· <i>"<code>~/work/myapp</code> 프로젝트로 등록해줘"</i> (있는 폴더를)<br>' +
            '· <i>"이런 프로젝트 하나 해보자"</i> (폴더까지 새로 만들어 등록합니다)<br>' +
            '<small>설명을 담은 <code>PROJECT.md</code> 는 ' + escHtml(assistantName) +
            ' 가 씁니다. 등록하면 <code>#이름</code> 으로 그 프로젝트 얘기를 할 수 있어요.</small></div>';
          return;
        }
        // 모듈/능력 뷰와 동형 master-detail 리스트(provider-item) — 카드 그리드 폐기(2026-07-18
        // 사용자 요청). 플랫 리스트(그룹화 없음) + 우측 상세. "실행 중(진행중)" 배지는 제거,
        // 상태는 보류/완료만 작은 라벨(active 는 노이즈라 생략).
        for (const p of projectsCache) {
          const status = ["active", "paused", "done"].includes(p.status) ? p.status : "active";
          const item = document.createElement("button");
          item.type = "button";
          item.className = "provider-item" + (p.path === selectedProjectPath ? " selected" : "");
          const head = document.createElement("div");
          head.className = "pi-head";
          const name = document.createElement("span");
          name.className = "pi-name";
          name.textContent = p.name || "(이름 없음)";
          name.title = p.name || "";
          head.appendChild(name);
          if (status !== "active") {
            const st = document.createElement("span");
            st.className = "pi-kind";
            st.textContent = PROJECT_STATUS_LABEL[status] || status;
            head.appendChild(st);
          }
          item.appendChild(head);
          const summary = document.createElement("div");
          summary.className = "pi-summary";
          summary.textContent = p.description || "설명 없음";
          item.appendChild(summary);
          const pathEl = document.createElement("div");
          pathEl.className = "pi-summary pi-path";
          pathEl.textContent = p.path;
          item.appendChild(pathEl);
          // 검색 대상 텍스트(이름·설명·경로·상태) — 모듈/능력 뷰와 동형(applyListSearchFilter).
          item.dataset.searchText = [p.name, p.description, p.path, PROJECT_STATUS_LABEL[status] || status]
            .filter(Boolean).join(" ").toLowerCase();
          item.addEventListener("click", () => openProjectDetail(p.path));
          // ⋯ 메뉴 + 우클릭 + 롱프레스(3경로 동일). ctx 에 path 를 실어 "폴더 열기"가 씀.
          const projectCtx = () => ({ type: "project", targetId: p.path, label: p.name || "(이름 없음)", name: p.name || "", path: p.path });
          attachKebab(item, "project", projectCtx);
          attachContextMenu(item, "project", projectCtx);
          attachLongPress(item, "project", projectCtx);
          grid.appendChild(item);
        }
        // 재렌더 후 현재 검색어 재적용 (모듈/능력 뷰와 동형).
        const searchInput = document.getElementById("projects-search");
        if (searchInput) applyListSearchFilter(grid, searchInput.value);
      };

      const closeProjectDetail = () => {
        selectedProjectPath = null;
        projectAgentsBox = null; // 라이브 재렌더 훅 중단.
        document.getElementById("detail-panel").innerHTML =
          '<div id="detail-empty">프로젝트를 선택하세요.</div>';
        renderProjectsGrid();
      };

      const openProjectDetail = async (projectPath) => {
        selectedProjectPath = projectPath;
        renderProjectsGrid();
        // 상세는 공유 #detail-panel 에 렌더(모듈/능력 뷰 동형).
        const panel = document.getElementById("detail-panel");
        if (!panel) return;
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
      // "최근 에이전트" 섹션 제거(사용자 요청) — 진행 중만. 진행 중 섹션은 접기 가능(localStorage
      //   영속), 카드는 compact(인라인 상세 없음)이고 클릭 시 백그라운드 패널로 위임(focusBgJob).
      const PD_RUNNING_COLLAPSE_LS = "tc:pdRunningCollapsed";
      const renderProjectAgentSections = (box, projectPath) => {
        box.innerHTML = "";
        projectAgentElapsedEls.clear();
        const now = Date.now();
        const target = pathNorm(projectPath);
        const running = [...jobCards.entries()]
          .filter(([, e]) => e.cwd && pathNorm(e.cwd) === target && e.status === "running");
        let collapsed = false;
        try { collapsed = localStorage.getItem(PD_RUNNING_COLLAPSE_LS) === "1"; } catch {}
        const sec = document.createElement("div");
        sec.className = "pd-section";
        const t = document.createElement("div");
        t.className = "pd-section-title pd-collapsible" + (collapsed ? " collapsed" : "");
        t.setAttribute("role", "button"); t.tabIndex = 0;
        const chevS = document.createElement("span"); chevS.className = "pd-sec-chev"; chevS.textContent = collapsed ? "▸" : "▾";
        const label = document.createElement("span"); label.textContent = "진행 중 에이전트 (" + running.length + ")";
        t.appendChild(chevS); t.appendChild(label);
        sec.appendChild(t);
        const body = document.createElement("div"); body.className = "pd-sec-body";
        if (collapsed) body.style.display = "none";
        if (running.length === 0) {
          const e = document.createElement("div"); e.className = "pd-empty";
          e.textContent = "지금 이 프로젝트에서 작업 중인 에이전트가 없습니다.";
          body.appendChild(e);
        } else {
          const grid = document.createElement("div"); grid.className = "pd-agents-grid";
          for (const [jobId, e] of running) {
            grid.appendChild(buildAgentCard(jobId, e, now, projectAgentElapsedEls, {
              compact: true,
              onOpen: (jid) => {
                if (typeof focusBgJob === "function") focusBgJob(jid);
                else if (typeof openBg === "function") openBg();
              },
            }));
          }
          body.appendChild(grid);
        }
        sec.appendChild(body);
        const toggle = () => {
          const isCollapsing = body.style.display !== "none";
          body.style.display = isCollapsing ? "none" : "";
          chevS.textContent = isCollapsing ? "▸" : "▾";
          t.classList.toggle("collapsed", isCollapsing);
          try { localStorage.setItem(PD_RUNNING_COLLAPSE_LS, isCollapsing ? "1" : "0"); } catch {}
        };
        t.addEventListener("click", toggle);
        t.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); toggle(); } });
        box.appendChild(sec);
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
        const close = document.createElement("button");
        close.type = "button";
        close.className = "project-detail-close";
        close.setAttribute("aria-label", "닫기");
        close.textContent = "✕";
        close.addEventListener("click", closeProjectDetail);
        head.appendChild(name);
        // "진행 중"(active) 배지는 노이즈라 숨김(리스트와 동형, 2026-07-18) — 보류/완료만 표시.
        if (status !== "active") {
          const st = document.createElement("span");
          st.className = "project-status " + status;
          st.textContent = PROJECT_STATUS_LABEL[status] || status;
          head.appendChild(st);
        }
        head.appendChild(close);
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

        // ★항목을 눌러 본문을 그 자리에서 펼친다 (2026-08-07 사용자 요청).
        //  프로젝트 전용 능력은 **프로젝트 레벨에서만** 관리한다 — 전역 인벤토리로 보내지
        //  않는다(거기 없는 것들이고, 섞으면 "메인 대화에서도 쓸 수 있다" 는 오해가 난다).
        //  본문은 **누를 때만** 가져오고(목록 로드 비대화 0) 한 번 받으면 DOM 에 남긴다.
        const loadCapabilityBody = async (kind, name, box) => {
          box.textContent = "불러오는 중…";
          try {
            const r = await fetch(
              "/api/projects/capability?path=" + encodeURIComponent(projectPath) +
              "&kind=" + encodeURIComponent(kind) + "&name=" + encodeURIComponent(name),
            );
            const d = await r.json();
            if (!r.ok || !d || typeof d.body !== "string") {
              box.textContent = (d && d.error) || "본문을 불러오지 못했습니다.";
              return;
            }
            box.innerHTML = "";
            const md = document.createElement("div");
            md.className = "chat-message md";
            setChatBody(md, d.body, true);
            box.appendChild(md);
          } catch (e) {
            box.textContent = "본문을 불러오지 못했습니다: " + (e && e.message ? e.message : e);
          }
        };

        const listSection = (title, items, kind) => {
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
              // 스킬·에이전트만 펼침(MCP 는 파일 본문이 없다 — 설정 한 줄이라 이미 다 보인다).
              if (kind === "skill" || kind === "agent") {
                row.classList.add("pd-item-open");
                row.title = "눌러서 본문 보기";
                const body = document.createElement("div");
                body.className = "pd-item-body";
                body.style.display = "none";
                let loaded = false;
                row.addEventListener("click", () => {
                  const showing = body.style.display !== "none";
                  body.style.display = showing ? "none" : "";
                  row.classList.toggle("expanded", !showing);
                  if (!showing && !loaded) {
                    loaded = true;
                    void loadCapabilityBody(kind, it.name, body);
                  }
                });
                row.appendChild(body);
              }
              list.appendChild(row);
            }
            sec.appendChild(list);
          }
          panel.appendChild(sec);
        };

        listSection("🛠️ 전용 스킬", detail.skills, "skill");
        listSection("🤖 전용 에이전트", detail.agents, "agent");
        // 전용 MCP — 이 프로젝트로 위임할 때만 노출되는 프로젝트 스코프 MCP(<project>/.mcp.json).
        listSection(
          "🧩 전용 MCP",
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

