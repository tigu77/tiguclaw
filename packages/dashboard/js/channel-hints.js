      // ── 엔드포인트/API 활동(B, 2026-07-12) ───────────────────────────────
      // 외부 앱이 register_endpoint 로 호출하는 turn 은 사람 대화가 아니라 기계 API 호출 →
      // 채팅에서 제외(아래 필터)하고 메인 nav "엔드포인트" 뷰에 모은다. 데이터 소스 = http-bridge
      // 가 매 호출에 발행하는 `endpoint.call` 이벤트(요청+응답 전문·성공/실패). 전체 기록은
      // DB(transcripts)에 영속 — 이 뷰는 라이브 세션 열람용.
      const endpointLog = [];        // {ts, name, ok, request, response} — 오름차순, 캡 EP_MAX.
      const epOpen = new Set();      // 펼친 항목 ts(재렌더 시 펼침 상태 보존).
      const epSeenTs = new Set();    // ts dedup.
      const EP_MAX = 60;
      const isEndpointThread = (tk) => typeof tk === "string" && tk.indexOf("endpoint:") === 0;
      // ── 채널 힌트(ADR 2026-07-15 §D6) — 메시지/세션이 어느 전송로에서 들어왔나. 세션은
      //    채널 무관이라(텔레그램도 기본 세션에 합류) "텔레그램 경유"를 가시화한다. 대시보드
      //    자기 채널(http-bridge/dashboard)은 자명하므로 배지 없음. §0 단방향: 코어 아닌
      //    대시보드/채널 레이어의 UI 컨벤션이라 채널명→라벨 매핑 허용(generic 폴백 유지).
      const CHANNEL_LABELS = { telegram: { short: "TG", full: "텔레그램" }, cli: { short: "CLI", full: "CLI" } };
      const OWN_CHANNELS = new Set(["http-bridge", "dashboard"]);
      const channelMeta = (ch) => {
        if (!ch || typeof ch !== "string" || OWN_CHANNELS.has(ch)) return null;
        return CHANNEL_LABELS[ch] || { short: ch.slice(0, 6).toUpperCase(), full: ch };
      };
      // threadKey 접두에서 채널 추론(서버가 channel 메타 미제공 시 폴백). tg:/cli:/dashboard:.
      const channelFromThreadKey = (tk) => {
        if (typeof tk !== "string" || tk === "") return null;
        if (tk.indexOf("tg:") === 0) return "telegram";
        if (tk.indexOf("cli:") === 0) return "cli";
        if (tk.indexOf("dashboard:") === 0) return "dashboard";
        const i = tk.indexOf(":");
        return i > 0 ? tk.slice(0, i) : null;
      };
      const buildChannelBadge = (ch) => {
        const m = channelMeta(ch);
        if (!m) return null;
        const b = document.createElement("span");
        b.className = "ch-badge"; b.textContent = m.short; b.title = m.full + " 경유";
        return b;
      };
      const captureEndpointCall = (p) => {
        const ts = Number(p && p.ts) || Date.now();
        if (epSeenTs.has(ts)) return;
        epSeenTs.add(ts);
        endpointLog.push({ ts, name: String((p && p.name) || "endpoint"), ok: (p && p.ok) !== false, request: String((p && p.request) || ""), response: String((p && p.response) || "") });
        endpointLog.sort((x, y) => x.ts - y.ts);
        if (endpointLog.length > EP_MAX) { for (const d of endpointLog.splice(0, endpointLog.length - EP_MAX)) epOpen.delete(d.ts); }
        epOpen.add(ts); // 최신 호출은 기본 펼침.
        updateEndpointBadge();
        renderEndpointsView(); // currentView!=endpoints 면 no-op.
      };
      const updateEndpointBadge = () => {
        const b = document.getElementById("nav-endpoint-count"); if (b) b.textContent = String(endpointLog.length);
      };
      const buildEpSection = (label, text) => {
        const box = document.createElement("div"); box.className = "ep-sec";
        const lab = document.createElement("div"); lab.className = "ep-sec-label"; lab.textContent = label;
        const body = document.createElement("div"); body.className = "ep-item-body"; body.textContent = text || "(없음)";
        box.appendChild(lab); box.appendChild(body); return box;
      };
      // 엔드포인트 뷰 렌더 — 메인 nav destination(#detail-panel). currentView 가 endpoints 일 때만
      // 그린다(라이브 갱신 시 no-op 가드, renderAgentsView 동형). 각 항목: 헤더 클릭 = 접힘/펼침,
      // 펼치면 요청·응답 전문(pre-wrap, 안 잘림 — 극단 길이만 내부 스크롤).
      const renderEndpointsView = () => {
        if (currentView !== "endpoints") return;
        const root = document.getElementById("detail-panel"); if (!root) return;
        root.innerHTML = "";
        const wrap = document.createElement("div"); wrap.className = "page-view";
        const head = document.createElement("div"); head.className = "detail-head";
        head.innerHTML = '<div class="detail-accent"></div><div class="detail-name">엔드포인트 호출</div><span class="detail-kind">API 활동</span>';
        wrap.appendChild(head);
        const desc = document.createElement("p"); desc.className = "ep-view-desc";
        desc.textContent = "외부 앱이 커스텀 HTTP 엔드포인트로 호출한 기록입니다(채팅과 분리, 읽기 전용). 헤더를 누르면 요청·응답 전문이 펼쳐집니다. 전체 기록은 DB 에 영속됩니다.";
        wrap.appendChild(desc);
        if (endpointLog.length === 0) {
          const empty = document.createElement("div"); empty.className = "ep-empty";
          empty.textContent = "아직 엔드포인트 호출이 없습니다.";
          wrap.appendChild(empty);
        } else {
          const list = document.createElement("div"); list.className = "ep-view-list";
          for (let i = endpointLog.length - 1; i >= 0; i--) { // 최신 먼저.
            const e = endpointLog[i];
            const open = epOpen.has(e.ts);
            const row = document.createElement("div"); row.className = "ep-item" + (e.ok ? " ep-out" : " ep-err") + (open ? " open" : "");
            const h = document.createElement("div"); h.className = "ep-item-head";
            const car = document.createElement("span"); car.className = "ep-caret"; car.textContent = "▶";
            const st = document.createElement("span"); st.textContent = e.ok ? "✅ 응답" : "⚠ 실패";
            const nm = document.createElement("span"); nm.className = "ep-item-name"; nm.textContent = e.name;
            const tm = document.createElement("span"); tm.className = "ep-item-time"; tm.textContent = fmtTime(e.ts);
            h.appendChild(car); h.appendChild(st); h.appendChild(nm); h.appendChild(tm);
            h.addEventListener("click", () => {
              const nowOpen = row.classList.toggle("open");
              if (nowOpen) epOpen.add(e.ts); else epOpen.delete(e.ts);
            });
            const detail = document.createElement("div"); detail.className = "ep-item-detail";
            detail.appendChild(buildEpSection("요청", e.request));
            detail.appendChild(buildEpSection("응답", e.response));
            row.appendChild(h); row.appendChild(detail); list.appendChild(row);
          }
          wrap.appendChild(list);
        }
        root.appendChild(wrap);
      };
      const showEndpoints = () => {
        setActiveNav("endpoints");
        document.getElementById("workbench").classList.remove("show-providers"); // detail-panel 노출(다른 뷰와 동형).
        document.getElementById("workbench").classList.remove("show-capabilities");
        renderEndpointsView();
      };

      const renderChannelMessage = (ev, ts) => {
        const payload = ev.payload || {};
        const isOut = ev.type === "channel.message.out";
        const thread = payload.threadKey || activeThreadKey;

        // ── 아웃바운드 첨부 카드(send_file, #2) ────────────────────────────
        // send_file 은 턴 *중간* 산출물이라 attachments 를 실은 out 이벤트가 온다. 이건 최종
        // 답변이 아니므로 P5 승격/턴 완료 로직을 타면 안 된다(그러면 턴이 조기 마감되고 첨부가
        // 안 보인다). 진행 중 턴 그룹이 있으면 그 안(스텝 아래)에, 없으면 스트림에 단독 삽입 —
        // 턴은 완료하지 않는다(최종 text-out 이 마감). 미리보기+받기 버튼은 buildAttachmentsPreview.
        if (isOut && payload.attachments && payload.attachments.length) {
          const div = document.createElement("div");
          div.className = "ev local channel-chat";
          div.dataset.type = "channel.message.out";
          if (ev.ts != null) div.dataset.ts = String(ev.ts);
          const head = document.createElement("div");
          const tsEl = document.createElement("span"); tsEl.className = "ts"; tsEl.textContent = ts;
          const tyEl = document.createElement("span"); tyEl.className = "type"; tyEl.textContent = assistantName;
          head.appendChild(tsEl); head.appendChild(tyEl);
          { const chb = buildChannelBadge(payload.channel); if (chb) head.appendChild(chb); } // 원격 채널 경유 표시.
          div.appendChild(head);
          const msg = document.createElement("div");
          msg.className = "chat-message";
          if (payload.text) setChatBody(msg, payload.text, true); // 캡션이 text 로 온 경우 대비(현재는 attachment.caption).
          msg.appendChild(buildAttachmentsPreview(payload.attachments, { download: true }));
          div.appendChild(msg);
          const card = cardByThread.get(thread);
          if (card && card.group && vtIndex.has(card.group) && !card.closed) {
            card.group.appendChild(div); // 진행 중 턴 그룹 안(스텝 다음).
            scheduleRelayout();
          } else {
            vtAppend(div);
          }
          localChatCount += 1;
          refreshChatEmpty();
          if (currentView === "overview") setTimeout(showOverview, 0);
          return;
        }

        // ── P5 진행 버블 승격 ──────────────────────────────────────────────
        // out(봇 답변)이고 같은 threadKey 에 스트리밍 진행 버블이 있으면, 새 버블을 만들지
        // 말고 그 진행 버블을 "최종 권위 전체본 + 마크다운"으로 승격(중복 버블 생성 금지).
        // 누적 평문 델타는 폐기되고 out 전체본으로 치환 = 부분 렌더 오차 자가치유.
        if (isOut) {
          const card = cardByThread.get(thread);
          // 인터리브(2026-07-13): 이 턴이 kind:"text" 세그먼트를 냈으면 마지막 텍스트는 이미
          // 세그먼트 버블이 소유 → 최종 답변 버블을 따로 만들거나 승격하지 않는다(중복 방지). 턴만 마감.
          if (card && card.sawTextSegment && vtIndex.has(card.group)) {
            if (card.replyMsg) card.replyMsg.classList.remove("streaming"); // 혹시 남은 커서 정리.
            card.replyBubble = null; card.replyMsg = null; card.replyRaw = "";
            completeTurnGroup(thread);
            localChatCount += 1;
            refreshChatEmpty();
            if (currentView === "overview") setTimeout(showOverview, 0);
            scheduleRelayout();
            return;
          }
          if (card && card.replyBubble && vtIndex.has(card.group)) {
            setChatBody(card.replyMsg, payload.text, true);     // 평문 델타 → 마크다운 전체본 1회.
            card.replyMsg.classList.remove("streaming");        // 타이핑 커서 off.
            card.replyBubble = null; card.replyMsg = null; card.replyRaw = "";
            completeTurnGroup(thread);                          // 스텝 카드 "n단계 완료"로 접기.
            localChatCount += 1;
            refreshChatEmpty();
            if (currentView === "overview") setTimeout(showOverview, 0);
            scheduleRelayout();
            return;
          }
        }

        const div = document.createElement("div");
        div.className = "ev local channel-chat";
        div.dataset.type = (ev.type || "").toLowerCase();
        if (ev.ts != null) div.dataset.ts = String(ev.ts); // prune 후 커서 복구용 수치 ts.
        const head = document.createElement("div");
        const tsEl = document.createElement("span");
        tsEl.className = "ts";
        tsEl.textContent = ts;
        const tyEl = document.createElement("span");
        tyEl.className = "type";
        tyEl.textContent = isOut ? assistantName : "나";
        head.appendChild(tsEl); head.appendChild(tyEl);
        { const chb = buildChannelBadge(payload.channel); if (chb) head.appendChild(chb); } // 텔레그램 등 원격 채널 경유 표시.
        div.appendChild(head);
        const msg = document.createElement("div");
        msg.className = "chat-message";
        // 봇 출력(비서)만 마크다운, 사용자 입력(나)은 평문 유지.
        setChatBody(msg, payload.text, isOut);
        // 라이브 첨부(rel 메타) — 타클라이언트/텔레그램발 사용자 메시지의 이미지/파일 표시. 이
        // 클라이언트 자기 전송은 낙관적 버블(base64)로 이미 떠서 echo 가 reconcile(여기 안 옴).
        if (!isOut && payload.attachments && payload.attachments.length) {
          msg.appendChild(buildAttachmentsPreview(payload.attachments));
        }
        div.appendChild(msg);
        // 봇 답변(out)이면 같은 턴의 스텝 그룹을 마무리하고 그 그룹 안(스텝 아래)에 버블 배치.
        // 진행 중 그룹이 없으면(또는 사용자 입력) 기존처럼 stream 최상단에 단독 삽입.
        const group = isOut ? completeTurnGroup(thread) : null;
        if (group) {
          group.appendChild(div); // 그룹 내 스텝 카드 다음 = 답변 말풍선(서브트리 변형 → RO 반영).
          scheduleRelayout();
        } else {
          vtAppend(div);
        }
        localChatCount += 1;
        refreshChatEmpty();
        if (currentView === "overview") setTimeout(showOverview, 0);
      };

