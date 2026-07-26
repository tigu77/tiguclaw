      // ── 전체 활동(크로스세션 모니터) — _workspace/all-activity_architect_contract.md §2.
      // 별도 경량 read-only append-only 렌더러. 채팅뷰(#stream·가상화·activeThreadKey 필터·
      // data-threadkey 누수가드·windowing·seq 인터리브·멀티세션 탭)는 절대 참조하지 않는다
      // (하드 제약 §2.1/§3 — 재사용의 "일반화"가 회귀표면을 키운다는 계약 판단). 자체 컨테이너
      // #activity-stream 에만 그리고, 자체 dedup Set·자체 스크롤 상태를 갖는다(상태 격리 §4).
      let activityOldestTs = null;           // 다음 beforeTs 페이지네이션 커서(가장 오래된 로드분 ts).
      let activityReachedOldest = false;     // 더 로드할 과거 배치가 없음.
      let activityLoadingOlder = false;      // 동시 로드 가드.
      const activitySeenMsgKeys = new Set(); // 채팅뷰 renderedMsgKeys 와 별개(§2.1 상태 분리).
      const activitySeenActKeys = new Set();
      const ACTIVITY_MAX_LINES = 200;        // DOM 상한(라이브 프리즈 실측 후 800→200). 초과 시 위(오래된 것)부터 프루닝.
      const ACTIVITY_INIT_LIMIT = 50;        // 초기 entries 요청 상한 — activities 가 entries 에 비례 폭증하므로 작게(라이브 실측: 200→1315줄 프리즈, 50→급감).
      const activityStreamEl = document.getElementById("activity-stream");

      // 세션 배지 표시명 — §3 계약: openTabs(서버 /api/sessions 로 갱신되는 기존 캐시) 재사용,
      // 신규 fetch 없음. openTabs 항목의 name 은 이미 서버 커스텀>파생 우선순위가 반영돼 있다
      // (refreshSessionPreviews). 못 찾으면(전체활동엔 안 연 세션도 나옴) deriveTabFallbackName
      // 이 채널 파생 폴백까지 처리(이미 존재하는 경로, 추가 로직 불필요).
      const activitySessionName = (tk) => {
        const t = openTabs.find((o) => o.threadKey === tk);
        if (t && t.name) return t.name;
        return deriveTabFallbackName(tk);
      };

      const buildActivitySessionBadge = (tk) => {
        const b = document.createElement("span");
        b.className = "aav-session-badge";
        b.textContent = activitySessionName(tk);
        b.title = String(tk || "");
        return b;
      };

      // 모니터 라인 본문 = 단일 라인 플레인 텍스트(truncate). 라이브 프리즈 실측 후, 마크다운
      // 파싱(setChatBody)·리치 블록은 불채택 — 800(→200) 라인을 한 번에 만드는 모니터에서 파서
      // 호출은 치명적. 개행은 공백으로 접고 ACTIVITY_TEXT_MAX 로 자른다(전문은 채팅뷰에서 확인).
      const ACTIVITY_TEXT_MAX = 200;
      const activityPlainPreview = (text) => {
        const s = String(text || "").replace(/\s+/g, " ").trim();
        return s.length > ACTIVITY_TEXT_MAX ? s.slice(0, ACTIVITY_TEXT_MAX) + "…" : s;
      };
      // 아코디언 본문에 넣는 *전체* 텍스트(자르지 않음). 접힘=CSS 1줄 클램프(nowrap+ellipsis, 개행은
      // 시각적으로 접힘), 펼침(.expanded)=pre-wrap 로 개행·공백 보존해 전문 표시. 트렁케이트를 렌더
      // 시 baked 하지 않으므로 펼침이 실제로 전문을 드러낸다(재렌더 0). \r\n 정규화 + 양끝 트림만.
      const activityFullText = (text) => String(text || "").replace(/\r\n/g, "\n").trim();

      // chat_log 행(entries) → 한 줄. 채팅뷰 buildHistoryDiv 와 달리 turn/스킵 dedup·마크다운 없이
      // 단순 flat 플레인 라인(§2.2 단순 우선 + 프리즈 방지).
      // ── 컨텍스트메뉴(전체활동 라인, context-menu 계약 §2.2) — 세션 점프(백로그 흡수)·복사.
      // 롱프레스 없음(계약 "카드/탭류"에만 롱프레스 — 라인은 kebab+우클릭만).
      registerBuiltinHandler("activity.jump", (ctx) => {
        const tk = ctx.threadKey;
        if (!tk || typeof switchToThread !== "function") return;
        if (!openTabs.some((t) => t.threadKey === tk)) {
          openTabs.push({ threadKey: tk, name: typeof deriveTabFallbackName === "function" ? deriveTabFallbackName(tk) : tk });
        }
        // 전체활동뷰 → 채팅뷰로 전환 + 그 세션 활성화(전체활동 라인에서 세션으로 점프).
        if (typeof setActiveNav === "function") setActiveNav("chat");
        if (typeof setChatPanel === "function") setChatPanel("chat");
        if (typeof setActiveTab === "function") setActiveTab("chat");
        switchToThread(tk);
      });
      registerBuiltinHandler("activity.copy", async (ctx) => {
        if (!navigator.clipboard) return;
        try { await navigator.clipboard.writeText(ctx.label || ""); } catch {}
      });
      registerMenuItems("activity", (ctx) => {
        const items = [];
        if (ctx.threadKey) items.push({ id: "jump", label: "세션으로 이동", icon: "↪️", action: { kind: "builtin", handler: "activity.jump" } });
        items.push({ id: "copy", label: "복사", icon: "📋", action: { kind: "builtin", handler: "activity.copy" } });
        return items;
      });

      const buildActivityLineFromEntry = (e) => {
        const line = document.createElement("div");
        const role = e.role === "assistant" ? "assistant" : "user";
        line.className = "aav-line aav-" + role;
        if (e.ts != null) line.dataset.ts = String(e.ts);
        const time = document.createElement("span"); time.className = "aav-time"; time.textContent = fmtTime(e.ts);
        const badges = document.createElement("span"); badges.className = "aav-badges";
        badges.appendChild(buildActivitySessionBadge(e.threadKey));
        const chb = buildChannelBadge(e.channel); if (chb) badges.appendChild(chb);
        const icon = document.createElement("span"); icon.className = "aav-role-icon";
        icon.textContent = role === "assistant" ? "🤖" : "🙂";
        // 아코디언: 접힘(기본)=메타+본문 프리뷰 한 줄 인라인, 펼침(클릭 .expanded)=메타 한 줄 위 /
        // 전체 본문 아래 전체폭 wrap. 접힘↔펼침 토글은 CSS flex-wrap(본문 flex-basis)로 처리.
        const meta = document.createElement("div"); meta.className = "aav-meta";
        const chev = document.createElement("span"); chev.className = "aav-chevron"; chev.textContent = "▸";
        meta.appendChild(chev); meta.appendChild(time); meta.appendChild(badges); meta.appendChild(icon);
        const body = document.createElement("div"); body.className = "aav-body";
        const full = activityFullText(e.text);
        const hasAtt = e.attachments && e.attachments.length;
        body.textContent = full || (hasAtt ? "" : "(빈 메시지)");
        if (hasAtt) {
          const att = document.createElement("span"); att.className = "aav-att-hint";
          att.textContent = "📎×" + e.attachments.length;
          body.appendChild(att);
        }
        line.appendChild(meta); line.appendChild(body);
        line.addEventListener("click", () => line.classList.toggle("expanded"));
        // 컨텍스트메뉴 트리거 — kebab(메타 끝) + 우클릭(라인 전체, 클릭 토글과 별개 이벤트).
        const actCtx = () => ({ type: "activity", targetId: "m|" + e.ts, threadKey: e.threadKey, label: full || e.text || "" });
        attachKebab(meta, "activity", actCtx);
        attachContextMenu(line, "activity", actCtx);
        return line;
      };

      // llm.activity(도구 스텝/텍스트 세그먼트) → 한 줄. diff/output 리치 카드·펼침은 불채택
      // (§2.2, 단순 우선) — label+detail 요약만. kind==="text" 는 텍스트 세그먼트 미리보기.
      const buildActivityLineFromAct = (a) => {
        const line = document.createElement("div");
        line.className = "aav-line aav-tool";
        if (a.ts != null) line.dataset.ts = String(a.ts);
        const time = document.createElement("span"); time.className = "aav-time"; time.textContent = fmtTime(a.ts);
        const badges = document.createElement("span"); badges.className = "aav-badges";
        badges.appendChild(buildActivitySessionBadge(a.threadKey));
        const chb = buildChannelBadge(channelFromThreadKey(a.threadKey)); if (chb) badges.appendChild(chb);
        const skill = skillStepInfo(a);
        const icon = document.createElement("span"); icon.className = "aav-role-icon";
        icon.textContent = a.kind === "text" ? "💬" : (skill ? "🛠" : "🔧");
        const meta = document.createElement("div"); meta.className = "aav-meta";
        const chev = document.createElement("span"); chev.className = "aav-chevron"; chev.textContent = "▸";
        meta.appendChild(chev); meta.appendChild(time); meta.appendChild(badges); meta.appendChild(icon);
        const body = document.createElement("div"); body.className = "aav-body";
        if (a.kind === "text") {
          const full = activityFullText(a.text);
          body.textContent = full ? "텍스트 응답: " + full : "(텍스트 세그먼트)";
        } else {
          const label = skill ? "스킬: " + skill.name : String(a.label || "tool");
          const detail = (!skill && a.detail) ? " — " + activityFullText(a.detail) : "";
          body.textContent = label + detail;
        }
        line.appendChild(meta); line.appendChild(body);
        line.addEventListener("click", () => line.classList.toggle("expanded"));
        // 컨텍스트메뉴 트리거 — buildActivityLineFromEntry 와 동형.
        const actCtx2 = () => ({ type: "activity", targetId: "a|" + a.ts + "|" + (a.seq == null ? "" : a.seq), threadKey: a.threadKey, label: body.textContent });
        attachKebab(meta, "activity", actCtx2);
        attachContextMenu(line, "activity", actCtx2);
        return line;
      };

      // 훅 발화 라인 — 도구 라인(buildActivityLineFromAct)과 동형. 차단(blocked)은 눈에 띄게(aav-hook-blocked).
      //   event(PreToolUse/PostToolUse/UserPromptSubmit/Stop) + toolName + 차단사유를 한 줄로.
      const buildActivityLineFromHook = (h) => {
        const line = document.createElement("div");
        line.className = "aav-line aav-hook" + (h.blocked ? " aav-hook-blocked" : "");
        if (h.ts != null) line.dataset.ts = String(h.ts);
        const time = document.createElement("span"); time.className = "aav-time"; time.textContent = fmtTime(h.ts);
        const badges = document.createElement("span"); badges.className = "aav-badges";
        badges.appendChild(buildActivitySessionBadge(h.threadKey));
        const chb = buildChannelBadge(channelFromThreadKey(h.threadKey)); if (chb) badges.appendChild(chb);
        const icon = document.createElement("span"); icon.className = "aav-role-icon";
        icon.textContent = h.blocked ? "⛔" : "🪝";
        const meta = document.createElement("div"); meta.className = "aav-meta";
        const chev = document.createElement("span"); chev.className = "aav-chevron"; chev.textContent = "▸";
        meta.appendChild(chev); meta.appendChild(time); meta.appendChild(badges); meta.appendChild(icon);
        const body = document.createElement("div"); body.className = "aav-body";
        const evName = String(h.event || "hook");
        const tool = h.toolName ? " · " + h.toolName : "";
        const blocked = h.blocked ? " — 차단" + (h.blockReason ? ": " + activityFullText(h.blockReason) : "") : "";
        body.textContent = "훅 " + evName + tool + blocked;
        line.appendChild(meta); line.appendChild(body);
        line.addEventListener("click", () => line.classList.toggle("expanded"));
        const hookCtx = () => ({ type: "activity", targetId: "h|" + h.ts + "|" + evName + "|" + (h.toolName || ""), threadKey: h.threadKey, label: body.textContent });
        attachKebab(meta, "activity", hookCtx);
        attachContextMenu(line, "activity", hookCtx);
        return line;
      };

      const pruneActivityStream = () => {
        if (!activityStreamEl) return;
        while (activityStreamEl.children.length > ACTIVITY_MAX_LINES) {
          activityStreamEl.removeChild(activityStreamEl.firstChild);
        }
        capKeyStore(activitySeenMsgKeys); // 순수 유틸(1032) 재사용 — dedup Set 도 무한증가 방지.
        capKeyStore(activitySeenActKeys);
      };

      // append-only. 바닥 근처였으면 자동 스크롤 유지(모니터=최근 위주 관측).
      const appendActivityNode = (node, ts) => {
        if (!activityStreamEl || !node) return;
        const empty = document.getElementById("activity-empty"); if (empty) empty.remove();
        const nearBottom = activityStreamEl.scrollTop + activityStreamEl.clientHeight >= activityStreamEl.scrollHeight - 60;
        activityStreamEl.appendChild(node);
        pruneActivityStream();
        if (nearBottom) activityStreamEl.scrollTop = activityStreamEl.scrollHeight;
        if (ts != null && (activityOldestTs === null || ts < activityOldestTs)) activityOldestTs = ts;
      };

      const prependActivityNodes = (nodes) => {
        if (!activityStreamEl || !nodes.length) return;
        const prevHeight = activityStreamEl.scrollHeight;
        const frag = document.createDocumentFragment();
        for (const n of nodes) frag.appendChild(n);
        activityStreamEl.insertBefore(frag, activityStreamEl.firstChild);
        activityStreamEl.scrollTop += (activityStreamEl.scrollHeight - prevHeight); // 점프 방지.
      };

      // entries+activities(한 배치) → ts(동률 시 seq) 오름차순 병합 유닛. 채팅뷰 groupMergedItems
      // 와 달리 turn 묶음·텍스트 세그먼트 dedup 로직 없음(§2.2 — 단순함↔일반성 충돌서 단순 우선).
      const mergeActivityBatch = (entries, activities) => {
        const merged = [
          ...entries.map((e) => ({ ts: e.ts, seq: -1, kind: "msg", e })),
          ...activities.map((a) => ({ ts: a.ts, seq: typeof a.seq === "number" ? a.seq : 0, kind: "act", a })),
        ];
        merged.sort((x, y) => (x.ts - y.ts) || (x.seq - y.seq));
        return merged;
      };

      // 유닛 → element(+dedup). 이미 그렸으면 null(초기 스냅샷↔라이브 SSE 중복 방지, 채팅뷰
      // msgKey/actKey 와 동형 아이디어이나 별개 Set — 상태 격리 §2.1).
      const renderActivityUnit = (u) => {
        if (u.kind === "msg") {
          const key = "m|" + u.e.ts + "|" + (u.e.role || "");
          if (activitySeenMsgKeys.has(key)) return null;
          activitySeenMsgKeys.add(key);
          return buildActivityLineFromEntry(u.e);
        }
        if (u.kind === "hook") {
          const h = u.h;
          const key = "h|" + h.ts + "|" + (h.threadKey || "") + "|" + (h.event || "") + "|" + (h.toolName || "");
          if (activitySeenActKeys.has(key)) return null;
          activitySeenActKeys.add(key);
          return buildActivityLineFromHook(h);
        }
        const key = "a|" + u.a.ts + "|" + (u.a.threadKey || "") + "|" + (u.a.seq == null ? "" : u.a.seq);
        if (activitySeenActKeys.has(key)) return null;
        activitySeenActKeys.add(key);
        return buildActivityLineFromAct(u.a);
      };

      // 진입 시 1회 스냅샷(§4 최단순 경로) + beforeTs 페이지네이션(§1.1, /chat-history 와 동일 시맨틱).
      const loadAllActivity = async (initial) => {
        try {
          const qs = initial
            ? ("?limit=" + ACTIVITY_INIT_LIMIT)
            : ("?limit=" + ACTIVITY_INIT_LIMIT + "&beforeTs=" + activityOldestTs);
          const r = await fetch("/api/all-activity" + qs);
          if (!r.ok) return;
          const data = await r.json().catch(() => ({}));
          const entries = Array.isArray(data.entries) ? data.entries : [];
          const activities = Array.isArray(data.activities) ? data.activities : [];
          if (initial) {
            if (activityStreamEl) activityStreamEl.innerHTML = "";
            activitySeenMsgKeys.clear(); activitySeenActKeys.clear();
            activityOldestTs = null; activityReachedOldest = false;
          }
          let units = mergeActivityBatch(entries, activities);
          if (units.length === 0) { if (!initial) activityReachedOldest = true; return; }
          if (initial) {
            // ★볼륨 바운드(라이브 프리즈 실측) — activities 폭증으로 병합이 상한을 크게 넘으면
            // 전부 만들고 프루닝(while-remove) 하면 여전히 그 많은 DOM 을 한 번 생성해 프리즈한다.
            // 렌더 *전에* 최근 ACTIVITY_MAX_LINES 개(꼬리)만 남겨 애초에 노드 생성량을 상한한다.
            // 잘려나간 과거분은 위로 스크롤 시 beforeTs 페이지네이션으로 다시 로드된다.
            if (units.length > ACTIVITY_MAX_LINES) units = units.slice(units.length - ACTIVITY_MAX_LINES);
            for (const u of units) {
              const ts = u.kind === "msg" ? u.e.ts : u.a.ts;
              const node = renderActivityUnit(u);
              if (node) appendActivityNode(node, ts);
            }
            if (activityStreamEl) activityStreamEl.scrollTop = activityStreamEl.scrollHeight;
          } else {
            const nodes = [];
            let minTs = activityOldestTs;
            for (const u of units) {
              const ts = u.kind === "msg" ? u.e.ts : u.a.ts;
              if (minTs === null || ts < minTs) minTs = ts;
              const node = renderActivityUnit(u);
              if (node) nodes.push(node);
            }
            prependActivityNodes(nodes);
            activityOldestTs = minTs;
          }
        } catch {}
      };

      const loadOlderActivity = () => {
        if (activityLoadingOlder || activityReachedOldest || activityOldestTs === null) return;
        activityLoadingOlder = true;
        loadAllActivity(false).finally(() => { activityLoadingOlder = false; });
      };

      // 상단 근처 스크롤 = 더 로드(§2.2 "있으면 좋음" 페이지네이션). 뷰 비활성 시 no-op.
      if (activityStreamEl) {
        activityStreamEl.addEventListener("scroll", () => {
          if (currentView === "activity" && activityStreamEl.scrollTop < 80) loadOlderActivity();
        });
      }

      const showActivityView = () => {
        setActiveNav("activity");
        loadAllActivity(true); // 진입할 때마다 새 스냅샷(단순, 이탈 동안의 갭 없음).
      };

      // 라이브 SSE 분기(§4) — 전체활동뷰가 currentView 일 때만, 전 스레드 그대로 append
      // (activeThreadKey 필터 없음). renderEvent 의 기존 채팅뷰 if/return 사슬과는 별개 호출로,
      // 그 흐름의 return·activityByStep 마스터 저장·워커 드로어 라우팅을 전혀 건드리지 않는다.
      const handleActivityLiveEvent = (ev) => {
        if (currentView !== "activity") return;
        if (ev.type === "channel.message.in" || ev.type === "channel.message.out") {
          const p = ev.payload || {};
          const tk = p.threadKey;
          if (typeof tk === "string" && tk.indexOf("endpoint:") === 0) return; // 엔드포인트 뷰 소관.
          const role = ev.type === "channel.message.out" ? "assistant" : "user";
          const node = renderActivityUnit({
            kind: "msg",
            e: { ts: ev.ts, threadKey: tk, channel: p.channel, role, text: p.text, attachments: p.attachments },
          });
          if (node) appendActivityNode(node, ev.ts);
          return;
        }
        if (ev.type === "llm.activity") {
          const ap = ev.payload || {};
          if (ap.ts == null) ap.ts = ev.ts;
          if (ap.phase === "end") return; // 실행시간 주석 이벤트 — 단순화(§2.2), 모니터 라인 없음.
          const tk = typeof ap.threadKey === "string" ? ap.threadKey : "";
          // 워커/서브/게이트웨이 스텝 제외 — bridge historyActivities(§1.2)와 동일 규칙(드로어 소관).
          if (tk.indexOf("worker:") === 0 || tk.indexOf("agent:") === 0 || tk.indexOf("gateway:") === 0) return;
          const node = renderActivityUnit({ kind: "act", a: ap });
          if (node) appendActivityNode(node, ap.ts);
          return;
        }
        if (ev.type === "hook.activity") {
          const h = ev.payload || {};
          if (h.ts == null) h.ts = ev.ts;
          const tk = typeof h.threadKey === "string" ? h.threadKey : "";
          // 도구 라인과 동일 규칙 — 워커/서브/게이트웨이는 드로어 소관이라 모니터 제외.
          if (tk.indexOf("worker:") === 0 || tk.indexOf("agent:") === 0 || tk.indexOf("gateway:") === 0) return;
          const node = renderActivityUnit({ kind: "hook", h });
          if (node) appendActivityNode(node, h.ts);
          return;
        }
        // prompt.options·llm.turn_*·worker.* 등 — 읽기전용 원칙(§5, 선택지 버튼 렌더 안 함) 또는
        // 이 뷰 범위 밖(§9 후속) → 조용히 무시.
      };

      for (const btn of document.querySelectorAll(".nav-button")) {
        btn.addEventListener("click", () => {
          const view = btn.dataset.view;
          if (view === "overview") showOverview();
          else if (view === "providers") showProviders();
          else if (view === "models") showModels();
          else if (view === "inventory") showInventory();
          else if (view === "projects") showProjects();
          else if (view === "endpoints") showEndpoints();
          else if (view === "activity") showActivityView();
          else if (view === "chat") { setActiveNav("chat"); setChatPanel("chat"); setActiveTab("chat"); scrollChatToNewest(); focusChatInput(); }
          else if (view === "settings") showSettings();
          // 채널·에이전트 top-nav 제거(ADR 2026-07-17 §5 오픈이슈#1, Phase 3b-1) — 채널은 모듈 뷰
          // (data-view="providers")에 흡수, 실행 중 에이전트는 백그라운드 드로어 잡카드 소관.
          // 🖥️ 셸 top-nav 제거(ADR §5, Phase 3b-2) — 백그라운드 드로어 안 별도 섹션으로 이식
          // (showShells 는 이제 openBg 로 드로어를 여는 함수, background-drawer.js 표면 B 소관).
          if (window.matchMedia("(max-width: 900px)").matches && ["overview","providers","models","inventory","settings","projects","endpoints","activity"].includes(view)) setActiveTab("main");
        });
      }

      refreshChatEmpty();
      showOverview();
      fetchProviders();
      setInterval(fetchProviders, 30000);
      fetchInventory();
      setInterval(fetchInventory, 30000);
      fetchProjects();
      setInterval(fetchProjects, 30000);
      fetchModelProfiles();
      setInterval(fetchModelProfiles, 30000);

      // 앱 버전 — /api/health(bridge)의 version 을 헤더 부제에 1회 반영(하드코딩 stale 방지).
      fetch("/api/health").then((r) => r.json()).then((h) => {
        const sub = document.getElementById("app-sub");
        if (sub && h && typeof h.version === "string") sub.textContent = "대시보드 · v" + h.version;
      }).catch(() => { /* health 미도달 — 부제 기본 유지 */ });

      const connDot = document.getElementById("conn-dot");
      const connText = document.getElementById("conn-text");
      const setConn = (up) => {
        connDot.className = "dot " + (up ? "up" : "down");
        connText.textContent = up ? "실시간" : "재연결 중…";
      };

      // SSE 연결 — 재연결 가능 클로저. EventSource 는 보통 끊기면 자동 재연결하지만,
      // 비-200 등 치명 에러면 CLOSED 로 영구 종료(자동 재연결 X) → 탭 stale. 그 경우만
      // 수동 재연결한다(데몬 재시작·블립 내성). 서버측 하트비트(: ping)와 함께 동작.
      let es = null;
      // ★liveness 워치독(2026-07-26) — onerror 만으로는 **조용한 죽음**을 못 잡는다. 연결이
      //  half-open 이 되면(맥 절전·네트워크 전환·프록시 idle timeout) 브라우저는 에러를 안 받고
      //  readyState 도 OPEN 이라 자동 재연결이 영영 안 걸린다. 그 사이 발행된 이벤트를 통째로
      //  놓쳐 카드가 "실행 중"으로 굳었다(실측: 끝난 워커가 30분째 도는 것처럼 보임).
      //  서버가 20s 마다 `stream.heartbeat` **실제 이벤트**를 보내므로(코멘트 ping 은 onmessage
      //  미발화라 관측 불가였음), 마지막 수신 시각을 추적해 임계 초과면 강제 재연결한다.
      let lastRecvAt = Date.now();
      const STREAM_STALE_MS = 70_000; // 하트비트 3회(60s) + 여유.
      const forceReconnect = () => {
        try { if (es) es.close(); } catch { /* 이미 닫힘 */ }
        setConn(false);
        connectStream();
      };
      const connectStream = () => {
        es = new EventSource("/api/events");
        lastRecvAt = Date.now();
        es.onopen = () => { lastRecvAt = Date.now(); setConn(true); };
        es.onmessage = (m) => {
          lastRecvAt = Date.now(); // 하트비트 포함 — 모든 수신이 liveness 증거.
          setConn(true);
          try { renderEvent(JSON.parse(m.data)); } catch (e) { /* skip malformed */ }
        };
        es.onerror = () => {
          setConn(false);
          // CONNECTING(=자동 재연결 중)이면 브라우저에 맡기고, CLOSED(치명)면 수동 재연결.
          if (es.readyState === EventSource.CLOSED) {
            setTimeout(connectStream, 3000);
          }
        };
      };
      // 주기 점검 — 무수신이 임계를 넘으면(=조용한 죽음) 강제 재연결. 재연결 시 서버가 최근
      // 이벤트를 replay 하므로 놓친 상태가 복구된다(유령 카드 해소).
      setInterval(() => {
        if (Date.now() - lastRecvAt > STREAM_STALE_MS) forceReconnect();
      }, 15_000);
      // 탭 복귀 즉시 점검 — 절전/백그라운드 복귀가 가장 흔한 조용한 죽음 케이스라, 다음 주기를
      // 기다리지 않고 바로 회복시킨다(모바일 사파리 포함).
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible" && Date.now() - lastRecvAt > STREAM_STALE_MS) {
          forceReconnect();
        }
      });
      // ══ 멀티세션 탭(ADR 2026-07-15 Phase 2) ══════════════════════════════════
      // 각 탭 = 독립 대화 세션(dashboard:<uuid> threadKey). 기본 = dashboard:default(연속성).
      // 열린 탭 목록 = 클라 localStorage(UI 선호, D2). 세션 존재/프리뷰 = 서버 /api/sessions.
      // 탭 전환 = 스트림 DOM/게이트(B계층) 리셋 + active 세션 이력 fetch 재빌드(§3.2). 마스터
      // 데이터(A, activityByStep·activeTurns·jobCards)는 전 스레드 무필터 보존(§3.4).
      const TABS_LS = "dash.tabs.v1";       // [{threadKey,name,channel?}]
      const ACTIVE_LS = "dash.activeTab.v1"; // activeThreadKey
      const SEQ_LS = "dash.tabSeq.v1";       // "세션 N" 단조 카운터
      const SESSION_NUM_LS = "dash.sessionNums.v1"; // threadKey → 안정 세션 번호(첫 등장 순서로 배정·영속). dashboard:default=1 시드.
      const CLOSED_LS = "dash.closedTabs.v1"; // 사용자가 명시 닫은 세션 id — 서버 세션 병합 시 재노출 차단(닫기 보존).
      // 서버 세션 병합 시 자동 노출 상한 — 대시보드 자기 세션 외 원격/레거시 세션(텔레그램·CLI 등)이
      // 무한 증가해도 탭바를 바운드(recency 순, 서버가 이미 last_used_at DESC). 과설계 방지.
      const MAX_SURFACED_TABS = 10;
      // dev DB 노이즈(test:·bridge:·내부 파생)를 목록에서 배제 — prod 엔 없지만 라이브 dev DB 방어.
      // 서버 excludeInternal 과 belt-and-suspenders(worker:/agent:/endpoint:/gateway:/scheduler:/::sub::).
      const NON_CONVO_PREFIXES = ["worker:", "agent:", "endpoint:", "gateway:", "scheduler:", "test:", "bridge:"];
      const isSurfaceableSession = (tk) => {
        if (typeof tk !== "string" || tk === "") return false;
        if (tk.indexOf("::sub::") !== -1) return false;
        for (const p of NON_CONVO_PREFIXES) if (tk.indexOf(p) === 0) return false;
        return true;
      };
      const loadClosedSet = () => {
        try { const a = JSON.parse(localStorage.getItem(CLOSED_LS) || "[]"); return new Set(Array.isArray(a) ? a : []); }
        catch { return new Set(); }
      };
      const markClosed = (tk) => {
        try { const s = loadClosedSet(); s.add(tk); localStorage.setItem(CLOSED_LS, JSON.stringify([...s])); } catch {}
      };
      let openTabs = [];       // [{ threadKey, name, preview?, channel? }]
      let sessionSeq = 0;
      let switchToken = 0;     // 전환 중 stale 이력 배치가 다른 탭에 렌더되는 것 방지.
      const sessionTabsEl = document.getElementById("session-tabs");

      const persistTabs = () => {
        try {
          localStorage.setItem(TABS_LS, JSON.stringify(openTabs.map((t) => ({ threadKey: t.threadKey, name: t.name, ...(t.channel ? { channel: t.channel } : {}) }))));
          localStorage.setItem(ACTIVE_LS, activeThreadKey);
          localStorage.setItem(SEQ_LS, String(sessionSeq));
        } catch {}
      };

      const loadTabs = () => {
        try {
          const raw = localStorage.getItem(TABS_LS);
          const arr = raw ? JSON.parse(raw) : null;
          if (Array.isArray(arr) && arr.length) {
            // 채널/세션 분리(ADR 2026-07-15) — 세션은 채널 무관이라 dashboard: 접두 필터 폐지.
            // 서버 병합으로 노출된 레거시 세션(tg:·cli:)도 재로드에 보존되게 임의 threadKey 허용.
            openTabs = arr
              .filter((t) => t && typeof t.threadKey === "string" && t.threadKey !== "")
              .map((t) => ({ threadKey: t.threadKey, name: typeof t.name === "string" && t.name ? t.name : deriveTabFallbackName(t.threadKey), ...(typeof t.channel === "string" && t.channel ? { channel: t.channel } : {}) }));
          }
        } catch {}
        if (!openTabs.length) openTabs = [{ threadKey: DEFAULT_DASH_THREAD, name: deriveTabFallbackName(DEFAULT_DASH_THREAD) }];
        // 기본 세션은 항상 존재(닫기 불가) — 복원 목록에 없으면 맨 앞에 삽입.
        if (!openTabs.some((t) => t.threadKey === DEFAULT_DASH_THREAD)) {
          openTabs.unshift({ threadKey: DEFAULT_DASH_THREAD, name: deriveTabFallbackName(DEFAULT_DASH_THREAD) });
        }
        try { const s = parseInt(localStorage.getItem(SEQ_LS) || "0", 10); if (Number.isFinite(s) && s > 0) sessionSeq = s; } catch {}
        let act = DEFAULT_DASH_THREAD;
        try { const a = localStorage.getItem(ACTIVE_LS); if (a && openTabs.some((t) => t.threadKey === a)) act = a; } catch {}
        activeThreadKey = act;
      };

