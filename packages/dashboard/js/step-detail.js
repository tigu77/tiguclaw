      // ── P4 축3 — 스텝 클릭 → 상세 사이드바(마스터-디테일) ─────────────────
      // 마스터 데이터: llm.activity 전체 payload 를 "threadKey␟seq" 키로 저장.
      // 스텝 클릭 시 data-threadkey/data-seq 로 이 맵을 조회해 우측 사이드바에 상세 표시.
      const activityByStep = new Map();
      const stepKey = (thread, seq) => (thread ?? "?") + "␟" + (seq == null ? "" : String(seq));
      let selectedStepEl = null;

      const closeStepDetail = () => {
        document.body.classList.remove("step-detail-open");
        if (selectedStepEl) { selectedStepEl.classList.remove("selected"); selectedStepEl = null; }
        const sd = document.getElementById("step-detail");
        if (sd) sd.setAttribute("aria-hidden", "true");
      };

      // 상세 1행 추가(키/값). value 는 항상 textContent → XSS 0(detail 은 비서·도구 유래).
      const sdRow = (body, k, v) => {
        const row = document.createElement("div");
        row.className = "sd-row";
        const ke = document.createElement("span"); ke.className = "sd-k"; ke.textContent = k;
        const ve = document.createElement("span"); ve.className = "sd-v"; ve.textContent = v;
        row.appendChild(ke); row.appendChild(ve);
        body.appendChild(row);
      };

      const openStepDetail = (p, lineEl) => {
        const body = document.getElementById("sd-body");
        if (!body) return;
        body.textContent = "";
        sdRow(body, "label", p.label || p.kind || "activity");
        sdRow(body, "kind", p.kind || "—");
        sdRow(body, "adapter", p.adapter || "—");
        if (p.model) sdRow(body, "model", p.model);
        sdRow(body, "seq", p.seq == null ? "—" : String(p.seq));
        // detail = 중립 상세 요약(file_path=… / command=…). 여러 줄 가능 → pre-wrap.
        const dRow = document.createElement("div");
        dRow.className = "sd-row";
        const dk = document.createElement("span"); dk.className = "sd-k"; dk.textContent = "detail";
        const dv = document.createElement("div");
        if (p.detail != null && String(p.detail).trim() !== "") {
          dv.className = "sd-detail";
          dv.textContent = String(p.detail); // ← textContent: XSS 0(마크다운 렌더 불요).
        } else {
          dv.className = "sd-detail empty";
          dv.textContent = i18n("step.detail.none");
        }
        dRow.appendChild(dk); dRow.appendChild(dv);
        body.appendChild(dRow);

        // 선택 하이라이트 전환.
        if (selectedStepEl && selectedStepEl !== lineEl) selectedStepEl.classList.remove("selected");
        selectedStepEl = lineEl;
        lineEl.classList.add("selected");
        document.body.classList.add("step-detail-open");
        const sd = document.getElementById("step-detail");
        if (sd) sd.setAttribute("aria-hidden", "false");
      };

      // 사이드바 닫기(버튼 + Esc). 정의 직후 바인딩 — TDZ 회피.
      const sdCloseBtn = document.getElementById("sd-close");
      if (sdCloseBtn) sdCloseBtn.addEventListener("click", closeStepDetail);
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && document.body.classList.contains("step-detail-open")) closeStepDetail();
      });

