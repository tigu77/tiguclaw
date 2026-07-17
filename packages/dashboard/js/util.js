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

