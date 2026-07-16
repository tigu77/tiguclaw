      // ── 컴포저 egress 채널 셀렉터(ADR 2026-07-16 §D4 Phase B2) ──────────────────
      // "이 턴의 응답을 어느 채널로 보낼지"를 컴포저에서 고른다. 기본 = 세션(현재 대시보드,
      // override 안 함). telegram 등 outbound-capable(hasDefaultTarget) 채널을 고르면 그 턴의
      // POST /api/messages body 에 outboundChannel 을 실어 보내 응답 egress 를 그 채널로 스왑
      // (백엔드 handler 가 deliverOutbound 로 배달). 후보 = /api/channels 의 hasDefaultTarget
      // 채널만(U3 — egress 좌표 아는 채널). 없으면 셀렉터를 숨긴다(무회귀·채널 없는 환경).
      //
      // 공유 상태 egressChannel("" = override 없음) — sendChatMessage(reply.js)가 전송 시 읽는다.
      // §0/채널레이어: 채널명→라벨은 대시보드 UI 컨벤션(generic 폴백 유지, channel-hints 동형).
      let egressChannel = ""; // "" = 세션 기본(인입 채널로 응답, override 없음).
      const egressSelEl = document.getElementById("chat-egress");
      const EGRESS_LABELS = { telegram: "텔레그램", cli: "CLI" };
      const egressLabel = (name) => EGRESS_LABELS[name] || name;
      const syncEgressStyle = () => {
        if (!egressSelEl) return;
        // override 중이면 강조(사용자가 "다른 채널로 응답"을 의식하게).
        egressSelEl.classList.toggle("override", egressChannel !== "");
      };
      const populateEgressSelector = async () => {
        if (!egressSelEl) return;
        let channels = [];
        try {
          const r = await fetch("/api/channels");
          const data = await r.json().catch(() => ({}));
          channels = Array.isArray(data && data.channels) ? data.channels : [];
        } catch { channels = []; }
        // 후보 = hasDefaultTarget(egress 좌표 아는 채널)만. status==="up" 만(disabled 제외 —
        // 토큰 부재 텔레그램 등은 실제로 못 보냄). 대시보드 자기 채널은 hasDefaultTarget=false 라
        // 자연 제외 = "세션(여기)" 기본 옵션이 그 역할.
        const candidates = channels.filter(
          (c) => c && c.hasDefaultTarget === true && c.status === "up",
        );
        if (candidates.length === 0) {
          egressSelEl.hidden = true;
          egressChannel = "";
          return;
        }
        const prev = egressChannel;
        egressSelEl.innerHTML = "";
        const optDefault = document.createElement("option");
        optDefault.value = "";
        optDefault.textContent = "📤 여기(세션)";
        egressSelEl.appendChild(optDefault);
        for (const c of candidates) {
          const opt = document.createElement("option");
          opt.value = c.name;
          opt.textContent = "📤 " + egressLabel(c.name);
          egressSelEl.appendChild(opt);
        }
        // 이전 선택이 아직 후보에 있으면 보존, 아니면 기본(세션)으로.
        egressChannel = candidates.some((c) => c.name === prev) ? prev : "";
        egressSelEl.value = egressChannel;
        egressSelEl.hidden = false;
        syncEgressStyle();
      };
      if (egressSelEl) {
        egressSelEl.addEventListener("change", () => {
          egressChannel = egressSelEl.value || "";
          syncEgressStyle();
        });
      }
      // 초기 채움(비차단·best-effort). SSE 로 채널 up/down 이 바뀌어도 여기선 1회 채움으로 충분
      // (채널 집합은 부팅 고정 — 런타임 추가는 재시작 경로). 실패 = 셀렉터 숨김(무회귀).
      void populateEgressSelector();
