      /**
       * HTML 텍스트 이스케이프 (2026-07-31 전체검토 P0).
       *
       * ★왜: 서버 문자열을 문자열 연결로 `innerHTML` 에 넣던 자리 9곳에서 XSS 가 실증됐다
       *  (스킬·에이전트·MCP 의 name/description, 프로바이더 name/summary/status,
       *   AGENT.md 의 `이름:`). 셋 다 **비서가 스스로 쓰는 값**이라 프롬프트 인젝션 한 번이면
       *  영속 XSS 가 되고, 같은 오리진의 `/api/messages`(=비서에게 임의 지시 = 도구 실행)·
       *  `/api/restart`·`/api/open-path` 를 전부 부를 수 있었다.
       *
       * 속성 위치(`class="..."`)에도 쓰이므로 따옴표 둘 다 이스케이프한다.
       * 마크다운 본문은 이 함수가 아니라 `renderMarkdown`(sanitize 통과)이 담당한다.
       */
      const escHtml = (v) =>
        String(v == null ? "" : v)
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;")
          .replace(/'/g, "&#39;");

      /**
       * 첨부 크기 표시 — **공유 유틸에 있어야 하는 이유가 있다** (2026-07-31 3차 검토).
       *
       * ★사고: 이 함수가 `chat-send.js`(로드 #29)에 있는데 `history-render.js`(#18)가 썼다.
       *  클래식 스크립트의 top-level `const` 는 스크립트 간 공유되지만 **실행 전엔 TDZ** 다.
       *  그런데 `tabs.js`(#25)가 top-level 에서 `loadChatHistory()` 를 부르고, 그 fetch 가
       *  `chat-send.js` 로드보다 먼저 끝나면(라이브 실측: 이력 214ms vs 스크립트 376ms —
       *  **창이 항상 열려 있다**) 렌더 중 `ReferenceError` 가 나고 catch 가 그걸 삼켜
       *  **채팅이 통째로 백지**가 됐다. 최근 20건에 `bytes` 를 가진 첨부가 하나만 있어도 발동.
       *
       *  교훈: 부팅 async 연속이 동기 렌더를 하면 그 렌더가 쓰는 것은 **더 앞에서** 정의돼야
       *  한다. 공유 유틸을 기능 파일에 두면 로드 순서가 그대로 잠재 버그가 된다.
       */
      const fmtBytes = (b) =>
        b < 1024
          ? b + "B"
          : b < 1048576
            ? Math.round(b / 1024) + "KB"
            : (b / 1048576).toFixed(1) + "MB";

      // 입력창(chat-input) 자동 포커스 = 중앙 정책 한 곳.
      //
      // 2026-07-24: 전면 비활성이었다(모바일 가상키보드 팝업 + 데스크톱 포커스 뺏기).
      //   그 판단은 **탭·뷰 전환·전송·슬래시** 에는 지금도 유효하다 — 사용자가 입력을
      //   원한 적이 없는데 커서가 끌려간다.
      // 2026-08-10: **답글·마이크만** 켠다(사용자 결정). 이 둘은 사용자가 방금
      //   "이제 입력하겠다" 는 행동을 한 자리라, 껐던 이유에 해당하지 않는다.
      //
      // ★허용 **이름 목록**을 두지 않는다 — 호출부가 늘 때 목록은 조용히 뒤처진다.
      //  대신 호출부가 *의도*를 밝히고 여기선 그 의도만 본다. 인자 없이 부르면(기존
      //  호출부 전부) 종전과 같이 아무것도 안 한다 = 회귀 0.
      const focusChatInput = (opts) => {
        if (!opts || opts.userIntendsToType !== true) return;
        // 모바일은 의도가 명시적이어도 안 켠다 — 껐던 이유의 한 축(가상키보드가 화면을
        // 절반 덮는 것)은 의도와 무관하게 그대로다.
        try {
          if (window.matchMedia && window.matchMedia("(pointer: coarse)").matches) return;
        } catch { /* matchMedia 미지원 — 계속 진행 */ }
        const el = document.getElementById("chat-input");
        if (!el) return;
        // preventScroll — 포커스 때문에 채팅이 튀지 않게(가상화 스크롤과 경합 회피).
        try { el.focus({ preventScroll: true }); } catch { try { el.focus(); } catch { /* noop */ } }
      };

      // ── 채팅 입력창 안내문(placeholder) = 판정 한 곳 (2026-08-10) ──────────────
      //
      // ★종전엔 네 곳이 같은 값을 썼다: index.html(기본) · perf.js(터치면 버튼 전송 문구) ·
      //  mobile-nav.js(좁으면 짧게) · ghost-suggest.js(고스트 중엔 비움). 판정 기준도 서로
      //  달랐고(입력 장치 vs 화면 폭) **승자가 로드 순서로** 정해졌다. 실제 결과:
      //   - 폰: mobile-nav 가 나중이라 perf.js 문구는 **한 번도 안 보였다**(죽은 문자열).
      //   - 좁은 데스크톱 창: "메시지 입력…" 만 떠 Enter 전송인지 알 수 없었다.
      //   - 고스트가 떴다 사라지면 초기값으로 되돌아가 모바일 문구가 PC 것으로 바뀌었다.
      //
      // 두 축은 **다른 것을 결정**한다 — *무엇을 안내하나*(전송 방식)는 입력 장치가,
      // *얼마나 길게*는 화면 폭이 정한다. 한 함수에서 조합하면 순서 의존이 사라진다.
      const CHAT_PLACEHOLDER_ENTER =
        "대시보드 채팅 — Enter 전송, Shift+Enter 줄바꿈 · 파일 붙여넣기/드롭";
      const CHAT_PLACEHOLDER_BUTTON =
        "대시보드 채팅 — 전송 버튼으로 전송, Enter 줄바꿈 · 파일 붙여넣기/드롭";
      const CHAT_PLACEHOLDER_SHORT = "메시지 입력…";

      // 주 포인터가 터치인가 — **전송 동작 판정과 같은 기준**이어야 한다(안내문이 그
      // 동작을 설명하므로). perf.js 의 Enter 전송 분기가 이 함수를 쓴다.
      const isTouchPrimary = () =>
        typeof window.matchMedia === "function" &&
        window.matchMedia("(pointer: coarse)").matches;
      // 좁은 화면인가 — 긴 안내문이 과한 폭. 전송 동작과는 무관하다.
      const isNarrowScreen = () =>
        typeof window.matchMedia === "function" &&
        window.matchMedia("(max-width: 900px)").matches;

      let chatGhostShowing = false;
      const computeChatPlaceholder = () => {
        // 고스트가 같은 자리를 쓴다 — 둘 다 그리면 글자가 겹쳐 못 읽는다.
        if (chatGhostShowing) return "";
        if (isNarrowScreen()) return CHAT_PLACEHOLDER_SHORT;
        return isTouchPrimary() ? CHAT_PLACEHOLDER_BUTTON : CHAT_PLACEHOLDER_ENTER;
      };
      const refreshChatPlaceholder = () => {
        const el = document.getElementById("chat-input");
        if (el) el.setAttribute("placeholder", computeChatPlaceholder());
      };
      /** 고스트 표시 상태 전달 — 값 자체는 여기서만 정한다(호출부는 사실만 알린다). */
      const setChatGhostShowing = (on) => {
        chatGhostShowing = on === true;
        refreshChatPlaceholder();
      };
      // 회전·창 크기 변경에도 따라간다 — 종전엔 로드 시 1회라 그대로 굳었다.
      try {
        for (const q of ["(pointer: coarse)", "(max-width: 900px)"]) {
          const mq = window.matchMedia(q);
          if (typeof mq.addEventListener === "function") {
            mq.addEventListener("change", refreshChatPlaceholder);
          }
        }
      } catch { /* matchMedia 미지원 — 초기 1회로 충분 */ }

      let toastTimer = null;
      const showToast = (msg, tone) => {
        const el = document.getElementById("toast");
        if (!el) return;
        el.textContent = msg;
        el.className = "show" + (tone ? " " + tone : "");
        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { el.className = el.className.replace("show", "").trim(); }, 4200);
      };

      // 데몬 재시작 — POST /api/restart (bridge POST /restart, admin 토큰 server-side 주입).
      // 메시지 큐를 타지 않는 아웃오브밴드 제어라 턴이 멈춰도 동작. 오발 방지 확인 다이얼로그.
      let restartInFlight = false;
      const restartDaemon = async () => {
        if (restartInFlight) return;
        if (!window.confirm("데몬을 재시작할까요? 진행 중인 작업이 중단되고 잠시 후 자동 복귀합니다.")) return;
        restartInFlight = true;
        showToast("재시작 요청 중…", "warn");
        try {
          const r = await fetch("/api/restart", { method: "POST" });
          if (r.ok || r.status === 202) {
            showToast("재시작 중… 잠시 후 복귀합니다.", "good");
          } else {
            const data = await r.json().catch(() => ({}));
            showToast("재시작 실패: " + (data.error || ("HTTP " + r.status)), "bad");
          }
        } catch (err) {
          // 데몬이 즉시 종료되면 응답 전에 연결이 끊길 수 있음 — 정상 흐름으로 안내.
          showToast("재시작 신호 전송됨 (응답 끊김) — 잠시 후 복귀합니다.", "warn");
        } finally {
          setTimeout(() => { restartInFlight = false; }, 6000);
        }
      };

      const formatValue = (value) => {
        if (value === null || value === undefined) return "";
        if (typeof value === "object") return JSON.stringify(value);
        return String(value);
      };

      const appendKv = (root, data) => {
        const kv = document.createElement("div");
        kv.className = "kv";
        const entries = data && typeof data === "object" && !Array.isArray(data)
          ? Object.entries(data)
          : [["value", data]];
        for (const [key, value] of entries) {
          const k = document.createElement("div");
          k.className = "kv-key"; k.textContent = key;
          const v = document.createElement("div");
          v.className = "kv-val"; v.textContent = formatValue(value);
          kv.appendChild(k); kv.appendChild(v);
        }
        root.appendChild(kv);
      };

      // kind 배지 라벨. ADR 2026-07-17(모듈/능력 2축) §5 P0 — 모듈 뷰(옛 프로바이더 뷰)가
      // provider(core|plugin)와 채널 presence(kind:"channel")를 한 목록에 섞어 렌더하므로
      // "channel" 값도 여기서 라벨링한다. provider/service/trigger/observer 는 P1(3패널·type
      // 필드 도입) 이후 실제로 채워질 값 — 지금은 core|plugin|channel 만 실사용.
      const kindLabel = (kind) => {
        const map = {
          provider: "모듈",
          core: "코어",
          plugin: "플러그인",
          channel: "채널",
          service: "서비스",
          trigger: "트리거",
          observer: "옵저버",
          runtime: "런타임",
          system: "시스템",
          daemon: "데몬",
          memory: "메모리",
          schedule: "스케줄",
        };
        return map[kind] || kind || "모듈";
      };

      const statusLabel = (status) => {
        const map = { active: "정상", degraded: "주의", error: "오류", inactive: "비활성", unknown: "알 수 없음" };
        return map[status] || status || "알 수 없음";
      };

      const dangerLabel = (danger) => {
        const map = { safe: "안전", gray: "확인 필요", danger: "위험" };
        return map[danger] || danger || "안전";
      };

      const isCoreProvider = (provider) => {
        const id = provider.id || "";
        const kind = provider.kind || "";
        return id.startsWith("core.") || kind === "core" || ["daemon", "memory", "schedule", "plugin-registry"].some((key) => id.includes(key));
      };

      const renderProviderView = (view) => {
        const div = document.createElement("div");
        div.className = "view";
        const title = document.createElement("div");
        title.className = "view-title";
        title.textContent = view.title || view.id || "화면";
        div.appendChild(title);
        const data = view.data || {};
        if (view.kind === "table" && Array.isArray(data.rows)) {
          const table = document.createElement("table");
          table.className = "provider-table";
          const columns = Array.isArray(data.columns) ? data.columns : [];
          const thead = document.createElement("thead");
          const hr = document.createElement("tr");
          for (const col of columns) {
            const th = document.createElement("th"); th.textContent = col;
            hr.appendChild(th);
          }
          thead.appendChild(hr); table.appendChild(thead);
          const tbody = document.createElement("tbody");
          for (const row of data.rows.slice(0, 20)) {
            const tr = document.createElement("tr");
            for (const col of columns) {
              const td = document.createElement("td");
              td.textContent = formatValue(row ? row[col] : "");
              tr.appendChild(td);
            }
            tbody.appendChild(tr);
          }
          table.appendChild(tbody); div.appendChild(table);
          if (data.rows.length > 20) {
            const more = document.createElement("div");
            more.className = "more"; more.textContent = "+ " + (data.rows.length - 20) + "개 행 더 있음";
            div.appendChild(more);
          }
        } else if (view.kind === "action-panel" && Array.isArray(data.actions)) {
          for (const action of data.actions) {
            const line = document.createElement("div");
            line.className = "action";
            const btn = document.createElement("button");
            btn.textContent = action.label || action.id;
            btn.disabled = true;
            const danger = document.createElement("span");
            danger.className = "danger-" + (action.danger || "safe");
            danger.textContent = dangerLabel(action.danger || "safe");
            line.appendChild(btn); line.appendChild(danger);
            div.appendChild(line);
          }
        } else {
          appendKv(div, data);
        }
        return div;
      };

      // ── 리스트 서브패널 공용: 검색(라이브 필터) + 접이식 카테고리(localStorage 영속) ──────────
      // 모듈 뷰·능력 뷰가 동일 마스터-디테일 패턴이라(ADR 2026-07-17 §5 마스터-디테일 통일) 한 벌만
      // 구현해 재사용한다(§5.5 선언형 — 새 뷰가 같은 패턴을 쓰면 코드변경0으로 편입).
      const isGroupCollapsed = (storagePrefix, groupKey) => {
        try { return localStorage.getItem(storagePrefix + ":" + groupKey) === "1"; } catch (e) { return false; }
      };
      const setGroupCollapsed = (storagePrefix, groupKey, collapsed) => {
        try {
          const key = storagePrefix + ":" + groupKey;
          if (collapsed) localStorage.setItem(key, "1"); else localStorage.removeItem(key);
        } catch (e) { /* storage 비활성(프라이빗 모드 등) — 접힘 상태만 비영속, 기능은 계속 동작 */ }
      };

      // 그룹(헤더+아이템 컨테이너) 한 쌍을 만들어 listEl 에 append. buildItems(itemsWrap) 이 실제
      // 항목 DOM 을 채운다(호출자가 provider-item/능력-item 렌더러를 그대로 재사용). 헤더 클릭 →
      // 접기/펴기 토글(chevron 은 CSS 로 회전, app.css .module-group-head.collapsed) + localStorage
      // 저장. ★검색 중(listEl.dataset.searching==="1", applyListSearchFilter 가 세팅)엔 클릭 무시 —
      // 강제 펼침 중 접어봤자 시각 변화 없이 localStorage 만 오염되는 걸 막는다.
      const appendCollapsibleGroup = (listEl, storagePrefix, groupKey, label, count, buildItems) => {
        const collapsed = isGroupCollapsed(storagePrefix, groupKey);
        const head = document.createElement("div");
        head.className = "module-group-head" + (collapsed ? " collapsed" : "");
        const chevron = document.createElement("span");
        chevron.className = "module-group-chevron"; chevron.textContent = "▾";
        const labelEl = document.createElement("span");
        labelEl.className = "module-group-label"; labelEl.textContent = label;
        const countEl = document.createElement("span");
        countEl.className = "module-group-count"; countEl.textContent = String(count);
        head.appendChild(chevron); head.appendChild(labelEl); head.appendChild(countEl);
        const itemsWrap = document.createElement("div");
        itemsWrap.className = "module-group-items";
        buildItems(itemsWrap);
        head.addEventListener("click", () => {
          if (listEl.dataset.searching === "1") return; // 검색 중 접기 무시
          const next = !head.classList.contains("collapsed");
          head.classList.toggle("collapsed", next);
          setGroupCollapsed(storagePrefix, groupKey, next);
        });
        listEl.appendChild(head);
        listEl.appendChild(itemsWrap);
        return itemsWrap;
      };

      // 라이브 검색 필터 — listEl 의 직계 자식 .module-group-head/.module-group-items 쌍을 순회해
      // .provider-item 을 name/kind/description 텍스트(각 렌더러가 채운 item.dataset.searchText)로
      // 매치시킨다. rebuild(list.innerHTML 재구성) 없이 클래스 토글만 하므로 30s 폴 재렌더 뒤에도
      // 각 뷰가 렌더 끝에서 다시 호출하면 검색어가 안 사라진다(호출자 책임). query 빈 문자열 = 전체
      // 복원(접힘은 appendCollapsibleGroup 이 이미 반영한 localStorage 값 그대로 — 손대지 않음).
      const applyListSearchFilter = (listEl, rawQuery) => {
        if (!listEl) return;
        const q = String(rawQuery || "").trim().toLowerCase();
        if (q) listEl.dataset.searching = "1"; else delete listEl.dataset.searching;
        let anyVisible = false;
        for (const head of listEl.querySelectorAll(":scope > .module-group-head")) {
          const itemsWrap = head.nextElementSibling;
          if (!itemsWrap || !itemsWrap.classList.contains("module-group-items")) continue;
          const items = itemsWrap.querySelectorAll(".provider-item");
          const countEl = head.querySelector(".module-group-count");
          if (!q) {
            head.classList.remove("search-hidden-group");
            itemsWrap.classList.remove("search-hidden-group", "force-expanded");
            for (const item of items) item.classList.remove("search-hidden");
            if (countEl) countEl.textContent = String(items.length);
            anyVisible = true;
            continue;
          }
          let visible = 0;
          for (const item of items) {
            const match = (item.dataset.searchText || "").includes(q);
            item.classList.toggle("search-hidden", !match);
            if (match) visible += 1;
          }
          if (countEl) countEl.textContent = String(visible);
          const groupEmpty = visible === 0;
          head.classList.toggle("search-hidden-group", groupEmpty);
          itemsWrap.classList.toggle("search-hidden-group", groupEmpty);
          itemsWrap.classList.toggle("force-expanded", !groupEmpty);
          if (!groupEmpty) anyVisible = true;
        }
        // 그룹 없는 직접 항목(플랫 리스트, 예: 프로젝트 패널)도 동일 필터.
        for (const item of listEl.querySelectorAll(":scope > .provider-item")) {
          if (!q) { item.classList.remove("search-hidden"); anyVisible = true; continue; }
          const match = (item.dataset.searchText || "").includes(q);
          item.classList.toggle("search-hidden", !match);
          if (match) anyVisible = true;
        }
        let emptyMsg = listEl.querySelector(".search-empty-msg");
        if (q && !anyVisible) {
          if (!emptyMsg) {
            emptyMsg = document.createElement("div");
            emptyMsg.className = "empty search-empty-msg";
            emptyMsg.style.margin = "8px";
            emptyMsg.textContent = "검색 결과가 없습니다.";
            listEl.appendChild(emptyMsg);
          }
        } else if (emptyMsg) {
          emptyMsg.remove();
        }
      };

      let providersCache = [];
      let inventoryCache = null;
      let modelProfilesCache = null; // { profiles:[{name,isDefault,description?,pool[],fallback?}], ... } 또는 null(미로드).
      let assistantName = "tiguclaw"; // 비서 표시 이름(AGENT.md 이름 → chat-history 응답, 폴백 tiguclaw).
      let selectedProviderId = null;
      let currentView = "overview";

      // 타임스탬프 — 로컬. 기존 toISOString().slice 는 UTC(한국이면 9h 어긋남)+밀리초였다.
      const tsPad = (n) => String(n).padStart(2, "0");
      // 메시지 버블 = 시각만(HH:MM:SS). 날짜는 날짜 구분선(date-divider)이 담당.
      const fmtTime = (ms) => {
        const d = new Date(ms);
        return `${tsPad(d.getHours())}:${tsPad(d.getMinutes())}:${tsPad(d.getSeconds())}`;
      };
      // 날짜 경계 판정 키(로컬 YYYY-MM-DD) + 구분선 표시 라벨(요일 포함).
      const dateKey = (ms) => {
        const d = new Date(ms);
        return `${d.getFullYear()}-${tsPad(d.getMonth() + 1)}-${tsPad(d.getDate())}`;
      };
      const fmtDate = (ms) => {
        const d = new Date(ms);
        const w = ["일", "월", "화", "수", "목", "금", "토"][d.getDay()];
        return `${dateKey(ms)} (${w})`;
      };


      // ── 세션 표시명 공유 지도 (2026-08-06) ──────────────────────────────────
      // threadKey → 서버가 정한 표시명. **채우는 곳은 한 군데**(tabs.js
      // refreshSessionPreviews — 서버 `/api/sessions` 의 전 세션을 이미 순회한다)이고,
      // 읽는 곳은 전체활동 배지와 백그라운드 잡 카드다.
      //
      // ★왜 공유인가: 소비처가 각자 이름을 파생하면 **같은 세션이 화면마다 다른 이름**으로
      //  보인다 — 대시보드 `세션3` vs 텔레그램 생키로 갈렸던 그 사고와 같은 뿌리다. 이름의
      //  정본은 서버이고(커스텀 > 첫 발화 > 폴백), 여기는 그 값을 나르는 자리일 뿐이다.
      // ★열린 탭에 없는 세션(닫은 세션·다른 채널)도 담긴다 — 백그라운드 잡은 대개
      //  "다른 세션에서 띄워놓고 잊은 것" 이라, 정작 이름이 필요한 순간이 안 보고 있는 세션이다.
      const sessionDisplayNames = new Map();

      /**
       * 서버가 아는 표시명. **모르면 빈 문자열** — 폴백을 쓸지는 호출부가 정한다.
       * (전체활동은 파생 폴백을 쓰고, 잡 카드는 지어내지 않고 배지를 생략한다.)
       */
      const sessionNameFor = (tk) => {
        if (!tk) return "";
        const fromServer = sessionDisplayNames.get(tk);
        if (fromServer) return fromServer;
        try {
          if (typeof openTabs !== "undefined") {
            const t = openTabs.find((o) => o.threadKey === tk);
            if (t && t.name) return t.name;
          }
        } catch {
          /* openTabs 미초기화(부팅 순간) — 이름 없음으로 취급 */
        }
        return "";
      };
