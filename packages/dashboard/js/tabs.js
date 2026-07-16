      // ── 세션 이름 인라인 편집(§4 계약) ──────────────────────────────────────
      // 표시 우선순위: 서버 커스텀(tab.customName, /api/sessions 의 name) > 로컬 파생 라벨.
      // customName 은 순수 인메모리 부기(diff 용) — TABS_LS 직렬화 shape 은 불변(name 필드만 저장, §4-3).
      let editingTabKey = null; // 동시 편집 방지(단순화) — 활성 편집 threadKey.

      // 세션 파생 이름 = "세션N"(번호식). ★프리뷰·채널명("텔레그램")·"기본" 폴백은 전부 제거 —
      // 세션 배지는 세션 정체성(세션N)만, 채널(TG)은 별도 채널 배지가 뒤에 붙는다(전체활동 뷰).
      // 번호는 threadKey 첫 등장 순서로 배정해 localStorage 에 영속(get-or-assign) → 새로고침·
      // 재접속에도 안정. dashboard:default 는 항상 1(세션1)로 시드. 커스텀 이름(threads.name)이
      // 있으면 그게 우선(이 함수는 폴백일 뿐 — commitTabName·refreshSessionPreviews 의 serverName>파생 유지).
      const loadSessionNums = () => {
        try { const o = JSON.parse(localStorage.getItem(SESSION_NUM_LS) || "null"); return (o && typeof o === "object" && !Array.isArray(o)) ? o : {}; }
        catch { return {}; }
      };
      const sessionNumberFor = (tk) => {
        const map = loadSessionNums();
        let changed = false;
        if (map[DEFAULT_DASH_THREAD] == null) { map[DEFAULT_DASH_THREAD] = 1; changed = true; } // 기본 세션 = 세션1 시드.
        if (map[tk] == null) {
          let max = 0;
          for (const k in map) { const n = Number(map[k]); if (Number.isFinite(n) && n > max) max = n; }
          map[tk] = max + 1; changed = true; // 첫 등장 = 현재 최대+1.
        }
        if (changed) { try { localStorage.setItem(SESSION_NUM_LS, JSON.stringify(map)); } catch {} }
        return map[tk];
      };
      const deriveTabFallbackName = (tk) => "세션" + sessionNumberFor(tk);

      // 저장 플로우(§4-1): 낙관적 반영 → best-effort POST → 성공 시 서버 정규화값 재동기화,
      // 실패 시 로컬(낙관적) 이름을 그대로 두고 경고만(다음 refreshSessionPreviews 폴이 재조정).
      const commitTabName = async (tk, rawValue) => {
        const tab = openTabs.find((t) => t.threadKey === tk);
        if (!tab) return;
        const trimmed = String(rawValue || "").replace(/\s+/g, " ").trim();
        const nameToSend = trimmed === "" ? null : trimmed.slice(0, 60);
        tab.customName = nameToSend;
        tab.name = nameToSend || deriveTabFallbackName(tk);
        persistTabs();
        renderTabBar();
        try {
          const r = await fetch("/api/session-name", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ threadKey: tk, name: nameToSend }),
          });
          if (!r.ok) throw new Error("HTTP " + r.status);
          const data = await r.json().catch(() => ({}));
          const t2 = openTabs.find((t) => t.threadKey === tk);
          if (t2) {
            const norm = data && typeof data.name === "string" && data.name ? data.name : null;
            t2.customName = norm;
            t2.name = norm || deriveTabFallbackName(tk);
            persistTabs();
            renderTabBar();
          }
        } catch (err) {
          console.warn("session-name save failed:", err && err.message ? err.message : err);
        }
      };

      // st-name 을 contenteditable 로 전환해 편집 진입. Enter/blur=저장, Esc=취소(원래 이름 복원).
      const startEditingTab = (tk) => {
        if (editingTabKey || !sessionTabsEl) return;
        // 속성-선택자 이스케이핑 리스크 회피 — dataset 비교 루프로 찾음(threadKey 는 임의 문자열 가능).
        let el = null;
        for (const btn of sessionTabsEl.querySelectorAll(".session-tab")) {
          if (btn.dataset.threadKey === tk) { el = btn.querySelector(".st-name"); break; }
        }
        const tab = openTabs.find((t) => t.threadKey === tk);
        if (!el || !tab) return;
        editingTabKey = tk;
        const original = tab.name;
        el.classList.add("editing");
        el.contentEditable = "true";
        el.textContent = original; // ellipsis 아닌 전체 문자열로 편집.
        el.focus();
        try {
          const range = document.createRange();
          range.selectNodeContents(el);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
        } catch {}
        const onKeydown = (e) => {
          if (e.key === "Enter") { e.preventDefault(); finish(true); }
          else if (e.key === "Escape") { e.preventDefault(); finish(false); }
        };
        const onBlur = () => finish(true);
        const finish = (commit) => {
          if (editingTabKey !== tk) return;
          editingTabKey = null;
          el.removeEventListener("keydown", onKeydown);
          el.removeEventListener("blur", onBlur);
          el.contentEditable = "false";
          el.classList.remove("editing");
          if (commit) void commitTabName(tk, el.textContent || "");
          else renderTabBar(); // 취소 — 원래(ellipsis 포함) 렌더로 복귀, 서버 호출 없음.
        };
        el.addEventListener("keydown", onKeydown);
        el.addEventListener("blur", onBlur);
      };

      const renderTabBar = () => {
        if (!sessionTabsEl) return;
        sessionTabsEl.innerHTML = "";
        for (const tab of openTabs) {
          const b = document.createElement("button");
          b.type = "button";
          b.className = "session-tab" + (tab.threadKey === activeThreadKey ? " active" : "");
          b.dataset.threadKey = tab.threadKey;
          b.setAttribute("role", "tab");
          if (tab.preview) b.title = tab.preview;
          const nameSpan = document.createElement("span");
          nameSpan.className = "st-name";
          nameSpan.textContent = tab.name;
          // 더블클릭 = 인라인 이름 편집 진입(단일 클릭은 위 탭 전환과 공존 — 충돌 없음, §4-1).
          nameSpan.addEventListener("dblclick", (e) => { e.stopPropagation(); startEditingTab(tab.threadKey); });
          b.appendChild(nameSpan);
          // 채널 힌트 칩 — 원격/레거시 세션(텔레그램·CLI 등)을 대시보드 세션과 구분(ADR §D6).
          // 채널 메타는 서버 세션(refreshSessionPreviews) 또는 threadKey 접두에서 파생. 대시보드 세션은 없음.
          { const cm = channelMeta(tab.channel || channelFromThreadKey(tab.threadKey));
            if (cm) { const ch = document.createElement("span"); ch.className = "st-ch"; ch.textContent = cm.short; ch.title = cm.full + " 세션"; b.appendChild(ch); } }
          // 진행 뱃지 — 이 세션(또는 스폰한 워커/서브)이 진행 중이면 점(모든 세션 추적, §5.12).
          if (activeTurns.has(tab.threadKey)) {
            const dot = document.createElement("span"); dot.className = "st-dot"; b.appendChild(dot);
          }
          b.addEventListener("click", () => switchToThread(tab.threadKey));
          // 닫기(×) — 기본 세션 제외. 백엔드 세션은 보존(deleteSession 호출 X, D3) = 재열기 복원.
          if (tab.threadKey !== DEFAULT_DASH_THREAD) {
            const x = document.createElement("span");
            x.className = "st-x"; x.textContent = "×"; x.title = "탭 닫기(대화는 보존)";
            x.addEventListener("click", (e) => { e.stopPropagation(); closeTab(tab.threadKey); });
            b.appendChild(x);
          }
          sessionTabsEl.appendChild(b);
        }
        const plus = document.createElement("button");
        plus.type = "button"; plus.className = "session-tab session-add"; plus.textContent = "+";
        plus.title = "새 세션";
        plus.addEventListener("click", newTab);
        sessionTabsEl.appendChild(plus);
      };
      onTurnsChanged = renderTabBar; // activeTurns 변경 시 진행 뱃지 갱신(refreshWorking 훅).

      // 스트림 DOM/게이트(B계층) 리셋 — 탭 전환 시 채팅 DOM·dedup Set·가상화 인덱스·활성 렌더
      // 참조를 모두 비운다. 마스터 데이터(activityByStep·activeTurns·jobCards, A계층)는 안 건드림.
      const resetStreamState = () => {
        vtClear();                     // 가상화 sizer/vtItems/vtIndex 비움 + 스트림 DOM 제거.
        renderedMsgKeys.clear();
        renderedActivityKeys.clear();
        cardByThread.clear();          // 진행 카드 참조(제거된 DOM) — 새 세션서 재빌드.
        pendingQueued.length = 0;      // 낙관적 대기 버블(active DOM 참조) — 승격 대상 초기화.
        localChatCount = 0;
        oldestLoadedTs = null;
        reachedOldest = false;
        loadingOlder = false;
      };

      // active 세션 이력 fetch → 기존 병합·인터리브·가상화 렌더 파이프 재실행(§3.2 3). 렌더러
      // 자체는 안 바꾼다 — 입력(entries/activities)이 threadKey 로 스코프될 뿐. token 으로 전환
      // 경합 방어(빠른 연속 전환 시 stale 배치가 다른 탭에 안 들어가게).
      const loadThreadHistory = async (tk) => {
        resetStreamState();
        refreshChatEmpty();
        const myToken = ++switchToken;
        try {
          const r = await fetch("/api/chat-history?limit=" + HISTORY_PAGE + "&threadKey=" + encodeURIComponent(tk));
          if (myToken !== switchToken) return; // 그 사이 또 전환됨 — 이 배치는 버림.
          if (!r.ok) { refreshChatEmpty(); return; }
          const data = await r.json().catch(() => ({}));
          if (myToken !== switchToken) return;
          const entries = Array.isArray(data.entries) ? data.entries : [];
          const activities = Array.isArray(data.activities) ? data.activities : [];
          if (entries.length === 0 && activities.length === 0) { refreshChatEmpty(); return; } // 빈(새) 세션.
          renderHistoryBatch(entries, activities, false);
          oldestLoadedTs = entries.length > 0 ? entries[0].ts : (activities.length > 0 ? activities[0].ts : null);
          if (entries.length < HISTORY_PAGE) reachedOldest = true;
          refreshChatEmpty();
          scrollChatToNewest();
          if (currentView === "overview") setTimeout(showOverview, 0);
        } catch (err) {
          refreshChatEmpty();
          console.warn("thread history load failed:", err && err.message ? err.message : err);
        }
      };

      const switchToThread = (tk) => {
        if (tk === activeThreadKey || !openTabs.some((t) => t.threadKey === tk)) return;
        activeThreadKey = tk;
        clearReply();          // 답글 인용은 세션 스코프 — 전환 시 초기화.
        renderTabBar();
        persistTabs();
        void loadThreadHistory(tk);
        if (typeof refreshBgScope === "function") refreshBgScope(); // 백그라운드 드로어 세션 스코프 재적용.
        try { document.getElementById("chat-input").focus(); } catch {}
      };

      const newTab = () => {
        const uuid = (self.crypto && self.crypto.randomUUID)
          ? self.crypto.randomUUID()
          : (String(Date.now()) + "-" + Math.random().toString(16).slice(2));
        const tk = "dashboard:" + uuid;
        sessionSeq += 1;
        openTabs.push({ threadKey: tk, name: deriveTabFallbackName(tk) }); // 번호식 세션명(공백없는 "세션N", 영속 번호). 커스텀은 더블클릭 편집.
        activeThreadKey = tk;   // 백엔드 행은 첫 전송에 lazy 생성(빈 탭 = 무흔적, D3).
        clearReply();
        renderTabBar();
        persistTabs();
        void loadThreadHistory(tk); // 빈 스트림(새 세션 = 이력 없음) 즉시.
        if (typeof refreshBgScope === "function") refreshBgScope(); // 백그라운드 드로어 세션 스코프 재적용.
        try { document.getElementById("chat-input").focus(); } catch {}
      };

      const closeTab = (tk) => {
        if (tk === DEFAULT_DASH_THREAD) return; // 기본 세션 닫기 불가.
        const idx = openTabs.findIndex((t) => t.threadKey === tk);
        if (idx === -1) return;
        openTabs.splice(idx, 1); // ★localStorage(탭 목록)에서만 제거 — 백엔드 세션 보존(D3, 비파괴).
        markClosed(tk); // 명시 닫음 기록 — 서버 세션 병합(refreshSessionPreviews)이 이 탭을 재노출하지 않게(닫기 보존).
        if (activeThreadKey === tk) {
          const next = openTabs[Math.max(0, idx - 1)] || openTabs[0] || { threadKey: DEFAULT_DASH_THREAD };
          activeThreadKey = next.threadKey;
          clearReply();
          renderTabBar();
          persistTabs();
          void loadThreadHistory(activeThreadKey);
          if (typeof refreshBgScope === "function") refreshBgScope(); // 백그라운드 드로어 세션 스코프 재적용.
        } else {
          renderTabBar();
          persistTabs();
        }
      };

      // 서버 /api/sessions = 세션 존재/프리뷰 진실 소스(D2). 채널/세션 분리(ADR 2026-07-15 §D6):
      // /sessions 가 이제 전 대화 세션(내부 파생 제외)을 반환 → 열린 탭 프리뷰/채널 메타를 채우고,
      // 아직 탭으로 안 열린 대화 세션(레거시 tg:·cli: 등)을 채널 힌트와 함께 목록에 노출한다.
      // 텔레그램은 기본 세션(dashboard:default)에 합류하므로 별 탭 아님(같은 id = 중복 0). 닫은 세션·
      // dev 노이즈(test:·bridge:)는 제외, recency 순 상한(MAX_SURFACED_TABS)으로 탭바 바운드.
      const refreshSessionPreviews = async () => {
        try {
          const r = await fetch("/api/sessions");
          if (!r.ok) return;
          const data = await r.json().catch(() => ({}));
          const sessions = Array.isArray(data.sessions) ? data.sessions : [];
          const openByKey = new Map(openTabs.map((t) => [t.threadKey, t]));
          const closed = loadClosedSet();
          let changed = false;
          // (1) 이미 열린 탭 — 프리뷰·채널 메타 갱신 + 이름 우선순위(§4-2): 서버 커스텀(s.name) >
          // 로컬 파생 라벨. 서버 커스텀이 사라지면(다른 클라가 지움 등) 로컬도 파생 폴백으로 복귀.
          for (const s of sessions) {
            const t = openByKey.get(s.threadKey);
            if (!t) continue;
            if (s.preview && t.preview !== s.preview) { t.preview = s.preview; changed = true; }
            const ch = s.channel || s.lastChannel || channelFromThreadKey(s.threadKey);
            if (ch && t.channel !== ch) { t.channel = ch; changed = true; }
            const serverName = (typeof s.name === "string" && s.name) ? s.name : null;
            if (serverName !== (t.customName || null)) {
              t.customName = serverName;
              t.name = serverName || deriveTabFallbackName(t.threadKey);
              changed = true;
            }
          }
          // (2) 아직 안 열린 대화 세션 노출(recency 순, 상한). 기본 세션·닫은 세션·노이즈 제외.
          // 이름 = 서버 커스텀(s.name) ?? 프리뷰 파생(slice16) ?? 채널 라벨(§4-2, 현행 파생 폴백 유지).
          let surfaced = 0;
          for (const s of sessions) {
            if (surfaced >= MAX_SURFACED_TABS) break;
            const tk = s.threadKey;
            if (openByKey.has(tk) || tk === DEFAULT_DASH_THREAD) continue;
            if (!isSurfaceableSession(tk) || closed.has(tk)) continue;
            const ch = s.channel || s.lastChannel || channelFromThreadKey(tk);
            const cm = channelMeta(ch);
            const serverName = (typeof s.name === "string" && s.name) ? s.name : null;
            const derived = (s.preview && s.preview.trim()) ? s.preview.trim().slice(0, 16) : (cm ? cm.full : "세션");
            const name = serverName || derived;
            const tab = { threadKey: tk, name, ...(serverName ? { customName: serverName } : {}), ...(s.preview ? { preview: s.preview } : {}), ...(ch ? { channel: ch } : {}) };
            openTabs.push(tab);
            openByKey.set(tk, tab);
            surfaced += 1; changed = true;
          }
          // 편집 중엔 렌더를 미룬다(진행 중인 contenteditable DOM 보존) — 데이터는 반영, 다음
          // renderTabBar(편집 종료 시 호출)가 자연히 최신 상태로 그림.
          if (changed) { persistTabs(); if (!editingTabKey) renderTabBar(); }
        } catch {}
      };

      // 과거 대화 이력을 먼저 복원한 뒤 SSE 연결(기능 B). dedup Set 이 채워진 상태로
      // 라이브 스트림이 붙어 history replay 중복을 막는다. 이력 로드 실패/지연이 SSE 를
      // 막지 않도록 then 으로 잇되, 실패해도 반드시 connectStream 으로 진행(라이브 무손상).
      loadTabs();          // localStorage 에서 열린 탭 + activeThreadKey 복원(없으면 기본 단일 탭).
      renderTabBar();
      loadChatHistory().finally(() => { connectStream(); refreshSessionPreviews(); });
      setInterval(refreshSessionPreviews, 30000);

      const form = document.getElementById("chat-form");
      const input = document.getElementById("chat-input");
      const sendBtn = document.getElementById("chat-send");
      const statusEl = document.getElementById("chat-status");

