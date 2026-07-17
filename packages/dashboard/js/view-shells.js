      // ── 셸/프로세스 뷰(왼쪽 nav 1급 destination) — 표면 C+D(ADR 2026-07-17 §5).
      // view-agents.js 클론(카드 그리드·경과 틱·상태 배지) — 별도 레인(P2 계약: shell.started/
      // shell.exited, GET /api/shells·/api/shell-output·POST /api/kill-shell). 워커/에이전트
      // jobCards 와 완전 분리된 자체 registry(shellRegistry) — 이 파일 하나로 자기완결
      // (ADR §2 "레지스트리 분리" — worker_jobs 아님, in-memory BG_SHELLS 미러).
      // codex/openai=프로세스 우리 소유(GET /api/shells 시드+kill/tail 완전). claude=SDK 내부
      // 소유라 Phase 4 관측 브리지(SSE shell.*, owner:"sdk"·killable:false)로만 라이브 유입 —
      // /api/shells 시드엔 없음(BG_SHELLS 밖), kill/tail 정직 미지원(Phase 3b, ADR §6).
      const SHELL_STATUS_LABEL = { running: "🟡 실행 중", exited: "✅ 종료", killed: "⏹ 중지됨" };
      const SHELL_MAX = 50; // 레지스트리 상한(메모리 바운드) — capBgList 동형.
      const SHELL_TAIL_POLL_MS = 1500; // 표면 D 폴 간격(고volume 방어, ADR §5).
      const SHELL_DEBOUNCE_MS = 800; // 단명 셸 노이즈 방지(ADR §5) — running 지속 시에만 그리드 노출.
      const shellRegistry = new Map(); // shellId -> entry(아래 upsertShellEntry 참조)
      const shellElapsedEls = new Map(); // shellId -> elapsed span(틱 갱신용, 렌더마다 재구성).
      const shellOutputEls = new Map(); // shellId -> <pre> el(폴링이 쓰는 대상, 렌더마다 재구성).
      const shellTailLineEls = new Map(); // shellId -> tail-line span(폴 결과 직접 갱신, 풀 리렌더 없이).
      const shellPollTimers = new Map(); // shellId -> intervalId(표면 D, 펼침 카드만).
      let shellsFilter = "running"; // "running" | "all"

      // /api/shells(listShells) 는 내부 status "running"|"completed"|"killed" 를 그대로 낸다
      // (BgShellSnapshot). 라이브 shell.exited 이벤트는 status "exited"|"killed" 를 쓴다(ADR §1).
      // 두 어휘를 이 뷰의 공통 상태값("running"|"exited"|"killed")으로 정규화.
      const normalizeSeedStatus = (raw) => (raw === "completed" ? "exited" : raw === "killed" ? "killed" : "running");

      const upsertShellEntry = (shellId, patch, opts) => {
        let e = shellRegistry.get(shellId);
        if (!e) {
          e = {
            shellId, command: "", cwd: "", status: "running", startedAt: Date.now(),
            threadKey: "", exitCode: null, expanded: false, killRequested: false,
            visible: !!(opts && opts.visible), lastLine: "",
            // owner/killable(Phase 3b, ADR §6) — 부재=killable:true(codex/openai, 프로세스 우리
            // 소유·⏹️ 가능). owner:"sdk"/killable:false(claude 관측 브리지)=⏹️ 비활성·SDK 표식.
            owner: null, killable: true,
          };
          shellRegistry.set(shellId, e);
        }
        Object.assign(e, patch);
        if (opts && opts.visible) e.visible = true;
        return e;
      };

      const capShellRegistry = () => {
        if (shellRegistry.size <= SHELL_MAX) return;
        const term = [...shellRegistry.values()]
          .filter((e) => e.status !== "running")
          .sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
        while (shellRegistry.size > SHELL_MAX && term.length) {
          const victim = term.shift();
          stopShellTailPoll(victim.shellId);
          shellRegistry.delete(victim.shellId);
        }
      };

      // 헤더 nav 배지("🖥️ 셸")는 뷰가 닫혀 있어도 항상 최신 — background-drawer.js 의
      // refreshBgBadge(nav-agent-count) 와 동형(뷰 오픈 무관 상시 갱신).
      const updateShellsBadge = () => {
        let running = 0;
        for (const e of shellRegistry.values()) {
          if (!e.visible) continue;
          if (e.status === "running") running += 1;
        }
        const navCount = document.getElementById("nav-shell-count");
        if (navCount) navCount.textContent = String(running);
      };

      // owner/killable 정규화 — 계약(ADR §6): 필드 부재 = killable:true(codex/openai). claude
      // 관측 브리지는 owner:"sdk"·killable:false 를 명시 payload 로 실어 보낸다(claude-agent-sdk.ts
      // publishClaudeShellEvent). p.killable===false 만 false 로, 그 외(undefined 포함)는 true.
      const normalizeShellOwner = (p) => ({
        owner: p && p.owner ? p.owner : null,
        killable: !!(p && p.killable === false) ? false : true,
      });

      const handleShellStarted = (p, ts) => {
        if (!p || !p.shellId) return;
        const own = normalizeShellOwner(p);
        const e = upsertShellEntry(p.shellId, {
          command: p.command || "", cwd: p.cwd || "", status: "running",
          startedAt: p.startedAt || ts || Date.now(), threadKey: p.threadKey || "", exitCode: null,
          owner: own.owner, killable: own.killable,
        });
        capShellRegistry();
        if (!e.visible) {
          // 단명 셸 디바운스 — SHELL_DEBOUNCE_MS 뒤에도 여전히 running(또는 이미 종료돼
          // handleShellExited 가 먼저 visible 로 만들었으면 이 타이머는 no-op)이면 노출.
          setTimeout(() => {
            const cur = shellRegistry.get(p.shellId);
            if (cur && !cur.visible) { cur.visible = true; updateShellsBadge(); scheduleShellsRender(); }
          }, SHELL_DEBOUNCE_MS);
        }
        updateShellsBadge();
        scheduleShellsRender();
        // 표면 A/B 훅(Phase 3b, cross-file — virtualization.js/background-drawer.js 가 이
        // 파일보다 늦게 로드돼도 호출 시점(SSE 이벤트, 부팅 완료 후)엔 이미 정의돼 있다.
        if (typeof syncShellChip === "function") syncShellChip(p.shellId);
        if (typeof refreshShellStrip === "function") refreshShellStrip();
      };

      const handleShellExited = (p, ts) => {
        if (!p || !p.shellId) return;
        const own = normalizeShellOwner(p);
        const e = upsertShellEntry(p.shellId, {
          command: p.command || "", cwd: p.cwd || "",
          status: p.status === "killed" ? "killed" : "exited",
          exitCode: p.exitCode != null ? p.exitCode : null, threadKey: p.threadKey || "",
          owner: own.owner, killable: own.killable,
        });
        e.visible = true; // 이미 결론난 상태라 더 이상 깜빡임 리스크 없음(ADR §5 취지).
        e.killRequested = false;
        stopShellTailPoll(p.shellId); // 폴링 중이면 다음 tick 에 status 재확인해 멈추지만, 즉시도 정지.
        updateShellsBadge();
        scheduleShellsRender();
        if (typeof syncShellChip === "function") syncShellChip(p.shellId);
        if (typeof refreshShellStrip === "function") refreshShellStrip();
      };

      // sse.js 가 "shell." 접두 이벤트 타입 전부를 이리로 라우팅(worker.* → handleWorkerEvent 동형).
      const handleShellEvent = (type, p, ts) => {
        if (type === "shell.started") return handleShellStarted(p, ts);
        if (type === "shell.exited") return handleShellExited(p, ts);
      };

      // 표면 D — 비소비 tail 폴링(GET /api/shell-output?id=). 펼친 카드만, running 아니면 정지.
      const stopShellTailPoll = (shellId) => {
        const t = shellPollTimers.get(shellId);
        if (t) { clearInterval(t); shellPollTimers.delete(shellId); }
      };
      const startShellTailPoll = (shellId) => {
        if (shellPollTimers.has(shellId)) return; // 이미 폴링 중(멱등).
        const poll = () => {
          const entry = shellRegistry.get(shellId);
          const outEl = shellOutputEls.get(shellId);
          // 카드가 재렌더로 사라졌거나(접힘·필터 변경) DOM 이탈했으면 폴링 중단.
          if (!entry || !entry.expanded || !outEl || !document.body.contains(outEl)) {
            stopShellTailPoll(shellId);
            return;
          }
          fetch("/api/shell-output?id=" + encodeURIComponent(shellId))
            .then((r) => r.json())
            .then((d) => {
              const stillEl = shellOutputEls.get(shellId);
              if (!stillEl || !document.body.contains(stillEl)) { stopShellTailPoll(shellId); return; }
              if (!d || d.error) {
                stillEl.textContent = "(출력 없음" + (d && d.error ? ": " + d.error : "") + ")";
                stopShellTailPoll(shellId);
                return;
              }
              const parts = [];
              if (d.stdout) parts.push(d.stdout);
              if (d.stderr) parts.push("\n[stderr]\n" + d.stderr);
              const combined = parts.join("") || "(출력 없음)";
              stillEl.textContent = combined;
              stillEl.scrollTop = stillEl.scrollHeight;
              // 마지막 출력 꼬리 1줄(카드 컴팩트 표시용) — 비어있지 않은 마지막 줄만. 풀 그리드
              // 리렌더(scheduleShellsRender) 없이 DOM 직접 갱신 — 폴 tick 마다 grid.innerHTML
              // 재구성하면 <pre> 스크롤·다른 카드 상태가 흔들린다(agent-card 패턴과 달리 여긴
              // 라이브 필드가 렌더 밖에서도 갱신돼야 해 elapsed 틱과 동일하게 el 참조 직접 갱신).
              const lines = combined.split("\n").map((l) => l.trim()).filter(Boolean);
              if (lines.length) {
                entry.lastLine = lines[lines.length - 1];
                const tlEl = shellTailLineEls.get(shellId);
                if (tlEl) tlEl.textContent = entry.lastLine;
              }
              const cur = shellRegistry.get(shellId);
              if (cur && cur.status !== "running") stopShellTailPoll(shellId); // 종료 확인 → 폴 정지.
            })
            .catch(() => { stopShellTailPoll(shellId); });
        };
        poll();
        shellPollTimers.set(shellId, setInterval(poll, SHELL_TAIL_POLL_MS));
      };

      const toggleShellExpand = (shellId) => {
        const e = shellRegistry.get(shellId);
        if (!e) return;
        e.expanded = !e.expanded;
        if (!e.expanded) stopShellTailPoll(shellId);
        scheduleShellsRender();
      };

      // ⏹️ Kill — POST /api/kill-shell {shellId} (낙관 UI, cancel-worker 버튼 패턴 답습).
      // 실제 종료 반영은 shell.exited SSE(handleShellExited) 가 한다. 가짜 id → killed:false
      // (백엔드 no-op) → 낙관 표시 되돌림.
      const requestKillShell = async (shellId) => {
        const entry = shellRegistry.get(shellId);
        // killable:false(claude SDK 소유, ADR §6) — 카드/칩이 ⏹️ 를 안 그려도 이중 방어(cosmetic
        // 버튼 금지는 U-I4 교훈 — 실수로 호출돼도 여기서 하드 거부, 서버도 no-op 이나 조용히).
        if (!entry || entry.status !== "running" || entry.killRequested || entry.killable === false) return;
        entry.killRequested = true;
        scheduleShellsRender();
        if (typeof syncShellChip === "function") syncShellChip(shellId); // 표면 A 칩도 즉시 낙관 반영.
        const revert = () => {
          entry.killRequested = false;
          scheduleShellsRender();
          if (typeof syncShellChip === "function") syncShellChip(shellId);
        };
        try {
          const res = await fetch("/api/kill-shell", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ shellId }),
          });
          const data = res.ok ? await res.json().catch(() => null) : null;
          if (!data || data.ok !== true) revert();
        } catch (err) {
          revert();
          console.warn("kill-shell 요청 실패:", err && err.message ? err.message : err);
        }
      };

      const fmtShellCwd = (cwd) => {
        if (!cwd) return "";
        return cwd.length > 48 ? "…" + cwd.slice(-47) : cwd;
      };

      const buildShellCard = (entry, now) => {
        const card = document.createElement("div");
        card.className = "agent-card shell-card " + entry.status;
        card.dataset.shellId = entry.shellId;
        const top = document.createElement("div"); top.className = "agent-card-top";
        const kind = document.createElement("span"); kind.className = "agent-card-kind";
        kind.textContent = "🖥️ 셸";
        top.appendChild(kind);
        const st = document.createElement("span"); st.className = "agent-card-status";
        st.textContent = SHELL_STATUS_LABEL[entry.status] || entry.status;
        top.appendChild(st);
        // SDK 소유 표식(Phase 3b, ADR §6) — claude 관측 브리지 셸(owner:"sdk")은 우리가 pid 를
        // 모른다 — kill/출력 tail 불가를 카드에서 정직히 노출(cosmetic ⏹️ 금지, U-I4 교훈).
        if (entry.owner === "sdk") {
          const ownerBadge = document.createElement("span"); ownerBadge.className = "shell-card-owner";
          ownerBadge.textContent = "SDK 소유";
          ownerBadge.title = "claude 백그라운드 셸은 SDK 내부 소유 — 강제 종료·출력 tail 불가(대화 턴 안에서만 제어).";
          top.appendChild(ownerBadge);
        }
        card.appendChild(top);
        const name = document.createElement("div"); name.className = "agent-card-name shell-card-command";
        name.textContent = entry.command || "(명령 없음)";
        card.appendChild(name);
        if (entry.cwd) {
          const cwd = document.createElement("div"); cwd.className = "shell-card-cwd";
          cwd.textContent = fmtShellCwd(entry.cwd);
          cwd.title = entry.cwd;
          card.appendChild(cwd);
        }
        const meta = document.createElement("div"); meta.className = "agent-card-meta";
        const el = document.createElement("span"); el.className = "agent-card-elapsed";
        el.textContent = fmtElapsed(now - (entry.startedAt || now));
        if (entry.status === "running") shellElapsedEls.set(entry.shellId, el);
        meta.appendChild(el);
        if (entry.status !== "running" && entry.exitCode != null) {
          const codeEl = document.createElement("span"); codeEl.className = "shell-card-exitcode";
          codeEl.textContent = "exit " + entry.exitCode;
          meta.appendChild(codeEl);
        }
        card.appendChild(meta);
        // 마지막 출력 꼬리(1줄) — 최소 한 번 펼쳐 폴링한 적 있어야 채워짐(전 카드 상시 폴링은
        // 백엔드 부하라 안 함, ADR §5 "폴 간격 바운드"). 없으면 안내만.
        const tailLine = document.createElement("div"); tailLine.className = "shell-card-tailline";
        tailLine.textContent = entry.lastLine || "(출력 미리보기 없음 — 펼쳐서 확인)";
        shellTailLineEls.set(entry.shellId, tailLine); // 폴 결과가 직접 갱신(위 startShellTailPoll).
        card.appendChild(tailLine);
        const controls = document.createElement("div"); controls.className = "shell-card-controls";
        // 출력 tail(표면 D) — SDK 소유 셸은 BG_SHELLS 밖이라 /api/shell-output 이 항상 404(정직한
        // 한계, ADR §6) → 토글 자체를 안 그려 헛수고 폴 0(entry.expanded 도 영영 false 라 no-op).
        if (entry.owner !== "sdk") {
          const toggleBtn = document.createElement("button");
          toggleBtn.type = "button"; toggleBtn.className = "shell-card-toggle";
          toggleBtn.textContent = entry.expanded ? "▾ 출력 접기" : "▸ 출력 보기";
          toggleBtn.addEventListener("click", (ev) => { ev.stopPropagation(); toggleShellExpand(entry.shellId); });
          controls.appendChild(toggleBtn);
        }
        if (entry.status === "running") {
          if (entry.killable === false) {
            // killable:false(claude SDK 소유) — ⏹️ 를 cosmetic 으로 달지 않는다(U-I4 하드 위반
            // 경고: "표시만 되고 안 멈춤"). 대신 정직한 안내만.
            const note = document.createElement("span"); note.className = "shell-card-kill-disabled";
            note.textContent = "⏹️ SDK 소유(자동 종료)";
            note.title = "claude 백그라운드 셸은 대화 턴 안에서만 제어됩니다(모델의 KillShell 도구로).";
            controls.appendChild(note);
          } else {
            const killBtn = document.createElement("button");
            killBtn.type = "button"; killBtn.className = "bg-job-stop shell-card-kill";
            killBtn.title = "셸 강제 종료";
            killBtn.disabled = entry.killRequested;
            killBtn.textContent = entry.killRequested ? "중지 요청…" : "⏹️ Kill";
            killBtn.addEventListener("click", (ev) => { ev.stopPropagation(); void requestKillShell(entry.shellId); });
            controls.appendChild(killBtn);
          }
        }
        card.appendChild(controls);
        if (entry.expanded) {
          const out = document.createElement("pre"); out.className = "shell-card-output";
          out.textContent = "출력을 불러오는 중…";
          card.appendChild(out);
          shellOutputEls.set(entry.shellId, out);
          startShellTailPoll(entry.shellId);
        }
        return card;
      };

      const renderShellsView = () => {
        if (currentView !== "shells") return;
        const grid = document.getElementById("shells-grid");
        const empty = document.getElementById("shells-empty");
        if (!grid) return;
        grid.innerHTML = "";
        shellElapsedEls.clear();
        shellOutputEls.clear();
        shellTailLineEls.clear();
        const now = Date.now();
        let running = 0, total = 0, shown = 0;
        const entries = [...shellRegistry.values()].filter((e) => e.visible);
        entries.sort((a, b) => {
          const ra = a.status === "running" ? 0 : 1;
          const rb = b.status === "running" ? 0 : 1;
          if (ra !== rb) return ra - rb;
          return (b.startedAt || 0) - (a.startedAt || 0);
        });
        for (const e of entries) {
          total += 1;
          if (e.status === "running") running += 1;
          if (shellsFilter === "running" && e.status !== "running") continue;
          shown += 1;
          grid.appendChild(buildShellCard(e, now));
        }
        const rc = document.getElementById("shells-count-running");
        const ac = document.getElementById("shells-count-all");
        if (rc) rc.textContent = String(running);
        if (ac) ac.textContent = String(total);
        if (empty) {
          empty.style.display = shown === 0 ? "" : "none";
          empty.textContent = shellsFilter === "running" ? "실행 중인 셸이 없습니다." : "관측된 셸이 없습니다.";
        }
      };
      let shellsRenderQueued = false;
      const scheduleShellsRender = () => {
        if (currentView !== "shells" || shellsRenderQueued) return;
        shellsRenderQueued = true;
        requestAnimationFrame(() => { shellsRenderQueued = false; renderShellsView(); });
      };

      const setShellsFilter = (mode) => {
        shellsFilter = mode === "all" ? "all" : "running";
        const bar = document.getElementById("shells-filter");
        if (bar) for (const b of bar.querySelectorAll(".bg-fbtn")) {
          const on = b.dataset.filter === shellsFilter;
          b.classList.toggle("active", on);
          b.setAttribute("aria-pressed", on ? "true" : "false");
        }
        renderShellsView();
      };

      // 뷰 오픈 시 GET /api/shells 시드(ADR §5 "C — 뷰 오픈 시 list 엔드포인트 시드"). 시드된
      // 셸은 이미 존재가 확정돼 있으므로 디바운스 없이 즉시 visible.
      const fetchShellsSeed = () => {
        fetch("/api/shells").then((r) => r.json()).then((d) => {
          if (!d || !Array.isArray(d.shells)) return;
          for (const s of d.shells) {
            if (!s || !s.shellId) continue;
            upsertShellEntry(s.shellId, {
              command: s.command || "", cwd: s.cwd || "", status: normalizeSeedStatus(s.status),
              startedAt: s.startedAt || Date.now(), threadKey: s.threadKey || "",
              exitCode: s.exitCode != null ? s.exitCode : null,
            }, { visible: true });
          }
          capShellRegistry();
          updateShellsBadge();
          scheduleShellsRender();
        }).catch(() => { /* 미도달 — SSE 로 채워짐 */ });
      };

      const showShells = () => {
        setActiveNav("shells");
        setChatPanel("chat");
        document.getElementById("workbench").classList.remove("show-providers");
        const root = document.getElementById("detail-panel");
        root.innerHTML = "";
        const wrap = document.createElement("div");
        wrap.className = "page-view shells-view";
        wrap.innerHTML =
          '<div class="detail-head"><div class="detail-accent active"></div><div class="detail-name">셸 / 프로세스</div><span class="detail-kind">실시간</span></div>' +
          '<p class="developer-copy">모델이 백그라운드로 띄운 셸(Bash) 프로세스를 관측합니다. codex/openai 셸은 강제 종료·출력 확인 가능. claude 셸(SDK 소유)은 실시간으로 표시만 되며 이 목록엔 사후 시드되지 않습니다 — "SDK 소유" 표식.</p>' +
          '<div class="agents-toolbar" id="shells-toolbar">' +
          '<div class="bg-filter" id="shells-filter">' +
          '<button class="bg-fbtn active" type="button" data-filter="running" aria-pressed="true">실행 중 <span class="bg-fcount" id="shells-count-running">0</span></button>' +
          '<button class="bg-fbtn" type="button" data-filter="all" aria-pressed="false">전체 <span class="bg-fcount" id="shells-count-all">0</span></button>' +
          '</div><span class="agents-hint">라이브 · GET /api/shells 시드</span></div>' +
          '<div class="agents-grid shells-grid filter-running" id="shells-grid"></div>' +
          '<div class="empty" id="shells-empty">실행 중인 셸이 없습니다.</div>';
        root.appendChild(wrap);
        const bar = wrap.querySelector("#shells-filter");
        for (const b of bar.querySelectorAll(".bg-fbtn")) {
          b.addEventListener("click", () => setShellsFilter(b.dataset.filter));
        }
        shellsFilter = "running";
        renderShellsView();
        fetchShellsSeed();
      };

      // 경과시간 라이브 틱(1s) — running 카드만(background-drawer.js tickElapsed 동형, 별도 셋).
      setInterval(() => {
        if (currentView !== "shells") return;
        const now = Date.now();
        for (const [shellId, e] of shellRegistry) {
          if (e.status !== "running") continue;
          const el = shellElapsedEls.get(shellId);
          if (el) el.textContent = fmtElapsed(now - (e.startedAt || now));
        }
      }, 1000);

      // 부팅 하이드레이션 — nav 배지("🖥️ 셸" running 카운트)가 뷰를 한 번도 안 열어도
      // 최신이게. hydrateActiveJobs(background-drawer.js) 동형.
      fetchShellsSeed();
