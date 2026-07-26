      // ── 컴포저 egress fan-out 체크박스(ADR 2026-07-16 §D4 Phase B2) ─────────────
      // "이 답을 인입 채널(지금 보는 곳)엔 항상 보내고, 체크한 추가 채널들에도 함께 보낸다"
      // (fan-out, swap 아님). 후보 = /api/channels 의 outbound-capable(hasDefaultTarget &&
      // status==="up") 채널 — 인입/세션 채널(대시보드 자기 채널)은 항상 가므로 후보에서 제외
      // (hasDefaultTarget=false 라 자연 제외되기도 함). 아무것도 체크 안 하면 현행(인입만, 회귀 0).
      // 체크된 채널 배열을 sendChatMessage(reply.js)가 outboundChannels 로 실어 보낸다.
      //
      // 공유 상태 egressChecked(체크된 채널명 Set) — 전송 시 배열로 읽힌다.
      // §0/채널레이어: 채널명→라벨은 대시보드 UI 컨벤션(generic 폴백, channel-hints 동형).
      const egressChecked = new Set(); // 체크된 추가 발신 채널명.
      // ★영속 (2026-07-26) — 종전엔 메모리에만 있어 새로고침·데몬 재시작마다 꺼졌다("재시작하면
      //   꺼지는거같더라고"). 열린 탭 목록과 같은 부류의 **클라이언트 UI 선호**라 localStorage.
      //   서버에 안 두는 이유: 기기·브라우저마다 다를 수 있고, 발신 좌표가 아니라 화면 설정이다.
      const EGRESS_LS = "dash.egressChannels.v1";
      const loadEgressSaved = () => {
        try {
          const a = JSON.parse(localStorage.getItem(EGRESS_LS) || "[]");
          return new Set(Array.isArray(a) ? a.filter((x) => typeof x === "string") : []);
        } catch { return new Set(); } // 프라이빗 모드·손상 값 → 기본(꺼짐).
      };
      // ★사용자가 직접 바꿀 때만 저장한다. 후보 정리(stale prune)로는 저장하지 않는다 —
      //   텔레그램이 잠깐 down 이면 후보에서 빠지는데 그때 저장해 버리면 선택이 **영구 소실**
      //   된다(사용자는 끈 적이 없다). 저장본은 남기고 이번 세션 메모리만 정리한다.
      const saveEgressChoice = () => {
        try { localStorage.setItem(EGRESS_LS, JSON.stringify([...egressChecked])); } catch { /* quota·프라이빗 모드 */ }
      };
      const egressBoxEl = document.getElementById("chat-egress");        // 옵션 팝오버(체크박스 목록).
      const egressBtnEl = document.getElementById("chat-egress-btn");    // 📤 도구 버튼(팝오버 토글).
      const egressDotEl = document.getElementById("egress-dot");         // 체크됨 표시 점.
      const EGRESS_LABELS = { telegram: "텔레그램", cli: "CLI", slack: "슬랙", discord: "디스코드" };
      const egressLabel = (name) => EGRESS_LABELS[name] || name;
      // 전송 시 reply.js 가 호출 — 체크된 채널 배열(빈 배열 = fan-out 없음 = 현행).
      const getEgressChannels = () => [...egressChecked];
      const syncEgressStyle = () => {
        const on = egressChecked.size > 0;
        if (egressBoxEl) egressBoxEl.classList.toggle("active", on);
        if (egressBtnEl) egressBtnEl.classList.toggle("active", on); // 버튼 하이라이트(선택됨).
        if (egressDotEl) egressDotEl.hidden = !on;                   // 선택 개수 점.
      };
      const closeEgressPopover = () => {
        if (egressBoxEl) egressBoxEl.hidden = true;
        if (egressBtnEl) egressBtnEl.setAttribute("aria-expanded", "false");
      };
      const populateEgressChannels = async () => {
        if (!egressBoxEl) return;
        let channels = [];
        try {
          const r = await fetch("/api/channels");
          const data = await r.json().catch(() => ({}));
          channels = Array.isArray(data && data.channels) ? data.channels : [];
        } catch { channels = []; }
        // 후보 = hasDefaultTarget(egress 좌표 아는 채널) && up. 대시보드 자기 채널(http-bridge/
        // dashboard)은 hasDefaultTarget=false 라 자연 제외 = 인입 채널은 항상 감(체크박스 아님).
        const candidates = channels.filter(
          (c) => c && c.hasDefaultTarget === true && c.status === "up",
        );
        if (candidates.length === 0) {
          egressBoxEl.hidden = true;
          egressBoxEl.innerHTML = "";
          egressChecked.clear(); // 메모리만 — 저장본은 유지(채널이 돌아오면 복원된다).
          if (egressBtnEl) egressBtnEl.hidden = true; // 후보 없으면 버튼도 숨김.
          return;
        }
        if (egressBtnEl) egressBtnEl.hidden = false;   // 후보 있으면 도구 버튼 노출.
        // 저장된 선택 복원 — 지금 살아있는 후보에 한해서(없는 채널을 체크된 척하지 않는다).
        const names = new Set(candidates.map((c) => c.name));
        for (const n of loadEgressSaved()) if (names.has(n)) egressChecked.add(n);
        // 사라진 후보의 체크 상태 정리(재채움 시 stale 제거) — 저장본은 안 건드린다.
        for (const n of [...egressChecked]) if (!names.has(n)) egressChecked.delete(n);
        egressBoxEl.innerHTML = "";
        const lead = document.createElement("span");
        lead.className = "egress-lead";
        lead.textContent = "📤 함께:";
        egressBoxEl.appendChild(lead);
        for (const c of candidates) {
          const lbl = document.createElement("label");
          lbl.className = "egress-opt";
          lbl.title = egressLabel(c.name) + " 로도 이 답을 보냄";
          const cb = document.createElement("input");
          cb.type = "checkbox";
          cb.value = c.name;
          cb.checked = egressChecked.has(c.name);
          cb.addEventListener("change", () => {
            if (cb.checked) egressChecked.add(c.name);
            else egressChecked.delete(c.name);
            saveEgressChoice(); // 사용자 의사표시 = 저장 시점(유일).
            syncEgressStyle();
          });
          const span = document.createElement("span");
          span.textContent = egressLabel(c.name);
          lbl.appendChild(cb);
          lbl.appendChild(span);
          egressBoxEl.appendChild(lbl);
        }
        egressBoxEl.hidden = true; // 팝오버는 기본 닫힘 — 📤 버튼 클릭 시 열림.
        syncEgressStyle();
      };
      // 📤 버튼 → 팝오버 토글. 바깥 클릭·Esc 로 닫힘.
      if (egressBtnEl && egressBoxEl) {
        egressBtnEl.addEventListener("click", (e) => {
          e.stopPropagation();
          const willOpen = egressBoxEl.hidden;
          egressBoxEl.hidden = !willOpen;
          egressBtnEl.setAttribute("aria-expanded", String(willOpen));
        });
        document.addEventListener("click", (e) => {
          if (egressBoxEl.hidden) return;
          if (!egressBoxEl.contains(e.target) && e.target !== egressBtnEl) closeEgressPopover();
        });
        document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeEgressPopover(); });
      }
      // 초기 채움(비차단·best-effort). 채널 집합은 부팅 고정(런타임 추가 = 재시작 경로)이라
      // 1회 채움으로 충분. 실패 = 컨테이너 숨김(무회귀).
      void populateEgressChannels();
