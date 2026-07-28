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

      // ── 이력 로드 창 보호 (2026-07-28) ───────────────────────────────────
      // 탭 전환·초기 로드는 스트림을 비우고(resetStreamState) 이력 fetch 를 await 한다.
      // 그 창에 도착한 메시지는 **리스트가 비어 있어** vtIsStaleForAppend 의 가드가 꺼지고
      // (`newest > 0` 이 거짓) 무조건 바닥에 붙는다. 이어서 이력이 그 위로 prepend 되면
      // 옛 메시지가 최신 대화 사이에 끼어 "모델이 갑자기 딴소리" 처럼 보인다.
      //   실측(회사 인스턴스): 오늘 11:24:20 · 11:24:50 사이에 어제 18:59:15 · 18:55:30 이
      //   **도착 순서 그대로(=시간 역순)** 끼고 그 아래 11:26:42 가 붙었다.
      // → 창 동안 보류했다가 이력 렌더 후 **시간순으로** 흘린다. 그때는 리스트가 차 있으니
      //   기존 가드가 제 판정을 한다(가드를 약화시키지 않고 그 전제를 지켜 주는 방식).
      let historyLoadDepth = 0;
      const heldSseEvents = [];
      const HELD_SSE_CAP = 200; // 폭주 방어 — 넘으면 오래된 것부터 버린다(원본은 chat_log 보존).
      const beginHistoryLoad = () => { historyLoadDepth += 1; };
      /** 보류분을 시간순으로 흘린다. 로드가 실패해도 반드시 불러야 한다(finally). */
      const endHistoryLoad = () => {
        historyLoadDepth = Math.max(0, historyLoadDepth - 1);
        if (historyLoadDepth > 0) return; // 중첩 로드 — 가장 바깥에서만 흘린다.
        if (heldSseEvents.length === 0) return;
        const q = heldSseEvents.splice(0, heldSseEvents.length);
        q.sort((a, b) => (a && a.ts ? a.ts : 0) - (b && b.ts ? b.ts : 0)); // 도착순 아님, 시간순.
        for (const e of q) { try { renderEvent(e); } catch { /* 한 건 실패가 나머지를 막지 않음 */ } }
      };
      /** 이력 로드 중이면 붙잡는다(true = 호출자는 지금 렌더하지 않는다). */
      const holdSseEventDuringHistory = (ev) => {
        if (historyLoadDepth <= 0) return false;
        heldSseEvents.push(ev);
        if (heldSseEvents.length > HELD_SSE_CAP) heldSseEvents.shift();
        return true;
      };

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

