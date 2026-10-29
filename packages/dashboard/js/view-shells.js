      // ── 셸/프로세스 섹션(백그라운드 드로어 안, background-drawer.js #bg-shells-list) —
      // 표면 C+D(ADR 2026-07-17 §5). ★Phase 3b-2: 왼쪽 nav 🖥️ 셸 top-nav 는 제거됐다 — 이
      // 파일은 이제 페이지 뷰가 아니라 드로어 안 별도 섹션을 그린다(showShells()는 openBg()로
      // 드로어를 열 뿐). 카드 그리드·경과 틱·상태 배지 로직(view-agents.js 클론)과 shell.started/
      // shell.exited, GET /api/shells·/api/shell-output·POST /api/kill-shell 계약은 그대로.
      // 매니저/에이전트 jobCards 와 완전 분리된 자체 registry(shellRegistry) — 이 파일 하나로
      // 자기완결(ADR §2 "레지스트리 분리" — worker_jobs 아님, in-memory BG_SHELLS 미러).
      // codex/openai=프로세스 우리 소유(GET /api/shells 시드+kill/tail 완전). claude=SDK 내부
      // 소유라 Phase 4 관측 브리지(SSE shell.*, owner:"sdk"·killable:false)로만 라이브 유입 —
      // /api/shells 시드엔 없음(BG_SHELLS 밖), kill/tail 정직 미지원(Phase 3b, ADR §6).
      const SHELL_STATUS_LABEL = { running: i18n("shell.status.running"), exited: i18n("shell.status.exited"), killed: i18n("shell.status.stopped") };
      const SHELL_MAX = 50; // 레지스트리 상한(메모리 바운드) — capBgList 동형.
      const SHELL_TAIL_POLL_MS = 1500; // 표면 D 폴 간격(고volume 방어, ADR §5).
      const SHELL_DEBOUNCE_MS = 800; // 단명 셸 노이즈 방지(ADR §5) — running 지속 시에만 그리드 노출.
      const shellRegistry = new Map(); // shellId -> entry(아래 upsertShellEntry 참조)
      const shellElapsedEls = new Map(); // shellId -> elapsed span(틱 갱신용, 렌더마다 재구성).
      const shellOutputEls = new Map(); // shellId -> <pre> el(폴링이 쓰는 대상, 렌더마다 재구성).
      const shellTailLineEls = new Map(); // shellId -> tail-line span(폴 결과 직접 갱신, 풀 리렌더 없이).
      const shellPollTimers = new Map(); // shellId -> { outEl, timer }(출력 DOM 세대 소유자).
      let shellsFilter = "running"; // "running" | "done"(완료=exited/killed, 상호배타)

      // /api/shells(listShells) 는 내부 status "running"|"completed"|"killed" 를 그대로 낸다
      // (BgShellSnapshot). 라이브 shell.exited 이벤트는 status "exited"|"killed" 를 쓴다(ADR §1).
      // 두 어휘를 이 뷰의 공통 상태값("running"|"exited"|"killed")으로 정규화.
      const normalizeSeedStatus = (raw) => (raw === "completed" ? "exited" : raw === "killed" ? "killed" : "running");

      /** 되돌릴 수 없는 셸 종료 상태 — 잡 카드(TERMINAL_JOB_STATUS)와 같은 규칙. */
      const TERMINAL_SHELL_STATUS = new Set(["exited", "killed"]);
      const upsertShellEntry = (shellId, patch, opts) => {
        let e = shellRegistry.get(shellId);
        // ★셸 상태도 단조다 (2026-07-29 검토). 매니저 잡엔 넣었는데 셸엔 안 넣어서,
        //  재연결 replay 가 옛 shell.started 를 흘리면 **종료된 셸이 running 으로
        //  되돌아갔고**(CDP 실측) 셸엔 하이드레이션 대조도 없어 영영 유령으로 남았다.
        if (
          e !== undefined &&
          TERMINAL_SHELL_STATUS.has(e.status) &&
          patch && patch.status === "running"
        ) {
          return e; // 종료는 되돌리지 않는다.
        }
        if (!e) {
          e = {
            shellId, command: "", cwd: "", status: "running", startedAt: Date.now(),
            threadKey: "", ownerTk: "", exitCode: null, cardOpen: true, expanded: false, killRequested: false,
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

      // nav 배지(레거시) — Phase 3b-2(ADR §5)로 🖥️ 셸 top-nav 자체가 사라져 엘리먼트가 없다.
      // getElementById 가드로 무해(nav-agent-count 의 동일 전례). 드로어 셸 섹션 카운트(#bg-shells-
      // count-running/-all)는 renderShellsView 가 필터 반영 실카운트로 갱신(아래).
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

      /**
       * 서버가 준 **사실만** 패치에 싣는다 (2026-10-23) — 숫자 시작·끝 시각, 비지 않은 설명(Bash `description`).
       *  ★없는 값이 이미 받은 값을 지우지 않는다: 같은 셸의 통지가 설명·시각을 실은 것과 안 실은 것(리퍼 stale·`run:`·옛 페이로드)으로
       *   섞여 오는데, `Object.assign` 에 그냥 얹으면 뒤에 온 빈 값이 지웠다. 시작 시각을 안 실으면 빈 화면에 종료 통지 하나로 생긴
       *   카드가 **받은 시각**을 시작으로 써 `끝 − 시작` 이 음수(→ 0s)가 됐다(GPT 설계 검토 10-23).
       */
      const shellFactPatch = (p) => {
        const out = {};
        if (typeof p.startedAt === "number") out.startedAt = p.startedAt;
        if (typeof p.finishedAt === "number") out.endedAt = p.finishedAt;
        if (typeof p.description === "string" && p.description !== "") out.description = p.description;
        return out;
      };
      /** 끝났는데 끝 시각을 모르면(옛 페이로드·리퍼 stale) **처음 끝난 걸 본 때**로 멈춘다 — 잡 카드와 같은 규칙. 뒤에 온 서버 값은 `shellFactPatch` 가 덮는다. */
      const settleShellEnd = (e) => {
        if (e && e.status !== "running" && typeof e.endedAt !== "number") e.endedAt = Date.now();
      };
      /** 셸 카드 경과 — 끝났으면 끝 시각까지(«완료 시간 고정», 10-23 — 종전엔 다시 그릴 때마다 자랐다). */
      const shellElapsedMs = (e, now) => {
        const end = e.status !== "running" && typeof e.endedAt === "number" ? e.endedAt : now;
        return end - (e.startedAt || end);
      };

      const handleShellStarted = (p, ts) => {
        if (!p || !p.shellId) return;
        const own = normalizeShellOwner(p);
        const e = upsertShellEntry(p.shellId, {
          command: p.command || "", cwd: p.cwd || "", status: "running",
          threadKey: p.threadKey || "", exitCode: null,
          ownerTk: typeof p.ownerThreadKey === "string" ? p.ownerThreadKey : "", // 서버 환원 원 세션.
          owner: own.owner, killable: own.killable,
          ...shellFactPatch(p),
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
          ownerTk: typeof p.ownerThreadKey === "string" ? p.ownerThreadKey : "", // 서버 환원 원 세션.
          owner: own.owner, killable: own.killable,
          ...shellFactPatch(p),
        });
        settleShellEnd(e);
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
      const stopShellTailPoll = (shellId, owner) => {
        const current = shellPollTimers.get(shellId);
        if (!current || (owner && current !== owner)) return;
        if (current.timer !== null) clearInterval(current.timer);
        shellPollTimers.delete(shellId);
      };
      const shellInCurrentScope = (entry) => {
        const scoped = typeof bgSessionScope !== "undefined" && bgSessionScope === "session" &&
          typeof isShellInScope === "function";
        return !scoped || isShellInScope(entry.threadKey, entry.ownerTk);
      };
      const shellPassesFilter = (entry) => shellsFilter === "running" ? entry.status === "running" : entry.status !== "running";
      const shellTailVisible = (entry, outEl) => {
        const head = document.getElementById("bg-shells-head");
        return !!(entry && entry.visible && entry.cardOpen && entry.expanded && entry.owner !== "sdk" &&
          shellInCurrentScope(entry) && shellPassesFilter(entry) &&
          outEl && document.body.contains(outEl) && !(head && head.classList.contains("collapsed")));
      };
      const stopHiddenShellTailPolls = () => {
        for (const [shellId, owner] of shellPollTimers) {
          if (!shellTailVisible(shellRegistry.get(shellId), owner.outEl)) stopShellTailPoll(shellId, owner);
        }
      };
      const startShellTailPoll = (shellId) => {
        if (shellPollTimers.has(shellId)) return;
        const outEl = shellOutputEls.get(shellId);
        if (!shellTailVisible(shellRegistry.get(shellId), outEl)) return;
        // 최초 GET보다 먼저 등록한다. 재렌더/접힘 뒤 도착한 옛 응답은 새 세대를 건드리지 못한다.
        const owner = { outEl, timer: null };
        shellPollTimers.set(shellId, owner);
        const ownsOutput = () => shellPollTimers.get(shellId) === owner &&
          shellOutputEls.get(shellId) === outEl && shellTailVisible(shellRegistry.get(shellId), outEl);
        const poll = () => {
          if (!ownsOutput()) { stopShellTailPoll(shellId, owner); return; }
          fetch("/api/shell-output?id=" + encodeURIComponent(shellId))
            .then((r) => r.json())
            .then((d) => {
              if (!ownsOutput()) { stopShellTailPoll(shellId, owner); return; }
              if (typeof bgGeometryChanged === "function") bgGeometryChanged();
              if (!d || d.error) {
                outEl.textContent = d && d.error
                  ? i18n("shell.noOutputWhy", { err: d.error })
                  : i18n("shell.noOutput");
                stopShellTailPoll(shellId, owner);
                return;
              }
              const parts = [];
              if (d.stdout) parts.push(d.stdout);
              if (d.stderr) parts.push("\n[stderr]\n" + d.stderr);
              const combined = parts.join("") || i18n("shell.noOutput");
              outEl.textContent = combined;
              outEl.scrollTop = outEl.scrollHeight;
              const entry = shellRegistry.get(shellId);
              const lines = combined.split("\n").map((l) => l.trim()).filter(Boolean);
              if (lines.length) {
                entry.lastLine = lines[lines.length - 1];
                const tlEl = shellTailLineEls.get(shellId);
                if (tlEl) tlEl.textContent = entry.lastLine;
              }
              if (entry.status !== "running") stopShellTailPoll(shellId, owner);
            })
            .catch(() => { stopShellTailPoll(shellId, owner); });
        };
        poll();
        // 종료된 셸은 부착 뒤 최초 조회 1회만. running인 같은 세대에만 timer 하나.
        if (shellRegistry.get(shellId).status === "running" && shellPollTimers.get(shellId) === owner) {
          owner.timer = setInterval(poll, SHELL_TAIL_POLL_MS);
        }
      };

      const toggleShellExpand = (shellId) => {
        const e = shellRegistry.get(shellId);
        if (!e) return;
        stopShellTailPoll(shellId);
        e.expanded = !e.expanded;
        scheduleShellsRender();
      };
      const toggleShellCard = (shellId) => {
        const e = shellRegistry.get(shellId);
        if (!e) return;
        stopShellTailPoll(shellId);
        e.cardOpen = !e.cardOpen;
        renderShellsView(shellId);
      };

      // ⏹️ Kill — POST /api/kill-shell {shellId} (낙관 UI, cancel-worker 버튼 패턴 답습).
      // 실제 종료 반영은 shell.exited SSE(handleShellExited) 가 한다. 가짜 id → killed:false
      // (백엔드 no-op) → 낙관 표시 되돌림.
      const requestKillShell = async (shellId) => {
        const entry = shellRegistry.get(shellId);
        // killable:false(claude SDK 소유, ADR §6) — 카드/칩이 ⏹️ 를 안 그려도 이중 방어(cosmetic
        // 버튼 금지는 U-I4 교훈 — 실수로 호출돼도 여기서 하드 거부, 서버도 no-op 이나 조용히).
        if (!entry || entry.status !== "running" || entry.killRequested || entry.killable === false) return;
        // ★강제 종료는 **먼저 묻는다** (2026-10-09 적대 검토) — 카드의 ⏹ 가 한 번에 실행됐다(잡 ⋯ 메뉴의 «중지» 는 묻는데).
        //  버튼이 아니라 여기 둔다: 셸을 죽이는 문은 카드·채팅 칩 둘이고 둘 다 이 함수로 온다(메뉴 경로는 없다 — 두 번 묻지 않는다).
        if (!window.confirm(i18n("ctx.confirm", { what: i18n("common.shell.kill") }))) return;
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
        // «그 카드로» 의 강조는 **항목의 상태**다 — 셸 목록은 출력이 올 때마다 통째로 다시 그려 노드에 붙인 강조가 곧바로 사라졌다(헤드리스 10-21).
        if (typeof entry.flashUntil === "number" && entry.flashUntil > Date.now()) card.classList.add("bg-flash");
        card.dataset.shellId = entry.shellId;
        const top = document.createElement("div"); top.className = "agent-card-top";
        // ★설명(Bash `description`)이 있을 때만 맨 윗줄 첫 칸에 이름 (2026-10-23) — 나머지 줄(명령·폴더·경과·종료 코드·꼬리·토글·Kill)은
        //  그대로다(사용자: «기존 표시는 그대로 두고 라벨만 보완»). 없으면 지금 카드와 DOM 이 같다.
        if ((typeof entry.description === "string" && entry.description !== "") || !entry.cardOpen) {
          const label = document.createElement("span"); label.className = "shell-card-label";
          label.textContent = entry.description || entry.command || i18n("shell.noCommand");
          label.title = label.textContent;
          top.appendChild(label);
        }
        const kind = document.createElement("span"); kind.className = "agent-card-kind";
        kind.textContent = i18n("shell.badge");
        top.appendChild(kind);
        const st = document.createElement("span"); st.className = "agent-card-status";
        st.textContent = SHELL_STATUS_LABEL[entry.status] || entry.status;
        top.appendChild(st);
        // SDK 소유 표식(Phase 3b, ADR §6) — claude 관측 브리지 셸(owner:"sdk")은 우리가 pid 를
        // 모른다 — kill/출력 tail 불가를 카드에서 정직히 노출(cosmetic ⏹️ 금지, U-I4 교훈).
        if (entry.owner === "sdk") {
          const ownerBadge = document.createElement("span"); ownerBadge.className = "shell-card-owner";
          ownerBadge.textContent = i18n("common.shell.sdkOwned");
          ownerBadge.title = i18n("shell.sdkOwned.long");
          top.appendChild(ownerBadge);
        }
        // 어느 세션이 띄운 셸인가 (2026-07-28) — 이 뷰는 세션 필터 없는 *전체 인벤토리* 라
        // (작업관리자 성격) 필터 대신 **귀속을 명시**한다. 근거는 서버 환원값(ownerTk) 우선,
        // 없으면 프런트 환원. 매니저·서브가 띄운 셸은 threadKey 가 잡 좌표라 그대로 쓰면 안 된다.
        {
          const owner =
            entry.ownerTk ||
            (typeof shellOwnerSession === "function" ? shellOwnerSession(entry.threadKey) : "");
          const sess = document.createElement("span");
          sess.className = "shell-card-session" + (owner ? "" : " unknown");
          sess.textContent = owner ? sessionLabelFor(owner) : i18n("shell.session.unknown");
          sess.title = owner
            ? i18n("shell.session.owner", { tk: owner })
            : i18n("shell.session.unknownHint");
          top.appendChild(sess);
        }
        const collapse = document.createElement("button");
        collapse.type = "button"; collapse.className = "shell-card-collapse";
        collapse.textContent = entry.cardOpen ? "▾" : "▸";
        collapse.setAttribute("aria-expanded", String(entry.cardOpen));
        collapse.setAttribute("aria-controls", "shell-card-body-" + entry.shellId);
        const collapseLabel = i18n(entry.cardOpen ? "shell.card.collapse" : "shell.card.expand");
        collapse.setAttribute("aria-label", collapseLabel);
        collapse.title = collapseLabel;
        collapse.addEventListener("click", (ev) => { ev.stopPropagation(); toggleShellCard(entry.shellId); });
        top.appendChild(collapse);
        card.appendChild(top);
        const body = document.createElement("div"); body.className = "shell-card-body";
        body.id = "shell-card-body-" + entry.shellId;
        body.hidden = !entry.cardOpen;
        card.appendChild(body);
        const name = document.createElement("div"); name.className = "agent-card-name shell-card-command";
        name.textContent = entry.command || i18n("shell.noCommand");
        body.appendChild(name);
        if (entry.cwd) {
          const cwd = document.createElement("div"); cwd.className = "shell-card-cwd";
          cwd.textContent = fmtShellCwd(entry.cwd);
          cwd.title = entry.cwd;
          body.appendChild(cwd);
        }
        const meta = document.createElement("div"); meta.className = "agent-card-meta";
        const el = document.createElement("span"); el.className = "agent-card-elapsed";
        // ★로드 순서 경합 가드 (2026-08-08, 헤드리스 실측). `fmtElapsed` 는
        //  `background-drawer.js`(로드 13번)에 있는데 이 파일은 7번이다 — 그 사이에 셸
        //  이벤트가 도착하면 `ReferenceError: fmtElapsed is not defined` 로 렌더가 **통째로
        //  죽는다**(콘솔에 실제로 2건 찍혔다). 정의 전이면 빈 값으로 두고, 다음 갱신 틱이
        //  채운다(`shellElapsedEls` 에 등록되므로 1초 뒤 정상 표시).
        el.textContent =
          typeof fmtElapsed === "function" ? fmtElapsed(shellElapsedMs(entry, now)) : "";
        if (entry.status === "running") shellElapsedEls.set(entry.shellId, el);
        meta.appendChild(el);
        if (entry.status !== "running" && entry.exitCode != null) {
          const codeEl = document.createElement("span"); codeEl.className = "shell-card-exitcode";
          codeEl.textContent = "exit " + entry.exitCode;
          meta.appendChild(codeEl);
        }
        body.appendChild(meta);
        // 마지막 출력 꼬리(1줄) — 최소 한 번 펼쳐 폴링한 적 있어야 채워짐(전 카드 상시 폴링은
        // 백엔드 부하라 안 함, ADR §5 "폴 간격 바운드"). 없으면 안내만.
        const tailLine = document.createElement("div"); tailLine.className = "shell-card-tailline";
        tailLine.textContent = entry.lastLine || i18n("shell.noPreview");
        shellTailLineEls.set(entry.shellId, tailLine); // 폴 결과가 직접 갱신(위 startShellTailPoll).
        body.appendChild(tailLine);
        const controls = document.createElement("div"); controls.className = "shell-card-controls";
        // 출력 tail(표면 D) — SDK 소유 셸은 BG_SHELLS 밖이라 /api/shell-output 이 항상 404(정직한
        // 한계, ADR §6) → 토글 자체를 안 그려 헛수고 폴 0(entry.expanded 도 영영 false 라 no-op).
        if (entry.owner !== "sdk") {
          const toggleBtn = document.createElement("button");
          toggleBtn.type = "button"; toggleBtn.className = "shell-card-toggle";
          toggleBtn.textContent = entry.expanded ? i18n("shell.output.hide") : i18n("shell.output.show");
          toggleBtn.addEventListener("click", (ev) => { ev.stopPropagation(); toggleShellExpand(entry.shellId); });
          controls.appendChild(toggleBtn);
        }
        if (entry.status === "running") {
          if (entry.killable === false) {
            // killable:false(claude SDK 소유) — ⏹️ 를 cosmetic 으로 달지 않는다(U-I4 하드 위반
            // 경고: "표시만 되고 안 멈춤"). 대신 정직한 안내만.
            const note = document.createElement("span"); note.className = "shell-card-kill-disabled";
            note.textContent = i18n("shell.status.sdkOwned");
            note.title = i18n("shell.sdkOwned.kill");
            controls.appendChild(note);
          } else {
            const killBtn = document.createElement("button");
            killBtn.type = "button"; killBtn.className = "bg-job-stop shell-card-kill";
            killBtn.title = i18n("common.shell.kill");
            killBtn.disabled = entry.killRequested;
            killBtn.textContent = entry.killRequested ? i18n("common.stopping") : "⏹️ Kill";
            killBtn.addEventListener("click", (ev) => { ev.stopPropagation(); void requestKillShell(entry.shellId); });
            controls.appendChild(killBtn);
          }
        }
        body.appendChild(controls);
        if (entry.cardOpen && entry.expanded && entry.owner !== "sdk") {
          const out = document.createElement("pre"); out.className = "shell-card-output";
          out.textContent = i18n("shell.output.loading");
          body.appendChild(out);
          shellOutputEls.set(entry.shellId, out);
        }
        return card;
      };

      // 목록과 스크롤 소유자를 구분한다. 공통 viewport에 실제 겹친 카드만 앵커다.
      const shellReadingAnchor = (grid) => {
        const pane = grid.closest("#bg-scroll");
        if (!pane || !(pane.scrollTop > 0)) return null;
        const viewport = pane.getBoundingClientRect();
        if (viewport.height <= 0) return null;
        const out = [];
        for (const c of grid.querySelectorAll(".shell-card")) {
          const r = c.getBoundingClientRect();
          if (r.bottom > viewport.top && r.top < viewport.bottom && r.height > 0) {
            out.push({ id: c.dataset.shellId, at: r.top - viewport.top });
          }
        }
        return out.length ? out : null;
      };
      const keepShellReadingAnchor = (grid, anchor) => {
        if (!anchor || typeof bgSetScrollTop !== "function") return;
        const pane = grid.closest("#bg-scroll");
        if (!pane) return;
        const now = new Map();
        for (const c of grid.querySelectorAll(".shell-card")) now.set(c.dataset.shellId, c);
        const top = pane.getBoundingClientRect().top;
        for (const a of anchor) {
          const c = now.get(a.id);
          if (!c) continue;
          const moved = c.getBoundingClientRect().top - top - a.at;
          if (moved !== 0) bgSetScrollTop(pane.scrollTop + moved);
          return;
        }
      };

      // 렌더 타깃 — 옛 사이드바 페이지(#shells-grid, currentView==="shells")에서 백그라운드 드로어
      // 셸 섹션(#bg-shells-list, ADR §5 Phase 3b-2)으로 이식. 드로어는 항상 DOM 에 존재(열림/닫힘은
      // CSS body.bg-open)이라 currentView 게이트가 불필요 — jobCards 와 동형으로 상시 라이브 갱신.
      const renderShellsView = (focusShellId = null) => {
        const grid = document.getElementById("bg-shells-list");
        const empty = document.getElementById("bg-shells-empty");
        if (!grid) return;
        const active = document.activeElement;
        const restoreFocus = focusShellId || (active && grid.contains(active) && active.classList.contains("shell-card-collapse")
          ? active.closest(".shell-card").dataset.shellId : null);
        // 이 파일의 초기 seed가 드로어 스크립트 로드보다 먼저 끝날 수도 있다.
        if (typeof bgGeometryChanged === "function") bgGeometryChanged();
        const anchor = shellReadingAnchor(grid);
        for (const shellId of shellPollTimers.keys()) stopShellTailPoll(shellId);
        grid.innerHTML = "";
        shellElapsedEls.clear();
        shellOutputEls.clear();
        shellTailLineEls.clear();
        const now = Date.now();
        let running = 0, total = 0, shown = 0;
        // ★드로어 상단 "현재 세션 / 전체 세션" 토글을 셸 그룹도 따른다 (2026-07-28).
        //  종전엔 잡 그룹만 따랐다 — "현재 세션"으로 둬도 남의 세션 셸이 그대로 보였다.
        //  CSS 숨김이 아니라 여기서 거른다: 아래 running/total 카운트가 화면과 어긋나지 않게.
        //  판정은 잡과 같은 근거(isShellInScope: 서버 환원값 우선, 미상 숨김).
        const entries = [...shellRegistry.values()].filter((e) => e.visible && shellInCurrentScope(e));
        entries.sort((a, b) => {
          const ra = a.status === "running" ? 0 : 1;
          const rb = b.status === "running" ? 0 : 1;
          if (ra !== rb) return ra - rb;
          // ★**오래된 것 먼저** (2026-09-10 적대 검토 P-3). 잡 레인을 오래된 순으로 바꾼
          //  명분이 *"같은 드로어 안에서 시간축이 반대로 흘렀다"* 인데, 정작 같은 드로어의
          //  아래 레인(셸)이 안 뒤집혀 있었다 — 한 스크롤 면에서 시간이 두 방향으로 흐른다.
          return (a.startedAt || 0) - (b.startedAt || 0);
        });
        for (const e of entries) {
          total += 1;
          if (e.status === "running") running += 1;
          if (!shellPassesFilter(e)) continue;
          shown += 1;
          grid.appendChild(buildShellCard(e, now));
        }
        keepShellReadingAnchor(grid, anchor);
        if (restoreFocus) {
          const card = grid.querySelector('.shell-card[data-shell-id="' + CSS.escape(restoreFocus) + '"]');
          const button = card && card.querySelector(".shell-card-collapse");
          if (button) button.focus({ preventScroll: true });
        }
        // 빌더는 조회하지 않는다. 모든 새 출력 DOM이 부착된 다음 시작한다.
        for (const shellId of shellOutputEls.keys()) startShellTailPoll(shellId);
        const rc = document.getElementById("bg-shells-count-running");
        const ac = document.getElementById("bg-shells-count-all"); // id 유지·의미=완료(종료) 수.
        if (rc) rc.textContent = String(running);
        if (ac) ac.textContent = String(total - running);
        if (empty) {
          empty.style.display = shown === 0 ? "" : "none";
          empty.textContent = shellsFilter === "running" ? i18n("bg.shells.empty") : i18n("shell.empty.done");
        }
        publishShells();
      };
      // ★셸 목록을 리소스로도 낸다(2026-10-21 «백그라운드 작업» 위젯 — 패널의 축약판). 범위·필터와 **무관한 전체**(보이는 것만 —
      //  디바운스 안 끝난 단명 셸은 패널에도 없다) — 거르는 건 받는 쪽이다. 같은 값이면 안 낸다(렌더는 잦다).
      const shellsRes = window.resourceStore.owned("bg-shells");
      let shellsSig = "";
      // ★첫 조회(`/api/shells`)가 오기 전의 빈 레지스트리는 «셸 없음» 이 아니라 «아직 모름» 이다 (2026-10-23 적대 검토 B-P3) —
      //  렌더마다 내면 범위 전환 같은 재그리기가 빈 목록을 내 위젯이 «없음» 이 됐다(타이머는 조회 뒤에만 낸다). 받은 셸이 있으면 그대로 낸다.
      let shellsSeeded = false;
      const publishShells = () => {
        const list = [...shellRegistry.values()]
          .filter((e) => e.visible)
          .map((e) => ({
            shellId: e.shellId, command: e.command, status: e.status, startedAt: e.startedAt,
            // 위젯 행 이름 — 있을 때만(없으면 위젯이 지금처럼 명령을 보인다).
            ...(typeof e.description === "string" && e.description !== "" ? { description: e.description } : {}),
            // 소속 = 카드와 같은 규칙(서버 환원값 → 잡 좌표면 원 세션으로 환원 → 모르면 «미상»). 잡 좌표를 그대로 대화로 쓰지 않는다(적대 검토 10-21).
            ownerThreadKey: e.ownerTk || (typeof shellOwnerSession === "function" ? shellOwnerSession(e.threadKey) : ""),
          }));
        if (!shellsSeeded && list.length === 0) return;
        const sig = JSON.stringify(list);
        if (sig === shellsSig) return;
        shellsSig = sig;
        shellsRes.set(list);
      };
      let shellsRenderQueued = false;
      // 드로어가 닫혀 있어도 배지 카운트가 최신이어야 하므로(jobCards 동형) currentView 게이트 없이
      // rAF 로만 배칭(고volume SSE 방어).
      const scheduleShellsRender = () => {
        if (shellsRenderQueued) return;
        shellsRenderQueued = true;
        requestAnimationFrame(() => { shellsRenderQueued = false; renderShellsView(); });
      };

      const setShellsFilter = (mode) => {
        shellsFilter = mode === "done" ? "done" : "running";
        const bar = document.getElementById("bg-shells-filter");
        if (bar) for (const b of bar.querySelectorAll(".bg-fbtn")) {
          const on = b.dataset.filter === shellsFilter;
          b.classList.toggle("active", on);
          b.setAttribute("aria-pressed", on ? "true" : "false");
        }
        renderShellsView();
      };
      // 드로어 셸 섹션 필터 버튼(진행 중/전체) — 정적 DOM(index.html, 드로어는 항상 존재)이라
      // showShells() 안이 아니라 부팅 시 1회 배선(background-drawer.js bg-filter 배선과 동형).
      (() => {
        const bar = document.getElementById("bg-shells-filter");
        if (!bar) return;
        for (const b of bar.querySelectorAll(".bg-fbtn")) {
          b.addEventListener("click", () => setShellsFilter(b.dataset.filter));
        }
      })();

      // 부팅/SSE 시 GET /api/shells 시드(ADR §5 "C — 뷰 오픈 시 list 엔드포인트 시드", Phase 3b-2
      // 부터는 드로어가 상시 존재하므로 부팅 하이드레이션으로 재해석). 시드된 셸은 이미 존재가
      // 확정돼 있으므로 디바운스 없이 즉시 visible.
      const fetchShellsSeed = () => {
        fetch("/api/shells").then((r) => r.json()).then((d) => {
          if (!d || !Array.isArray(d.shells)) return;
          shellsSeeded = true;
          for (const s of d.shells) {
            if (!s || !s.shellId) continue;
            const se = upsertShellEntry(s.shellId, {
              command: s.command || "", cwd: s.cwd || "", status: normalizeSeedStatus(s.status),
              threadKey: s.threadKey || "",
              ownerTk: typeof s.ownerThreadKey === "string" ? s.ownerThreadKey : "", // 서버 환원 원 세션.
              exitCode: s.exitCode != null ? s.exitCode : null,
              ...shellFactPatch(s),
            }, { visible: true });
            settleShellEnd(se);
          }
          capShellRegistry();
          updateShellsBadge();
          scheduleShellsRender();
        }).catch(() => { /* 미도달 — SSE 로 채워짐 */ });
      };

      // showShells — Phase 3b-1(에이전트)과 같은 이식: 옛 전체페이지 사이드바 뷰 대신 백그라운드
      // 드로어를 열고 셸 섹션으로 포커스(짧은 flash 하이라이트, bg-flash 관례 재사용). 표면 A(채팅
      // 인라인 칩)·B(컴포저 "🖥️ 셸 N개" 스트립, background-drawer.js)는 이 함수를 그대로 호출 —
      // shellRegistry 계약 무변경이라 두 표면 다 무수정으로 계속 동작.
      const showShells = () => {
        revealBgCard({
          find: () => document.getElementById("bg-shells-head"),
          groupHead: "bg-shells-head",
        });
      };

      // 위젯의 «보여 줘»(`ctx.reveal({ kind: "shell", id })`) — 패널의 공통 판정(`revealBgCard`, background-drawer.js)을 탄다.
      window.addEventListener("tigu:reveal", (ev) => {
        const d = ev.detail || {};
        if (d.kind !== "shell" || typeof d.id !== "string") return;
        const e = shellRegistry.get(d.id);
        revealBgCard({
          find: () => document.querySelector('#bg-shells-list .shell-card[data-shell-id="' + CSS.escape(d.id) + '"]'),
          inScope: e ? isShellInScope(e.threadKey, e.ownerTk) : true,
          showFilter: () => {
            if (!e) return;
            const ended = e.status !== "running"; // 렌더가 거르는 기준 그대로
            if ((shellsFilter === "done") !== ended) setShellsFilter(ended ? "done" : "running");
          },
          groupHead: "bg-shells-head",
          rerender: renderShellsView,
          open: () => {
            if (!e) return;
            e.flashUntil = Date.now() + 900;
            setTimeout(scheduleShellsRender, 950); // 강조를 걷는 다시 그리기
            // ★펼치지 않는다(사용자 10-23 — 위젯을 누르면 카드 **맨 위**를 보이고, 펼침은 사용자가 그 자리에서). 접힘·펼침은 지금 그대로.
            renderShellsView();
          },
        });
      });

      // 경과시간 라이브 틱(1s) — running 카드만(background-drawer.js tickElapsed 동형, 별도 셋).
      // 드로어가 닫혀 있어도 카운트/카드가 최신이어야 하므로 currentView 게이트 없음(jobCards 동형).
      setInterval(() => {
        const now = Date.now();
        for (const [shellId, e] of shellRegistry) {
          if (e.status !== "running") continue;
          const el = shellElapsedEls.get(shellId);
          if (el) el.textContent = fmtElapsed(now - (e.startedAt || now));
        }
      }, 1000);

      // 부팅 하이드레이션 — 드로어 셸 섹션·컴포저 스트립(표면 B)이 드로어를 한 번도 안 열어도
      // 최신이게. hydrateActiveJobs(background-drawer.js) 동형.
      fetchShellsSeed();
      // ★부팅 외 트리거에서도 재동기할 수 있게 노출 — 잡(reconcileBgJobs)과 대칭.
      //  "화면을 다시 볼 때" 정확해야 하는 건 잡·셸이 같다.
      window.resyncShells = fetchShellsSeed;
