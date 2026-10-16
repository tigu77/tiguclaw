      // ── 스텝 마스터 데이터 ─────────────────────────────────────────────
      // llm.activity 전체 payload 를 "threadKey␟seq" 키로 저장 — 도구 스텝 인라인 상세가 조회한다.
      //  (옛 우측 상세 사이드바는 인라인 상세로 대체돼 지웠다 — virtualization.js)
      const activityByStep = new Map();
      const stepKey = (thread, seq) => (thread ?? "?") + "␟" + (seq == null ? "" : String(seq));
