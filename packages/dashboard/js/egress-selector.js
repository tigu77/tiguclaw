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
      const egressBoxEl = document.getElementById("chat-egress");
      const EGRESS_LABELS = { telegram: "텔레그램", cli: "CLI", slack: "슬랙", discord: "디스코드" };
      const egressLabel = (name) => EGRESS_LABELS[name] || name;
      // 전송 시 reply.js 가 호출 — 체크된 채널 배열(빈 배열 = fan-out 없음 = 현행).
      const getEgressChannels = () => [...egressChecked];
      const syncEgressStyle = () => {
        if (!egressBoxEl) return;
        egressBoxEl.classList.toggle("active", egressChecked.size > 0);
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
          egressChecked.clear();
          return;
        }
        // 사라진 후보의 체크 상태 정리(재채움 시 stale 제거).
        const names = new Set(candidates.map((c) => c.name));
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
            syncEgressStyle();
          });
          const span = document.createElement("span");
          span.textContent = egressLabel(c.name);
          lbl.appendChild(cb);
          lbl.appendChild(span);
          egressBoxEl.appendChild(lbl);
        }
        egressBoxEl.hidden = false;
        syncEgressStyle();
      };
      // 초기 채움(비차단·best-effort). 채널 집합은 부팅 고정(런타임 추가 = 재시작 경로)이라
      // 1회 채움으로 충분. 실패 = 컨테이너 숨김(무회귀).
      void populateEgressChannels();
