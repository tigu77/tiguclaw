      // ── 축1 선택지(버튼 묶음) — 대시보드 채널 렌더 ─────────────────────────
      // http-bridge 가 publish 한 prompt.options 이벤트를 채팅 흐름에 버튼 묶음으로 렌더.
      // 버튼 클릭 = 사용자가 그 value 를 입력한 것과 동치 → 기존 chat-form 과 동일하게
      // POST /api/messages {text:value, threadKey}. 클릭 후 묶음 비활성(중복 클릭 방지).
      // 비차단: 전송은 백그라운드(에러는 status/로컬 오류 버블로 표면화). route() 단일 인격
      // 재진입이라 새 세션/스레드 0 — threadKey 는 페이로드 우선, 없으면 대시보드 기본.
      // 채팅 진행 상태 표시 — 켜면 "<이름> 작업 중…"(펄스), 끄면 지움. 답(SSE)·에러 시 해제.
      // 진행 표시(모든 채널) — 회전 스피너 + 경과시간. 대시보드 자기 발신뿐 아니라 텔레그램·CLI
      // 등 어느 채널의 턴이 진행 중이어도 표시(SSE channel.message.in=시작, .out/turn_done/
      // turn_error=종료). activeTurns: threadKey→{start,channel}. 하나라도 있으면 working. 대표는
      // 내 대화(activeThreadKey) 우선, 없으면 가장 이른 것. 여럿이면 "(+N)". 스피너 요소는 유지하고
      // 경과 텍스트만 1초 틱 갱신(애니메이션 끊김 방지).
      let chatWorkingTimer = null;
      const activeTurns = new Map(); // threadKey -> startTime(ms). 채널 무관 — 단일 인격 취급.
      // activeTurns 변경 시 세션 탭 진행 뱃지 갱신 훅(멀티세션 탭, 나중에 renderTabBar 로 연결).
      // let 홀더로 두어 TDZ(const 상수 뒤늦은 정의) 회피 — 정의 전엔 null 이라 no-op.
      let onTurnsChanged = null;
      // stale 임계 — 어떤 실제 턴도 이보다 오래 못 감(codex 턴 캡 ~10분 + 여유). 초과 진행표시는
      // turn_done 을 놓친 유령(SSE 재연결·replay·데몬 재시작 중)으로 보고 해제(영구 '작업 중' 방지).
      const STALE_TURN_MS = 15 * 60 * 1000;
      /**
       * 이 턴이 **지금 무엇을 하고 있나** — threadKey → {kind,label} (2026-08-21 사용자 요청).
       * `llm.activity` 가 올 때마다 갱신되고 턴이 끝나면 지워진다. 없으면 "생각 중".
       */
      const turnPhase = new Map();
      const setTurnPhase = (tk, kind, label) => {
        const k = tk || activeThreadKey;
        if (!activeTurns.has(k)) return; // 안 도는 턴의 단계를 기억하지 않는다.
        turnPhase.set(k, { kind: kind || "", label: label || "" });
        if (k === activeThreadKey) refreshWorking();
      };

      /**
       * 입력창 위 진행 표시가 **무엇을 말할지** — 순수 판정 (2026-08-21 사용자 요청).
       *
       * ★사고: 이 줄은 **내 입력창 바로 위**라 누구나 "내 요청 상태" 로 읽는다. 그런데 판정이
       *  `activeTurns.size > 0` 이었다 — 내 대화가 놀고 있어도 **다른 세션의 턴**이나
       *  **백그라운드 잡**이 하나 있으면 "돌쇠 작업 중" 이 떴다(둘 다 헤드리스로 재현).
       *  2026-08-06 에 같은 이유로 *경과시간*은 고쳤는데, **깃발 자체**는 그대로였다 —
       *  고쳐진 축과 안 고쳐진 축이 나란히 있던 자리다.
       *
       * ★세 상태를 가른다: 내가 일을 시킨 중(작업 중) / 메인은 비었고 백그라운드만 도는 중
       *  (대기 중) / 아무것도 없음(숨김). "대기 중" 을 따로 두는 이유는 그때 **말을 걸어도
       *  된다**는 뜻이기 때문이다 — 사용자가 알아야 하는 건 그거다.
       *
       * @returns {{show:boolean, label:string, elapsed:string, idle:boolean}}
       */
      const workingBannerView = (v) => {
        const name = v.assistantName || "비서";
        if (v.mineActive) {
          const doing = doingText(v.phase); // 잡 카드와 **같은 판정**(util.js 정의점).
          const why = v.reason ? " · " + v.reason : "";
          // ★다른 세션 이야기는 **여기 안 쓴다** (2026-08-24 사용자 지정: "어차피 세션별로
          //  나오는 부분이라 다른 세션 내용이 들어갈 필요는 없지 않아?"). 종전엔 `(+N)` 을
          //  붙였는데, 이 줄은 **내 입력창 바로 위**라 누구나 자기 요청 상태로 읽는다 —
          //  거기 남의 세션 수를 얹으면 한 자리가 두 가지를 말한다. 이름도 링크도 없는
          //  숫자여서 보고 할 수 있는 것도 없었다. 그 사실은 세션 탭의 진행 점이 말한다.
          return {
            show: true,
            idle: false,
            label: name + " · " + doing + why + (v.mineStart ? " ·" : ""),
            elapsed: v.mineStart ? fmtElapsed(v.now - v.mineStart) : "",
          };
        }
        if (v.bgRunning > 0) {
          return {
            show: true,
            idle: true,
            label: name + " 대기 중 · 백그라운드 " + v.bgRunning + "건 진행",
            elapsed: "",
          };
        }
        return { show: false, idle: false, label: "", elapsed: "" };
      };

      /** 내 세션이 띄운, 지금 도는 백그라운드 잡 수. 없으면 0(모르면 0 — 지어내지 않는다). */
      const myRunningBgJobs = () => {
        if (typeof jobCards === "undefined" || typeof isBgInScope !== "function") return 0;
        let n = 0;
        for (const e of jobCards.values()) {
          if (e.status === "running" && isBgInScope(e.threadKey, e.ownerTk)) n += 1;
        }
        return n;
      };

      /** 지금 화면에 그릴 값 — 판정은 위 순수 함수가 하고 여기선 재료만 모은다. */
      const currentBannerView = () =>
        workingBannerView({
          assistantName,
          mineActive: activeTurns.has(activeThreadKey),
          // ★`get` 은 복원분에서 null 이다(시작시각을 모른다) — 그대로 넘긴다.
          mineStart: activeTurns.get(activeThreadKey) ?? null,
          phase: turnPhase.get(activeThreadKey) ?? null,
          reason: turnReason.get(activeThreadKey) ?? "",
          bgRunning: myRunningBgJobs(),
          now: Date.now(),
        });

      const paintWorking = (s) => {
        const v = currentBannerView();
        const lab = s.querySelector(".chat-work-label");
        if (lab) lab.textContent = v.label;
        const el = s.querySelector(".chat-elapsed");
        if (el) el.textContent = v.elapsed;
        const sp = s.querySelector(".chat-spinner");
        // 대기 중엔 스피너를 돌리지 않는다 — 도는 그림은 "내 일이 진행 중" 이라는 뜻이다.
        if (sp) sp.textContent = v.idle ? "💤" : "✳️";
        s.classList.toggle("idle", v.idle);
      };
      const refreshWorking = () => {
        if (onTurnsChanged) onTurnsChanged(); // 세션 탭 진행 뱃지 갱신(모든 세션 추적, active 대표).
        const s = document.getElementById("chat-status"); if (!s) return;
        if (!currentBannerView().show) {
          if (chatWorkingTimer) { clearInterval(chatWorkingTimer); chatWorkingTimer = null; }
          s.classList.remove("working"); s.classList.remove("idle"); s.textContent = ""; return;
        }
        if (!s.classList.contains("working")) {
          s.classList.add("working");
          s.innerHTML = '<span class="chat-spinner">✳️</span> <span class="chat-work-label"></span> <span class="chat-elapsed"></span>';
        }
        paintWorking(s);
        if (!chatWorkingTimer) chatWorkingTimer = setInterval(() => {
          // stale 스윕 — 유령 진행표시(놓친 turn_done)가 영영 안 꺼지는 것 방지. 비면 해제.
          const now = Date.now(); let swept = false;
          // ★`start` 가 null(복원분)이면 `now - null === now` 라 **즉시 스윕**된다 — 복원 시각을
          //  대신 쓴다. 표시(경과시간)와 수명(스윕)은 다른 질문이고, 모르는 건 표시만 안 한다.
          for (const [k, start] of activeTurns) {
            const since = start === null ? (restoredAt.get(k) || now) : start;
            if (now - since > STALE_TURN_MS) { activeTurns.delete(k); restoredAt.delete(k); swept = true; }
          }
          if (swept) { refreshWorking(); return; }
          const el = document.getElementById("chat-status"); if (el) paintWorking(el);
        }, 1000);
      };
      // ★새로고침 복원분은 **시작시각을 모른다** (2026-08-09 적대 검토 E). 서버(`/health`)는
      //  진행 중 스레드 키만 주고 시작시각은 안 준다. 그런데 복원하며 `Date.now()` 를 넣으면
      //  10분째 도는 턴이 "0초" 부터 다시 세어 **모르는 값을 지어낸다** — 바로 위 주석이
      //  2026-08-06 에 그 이유로 고친 그 자리다. 그래서 복원분은 시각을 `null` 로 표시하고
      //  경과시간을 **안 쓴다**("작업 중" 만). stale 스윕은 별도 필드로 계속 돈다.
      const restoredAt = new Map(); // threadKey -> 복원 시각(스윕 전용, 표시 금지)
      // ★"무엇 때문에 도는가" (2026-08-13) — 사용자: "뭘 하고 있는지 알기가 어렵다".
      //  사용자가 직접 친 턴은 자기가 뭘 시켰는지 안다. 모르는 건 **자기가 안 시킨 턴**
      //  (워커·에이전트 완료 후 메인이 정리하는 구간)이라, 그때만 이유를 같이 적는다.
      const turnReason = new Map(); // threadKey -> 사유(있을 때만)
      const markTurnActive = (tk, opts) => {
        const k = tk || activeThreadKey;
        if (!activeTurns.has(k)) {
          const unknownStart = opts && opts.startUnknown === true;
          activeTurns.set(k, unknownStart ? null : Date.now());
          if (unknownStart) restoredAt.set(k, Date.now());
          turnPhase.delete(k); // 옛 턴의 단계가 새 턴에 눌러붙지 않게(사유와 같은 규칙).
        }
        // 사유는 있을 때만 세운다 — 없으면 **지운다**(옛 사유가 다음 턴에 눌러붙지 않게).
        if (opts && typeof opts.reason === "string" && opts.reason) turnReason.set(k, opts.reason);
        else if (!(opts && opts.keepReason)) turnReason.delete(k);
        refreshWorking();
      };
      const markTurnDone = (tk) => { const k = tk || activeThreadKey; restoredAt.delete(k); turnReason.delete(k); turnPhase.delete(k); if (activeTurns.delete(k)) refreshWorking(); };
      // ★codex-우선 + claude-폴백 처리 — 한 사용자 턴이 여러 어댑터 시도로 나뉘면(codex 429 →
      // claude 폴백) codex 의 turn_error 가 *턴 중간*에 온다. 그때 작업표시를 즉시 끄면 폴백 claude
      // 가 도는 동안 표시가 사라진다(실측 버그). → turn_error 는 즉시 끄지 않고 *유예* 클리어:
      // 후속 진행 이벤트(channel.message.in/out·delta·activity·성공 turn_done)가 취소하고, 유예
      // 만료(후속 없음 = 최종 실패)에만 끈다. 진짜 종결(성공·out)은 즉시 끈다.
      const ERR_CLEAR_GRACE_MS = 15000;
      const turnErrClearTimers = new Map(); // threadKey -> timeout id.
      const cancelErrClear = (tk) => { const k = tk || activeThreadKey; const t = turnErrClearTimers.get(k); if (t) { clearTimeout(t); turnErrClearTimers.delete(k); } };
      const scheduleErrClear = (tk) => {
        const k = tk || activeThreadKey;
        cancelErrClear(k);
        turnErrClearTimers.set(k, setTimeout(() => { turnErrClearTimers.delete(k); markTurnDone(k); }, ERR_CLEAR_GRACE_MS));
      };
      // 하위호환 — sendChatMessage 의 로컬 즉시 피드백/에러 해제(내 대화 턴).
      const setChatWorking = (on) => { if (on) markTurnActive(activeThreadKey); else markTurnDone(activeThreadKey); };
      // 큐 대기 표시 — 이미 이 스레드 턴이 진행 중일 때(busy) 보낸 메시지는 직렬 큐(enqueueThreadTurn)
      // 뒤에 붙어 현재 턴이 끝나야 처리된다. 처리 시작(channel.message.in echo) 전까진 화면에 안
      // 떠서 "등록됐나?" 헷갈린다 → 낙관적 "대기 중" 버블로 즉시 피드백, echo 도착 시 승격(배지 제거).
      const pendingQueued = []; // [{ text, el, cid }] — echo 도착 시 승격할 낙관적 사용자 버블(대기 중 또는 첨부).
      // opts.attachments 있으면 버블 안에 미리보기, opts.queued 면 '대기 중' 배지 + ✕ 취소 버튼
      // (ADR 2026-07-15). 어느 경우든 pendingQueued 에 등록 → channel.message.in echo 가
      // correlationId(있으면) 또는 텍스트 매칭으로 이 버블을 승격(중복 렌더 방지, 배지·버튼 제거).
      // 큐-취소(대기 중 버블) — ✕ 클릭 시 POST /api/cancel-queued. "cancelled" 면 버블을 취소선+
      // "취소됨"(G2)·pendingQueued 에서 제거(echo 승격 대상 아님). "already-started"/"not-found"
      // (echo 이후 등)면 안내만(G3, 자동 /stop 전환 X). 실패해도 버블은 유지(비파괴).
      const cancelQueuedBubble = async (entry, btn) => {
        if (!entry || !entry.cid) return;
        btn.disabled = true;
        try {
          const r = await fetch("/api/cancel-queued", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ threadKey: activeThreadKey, correlationId: entry.cid }),
          });
          const data = await r.json().catch(() => ({}));
          const result = r.ok ? data.result : null;
          if (result === "cancelled") {
            const el = entry.el;
            el.classList.remove("queued");
            el.classList.add("cancelled-turn");
            const b = el.querySelector(".queued-badge");
            if (b) { b.textContent = "취소됨"; b.classList.add("cancelled-badge"); }
            btn.remove();
            const idx = pendingQueued.indexOf(entry);
            if (idx !== -1) pendingQueued.splice(idx, 1); // echo 승격 대상에서 제외.
          } else {
            // 이미 시작됨(echo 도착 후) 또는 미상 — 안내만(G3).
            btn.disabled = false;
            btn.title = "이미 시작됨 — 중지하려면 /stop 을 보내세요";
            renderLocalChat("info", "이미 처리가 시작됐어요 — 중지하려면 /stop 을 보내세요.");
          }
        } catch {
          btn.disabled = false; // 네트워크 실패 = 버블 유지, 재시도 가능.
        }
      };
      const queueOptimisticBubble = (text, opts) => {
        const o = opts || {};
        const cid = o.cid || "";
        const div = buildHistoryDiv({ ts: Date.now(), role: "user", text });
        if (o.attachments && o.attachments.length) {
          const msg = div.querySelector(".chat-message");
          (msg || div).appendChild(buildAttachmentsPreview(o.attachments));
        }
        const entry = { text, el: div, cid };
        if (o.queued) {
          div.classList.add("queued");
          const badge = document.createElement("span");
          badge.className = "queued-badge"; badge.textContent = "대기 중";
          (div.firstChild || div).appendChild(badge); // head(ts+라벨) 에 배지 부착.
          if (cid) {
            // ✕ 취소 버튼 — 대기 중(미시작) 버블에만. echo 승격 시 제거(D3).
            const x = document.createElement("button");
            x.type = "button"; x.className = "queued-cancel"; x.textContent = "✕";
            x.title = "대기 취소";
            x.addEventListener("click", (ev) => { ev.stopPropagation(); void cancelQueuedBubble(entry, x); });
            (div.firstChild || div).appendChild(x);
          }
        }
        vtAppend(div);
        pendingQueued.push(entry);
        localChatCount += 1;
        refreshChatEmpty();
        scrollChatToNewest();
      };

