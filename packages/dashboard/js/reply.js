      // ── 답글 인용(인바운드) — 특정 메시지에 답글로 입력 ──────────────────────────
      // 각 메시지 버블 hover 시 "↩ 답글" 버튼 lazy 주입(렌더 경로 무변경 = 델리게이션). 클릭 →
      // 입력창 위 인용 칩. 전송 시 그 원문을 replyToText 로 POST → 브리지가 IncomingMessage.replyToText
      // 로 실어 route 직전 인용 주입(telegram reply_to 와 동형·LLM-agnostic, 신규 백엔드 0).
      const chatReplyEl = document.getElementById("chat-reply");
      let replyingTo = null; // { text, label }
      const clearReply = () => {
        replyingTo = null;
        if (chatReplyEl) { chatReplyEl.hidden = true; chatReplyEl.textContent = ""; }
      };
      const startReply = (text, label) => {
        const t = String(text || "").trim();
        if (t === "" || !chatReplyEl) return;
        replyingTo = { text: t.slice(0, 1500), label: label || "메시지" };
        chatReplyEl.textContent = "";
        const lb = document.createElement("span"); lb.className = "cr-label"; lb.textContent = "↩ " + replyingTo.label;
        const tx = document.createElement("span"); tx.className = "cr-text"; tx.textContent = replyingTo.text.replace(/\s+/g, " ");
        const x = document.createElement("button"); x.type = "button"; x.className = "cr-x"; x.textContent = "✕"; x.title = "답글 취소";
        x.addEventListener("click", clearReply);
        chatReplyEl.appendChild(lb); chatReplyEl.appendChild(tx); chatReplyEl.appendChild(x);
        chatReplyEl.hidden = false;
        try { document.getElementById("chat-input").focus(); } catch {}
      };
      // 메시지 카드 hover 시 ⋯ 메뉴 kebab 을 **카드 맨 윗라인 우측**에 1회 주입. 붙어있던
      // ↩답글 버튼은 폐지 — 답글은 ⋯ 메뉴 안(아래 registerMenuItems "message")에 있어 무손실.
      // 단순 버블(.ev.local)=head 우측 절대배치 / 턴그룹=turn-head flex 끝(margin-left:auto,
      // turn-count 겹침 회피). 툴 스텝(.act-line)엔 .chat-message 없어 무영향. 카드당 1회(가상화
      // detach 후에도 dataset 이 노드에 유지 = 재주입 0).
      stream.addEventListener("mouseover", (e) => {
        const msg = e.target && e.target.closest ? e.target.closest(".chat-message") : null;
        if (!msg) return;
        const host = msg.closest(".ev.local, .turn-group") || msg.parentElement;
        if (!host || host.dataset.kebabDone) return;
        host.dataset.kebabDone = "1";
        const turnHead = host.classList && host.classList.contains("turn-group")
          ? host.querySelector(":scope > .turn-head") : null;
        attachKebab(turnHead || host, "message", () => messageCtxFromEl(msg));
      });

      // ── 컨텍스트메뉴(메시지, context-menu 계약 §2.2) — 답글(기존 startReply 재사용)·복사 ──
      const messageCtxFromEl = (msg) => {
        const host = msg.closest(".ev.local, .turn-group") || msg.parentElement;
        const typeEl = host ? host.querySelector(".type") : null;
        const label = typeEl && typeEl.textContent ? typeEl.textContent : "메시지";
        const tsAttr = host && host.dataset ? host.dataset.ts : null;
        return { type: "message", targetId: tsAttr || ("m" + Date.now()), label, text: msg.textContent };
      };
      registerBuiltinHandler("message.reply", (ctx) => { startReply(ctx.text, ctx.label); });
      registerBuiltinHandler("message.copy", async (ctx) => {
        if (!navigator.clipboard) return;
        try { await navigator.clipboard.writeText(ctx.text || ""); } catch {}
      });
      registerMenuItems("message", () => [
        { id: "reply", label: "답글", icon: "↩️", action: { kind: "builtin", handler: "message.reply" } },
        { id: "copy", label: "복사", icon: "📋", action: { kind: "builtin", handler: "message.copy" } },
      ]);
      // 우클릭 — 채팅 스트림 위임(가상화로 메시지가 계속 추가/제거되므로 델리게이션, hover 주입과
      // 동형). 텍스트 선택(드래그)과 우클릭은 별개 이벤트라 선택 방해 없음.
      stream.addEventListener("contextmenu", (e) => {
        const msg = e.target && e.target.closest ? e.target.closest(".chat-message") : null;
        if (!msg) return;
        e.preventDefault();
        openMenu("message", messageCtxFromEl(msg), { pos: { x: e.clientX, y: e.clientY } });
      });

      // POST /api/messages 공용 전송 — 긴 턴은 응답이 SSE 로 도착하므로, POST 가 오래 기다린 뒤
      // 끊겨도(프록시/HTTP 타임아웃) 빨간 에러 대신 "작업 중…" 유지(가짜 timeout 방지). 답이
      // 오면 SSE(channel.message.out)가 setChatWorking(false)로 해제. 즉시 실패(<10s)만 진짜 에러.
      const sendChatMessage = async (text, attachments, replyToText) => {
        recordTypedTags(text); // 타이핑/삽입한 #태그 학습 → 다음부터 칩으로.
        // 큐-취소 correlationId(ADR 2026-07-15) — 전송 순간 만들어 (a)낙관적 버블 (b)POST body
        // 를 하나로 묶는다(대기 중이면 ✕ 취소가 이 id 로 그 큐 항목을 지목). 어댑터 무독해(#2).
        const correlationId = (self.crypto && self.crypto.randomUUID)
          ? self.crypto.randomUUID()
          : (String(Date.now()) + "-" + Math.random().toString(16).slice(2));
        // 낙관적 사용자 버블: 진행 중이면 "대기 중" 배지, 첨부가 있으면 이미지/파일 미리보기를 즉시 렌더
        // (전송한 파일을 채팅 카드에서 바로 확인). 둘 중 하나라도 해당하고 내용이 있으면 만든다.
        const busy = activeTurns.has(activeThreadKey);
        const hasAtt = !!(attachments && attachments.length);
        if ((busy || hasAtt) && (text || hasAtt)) {
          queueOptimisticBubble(text, { attachments: hasAtt ? attachments : null, queued: busy, cid: correlationId });
        }
        setChatWorking(true);
        const t0 = Date.now();
        try {
          const r = await fetch("/api/messages", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              text,
              threadKey: activeThreadKey,
              correlationId,
              ...(attachments && attachments.length ? { attachments } : {}),
              ...(replyToText ? { replyToText } : {}),
              // egress override(ADR 2026-07-16 §D4 Phase B2) — 컴포저 셀렉터가 세션(기본)이
              // 아닌 채널을 골랐을 때만 실어 그 턴 응답 egress 를 스왑. 기본("") = 미전송(회귀 0).
              ...(typeof egressChannel === "string" && egressChannel !== ""
                ? { outboundChannel: egressChannel }
                : {}),
            }),
          });
          const data = await r.json().catch(() => ({}));
          if (!r.ok) {
            if (Date.now() - t0 < 10000) { // 즉시 실패 = 진짜 에러(브리지 다운·잘못된 요청 등).
              setChatWorking(false);
              renderLocalChat("error", data.error || ("HTTP " + r.status));
            }
            // 오래 기다린 뒤 끊김 = 긴 턴 → 작업 중 유지(답은 SSE 로). 아무것도 안 함.
          } else {
            setChatWorking(false); // 동기 POST 반환 = 턴 완료(답은 SSE 로 이미/곧 렌더).
          }
        } catch (err) {
          if (Date.now() - t0 < 10000) { // 즉시 네트워크 실패 = 진짜 에러.
            setChatWorking(false);
            renderLocalChat("error", err.message);
          }
          // 긴 대기 뒤 fetch 끊김 = 긴 턴 → 작업 중 유지(답은 SSE 로).
        }
      };
      const submitOptionValue = (value) => sendChatMessage(value);

