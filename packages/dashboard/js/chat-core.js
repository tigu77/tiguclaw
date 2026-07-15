      const typeClass = (type) => {
        if (type === "plugin.error" || type.endsWith(".error")) return "t-error";
        if (type.startsWith("channel.message")) return "t-channel";
        if (type.startsWith("region.")) return "t-region";
        if (type.startsWith("memory.")) return "t-memory";
        if (type.startsWith("scheduler.")) return "t-sched";
        return "t-other";
      };

      const stream = document.getElementById("stream");
      const evCountEl = document.getElementById("ev-count");
      const filterEl = document.getElementById("ev-filter");
      const setChatPanel = (panel) => {
        document.body.dataset.chatPanel = panel;
        for (const btn of document.querySelectorAll(".chat-tab")) {
          btn.classList.toggle("active", btn.dataset.chatPanelTarget === panel);
        }
      };
      for (const btn of document.querySelectorAll(".chat-tab")) {
        btn.addEventListener("click", () => setChatPanel(btn.dataset.chatPanelTarget || "chat"));
      }
      let firstEvent = true;
      let evCount = 0;
      let localChatCount = 0;
      let filterText = "";

      // ── 대화 이력 dedup (기능 B) ─────────────────────────────────────────
      // /api/chat-history 로 그린 과거 메시지와 SSE history replay(최근 50) 가 겹친다.
      // 쓰기 훅이 event.ts 를 그대로 chat_log 에 기록하므로, "ts|role" 키로 이미 렌더된
      // 메시지를 추적해 SSE 의 channel.message.in/out 이 같은 키면 스킵한다(안정 dedup).
      const renderedMsgKeys = new Set();
      const msgKey = (ts, role) => String(ts) + "|" + role;
      // 도구 스텝 dedup(기능 B) — chat-history 로 그린 영속 스텝과 SSE replay(같은 활동) 가
      // 겹치지 않게. 키 = ts|threadKey|seq (라이브 activity·영속 activity 동일).
      const renderedActivityKeys = new Set();
      const actKey = (ts, threadKey, seq) => String(ts) + "|" + (threadKey || "") + "|" + (seq == null ? "" : seq);

      const refreshChatEmpty = () => {
        const chatEmpty = document.getElementById("chat-empty");
        if (chatEmpty) chatEmpty.style.display = localChatCount === 0 ? "" : "none";
      };

      filterEl.addEventListener("input", () => {
        filterText = filterEl.value.trim().toLowerCase();
        // 일반 이벤트(알 수 없는 유형)는 로그 싱크(데드 로그 패널용·채팅선 숨김)에 쌓인다.
        for (const child of logSink.children) {
          const t = child.dataset.type || "";
          child.style.display =
            filterText === "" || t.includes(filterText) ? "" : "none";
        }
      });

      const ADAPTERS = ["claude", "codex", "openai"];
      const cardByThread = new Map();

