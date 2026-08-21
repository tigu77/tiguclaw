      // ── 세션 이름 인라인 편집(§4 계약) ──────────────────────────────────────
      // 표시 우선순위: 서버 커스텀(tab.customName, /api/sessions 의 name) > 로컬 파생 라벨.
      // customName 은 순수 인메모리 부기(diff 용) — TABS_LS 직렬화 shape 은 불변(name 필드만 저장, §4-3).
      let editingTabKey = null; // 동시 편집 방지(단순화) — 활성 편집 threadKey.
      let dragThreadKey = null; // 드래그 재정렬 중인 탭의 threadKey (null = 드래그 아님).

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

      // ★"+"로 만든 세션이 서버에 처음 나타난 순간, 이름이 없으면 지금 보이는 이름을 고정한다.
      //  (2026-08-19 사용자 신고: `/sessions` 목록에 "회사돌쇠야?"·"그냥" 같은 **말조각**이
      //   세션 이름으로 떴다. 원인은 세션이 잘못 생긴 게 아니라 **이름이 없어서** 표시명이
      //   첫 발화에서 파생된 것 — 대시보드 "+"는 이름을 localStorage 에만 두고 서버엔 안 남겼다.
      //   같은 말로 시작한 세션이 셋이면 목록에서 구분이 아예 안 된다.)
      //  ★텔레그램 `/sessions new` 는 이름을 안 줘도 서버에 기본명을 저장한다(2026-07-29).
      //   같은 일을 하는 두 입구가 다르게 동작하던 것을 맞춘다.
      //  ★판정을 함수로 뽑아 둔다 — 갱신 루프 안에 두면 검사가 문자열 grep 밖에 못 하고,
      //   그러면 `if (false)` 한 줄로 조용히 죽는다(이 파일의 markClosed 가 같은 이유로 뽑혀 있다).
      const commitPendingName = (threadKey, serverName) => {
        if (threadKey === DEFAULT_DASH_THREAD) return false;   // 기본 세션은 고정 라벨.
        if (typeof serverName === "string" && serverName.trim() !== "") return false; // 이미 이름 있음.
        void commitTabName(threadKey, deriveTabFallbackName(threadKey));
        return true;
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
        if (el.parentElement) el.parentElement.draggable = false; // 편집 중 드래그 off (텍스트 선택 충돌 방지).
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

      // ── 컨텍스트메뉴(세션, context-menu 계약 §2.2) — 이름변경·닫기·새 세션. 닫기는 이 메뉴로만
      // (붙은 × 버튼 폐지, 사용자 요청). 더블클릭 이름변경·+ 새탭은 유지. closeTab/newTab 은 아래 정의되지만 클로저
      // 참조라 호출 시점(사용자 클릭 후)엔 이미 존재 — 선언 순서 무관.
      registerBuiltinHandler("session.rename", (ctx) => { startEditingTab(ctx.targetId); });
      registerBuiltinHandler("session.close", (ctx) => { closeTab(ctx.targetId); });
      registerBuiltinHandler("session.new", () => { newTab(); });
      registerMenuItems("session", (ctx) => {
        const items = [
          { id: "rename", label: "이름 변경", icon: "✏️", action: { kind: "builtin", handler: "session.rename" } },
          { id: "new", label: "새 세션", icon: "➕", action: { kind: "builtin", handler: "session.new" } },
        ];
        if (ctx.targetId !== DEFAULT_DASH_THREAD) {
          items.push({ id: "close", label: "탭 닫기", icon: "✕", danger: true, action: { kind: "builtin", handler: "session.close" } });
        }
        return items;
      });

      // ── 활성 세션탭을 보이는 자리로 (2026-08-10, ★근본 수정 08-11) ─────────
      //
      // 탭이 늘면 활성 탭이 스트립 밖으로 나간다. 종전엔 `renderTabBar` 끝에서 한 번만
      // 스크롤했는데, **부팅에선 그게 아무 일도 안 했다**: 부팅 순서가
      //   ①탭 렌더(이때 채팅 패널은 아직 안 보임 → 스트립 폭 0 → scrollIntoView 무효)
      //   ②마지막 뷰 복원으로 채팅이 보이게 됨 (렌더는 다시 안 돎)
      // 이라, 새로고침 직후엔 활성 탭이 화면 밖에 있었다. 헤드리스 실측:
      // 탭 클릭 시 scrollLeft=95(보임) / 새로고침 후 scrollLeft=0, 활성탭 left=485(안 보임).
      //
      // ★고침은 "한 번 더 부르기"가 아니라 **불변식을 다시 세우는 자리를 만드는 것**이다.
      //  "활성 탭은 보여야 한다" 는 렌더 1회의 성질이 아니라 스트립의 성질이다. 그래서
      //  크기가 바뀔 때(숨김→보임, 창 크기 변경, 모바일 탭 전환) 스스로 다시 확인한다.
      const ensureActiveTabVisible = () => {
        try {
          if (!sessionTabsEl || sessionTabsEl.clientWidth === 0) return false; // 아직 레이아웃 전.
          const activeEl = sessionTabsEl.querySelector(".session-tab.active");
          if (!activeEl || !activeEl.scrollIntoView) return false;
          // block:"nearest" — 이미 보이면 안 움직인다(스크롤 튐 0). 세로 페이지 스크롤도 안 건드린다.
          activeEl.scrollIntoView({ block: "nearest", inline: "nearest" });
          return true;
        } catch {
          return false; // 구형 브라우저 — 스크롤만 안 따라갈 뿐 무해.
        }
      };
      // 폭 0 → N (채팅이 보이게 되는 순간)에 다시 확인. 타이머로 짐작하지 않는다.
      if (sessionTabsEl && typeof ResizeObserver === "function") {
        new ResizeObserver(() => ensureActiveTabVisible()).observe(sessionTabsEl);
      }

      // ★세로 휠은 이 스트립에서 끝난다 (2026-08-11 사용자 지시) — 탭을 훑다가 대화가
      //  딸려 스크롤되지 않게. 터치는 CSS `touch-action:pan-x` 가 막는데(app.css
      //  `.session-tabs`) **휠은 CSS 로 못 막아** 여기 한 줄이 필요하다. 성질의 정본은
      //  CSS 쪽이고 이건 같은 성질의 플랫폼 보충이다 — 판단이 갈리지 않게 주석으로 묶어 둔다.
      //  ★가로 성분이 우세하면 건드리지 않는다(트랙패드 가로 스와이프 = 탭 넘기기, 정상 동작).
      if (sessionTabsEl) {
        sessionTabsEl.addEventListener(
          "wheel",
          (e) => {
            if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.preventDefault();
          },
          { passive: false },
        );
      }

      const renderTabBar = () => {
        if (!sessionTabsEl) return;
        sessionTabsEl.innerHTML = "";
        for (const tab of openTabs) {
          const b = document.createElement("button");
          b.type = "button";
          b.className = "session-tab" + (tab.threadKey === activeThreadKey ? " active" : "");
          b.dataset.threadKey = tab.threadKey;
          b.setAttribute("role", "tab");
          // ── 드래그 재정렬 — openTabs 배열 순서 = 렌더·직렬화 순서(persistTabs)라, 배열을
          //    재배치하면 재접속·리로드 후에도 순서 유지. 편집 중(editingTabKey)엔 draggable off
          //    (contentEditable 텍스트 선택과 충돌 방지). 드롭 위치는 대상 탭 중앙 기준 앞/뒤.
          b.draggable = editingTabKey !== tab.threadKey;
          b.addEventListener("dragstart", (e) => {
            if (editingTabKey) { e.preventDefault(); return; }
            dragThreadKey = tab.threadKey;
            b.classList.add("dragging");
            if (e.dataTransfer) { e.dataTransfer.effectAllowed = "move"; try { e.dataTransfer.setData("text/plain", tab.threadKey); } catch {} }
          });
          b.addEventListener("dragend", () => {
            dragThreadKey = null;
            b.classList.remove("dragging");
            for (const el of sessionTabsEl.querySelectorAll(".drag-over")) el.classList.remove("drag-over");
          });
          b.addEventListener("dragover", (e) => {
            if (dragThreadKey === null || dragThreadKey === tab.threadKey) return;
            e.preventDefault();
            if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
            b.classList.add("drag-over");
          });
          b.addEventListener("dragleave", () => { b.classList.remove("drag-over"); });
          b.addEventListener("drop", (e) => {
            e.preventDefault();
            b.classList.remove("drag-over");
            if (dragThreadKey === null || dragThreadKey === tab.threadKey) return;
            const rect = b.getBoundingClientRect();
            const after = e.clientX > rect.left + rect.width / 2;
            const from = openTabs.findIndex((t) => t.threadKey === dragThreadKey);
            if (from < 0) return;
            const [moved] = openTabs.splice(from, 1);
            let to = openTabs.findIndex((t) => t.threadKey === tab.threadKey);
            if (to < 0) to = openTabs.length; else if (after) to += 1;
            openTabs.splice(to, 0, moved);
            persistTabs();
            renderTabBar();
          });
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
          // 진행 배지 = 활성 턴 **또는** 그 세션이 띄운 백그라운드(워커·서브·셸)가 도는 중
          // (2026-07-26 사용자 요청). 종전엔 턴만 봐서, 워커/셸이 도는 세션 탭이 조용했다.
          // bgWorkSessions 는 background-drawer.js 가 소속 확정된 것만 담는다(남의 탭 오탐 0).
          const hasBgWork = typeof bgWorkSessions !== "undefined" && bgWorkSessions.has(tab.threadKey);
          if (activeTurns.has(tab.threadKey) || hasBgWork) {
            const dot = document.createElement("span"); dot.className = "st-dot"; b.appendChild(dot);
          }
          // ★안 본 메시지 배지 (2026-08-12, 사용자 제안) — 진행 점과 **따로** 붙인다.
          //  "지금 도는가" 와 "내가 못 본 게 있나" 는 다른 사실이라, 한 턴이 끝나 진행 점이
          //  사라지는 순간이 곧 **읽어야 할 게 생긴** 순간이다. 같은 자리에 겹쳐 쓰면 그 신호가
          //  사라진다. 둘 다 참이면 둘 다 보인다(도는 중 + 이미 온 답 N개).
          const unread = typeof unreadCount === "function" ? unreadCount(tab.threadKey) : 0;
          if (unread > 0) {
            const u = document.createElement("span");
            u.className = "st-unread";
            u.textContent = unread > 99 ? "99+" : String(unread);
            u.title = `안 읽은 답변 ${unread}개`;
            b.appendChild(u);
          }
          b.addEventListener("click", () => switchToThread(tab.threadKey));
          // 닫기는 ⋯ 메뉴의 "탭 닫기"로만(붙은 × 버튼 폐지 — 사용자 요청). 기본 세션은 메뉴에도
          // 닫기 항목 없음(registerMenuItems 조건). 대화는 보존(deleteSession 호출 X, D3) = 재열기 복원.
          // 컨텍스트메뉴 트리거 — kebab + 우클릭 + 롱프레스(탭류, 3경로 동일 메뉴).
          const sessionCtx = () => ({ type: "session", targetId: tab.threadKey, threadKey: tab.threadKey, label: tab.name });
          // 메뉴 = 항상 보이는 ⋯ kebab(클릭/탭) + 우클릭. 롱프레스는 뺀다 — 드래그 재정렬
          // (누르고 끌기)과 충돌(누르고 있으면 메뉴 뜸)하고, kebab 이 이미 전 기기서 접근 가능.
          attachKebab(b, "session", sessionCtx);
          attachContextMenu(b, "session", sessionCtx);
          sessionTabsEl.appendChild(b);
        }
        const plus = document.createElement("button");
        plus.type = "button"; plus.className = "session-tab session-add"; plus.textContent = "+";
        plus.title = "새 세션";
        plus.addEventListener("click", newTab);
        sessionTabsEl.appendChild(plus);
        // ★활성 탭이 보이는 자리로 스크롤 (2026-08-10 사용자 지적). 탭이 늘면 활성 탭이
        //  스트립 밖으로 나가는데, 종전엔 따라가는 코드가 **한 곳도 없어** 채팅에 들어와도
        //  지금 어느 탭인지 눈으로 못 찾았다(특히 새로고침 직후 마지막 탭 복원 시).
        //  ★block:"nearest" — 이미 보이면 안 움직인다(불필요한 스크롤 튐 0). inline 만
        //   가로 스트립 기준으로 맞춘다. 세로 페이지 스크롤을 건드리지 않는 게 중요하다.
        ensureActiveTabVisible();
      };
      onTurnsChanged = renderTabBar; // activeTurns 변경 시 진행 뱃지 갱신(refreshWorking 훅).

      // 스트림 DOM/게이트(B계층) 리셋 — 탭 전환 시 채팅 DOM·dedup Set·가상화 인덱스·활성 렌더
      // 참조를 모두 비운다. 마스터 데이터(activityByStep·activeTurns·jobCards, A계층)는 안 건드림.
      const resetStreamState = () => {
        vtClear();                     // 가상화 sizer/vtItems/vtIndex 비움 + 스트림 DOM 제거.
        renderedMsgKeys.clear();
        renderedActivityKeys.clear();
        // ★신규 dedup Set 2개도 비운다 (2026-07-29 검토). 안 비우면 탭 전환으로 DOM 이
        //  지워진 뒤 **진행 중 선택지가 replay 로도 복구되지 않는다**(가드가 과잉이 된다).
        //  순서 보호는 vtIsStaleForAppend 가 별도로 하므로 dedup 을 비워도 옛것은 안 붙는다.
        //  상한도 없던 Set 이라 여기서 비우는 게 메모리 관리도 겸한다.
        renderedPromptOptionKeys.clear();
        renderedNoticeKeys.clear();
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
        setHistoryLoadState("loading"); // 전환 직후 빈 리스트에 "대화가 없습니다"를 띄우지 않는다.
        const myToken = ++switchToken;
        // ★리스트를 비운 직후부터 이력 렌더까지의 창 — 이 사이 SSE 메시지는 보류한다.
        //  안 그러면 빈 리스트 때문에 stale 가드가 꺼져 옛 메시지가 바닥에 붙고, 그 위로
        //  이력이 prepend 되며 옛 대화가 최신 사이에 끼어든다(2026-07-28 실측).
        beginHistoryLoad();
        try {
          const r = await fetch("/api/chat-history?limit=" + HISTORY_PAGE + "&threadKey=" + encodeURIComponent(tk));
          if (myToken !== switchToken) return; // 그 사이 또 전환됨 — 이 배치는 버림.
          if (!r.ok) { setHistoryLoadState("error"); return; } // 실패와 빈 세션은 다른 상태다.
          const data = await r.json().catch(() => ({}));
          if (myToken !== switchToken) return;
          const entries = Array.isArray(data.entries) ? data.entries : [];
          const activities = Array.isArray(data.activities) ? data.activities : [];
          if (entries.length === 0 && activities.length === 0) return; // 빈(새) 세션 — finally 가 ready 로 닫는다.
          // ★진행 중 턴 seamless 재개(멀티세션 도구폭주 픽스) — 이 스레드에 활성 턴(activeTurns)
          // 이 있으면, 이력 활동의 마지막 seq-run(=진행 중 턴)을 정적 hist-turn 이 아니라 라이브
          // 경로(renderActivity)로 재구성한다. 그래야 cardByThread 가 세팅돼 뒤이어 SSE 로
          // 도착하는 라이브 활동이 같은 turn-group 에 이어붙고, 한 턴이 hist-turn+turn-group
          // 두 카드로 쪼개지지 않는다(전환-복귀 시 도구 플랫/중복 나열의 근본). 완료된 앞선
          // 턴들은 그대로 hist-turn(N단계)으로. seq 리셋(비증가 경계)이 진행 중 턴의 시작.
          let histActivities = activities, liveResume = [];
          if (activeTurns.has(tk) && activities.length > 0) {
            let start = activities.length - 1;
            while (start > 0 && (activities[start].seq ?? 0) > (activities[start - 1].seq ?? 0)) start--;
            histActivities = activities.slice(0, start);
            liveResume = activities.slice(start);
          }
          renderHistoryBatch(entries, histActivities, false);
          for (const a of liveResume) { try { renderActivity(a, fmtTime(a.ts)); } catch { /* best-effort 재개 */ } }
          oldestLoadedTs = entries.length > 0 ? entries[0].ts : (activities.length > 0 ? activities[0].ts : null);
          if (entries.length < HISTORY_PAGE) reachedOldest = true;
          refreshChatEmpty();
          scrollChatToNewest();
          if (currentView === "overview") setTimeout(showOverview, 0);
        } catch (err) {
          setHistoryLoadState("error");
          console.warn("thread history load failed:", err && err.message ? err.message : err);
        } finally {
          endHistoryLoad(); // 조기 return(토큰 무효·!ok·빈 세션) 포함 — 보류분 유실 0.
          // ★"loading" 으로 굳는 경로 0 — 초기 로드(history-render)와 같은 형태로 닫는다.
          if (historyLoadState === "loading") setHistoryLoadState("ready");
        }
      };

      const switchToThread = (tk) => {
        if (tk === activeThreadKey || !openTabs.some((t) => t.threadKey === tk)) return;
        if (window.saveChatDraft) window.saveChatDraft(activeThreadKey); // 떠나는 탭 draft 저장.
        activeThreadKey = tk;
        if (window.restoreChatDraft) window.restoreChatDraft(tk);        // 들어오는 탭 draft 복원.
        clearReply();          // 답글 인용은 세션 스코프 — 전환 시 초기화.
        renderTabBar();
        persistTabs();
        // 세션을 옮기면 배경 상태도 맞춘다 — 옮겨 다니는 동안 끝난 잡이 "진행 중" 으로
        // 굳는 것이 사용자 제보의 주 경로였다(2026-08-02).
        if (typeof window.resyncBackground === "function") window.resyncBackground();
        // 그 탭을 열었으면 읽은 것 — 배지 해제. (renderTabBar 재호출은 clearUnread 안에서.)
        if (typeof clearUnread === "function") clearUnread(tk);
        void loadThreadHistory(tk);
        if (typeof refreshBgScope === "function") refreshBgScope(); // 백그라운드 드로어 세션 스코프 재적용.
        if (window.hydrateModelSelect) window.hydrateModelSelect(); // 모델 프로파일 드롭다운 = 이 탭 상태로.
        // 세션탭 *이동* 시엔 입력 포커스 안 줌 — 모바일에서 전환 때마다 가상키보드가 올라오는 문제.
        // (새 탭 생성 newTab 은 타이핑 의도라 포커스 유지.)
      };

      const newTab = () => {
        const uuid = (self.crypto && self.crypto.randomUUID)
          ? self.crypto.randomUUID()
          : (String(Date.now()) + "-" + Math.random().toString(16).slice(2));
        const tk = "dashboard:" + uuid;
        sessionSeq += 1;
        if (window.saveChatDraft) window.saveChatDraft(activeThreadKey); // 떠나는 탭 draft 저장.
        // pending — 아직 서버 행이 없다(첫 전송에 lazy 생성). 아래 고아 정리가
        // 이걸 "서버가 모르는 탭" 으로 오인해 지우지 않게 한다.
        openTabs.push({ threadKey: tk, name: deriveTabFallbackName(tk), modelProfile: null, pending: true }); // 번호식 세션명(공백없는 "세션N", 영속 번호). 커스텀은 더블클릭 편집. 새 세션 = 프로파일 미선택(상속).
        activeThreadKey = tk;   // 백엔드 행은 첫 전송에 lazy 생성(빈 탭 = 무흔적, D3).
        if (window.restoreChatDraft) window.restoreChatDraft(tk);        // 새 탭 = 빈 draft(입력 클리어).
        clearReply();
        renderTabBar();
        persistTabs();
        void loadThreadHistory(tk); // 빈 스트림(새 세션 = 이력 없음) 즉시.
        if (typeof refreshBgScope === "function") refreshBgScope(); // 백그라운드 드로어 세션 스코프 재적용.
        if (window.hydrateModelSelect) window.hydrateModelSelect(); // 새 세션 = 드롭다운 기본으로.
        focusChatInput();
      };

      const closeTab = (tk) => {
        if (tk === DEFAULT_DASH_THREAD) return; // 기본 세션 닫기 불가.
        const idx = openTabs.findIndex((t) => t.threadKey === tk);
        if (idx === -1) return;
        openTabs.splice(idx, 1); // ★localStorage(탭 목록)에서만 제거 — 백엔드 세션 보존(D3, 비파괴).
        markClosed(tk); // 명시 닫음 기록 — 서버 세션 병합(refreshSessionPreviews)이 이 탭을 재노출하지 않게(닫기 보존).
        if (window.clearChatDraft) window.clearChatDraft(tk); // 닫는 탭의 draft 정리.
        if (activeThreadKey === tk) {
          const next = openTabs[Math.max(0, idx - 1)] || openTabs[0] || { threadKey: DEFAULT_DASH_THREAD };
          activeThreadKey = next.threadKey;
          if (window.restoreChatDraft) window.restoreChatDraft(activeThreadKey); // 전환된 탭 draft 복원.
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
      // ★자동 개설은 **이름 붙인 세션만**(shouldAutoOpenTab) — 목록 가시성과 탭 점유는 다른
      // 질문이다. 무명 세션도 목록엔 보이고 눌러서 열 수 있다. recency 순 상한으로 탭바 바운드.
      const refreshSessionPreviews = async () => {
        try {
          const r = await fetch("/api/sessions");
          if (!r.ok) return;
          const data = await r.json().catch(() => ({}));
          const sessions = Array.isArray(data.sessions) ? data.sessions : [];
          const openByKey = new Map(openTabs.map((t) => [t.threadKey, t]));
          const closed = loadClosedSet();
          let changed = false;
          // ★세션 표시명 공유 지도 갱신 (2026-08-06) — **열린 탭 여부와 무관하게 전 세션**.
          //  여기가 유일한 채우는 곳이다(util.js sessionDisplayNames 주석 참조). 백그라운드
          //  잡 카드가 "이 잡이 어느 세션 것인가" 를 사람이 읽는 이름으로 보여주려면 안 연
          //  세션의 이름도 필요한데, 이 응답이 이미 그걸 들고 있으므로 추가 요청 0.
          for (const s of sessions) {
            if (typeof s.threadKey !== "string" || s.threadKey === "") continue;
            const nm = (typeof s.displayName === "string" && s.displayName)
              ? s.displayName
              : (typeof s.name === "string" && s.name ? s.name : "");
            if (nm !== "") sessionDisplayNames.set(s.threadKey, nm);
          }
          // 이름이 새로 생겼을 수 있으니 잡 카드 배지를 한 번 훑는다(끝난 잡은 이벤트가
          // 더 안 와서 스스로 갱신되지 않는다). 드로어가 없으면 no-op.
          if (typeof window.refreshBgSessionBadges === "function") window.refreshBgSessionBadges();
          // (1) 이미 열린 탭 — 프리뷰·채널 메타 갱신 + 이름 우선순위(§4-2): 서버 커스텀(s.name) >
          // 로컬 파생 라벨. 서버 커스텀이 사라지면(다른 클라가 지움 등) 로컬도 파생 폴백으로 복귀.
          for (const s of sessions) {
            const t = openByKey.get(s.threadKey);
            if (!t) continue;
            if (t.pending) {
              delete t.pending; // 서버가 알게 됨 = 더는 신규 아님.
              changed = true;
              // ★이 순간이 **첫 전송으로 서버 행이 막 생긴 시점**이다(그 전엔 행이 없다 =
              //  "빈 탭 = 흔적 0" 성질은 그대로). 그 행엔 이름이 없으므로 여기서 고정한다.
              commitPendingName(t.threadKey, s.name);
            }
            if (s.preview && t.preview !== s.preview) { t.preview = s.preview; changed = true; }
            const ch = s.channel || s.lastChannel || channelFromThreadKey(s.threadKey);
            if (ch && t.channel !== ch) { t.channel = ch; changed = true; }
            const serverName = (typeof s.name === "string" && s.name) ? s.name : null;
            // ★표시명은 서버가 준 displayName 을 쓴다(커스텀 > 첫 대화 발췌 > 폴백).
            //  종전엔 커스텀이 없으면 로컬 "세션N" 으로 되돌아가, **같은 세션이 텔레그램
            //  에선 생키·여기선 세션N** 으로 갈렸다(단일 인격 위반).
            const shown = (typeof s.displayName === "string" && s.displayName)
              ? s.displayName : (serverName || deriveTabFallbackName(t.threadKey));
            if (serverName !== (t.customName || null) || t.name !== shown) {
              t.customName = serverName;
              t.name = shown;
              changed = true;
            }
            // 세션 모델 프로파일(드롭다운 상태 복원, ADR model-dropdown §3-c) — 서버가 진실.
            // in-memory only(TABS_LS 직렬화 shape 불변). null = 상속(기본).
            const sp = (typeof s.modelProfile === "string" && s.modelProfile) ? s.modelProfile : null;
            if ((t.modelProfile || null) !== sp) { t.modelProfile = sp; changed = true; }
          }
          // (2) 아직 안 열린 대화 세션 노출(recency 순, 상한). 기본 세션·닫은 세션·노이즈 제외.
          // 이름 = 서버 커스텀(s.name) ?? 프리뷰 파생(slice16) ?? 채널 라벨(§4-2, 현행 파생 폴백 유지).
          let surfaced = 0;
          for (const s of sessions) {
            if (surfaced >= MAX_SURFACED_TABS) break;
            const tk = s.threadKey;
            if (openByKey.has(tk) || tk === DEFAULT_DASH_THREAD) continue;
            if (!shouldAutoOpenTab(s) || closed.has(tk)) continue;
            const ch = s.channel || s.lastChannel || channelFromThreadKey(tk);
            const cm = channelMeta(ch);
            const serverName = (typeof s.name === "string" && s.name) ? s.name : null;
            // 파생은 서버 규칙 하나(sessionDisplayName). 채널 라벨은 그것도 비었을 때만.
            const name = (typeof s.displayName === "string" && s.displayName)
              ? s.displayName : (serverName || (cm ? cm.full : "세션"));
            const sp = (typeof s.modelProfile === "string" && s.modelProfile) ? s.modelProfile : null;
            const tab = { threadKey: tk, name, modelProfile: sp, ...(serverName ? { customName: serverName } : {}), ...(s.preview ? { preview: s.preview } : {}), ...(ch ? { channel: ch } : {}) };
            openTabs.push(tab);
            openByKey.set(tk, tab);
            surfaced += 1; changed = true;
          }
          // ★고아 탭 정리 (2026-08-03 사용자 제보 "Verify 세션탭 떠있는건 뭐지?").
          //  `openTabs` 는 **줄어드는 경로가 없었다** — 드래그 재정렬과 명시적 닫기뿐.
          //  그래서 서버 세션이 사라져도(프루닝·다른 기기에서 보관·다른 홈) 탭은 그때
          //  캐시된 이름을 단 채 **영원히** 남았다. 눌러도 빈 대화만 나온다.
          //  ★닫기를 서버 정본으로 바꾸면서(같은 날) 이게 더 커졌다 — A 기기에서 닫으면
          //   B 기기엔 좀비 탭이 남는다. 되살리는 쪽만 서버를 보고 지우는 쪽은 안 봤다.
          //  안전장치 셋: 목록이 비면(로드 실패·부팅 순간) 아무것도 안 지운다 / 기본 세션은
          //  대상 아님 / `pending`(첫 전송 전이라 서버 행이 아직 없음)은 건드리지 않는다.
          if (sessions.length > 0) {
            const known = new Set(sessions.map((s) => s.threadKey));
            const orphan = (t) =>
              t.threadKey !== DEFAULT_DASH_THREAD && !t.pending && !known.has(t.threadKey);
            // ★활성 탭이 고아면 **먼저 기본 세션으로 옮기고** 지운다 (2026-08-03 2차).
            //  1차 수정은 "보고 있는 탭은 안 뺀다" 로 활성 탭을 면제했는데, 사용자가 신고한
            //  바로 그 탭(`verify:…`)이 **활성**이라 영구 면제가 됐다 — 새로고침해도
            //  activeThreadKey 가 localStorage 에서 그 탭으로 복원돼 다시 면제된다.
            //  고아는 서버가 모르는 세션이라 **내용이 없다**(화면에도 "아직 대화가 없습니다").
            //  옮겨도 잃을 게 없다. 새로 만든 탭은 `pending` 이라 여기 안 걸린다.
            if (openTabs.some((t) => t.threadKey === activeThreadKey && orphan(t))) {
              switchToThread(DEFAULT_DASH_THREAD);
            }
            for (let i = openTabs.length - 1; i >= 0; i--) {
              const t = openTabs[i];
              if (!orphan(t) || t.threadKey === activeThreadKey) continue;
              openTabs.splice(i, 1);
              changed = true;
              console.debug("[tabs] 서버에 없는 세션 탭 정리:", t.threadKey, t.name);
            }
          }
          // 편집 중엔 렌더를 미룬다(진행 중인 contenteditable DOM 보존) — 데이터는 반영, 다음
          // renderTabBar(편집 종료 시 호출)가 자연히 최신 상태로 그림.
          if (changed) { persistTabs(); if (!editingTabKey) renderTabBar(); }
          if (window.hydrateModelSelect) window.hydrateModelSelect(); // 활성 탭 프로파일 → 드롭다운 반영.
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

