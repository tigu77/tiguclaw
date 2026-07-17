      // ── 채널 뷰(왼쪽 nav 1급 destination — 읽기전용) ──────────────────────────
      // ADR 2026-07-16 §D4 Phase A. GET /api/channels → 라이브 채널 presence(name·kind·status).
      // 진실원 = index.ts 가 부팅 때 실제 로드·시작한 산 channels[](channel-registry.ts). 정적
      // 파일 walk 아님. 순수 가시성 — outbound 라우팅 무관(능력 플래그는 Phase B1 몫). 프로젝트
      // 뷰 동형 렌더(setActiveNav·detail-panel·카드 그리드). 새 프레임워크 0.
      const CHANNEL_STATUS_LABEL = { up: "작동 중", disabled: "꺼짐" };
      let channelsCache = [];

      const showChannels = () => {
        setActiveNav("channels");
        setChatPanel("chat");
        document.getElementById("workbench").classList.remove("show-providers");
        document.getElementById("workbench").classList.remove("show-capabilities");
        const root = document.getElementById("detail-panel");
        root.innerHTML = "";
        const wrap = document.createElement("div");
        wrap.className = "page-view channels-view";
        wrap.innerHTML =
          '<div class="detail-head"><div class="detail-accent active"></div><div class="detail-name">채널</div><span class="detail-kind">레지스트리</span></div>' +
          '<p class="developer-copy">데몬이 지금 갖고 있는 채널(CLI·텔레그램·대시보드 등)을 봅니다. 여러 채널이 한 명의 비서로 모입니다. 읽기 전용입니다.</p>' +
          '<div class="channels-grid" id="channels-grid"><div class="empty">불러오는 중…</div></div>';
        root.appendChild(wrap);
        renderChannelsGrid();
        fetchChannels();
      };

      const fetchChannels = async () => {
        try {
          const r = await fetch("/api/channels");
          const data = await r.json();
          channelsCache = data && Array.isArray(data.channels) ? data.channels : [];
        } catch (e) {
          channelsCache = [];
        }
        const nav = document.getElementById("nav-channel-count");
        if (nav) nav.textContent = String(channelsCache.length);
        if (currentView === "channels") renderChannelsGrid();
      };

      const renderChannelsGrid = () => {
        const grid = document.getElementById("channels-grid");
        if (!grid) return;
        grid.innerHTML = "";
        if (channelsCache.length === 0) {
          grid.innerHTML = '<div class="empty">채널이 없습니다.</div>';
          return;
        }
        for (const c of channelsCache) {
          const status = c.status === "disabled" ? "disabled" : "up";
          const card = document.createElement("div");
          card.className = "channel-card s-" + status;
          const head = document.createElement("div");
          head.className = "channel-card-head";
          const name = document.createElement("span");
          name.className = "channel-card-name";
          name.textContent = c.name || "(이름 없음)";
          head.appendChild(name);
          const st = document.createElement("span");
          st.className = "channel-status " + status;
          st.textContent = CHANNEL_STATUS_LABEL[status] || status;
          head.appendChild(st);
          const kind = document.createElement("div");
          kind.className = "channel-card-kind";
          kind.textContent = c.kind || c.name || "";
          card.appendChild(head);
          card.appendChild(kind);
          grid.appendChild(card);
        }
      };
