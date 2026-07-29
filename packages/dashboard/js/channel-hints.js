      // ── 엔드포인트/API 활동(B, 2026-07-12) ───────────────────────────────
      // 외부 앱이 register_endpoint 로 호출하는 turn 은 사람 대화가 아니라 기계 API 호출 →
      // 채팅에서 제외(아래 필터)하고 메인 nav "엔드포인트" 뷰에 모은다. 데이터 소스 = http-bridge
      // 가 매 호출에 발행하는 `endpoint.call` 이벤트(요청+응답 **미리보기**·성공/실패). 전체
      // 기록은 DB(transcripts)에 영속 — 이 뷰는 라이브 세션 열람용.
      const endpointLog = [];        // {ts, name, ok, request, response} — 오름차순, 캡 EP_MAX.
      const epOpen = new Set();      // 펼친 항목 ts(재렌더 시 펼침 상태 보존).
      const epSeenTs = new Set();    // ts dedup.
      const EP_MAX = 60;
      // ★자동 펼침은 **최신 1건만** (2026-07-26). 종전엔 캡처마다 epOpen.add 라 최대 60건이
      //   전부 펼쳐진 채 DOM 에 들어갔다. 엔드포인트 요청은 실측 평균 25만자·최대 1.3MB(!)
      //   여서 pre-wrap 레이아웃이 브라우저를 멈춰 세웠다(사용자 신고: "들어가면 멈춰있어").
      //   서버가 미리보기로 자르고(ENDPOINT_PREVIEW_MAX), 여기선 펼침 수를 줄이고,
      //   본문 DOM 은 펼칠 때 만든다(lazy) — 3중으로 핫 경로를 바운드.
      //   사용자가 직접 펼친 건 그대로 두고 *자동으로* 펼쳤던 직전 것만 접는다.
      let epAutoOpenTs = null;
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
      // ★수명주기 (2026-07-26) — 서버가 요청 접수 시 phase:"start", 끝나면 phase:"done" 을
      //   **같은 callId** 로 보낸다. 종전엔 완료 이벤트 하나뿐이라 20초~5분 도는 동안 화면에
      //   아무것도 없었다("멈춘 것처럼 보인다" — 실제 엔드포인트가 20초+ 걸림).
      //   start 를 못 받은 옛 이벤트(callId 없음)는 그대로 완료 1건으로 취급(회귀 0).
      const captureEndpointCall = (p) => {
        const ts = Number(p && p.ts) || Date.now();
        const phase = (p && p.phase) || "done";
        const callId = (p && p.callId) || null;

        // 완료 — 진행 중이던 같은 호출을 **제자리에서** 갱신(새 항목 만들지 않는다).
        if (phase === "done" && callId !== null) {
          const prev = endpointLog.find((d) => d.callId === callId);
          if (prev) {
            prev.pending = false;
            prev.ok = (p && p.ok) !== false;
            prev.response = String((p && p.response) || "");
            prev.durationMs = Number(p && p.durationMs) || (ts - prev.ts);
            renderEndpointsView();
            return;
          }
        }
        if (epSeenTs.has(ts)) return;
        epSeenTs.add(ts);
        endpointLog.push({
          ts, callId,
          pending: phase === "start",
          name: String((p && p.name) || "endpoint"),
          ok: (p && p.ok) !== false,
          request: String((p && p.request) || ""),
          response: String((p && p.response) || ""),
          durationMs: Number(p && p.durationMs) || 0,
        });
        endpointLog.sort((x, y) => x.ts - y.ts);
        if (endpointLog.length > EP_MAX) { for (const d of endpointLog.splice(0, endpointLog.length - EP_MAX)) epOpen.delete(d.ts); }
        if (epAutoOpenTs !== null) epOpen.delete(epAutoOpenTs); // 직전 자동 펼침만 접는다.
        epOpen.add(ts); epAutoOpenTs = ts;                       // 최신 호출 1건만 기본 펼침.
        updateEndpointBadge();
        renderEndpointsView(); // currentView!=endpoints 면 no-op.
      };
      // nav 배지 = 진행 중이 있으면 그 수를 강조(없으면 총 건수). 화면 밖에서도 "지금 돌고
      // 있다" 를 알 수 있어야 한다 — 이게 없어서 사용자가 멈춘 걸로 오해했다.
      const updateEndpointBadge = () => {
        const b = document.getElementById("nav-endpoint-count"); if (!b) return;
        const running = endpointLog.filter((d) => d.pending).length;
        b.textContent = running > 0 ? `⏳${running}` : String(endpointLog.length);
        b.classList.toggle("ep-running", running > 0);
      };
      // 경과시간 포맷은 background-drawer.js 의 `fmtElapsed` 를 그대로 쓴다 — 대시보드 js 는
      // **한 스코프를 공유**하므로 재선언하면 SyntaxError 로 이 파일 전체가 죽는다(실제로 당함:
      // "showEndpoints is not defined" → 엔드포인트 뷰 전멸). 잡 카드와 표기도 통일된다.
      // 진행 중 항목의 경과시간을 1초마다 갱신(전체 재렌더 없이 텍스트만 — 무거운 DOM 재구성 X).
      setInterval(() => {
        if (!endpointLog.some((d) => d.pending)) return;
        updateEndpointBadge();
        document.querySelectorAll("#detail-panel .ep-item.ep-pending .ep-item-elapsed").forEach((el) => {
          const t0 = Number(el.dataset.ts) || Date.now();
          el.textContent = fmtElapsed(Date.now() - t0);
        });
      }, 1000);
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
            // 상태 3종: ⏳ 진행 중(경과시간 실시간) → ✅ 완료 / ⚠ 실패(소요시간).
            const state = e.pending ? " ep-pending" : e.ok ? " ep-out" : " ep-err";
            const row = document.createElement("div"); row.className = "ep-item" + state + (open ? " open" : "");
            const h = document.createElement("div"); h.className = "ep-item-head";
            const car = document.createElement("span"); car.className = "ep-caret"; car.textContent = "▶";
            const st = document.createElement("span"); st.className = "ep-item-state";
            st.textContent = e.pending ? "⏳ 진행 중" : e.ok ? "✅ 완료" : "⚠ 실패";
            const nm = document.createElement("span"); nm.className = "ep-item-name"; nm.textContent = e.name;
            const tm = document.createElement("span"); tm.className = "ep-item-time"; tm.textContent = fmtTime(e.ts);
            h.appendChild(car); h.appendChild(st); h.appendChild(nm);
            if (e.pending) { // 살아 있다는 신호 — 1초마다 갱신(전체 재렌더 없이 텍스트만).
              const el = document.createElement("span"); el.className = "ep-item-elapsed";
              el.dataset.ts = String(e.ts); el.textContent = fmtElapsed(Date.now() - e.ts);
              h.appendChild(el);
            } else if (e.durationMs > 0) {
              const dur = document.createElement("span"); dur.className = "ep-item-elapsed";
              dur.textContent = fmtElapsed(e.durationMs);
              h.appendChild(dur);
            }
            const sz = (e.request || "").length + (e.response || "").length;
            if (sz > 2000) { // 큰 항목은 접힌 상태에서도 무게를 알 수 있게(펼치기 전 예고).
              const szEl = document.createElement("span"); szEl.className = "ep-item-size";
              szEl.textContent = `${Math.round(sz / 1000)}KB`;
              h.appendChild(szEl);
            }
            h.appendChild(tm);
            const detail = document.createElement("div"); detail.className = "ep-item-detail";
            // ★lazy — 본문 DOM 은 **펼칠 때** 만든다. 접힌 항목은 CSS 로 숨겨도 텍스트 노드가
            //   DOM 에 남아 레이아웃 비용을 그대로 낸다(멈춤의 실제 원인). 접혀 있으면 아예 없다.
            const fillDetail = () => {
              if (detail.dataset.filled === "1") return;
              detail.dataset.filled = "1";
              detail.appendChild(buildEpSection("요청", e.request));
              // 진행 중이면 응답이 아직 없다 — "(없음)" 은 실패로 읽히므로 상태를 그대로 쓴다.
              detail.appendChild(
                e.pending
                  ? buildEpSection("응답", "아직 처리 중입니다 — 완료되면 여기에 표시됩니다.")
                  : buildEpSection("응답", e.response),
              );
            };
            if (open) fillDetail();
            h.addEventListener("click", () => {
              const nowOpen = row.classList.toggle("open");
              if (nowOpen) { fillDetail(); epOpen.add(e.ts); } else epOpen.delete(e.ts);
            });
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
          head.className = "bubble-meta"; // 이력 버블과 같은 간격(새로고침 전후 동일해야 함).
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
        // ★시스템 통지 구분 (2026-07-27) — 스케줄 실패·자가 점검·작업 멈춤 같은 인프라 통지가
        //  비서 발화와 **같은 말풍선**으로 들어와 "내가 뭘 물어본 것도 아닌데 답장이 온" 것처럼
        //  보였다(사용자 신고). 통지를 없애면 관측을 잃으니, 없애는 대신 *모양을 나눈다*.
        //  발신부(deliverOutbound notice:true)가 의도를 표시하고 여기서 렌더만 분기한다.
        const isNotice = isOut && payload.notice === true;
        div.className = isNotice ? "ev local channel-chat sys-notice" : "ev local channel-chat";
        div.dataset.type = (ev.type || "").toLowerCase();
        if (ev.ts != null) div.dataset.ts = String(ev.ts); // prune 후 커서 복구용 수치 ts.
        const head = document.createElement("div");
        head.className = "bubble-meta"; // 채팅 버블 메타 줄 간격(생성 지점 4곳 공통).
        const tsEl = document.createElement("span");
        tsEl.className = "ts";
        tsEl.textContent = ts;
        const tyEl = document.createElement("span");
        tyEl.className = "type";
        tyEl.textContent = isNotice ? "시스템 알림" : (isOut ? assistantName : "나");
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

