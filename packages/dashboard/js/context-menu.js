      // ── 확장 가능 컨텍스트메뉴 프리미티브 ────────────────────────────────────
      // 계약: _workspace/context-menu_architect_contract.md. 프리미티브 하나(이 파일) + 뷰별
      // provider 등록(§2.1) — 코어는 ctx.type 으로 switch 하지 않는다(provider 맵 lookup 만,
      // §0 단방향 준수). 채팅 #stream·가상화·누수가드 미접촉(이 파일은 오버레이 하나만 소유).
      // 로드순서: util.js 직후(뷰 모듈들이 registerMenuItems 호출하려면 이 파일이 먼저 실행돼야
      // 함) — js/_manifest.json + index.html 순서 참조.

      // type -> Set<providerFn>. providerFn(ctx) => MenuItem[](동기, 열 때마다 호출).
      const menuProviders = new Map();
      // handler name -> fn(ctx, args). kind:"builtin" 액션이 이 이름으로 조회(코어는 handler
      // 구현을 모름 — 각 뷰 모듈이 자기 이름으로 등록, §0 준수).
      const builtinHandlers = new Map();

      const registerMenuItems = (type, providerFn) => {
        if (typeof type !== "string" || type === "" || typeof providerFn !== "function") return;
        if (!menuProviders.has(type)) menuProviders.set(type, new Set());
        menuProviders.get(type).add(providerFn);
      };

      const registerBuiltinHandler = (name, fn) => {
        if (typeof name !== "string" || name === "" || typeof fn !== "function") return;
        builtinHandlers.set(name, fn);
      };

      // ── 외부 기여(§2.3) — 기동 시 1회 fetch·캐시. 404/빈응답/네트워크실패 = graceful(빈 맵).
      // 백엔드가 아직 없어도(엔드포인트 미구현) 무해 — catch 로 조용히 빈 상태 유지.
      // 외부 기여 인덱스 — type -> MenuItem[]. 실제 엔드포인트(plugins/http-bridge) 응답 shape 은
      // 평탄 배열 `{ items: [{ id, type, label, icon?, action, group?, danger? }, …] }`(각 항목이
      // 자기 type 을 실음) — fetch 직후 type 별로 인덱싱해 둔다. 구버전/그룹 shape(`{ [type]:
      // MenuItem[] }`)도 방어적으로 함께 받아준다(그대로 merge, 어느 쪽이 와도 무해).
      let externalMenuIndex = new Map(); // type -> MenuItem[]
      let externalMenuFetched = false;
      const indexExternalMenuItems = (data) => {
        const idx = new Map();
        const addTo = (type, item) => {
          if (typeof type !== "string" || type === "" || !item) return;
          if (!idx.has(type)) idx.set(type, []);
          idx.get(type).push(item);
        };
        if (data && Array.isArray(data.items)) {
          for (const it of data.items) if (it && typeof it.type === "string") addTo(it.type, it);
        } else if (data && typeof data === "object" && !Array.isArray(data)) {
          // 방어적 폴백 — { [type]: MenuItem[] } 그룹 shape.
          for (const [type, arr] of Object.entries(data)) {
            if (Array.isArray(arr)) for (const it of arr) addTo(type, it);
          }
        }
        return idx;
      };
      const fetchExternalMenuItems = () => {
        if (externalMenuFetched) return;
        externalMenuFetched = true;
        fetch("/api/context-menu-items")
          .then((r) => (r.ok ? r.json() : null))
          .then((data) => { externalMenuIndex = indexExternalMenuItems(data); })
          .catch(() => { externalMenuIndex = new Map(); });
      };
      fetchExternalMenuItems();

      // 항목 수집(§1.2) — 등록 provider(들) concat + 외부 기여(type 매칭) append. 외부 항목은
      // contributed:true 로 태깅(실행 시 보안 경계 재확인용, executeMenuAction 참조).
      const collectMenuItems = (type, ctx) => {
        const items = [];
        const set = menuProviders.get(type);
        if (set) for (const fn of set) {
          try {
            const got = fn(ctx) || [];
            for (const it of got) if (it) items.push(it);
          } catch (err) {
            console.warn("context-menu: provider 실패(" + type + "):", err && err.message ? err.message : err);
          }
        }
        const ext = externalMenuIndex.get(type);
        if (ext) for (const it of ext) if (it) items.push(Object.assign({}, it, { contributed: true, group: it.group || "external" }));
        return items;
      };

      // ── 렌더 + 위치 + teardown ────────────────────────────────────────────
      let menuEl = null;
      let menuTeardown = null;
      let menuFocusIndex = -1;

      const closeMenu = () => {
        if (menuTeardown) { try { menuTeardown(); } catch {} menuTeardown = null; }
        if (menuEl && menuEl.parentElement) menuEl.parentElement.removeChild(menuEl);
        menuEl = null;
        menuFocusIndex = -1;
      };

      // 외부 기여 데이터가 endpoint/builtin 을 갖고 들어와도(백엔드가 이미 drop 하지만 belt-and-
      // suspenders, §0 코어는 데이터를 무조건 신뢰하지 않는다) 프론트에서도 재차 차단.
      const executeMenuAction = async (item, ctx) => {
        const action = item && item.action;
        if (!action || typeof action.kind !== "string") return;
        if (item.contributed && (action.kind === "endpoint" || action.kind === "builtin")) {
          console.warn("context-menu: 외부 기여 항목이 금지된 action(" + action.kind + ") 시도 — 무시");
          return;
        }
        try {
          if (action.kind === "builtin") {
            const fn = builtinHandlers.get(action.handler);
            if (fn) await fn(ctx, action.args || {});
            else console.warn("context-menu: 미등록 builtin handler:", action.handler);
          } else if (action.kind === "navigate") {
            const view = action.view, tab = action.tab, drawer = action.drawer;
            if (view && typeof setActiveNav === "function") {
              setActiveNav(view);
              if (typeof setChatPanel === "function" && view === "chat") setChatPanel("chat");
            }
            if (tab && typeof setActiveTab === "function") setActiveTab(tab);
            if (drawer === "background" && typeof openBg === "function") openBg();
          } else if (action.kind === "send_message" || action.kind === "invoke_skill") {
            // §2.4 — 템플릿은 ${label}/${targetId} 단순 치환만(엔진 금지, Q6 가드). invoke_skill 은
            // 고정 문구로 정규화. 전부 POST /api/messages(threadKey=ctx) — 모델 매개, 기존 승인/
            // 권한 게이트가 그대로 적용된다(§3). 기존 sendChatMessage(activeThreadKey 고정)와 달리
            // ctx.threadKey 를 명시 지정(잡/활동처럼 활성 탭과 다른 세션을 겨눌 수 있어 직접 POST).
            const label = ctx && ctx.label ? ctx.label : (ctx && ctx.targetId ? ctx.targetId : "");
            const targetId = ctx && ctx.targetId ? ctx.targetId : "";
            const text = action.kind === "invoke_skill"
              ? (String(action.skill || "") + " 스킬을 이 " + (ctx && ctx.type ? ctx.type : "대상") + "(" + label + ")에 실행")
              : String(action.template || "").replace(/\$\{label\}/g, label).replace(/\$\{targetId\}/g, targetId);
            if (text.trim() === "") return;
            const threadKey = (ctx && ctx.threadKey) || (typeof activeThreadKey !== "undefined" ? activeThreadKey : undefined);
            const correlationId = (self.crypto && self.crypto.randomUUID)
              ? self.crypto.randomUUID()
              : (String(Date.now()) + "-" + Math.random().toString(16).slice(2));
            await fetch("/api/messages", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ text, threadKey, correlationId }),
            });
          } else if (action.kind === "endpoint") {
            if (action.method !== "POST" || typeof action.path !== "string") return;
            await fetch(action.path, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(action.body || {}),
            });
          }
        } catch (err) {
          console.warn("context-menu: action 실행 실패:", err && err.message ? err.message : err);
        }
      };

      const runMenuItem = async (item, ctx) => {
        if (item.enabled === false) return;
        if (item.danger && !window.confirm((item.label || "이 작업") + " — 계속할까요?")) return;
        closeMenu(); // §1.3 — 실행 시 항상 닫음(성공/실패 무관, 에러는 메뉴 밖 토스트/로컬챗에 표기).
        await executeMenuAction(item, ctx);
      };

      // group 정렬 — 등장 순서 유지, danger 는 강제로 맨 끝 그룹(§1.2). 그룹 사이 구분선.
      const buildMenuDom = (items, ctx) => {
        const el = document.createElement("div");
        el.className = "ctx-menu";
        el.setAttribute("role", "menu");
        const groups = new Map();
        const order = [];
        for (const it of items) {
          const g = it.danger ? "__danger__" : (it.group || "default");
          if (!groups.has(g)) { groups.set(g, []); order.push(g); }
          groups.get(g).push(it);
        }
        if (groups.has("__danger__")) {
          order.splice(order.indexOf("__danger__"), 1);
          order.push("__danger__");
        }
        order.forEach((g, gi) => {
          if (gi > 0) {
            const sep = document.createElement("div");
            sep.className = "cm-sep";
            el.appendChild(sep);
          }
          for (const it of groups.get(g)) {
            const enabled = it.enabled !== false;
            const row = document.createElement("div");
            row.className = "cm-item" + (it.danger ? " cm-danger" : "") + (enabled ? "" : " cm-disabled");
            row.setAttribute("role", "menuitem");
            row.tabIndex = -1;
            if (it.icon) {
              const ic = document.createElement("span"); ic.className = "cm-icon"; ic.textContent = it.icon;
              row.appendChild(ic);
            }
            const lb = document.createElement("span"); lb.className = "cm-label"; lb.textContent = it.label || it.id || "";
            row.appendChild(lb);
            if (enabled) {
              row.addEventListener("click", (ev) => { ev.stopPropagation(); void runMenuItem(it, ctx); });
            }
            el.appendChild(row);
          }
        });
        return el;
      };

      // 위치 — anchor rect 또는 pos 좌표 기준, 뷰포트 클램프(넘치면 flip). anchor 우선(opts.anchor).
      const positionMenu = (el, opts) => {
        document.body.appendChild(el); // 크기 측정 위해 먼저 붙임.
        const vw = window.innerWidth, vh = window.innerHeight;
        let x, y;
        if (opts.anchor && typeof opts.anchor.getBoundingClientRect === "function") {
          const r = opts.anchor.getBoundingClientRect();
          x = opts.align === "end" ? r.right : r.left;
          y = r.bottom + 4;
        } else if (opts.pos) {
          x = opts.pos.x; y = opts.pos.y;
        } else {
          x = vw / 2; y = vh / 2;
        }
        const rect = el.getBoundingClientRect();
        if (x + rect.width > vw - 8) x = Math.max(8, vw - rect.width - 8);
        if (y + rect.height > vh - 8) {
          if (opts.anchor && typeof opts.anchor.getBoundingClientRect === "function") {
            const r = opts.anchor.getBoundingClientRect();
            y = Math.max(8, r.top - rect.height - 4);
          } else {
            y = Math.max(8, y - rect.height);
          }
        }
        if (x < 8) x = 8;
        if (y < 8) y = 8;
        el.style.left = x + "px";
        el.style.top = y + "px";
      };

      // teardown — 바깥 클릭(capture pointerdown)·Esc·스크롤/리사이즈, 단일 해제 함수로 묶는다
      // (누수 0, §1.3). 키보드: ↑/↓ 이동, Enter 실행, Esc 닫기.
      const attachMenuBehavior = (el) => {
        const onDocPointerDown = (ev) => { if (!el.contains(ev.target)) closeMenu(); };
        const onKeydown = (ev) => {
          const focusable = Array.from(el.querySelectorAll(".cm-item:not(.cm-disabled)"));
          if (ev.key === "Escape") { ev.preventDefault(); closeMenu(); return; }
          if (!focusable.length) return;
          if (ev.key === "ArrowDown") {
            ev.preventDefault();
            menuFocusIndex = (menuFocusIndex + 1) % focusable.length;
            focusable[menuFocusIndex].focus();
          } else if (ev.key === "ArrowUp") {
            ev.preventDefault();
            menuFocusIndex = (menuFocusIndex - 1 + focusable.length) % focusable.length;
            focusable[menuFocusIndex].focus();
          } else if (ev.key === "Enter") {
            ev.preventDefault();
            if (menuFocusIndex >= 0 && focusable[menuFocusIndex]) focusable[menuFocusIndex].click();
          }
        };
        const onScrollOrResize = () => closeMenu();
        document.addEventListener("pointerdown", onDocPointerDown, true);
        document.addEventListener("keydown", onKeydown, true);
        window.addEventListener("scroll", onScrollOrResize, true); // capture — 내부 스크롤 컨테이너도.
        window.addEventListener("resize", onScrollOrResize);
        return () => {
          document.removeEventListener("pointerdown", onDocPointerDown, true);
          document.removeEventListener("keydown", onKeydown, true);
          window.removeEventListener("scroll", onScrollOrResize, true);
          window.removeEventListener("resize", onScrollOrResize);
        };
      };

      // ── 공개 진입점 ───────────────────────────────────────────────────────
      // openMenu(type, ctx, opts) — type=ctx.type(provider 매칭 키), opts={anchor|pos, align?}.
      const openMenu = (type, ctx, opts) => {
        closeMenu(); // 한 번에 한 메뉴만(§1.3).
        const safeCtx = (ctx && typeof ctx === "object") ? ctx : {};
        if (!safeCtx.type) safeCtx.type = type;
        const items = collectMenuItems(type, safeCtx);
        if (!items.length) return;
        const el = buildMenuDom(items, safeCtx);
        positionMenu(el, opts || {});
        menuTeardown = attachMenuBehavior(el);
        menuEl = el;
        const first = el.querySelector(".cm-item:not(.cm-disabled)");
        if (first) { menuFocusIndex = 0; first.focus(); }
      };

      // ── 트리거 헬퍼(§1.1) — 한 곳에서 재사용, 각자 openMenu 호출 ──────────────
      // ctxFn(ev) => MenuContext(위임 안전 — 이벤트 시점에 대상 컨텍스트 생성).
      // ★<span role="button">(<button> 아님) — 세션 탭처럼 hostEl 자체가 <button> 인 경우가 있어
      // (nested <button> 은 무효 HTML·클릭 버블 꼬임) 기존 .st-x(탭 닫기) 컨벤션과 동일하게 span
      // 으로 클릭·키보드(Enter/Space) 를 직접 배선한다.
      /**
       * ⋯ 메뉴 버튼을 카드에 붙인다.
       *
       * ★`opts.first` = 흐름 **맨 앞**에 넣는다. sticky+float 로 우상단에 띄우려면 흐름의
       *  처음에 있어야 한다(뒤에 있으면 그 위치부터 떠서 본문 아래로 내려간다).
       *  절대배치 시절엔 순서가 무관했다 — 그래서 append 였다.
       */
      const attachKebab = (hostEl, type, ctxFn, opts) => {
        if (!hostEl) return null;
        const btn = document.createElement("span");
        btn.className = "cm-kebab"; btn.textContent = "⋯"; btn.title = "메뉴";
        btn.setAttribute("role", "button"); btn.tabIndex = 0;
        const trigger = (ev) => {
          ev.stopPropagation();
          if (ev.preventDefault) ev.preventDefault();
          const ctx = ctxFn(ev);
          if (ctx) openMenu(type, ctx, { anchor: btn, align: "end" });
        };
        btn.addEventListener("click", trigger);
        btn.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") trigger(ev); });
        if (opts && opts.first === true && hostEl.firstChild) hostEl.insertBefore(btn, hostEl.firstChild);
        else hostEl.appendChild(btn);
        return btn;
      };

      // pointerdown(터치/펜만 — 마우스는 우클릭 경로와 중복이라 제외) ~500ms. pointermove 가
      // 임계(≈10px) 넘으면 스크롤로 간주해 취소(§1.3 충돌 회피). 메뉴 뜬 뒤에만 선택 억제되므로
      // 스크롤·텍스트 선택 방해 0.
      const attachLongPress = (el, type, ctxFn) => {
        if (!el) return;
        let timer = null, startX = 0, startY = 0, moved = false;
        const THRESH = 10, DURATION = 500;
        const clear = () => { if (timer) { clearTimeout(timer); timer = null; } };
        el.addEventListener("pointerdown", (ev) => {
          if (ev.pointerType === "mouse") return;
          moved = false; startX = ev.clientX; startY = ev.clientY;
          clear();
          timer = setTimeout(() => {
            timer = null;
            if (moved) return;
            const ctx = ctxFn(ev);
            if (ctx) openMenu(type, ctx, { pos: { x: ev.clientX, y: ev.clientY } });
          }, DURATION);
        });
        el.addEventListener("pointermove", (ev) => {
          if (!timer) return;
          if (Math.abs(ev.clientX - startX) > THRESH || Math.abs(ev.clientY - startY) > THRESH) { moved = true; clear(); }
        });
        el.addEventListener("pointerup", clear);
        el.addEventListener("pointercancel", clear);
        el.addEventListener("pointerleave", clear);
      };

      const attachContextMenu = (el, type, ctxFn) => {
        if (!el) return;
        el.addEventListener("contextmenu", (ev) => {
          ev.preventDefault();
          const ctx = ctxFn(ev);
          if (ctx) openMenu(type, ctx, { pos: { x: ev.clientX, y: ev.clientY } });
        });
      };
