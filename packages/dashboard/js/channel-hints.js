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
      // 외부 호출 스레드(엔드포인트·게이트웨이) — 채팅이 아니라 "외부 호출" 뷰 소관이다.
      // ★게이트웨이 추가 (2026-08-12): 이제 게이트웨이 턴도 transcripts 에 남으므로,
      //  이 필터가 없으면 앱 요청이 대화 이력에 섞여 보인다.
      const isEndpointThread = (tk) =>
        typeof tk === "string" && (tk.indexOf("endpoint:") === 0 || tk.indexOf("gateway:") === 0);
      // ── 채널 힌트(ADR 2026-07-15 §D6) — 메시지/세션이 어느 전송로에서 들어왔나. 세션은
      //    채널 무관이라(텔레그램도 기본 세션에 합류) "텔레그램 경유"를 가시화한다. 대시보드
      //    자기 채널(http-bridge/dashboard)은 자명하므로 배지 없음. §0 단방향: 코어 아닌
      //    대시보드/채널 레이어의 UI 컨벤션이라 채널명→라벨 매핑 허용(generic 폴백 유지).
      const CHANNEL_LABELS = { telegram: { short: "TG", full: i18n("common.channel.telegram") }, cli: { short: "CLI", full: "CLI" } };
      const OWN_CHANNELS = new Set(["http-bridge", "dashboard"]);
      // ★배지는 **실재하는 채널**에만 단다 (2026-08-03 사용자 제보).
      //  종전엔 `xxx:` 접두면 무엇이든 채널로 보고 `앞 6글자 대문자` 배지를 만들었다.
      //  그래서 검증 스크립트가 남긴 `verify:…` 스레드가 탭에 **VERIFY** 배지를 달고
      //  툴팁까지 "verify 세션" 이라고 말했다 — **없는 사실을 자신 있게 표시**한 것이다.
      //  정본은 서버 `/api/channels`(살아 있는 채널 presence). 손으로 유지하는 목록이
      //  아니라 실제 목록이므로 새 채널(slack 등)이 붙으면 저절로 배지가 생긴다.
      //  초기값은 보수적으로 라벨을 가진 둘만 — 목록이 오기 전에 가짜 배지가 뜨지 않게.
      let knownChannels = new Set(Object.keys(CHANNEL_LABELS));
      const loadKnownChannels = async () => {
        try {
          const r = await fetch("/api/channels");
          if (!r.ok) return;
          const d = await r.json();
          const names = (Array.isArray(d.channels) ? d.channels : [])
            .map((c) => (c && typeof c.name === "string" ? c.name : null))
            .filter((n) => n !== null && !OWN_CHANNELS.has(n));
          // 빈 응답으로 목록을 비우지 않는다(부팅 순간·실패를 "채널 없음" 으로 오독 금지).
          if (names.length === 0) return;
          const before = [...knownChannels].sort().join(",");
          knownChannels = new Set(names);
          // 목록이 달라졌으면 이미 그려진 배지를 다시 판정한다(늦게 온 진짜 채널 반영).
          // 모듈들은 스코프를 공유한다(tabs.js 가 여기 channelMeta 를 그냥 부르는 것과 같은
          // 관행). 이 콜백은 tabs.js 가 실행된 뒤에 돌므로 참조가 안전하고, 실패해도 아래
          // catch 가 받는다 — 배지 재판정 실패가 화면을 막지 않는다.
          if (before !== names.slice().sort().join(",")) renderTabBar();
        } catch (e) {
          console.warn("채널 목록 로드 실패 — 배지는 알려진 채널만:", e && e.message ? e.message : e);
        }
      };
      void loadKnownChannels();
      const channelMeta = (ch) => {
        if (!ch || typeof ch !== "string" || OWN_CHANNELS.has(ch)) return null;
        // ★없는 채널을 지어내지 않는다. 키 접두는 채널이 아니다.
        if (!knownChannels.has(ch)) return null;
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
        b.className = "ch-badge"; b.textContent = m.short; b.title = i18n("ch.via", { name: m.full });
        return b;
      };
      // ★수명주기 (2026-07-26) — 서버가 요청 접수 시 phase:"start", 끝나면 phase:"done" 을
      //   **같은 callId** 로 보낸다. 종전엔 완료 이벤트 하나뿐이라 20초~5분 도는 동안 화면에
      //   아무것도 없었다("멈춘 것처럼 보인다" — 실제 엔드포인트가 20초+ 걸림).
      //   start 를 못 받은 옛 이벤트(callId 없음)는 그대로 완료 1건으로 취급(회귀 0).
      let epFilter = "all"; // 뷰 필터(전체/엔드포인트/게이트웨이) — 화면 상태라 메모리로 충분.
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
            prev.durationMs =
              Number(p && p.durationMs) || Number(p && p.elapsedMs) || (ts - prev.ts);
            if (p && p.inputTokens != null) prev.inputTokens = Number(p.inputTokens) || 0;
            if (p && p.outputTokens != null) prev.outputTokens = Number(p.outputTokens) || 0;
            if (p && p.toolCalls != null) prev.toolCalls = Number(p.toolCalls) || 0;
            if (p && p.servedBy) prev.servedBy = String(p.servedBy);
            if (p && p.stream != null) prev.stream = p.stream === true;
            if (p && p.messages != null) prev.messages = Number(p.messages) || 0;
            if (p && p.error) prev.error = String(p.error);
            renderEndpointsView();
            return;
          }
        }
        if (epSeenTs.has(ts)) return;
        epSeenTs.add(ts);
        // ★게이트웨이 호출도 같은 목록에 담는다 (2026-08-10). 둘 다 "외부가 나를 호출한
        //  기록" 이라 사용자가 던지는 질문이 같다 — 화면을 둘로 나눌 이유가 없다.
        //  게이트웨이는 본문을 안 남기고(외부 앱 데이터) **회계·건강 축**만 온다.
        const kind = (p && p.kind) === "gateway" ? "gateway" : "endpoint";
        endpointLog.push({
          ts, callId, kind,
          pending: phase === "start",
          name: kind === "gateway"
            ? String((p && p.model) || i18n("ch.default"))
            : String((p && p.name) || "endpoint"),
          ok: (p && p.ok) !== false,
          request: String((p && p.request) || ""),
          response: String((p && p.response) || ""),
          durationMs: Number(p && p.durationMs) || Number(p && p.elapsedMs) || 0,
          inputTokens: Number(p && p.inputTokens) || 0,
          outputTokens: Number(p && p.outputTokens) || 0,
          toolCalls: Number(p && p.toolCalls) || 0,
          servedBy: String((p && p.servedBy) || ""),
          error: String((p && p.error) || ""),
          // ★게이트웨이 고유 축 (2026-08-12) — 종전엔 담지도 그리지도 않아, 펼치면
          //  "요청 (없음) / 응답 (없음)" 두 칸만 나왔다("내용물이 싹 비어있네").
          //  본문을 안 남기는 건 의도(외부 앱 데이터)지만, 남기기로 한 회계·건강까지
          //  화면에서 사라진 건 의도가 아니다 — 자료는 있었고 읽는 쪽이 없었다.
          stream: (p && p.stream) === true,
          messages: Number(p && p.messages) || 0,
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
        const body = document.createElement("div"); body.className = "ep-item-body"; body.textContent = text || i18n("ch.none");
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
        head.innerHTML = '<div class="detail-accent"></div><div class="detail-name"></div><span class="detail-kind"></span>';
        head.querySelector(".detail-name").textContent = i18n("ch.page.title");
        head.querySelector(".detail-kind").textContent = i18n("ch.page.kind");
        wrap.appendChild(head);
        const desc = document.createElement("p"); desc.className = "ep-view-desc";
        desc.textContent = i18n("ch.desc");
        wrap.appendChild(desc);
        // ── 필터 (2026-08-10) — 한 페이지에서 축을 나눠 본다(사용자 결정). ──────
        const bar = document.createElement("div"); bar.className = "ep-filter-bar";
        const counts = {
          all: endpointLog.length,
          endpoint: endpointLog.filter((d) => d.kind !== "gateway").length,
          gateway: endpointLog.filter((d) => d.kind === "gateway").length,
        };
        for (const [key, label] of [["all",i18n("ch.metric.total")],["endpoint",i18n("ch.kind.endpoint")],["gateway",i18n("ch.kind.gateway")]]) {
          const b = document.createElement("button");
          b.type = "button";
          b.className = "ep-filter" + (epFilter === key ? " active" : "");
          b.textContent = `${label} ${counts[key]}`;
          b.addEventListener("click", () => { epFilter = key; renderEndpointsView(); });
          bar.appendChild(b);
        }
        wrap.appendChild(bar);
        const shown = endpointLog.filter(
          (d) => epFilter === "all" || (epFilter === "gateway" ? d.kind === "gateway" : d.kind !== "gateway"),
        );
        if (shown.length === 0) {
          const empty = document.createElement("div"); empty.className = "ep-empty";
          empty.textContent = i18n("ch.empty");
          wrap.appendChild(empty);
        } else {
          const list = document.createElement("div"); list.className = "ep-view-list";
          for (let i = shown.length - 1; i >= 0; i--) { // 최신 먼저(필터 적용분).
            const e = shown[i];
            const open = epOpen.has(e.ts);
            // 상태 3종: ⏳ 진행 중(경과시간 실시간) → ✅ 완료 / ⚠ 실패(소요시간).
            const state = e.pending ? " ep-pending" : e.ok ? " ep-out" : " ep-err";
            const row = document.createElement("div"); row.className = "ep-item" + state + (open ? " open" : "");
            const h = document.createElement("div"); h.className = "ep-item-head";
            const car = document.createElement("span"); car.className = "ep-caret"; car.textContent = "▶";
            const st = document.createElement("span"); st.className = "ep-item-state";
            st.textContent = e.pending ? i18n("ch.status.running") : e.ok ? i18n("common.status.done") : i18n("ch.status.failed");
            const kb = document.createElement("span");
            kb.className = "ep-kind " + (e.kind === "gateway" ? "ep-kind-gw" : "ep-kind-ep");
            kb.textContent = e.kind === "gateway" ? "GW" : "EP";
            const nm = document.createElement("span"); nm.className = "ep-item-name"; nm.textContent = e.name;
            const tm = document.createElement("span"); tm.className = "ep-item-time"; tm.textContent = fmtTime(e.ts);
            h.appendChild(car); h.appendChild(st); h.appendChild(kb); h.appendChild(nm);
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
              // ★게이트웨이는 축이 다르다 — 본문 대신 회계·건강을 그린다 (2026-08-12).
              //  요청/응답 두 칸만 그리면 "(없음)(없음)" 이라 아무것도 없는 것처럼 보인다.
              if (e.kind === "gateway") {
                const rows = [
                  [i18n("ch.metric.reqModel"), e.name || i18n("ch.default")],
                  [i18n("ch.metric.handled"), e.servedBy || i18n("ch.unrecorded")],
                  [i18n("ch.metric.tokens"), i18n("ch.tokens.inOut", { in: (e.inputTokens || 0).toLocaleString(), out: (e.outputTokens || 0).toLocaleString() })],
                  [i18n("ch.metric.toolCalls"), String(e.toolCalls || 0)],
                  [i18n("common.message"), i18n("ch.msgCount", { n: e.messages || 0, stream: e.stream ? i18n("ch.streaming") : "" })],
                  [i18n("ch.metric.elapsed"), e.durationMs > 0 ? fmtElapsed(e.durationMs) : i18n("ch.inProgress")],
                ];
                if (e.error) rows.push([i18n("common.error"), e.error]);
                detail.appendChild(buildEpSection(i18n("ch.metric.accounting"), rows.map(([k, v]) => `${k}: ${v}`).join("\n")));
                // ★본문도 보여준다 (2026-08-12, 사용자 결정) — 무슨 요청이 오갔는지가 이
                //  기록의 목적이다. 게이트웨이 턴은 transcripts 에 안 남으므로(internal)
                //  여기가 유일한 기록이고, 길면 앞부분 + 잘린 사실이 본문에 명시돼 온다.
                detail.appendChild(buildEpSection(i18n("ch.metric.request"), e.request));
                detail.appendChild(
                  e.pending
                    ? buildEpSection(i18n("ch.metric.response"), i18n("ch.pending"))
                    : buildEpSection(i18n("ch.metric.response"), e.response),
                );
                return;
              }
              detail.appendChild(buildEpSection(i18n("ch.metric.request"), e.request));
              // 진행 중이면 응답이 아직 없다 — "(없음)" 은 실패로 읽히므로 상태를 그대로 쓴다.
              detail.appendChild(
                e.pending
                  ? buildEpSection(i18n("ch.metric.response"), i18n("ch.pending"))
                  : buildEpSection(i18n("ch.metric.response"), e.response),
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
      // ★열 때 서버 이력을 채운다 (2026-08-01) — 종전엔 라이브 SSE 로만 쌓아서
      //  **새로고침·데몬 재시작이면 전멸**했다(사용자 신고: "엔드포인트 기록들이 다 사라졌어").
      //  자료는 서버에 있었는데 읽는 쪽이 없었다. 채팅의 /chat-history 와 같은 자리.
      let epHistoryLoaded = false;
      const loadEndpointHistory = async () => {
        if (epHistoryLoaded) return;
        epHistoryLoaded = true;
        try {
          const r = await fetch("/api/endpoint-calls?limit=60");
          const d = await r.json();
          for (const c of (d && d.calls) || []) captureEndpointCall(c);
          renderEndpointsView();
        } catch {
          epHistoryLoaded = false; // 실패하면 다음에 다시 시도(한 번 실패로 영구 빈 화면 금지).
        }
      };

      const showEndpoints = () => {
        setActiveNav("endpoints");
        loadEndpointHistory();
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
          if (card && !card.interrupted && card.sawTextSegment && vtIndex.has(card.group)) {
            if (card.replyMsg) card.replyMsg.classList.remove("streaming"); // 혹시 남은 커서 정리.
            card.replyBubble = null; card.replyMsg = null; card.replyRaw = "";
            completeTurnGroup(thread);
            localChatCount += 1;
            refreshChatEmpty();
            if (currentView === "overview") setTimeout(showOverview, 0);
            scheduleRelayout();
            return;
          }
          if (card && !card.interrupted && card.replyBubble && vtIndex.has(card.group)) {
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
        tyEl.textContent = isNotice ? i18n("common.systemNotice") : (isOut ? assistantName : i18n("common.sender.me"));
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
        // ★사용자 메시지가 진행 중 턴에 끼어들면 그 자리에서 그룹을 닫는다 (2026-08-12).
        //  안 닫으면 이후 답변이 **이 메시지보다 위**(턴 시작 때 잡힌 자리)에 그려진다.
        if (!isOut) interruptOpenTurn(thread);
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

