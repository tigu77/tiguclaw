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
        replyingTo = { text: t.slice(0, 1500), label: label || i18n("common.message") };
        chatReplyEl.textContent = "";
        const lb = document.createElement("span"); lb.className = "cr-label"; lb.textContent = "↩ " + replyingTo.label;
        const tx = document.createElement("span"); tx.className = "cr-text"; tx.textContent = replyingTo.text.replace(/\s+/g, " ");
        const x = document.createElement("button"); x.type = "button"; x.className = "cr-x"; x.textContent = "✕"; x.title = i18n("reply.cancel");
        x.addEventListener("click", clearReply);
        chatReplyEl.appendChild(lb); chatReplyEl.appendChild(tx); chatReplyEl.appendChild(x);
        chatReplyEl.hidden = false;
        // 답글은 "이제 쓰겠다" 는 명시적 행동 — 포커스가 가는 게 맞다(util.js 정책 참조).
        focusChatInput({ userIntendsToType: true });
      };
      // 메시지 카드 hover 시 ⋯ 메뉴 kebab 을 **카드 맨 윗라인 우측**에 1회 주입. 붙어있던
      // ↩답글 버튼은 폐지 — 답글은 ⋯ 메뉴 안(아래 registerMenuItems "message")에 있어 무손실.
      // 단순 버블(.ev.local)=head 우측 절대배치 / 턴그룹=turn-head flex 끝(margin-left:auto,
      // turn-count 겹침 회피). 툴 스텝(.act-line)엔 .chat-message 없어 무영향. 카드당 1회(가상화
      // detach 후에도 dataset 이 노드에 유지 = 재주입 0).
      /**
       * 긴 카드에서 ⋯ 버튼이 **보이는 영역을 따라다니게** 한다 (2026-08-23 사용자 요청).
       *
       * ★CSS `sticky` 로 안 된다 — 가상화가 창을 `translateY` 로 옮기고, 변환된 조상이
       *  sticky 의 기준을 깨뜨린다(실측: 버튼이 카드 끝에 남았고 재배치 때 노드도 갈렸다).
       *  그래서 절대배치 그대로 두고 `top` 만 스크롤에 맞춰 옮긴다 — 변환 안에서도
       *  예측 가능하다.
       * ★비용: 리스너는 **하나**고, 매 스크롤에 갱신하는 카드는 지금 hover 중인 **하나**뿐.
       *  카드마다 옵저버를 달면 목록 길이에 비례해 비싸진다(가상화가 그걸 피하려 있는 것).
       * 카드가 화면 안에 다 들어오면 원래 자리(7px)로 돌아간다 — 짧은 카드는 동작 변화 0.
       */
      let followed = null; // { host, btn }
      const KEBAB_TOP = 7;
      const syncFollowedKebab = () => {
        if (followed === null) return;
        const { host, btn } = followed;
        if (!host.isConnected || !btn.isConnected) { followed = null; return; }
        const sr = stream.getBoundingClientRect();
        const hr = host.getBoundingClientRect();
        // 카드 상단이 화면 위로 밀린 만큼 내려 보낸다. 카드 아래로는 안 넘어가게 clamp.
        const pushed = Math.max(0, sr.top - hr.top);
        const maxTop = Math.max(0, hr.height - btn.offsetHeight - KEBAB_TOP * 2);
        btn.style.top = `${Math.round(Math.min(pushed + KEBAB_TOP, maxTop))}px`;
      };
      const followKebab = (host, btn) => {
        if (!host || !btn) return;
        // 턴 그룹은 머리(flex)에 붙어 있어 `top` 이 없다 — 단순 버블(절대배치)만 따라간다.
        if (!host.classList || !host.classList.contains("local")) return;
        host.addEventListener("mouseenter", () => { followed = { host, btn }; syncFollowedKebab(); });
        host.addEventListener("mouseleave", () => {
          if (followed && followed.host === host) followed = null;
          btn.style.top = `${KEBAB_TOP}px`;
        });
        followed = { host, btn };
        syncFollowedKebab();
      };
      stream.addEventListener("scroll", syncFollowedKebab, { passive: true });

      stream.addEventListener("mouseover", (e) => {
        const msg = e.target && e.target.closest ? e.target.closest(".chat-message") : null;
        if (!msg) return;
        const host = msg.closest(".ev.local, .turn-group") || msg.parentElement;
        if (!host || host.dataset.kebabDone) return;
        host.dataset.kebabDone = "1";
        const turnHead = host.classList && host.classList.contains("turn-group")
          ? host.querySelector(":scope > .turn-head") : null;
        // 턴 머리는 flex 라 기존대로 끝에(margin-left:auto). 단순 버블은 sticky+float 이라
        // 흐름 **맨 앞**에 넣어야 우상단에 뜬다(app.css `.ev.local > .cm-kebab` 참조).
        const btn = attachKebab(turnHead || host, "message", () => messageCtxFromEl(msg));
        followKebab(host, btn);
      });

      // ── 컨텍스트메뉴(메시지, context-menu 계약 §2.2) — 답글(기존 startReply 재사용)·복사 ──
      const messageCtxFromEl = (msg) => {
        const host = msg.closest(".ev.local, .turn-group") || msg.parentElement;
        const typeEl = host ? host.querySelector(".type") : null;
        const label = typeEl && typeEl.textContent ? typeEl.textContent : i18n("common.message");
        const tsAttr = host && host.dataset ? host.dataset.ts : null;
        // ★`raw` = 마크다운 원문(있으면). 복사는 이걸 쓰고, **답글 인용은 `text`**(렌더된
        //  글)를 쓴다 — 인용은 입력창에 짧게 보이는 것이라 기호가 붙으면 읽기 나쁘다.
        //  두 쓰임이 다른 것을 원하므로 필드를 둘로 나눈다(하나로 합치면 한쪽이 손해다).
        return {
          type: "message",
          targetId: tsAttr || ("m" + Date.now()),
          label,
          text: msg.textContent,
          raw: (msg.dataset && msg.dataset.mdSrc) || msg.textContent,
          // ★접기/펴기가 겨눌 **카드 뿌리**. 직렬화되지 않는 자리다(ctx 는 어디서도 통째로
          //  JSON 이 되지 않는다 — endpoint 는 action.body 를, send_message 는 label/targetId
          //  만 쓴다). 외부 기여 항목은 builtin 을 못 부르므로 이 참조에 닿지 않는다.
          el: host,
        };
      };
      registerBuiltinHandler("message.reply", (ctx) => { startReply(ctx.text, ctx.label); });
      registerBuiltinHandler("message.copy", async (ctx) => {
        if (!navigator.clipboard) return;
        // 마크다운 원문 우선 — 없으면(사용자 메시지 등 평문) 렌더된 글 그대로.
        try { await navigator.clipboard.writeText(ctx.raw || ctx.text || ""); } catch {}
      });
      // ★접기/펴기는 **`toggleCardCollapsed` 한 곳**으로 간다(virtualization.js) — 머리줄
      //  클릭과 같은 자리다. 여기서 classList 를 직접 만지면 접기 판정이 두 벌이 된다.
      registerBuiltinHandler("message.collapse", (ctx) => {
        if (ctx && ctx.el) toggleCardCollapsed(ctx.el);
      });
      registerMenuItems("message", (ctx) => {
        const items = [
          { id: "reply", label: i18n("reply.label"), icon: "↩️", action: { kind: "builtin", handler: "message.reply" } },
          { id: "copy", label: i18n("common.copy"), icon: "📋", action: { kind: "builtin", handler: "message.copy" } },
        ];
        // ★**본문 어디서 우클릭해도 접을 수 있다** — 머리줄만 누르게 바꾸면서(2026-09-14)
        //  «긴 답변은 머리줄이 화면 밖» 이 다시 문제가 되는데, 그 필요를 여기가 받는다.
        //  펼칠 손잡이(머리줄)가 없는 카드엔 항목을 내지 않는다 — 되돌릴 길이 없으니까.
        const root = ctx && ctx.el;
        if (root && cardCollapseHead(root)) {
          const collapsed = isCardCollapsed(root);
          items.push({
            id: "collapse",
            label: collapsed ? i18n("ctx.expand") : i18n("ctx.collapse"),
            icon: collapsed ? "▸" : "▾",
            action: { kind: "builtin", handler: "message.collapse" },
          });
        }
        return items;
      });
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
              // egress fan-out(ADR 2026-07-16 §D4 Phase B2) — 컴포저 체크박스가 "이 답도 함께
              // 보낼" 추가 채널을 골랐을 때만 배열로 실음(인입 응답은 백엔드가 항상 유지). 빈
              // 배열/미체크 = 미전송(회귀 0). getEgressChannels 는 egress-selector.js 가 정의.
              ...((() => {
                const chs =
                  typeof getEgressChannels === "function" ? getEgressChannels() : [];
                return Array.isArray(chs) && chs.length > 0
                  ? { outboundChannels: chs }
                  : {};
              })()),
            }),
          });
          const data = await r.json().catch(() => ({}));
          if (!r.ok) {
            // ★판정은 `sendRejectionAction`(순수)가 한다 — 여기 인라인으로 두면 «말해주나» 와
            //  «작업중을 끄나» 가 한 조건에 묶여, 느린 거절이 **아무 말 없이** 텍스트만
            //  되돌리는 상태가 된다(정태님 신고: 턴 진행중인데 보낸 글이 입력창에 다시).
            const act = sendRejectionAction(Date.now() - t0, r.status);
            if (act.clearWorking) setChatWorking(false);
            if (act.tellUser) renderLocalChat("error", data.error || ("HTTP " + r.status));
            // 오래 기다린 뒤엔 **작업 중 표시는 유지**한다(긴 턴일 수 있고 답은 SSE 로).
            // ★그러나 **보낸 게 아니라는 사실은 시간과 무관하다** (2026-09-15 2차 정정,
            //  회사 아스트라 P2). 종전엔 10초를 넘기면 `{ ok: true }` 로 떨어져, 느린
            //  업로드 뒤 도착한 **413 같은 명시적 거절**에서 컴포저가 성공으로 알고
            //  **쓴 글과 첨부를 지웠다.** 서버가 상태 코드로 «안 받았다» 고 말한 것을
            //  경과 시간으로 뒤집으면 안 된다. 「작업 중 표시」와 「수락 여부」는 다른 판단이다.
            return { ok: false };
          } else if (data && data.steered) {
            // mid-turn steering 주입(ADR 2026-07-16) — 이 POST 는 진행 턴을 *이어가게* 메시지를
            // 끼워넣고 즉시 반환한다(턴 완료 아님). 여기서 setChatWorking(false) 하면 긴 codex
            // 턴이 계속 도는데도 작업중이 조기에 꺼진다(steering 조기-off 버그). 스킵 — 작업중은
            // 원래 턴의 실제 종료(SSE channel.message.out/turn_done)까지 유지. 사용자 버블은
            // channel.message.in echo 가 낙관적 '대기 중' 버블을 정상 버블로 승격한다.
          } else {
            setChatWorking(false); // 동기 POST 반환 = 턴 완료(답은 SSE 로 이미/곧 렌더).
          }
        } catch (err) {
          if (Date.now() - t0 < 10000) { // 즉시 네트워크 실패 = 진짜 에러.
            setChatWorking(false);
            renderLocalChat("error", err.message);
            return { ok: false }; // 위와 같은 이유 — 초안을 되돌릴 수 있게.
          }
          // ★긴 대기 뒤 **연결이 끊긴 것**은 위(명시적 거절)와 다르다 — 서버가 받았는지
          //  **모른다.** 여기서 실패로 보고하면 사용자가 되돌아온 초안을 다시 보내
          //  **중복 전송**이 된다. 모를 땐 지우지도, 되돌리지도 않는다(현행 유지).
        }
        return { ok: true };
      };
      const submitOptionValue = (value) => sendChatMessage(value);

