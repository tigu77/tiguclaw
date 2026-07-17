      // 사이드바 접기 토글 — 넓은(그리드) 레이아웃에서 사이드바를 아이콘 레일로 줄여 콘텐츠 폭
      // 확보. body.nav-collapsed + localStorage 영속. 모바일(≤900)에선 CSS 가 토글을 숨김.
      (() => {
        const btn = document.getElementById("nav-collapse");
        if (!btn) return;
        const KEY = "nav-collapsed";
        const apply = (collapsed) => {
          document.body.classList.toggle("nav-collapsed", collapsed);
          btn.textContent = collapsed ? "»" : "«";
          btn.setAttribute("aria-label", collapsed ? "메뉴 펼치기" : "메뉴 접기");
        };
        apply(localStorage.getItem(KEY) === "1");
        btn.addEventListener("click", () => {
          const collapsed = !document.body.classList.contains("nav-collapsed");
          apply(collapsed);
          try { localStorage.setItem(KEY, collapsed ? "1" : "0"); } catch {}
        });
      })();

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

      const kindLabel = (kind) => {
        const map = {
          provider: "프로바이더",
          core: "코어",
          plugin: "플러그인",
          runtime: "런타임",
          system: "시스템",
          daemon: "데몬",
          memory: "메모리",
          schedule: "스케줄",
        };
        return map[kind] || kind || "프로바이더";
      };

      const statusLabel = (status) => {
        const map = { active: "정상", degraded: "주의", error: "오류", unknown: "알 수 없음" };
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

