      // ── 위젯 패널 (2026-10-20, docs/decisions/2026-10-20-widget-panel-design.md) ──────────────
      //
      // ★홈 화면의 위젯 영역이 **어디서나 열리는 오른쪽 패널**로 옮겨왔다(정태님: «홈이 굳이 의미가 없다, 채팅이 거의 메인»).
      //  위젯·선언·마운트(`widgetHost.mount`)·배치 도구(`configure_home`)·저장(`dashboard.home.widgets`)은 그대로다 —
      //  바뀐 것은 그리는 자리와 수명뿐이다.
      // ★**수명 — 열면 붙이고, 닫으면 뗀다.** 닫을 때 목록을 DOM 에서 지워야 `widgetHost` 가 위젯의 타이머·구독을 회수한다
      //  (CSS 로 숨기기만 하면 안 치워진다). 화면 이동(홈→채팅→설정)은 패널과 무관하다 — 셸에 있으므로 다시 마운트하지 않는다.
      // ★**늦은 응답은 세대로 버린다.** 열 때·닫을 때마다 `gen` 이 오른다. 닫기 전에 떠난 요청이 닫은 뒤(또는 다시 연 뒤) 도착해도
      //  자기 세대가 아니면 그리지 않는다 — 옛 응답이 새 인스턴스를 덮지 않는다.
      // ★**숨은 탭에선 쉰다.** 위젯 하나가 곧 주기적인 데몬 요청 하나라, 패널을 어디서나 열어 두게 되면서(종전: 홈에 있는 동안만)
      //  열린 시간이 길어졌다. 보이지 않는 탭은 조회를 멈추고, 다시 보이면 **한 번** 갱신한다(놓친 주기를 몰아서 돌리지 않는다).
      // ★**데이터 라우트 이름 = 위젯 이름**(관례, 종전 홈과 같다). 라우트가 없는 위젯은 값 없이 마운트한다(live — 스스로 구독).
      const WIDGET_POLL_MS = 5 * 60 * 1000;
      const WIDGET_LAYOUT_POLL_MS = 30 * 1000;
      const WG_OPEN_LS = "dash.wgOpen.v1";

      const widgetPanel = (() => {
        const panel = document.getElementById("widget-panel");
        const list = document.getElementById("wg-list");
        if (!panel || !list) return { open: () => {}, close: () => {}, isOpen: () => false };
        /** 열기·닫기마다 오른다 — 늦은 응답 판정. */
        let gen = 0;
        let timers = [];
        /** 서버가 준 배치. null = 아직 못 받음. */
        let layout = null;
        let dataRoutes = [];
        /** id → 마지막으로 받은 값(다시 그릴 때 깜빡이지 않게). */
        const values = new Map();
        /** 지금 그려 둔 배치 — 같으면 다시 그리지 않는다. */
        let paintedSig = null;
        const sigOf = () => JSON.stringify([layout, dataRoutes]);
        /**
         * 위젯 하나의 «무엇을 보여 주나» — 종류 + 설정. 값은 이 표시와 함께 둔다(아스트라 10-21: 같은 id 의 설정을 A→B 로 바꾼 뒤
         *  늦게 온 A 응답이 B 를 덮고 A 로 다시 마운트했다 — 세대는 열기·닫기만 갈라 설정 변경을 못 봤다).
         */
        const wSig = (w) => JSON.stringify([w.type, w.config || {}]);
        const isOpen = () => document.body.classList.contains("wg-open");
        const live = (g) => g === gen && isOpen();
        const stopTimers = () => {
          for (const t of timers) clearInterval(t);
          timers = [];
        };
        const remember = (on) => {
          try { localStorage.setItem(WG_OPEN_LS, on ? "1" : "0"); } catch { /* quota·프라이빗 */ }
        };

        /** 위젯 하나를 그린다 — 값이 없으면 «받아오는 중», 실패면 한 줄. */
        const paint = (item, w) => {
          const prev = item.querySelector(".wg-body");
          // ★제거가 먼저 — 관측자가 그때 회수한다(새 노드를 먼저 붙이면 같은 위젯이 잠깐 둘이 된다).
          if (prev) prev.remove();
          const box = document.createElement("div");
          box.className = "wg-body";
          box.dataset.widget = w.type; // 조상이 통째로 지워질 때도 회수되게(sweep 이 이 속성으로 찾는다)
          item.appendChild(box);
          if (!dataRoutes.includes(w.type)) {
            void widgetHost.mount(box, { widget: w.type, data: null });
            return;
          }
          // 지금 설정으로 받은 값만 쓴다 — 바뀌기 전 설정의 값은 «받아오는 중» 으로 본다.
          const kept = values.get(w.id);
          const state = kept !== undefined && kept.sig === wSig(w) ? kept : undefined;
          if (state === undefined || state.error) {
            box.classList.add("wg-note");
            box.textContent = i18n(state === undefined ? "wg.loading" : "wg.failed");
            return;
          }
          void widgetHost.mount(box, { widget: w.type, data: state.data });
        };
        const itemOf = (id) => list.querySelector('.wg-item[data-id="' + CSS.escape(id) + '"]');
        /**
         * 목록을 비운다 — ★위젯 상자(`.wg-body`)를 **먼저 하나씩 뗀다**. 목록째 지우면 상자의 부모(`.wg-item`)가 남아 있어, 호스트가
         *  «다시 붙을 수 있다» 고 보고 대기줄에 되돌린다 → 영영 안 붙는 대기분 때문에 문서 전체 관측자가 꺼지지 않았다(레드팀 10-20).
         */
        const clearList = () => {
          for (const b of [...list.querySelectorAll(".wg-body")]) b.remove();
          list.textContent = "";
        };

        /** 값을 받아온다. ★외부는 데몬이 부른다 — 브라우저는 우리 오리진만 만진다. */
        const refresh = async (w, g) => {
          const slash = w.type.indexOf("/");
          const qs = new URLSearchParams();
          for (const [k, v] of Object.entries(w.config || {})) qs.set(k, String(v));
          const url =
            "/api/plugin-data/" + encodeURIComponent(w.type.slice(0, slash)) + "/" + encodeURIComponent(w.type.slice(slash + 1)) +
            (qs.toString() ? "?" + qs.toString() : "");
          let next;
          try {
            const r = await fetch(url, { cache: "no-store" });
            const j = await r.json();
            if (!r.ok) throw new Error(j && j.error ? j.error : "HTTP " + r.status);
            next = { data: j.data };
          } catch (e) {
            // ★하나가 실패해도 나머지는 산다. 사유는 콘솔에, 화면엔 한 줄.
            console.warn("[widget] " + w.type + " 값을 못 받았습니다:", e);
            next = { error: true };
          }
          if (!live(g)) return; // 닫혔거나 다시 열렸다 — 옛 응답
          // 요청을 보낸 뒤 그 위젯의 종류·설정이 바뀌었으면(또는 빠졌으면) 옛 설정의 응답이다 — 버린다.
          const cur = (layout || []).find((x) => x.id === w.id);
          if (cur === undefined || wSig(cur) !== wSig(w)) return;
          values.set(w.id, { ...next, sig: wSig(w) });
          const item = itemOf(w.id);
          if (item) paint(item, w);
        };

        /** 목록을 새로 그린다(배치가 바뀌었을 때·열 때). */
        const render = () => {
          clearList(); // ★DOM 에서 떼야 호스트가 옛 위젯을 회수한다
          paintedSig = sigOf();
          if (!Array.isArray(layout) || layout.length === 0) {
            const empty = document.createElement("div");
            empty.className = "wg-empty";
            empty.textContent = i18n(layout === null ? "wg.loading" : "wg.empty");
            list.appendChild(empty);
            return;
          }
          for (const w of layout) {
            const item = document.createElement("div");
            item.className = "wg-item";
            item.dataset.id = w.id;
            const handle = document.createElement("button");
            handle.type = "button";
            handle.className = "wg-handle";
            handle.textContent = "⋯⋯";
            handle.title = i18n("wg.handle");
            handle.setAttribute("aria-label", i18n("wg.handle"));
            item.appendChild(handle);
            list.appendChild(item);
          }
          // ★그리는 건 문서에 붙은 뒤 — 붙기 전에 마운트하면 호스트 대기줄에 갇힐 수 있다.
          for (const w of layout) {
            const item = itemOf(w.id);
            if (item) paint(item, w);
          }
        };

        /** 배치를 받아온다. 바뀌었을 때만 다시 그린다. */
        const loadLayout = async (g) => {
          let next;
          let routes;
          try {
            const r = await fetch("/api/home-widgets", { cache: "no-store" });
            // ★실패 응답(HTTP 500 의 `{error}`)을 «빈 목록» 으로 읽지 않는다 — 위젯이 전부 사라져 보였다(아스트라 10-21). 지금 그림을 둔다.
            if (!r.ok) return;
            const j = await r.json();
            next = Array.isArray(j.widgets) ? j.widgets : [];
            routes = Array.isArray(j.dataRoutes) ? j.dataRoutes : [];
          } catch {
            return; // 못 받으면 지금 그림을 그대로 둔다
          }
          if (!live(g)) return;
          layout = next;
          dataRoutes = routes;
          const ids = new Set(next.map((w) => w.id));
          for (const id of [...values.keys()]) if (!ids.has(id)) values.delete(id);
          if (paintedSig !== sigOf()) {
            render();
            startPolls(g);
          }
        };

        /** 조회 타이머 — 한 벌만. 걸 때 한 번씩 바로 받는다. */
        const startPolls = (g) => {
          stopTimers();
          if (document.hidden) return; // 숨은 탭 — 보이면 visibilitychange 가 건다
          for (const w of layout || []) {
            if (!dataRoutes.includes(w.type)) continue; // live 위젯은 받을 게 없다
            void refresh(w, g);
            timers.push(setInterval(() => void refresh(w, gen), WIDGET_POLL_MS));
          }
          timers.push(setInterval(() => void loadLayout(gen), WIDGET_LAYOUT_POLL_MS));
        };

        const open = () => {
          if (isOpen()) return;
          document.body.classList.add("wg-open");
          panel.setAttribute("aria-hidden", "false");
          remember(true);
          gen += 1;
          const g = gen;
          render();
          startPolls(g);
          void loadLayout(g);
          sidePanels.used("wg");
        };
        /** @param {boolean} [keepRemembered] 자리가 모자라 닫는 것(side-panels) — 사용자가 닫은 게 아니므로 «열려 있었다» 기억은 그대로 둔다. */
        const close = (keepRemembered) => {
          if (!isOpen()) return;
          document.body.classList.remove("wg-open");
          panel.setAttribute("aria-hidden", "true");
          if (keepRemembered !== true) remember(false);
          gen += 1;
          stopTimers();
          clearList(); // 위젯 회수(타이머·구독)
          paintedSig = null;
        };

        document.addEventListener("visibilitychange", () => {
          if (!isOpen()) return;
          if (document.hidden) stopTimers();
          else { startPolls(gen); void loadLayout(gen); }
        });

        // ── 끌어서 순서 바꾸기(손잡이로만) · 키보드 ↑↓ ─────────────────────────────────
        // ★순서는 서버의 의미 데이터다 — 비서의 «날씨를 맨 위로» 와 같은 값을 손으로 쓴다. 놓으면 id 순서를 보내고,
        //  서버가 «지금 보이는 집합의 순열» 일 때만 받는다(409 = 그새 바뀜 → 최신을 다시 읽는다). 낙관적으로 옮겨 두고
        //  실패하면 서버 목록으로 되돌린다.
        const saveOrder = async () => {
          const g = gen;
          const order = [...list.querySelectorAll(".wg-item")].map((e) => e.dataset.id);
          let ok = false;
          let conflict = false;
          try {
            const r = await fetch("/api/home-widgets/order", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ order }),
            });
            ok = r.ok;
            conflict = r.status === 409;
          } catch { /* 아래에서 되돌린다 */ }
          if (!live(g)) return;
          if (ok) {
            const byId = new Map((layout || []).map((w) => [w.id, w]));
            layout = order.map((id) => byId.get(id)).filter(Boolean);
            paintedSig = sigOf(); // 화면이 이미 이 순서다 — 다시 그리지 않는다
            return;
          }
          try { showToast(i18n(conflict ? "wg.reorderConflict" : "wg.reorderFailed"), "warn"); } catch { /* noop */ }
          paintedSig = null;
          await loadLayout(g);
          if (live(g) && paintedSig === null) render();
        };
        /** item 을 before 앞으로(null 이면 맨 끝). 실제로 움직였으면 true. */
        const moveItem = (item, before) => {
          if (before === item || item.nextElementSibling === before) return false;
          list.insertBefore(item, before);
          return true;
        };

        let drag = null;
        list.addEventListener("pointerdown", (e) => {
          const handle = e.target && typeof e.target.closest === "function" ? e.target.closest(".wg-handle") : null;
          if (!handle) return; // 손잡이가 아니면 평소대로(스크롤·위젯 조작)
          const item = handle.closest(".wg-item");
          if (!item) return;
          e.preventDefault();
          drag = { item, target: null, after: false };
          item.classList.add("dragging");
          try { handle.setPointerCapture(e.pointerId); } catch { /* noop */ }
        });
        const clearMarks = () => {
          for (const el of list.querySelectorAll(".drop-before, .drop-after")) el.classList.remove("drop-before", "drop-after");
        };
        list.addEventListener("pointermove", (e) => {
          if (!drag) return;
          clearMarks();
          const others = [...list.querySelectorAll(".wg-item")].filter((el) => el !== drag.item);
          let target = null;
          let after = false;
          for (const el of others) {
            const r = el.getBoundingClientRect();
            if (e.clientY < r.top + r.height / 2) { target = el; after = false; break; }
            target = el;
            after = true;
          }
          drag.target = target;
          drag.after = after;
          if (target) target.classList.add(after ? "drop-after" : "drop-before");
        });
        const endDrag = (commit) => {
          if (!drag) return;
          const { item, target, after } = drag;
          drag = null;
          item.classList.remove("dragging");
          clearMarks();
          if (!commit || !target) return;
          // ★끄는 사이 목록이 다시 그려졌으면(배치 조회·비서 변경) 잡고 있던 노드는 이미 떨어져 있다 — 그걸 새 목록에 끼우면 같은 위젯이
          //  둘이 되고 순서에 같은 id 가 두 번 실렸다(레드팀 10-20). 그 끌기는 버린다(새 목록이 진실이다).
          if (item.parentNode !== list || target.parentNode !== list) return;
          if (moveItem(item, after ? target.nextElementSibling : target)) void saveOrder();
        };
        list.addEventListener("pointerup", () => endDrag(true));
        list.addEventListener("pointercancel", () => endDrag(false));
        // 손잡이가 다시 그리기로 사라지면 포인터 캡처가 풀린다 — 끌기 상태를 남기지 않는다.
        list.addEventListener("lostpointercapture", () => endDrag(false));
        list.addEventListener("keydown", (e) => {
          const handle = e.target && typeof e.target.closest === "function" ? e.target.closest(".wg-handle") : null;
          if (!handle || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
          const item = handle.closest(".wg-item");
          if (!item) return;
          e.preventDefault();
          const moved = e.key === "ArrowUp"
            ? item.previousElementSibling ? moveItem(item, item.previousElementSibling) : false
            : item.nextElementSibling ? moveItem(item, item.nextElementSibling.nextElementSibling) : false;
          if (moved) { handle.focus(); void saveOrder(); }
        });

        sidePanels.register("wg", { el: panel, cls: "wg-open", close: () => close(true) });
        const toggle = document.getElementById("wg-toggle");
        if (toggle) toggle.addEventListener("click", () => (isOpen() ? close() : open()));
        const closeBtn = document.getElementById("wg-close");
        if (closeBtn) closeBtn.addEventListener("click", () => close());
        const backdrop = document.getElementById("wg-backdrop");
        if (backdrop) backdrop.addEventListener("click", () => close());
        const handle = document.getElementById("wg-resize");
        if (handle) attachPanelResize({ panel, handle, key: "tc:wgPanelWidth", cssVar: "--wg-panel-w", name: "wg" });
        // 부팅 복원 — PC 만(좁은 화면에선 서랍이 전면을 덮는다). ★다른 스크립트(widgetHost 등)가 다 실린 뒤에 연다.
        document.addEventListener("DOMContentLoaded", () => {
          try {
            if (localStorage.getItem(WG_OPEN_LS) === "1" && !window.matchMedia("(max-width: 900px)").matches) open();
          } catch { /* 닫힌 채 시작 */ }
        });
        return { open, close: () => close(), isOpen };
      })();
