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
      /**
       * **그 메시지가 서버에 도착했나** — 추측 대신 확인 (2026-09-20).
       *
       * 연결이 끊겨 응답을 못 받았을 때, «안 받았다» 를 경과 시간으로 단정하지 않고
       * 최근 기록을 되읽어 **같은 글이 사용자 발화로 들어와 있는지** 본다.
       * ★`true` 만 «도착했다» 로 읽는다. 그 밖은 전부 «모른다» 이고, 모르면 **되돌린다**
       *  (글을 지키는 쪽). «없다» 와 «못 봤다» 를 섞지 않는다.
       * ★글이 비어 있으면(첨부만 보낸 경우) 대조할 것이 없으므로 `null`.
       * ★★**한계를 적어 둔다**(회사돌쇠 검토): 이건 «글 + 시각 + 최근 8개» 휴리스틱이라
       *  **확정 증거가 아니다.** 첨부만 보냄 · 큐 대기 · 같은 문장 반복 · 시계 차이에서
       *  틀릴 수 있다. 정확히 하려면 이미 보내고 있는 `correlationId` 를 서버가 저장하고
       *  그걸로 대조해야 하는데, **지금 `chat_log` 는 그 값을 저장하지 않는다**(확인함).
       *  그래서 서버를 고치기 전까지는 여기까지다 — 틀리면 «되돌린다» 쪽으로 틀린다.
       */
      const messageReachedServer = async (threadKey, text, sinceMs) => {
        if (!threadKey || typeof text !== "string" || text.trim() === "") return null;
        try {
          const r = await fetch(
            "/api/chat-history?threadKey=" + encodeURIComponent(threadKey) + "&limit=8",
          );
          if (!r.ok) return null;
          const j = await r.json();
          const rows = (j && Array.isArray(j.entries)) ? j.entries : [];
          const want = text.trim();
          // ★★**애매하면 «모른다» 다 — «도착했다» 는 애매하지 않을 때만** (2026-09-20,
          //  적대 검토 F1·F2·F3). 첫 판은 «5초 앞까지» 를 시계 오차용으로 뒀는데, 그 창이
          //  **같은 글을 5초 안에 두 번 보내면 두 번째를 삼키는** 구멍이었다. 검토자가
          //  네 상황을 재현했다(2연타 · 같은 글 다른 첨부 · 브라우저 시계 30초 느림 ·
          //  되돌아온 글 재전송). 넷 다 «도착» 으로 읽혀 **글과 첨부가 사라진다.**
          //  ★내가 주석에 *"틀리면 «되돌린다» 쪽으로 틀린다"* 고 적어놨는데 **그 진술이
          //   거짓이었다.** 이제 실제로 그쪽으로 틀리게 만든다:
          //   ①`sinceMs` **이후**만 센다(뒤로 여유를 두지 않는다 — 옛 전송을 삼키는 창이다)
          //   ②**딱 하나**일 때만 «도착» 이다. 둘 이상이면 어느 것이 이번 것인지 **모른다**
          //   ③하나도 없으면 «도착 안 함» 이 아니라 **`null`(모른다)** — 큐 대기로 아직
          //     `chat_log` 에 없을 수 있다(F3). 호출부는 `null` 을 되돌림으로 읽는다.
          //  ★시계 축은 **양방향**이다(브라우저 vs 서버). 보정을 빼면 «못 봤다» 가 늘지만
          //   그건 **중복 전송** 쪽이고, 중복은 보이고 되돌릴 수 있다 — 소실은 아니다.
          const hits = rows.filter(
            (e) =>
              e && e.role === "user" && Number(e.ts) >= Number(sinceMs) && String(e.text || "").trim() === want,
          );
          return hits.length === 1 ? true : null;
        } catch {
          return null; // 확인도 못 했다 — «모름» 이다.
        }
      };

      const sendChatMessage = async (text, attachments, replyToText) => {
        // ★★**보낼 방을 여기서 고정한다** (2026-09-20, 회사돌쇠 검토 ②). `await` 뒤에
        //  `activeThreadKey` 를 다시 읽으면, 보내는 사이 탭을 옮겼을 때 **다른 방의 기록**을
        //  조회해 «도착 안 했다» 로 읽는다(실측 재현: A 에 보냈는데 `threadKey=room-B` 를 조회).
        //  ★`chat-send.js` 가 **이미 같은 것을 배웠다**(`sentFrom`, 2026-09-15 레드팀 O4).
        //   나는 그 옆에 새 코드를 쓰면서 같은 실수를 되풀이했다 — 배운 것을 안 옮겼다.
        const sentTo = activeThreadKey;
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
              threadKey: sentTo,
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
            // ★판정은 `sendRejectionAction`(순수)가 한다 — 여기 인라인으로 두면 «되돌리나»·
            //  «말해주나»·«작업중을 끄나» 셋이 한 조건에 묶인다.
            // ★**신고의 원인은 «말을 안 해준다» 가 아니었다**(2026-09-16 2차 정정). 같은
            //  신고를 그렇게 읽고 `tellUser` 를 켰는데 증상이 그대로였다 — 진짜 원인은
            //  **504 를 거절로 읽어 되돌린 것**이다. 자세한 사슬은 `util.js` 의 그 함수 주석.
            const act = sendRejectionAction(Date.now() - t0, r.status, data);
            // ★★**5xx 는 «안 받았다» 가 아니라 «모른다» 다** (2026-09-20, 회사돌쇠 검토 ①).
            //  대시보드 프록시는 브리지 요청 뒤 응답을 못 받으면 `accepted` 없는 **502** 를
            //  낸다 — 그 안엔 «접속 전 실패» 와 «처리는 시작됐는데 응답만 유실» 이 **섞여
            //  있다.** 앞 커밋은 연결 예외 가지만 고쳤고 **이 가지는 그대로 두었다.**
            //  ★4xx 는 다르다 — 서버가 «안 받았다» 고 **말한** 것이라 그대로 되돌린다
            //   (413·400 에서 쓴 글과 첨부를 지키는 것이 그 가지의 존재 이유다).
            if (act.restore && !(act.status >= 400 && act.status < 500)) {
              const reached = await messageReachedServer(sentTo, text, t0);
              if (reached === true) {
                if (act.clearWorking) setChatWorking(false, sentTo);
                renderLocalChat("info", i18n("chat.send.deliveredNoReply"));
                return { ok: true };
              }
            }
            if (act.clearWorking) setChatWorking(false, sentTo);
            // ★5xx 는 «거절» 이 아니라 «모름» 이다 — 504 는 우리 브리지의 60초 시한이고
            //  그 사이 메시지는 큐에서 그대로 실행된다. 오류로 붉게 띄우면 사용자가 다시
            //  보내게 되고 그게 곧 중복 전송이다. 무슨 일인지는 말하되 격을 가른다.
            if (act.tellUser) {
              if (act.stillRunning) {
                renderLocalChat("info", i18n("chat.send.stillRunning"));
              } else {
                renderLocalChat("error", data.error || ("HTTP " + r.status));
              }
            }
            // 오래 기다린 뒤엔 **작업 중 표시는 유지**한다(긴 턴일 수 있고 답은 SSE 로).
            // ★그러나 **보낸 게 아니라는 사실은 시간과 무관하다** (2026-09-15 2차 정정,
            //  회사 아스트라 P2). 종전엔 10초를 넘기면 `{ ok: true }` 로 떨어져, 느린
            //  업로드 뒤 도착한 **413 같은 명시적 거절**에서 컴포저가 성공으로 알고
            //  **쓴 글과 첨부를 지웠다.** 서버가 상태 코드로 «안 받았다» 고 말한 것을
            //  경과 시간으로 뒤집으면 안 된다. 「작업 중 표시」와 「수락 여부」는 다른 판단이다.
            // ★`restore` 가 곧 «서버가 안 받았다고 말했나» 다. `ok` 와 갈라 둔다 —
            //  전송이 성공한 것은 아니지만, 되돌리는 것과는 다른 판단이다.
            return { ok: false, restore: act.restore };
          } else if (data && data.steered) {
            // mid-turn steering 주입(ADR 2026-07-16) — 이 POST 는 진행 턴을 *이어가게* 메시지를
            // 끼워넣고 즉시 반환한다(턴 완료 아님). 여기서 setChatWorking(false, sentTo) 하면 긴 codex
            // 턴이 계속 도는데도 작업중이 조기에 꺼진다(steering 조기-off 버그). 스킵 — 작업중은
            // 원래 턴의 실제 종료(SSE channel.message.out/turn_done)까지 유지. 사용자 버블은
            // channel.message.in echo 가 낙관적 '대기 중' 버블을 정상 버블로 승격한다.
          } else {
            setChatWorking(false, sentTo); // 동기 POST 반환 = 턴 완료(답은 SSE 로 이미/곧 렌더).
          }
        } catch (err) {
          // ★★**«못 받았다» 를 시계로 추정하지 않는다 — 서버에 물어본다** (2026-09-20,
          //  정태님 신고 3회째). 종전엔 «10초 안에 끊기면 진짜 에러» 로 가르고 글·첨부를
          //  입력창에 되돌렸다. 그런데 **요청은 도착해 처리까지 됐는데 응답만 못 돌아오는**
          //  경우가 있고, 그때 되돌리면 사용자가 다시 눌러 **같은 지시가 두 번** 간다.
          //  ★실측: 보낸 메시지가 `chat_log` 에 멀쩡히 있는데(비서가 그 일을 수행 중)
          //   같은 글과 **첨부 칩까지** 컴포저로 돌아와 있었다. 그 브리지는 연결을 자주
          //   끊는다(같은 날 POST 첫 시도 실패가 열 번 넘었다).
          //  ★바로 아래 «10초 초과» 주석이 이미 옳은 답을 적어놨다 — *"서버가 받았는지
          //   **모른다**"*. 같은 불확실성이 10초 안쪽에도 있는데 거기서만 «안다» 고
          //   단정하고 있었다. 이제 **시간으로 가르지 않고 사실을 확인한다.**
          const arrived = await messageReachedServer(sentTo, text, t0);
          if (arrived === true) {
            // 서버는 받았다 — 되돌리면 그게 곧 중복 전송이다. 말만 하고 글은 안 되돌린다.
            renderLocalChat("info", i18n("chat.send.deliveredNoReply"));
            return { ok: true };
          }
          // ★확인이 «아니다» 이거나 **확인 자체가 실패**(브리지가 아예 죽음)면 되돌린다 —
          //  그 경우 대개 도달 자체를 못 했고, 틀려도 «보이고 되돌릴 수 있는» 쪽이다.
          //  ★긴 대기 뒤 끊긴 것은 종전대로 **지우지도 되돌리지도 않는다**(현행 유지).
          if (Date.now() - t0 < 10000) {
            setChatWorking(false, sentTo);
            renderLocalChat("error", err.message);
            return { ok: false, restore: true };
          }
        }
        return { ok: true };
      };
      const submitOptionValue = (value) => sendChatMessage(value);

