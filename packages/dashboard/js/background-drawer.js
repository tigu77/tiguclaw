      // ── Step2/3 (2026-06-30) — 백그라운드 작업 드로어 + 잡 카드 + 스텝 타임라인 ──
      // worker.* lifecycle(Step1)로 잡 카드 생성·상태(payload.status: running/done/failed/
      // cancelled). 워커 llm.activity(threadKey=worker:<jobId>)는 그 잡 카드 안 접이식
      // 스텝으로(Step3) — 채팅으로 새지 않게 dispatch 에서 가로채 여기로 보낸다.
      // 토글 드로어(PC 우측 고정·모바일 슬라이드인+백드롭). 배지 = 실행 중 잡 수.
      const bgPanel = document.getElementById("bg-panel");
      const bgList = document.getElementById("bg-list");
      const bgEmpty = document.getElementById("bg-empty");
      const bgBadge = document.getElementById("bg-badge");
      // "↑ 최신" 점프 — 아래로 내려 과거 잡 열람 중(scrollTop>임계)일 때만 노출, 클릭하면 맨 위(최신)로.
      // 채팅 chat-jump 의 상단판(newest=insertBefore 로 top). stickTop 이 안 끌어당기는 케이스의 어포던스.
      const bgJump = document.getElementById("bg-jump");
      const BG_JUMP_THRESHOLD = 40; // stickTop 임계(ensureJobCard _bgNearTop)와 동일.
      const updateBgJump = () => { if (bgJump) bgJump.hidden = bgList.scrollTop < BG_JUMP_THRESHOLD; };
      if (bgJump) bgJump.addEventListener("click", () => { bgList.scrollTop = 0; updateBgJump(); });
      bgList.addEventListener("scroll", updateBgJump, { passive: true });
      const BG_STATUS = {
        running: "🟡 진행 중", done: "✅ 완료", failed: "⚠️ 실패", cancelled: "⏹ 취소",
      };
      const BG_MAX = 50; // 카드 상한(메모리 바운드). 오래된 끝난 잡부터 제거.
      const jobCards = new Map(); // jobId -> { el, labelEl, statusEl, chevEl, stepsEl, errEl, status, stepCount }

      // ── 취소(중지) — POST /api/cancel-worker { jobId } → { ok, cancelled }. 대상: 실행 중
      // (status running) + detached worker(kind==="worker") 뿐 — awaited 서브에이전트(kind==="agent")
      // 는 취소 대상 아님(백엔드 계약). 낙관적 UI: 클릭 즉시 버튼 비활성화+"중지 요청…" 텍스트로,
      // 상태 배지도 "취소 중…"(기존 잡 상태 렌더 재사용, BG_STATUS 확장). cancelled:false(대상없음/
      // 이미종료) 나 네트워크 실패는 무해하게 되돌린다 — 실제 종료 반영은 worker.cancelled lifecycle
      // SSE(handleWorkerEvent, BG_STATUS.cancelled="⏹ 취소")가 한다.
      const canCancelJob = (entry) => !!entry && entry.status === "running" && entry.kind === "worker";
      const updateStopBtn = (entry) => {
        if (!entry || !entry.stopBtnEl) return;
        const show = canCancelJob(entry);
        entry.stopBtnEl.style.display = show ? "" : "none";
        entry.stopBtnEl.disabled = !!entry._cancelRequested;
        entry.stopBtnEl.textContent = entry._cancelRequested ? "중지 요청…" : "⏹️ 중지";
      };
      const requestCancelJob = async (jobId) => {
        const entry = jobCards.get(jobId);
        if (!canCancelJob(entry) || entry._cancelRequested) return;
        entry._cancelRequested = true;
        updateStopBtn(entry);
        if (entry.statusEl) entry.statusEl.textContent = "⏳ 취소 중…";
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
        entry.el.classList.toggle("open");
        updateChev(entry);
      });
      registerBuiltinHandler("job.copy", async (ctx) => {
        const entry = jobCards.get(ctx.targetId);
        if (!entry || !navigator.clipboard) return;
        const parts = [entry.labelEl.textContent || ""];
        if (entry.task) parts.push("작업: " + entry.task);
        if (entry.result) parts.push("결과: " + entry.result);
        if (entry.errorText) parts.push("에러: " + entry.errorText);
        try { await navigator.clipboard.writeText(parts.join("\n")); } catch {}
      });
      registerMenuItems("job", (ctx) => {
        const entry = jobCards.get(ctx.targetId);
        const items = [];
        if (entry && entry.el.classList.contains("has-detail")) {
          items.push({
            id: "detail",
            label: entry.el.classList.contains("open") ? "상세 접기" : "상세 보기",
            icon: "🔎",
            action: { kind: "builtin", handler: "job.toggleDetail" },
          });
        }
        items.push({ id: "copy", label: "복사", icon: "📋", action: { kind: "builtin", handler: "job.copy" } });
        if (canCancelJob(entry) && !entry._cancelRequested) {
          items.push({
            id: "cancel",
            label: "중지",
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
        const clamp = (w) => Math.max(300, Math.min(Math.min(760, window.innerWidth * 0.9), w));
        const apply = (w) => { bgPanel.style.width = clamp(w) + "px"; };
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
      const fmtDur = (ms) => {
        if (ms == null) return "";
        if (ms < 1000) return Math.round(ms) + "ms";
        const s = ms / 1000;
        if (s < 10) return s.toFixed(1) + "s";
        if (s < 60) return Math.round(s) + "s";
        const m = Math.floor(s / 60), rs = Math.round(s % 60);
        return m + "m " + rs + "s";
      };
      const applyDurationBadge = (el, ms) => {
        if (!el) return;
        let b = el.querySelector(":scope > .dur-badge");
        if (!b) { b = document.createElement("span"); b.className = "dur-badge"; el.appendChild(b); }
        b.textContent = fmtDur(ms);
        if (ms >= 90000) b.classList.add("slow"); // tool-slow 임계 이상 = warn 틴트.
        b.title = "도구 실행시간 " + fmtDur(ms);
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
          for (let i = oLines.length - 1; i >= 0; i--) {
            if (!oLines[i].querySelector(":scope > .act-output")) {
              oLines[i].appendChild(buildOutputBlock(ap.output));
              break;
            }
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

      const openBg = () => { document.body.classList.add("bg-open"); bgPanel.setAttribute("aria-hidden", "false"); updateBgJump(); };
      const closeBg = () => { document.body.classList.remove("bg-open"); bgPanel.setAttribute("aria-hidden", "true"); };
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
      let bgFilter = "running"; // "running" | "all"
      const setBgFilter = (mode) => {
        bgFilter = mode === "all" ? "all" : "running";
        bgList.classList.toggle("filter-running", bgFilter === "running");
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
      const bgScopeCountEl = document.getElementById("bg-scope-count");
      let bgSessionScope = "session"; // "session" | "all"
      // 카드가 활성 세션 소속인가 — threadKey 없음(레거시/구버전 카드)은 항상 소속 취급(누락 0,
      // isActiveThread 의 "미지정=활성" 관례와 동형).
      const isBgInScope = (tk) => !tk || tk === activeThreadKey;
      const setBgSessionScope = (mode) => {
        bgSessionScope = mode === "all" ? "all" : "session";
        bgList.classList.toggle("scope-session", bgSessionScope === "session");
        if (bgScopeFilterEl) for (const b of bgScopeFilterEl.querySelectorAll(".bg-fbtn")) {
          const on = b.dataset.scope === bgSessionScope;
          b.classList.toggle("active", on);
          b.setAttribute("aria-pressed", on ? "true" : "false");
        }
        refreshBgBadge();
      };
      if (bgScopeFilterEl) for (const b of bgScopeFilterEl.querySelectorAll(".bg-fbtn")) {
        b.addEventListener("click", () => setBgSessionScope(b.dataset.scope));
      }
      // 탭 전환(activeThreadKey 변경) 후 재적용 훅 — js/tabs.js 가 switchToThread/newTab/closeTab
      // 뒤에 호출(전역 스코프, background-drawer.js 가 tabs.js 보다 먼저 로드돼 참조 가능).
      const refreshBgScope = () => {
        for (const e of jobCards.values()) e.el.classList.toggle("bg-in-scope", isBgInScope(e.threadKey));
        refreshBgBadge();
      };

      const refreshBgBadge = () => {
        let running = 0, runningScoped = 0, totalScoped = 0;
        for (const e of jobCards.values()) {
          if (e.status === "running") running += 1;
          if (isBgInScope(e.threadKey)) {
            totalScoped += 1;
            if (e.status === "running") runningScoped += 1;
          }
        }
        const total = jobCards.size;
        if (bgBadge) {
          bgBadge.textContent = String(running);
          bgBadge.classList.toggle("show", running > 0);
        }
        // 드로어 내부 필터 카운트(진행 중/전체 버튼) — 현재 세션 스코프 반영(화면에 실제 보이는
        // 수와 일치시킴). 헤더 배지·nav·에이전트뷰는 아래에서 전역 유지(스코프 무관, 회귀 방지).
        const dispRunning = bgSessionScope === "session" ? runningScoped : running;
        const dispTotal = bgSessionScope === "session" ? totalScoped : total;
        if (bgCountRunning) bgCountRunning.textContent = String(dispRunning);
        if (bgCountAll) bgCountAll.textContent = String(dispTotal);
        if (bgScopeCountEl) bgScopeCountEl.textContent = String(totalScoped);
        // 왼쪽 nav "에이전트" 항목 카운트 뱃지 = 진행 중 개수(라이브, 전역).
        const navAgentCount = document.getElementById("nav-agent-count");
        if (navAgentCount) navAgentCount.textContent = String(running);
        // 에이전트 메인 뷰 자체 카운트/빈상태도 함께 갱신(전역, 열려 있을 때만 렌더).
        if (typeof syncAgentsCounts === "function") syncAgentsCounts(running, total);
        // 빈 메시지 — 활성 상태필터 × 세션스코프 AND 기준(드로어에 실제 보이는 카드 수와 일치).
        const visible = bgFilter === "running" ? dispRunning : dispTotal;
        if (bgEmpty) {
          bgEmpty.style.display = visible === 0 ? "" : "none";
          bgEmpty.textContent = bgFilter === "running"
            ? "진행 중인 작업이 없습니다."
            : "백그라운드 작업이 없습니다.";
        }
      };
      const capBgList = () => {
        while (jobCards.size > BG_MAX) {
          let removed = false;
          for (let node = bgList.lastElementChild; node; node = node.previousElementSibling) {
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
        entry.chevEl.textContent = (open ? "▾ " : "▸ ") + (entry.stepCount > 0 ? entry.stepCount + "단계" : "자세히");
      };
      // opts.threadKey 에서 "진짜" 원 세션 threadKey 만 뽑는다 — handleWorkerActivity 는 라우팅용
      // 내부 의사-threadKey("worker:<jobId>"/"agent:<jobId>")를 opts.threadKey 로 넘기기도 하는데,
      // 그건 세션 스코프 판정에 쓰면 안 됨(원 세션이 아니라 잡 좌표라 activeThreadKey 와 절대 안 맞음).
      const realSessionThreadKey = (tk) =>
        (typeof tk === "string" && tk && tk.indexOf("worker:") !== 0 && tk.indexOf("agent:") !== 0) ? tk : "";
      // 잡 카드 확보(없으면 생성). label/task 는 worker.started, result 는 worker.done 이 채운다.
      const ensureJobCard = (jobId, opts) => {
        let entry = jobCards.get(jobId);
        if (!entry) {
          const el = document.createElement("div");
          el.className = "bg-job running";
          el.dataset.jobId = jobId;
          el.dataset.threadkey = realSessionThreadKey(opts && opts.threadKey); // 세션 스코프 필터 대상.
          const top = document.createElement("div"); top.className = "bg-job-top";
          const label = document.createElement("span"); label.className = "bg-job-label";
          label.textContent = (opts && opts.label) || "(작업)";
          // kind 배지(워커/서브에이전트) — status 뱃지와 별개 축. 기본은 워커 배지("📦 워커")를
          // 항상 표시하고, lifecycle 로 서브에이전트로 승격되면 아래에서 텍스트를 교체(.agent 가 색 전환).
          const kindBadge = document.createElement("span"); kindBadge.className = "bg-job-kind";
          kindBadge.textContent = AGENT_KIND_BADGE.worker;
          // 모델 티어 칩 — kind==="agent" 이고 modelTier 있을 때만(default 제외). kindBadge 옆에.
          const tierBadge = document.createElement("span"); tierBadge.className = "bg-job-tier"; tierBadge.style.display = "none";
          const st = document.createElement("span"); st.className = "bg-job-status";
          // 기본 상태 텍스트 — 활동(activity)으로만 생성된 카드(대시보드가 worker.started 를
          // 놓친 경우: 워커 실행 중 새로고침 등)도 상태 뱃지가 비지 않게. 라이프사이클 이벤트
          // 오면 handleWorkerEvent 가 실제 상태로 갱신. entry.status 기본값("running")과 일치.
          st.textContent = BG_STATUS.running;
          // 중지 버튼 — running+worker 일 때만 노출(updateStopBtn 이 켜고/끔). 클릭은 top 의
          // 펼침 토글로 버블링되지 않게 stopPropagation.
          const stopBtn = document.createElement("button");
          stopBtn.type = "button"; stopBtn.className = "bg-job-stop"; stopBtn.title = "작업 중지";
          stopBtn.textContent = "⏹️ 중지"; stopBtn.style.display = "none";
          stopBtn.addEventListener("click", (ev) => { ev.stopPropagation(); void requestCancelJob(jobId); });
          const chev = document.createElement("span"); chev.className = "bg-job-chev"; chev.style.display = "none";
          top.appendChild(label); top.appendChild(kindBadge); top.appendChild(tierBadge); top.appendChild(st); top.appendChild(stopBtn); top.appendChild(chev);
          const meta = document.createElement("div"); meta.className = "bg-job-meta";
          meta.textContent = ((opts && opts.ts) || "") + (opts && opts.threadKey ? " · " + opts.threadKey : "");
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
            resultEl: result, errEl: err, kindBadgeEl: kindBadge, stopBtnEl: stopBtn,
            liveEl: live, elapsedEl: elapsed, lastStepEl: laststep, tierBadgeEl: tierBadge, summaryEl: summary,
            startTs: Date.now(), // 경과시간 기준(카드 최초 관측 시각 — lifecycle/activity 어느 쪽이 먼저든).
            lastStep: "", // 마지막 활동 라벨(문자열) — DOM 과 별개로 보관, 에이전트 뷰가 DOM 결합 없이 읽음.
            modelTier: "", // 서브에이전트 모델 티어(low/mid/high 등) — lifecycle payload.modelTier. 에이전트 뷰도 읽음.
            cwd: "", // 실행 폴더(cwd) — worker.started payload.cwd. 프로젝트 상세가 이걸로 필터/귀속.
            task: "", result: "", errorText: "", // 작업 지시/결과/에러 원문(문자열) — DOM 과 별개 보관. 에이전트 뷰가 한 줄 요약·펼침 상세에 읽음.
            expanded: false, // 에이전트 뷰 카드 펼침 상태(jobId 별) — 리렌더돼도 유지. 드로어는 .open 클래스로 별도 관리.
            status: "running", kind: "worker", stepCount: 0, hasTask: false, hasResult: false,
            threadKey: realSessionThreadKey(opts && opts.threadKey), // 원 세션 threadKey(세션 스코프 필터용) — 없으면 "".
            seenSteps: new Set(), // ★스텝 dedup — SSE replay(새로고침 재연결)가 같은 활동을 재전송해도 중복 append 방지.
            _cancelRequested: false, // 낙관 취소 요청 중(재클릭 방지) — cancelled:false/실패 시 되돌림.
          };
          entry.el.classList.toggle("bg-in-scope", isBgInScope(entry.threadKey));
          jobCards.set(jobId, entry);
          updateStopBtn(entry); // 신규 카드 기본 running+worker → 중지 버튼 노출.
          // 컨텍스트메뉴 트리거 — kebab(top 우측) + 우클릭 + 롱프레스(카드류, 3경로 동일 메뉴).
          // ctxFn 은 매 호출 시 최신 entry 를 다시 읽어(jobCards.get) label/threadKey 드리프트 없음.
          const jobCtx = () => {
            const e = jobCards.get(jobId);
            return { type: "job", targetId: jobId, threadKey: e ? e.threadKey : "", label: e ? e.labelEl.textContent : jobId };
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
            entry.el.classList.toggle("bg-in-scope", isBgInScope(entry.threadKey));
          }
        }
        // 서브에이전트 마킹(멱등) — lifecycle(kind:"agent")이 활동보다 먼저/나중 어느 쪽으로 와도
        // 카드를 서브로 승격. 배지 텍스트를 워커→서브에이전트로 교체(.agent 클래스가 색 전환).
        // 워커(kind 미지정/"worker")는 기본 워커 배지 그대로 유지.
        if (opts && opts.kind === "agent" && entry.kind !== "agent") {
          entry.kind = "agent";
          entry.el.classList.add("agent");
          entry.kindBadgeEl.textContent = AGENT_KIND_BADGE.agent;
          updateStopBtn(entry); // awaited 서브에이전트 승격 — 취소 대상 아님, 버튼 숨김.
        }
        // 에이전트명 채우기 — 활동-선도 카드는 activity 시엔 agentName 이 없어 라벨이 "(작업)".
        // lifecycle 이 agentName 을 실어 오면(먼저든 나중이든) 라벨을 "🤖 <name>" 로. 이미 채웠으면 무영향.
        if (entry.kind === "agent" && opts && opts.agentName) {
          const want = "🤖 " + opts.agentName;
          if (entry.labelEl.textContent !== want) entry.labelEl.textContent = want;
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
          }
        }
        // 실행 cwd(멱등) — worker.started 가 실어 옴. 프로젝트 상세가 이걸로 필터/귀속.
        if (opts && opts.cwd && !entry.cwd) entry.cwd = String(opts.cwd);
        if (opts && opts.label && entry.labelEl.textContent === "(작업)") entry.labelEl.textContent = opts.label;
        if (opts && opts.task && !entry.hasTask) {
          entry.task = String(opts.task); // 원문 보관(에이전트 뷰가 읽음).
          entry.taskEl.textContent = "작업 · " + opts.task; // 펼침 영역 전문.
          entry.taskEl.style.display = ""; entry.hasTask = true;
          // 항상 보이는 한 줄 요약(이름 아래) — 접혀 있어도 무슨 작업인지 구분.
          entry.summaryEl.textContent = opts.task;
          entry.summaryEl.style.display = "";
          updateChev(entry);
        }
        return entry;
      };
      const handleWorkerEvent = (p, ts) => {
        if (!p.jobId) return;
        const status = p.status || "running";
        const entry = ensureJobCard(p.jobId, { label: p.label, task: p.task, ts, threadKey: p.threadKey, kind: p.kind, agentName: p.agentName, modelTier: p.modelTier, cwd: p.cwd });
        const wasRunning = entry.status === "running";
        entry.status = status;
        entry.el.classList.remove("running", "done", "failed", "cancelled");
        entry.el.classList.add(status); // open/has-detail 보존.
        if (status !== "running") entry._cancelRequested = false; // 종료됐으면 낙관 플래그 리셋(멱등).
        entry.statusEl.textContent = BG_STATUS[status] || status;
        updateStopBtn(entry); // running 이탈/kind 무관 — 버튼 노출조건 재평가.
        // 잡 종료 시 경과시간 최종 확정(틱은 running 만 갱신 → 여기서 마지막 값 고정).
        if (wasRunning && status !== "running" && entry.elapsedEl) {
          entry.elapsedEl.textContent = fmtElapsed(Date.now() - (entry.startTs || Date.now()));
        }
        if ((status === "failed" || status === "cancelled") && p.error) {
          entry.errorText = String(p.error); // 원문 보관(에이전트 뷰 펼침 상세가 읽음).
          entry.errEl.textContent = p.error;
          entry.errEl.style.display = "";
        }
        if (status === "done" && p.result) {
          entry.result = String(p.result); // 원문 보관(에이전트 뷰 펼침 상세가 읽음).
          entry.resultEl.textContent = "결과 · " + p.result;
          entry.resultEl.style.display = ""; entry.hasResult = true; updateChev(entry);
        }
        capBgList();
        refreshBgBadge();
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
      // 🛠 스킬 스텝 인식 (2026-07-14) — invoke_skill 도구 호출을 스킬 배지로 승격한다.
      // 스킬명은 공유 detail 빌더(_activity-detail.ts)가 "name=<skill>"(path 지정 시
      // "path=…, name=<skill>") 로 실어 보낸 p.detail 에서 뽑는다 — 세 어댑터(claude/codex/
      // openai) 가 같은 빌더를 써 포맷이 동일하므로 LLM-agnostic(원칙 #2). 코어/어댑터는
      // 스킬 개념을 모르는 채(generic invoke_skill 도구)로 두고, "스킬"이라는 표현은 뷰에서만.
      // 반환: {name} 이면 스킬 스텝, null 이면 일반 도구/활동(기존 렌더 그대로).
      function skillStepInfo(p) {
        if (!p || (p.kind && p.kind !== "tool") || p.label !== "invoke_skill") return null;
        const d = typeof p.detail === "string" ? p.detail : "";
        // 마지막 name= 세그먼트를 끝 앵커·콤마 비월경으로 잡는다(path 가 앞설 수 있음).
        const m = d.match(/name=([^,]*)$/);
        const name = m && m[1] ? m[1].trim() : "";
        return { name: name || "?" }; // 파싱 실패해도 스킬 스텝임은 배지로 확실히.
      }

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
        lab.textContent = skill ? "스킬: " + skill.name : (p.label || p.kind || "활동");
        line.appendChild(icon); line.appendChild(lab);
        if (p.detail && !skill) { // 스킬 스텝은 detail(=name=…)이 라벨과 중복 → 생략.
          const d = document.createElement("span"); d.className = "bg-step-detail";
          d.textContent = p.detail; line.appendChild(d);
        }
        // 리치 diff(Edit/Write)가 스텝 시작 payload 에 실려 오면 보관 + 펼침 affordance 배선.
        // 자동 펼치지 않음(기본 접힘) — 클릭 시에만 buildDiffBlock 으로 렌더.
        if (p.diff && Array.isArray(p.diff.lines)) { line._diff = p.diff; ensureStepExpandable(line); }
        // 최신 스텝 팔로우 — bounded(.bg-job-steps max-height) 영역이라 append 전 바닥 근처였으면
        // append 후 바닥으로(최신 스텝 노출). 위로 올려 과거 스텝을 읽는 중이면 존중(yank 금지) =
        // 채팅 stickBottom 과 동형. 임계 24px.
        const _stepsEl = entry.stepsEl;
        const _stepsNearBot = _stepsEl.scrollHeight - _stepsEl.scrollTop - _stepsEl.clientHeight < 24;
        _stepsEl.appendChild(line);
        entry.stepCount += 1;
        if (_stepsNearBot) _stepsEl.scrollTop = _stepsEl.scrollHeight;
        // 진행 중 라이브 줄의 "마지막 스텝"(현재 무엇을 하는 중) 갱신 — 펼치지 않아도 보이게.
        {
          const lbl = skill ? "🛠 스킬: " + skill.name : (p.label || p.kind || "활동");
          entry.lastStep = (!skill && p.detail) ? lbl + " · " + p.detail : lbl;
          if (entry.lastStepEl) entry.lastStepEl.textContent = entry.lastStep;
        }
        updateChev(entry);
        scheduleAgentsRender(); // 에이전트 메인 뷰가 열려 있으면 라이브 반영(throttle, 닫혀 있으면 no-op).
        scheduleProjectAgentsRender(); // 프로젝트 상세 열려 있으면 현재 스텝까지 라이브 반영.
        return true;
      };

      // 경과시간 라이브 틱 — running 카드만 갱신(끝난 잡은 고정). 1s 주기, 저렴(카드 ≤ BG_MAX).
      const fmtElapsed = (ms) => {
        const s = Math.max(0, Math.floor(ms / 1000));
        if (s < 60) return s + "s";
        const m = Math.floor(s / 60), rs = s % 60;
        if (m < 60) return m + "m " + rs + "s";
        const h = Math.floor(m / 60), rm = m % 60;
        return h + "h " + rm + "m";
      };
      const tickElapsed = () => {
        const now = Date.now();
        for (const e of jobCards.values()) {
          if (e.status !== "running" || !e.elapsedEl) continue;
          e.elapsedEl.textContent = fmtElapsed(now - (e.startTs || now));
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
