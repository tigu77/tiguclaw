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
      const paintWorking = (s) => {
        // ★다채널 단일 인격 — 텔레그램·CLI·대시보드 어디서 온 턴이든 대시보드 발신과 똑같이
        // "<비서> 작업 중" 으로 통일(채널 라벨 없음). 동시에 여럿이면 "(+N)".
        const extra = activeTurns.size > 1 ? " (+" + (activeTurns.size - 1) + ")" : "";
        // ★경과시간은 **이 대화의 것만** 판다 (2026-08-06). 종전엔 내 세션에 진행 턴이 없으면
        //  `가장 이른 턴`으로 폴백해 **남의 세션 경과시간이 내 화면에 떴다** — 이 줄은 입력창
        //  바로 위라 누구나 "내 요청이 N분째" 로 읽는다. 다른 세션이 도는 사실은 그 세션 탭의
        //  진행 점(st-dot)이 이미 알려주므로, 여기서 숫자를 지어내지 않는다(모르면 안 쓴다).
        const mineStart = activeTurns.get(activeThreadKey);
        const lab = s.querySelector(".chat-work-label");
        if (lab) lab.textContent = assistantName + " 작업 중" + extra + (mineStart ? " ·" : "");
        const el = s.querySelector(".chat-elapsed");
        if (el) el.textContent = mineStart ? fmtElapsed(Date.now() - mineStart) : "";
      };
      const refreshWorking = () => {
        if (onTurnsChanged) onTurnsChanged(); // 세션 탭 진행 뱃지 갱신(모든 세션 추적, active 대표).
        const s = document.getElementById("chat-status"); if (!s) return;
        if (activeTurns.size === 0) {
          if (chatWorkingTimer) { clearInterval(chatWorkingTimer); chatWorkingTimer = null; }
          s.classList.remove("working"); s.textContent = ""; return;
        }
        if (!s.classList.contains("working")) {
          s.classList.add("working");
          s.innerHTML = '<span class="chat-spinner">✳️</span> <span class="chat-work-label"></span> <span class="chat-elapsed"></span>';
        }
        paintWorking(s);
        if (!chatWorkingTimer) chatWorkingTimer = setInterval(() => {
          // stale 스윕 — 유령 진행표시(놓친 turn_done)가 영영 안 꺼지는 것 방지. 비면 해제.
          const now = Date.now(); let swept = false;
          for (const [k, start] of activeTurns) if (now - start > STALE_TURN_MS) { activeTurns.delete(k); swept = true; }
          if (swept && activeTurns.size === 0) { refreshWorking(); return; }
          const el = document.getElementById("chat-status"); if (el) paintWorking(el);
        }, 1000);
      };
      const markTurnActive = (tk) => {
        const k = tk || activeThreadKey;
        if (!activeTurns.has(k)) activeTurns.set(k, Date.now());
        refreshWorking();
      };
      const markTurnDone = (tk) => { const k = tk || activeThreadKey; if (activeTurns.delete(k)) refreshWorking(); };
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

