      // ── Step2/3 (2026-06-30) — 백그라운드 작업 드로어 + 잡 카드 + 스텝 타임라인 ──
      // worker.* lifecycle(Step1)로 잡 카드 생성·상태(payload.status: running/done/failed/
      // cancelled). 워커 llm.activity(threadKey=worker:<jobId>)는 그 잡 카드 안 접이식
      // 스텝으로(Step3) — 채팅으로 새지 않게 dispatch 에서 가로채 여기로 보낸다.
      // 토글 드로어(PC 우측 고정·모바일 슬라이드인+백드롭). 배지 = 실행 중 잡 수.
      const bgPanel = document.getElementById("bg-panel");
      const bgList = document.getElementById("bg-list");
      const bgEmpty = document.getElementById("bg-empty");
      const bgBadge = document.getElementById("bg-badge");
      // 컴포저(입력창 위) 인디케이터 — 현재 세션에 백그라운드 작업이 돌면 노출(runningScoped>0).
      // 클릭하면 드로어를 연다. refreshBgBadge 가 잡 상태·탭 전환마다 갱신.
      const chatBgActiveEl = document.getElementById("chat-bg-active");
      if (chatBgActiveEl) chatBgActiveEl.addEventListener("click", () => { if (typeof openBg === "function") openBg(); });

      // ── 표면 B — 셸 컴포저 스트립(ADR 2026-07-17 §5-B, Phase 3b) ─────────────────────────
      // chat-bg-active(워커)와 물리적으로 분리된 별도 레인(사용자 확정 — 셸=다른 종). 세션
      // 스코프(runningScoped 패턴 동형) — shell.started.threadKey 가 활성 세션과 같은 running
      // 셸만 카운트. 누르면 셸 사이드바 뷰로 점프(택1 중 간단한 쪽 — 별도 팝오버 신설 안 함).
      const chatShellActiveEl = document.getElementById("chat-shell-active");
      // 셸 세션 스코프 판정. ★worker/서브가 띄운 셸의 threadKey 는 세션 좌표가 아니라 **잡 좌표**
      //  ("worker:<jobId>"/"agent:<jobId>")라 activeThreadKey 와 **절대** 안 맞는다(아래
      //  realSessionThreadKey 주석과 동일 근거). 종전 `tk === activeThreadKey` 단순 비교는 그런 셸을
      //  영구히 숨겨, 워커가 띄운 dev 서버가 30분째 돌아도 "🖥️ 셸 N개 실행 중"이 안 뜨는 버그를 냈다
      //  (2026-07-26 실측). 잡 좌표면 원 세션으로 환원해 판정한다.
      // 셸 threadKey → **원 세션** threadKey 환원. 잡 좌표(worker:/agent:<jobId>)면 그 잡 카드가
      // 아는 원 세션으로, 이미 세션 좌표면 그대로. 모르면 ""(=소속 미상).
      const shellOwnerSession = (tk) => {
        if (!tk) return "";
        const m = /^(?:worker|agent):(.+)$/.exec(tk);
        if (!m) return tk;
        if (typeof jobCards === "undefined") return "";
        const card = jobCards.get(m[1]);
        if (!card) return "";
        // ★card.threadKey 를 세션 키로 단정하지 않는다 (2026-07-28). 잡 카드의 threadKey 는
        //  자기를 띄운 부모 *잡 좌표*일 수 있어(서브가 띄운 서브) 한 단계로는 안 끝난다.
        //  서버 환원값(ownerTk) 우선, 없으면 부모 체인을 끝까지 따라간다.
        return card.ownerTk || jobOwnerSession(card.threadKey);
      };
      // ★잡 카드(isBgInScope)와 **같은 기준** (2026-07-28, 사용자 확정 "다 맞춰야지").
      //  근거 우선순위: ①서버가 환원해 실어 준 ownerThreadKey(shell.* payload / GET /api/shells)
      //  ②없으면 프런트 환원. **미상은 숨긴다(fail-closed)** — 종전엔 노출이었는데, 사용자가
      //  명시한 세션 필터를 어기는 쪽이 안 보이는 쪽보다 나쁜 실패다(남의 세션 배지 오탐).
      const isShellInScope = (tk, ownerHint) => {
        if (!tk) return false; // 소속 근거 자체가 없음 — 활성 세션 것이라 단정하지 않는다.
        if (tk === activeThreadKey) return true;
        const owner =
          typeof ownerHint === "string" && ownerHint !== ""
            ? ownerHint
            : shellOwnerSession(tk);
        return owner !== "" && owner === activeThreadKey;
      };
      // 세션별 진행 중 백그라운드(잡·셸) 보유 집합 — 세션 탭 진행 배지가 읽는다(tabs.js).
      // ★"자기 세션 것만" 원칙: 소속이 확정된 것만 넣는다(미상은 넣지 않음 — 남의 탭에 점이
      // 찍히는 오탐이 누락보다 나쁘다. 미상 카드는 아래 threadKey 지연 채움으로 대부분 확정된다).
      const bgWorkSessions = new Set();
      let lastBgWorkSig = "";
      const syncSessionBgBadges = () => {
        const next = new Set();
        for (const e of jobCards.values()) {
          // 좌표(worker:/agent:)는 원 세션으로 환원해 담는다 — 서브에이전트가 도는 세션 탭에도
          // 점이 찍혀야 하고, 남의 탭엔 안 찍혀야 한다. 환원 불가(미상)는 담지 않는다(오탐 0 정책).
          if (e.status !== "running") continue;
          const owner = e.ownerTk || jobOwnerSession(e.threadKey); // 서버 환원값 우선.
          if (owner) next.add(owner);
        }
        if (typeof shellRegistry !== "undefined") {
          for (const s of shellRegistry.values()) {
            if (s.status !== "running") continue;
            const owner = s.ownerTk || shellOwnerSession(s.threadKey); // 서버 환원값 우선.
            if (owner) next.add(owner);
          }
        }
        const sig = [...next].sort().join("|");
        if (sig === lastBgWorkSig) return; // 변화 없으면 리렌더 0(1초 폴에 매번 갱신 방지).
        lastBgWorkSig = sig;
        bgWorkSessions.clear();
        for (const k of next) bgWorkSessions.add(k);
        if (typeof renderTabBar === "function") renderTabBar();
      };
      if (chatShellActiveEl) chatShellActiveEl.addEventListener("click", () => {
        if (typeof showShells === "function") showShells();
      });
      const refreshShellStrip = () => {
        if (!chatShellActiveEl) return;
        let running = 0;
        if (typeof shellRegistry !== "undefined") {
          for (const e of shellRegistry.values()) {
            if (e.status === "running" && isShellInScope(e.threadKey, e.ownerTk)) running += 1;
          }
        }
        if (running > 0) {
          chatShellActiveEl.textContent = i18n("bg.shells.activeCount", { n: running });
          chatShellActiveEl.hidden = false;
        } else {
          chatShellActiveEl.hidden = true;
        }
      };
      // view-shells.js 의 handleShellStarted/handleShellExited 가 상태변화마다 이 함수를 직접
      // 부르지만(cross-file 훅), 세션 탭 전환(activeThreadKey 변경)은 tabs.js 를 건드리지 않고도
      // 최대 1s 이내 반영되도록 가벼운 폴 — background-drawer.js 자기완결(무접촉 파일 원칙 준수).
      setInterval(() => { refreshShellStrip(); syncSessionBgBadges(); }, 1000);
      // "↑ 최신" 점프 — 아래로 내려 과거 잡 열람 중(scrollTop>임계)일 때만 노출, 클릭하면 맨 위(최신)로.
      // 채팅 chat-jump 의 상단판(newest=insertBefore 로 top). stickTop 이 안 끌어당기는 케이스의 어포던스.
      const bgJump = document.getElementById("bg-jump");
      const BG_JUMP_THRESHOLD = 40; // stickTop 임계(ensureJobCard _bgNearTop)와 동일.
      const updateBgJump = () => { if (bgJump) bgJump.hidden = bgList.scrollTop < BG_JUMP_THRESHOLD; };
      if (bgJump) bgJump.addEventListener("click", () => { bgList.scrollTop = 0; updateBgJump(); });
      bgList.addEventListener("scroll", updateBgJump, { passive: true });
      const BG_STATUS = {
        running: i18n("bg.status.running"), done: i18n("common.status.done"), failed: i18n("bg.status.failed"), cancelled: i18n("bg.status.cancelled"),
        // 종료된 건 확실한데 결과를 못 받은 경우(연결이 끊긴 사이 종료·데몬 재시작).
        // "완료"로 단정하지 않는다 — 성공 여부를 모르는데 성공처럼 보이면 거짓값이다.
        interrupted: i18n("bg.status.interrupted"),
      };
      /** 되돌릴 수 없는 종료 상태 — 이 상태의 카드는 다시 running 이 되지 않는다. */
      const TERMINAL_JOB_STATUS = new Set(["done", "failed", "cancelled", "interrupted"]);
      const BG_MAX = 50; // 카드 상한(메모리 바운드). 오래된 끝난 잡부터 제거.
      const jobCards = new Map(); // jobId -> { el, labelEl, statusEl, chevEl, stepsEl, errEl, status, stepCount }

      // ── 취소(중지) — POST /api/cancel-worker { jobId } → { ok, cancelled }. 대상: 진행 중인
      // 잡(worker·agent) 모두 — U-I4 개정(2026-07-17): awaited 서브에이전트(kind==="agent")도
      // 이제 취소 가능(백엔드가 cancel-only abort 핸들 등록). kind 무관, status==="running" 만
      // 게이트. 낙관적 UI: 클릭 즉시 버튼 비활성화+"중지 요청…" 텍스트로, 상태 배지도
      // "취소 중…"(기존 잡 상태 렌더 재사용, BG_STATUS 확장). cancelled:false(대상없음/
      // 이미종료) 나 네트워크 실패는 무해하게 되돌린다 — 실제 종료 반영은 worker.cancelled lifecycle
      // SSE(handleWorkerEvent, BG_STATUS.cancelled="⏹ 취소")가 한다.
      const canCancelJob = (entry) => !!entry && entry.status === "running";
      const updateStopBtn = (entry) => {
        if (!entry || !entry.stopBtnEl) return;
        const show = canCancelJob(entry);
        entry.stopBtnEl.style.display = show ? "" : "none";
        entry.stopBtnEl.disabled = !!entry._cancelRequested;
        entry.stopBtnEl.textContent = entry._cancelRequested ? i18n("common.stopping") : i18n("bg.stop");
      };
      const requestCancelJob = async (jobId) => {
        const entry = jobCards.get(jobId);
        if (!canCancelJob(entry) || entry._cancelRequested) return;
        entry._cancelRequested = true;
        updateStopBtn(entry);
        if (entry.statusEl) entry.statusEl.textContent = i18n("bg.status.cancelling");
        const revert = () => {
          entry._cancelRequested = false;
          updateStopBtn(entry);
          if (entry.statusEl && entry.status === "running") entry.statusEl.textContent = BG_STATUS.running;
        };
        try {
          const res = await fetch("/api/cancel-worker", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ jobId }),
          });
          const data = res.ok ? await res.json().catch(() => null) : null;
          // cancelled:true → worker.cancelled lifecycle 이 곧 status 갱신(handleWorkerEvent). 그 외
          // (대상없음/이미종료/네트워크 실패)는 무해 폴백 — 낙관 표시를 되돌려 사용자가 재시도 가능.
          if (!data || data.cancelled !== true) revert();
        } catch (err) {
          revert();
          console.warn("cancel-worker 요청 실패:", err && err.message ? err.message : err);
        }
      };
      registerBuiltinHandler("job.cancel", (ctx) => requestCancelJob(ctx.targetId));

      // ── 컨텍스트메뉴(잡, context-menu 계약 §2.2) — 상세 보기/접기 · 복사 · (해당 시) 중지.
      registerBuiltinHandler("job.toggleDetail", (ctx) => {
        const entry = jobCards.get(ctx.targetId);
        if (!entry || !entry.el.classList.contains("has-detail")) return;
        const nowOpen = entry.el.classList.toggle("open");
        updateChev(entry);
        // 펼칠 때 스텝박스를 최신(바닥)으로 — 안 그러면 scrollTop=0(맨위)이라 스텝 append 팔로우
        //   (near-bottom 24px 판정)가 영영 안 붙어 진행 중 잡의 라이브 스텝을 못 따라간다. rAF 로
        //   .open 레이아웃 반영 후 스크롤(접힘 상태 clientHeight=0 회피).
        if (nowOpen && entry.stepsEl) {
          requestAnimationFrame(() => {
            entry.stepsEl.scrollTop = entry.stepsEl.scrollHeight;
          });
        }
      });
      registerBuiltinHandler("job.copy", async (ctx) => {
        const entry = jobCards.get(ctx.targetId);
        if (!entry || !navigator.clipboard) return;
        const parts = [entry.label || ""];
        if (entry.task) parts.push(i18n("bg.copy.task", { v: entry.task }));
        if (entry.result) parts.push(i18n("bg.copy.result", { v: entry.result }));
        if (entry.errorText) parts.push(i18n("bg.copy.error", { v: entry.errorText }));
        try { await navigator.clipboard.writeText(parts.join("\n")); } catch {}
      });
      // 세션으로 이동 — 그 작업을 띄운 세션(threadKey)으로 점프(전체활동 activity.jump 동형).
      registerBuiltinHandler("job.jumpSession", (ctx) => {
        const tk = ctx.threadKey;
        if (!tk || typeof switchToThread !== "function") return;
        if (typeof openTabs !== "undefined" && !openTabs.some((t) => t.threadKey === tk)) {
          openTabs.push({ threadKey: tk, name: typeof deriveTabFallbackName === "function" ? deriveTabFallbackName(tk) : tk });
        }
        if (typeof setActiveNav === "function") setActiveNav("chat");
        if (typeof setChatPanel === "function") setChatPanel("chat");
        if (typeof setActiveTab === "function") setActiveTab("chat");
        switchToThread(tk);
      });
      registerBuiltinHandler("job.copyResult", async (ctx) => {
        const entry = jobCards.get(ctx.targetId);
        if (!entry || !navigator.clipboard || !entry.result) return;
        try { await navigator.clipboard.writeText(entry.result); } catch {}
      });
      registerBuiltinHandler("job.copyId", async (ctx) => {
        if (!navigator.clipboard) return;
        try { await navigator.clipboard.writeText(ctx.targetId || ""); } catch {}
      });
      registerMenuItems("job", (ctx) => {
        const entry = jobCards.get(ctx.targetId);
        const items = [];
        // 세션으로 이동 — 원 세션 threadKey 가 있을 때만(worker:/agent: 의사키·미지정 제외).
        if (ctx.threadKey) {
          items.push({ id: "jump", label: i18n("common.jumpSession"), icon: "↪️", action: { kind: "builtin", handler: "job.jumpSession" } });
        }
        if (entry && entry.el.classList.contains("has-detail")) {
          items.push({
            id: "detail",
            label: entry.el.classList.contains("open") ? i18n("bg.detail.hide") : i18n("bg.detail.show"),
            icon: "🔎",
            action: { kind: "builtin", handler: "job.toggleDetail" },
          });
        }
        items.push({ id: "copy", label: i18n("common.copy"), icon: "📋", action: { kind: "builtin", handler: "job.copy" } });
        if (entry && entry.result) {
          items.push({ id: "copy-result", label: i18n("bg.copyResult"), icon: "📄", action: { kind: "builtin", handler: "job.copyResult" } });
        }
        items.push({ id: "copy-id", label: i18n("bg.copyId"), icon: "🔖", action: { kind: "builtin", handler: "job.copyId" } });
        if (canCancelJob(entry) && !entry._cancelRequested) {
          items.push({
            id: "cancel",
            label: i18n("bg.stopShort"),
            icon: "⏹️",
            danger: true,
            action: { kind: "builtin", handler: "job.cancel" },
          });
        }
        return items;
      });

      // 백그라운드 드로어 폭 드래그 조절(왼쪽 가장자리) + localStorage 영속. PC 전용(모바일=핸들 숨김).
      (() => {
        const handle = document.getElementById("bg-resize");
        if (!bgPanel || !handle) return;
        const KEY = "tc:bgPanelWidth";
        const clamp = clampDrawerWidth; // 폭 한계는 constants.js 한 곳 — 검색 드로어와 공유.
        // PC 사이드 패널 푸시(CC 웹식) — 패널 폭을 --bg-panel-w 로 공유해 header/main 이 그만큼
        //   margin-right 로 채팅을 좁힌다(app.css). 드래그 중에도 라이브 추적.
        const apply = (w) => {
          const cw = clamp(w);
          bgPanel.style.width = cw + "px";
          document.body.style.setProperty("--bg-panel-w", cw + "px");
        };
        const saved = parseInt(localStorage.getItem(KEY) || "", 10);
        if (Number.isFinite(saved)) apply(saved);
        let dragging = false;
        window.addEventListener("mousemove", (e) => { if (dragging) apply(window.innerWidth - e.clientX); });
        window.addEventListener("mouseup", () => {
          if (!dragging) return;
          dragging = false; handle.classList.remove("dragging"); document.body.classList.remove("bg-resizing");
          try { localStorage.setItem(KEY, String(parseInt(bgPanel.style.width, 10))); } catch {}
        });
        handle.addEventListener("mousedown", (e) => {
          e.preventDefault(); dragging = true; handle.classList.add("dragging"); document.body.classList.add("bg-resizing");
        });
      })();

      // 도구 실행시간(#3) — phase:"end" 활동이 같은 seq 의 시작 스텝에 durationMs 뱃지를 붙인다.
      // 잡 카드 스텝(.bg-step, worker:/agent: 좌표)과 메인 스트림 라인(.act-line) 양쪽 커버.
      // 활동 한 줄 렌더 — 채팅 `/workers` 와 **같은 사실**을 같은 모양으로 말한다
      // (진행 중 도구가 있으면 그 도구와 경과, 없으면 마지막 활동 이후). 값이 없으면
      // **안 그린다**(거짓값 금지 — 이 파일의 modelBadge 규칙과 동형).
      const renderDoing = (entry, now) => {
        const el = entry && entry.doingEl;
        if (!el) return;
        const act = entry.activity;
        if (!act) { el.style.display = "none"; return; }
        const t = typeof now === "number" ? now : Date.now();
        const txt =
          Array.isArray(act.inFlight) && act.inFlight.length > 0
            ? " · " + act.inFlight.map((f) => i18n("bg.inFlight", { tool: f.tool, elapsed: fmtElapsed(t - f.since) })).join(", ")
            : typeof act.lastActivityAt === "number"
              ? i18n("bg.lastActivity", { ago: fmtElapsed(t - act.lastActivityAt) })
              : "";
        if (txt === "") { el.style.display = "none"; return; }
        el.style.display = "";
        if (el.textContent !== txt) el.textContent = txt;
      };
      const fmtDur = (ms) => {
        if (ms == null) return "";
        if (ms < 1000) return Math.round(ms) + "ms";
        const s = ms / 1000;
        if (s < 10) return s.toFixed(1) + "s";
        if (s < 60) return Math.round(s) + "s";
        const m = Math.floor(s / 60), rs = Math.round(s % 60);
        return m + "m " + rs + "s";
      };
      // ★잡 카드의 실제 응답 모델 (2026-07-27) — 채팅의 setTurnModel 과 같은 규칙:
      //  값 없으면 안 그린다(거짓값 금지) · 같은 값 반복은 no-op · 도중에 바뀌면 "이전→현재" 로
      //  남긴다(폴백을 지우지 않는다). 워커·서브에이전트는 사용자가 안 보는 동안 도는 것이라
      //  "어느 모델로 돌았나" 가 사후에 더 중요하다.
      const setJobModel = (entry, model) => {
        const m = typeof model === "string" ? model.trim() : "";
        if (!entry || m === "" || entry.modelSeen === m) return;
        entry.modelSeen = m;
        const el = entry.modelBadgeEl;
        if (!el) return;
        el.style.display = "";
        el.textContent = m; // 현재 모델만(전환 표기 없음 — 채팅 setTurnModel 과 같은 규칙).
        el.title = i18n("bg.model.title");
      };

      const applyDurationBadge = (el, ms) => {
        if (!el) return;
        // ★진행 표식을 **먼저** 걷는다 (2026-08-24). 순서가 반대면 아래 `.dur-badge` 조회가
        //  진행 중 뱃지(`dur-badge running`)를 잡아 거기에 실행시간을 쓰고, 그 다음 해제가
        //  **그 뱃지를 지운다** — 실행시간이 통째로 사라진다(실측으로 걸렸다).
        clearStepRunning(el);
        let b = el.querySelector(":scope > .dur-badge");
        if (!b) { b = document.createElement("span"); b.className = "dur-badge"; el.appendChild(b); }
        b.textContent = fmtDur(ms);
        if (ms >= 90000) b.classList.add("slow"); // tool-slow 임계 이상 = warn 틴트.
        b.title = i18n("bg.toolElapsed", { v: fmtDur(ms) });
      };

      /**
       * 스텝 줄의 **진행 중** 표식 (2026-08-24 사용자 요청: "진행중인 도구도 나올 수 있어?").
       *
       * ★"뱃지 없는 마지막 스텝 = 실행 중" 으로 **추정하지 않는다.** 끝 이벤트를 못 받는
       *  경우가 실제로 있고(잡 취소·데몬 재시작·SSE 끊김), 그러면 그 줄이 영원히 카운트업하며
       *  죽은 잡의 도구가 도는 것처럼 보인다 — 이 레포가 반복해서 고쳐 온 **유령**이다.
       *  대신 **append 시점에 단다**(그 순간 시작한 건 사실이다) → 뱃지가 오면 끈다
       *  → **잡이 끝나면 남은 것을 전부 끈다**(아래 handleWorkerEvent). 셋이 다 있어야 한다.
       */
      const markStepRunning = (el, startTs) => {
        if (!el || !startTs) return;
        el.classList.add("bg-step-running");
        el.dataset.runsince = String(startTs);
        const b = document.createElement("span");
        b.className = "dur-badge running";
        b.textContent = "⏳ " + fmtElapsed(Date.now() - startTs);
        el.appendChild(b);
      };
      const clearStepRunning = (el) => {
        if (!el || !el.classList.contains("bg-step-running")) return;
        el.classList.remove("bg-step-running");
        delete el.dataset.runsince;
        const b = el.querySelector(":scope > .dur-badge.running");
        if (b) b.remove(); // 실제 실행시간 뱃지가 그 자리를 대신한다.
      };
      /** 잡이 끝났다 = 그 카드의 어떤 도구도 더는 안 돈다. 남은 표식을 전부 끈다(유령 방지). */
      const clearAllStepsRunning = (entry) => {
        if (!entry || !entry.stepsEl) return;
        for (const el of entry.stepsEl.querySelectorAll(".bg-step-running")) clearStepRunning(el);
      };
      const annotateToolDuration = (ap) => {
        if (ap.seq == null) return;
        const tk = ap.threadKey || "";
        // 사이드바 상세도 실행시간·출력 보이게 — 저장된 시작 payload 에 병합(있으면).
        const stored = activityByStep.get(stepKey(tk, ap.seq));
        if (stored) {
          if (ap.durationMs != null) stored.durationMs = ap.durationMs;
          if (ap.output) stored.output = ap.output;
        }
        // 리치 출력(Bash/Read/Grep/Glob, phase:end) — 시작 스텝 라인에 접이식 블록 append.
        // (메인 스트림 스텝만; 잡 카드 스텝은 durationMs 뱃지만 — 아래 (a) 에서 return.)
        if (ap.output && (tk.indexOf("worker:") !== 0 && tk.indexOf("agent:") !== 0)) {
          const oLines = stream.querySelectorAll('.act-line[data-seq="' + ap.seq + '"][data-threadkey="' + tk + '"]');
          let target = null;
          for (let i = oLines.length - 1; i >= 0; i--) {
            if (!oLines[i].querySelector(":scope > .act-output")) { target = oLines[i]; break; }
          }
          if (target) {
            target.appendChild(buildOutputBlock(ap.output));
            // 표면 A(Phase 3b) — 백그라운드 셸 인라인 칩. 백엔드 무변경, 출력 텍스트에 이미 실린
            // bash_id 를 파싱만(virtualization.js SHELL_CHIP_ID_RE/attachShellChip, 정의 순서
            // 무관 — SSE 는 부팅 완료 후에만 발화, typeof 가드 불요할 만큼 확정적이나 방어적으로 유지).
            const shellM = (typeof ap.output.text === "string" && typeof SHELL_CHIP_ID_RE !== "undefined")
              ? SHELL_CHIP_ID_RE.exec(ap.output.text) : null;
            if (shellM && typeof attachShellChip === "function") attachShellChip(target, shellM[1]);
          }
        }
        if (ap.durationMs == null) return;
        // (a) 잡 카드 스텝 — worker:/agent: 좌표면 그 카드 stepsEl 에서 seq 로 찾아 주석.
        if (tk.indexOf("worker:") === 0 || tk.indexOf("agent:") === 0) {
          const jobId = tk.slice(tk.indexOf(":") + 1);
          const card = jobCards.get(jobId);
          if (card && card.stepsEl) {
            const stepEl = card.stepsEl.querySelector('.bg-step[data-seq="' + ap.seq + '"]');
            applyDurationBadge(stepEl, ap.durationMs);
            // 워커 output(Bash/Read/Grep/Glob 등)은 자동 append 하지 않고(채팅 누수/컴팩트 유지)
            // 스텝에 보관 + 펼침 affordance 만 배선 — on-demand 로만 buildOutputBlock 렌더.
            if (stepEl && ap.output) { stepEl._output = ap.output; ensureStepExpandable(stepEl); }
          }
          return;
        }
        // (b) 메인 스트림 활동 라인 — threadKey+seq 매칭. seq 는 턴마다 리셋(0,1,2…)이라
        // 스트림에 같은 seq 라인이 누적될 수 있으므로, 아직 실행시간이 안 붙은 가장 최근 라인을
        // 고른다(방금 끝난 도구 = 그 스텝). 전부 붙었으면 마지막. threadKey 엔 따옴표 없어 안전.
        const lines = stream.querySelectorAll('.act-line[data-seq="' + ap.seq + '"][data-threadkey="' + tk + '"]');
        if (lines.length) {
          let target = null;
          for (let i = lines.length - 1; i >= 0; i--) {
            if (!lines[i].querySelector(":scope > .dur-badge")) { target = lines[i]; break; }
          }
          applyDurationBadge(target || lines[lines.length - 1], ap.durationMs);
        }
      };

      // ★드로어를 여는 순간 서버와 맞춘다 (2026-08-02) — **보는 순간이 정확해야 할 순간**이다.
      //  종전엔 대조가 부팅·SSE재연결에만 걸려 있어, 닫아둔 사이 끝난 잡이 "진행 중" 으로
      //  굳은 채 열렸다(그 worker.done 은 이미 지나갔고 다시 오지 않는다).
      // ★열림 여부도 기억한다 (2026-08-10). 폭(tc:bgPanelWidth)은 이미 저장되고 있었는데
      //  **열려 있었는지**만 없어서, 새로고침하면 늘 닫힌 채로 시작했다. 진행 중인 작업을
      //  보려고 열어둔 사람에겐 그게 매번 다시 여는 일이 된다.
      const BG_OPEN_LS = "dash.bgOpen.v1";
      const rememberBgOpen = (on) => {
        try { localStorage.setItem(BG_OPEN_LS, on ? "1" : "0"); } catch { /* quota·프라이빗 */ }
      };
      const openBg = () => {
        document.body.classList.add("bg-open");
        bgPanel.setAttribute("aria-hidden", "false");
        updateBgJump();
        rememberBgOpen(true);
        if (typeof window.resyncBackground === "function") window.resyncBackground();
      };
      // 부팅 복원 — 모바일은 제외한다. 좁은 화면에서 드로어는 전면을 덮어서, 켜둔 채
      // 새로고침하면 채팅이 가려진 채로 시작한다(PC 는 옆으로 밀어 공존한다).
      try {
        const wasOpen = localStorage.getItem(BG_OPEN_LS) === "1";
        const narrow = window.matchMedia("(max-width: 900px)").matches;
        if (wasOpen && !narrow) openBg();
      } catch { /* 조회 실패 = 닫힌 채 시작(기존 동작) */ }
      const closeBg = () => { document.body.classList.remove("bg-open"); bgPanel.setAttribute("aria-hidden", "true"); rememberBgOpen(false); };
      // 프로젝트 상세의 compact 카드 클릭 → bg 패널 열고 그 잡으로 스크롤·펼침(자세히는 여기서).
      //   best-effort: 잡이 현재 bg 스코프 필터에 안 걸려 미렌더면 패널만 열림(스코프는 존중).
      window.focusBgJob = (jobId) => {
        openBg();
        requestAnimationFrame(() => {
          const entry = jobCards.get(jobId);
          if (!entry || !entry.el) return;
          if (entry.el.classList.contains("has-detail") && !entry.el.classList.contains("open")) {
            entry.el.classList.add("open");
            if (typeof updateChev === "function") updateChev(entry);
            if (entry.stepsEl) requestAnimationFrame(() => { entry.stepsEl.scrollTop = entry.stepsEl.scrollHeight; });
          }
          if (entry.el.scrollIntoView) entry.el.scrollIntoView({ block: "center" });
        });
      };
      const bgToggleBtn = document.getElementById("bg-toggle");
      if (bgToggleBtn) bgToggleBtn.addEventListener("click", () => {
        document.body.classList.contains("bg-open") ? closeBg() : openBg();
      });
      const bgCloseBtn = document.getElementById("bg-close");
      if (bgCloseBtn) bgCloseBtn.addEventListener("click", closeBg);
      const bgBackdrop = document.getElementById("bg-backdrop");
      if (bgBackdrop) bgBackdrop.addEventListener("click", closeBg);

      // 진행 중 필터(기본 "running") — status 클래스 기반 CSS 로 카드 숨김/표시. 라이브 이벤트가
      // status 를 바꾸면 CSS 가 즉시 재평가 → 잡 등장/사라짐이 별도 재렌더 없이 자동 반영.
      const bgFilterEl = document.getElementById("bg-filter");
      const bgCountRunning = document.getElementById("bg-count-running");
      const bgCountAll = document.getElementById("bg-count-all");
      let bgFilter = "running"; // "running" | "done"(완료=종료된 잡만, 상호배타)
      const setBgFilter = (mode) => {
        bgFilter = mode === "done" ? "done" : "running";
        bgList.classList.toggle("filter-running", bgFilter === "running");
        bgList.classList.toggle("filter-done", bgFilter === "done");
        if (bgFilterEl) for (const b of bgFilterEl.querySelectorAll(".bg-fbtn")) {
          const on = b.dataset.filter === bgFilter;
          b.classList.toggle("active", on);
          b.setAttribute("aria-pressed", on ? "true" : "false");
        }
        refreshBgBadge();
      };
      if (bgFilterEl) for (const b of bgFilterEl.querySelectorAll(".bg-fbtn")) {
        b.addEventListener("click", () => setBgFilter(b.dataset.filter));
      }

      // 세션 스코프 필터(기본 "session" — 사용자 확정) — 활성 세션(activeThreadKey)이 띄운 잡만
      // 보여주고, "전체 세션" 토글로 전 세션 잡을 드러낸다. 위 상태필터(running/all)와 독립 축이라
      // AND 결합(카드 레벨 .bg-in-scope 클래스 + 리스트 레벨 .scope-session 클래스, app.css 참조).
      // 영속 불필요(사용자 확정) — 매 로드 기본 "session".
      const bgScopeFilterEl = document.getElementById("bg-scope-filter");
      let bgSessionScope = "session"; // "session" | "all"
      // 카드가 활성 세션 소속인가 — threadKey 없음(레거시/구버전 카드)은 항상 소속 취급(누락 0,
      // isActiveThread 의 "미지정=활성" 관례와 동형).
      // 세션 스코프 판정 — 잡 좌표는 원 세션으로 환원한 뒤 비교(서브에이전트가 남의 세션에
      //  뜨던 원인). 근거 우선순위: ①서버가 환원해 실어 준 ownerThreadKey(authoritative —
      //  잡 레지스트리 전체를 봄) ②없으면 프런트 부모-체인 추측(구버전 이벤트 replay 대비).
      // ★미상은 숨긴다 (2026-07-28, fail-closed). 종전엔 노출이었는데("숨기는 쪽이 더 나쁜
      //  실패"), 프런트 지도가 부분집합이라 미상이 흔했고 결과적으로 **사용자가 "현재 세션만"
      //  으로 해뒀는데도 남의 세션 잡이 떴다**(신고 2회). 명시한 필터를 어기는 쪽이 더 나쁜
      //  실패다. 숨겨도 "전체 세션" 토글이 escape hatch 이고, 진행 중 잡은 부팅
      //  하이드레이션(GET /api/worker-jobs)이 전부 ownerThreadKey 를 실어 오므로 미상 ≈ 0.
      const isBgInScope = (tk, ownerHint) => {
        const owner =
          typeof ownerHint === "string" && ownerHint !== ""
            ? ownerHint
            : jobOwnerSession(tk);
        return owner !== "" && owner === activeThreadKey;
      };
      const setBgSessionScope = (mode) => {
        bgSessionScope = mode === "all" ? "all" : "session";
        bgList.classList.toggle("scope-session", bgSessionScope === "session");
        if (bgScopeFilterEl) for (const b of bgScopeFilterEl.querySelectorAll(".bg-fbtn")) {
          const on = b.dataset.scope === bgSessionScope;
          b.classList.toggle("active", on);
          b.setAttribute("aria-pressed", on ? "true" : "false");
        }
        refreshBgBadge();
        // 셸 그룹도 같은 토글을 따른다(2026-07-28) — 셸은 CSS 숨김이 아니라 렌더에서 거르므로
        // (카운트 정합) 여기서 재렌더를 걸어 준다. 로드 순서 무관하게 typeof 가드.
        if (typeof scheduleShellsRender === "function") scheduleShellsRender();
      };
      if (bgScopeFilterEl) for (const b of bgScopeFilterEl.querySelectorAll(".bg-fbtn")) {
        b.addEventListener("click", () => setBgSessionScope(b.dataset.scope));
      }

      // ── 카테고리 그룹 접기/펴기(작업 레인 / 셸 레인) — 헤더(.bg-group-head) 클릭 시 본문
      // (.bg-group-body, 헤더 바로 뒤 형제) 을 CSS(.collapsed + .bg-group-body{display:none})로
      // 접고, chevron 회전·localStorage 영속. 세션 스코프(위)는 두 그룹 공유, 상태필터는 각 본문 안.
      // 모듈 뷰 collapse 패턴의 드로어판(별도 클래스). 헤더는 role=button — Enter/Space 도 토글.
      const BG_CAT_KEY = "bg-cat-collapse:";
      const wireBgGroup = (headId) => {
        const head = document.getElementById(headId);
        if (!head) return;
        const key = BG_CAT_KEY + headId;
        const apply = (collapsed) => {
          head.classList.toggle("collapsed", collapsed);
          head.setAttribute("aria-expanded", collapsed ? "false" : "true");
        };
        let saved = false;
        try { saved = localStorage.getItem(key) === "1"; } catch {}
        apply(saved); // 초기 복원(기본 펼침).
        const toggle = () => {
          const collapsed = !head.classList.contains("collapsed");
          apply(collapsed);
          try { localStorage.setItem(key, collapsed ? "1" : "0"); } catch {}
        };
        head.addEventListener("click", toggle);
        head.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
        });
      };
      wireBgGroup("bg-jobs-head");
      wireBgGroup("bg-shells-head");

      // 탭 전환(activeThreadKey 변경) 후 재적용 훅 — js/tabs.js 가 switchToThread/newTab/closeTab
      // 뒤에 호출(전역 스코프, background-drawer.js 가 tabs.js 보다 먼저 로드돼 참조 가능).
      const refreshBgScope = () => {
        for (const e of jobCards.values()) e.el.classList.toggle("bg-in-scope", isBgInScope(e.threadKey, e.ownerTk));
        refreshBgBadge();
        // 셸 그룹은 렌더에서 거르므로(카운트 정합) 세션이 바뀌면 재렌더가 필요하다.
        if (typeof scheduleShellsRender === "function") scheduleShellsRender();
        if (typeof refreshShellStrip === "function") refreshShellStrip(); // 상단 "🖥️ N개" 도 갱신.
      };

      const refreshBgBadge = () => {
        // 잡 상태가 바뀌면 입력창 위 표시도 다시 판정한다 — 메인이 비었는데 백그라운드가
        // 도는 구간을 "대기 중" 으로 보여주는 게 그 표시의 일이다(2026-08-21).
        if (typeof refreshWorking === "function") setTimeout(refreshWorking, 0);
        let running = 0, runningScoped = 0, totalScoped = 0;
        for (const e of jobCards.values()) {
          if (e.status === "running") running += 1;
          if (isBgInScope(e.threadKey, e.ownerTk)) {
            totalScoped += 1;
            if (e.status === "running") runningScoped += 1;
          }
        }
        const total = jobCards.size;
        if (bgBadge) {
          bgBadge.textContent = String(running);
          bgBadge.classList.toggle("show", running > 0);
        }
        // 드로어 내부 필터 카운트(진행 중/완료 버튼) — 현재 세션 스코프 반영(화면에 실제 보이는
        // 수와 일치시킴). "완료"=종료된 잡(status!=="running")만(상호배타, "전체" 아님). 헤더 배지·
        // nav·에이전트뷰는 아래에서 전역 유지(스코프 무관, 회귀 방지). bg-count-all id 는 유지하되 의미=완료수.
        const dispRunning = bgSessionScope === "session" ? runningScoped : running;
        const dispDone = bgSessionScope === "session" ? (totalScoped - runningScoped) : (total - running);
        if (bgCountRunning) bgCountRunning.textContent = String(dispRunning);
        if (bgCountAll) bgCountAll.textContent = String(dispDone);
        // 왼쪽 nav "에이전트" 항목 카운트 뱃지 = 진행 중 개수(라이브, 전역).
        const navAgentCount = document.getElementById("nav-agent-count");
        if (navAgentCount) navAgentCount.textContent = String(running);
        // 에이전트 메인 뷰 자체 카운트/빈상태도 함께 갱신(전역, 열려 있을 때만 렌더).
        if (typeof syncAgentsCounts === "function") syncAgentsCounts(running, total);
        // 빈 메시지 — 활성 상태필터 × 세션스코프 AND 기준(드로어에 실제 보이는 카드 수와 일치).
        const visible = bgFilter === "running" ? dispRunning : dispDone;
        if (bgEmpty) {
          bgEmpty.style.display = visible === 0 ? "" : "none";
          // ★"없습니다" 로 **단정하지 않는다** (2026-08-20 재검토 F3). 헤더 배지는 전역이고
          //  이 목록은 세션 스코프라 **둘이 다른 건 설계**인데, 종전 문구는 그 차이를 안 말해서
          //  사용자가 "숫자는 2인데 카드가 없다" 를 신고했다(그리고 나는 그걸 결함으로 쫓았다).
          //  숫자가 갈릴 땐 **어디에 있는지**를 말한다 — 스코프 토글이 바로 옆에 있다.
          const kindWord = bgFilter === "running" ? i18n("bg.filter.runningAdj") : i18n("bg.filter.doneAdj");
          const elsewhere = bgSessionScope === "session"
            ? (bgFilter === "running" ? running - runningScoped : (total - running) - (totalScoped - runningScoped))
            : 0;
          bgEmpty.textContent = elsewhere > 0
            ? i18n("bg.empty.elsewhere", { kind: kindWord, n: elsewhere })
            : i18n("bg.empty.scoped", { kind: kindWord });
        }
        // 컴포저 인디케이터 — 현재 세션(runningScoped)에 도는 작업이 있으면 입력창 위에 표시.
        if (chatBgActiveEl) {
          if (runningScoped > 0) {
            chatBgActiveEl.textContent = i18n("bg.activeCount", { n: runningScoped });
            chatBgActiveEl.hidden = false;
          } else {
            chatBgActiveEl.hidden = true;
          }
        }
      };
      const capBgList = () => {
        while (jobCards.size > BG_MAX) {
          // 카드는 그룹 컨테이너 안에 중첩될 수 있어 직계 순회 대신 .bg-job 후손을 뒤에서부터.
          const cards = bgList.querySelectorAll(".bg-job");
          let removed = false;
          for (let i = cards.length - 1; i >= 0; i--) {
            const node = cards[i];
            const jid = node.dataset ? node.dataset.jobId : null;
            if (!jid) continue;
            const entry = jobCards.get(jid);
            if (entry && entry.status !== "running") { node.remove(); jobCards.delete(jid); removed = true; break; }
          }
          if (!removed) break; // 전부 running 이면 중단.
        }
      };
      // 펼침 어포던스 — 작업(task)/스텝/결과(result) 중 하나라도 있으면 카드를 펼칠 수 있다.
      // (도구 안 쓴 잡은 스텝 0 이어도 task/result 로 내용을 보여줘 "눌러도 빈" 문제 해소.)
      const updateChev = (entry) => {
        const hasDetail = entry.stepCount > 0 || entry.hasTask || entry.hasResult;
        if (!hasDetail) { entry.chevEl.style.display = "none"; entry.el.classList.remove("has-detail"); return; }
        entry.chevEl.style.display = "";
        entry.el.classList.add("has-detail");
        const open = entry.el.classList.contains("open");
        entry.chevEl.textContent = (open ? "▾ " : "▸ ") + (entry.stepCount > 0 ? i18n("bg.stepCount", { n: entry.stepCount }) : i18n("bg.more"));
      };
      // opts.threadKey 에서 "진짜" 원 세션 threadKey 만 뽑는다 — handleWorkerActivity 는 라우팅용
      // 내부 의사-threadKey("worker:<jobId>"/"agent:<jobId>")를 opts.threadKey 로 넘기기도 하는데,
      // 그건 세션 스코프 판정에 쓰면 안 됨(원 세션이 아니라 잡 좌표라 activeThreadKey 와 절대 안 맞음).
      // ★잡 좌표를 버리지 않는다 (2026-07-27). 종전엔 `worker:`/`agent:` 접두면 ""(미상)로
      //  버렸는데, **서브에이전트의 threadKey 는 원래 부모 잡 좌표**다(DB 실측: kind=agent
      //  138건 중 33건이 `worker:<부모id>`). 그래서 서브에이전트 카드는 영구히 미상이 되고,
      //  isBgInScope 가 미상을 "모든 세션 소속" 으로 취급해 **다른 세션에서도 진행 중으로 떴다**
      //  (사용자 신고). 좌표는 버릴 정보가 아니라 *부모를 가리키는 링크* 이므로 그대로 두고,
      //  세션 귀속은 판정 시점에 jobOwnerSession 이 부모를 따라 올라가 환원한다(파생 상태).
      const realSessionThreadKey = (tk) => (typeof tk === "string" ? tk : "");
      /**
       * 잡 좌표(`worker:`/`agent:<jobId>`)를 **원 세션 threadKey** 로 환원. 이미 세션 키면 그대로.
       * 부모 체인을 따라 올라가며(서브에이전트가 서브에이전트를 띄운 경우) 자기참조·순환은 끊는다
       * (활동-선도 카드는 자기 좌표를 들고 있어 자기참조가 실제로 발생한다).
       * 못 찾으면 ""(미상) — 호출자가 정책을 정한다. shellOwnerSession 의 잡 버전.
       */
      const jobOwnerSession = (tk, seen) => {
        if (typeof tk !== "string" || tk === "") return "";
        const m = /^(?:worker|agent):(.+)$/.exec(tk);
        if (!m) return tk; // 세션 키 — 환원 끝.
        const id = m[1];
        const s = seen || new Set();
        if (s.has(id)) return ""; // 자기참조/순환 — 미상으로 닫는다.
        s.add(id);
        const parent = jobCards.get(id);
        return parent ? jobOwnerSession(parent.threadKey, s) : "";
      };
      // 워커 라벨 접두 — 서브에이전트("🤖 <name>")와 대칭 표기용(아래 ensureJobCard 참조).
      const WORKER_LABEL_PREFIX = "📦 ";
      /**
       * kind 에 맞는 라벨을 돌려준다 — **순수 함수**(2026-08-26).
       *
       * 규칙: 워커면 접두를 붙이고, 에이전트면 뗀다. **멱등**이라 몇 번 불러도 같다.
       * ★함수로 뺀 이유는 미관이 아니라 **검사 가능성**이다 — 종전엔 이 판단이 갱신 루프
       *  한복판에 인라인으로 있어서 회귀가 부를 수가 없었고, 그래서 접두 규칙엔 그물이
       *  **하나도 없었다**(적대 검토 G축 ②). 접두가 두 번 붙거나 승격 때 안 떨어져도
       *  스위트는 초록이다 — 화면에서 눈으로만 보인다.
       */
      const withKindPrefix = (kind, label) => {
        const has = String(label).indexOf(WORKER_LABEL_PREFIX) === 0;
        if (kind === "agent") return has ? String(label).slice(WORKER_LABEL_PREFIX.length) : String(label);
        return has ? String(label) : WORKER_LABEL_PREFIX + String(label);
      };
      /**
       * 잡 카드 라벨을 정하는 **유일한 자리** — 상태(`label`·`hasLabel`)와 화면을 같이 쓴다.
       *
       * ★종전엔 "이름이 아직 없다" 를 화면 글자로 판정했다(`textContent === "(작업)"`, 3곳).
       *  표시 문자열을 상태로 쓰면 그 문구를 번역하는 순간 판정이 언어별로 갈린다
       *  ([[JOB_LABEL_FALLBACK]] 주석 참조). 상태를 따로 들면 번역은 표시만 바꾼다.
       * ★`label` 을 문자열로도 보관하는 이유는 옆 뷰 때문이다 — `view-agents.js` 가 이 카드의
       *  DOM(`labelEl.textContent`)을 건너 읽고 있었다. `lastStep`·`task` 가 이미 쓰는 방식
       *  (DOM 과 별개 보관)으로 맞춰 뷰 간 DOM 결합을 없앤다.
       * 빈 문자열 = 아직 이름 없음(화면엔 폴백 문구).
       */
      const setJobLabel = (entry, text) => {
        entry.label = typeof text === "string" ? text : "";
        entry.hasLabel = entry.label !== "";
        entry.labelEl.textContent = entry.hasLabel ? entry.label : JOB_LABEL_FALLBACK;
      };
      // 잡 카드 확보(없으면 생성). label/task 는 worker.started, result 는 worker.done 이 채운다.
      // 소속 세션 배지 갱신 — 이름을 **알 때만** 단다(멱등). ownerTk 는 lifecycle/하이드레이션이
      // 뒤늦게 채울 수 있고, 세션 이름도 `/api/sessions` 폴 뒤에야 알려질 수 있으므로 여러 번
      // 불린다. ★모르면 숨긴다 — 원시 좌표(`dashboard:1784…`)를 대신 보여주지 않는다(사용자에게
      // 의미 없는 문자열이고, 그걸 이름처럼 두면 "없는 것을 지어낸" 배지가 된다).
      const updateSessionBadge = (entry) => {
        const el = entry && entry.sessBadgeEl;
        if (!el) return;
        const tk = entry.ownerTk || "";
        const name = tk ? sessionNameFor(tk) : "";
        const raw = entry.rawTkEl;
        if (name === "") {
          el.style.display = "none";
          // 이름을 모르면 좌표라도 보여야 한다 — 둘 다 없으면 어느 대화 것인지 알 길이 없다.
          if (raw) raw.style.display = "";
          return;
        }
        el.textContent = "↪ " + name;
        el.title = i18n("bg.ownerSession.title", { tk });
        el.style.display = "";
        if (raw) raw.style.display = "none"; // 이름이 있으면 좌표는 툴팁에만.
      };

      const ensureJobCard = (jobId, opts) => {
        let entry = jobCards.get(jobId);
        if (!entry) {
          const el = document.createElement("div");
          el.className = "bg-job running";
          el.dataset.jobId = jobId;
          el.dataset.threadkey = realSessionThreadKey(opts && opts.threadKey); // 세션 스코프 필터 대상.
          const top = document.createElement("div"); top.className = "bg-job-top";
          const label = document.createElement("span"); label.className = "bg-job-label";
          label.textContent = JOB_LABEL_FALLBACK; // 실제 값은 entry 생성 직후 setJobLabel 이 정한다.
          // kind 배지(워커/서브에이전트) — status 뱃지와 별개 축. 기본은 워커 배지("📦 워커")를
          // 항상 표시하고, lifecycle 로 서브에이전트로 승격되면 아래에서 텍스트를 교체(.agent 가 색 전환).
          const kindBadge = document.createElement("span"); kindBadge.className = "bg-job-kind";
          kindBadge.textContent = AGENT_KIND_BADGE.worker;
          // 모델 티어 칩 — kind==="agent" 이고 modelTier 있을 때만(default 제외). kindBadge 옆에.
          const tierBadge = document.createElement("span"); tierBadge.className = "bg-job-tier"; tierBadge.style.display = "none";
          // 상대시간 — 머리줄 우측. "언제 일어났나"(경과시간과 다른 질문이라 같이 둔다).
          //  값은 tickElapsed 가 startTs 를 알게 된 뒤 채운다(카드 생성 시점엔 아직 모를 수 있다).
          const ago = document.createElement("span"); ago.className = "bg-job-ago";
          const st = document.createElement("span"); st.className = "bg-job-status";
          // 기본 상태 텍스트 — 활동(activity)으로만 생성된 카드(대시보드가 worker.started 를
          // 놓친 경우: 워커 실행 중 새로고침 등)도 상태 뱃지가 비지 않게. 라이프사이클 이벤트
          // 오면 handleWorkerEvent 가 실제 상태로 갱신. entry.status 기본값("running")과 일치.
          st.textContent = BG_STATUS.running;
          // 중지 버튼 — running 이면 노출(worker·agent 무관, U-I4 개정; updateStopBtn 이 켜고/끔).
          // 클릭은 top 의 펼침 토글로 버블링되지 않게 stopPropagation.
          const stopBtn = document.createElement("button");
          stopBtn.type = "button"; stopBtn.className = "bg-job-stop"; stopBtn.title = i18n("bg.stopTitle");
          stopBtn.textContent = i18n("bg.stop"); stopBtn.style.display = "none";
          stopBtn.addEventListener("click", (ev) => { ev.stopPropagation(); void requestCancelJob(jobId); });
          const chev = document.createElement("span"); chev.className = "bg-job-chev"; chev.style.display = "none";
          // 실제 응답 모델 (2026-07-27) — tierBadge 는 *요청한* 티어(high/mid/low)이고 이건 그
          //  요청이 실제로 어느 모델로 실행됐나다. 둘이 갈리는 경우(폴백·쿨다운)를 보이게 하는 게
          //  목적이라 티어 바로 옆에 둔다 — "high 로 보냈는데 뭐가 답했나"가 한 줄에 보인다.
          const modelBadge = document.createElement("span");
          modelBadge.className = "bg-job-model"; modelBadge.style.display = "none";
          top.appendChild(label); top.appendChild(kindBadge); top.appendChild(tierBadge); top.appendChild(modelBadge); top.appendChild(ago); top.appendChild(st); top.appendChild(stopBtn); top.appendChild(chev);
          const meta = document.createElement("div"); meta.className = "bg-job-meta";
          meta.textContent = (opts && opts.ts) || "";
          // ★원시 좌표는 **이름 배지가 없을 때만** 보인다 (2026-08-07 사용자 지적).
          //  이름이 붙었는데 `dashboard:05f08ea8-…` 를 나란히 두면 같은 정보를 두 번 말하면서
          //  긴 쪽이 카드를 밀어낸다. 좌표는 버리는 게 아니라 **툴팁으로** 내린다 — 진단할 땐
          //  여전히 필요하고(잡↔세션 대조), 평소엔 읽을 일이 없다.
          const rawTk = document.createElement("span");
          rawTk.className = "bg-job-rawtk";
          if (opts && opts.threadKey) {
            rawTk.textContent = " · " + opts.threadKey;
            rawTk.title = opts.threadKey;
          }
          meta.appendChild(rawTk);
          // ★"지금 무엇을 하는 중인가" (2026-08-24 사용자 신고: "새로고침하면 백그라운드
          //  매니저·에이전트의 뭘 진행중인지가 사라져"). 종전엔 이 정보가 SSE 스텝으로만
          //  왔는데, replay 창(50) 밖으로 밀린 긴 잡은 새로고침 뒤 영영 안 왔다 — 카드는
          //  하이드레이션으로 서는데 **속이 비었다.** 서버가 `/api/worker-jobs` 로 같이
          //  주므로(점검이 쓰는 것과 **같은 증거**) 여기 한 줄로 그린다.
          const doingEl = document.createElement("span");
          doingEl.className = "bg-job-doing";
          doingEl.style.display = "none";
          meta.appendChild(doingEl);
          // ★소속 세션 배지 (2026-08-06) — "이 잡을 어느 대화가 띄웠나". 종전엔 원시 좌표
          //  (`dashboard:1784…`)만 있어 사람이 읽을 수 없었고, 스코프 필터로 거를 수는 있어도
          //  전체를 볼 땐 구분이 안 됐다. 이름은 공유 해석기(서버 정본)에서 가져오고,
          //  ★모르면 **달지 않는다** — 없는 이름을 지어내지 않는다(채널 배지 사고와 같은 규칙).
          //  누르면 그 세션으로 이동(기존 job.jumpSession 재사용 — 우클릭 메뉴에만 있던 동작).
          const sessBadge = document.createElement("span");
          sessBadge.className = "bg-job-session"; sessBadge.style.display = "none";
          sessBadge.addEventListener("click", (e) => {
            e.stopPropagation();
            const tk = entry && entry.ownerTk;
            if (tk && typeof switchToThread === "function") {
              if (typeof openTabs !== "undefined" && !openTabs.some((t) => t.threadKey === tk)) {
                openTabs.push({ threadKey: tk, name: sessionNameFor(tk) || deriveTabFallbackName(tk) });
              }
              if (typeof setActiveNav === "function") setActiveNav("chat");
              switchToThread(tk);
            }
          });
          meta.appendChild(sessBadge);
          // 항상 보이는 한 줄 작업 요약(이름 아래·1줄 truncate) — 같은 이름 서브 여러 개도 구분되게.
          // 전문은 펼침 영역(bg-job-task)에. task 없으면 숨김.
          const summary = document.createElement("div"); summary.className = "bg-job-summary"; summary.style.display = "none";
          // 진행 중 라이브 줄 — 경과시간 + 마지막 스텝(현재 작업). 펼치지 않아도 "지금 뭘 하나" 즉시.
          const live = document.createElement("div"); live.className = "bg-job-live";
          const elapsed = document.createElement("span"); elapsed.className = "bg-job-elapsed"; elapsed.textContent = "0s";
          const laststep = document.createElement("span"); laststep.className = "bg-job-laststep";
          live.appendChild(elapsed); live.appendChild(laststep);
          const err = document.createElement("div"); err.className = "bg-job-err"; err.style.display = "none";
          // 펼침 영역(open 시 표시): 작업 + 스텝 + 결과.
          const detail = document.createElement("div"); detail.className = "bg-job-detail";
          const task = document.createElement("div"); task.className = "bg-job-task"; task.style.display = "none";
          const steps = document.createElement("div"); steps.className = "bg-job-steps";
          const result = document.createElement("div"); result.className = "bg-job-result"; result.style.display = "none";
          detail.appendChild(task); detail.appendChild(steps); detail.appendChild(result);
          el.appendChild(top); el.appendChild(meta); el.appendChild(summary); el.appendChild(live); el.appendChild(err); el.appendChild(detail);
          top.addEventListener("click", () => {
            if (entry.el.classList.contains("has-detail")) { el.classList.toggle("open"); updateChev(entry); }
          });
          // 최신=위 삽입 + stickTop 팔로우 — 삽입 전 맨 위 근처(최신 주시)면 삽입 후 top 으로
          // 스냅해 새 카드 노출. 아래로 내려 과거 잡을 보는 중이면 존중(브라우저 scroll-anchoring
          // 이 위치 보존, yank 금지) = 채팅 stickBottom 의 상단판. 임계 40px.
          const _bgNearTop = bgList.scrollTop < 40;
          bgList.insertBefore(el, bgList.firstChild); // 최신=위(bgEmpty 는 size>0 면 숨김).
          if (_bgNearTop) bgList.scrollTop = 0;
          updateBgJump(); // 새 카드가 위에 쌓임 — 내려본 상태면 "↑ 최신" 노출 갱신.
          entry = {
            el, labelEl: label, statusEl: st, chevEl: chev, taskEl: task, stepsEl: steps,
            sessBadgeEl: sessBadge, rawTkEl: rawTk,
            resultEl: result, errEl: err, kindBadgeEl: kindBadge, stopBtnEl: stopBtn,
            liveEl: live, elapsedEl: elapsed, agoEl: ago, lastStepEl: laststep, tierBadgeEl: tierBadge, summaryEl: summary,
            modelBadgeEl: modelBadge, modelSeen: "", // 실제 응답 모델(활동 이벤트에서 채움).
            doingEl, // "지금 무엇을 하는 중" 한 줄(서버 activity).
            activity: null, // { lastActivityAt, inFlight:[{tool,since}] } — /api/worker-jobs.
            // ★경과시간 기준은 **서버가 준 잡 시작 시각**이다 (2026-08-20 적대 검토 C).
            //  종전엔 무조건 `Date.now()`(카드가 생긴 시각)라, 2시간째 자식을 기다리는
            //  매니저도 **새로고침하면 "0s"** 로 보였다. 서버는 `/worker-jobs` 로 `startedAt`
            //  을 이미 주고 있었는데 그 값을 **시각 표기에만** 쓰고 경과시간엔 안 썼다 —
            //  어제 같은 줄에서 시각 표기(epoch 원값)는 고치고 바로 옆 필드는 놓쳤다.
            //  ★옆 레인(`view-shells.js`)은 처음부터 `s.startedAt || Date.now()` 로 맞다.
            startTs:
              opts && typeof opts.startedAt === "number" ? opts.startedAt : Date.now(),
            // ★경합 가드용 **카드 생성 시각** — `startTs` 와 축이 다르다.
            //  하이드레이션 대조는 "이 fetch 이후에 생긴 카드는 대상이 아니다" 를 판정하는데,
            //  `startTs` 가 이제 (더 오래된) 잡 시작 시각이라 그걸 쓰면 fetch 뒤에 생긴 카드도
            //  대조 대상이 되어 **엉뚱하게 interrupted** 로 찍힌다. 두 질문이 다르므로 값도 둘이다.
            createdTs: Date.now(),
            lastStep: "", // 마지막 활동 라벨(문자열) — DOM 과 별개로 보관, 에이전트 뷰가 DOM 결합 없이 읽음.
            modelTier: "", // 서브에이전트 모델 티어(low/mid/high 등) — lifecycle payload.modelTier. 에이전트 뷰도 읽음.
            cwd: "", // 실행 폴더(cwd) — worker.started payload.cwd. 프로젝트 상세가 이걸로 필터/귀속.
            task: "", result: "", errorText: "", // 작업 지시/결과/에러 원문(문자열) — DOM 과 별개 보관. 에이전트 뷰가 한 줄 요약·펼침 상세에 읽음.
            expanded: false, // 에이전트 뷰 카드 펼침 상태(jobId 별) — 리렌더돼도 유지. 드로어는 .open 클래스로 별도 관리.
            label: "", hasLabel: false, // setJobLabel 이 정한다(아래). 빈 값 = 아직 이름 없음.
            status: "running", kind: "worker", stepCount: 0, hasTask: false, hasResult: false,
            threadKey: realSessionThreadKey(opts && opts.threadKey), // 잡 좌표 원본(부모 링크일 수 있음).
            // 서버가 환원한 원 세션(worker.* payload / GET /api/worker-jobs 의 ownerThreadKey).
            // 세션 스코프 판정의 1순위 근거 — 없으면 "" 로 두고 프런트 추측으로 폴백.
            ownerTk: opts && typeof opts.ownerThreadKey === "string" ? opts.ownerThreadKey : "",
            seenSteps: new Set(), // ★스텝 dedup — SSE replay(새로고침 재연결)가 같은 활동을 재전송해도 중복 append 방지.
            _cancelRequested: false, // 낙관 취소 요청 중(재클릭 방지) — cancelled:false/실패 시 되돌림.
          };
          setJobLabel(entry, opts && opts.label ? String(opts.label) : "");
          entry.el.classList.toggle("bg-in-scope", isBgInScope(entry.threadKey, entry.ownerTk));
          updateSessionBadge(entry);
          jobCards.set(jobId, entry);
          // ★원 세션을 **모르는 채로 태어난 카드는 서버에 묻는다** (2026-08-20 사용자 신고:
          //  "매니저가 사라졌는데 백그라운드 숫자는 2개").
          //  활동(llm.activity)이 lifecycle 보다 먼저 오면 카드는 잡 좌표(worker:<id>)만 들고
          //  태어난다. 그러면 스코프 판정이 프런트 추측으로 떨어지는데, 매니저는 자기 좌표가
          //  곧 자기 jobId 라 그 추측이 세션까지 못 간다 → **스코프 밖으로 숨는다.** 반면 헤더
          //  배지는 전역 집계라 계속 세므로 "숫자는 있는데 카드가 없다" 가 된다.
          //  하이드레이션은 로드·재연결 때만 돌아 그 사이 생긴 카드는 계속 미상으로 남았다.
          //  ★추측을 정교하게 만들지 않는다 — 서버가 아는 사실(ownerThreadKey)을 가져온다.
          if (entry.ownerTk === "") scheduleOwnerBackfill();
          updateStopBtn(entry); // 신규 카드 기본 running → 중지 버튼 노출(worker·agent 무관).
          // 컨텍스트메뉴 트리거 — kebab(top 우측) + 우클릭 + 롱프레스(카드류, 3경로 동일 메뉴).
          // ctxFn 은 매 호출 시 최신 entry 를 다시 읽어(jobCards.get) label/threadKey 드리프트 없음.
          const jobCtx = () => {
            const e = jobCards.get(jobId);
            return { type: "job", targetId: jobId, threadKey: e ? e.threadKey : "", label: (e && e.label) || jobId };
          };
          attachKebab(top, "job", jobCtx);
          attachContextMenu(el, "job", jobCtx);
          attachLongPress(el, "job", jobCtx);
          // 활동으로만 생성된 카드도 헤더 '백그라운드 N' 개수 뱃지·bgEmpty 를 즉시 반영
          // (기존엔 handleWorkerEvent 만 refreshBgBadge 호출 → 활동-only 카드는 개수 누락).
          refreshBgBadge();
        }
        // 세션 스코프 threadKey 갱신(멱등) — 활동-선도 카드(worker:/agent: 의사값만 있던 카드)에
        // 나중에 lifecycle 이 진짜 원 세션 threadKey 를 실어 오면 반영. 이미 같으면 no-op.
        {
          const realTk = realSessionThreadKey(opts && opts.threadKey);
          if (realTk && entry.threadKey !== realTk) {
            entry.threadKey = realTk;
            entry.el.dataset.threadkey = realTk;
            entry.el.classList.toggle("bg-in-scope", isBgInScope(entry.threadKey, entry.ownerTk));
          }
        }
        // 서브에이전트 마킹(멱등) — lifecycle(kind:"agent")이 활동보다 먼저/나중 어느 쪽으로 와도
        // 카드를 서브로 승격. 배지 텍스트를 워커→서브에이전트로 교체(.agent 클래스가 색 전환).
        // 워커(kind 미지정/"worker")는 기본 워커 배지 그대로 유지.
        if (opts && opts.kind === "agent" && entry.kind !== "agent") {
          entry.kind = "agent";
          entry.el.classList.add("agent");
          entry.kindBadgeEl.textContent = AGENT_KIND_BADGE.agent;
          updateStopBtn(entry); // awaited 서브에이전트 승격 후에도 running 이면 중지버튼 표시(U-I4 개정).
        }
        // 에이전트명 채우기 — 활동-선도 카드는 activity 시엔 agentName 이 없어 라벨이 "(작업)".
        // lifecycle 이 agentName 을 실어 오면(먼저든 나중이든) 라벨을 "🤖 <name>" 로. 이미 채웠으면 무영향.
        if (entry.kind === "agent" && opts && opts.agentName) {
          const want = "🤖 " + opts.agentName;
          if (entry.label !== want) setJobLabel(entry, want);
        }
        // 모델 티어(멱등) — 워커·서브 공통, modelTier 있을 때만. "default"/빈값은 표시 생략.
        // lifecycle 이 실어 오면(먼저/나중 무관) entry.modelTier 저장 + 드로어 칩 갱신. 에이전트 뷰는 renderAgentsView 가 읽음.
        if (opts && opts.modelTier != null && String(opts.modelTier).trim() !== "" && String(opts.modelTier).trim().toLowerCase() !== "default") {
          const tier = String(opts.modelTier).trim();
          entry.modelTier = tier;
          const show = tier !== "" && tier.toLowerCase() !== "default";
          if (entry.tierBadgeEl) {
            entry.tierBadgeEl.textContent = tier;
            entry.tierBadgeEl.dataset.tier = tier.toLowerCase();
            entry.tierBadgeEl.style.display = show ? "" : "none";
            // ★프로파일이 정한 색을 입힌다 (2026-08-24). CSS 엔 `low|mid|high` **세 이름만**
            //  적혀 있어서 사용자가 만든 프로파일(`gpt-high` 등)은 전부 회색이었다 —
            //  손으로 관리하는 목록의 전형적 결말([[feedback_hand_maintained_lists]]).
            //  색이 없으면 아무것도 안 한다 = 그 세 이름은 CSS 기본 그대로(회귀 0).
            if (typeof profileColorByName === "function") {
              paintProfileBadge(entry.tierBadgeEl, profileColorByName(tier));
            }
          }
        }
        // 원 세션 threadKey **지연 채움**(2026-07-26) — 활동-선도 카드는 생성 시 잡 좌표
        // (worker:<jobId>)뿐이라 threadKey 가 ""(소속 미상)로 남는데, isBgInScope 가 빈 값을
        // "모든 세션 소속"으로 취급해 **남의 세션 칩·배지에도 떴다**. lifecycle 이 원 세션을
        // 실어 오면 그때 확정한다(멱등 — 이미 있으면 무변).
        // ★승격 조건 (2026-07-27): 종전엔 `!entry.threadKey` 라 **좌표를 이미 들고 있으면
        //  진짜 세션 키가 와도 갱신되지 않았다**. 세션 키가 아닌 동안엔 계속 업그레이드한다.
        const incomingTk = realSessionThreadKey(opts && opts.threadKey);
        const isSessionKey = (t) => typeof t === "string" && t !== "" && !/^(?:worker|agent):/.test(t);
        if (incomingTk !== "" && !isSessionKey(entry.threadKey)) {
          entry.threadKey = incomingTk;
          entry.el.dataset.threadkey = incomingTk;
          entry.el.classList.toggle("bg-in-scope", isBgInScope(incomingTk, entry.ownerTk));
        }
        // 서버 환원 원 세션(멱등) — lifecycle SSE·부팅 하이드레이션 어느 쪽이 먼저 오든 확정.
        // 이게 오면 프런트 부모-체인 추측은 더 쓰지 않는다(authoritative 가 이김).
        {
          const ownTk = opts && typeof opts.ownerThreadKey === "string" ? opts.ownerThreadKey : "";
          if (ownTk !== "" && entry.ownerTk !== ownTk) {
            entry.ownerTk = ownTk;
            entry.el.classList.toggle("bg-in-scope", isBgInScope(entry.threadKey, ownTk));
          }
        }
        // 소속 세션 배지 — ownerTk 가 방금 왔거나, 세션 이름을 그동안 알게 됐을 수 있다
        // (`/api/sessions` 폴은 카드 생성과 무관하게 돈다). 멱등이라 매번 불러도 무해.
        updateSessionBadge(entry);
        // 실행 cwd(멱등) — worker.started 가 실어 옴. 프로젝트 상세가 이걸로 필터/귀속.
        if (opts && opts.cwd && !entry.cwd) entry.cwd = String(opts.cwd);
        if (opts && opts.label && !entry.hasLabel) setJobLabel(entry, String(opts.label));
        // 라벨 kind 접두 (2026-07-26) — 서브에이전트는 위에서 "🤖 <name>" 으로 쓰는데 워커는
        // 접두가 없어 비대칭이었다. 워커도 "📦 <작업>" 으로 맞춰, 드로어에 워커·서브가 섞여
        // 있을 때 **이름만 보고** 구분되게 한다. 특히 모바일에선 kind 배지가 다음 줄로 wrap
        // 되므로(.bg-job-top flex-wrap) 라벨 접두가 사실상 유일한 구분 단서다.
        // 멱등 — 이미 붙었으면 재적용 0. agent 로 승격되면 위(agentName 분기)가 라벨을 통째
        // 교체하지만, agentName 없이 승격된 드문 경우엔 여기서 접두를 떼어 정합을 지킨다.
        if (entry.hasLabel) {
          const cur = entry.label;
          const next = withKindPrefix(entry.kind, cur);
          if (next !== cur) setJobLabel(entry, next);
        }
        if (opts && opts.task && !entry.hasTask) {
          entry.task = String(opts.task); // 원문 보관(에이전트 뷰가 읽음).
          entry.taskEl.textContent = i18n("bg.task.full", { v: opts.task }); // 펼침 영역 전문.
          entry.taskEl.style.display = ""; entry.hasTask = true;
          // 항상 보이는 한 줄 요약(이름 아래) — 접혀 있어도 무슨 작업인지 구분.
          entry.summaryEl.textContent = opts.task;
          entry.summaryEl.style.display = "";
          updateChev(entry);
        }
        return entry;
      };
      const handleWorkerEvent = (p, ts) => {
        // (아래에서 entry 를 얻은 뒤 activity 를 반영한다 — ensureJobCard 가 먼저 필요.)
        if (!p.jobId) return;
        const status = p.status || "running";
        // ownerThreadKey = 서버가 환원한 원 세션(worker.* payload / GET /api/worker-jobs).
        // 세션 스코프 판정의 1순위 근거라 반드시 함께 넘긴다(빠뜨리면 프런트 추측으로 폴백).
        // ★페이로드를 **통째로** 넘긴다 (2026-08-20 재검토 F1). 종전엔 필드를 손으로
        //  골라 적었고, 그래서 서버가 보낸 `startedAt` 이 **여기서 조용히 버려졌다** —
        //  카드 생성 쪽을 "서버값을 쓰도록" 고쳐놓고도 값이 도착을 안 해 픽스가 통째로
        //  무동작이었다(소비자만 고치고 생산자를 안 봄). `ensureJobCard` 는 아는 키만
        //  읽으므로 여분 필드는 무해하고, 새 필드가 생기면 **저절로** 흘러간다.
        const entry = ensureJobCard(p.jobId, { ...p, ts });
        // 서버가 실어 준 "지금 무엇을 하는 중" 을 반영한다(하이드레이션 경로). 값이 없으면
        // **덮지 않는다** — SSE 로 이미 채워진 것을 빈 값으로 지우면 새로고침만 못해진다.
        if (p.activity && typeof p.activity === "object") {
          entry.activity = p.activity;
          renderDoing(entry);
        }
        // ★잡 상태는 **단조**다 — running → 종료, 되돌아가지 않는다 (2026-07-28).
        //  종전엔 마지막 이벤트가 무조건 이겨서, 재연결 replay 가 흘린 옛 worker.started 가
        //  이미 끝난 카드를 **다시 "진행 중"으로 되돌렸고** 그 뒤로 갱신할 이벤트가 없어
        //  영원히 진행 중으로 남았다(사용자 신고). 오늘 채팅 순서에서 고친 것과 같은 뿌리 —
        //  replay 를 최신 사실로 착각하는 것. 종료는 되돌릴 수 없는 사실이므로 sticky 로 둔다.
        //  ★단, `interrupted` 는 예외다 (2026-08-20 사용자 신고: "매니저가 에이전트보다 먼저
        //   사라졌다"). 그건 **서버가 관측한 사실이 아니라 클라이언트의 추측**이다 —
        //   하이드레이션 응답에 그 잡이 안 보이더라는 것뿐이고, 그 부재는 경합·지연으로도
        //   생긴다. 추측을 sticky 로 두면 **그 뒤 서버가 "running" 이라 해도 거부**하게 되어
        //   카드가 영영 안 돌아온다(진행중 필터에 숨고, 상한 축출 대상이 되어 아예 사라진다).
        //   서버가 준 사실(`fromServer`)은 추측을 덮을 수 있어야 한다 — 권위가 이긴다.
        const clientGuess = entry.status === "interrupted";
        if (
          TERMINAL_JOB_STATUS.has(entry.status) &&
          status === "running" &&
          !(clientGuess && p && p.fromServer === true)
        ) {
          return entry;
        }
        const wasRunning = entry.status === "running";
        entry.status = status;
        // ★상태 클래스는 **정의점에서 파생**한다 — 손으로 적으면 빠진다(실제로 `interrupted`
        //  가 빠져 있어, 되살아난 카드에 `interrupted running` 이 함께 남았다).
        entry.el.classList.remove("running", ...TERMINAL_JOB_STATUS);
        entry.el.classList.add(status); // open/has-detail 보존.
        if (status !== "running") entry._cancelRequested = false; // 종료됐으면 낙관 플래그 리셋(멱등).
        entry.statusEl.textContent = BG_STATUS[status] || status;
        updateStopBtn(entry); // running 이탈/kind 무관 — 버튼 노출조건 재평가.
        // 잡 종료 시 경과시간 최종 확정(틱은 running 만 갱신 → 여기서 마지막 값 고정).
        if (wasRunning && status !== "running" && entry.elapsedEl) {
          entry.elapsedEl.textContent = fmtElapsed(Date.now() - (entry.startTs || Date.now()));
        }
        // ★잡이 끝나면 스텝의 진행 표식도 끈다 — 끝 이벤트를 못 받은 도구(취소·재시작·SSE
        //  끊김)가 죽은 잡 안에서 영원히 카운트업하는 것을 막는다. 이게 없으면 위 유령이
        //  그대로 재현된다(잡 상태는 끝났는데 그 안의 줄만 계속 돈다).
        if (status !== "running") clearAllStepsRunning(entry);
        if ((status === "failed" || status === "cancelled") && p.error) {
          entry.errorText = String(p.error); // 원문 보관(에이전트 뷰 펼침 상세가 읽음).
          entry.errEl.textContent = p.error;
          entry.errEl.style.display = "";
        }
        if (status === "done" && p.result) {
          entry.result = String(p.result); // 원문 보관(에이전트 뷰 펼침 상세가 읽음).
          entry.resultEl.textContent = i18n("bg.result.full", { v: p.result });
          entry.resultEl.style.display = ""; entry.hasResult = true; updateChev(entry);
        }
        capBgList();
        refreshBgBadge();
        syncSessionBgBadges(); // 세션 탭 진행 배지(백그라운드) 갱신.
        scheduleAgentsRender(); // 에이전트 메인 뷰가 열려 있으면 상태 전환 반영(throttle, 닫혀 있으면 no-op).
        scheduleProjectAgentsRender(); // 프로젝트 상세 열려 있으면 그 프로젝트 카드도 라이브 반영.
      };
      // Step3 — 백그라운드 잡 활동(threadKey=worker:<jobId> | agent:<jobId>)을 그 잡 카드 안
      // 스텝으로. true=처리됨 → 메인 채팅 로그로 안 샘(워커·서브 동일 격리). 서브 규약(ADR
      // 2026-07-03): prefix 만 worker:→agent: 로 다르고 payload 구조 동형. agent: 로 온 활동은
      // 카드를 서브로 마킹(lifecycle 보다 활동이 먼저 도착해도 배지 표시).
      // 잡 카드 스텝 on-demand 펼침 — 기본은 컴팩트 한 줄(채팅 누수 차단 유지), diff/output 이
      // 있는 스텝만 ▸ affordance + 클릭 토글. 클릭 시 메인 채팅과 동일한 리치 블록(buildDiffBlock·
      // buildOutputBlock, 재사용)을 스텝 아래 append, 다시 클릭하면 제거. diff 는 스텝 시작 이벤트,
      // output 은 phase:end(annotateToolDuration)로 뒤늦게 도착하므로 데이터는 엘리먼트에 보관·지연 빌드.
      const toggleWorkerStepRich = (stepEl) => {
        const existing = stepEl.querySelectorAll(":scope > .act-diff, :scope > .act-output");
        if (existing.length) { // 이미 펼침 → 접기(리치 블록 제거).
          existing.forEach((n) => n.remove());
          stepEl.classList.remove("expanded");
          return;
        }
        // 접힘 → 펼침. 현재 보관된 최신 데이터로 리치 블록 빌드(output 이 나중에 온 경우도 반영).
        if (stepEl._diff && Array.isArray(stepEl._diff.lines)) stepEl.appendChild(buildDiffBlock(stepEl._diff));
        if (stepEl._output) stepEl.appendChild(buildOutputBlock(stepEl._output));
        stepEl.classList.add("expanded");
      };
      const ensureStepExpandable = (stepEl) => {
        if (!stepEl) return;
        const hasRich = (stepEl._diff && Array.isArray(stepEl._diff.lines)) || stepEl._output;
        if (!hasRich || stepEl._expandable) return; // 리치 데이터 없거나 이미 배선됨 → no-op(멱등).
        stepEl._expandable = true;
        stepEl.classList.add("bg-step-rich");
        const caret = document.createElement("span");
        caret.className = "act-diff-caret bg-step-caret"; caret.textContent = "▸";
        stepEl.insertBefore(caret, stepEl.firstChild); // 아이콘 앞 작은 ▸ affordance.
        stepEl.addEventListener("click", (e) => { e.stopPropagation(); toggleWorkerStepRich(stepEl); });
      };

      // ── 부팅 하이드레이션 — 실행 중 잡을 서버(GET /api/worker-jobs = in-memory listJobs)에서
      // 받아 카드 복원. 긴 워커의 worker.started SSE 가 replay 창(50) 밖으로 밀리면 새로고침 시
      // activity-only 카드라 라벨이 "(작업)"으로 뜨던 문제를 label·kind·task 복원으로 해소.
      // handleWorkerEvent 재사용(멱등 ensureJobCard — SSE 와 중복돼도 같은 jobId=같은 카드).
      // 원 세션 미상 카드를 위한 **디바운스 백필** — 카드가 연달아 생겨도 fetch 는 1회.
      //  하이드레이션과 같은 경로를 쓴다(서버 진실 단일 소스, 중복 구현 0).
      let ownerBackfillTimer = null;
      const scheduleOwnerBackfill = () => {
        if (ownerBackfillTimer !== null) return;
        ownerBackfillTimer = setTimeout(() => {
          ownerBackfillTimer = null;
          hydrateActiveJobs();
        }, 1200);
      };
      const hydrateActiveJobs = () => {
        // ★서버가 주는 건 "지금 도는 잡" 전량이므로, 하이드레이션은 **복원 + 대조** 두 일을 한다.
        //  대조가 없으면: 잡이 끝났는데 그 worker.done 이 replay 창 밖으로 밀린 경우(긴 잡·
        //  오래 끊긴 연결) 카드가 영원히 "진행 중"으로 남는다 — 갱신해 줄 이벤트가 더는 없다.
        //  서버 목록에 없는 running 카드 = 이미 끝난 잡이다(관측된 사실). 결과는 모르므로
        //  "완료"로 단정하지 않고 종료 사실만 반영한다(거짓값 금지).
        const startedAt = Date.now();
        fetch("/api/worker-jobs").then((r) => r.json()).then((d) => {
          if (!d || !Array.isArray(d.jobs)) return;
          const live = new Set();
          for (const j of d.jobs) {
            if (!j || !j.jobId) continue;
            live.add(j.jobId);
            // ★시각은 **포맷해서** 넘긴다 (2026-08-19). SSE 경로는 `fmtTime(ev.ts)` 를 주는데
            //  여기만 `Date.now()`(원값)를 줘서, 새로고침하면 그 카드만 `1787121377393` 같은
            //  숫자가 시각 자리에 떴다 — 같은 인자에 두 경로가 다른 타입을 넣고 있었다.
            //  그리고 "지금" 이 아니라 **그 잡이 시작한 시각**을 쓴다(서버가 준다).
            handleWorkerEvent(
              // ★`fromServer` — 이건 replay 가 아니라 **지금 서버가 아는 사실**이다.
              //  클라이언트가 추측으로 찍어둔 `interrupted` 를 덮을 자격이 있다.
              { ...j, status: j.status || "running", fromServer: true },
              fmtTime(typeof j.startedAt === "number" ? j.startedAt : Date.now()),
            );
          }
          for (const [jobId, e] of jobCards) {
            if (e.status !== "running" || live.has(jobId)) continue;
            // 이 fetch 이후에 생긴 카드는 대조 대상이 아니다(응답이 그 잡을 알 리 없다) — race 방지.
            if ((e.createdTs || e.startTs || 0) > startedAt) continue;
            handleWorkerEvent({ jobId, status: "interrupted" }, fmtTime(Date.now()));
          }
        }).catch(() => { /* 미도달 — SSE 로 채워짐 */ });
      };
      hydrateActiveJobs();
      // 재연결마다 다시 대조 — 끊겨 있는 동안 끝난 잡이 유령으로 남지 않게(활동.js 가 부름).
      window.reconcileBgJobs = hydrateActiveJobs;
      // 세션 이름은 `/api/sessions` 폴이 뒤늦게 알려준다(카드 생성과 무관한 주기). 그때
      // 한 번 훑어 배지를 채운다 — 끝난 잡은 더 이상 이벤트가 안 와서 스스로는 갱신되지 않는다.
      window.refreshBgSessionBadges = () => {
        for (const e of jobCards.values()) updateSessionBadge(e);
      };

      // 🛠 스킬 스텝 인식 (2026-07-14) — invoke_skill 도구 호출을 스킬 배지로 승격한다.
      // 스킬명은 공유 detail 빌더(_activity-detail.ts)가 `key=value, …` 로 실어 보낸
      // p.detail 에서 뽑는다 — 세 어댑터(claude/codex/openai) 가 같은 빌더를 써 포맷이
      // 동일하므로 LLM-agnostic(원칙 #2). 코어/어댑터는 스킬 개념을 모르는 채(generic
      // invoke_skill 도구)로 두고, "스킬"이라는 표현은 뷰에서만.
      //
      // ★**순서를 가정하지 않는다** (2026-08-24 사용자 신고: "프로젝트 전용 스킬이라
      //  그런가 배지에 물음표로 나올 때가 있네"). 종전엔 `name=([^,]*)$` — **끝 앵커**였고
      //  주석엔 *"path 지정 시 `path=…, name=<skill>`"* 이라 적혀 있었다. 그런데 빌더가
      //  2026-08-20 에 **식별자를 앞으로** 옮겼다(`spawn_agent` 요약에서 name 이 접히던 것을
      //  고치며 IDENTITY_KEYS 를 최우선으로). 그래서 실물은 `name=tech-radar, path=/Users/…`
      //  가 됐고, 끝 앵커는 **path 가 붙는 순간 전부 실패**했다 — 즉 `path` 를 넘기는
      //  프로젝트 전용 스킬은 항상 `?`. (실측 DB: `name=tech-radar, path=/Users/…` ·
      //  `name=news-digest, path=` — 빈 path 도 콤마를 만들어 똑같이 깨졌다.)
      //  ★부류: A(빌더 순서)를 바꾸고 A에 의존하던 B(이 파서)를 안 본 것. 여기 주석이
      //   그 낡은 순서를 **사실처럼** 적어두고 있어서 더 안 보였다.
      // 반환: {name} 이면 스킬 스텝, null 이면 일반 도구/활동(기존 렌더 그대로).
      function skillStepInfo(p) {
        if (!p || (p.kind && p.kind !== "tool") || p.label !== "invoke_skill") return null;
        const d = typeof p.detail === "string" ? p.detail : "";
        // 세그먼트 경계(문자열 앞 또는 ", ")에 붙은 첫 `name=` — 앞뒤 어디에 있든 잡는다.
        const m = d.match(/(?:^|,\s*)name=([^,]*)/);
        const name = m && m[1] ? m[1].trim() : "";
        return { name: name || "?" }; // 파싱 실패해도 스킬 스텝임은 배지로 확실히.
      }

      // 스텝 한 줄 append 공통 — 최신 스텝 팔로우 + 개수 + 셰브런. bounded(.bg-job-steps
      // max-height) 영역이라 append 전 바닥 근처였으면 append 후 바닥으로(최신 스텝 노출).
      // 위로 올려 과거 스텝을 읽는 중이면 존중(yank 금지) = 채팅 stickBottom 과 동형. 임계 24px.
      const appendJobStep = (entry, line) => {
        const stepsEl = entry.stepsEl;
        const nearBot = stepsEl.scrollHeight - stepsEl.scrollTop - stepsEl.clientHeight < 24;
        stepsEl.appendChild(line);
        entry.stepCount += 1;
        if (nearBot) stepsEl.scrollTop = stepsEl.scrollHeight;
        updateChev(entry);
      };

      // ── 매니저 스티어 스텝 (2026-08-05, ADR 2026-08-03-steer-observability) ──────────
      // 돌고 있는 매니저에 얹은 추가 지시를 그 잡 카드 타임라인에 쌓는다. ★이름(label)은
      // 건드리지 않는다 — 덮어쓰면 원래 의도가 사라진다. "무엇이 바뀌었나"는 타임라인이
      // 답할 일이고, 그래야 원래 의도와 변경이 **둘 다** 남는다.
      // 전달 못 된 시도(closed/absent)도 같은 자리에 남긴다 — 유실이야말로 사후에 봐야 할 값.
      const STEER_OUTCOME_NOTE = {
        closed: i18n("bg.steer.justFinished"),
        absent: i18n("bg.steer.failed"),
        "other-session": i18n("bg.steer.otherThread"),
        "no-target": i18n("bg.steer.notFound"),
      };
      const handleWorkerSteered = (p, ts) => {
        // 대상을 못 고른 시도(no-target)는 붙일 카드가 없다 — events 기록으로만 남는다
        // (사후 집계용). 카드를 지어내지 않는다(없는 잡을 만들면 그게 유령이다).
        if (!p.jobId) return;
        // 카드도 없고 라벨도 없으면 = 서버도 그 잡을 더는 모른다(프루닝된 옛 jobId 로의 스티어).
        // 여기서 카드를 만들면 "(작업)" 유령이 하나 생긴다 — 지어낼 근거가 없으면 그리지 않는다.
        if (!jobCards.has(p.jobId) && !p.label) return;
        const entry = ensureJobCard(p.jobId, { ...p, ts }); // 위와 같은 이유로 통째 전달.
        // dedup — SSE replay 가 같은 스티어를 재전송해도 한 줄만(활동 스텝 dedup 과 동형).
        // 스티어엔 어댑터 seq 가 없으므로 시각+원문으로 판정.
        const key = "steer␟" + (p.ts || ts || "") + "␟" + (p.message || "");
        if (entry.seenSteps.has(key)) return;
        entry.seenSteps.add(key);
        const line = document.createElement("div");
        line.className = "bg-step";
        const icon = document.createElement("span");
        icon.className = "bg-step-icon"; icon.textContent = "💬";
        const lab = document.createElement("span");
        lab.className = "bg-step-label bg-steer"; lab.textContent = i18n("bg.steer.add");
        line.appendChild(icon); line.appendChild(lab);
        if (p.message) {
          const d = document.createElement("span");
          d.className = "bg-step-detail"; d.textContent = p.message;
          line.appendChild(d);
        }
        const note = STEER_OUTCOME_NOTE[p.outcome];
        if (note) {
          const n = document.createElement("span");
          n.className = "bg-step-detail bg-steer-miss"; n.textContent = "(" + note + ")";
          line.appendChild(n);
        }
        appendJobStep(entry, line);
        scheduleAgentsRender(); // 에이전트 뷰가 열려 있으면 거기 단계 목록에도 반영(throttle).
        scheduleProjectAgentsRender();
      };

      const handleWorkerActivity = (p, ts) => {
        const tk = typeof p.threadKey === "string" ? p.threadKey : "";
        let jobId = null;
        let cardOpts = { ts, threadKey: tk };
        if (tk.indexOf("worker:") === 0) {
          jobId = tk.slice("worker:".length);
        } else if (tk.indexOf("agent:") === 0) {
          jobId = tk.slice("agent:".length);
          cardOpts.kind = "agent"; // 활동-선도 카드도 서브로 승격(agentName 은 lifecycle 이 채움).
        } else {
          return false;
        }
        const entry = ensureJobCard(jobId, cardOpts);
        // ★이 매니저·에이전트가 **지금** 무엇을 하는 중인지 카드 머리에 (2026-08-21 사용자 제안).
        //  스텝 목록은 접혀 있을 수 있어서, 펼치지 않고도 보이는 자리가 필요하다. 문구는
        //  메인 진행 표시와 **같은 판정**(util.js `doingText`)을 쓴다 — 두 벌이면 같은 상태를
        //  두 이름으로 부르게 된다. 끝난 잡은 안 건드린다(lifecycle 이 최종 상태를 쓴다).
        if (entry.statusEl && entry.status === "running" && !entry._cancelRequested) {
          entry.statusEl.textContent = BG_STATUS.running + " · " + doingText({ kind: p.kind, label: p.label });
        }
        // 실제 모델 — dedup(아래) *앞*에서 반영한다. 재전송된 스텝이라도 모델 정보는 유효하고,
        //  폴백이 늦은 스텝에서 일어나면 그 스텝이 dedup 에 걸려도 전환은 남아야 한다.
        setJobModel(entry, p.model);
        // ★dedup — SSE replay(새로고침 시 재연결) 가 버퍼 이벤트를 재전송하면 같은 워커 스텝이
        // 매번 다시 append 돼 "무한 반복"처럼 보였다(2026-07-03 실측). seq(어댑터 단조) 로 판정,
        // seq 없으면 label␟detail 로 폴백. 이미 그린 스텝이면 건너뛴다.
        const stepKey = p.seq != null ? "s" + p.seq : (p.label || "") + "␟" + (p.detail || "");
        if (entry.seenSteps.has(stepKey)) return true;
        entry.seenSteps.add(stepKey);
        const line = document.createElement("div");
        line.className = "bg-step";
        if (p.seq != null) line.dataset.seq = String(p.seq); // #3 — phase:"end" 가 실행시간 붙일 앵커.
        const skill = skillStepInfo(p);
        const icon = document.createElement("span"); icon.className = "bg-step-icon";
        icon.textContent = skill ? "🛠" : (p.kind === "tool" ? "🔧" : "▶");
        const lab = document.createElement("span"); lab.className = skill ? "bg-step-label bg-skill" : "bg-step-label";
        lab.textContent = skill ? i18n("bg.step.skill", { name: skill.name }) : (p.label || p.kind || i18n("bg.activity"));
        line.appendChild(icon); line.appendChild(lab);
        if (p.detail && !skill) { // 스킬 스텝은 detail(=name=…)이 라벨과 중복 → 생략.
          const d = document.createElement("span"); d.className = "bg-step-detail";
          d.textContent = p.detail; line.appendChild(d);
        }
        // ★상대시간 — "언제" (2026-08-24 사용자 요청: "몇분전·몇시간전이 걸린시간 옆에").
        //  실행시간(얼마나)만으론 긴 잡의 타임라인에서 그 스텝이 **언제 일** 이었는지 모른다.
        //  포매터는 잡 카드 머리와 **같은 것**(`fmtAgo`) — 두 벌이면 같은 시각을 다르게 부른다.
        //  ts 가 없으면 span 을 안 만든다(빈 자리를 지어내지 않는다).
        const stepTs = typeof p.ts === "number" ? p.ts : 0;
        if (stepTs > 0) {
          line.dataset.ts = String(stepTs);
          const a = document.createElement("span");
          a.className = "bg-step-ago"; a.textContent = fmtAgo(stepTs);
          line.appendChild(a);
        }
        // 리치 diff(Edit/Write)가 스텝 시작 payload 에 실려 오면 보관 + 펼침 affordance 배선.
        // 자동 펼치지 않음(기본 접힘) — 클릭 시에만 buildDiffBlock 으로 렌더.
        if (p.diff && Array.isArray(p.diff.lines)) { line._diff = p.diff; ensureStepExpandable(line); }
        // 이 스텝은 **방금 시작했다** — 추정이 아니라 관측이다. 끝(뱃지)이나 잡 종료가 끈다.
        if (p.kind === "tool" && stepTs > 0) markStepRunning(line, stepTs);
        appendJobStep(entry, line);
        // 진행 중 라이브 줄의 "마지막 스텝"(현재 무엇을 하는 중) 갱신 — 펼치지 않아도 보이게.
        {
          const lbl = skill ? i18n("bg.step.skillBadge", { name: skill.name }) : (p.label || p.kind || i18n("bg.activity"));
          entry.lastStep = (!skill && p.detail) ? lbl + " · " + p.detail : lbl;
          if (entry.lastStepEl) entry.lastStepEl.textContent = entry.lastStep;
        }
        updateChev(entry);
        scheduleAgentsRender(); // 에이전트 메인 뷰가 열려 있으면 라이브 반영(throttle, 닫혀 있으면 no-op).
        scheduleProjectAgentsRender(); // 프로젝트 상세 열려 있으면 현재 스텝까지 라이브 반영.
        return true;
      };

      // 경과시간 라이브 틱 — running 카드만 갱신(끝난 잡은 고정). 1s 주기, 저렴(카드 ≤ BG_MAX).
      // ★`fmtElapsed` 는 util.js 정본을 쓴다 (2026-08-21). 여기 사본이 있던 동안 다른 카드는
      //  이 포맷을 못 썼고, 그래서 상대시간을 붙일 때 두 번째 사본이 생길 뻔했다.
      const tickElapsed = () => {
        const now = Date.now();
        for (const e of jobCards.values()) {
          // 상대시간은 **끝난 카드도 늙는다** — running 만 갱신하는 경과시간과 다른 축이라
          //  같은 틱에서 따로 돌린다(분 단위라 1s 틱 안에서 대부분 no-op).
          if (e.agoEl && e.startTs) {
            const ago = fmtAgo(e.startTs);
            if (e.agoEl.textContent !== ago) e.agoEl.textContent = ago;
          }
          // ★스텝 시각도 같은 시계에 얹는다(새 타이머 0). 두 축이 다르다:
          //  - `.bg-step-ago`(언제) — **끝난 카드도 늙는다**. 분 단위라 대부분 no-op(문자열 비교).
          //  - `.dur-badge.running`(지금 몇 초째) — 도는 도구만. 잡이 끝나면 표식이 걷힌다.
          if (e.stepsEl) {
            for (const el of e.stepsEl.querySelectorAll(".bg-step[data-ts]")) {
              const a = el.querySelector(":scope > .bg-step-ago");
              if (!a) continue;
              const t = fmtAgo(Number(el.dataset.ts));
              if (a.textContent !== t) a.textContent = t;
            }
            for (const el of e.stepsEl.querySelectorAll(".bg-step-running[data-runsince]")) {
              const b = el.querySelector(":scope > .dur-badge.running");
              if (b) b.textContent = "⏳ " + fmtElapsed(now - Number(el.dataset.runsince));
            }
          }
          if (e.status !== "running" || !e.elapsedEl) continue;
          e.elapsedEl.textContent = fmtElapsed(now - (e.startTs || now));
          // "3분째" 가 굳지 않게 같은 시계에 얹는다(새 타이머 0).
          if (e.activity) renderDoing(e, now);
        }
        // 에이전트 뷰가 열려 있으면 그쪽 running 카드 경과시간도 라이브로(별도 DOM ref).
        if (currentView === "agents") {
          for (const [jobId, e] of jobCards) {
            if (e.status !== "running") continue;
            const el = agentElapsedEls.get(jobId);
            if (el) el.textContent = fmtElapsed(now - (e.startTs || now));
          }
        }
        // 프로젝트 상세가 열려 있으면 그 카드들 경과도 라이브로(별도 DOM ref).
        if (projectAgentsBox) {
          for (const [jobId, e] of jobCards) {
            if (e.status !== "running") continue;
            const el = projectAgentElapsedEls.get(jobId);
            if (el) el.textContent = fmtElapsed(now - (e.startTs || now));
          }
        }
      };
      setInterval(tickElapsed, 1000);

      const applyFilter = (el) => {
        if (filterText !== "" && !(el.dataset.type || "").includes(filterText)) {
          el.style.display = "none";
        }
      };
