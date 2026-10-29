      /**
       * **오른쪽 패널 둘(백그라운드 · 위젯)의 공간 판정과 폭 조절** — 한 곳 (2026-10-20, [설계](../../../docs/decisions/2026-10-20-widget-panel-design.md) §2.1).
       *
       * ★순서는 고정이다: `본문 | 백그라운드 | 위젯`. 데스크톱(901px 이상)에서 둘 다 열 수 있고, **본문이 최소폭보다 좁아지면**
       *  가장 최근에 사용자가 연(또는 폭을 조절한) 패널을 남기고 다른 쪽을 닫는다. 넓어져도 **다시 열지 않는다**(복원 상태를 들지 않는다).
       *  좁은 화면(900px 이하)은 서랍이라 **하나만** 연다. 판정은 세 진입점(열기 · 창 크기 · 폭 조절)이 전부 `sidePanels.enforce` 를 부른다.
       */
      /**
       * 본문(사이드바 오른쪽, 패널 왼쪽) 최소폭 — 헤드리스 실측(2026-10-20, 돌쇠 배포본): 채팅은 560px 까지 넘침 0(입력칸 155px),
       *  520px 에서 세션 탭 줄이 16px 넘친다. 설정·프로젝트는 440px 까지 멀쩡. (플러그인 화면은 600px 에서도 스위치가 넘친다 — 패널과 무관한 기존 결함.)
       *  ★그래서 1440px 창(사이드바 220)에선 기본 폭 두 패널(380+340)이 함께 못 선다 — 방금 연 쪽만 남는다. 1920px 이면 둘 다.
       */
      const SIDE_MIN_CONTENT_W = 560;

      /**
       * 닫을 패널 — 순수 함수. 둘 다 열렸을 때만 의미가 있다.
       * @param {{ narrow: boolean, viewport: number, sidebar: number, bg: {open:boolean,w:number}, wg: {open:boolean,w:number}, last: "bg"|"wg"|null }} s
       * @returns {"bg"|"wg"|null}
       */
      const sidePanelToClose = (s) => {
        if (!(s.bg.open && s.wg.open)) return null;
        const other = s.last === "bg" ? "wg" : "bg";
        if (s.narrow) return other;
        return s.viewport - s.sidebar - s.bg.w - s.wg.w >= SIDE_MIN_CONTENT_W ? null : other;
      };

      const sidePanels = (() => {
        /** @type {Record<string, { el: HTMLElement, cls: string, close: () => void }>} */
        const reg = {};
        let last = null;
        const state = (name) => {
          const p = reg[name];
          return { open: !!p && document.body.classList.contains(p.cls), w: p ? p.el.getBoundingClientRect().width : 0 };
        };
        const enforce = () => {
          if (!reg.bg || !reg.wg) return;
          const sb = document.getElementById("sidebar");
          const close = sidePanelToClose({
            narrow: window.matchMedia("(max-width: 900px)").matches,
            viewport: window.innerWidth,
            sidebar: sb ? sb.getBoundingClientRect().width : 0,
            bg: state("bg"),
            wg: state("wg"),
            last,
          });
          if (close) reg[close].close();
        };
        window.addEventListener("resize", enforce);
        return {
          /** @param {"bg"|"wg"} name @param {{ el: HTMLElement, cls: string, close: () => void }} p */
          register: (name, p) => { reg[name] = p; },
          /** 사용자가 이 패널을 열었다(또는 폭을 조절했다) — 이 패널을 남기는 쪽으로 판정한다. */
          used: (name) => { last = name; enforce(); },
          enforce,
        };
      })();

      /**
       * 모바일 overlay의 세로 터치 경계. contain만으로는 실제 스크롤 범위가 없는 패널에서
       * 뒤 문서로 새는 Safari가 있다. 실제 터치 대상부터 패널까지만 보고, 그 방향으로
       * 소비할 스크롤러가 없을 때만 막는다. 메뉴의 가로 닫기·탭·선택·핀치는 그대로 둔다.
       * 표식/리스너 수명은 마크업/페이지와 같다 — 열고 닫을 때 새로 등록하지 않는다.
       */
      for (const panel of document.querySelectorAll(".overlay-panel")) {
        let touch = null;
        const reset = () => { touch = null; };
        panel.addEventListener("touchstart", (e) => {
          reset();
          if (!window.matchMedia("(max-width: 900px)").matches || e.touches.length !== 1) return;
          const t = e.touches[0];
          touch = { id: t.identifier, x: t.clientX, y: t.clientY, lastY: t.clientY };
        }, { passive: true, capture: true });
        panel.addEventListener("touchmove", (e) => {
          if (!touch) return;
          const r = panel.getBoundingClientRect();
          if (!window.matchMedia("(max-width: 900px)").matches || e.touches.length !== 1 ||
              panel.getAttribute("aria-hidden") === "true" || r.right <= 0 || r.left >= window.innerWidth ||
              r.bottom <= 0 || r.top >= window.innerHeight) { reset(); return; }
          const t = e.touches[0];
          if (t.identifier !== touch.id) { reset(); return; }
          const dy = t.clientY - touch.lastY;
          touch.lastY = t.clientY;
          if (!dy || Math.abs(t.clientX - touch.x) >= Math.abs(t.clientY - touch.y)) return;
          const selection = window.getSelection();
          // 남은 선택만으로 패널 전체를 해제하지 않는다 — 이번 시작점이 선택 텍스트 위일 때만 보호.
          if (selection && !selection.isCollapsed && selection.rangeCount && panel.contains(selection.anchorNode) &&
              [...selection.getRangeAt(0).getClientRects()].some(r =>
                touch.x >= r.left && touch.x <= r.right && touch.y >= r.top && touch.y <= r.bottom)) return;
          let el = e.target.nodeType === 1 ? e.target : e.target.parentElement;
          if (!panel.contains(el)) { reset(); return; }
          for (; el; el = el.parentElement) {
            const style = getComputedStyle(el);
            if (/^(auto|scroll|overlay)$/.test(style.overflowY) && el.scrollHeight > el.clientHeight &&
                (dy > 0 ? el.scrollTop > 0 : el.scrollTop < el.scrollHeight - el.clientHeight)) return;
            if (el === panel) break;
          }
          if (e.cancelable) e.preventDefault();
        }, { passive: false, capture: true });
        panel.addEventListener("touchend", reset, { passive: true, capture: true });
        panel.addEventListener("touchcancel", reset, { passive: true, capture: true });
      }

      /**
       * 패널 왼쪽 가장자리 손잡이로 폭 조절 — bg·위젯 공통.
       * ★폭 = **드래그 시작 폭 + 포인터 이동량**. 종전 bg 의 `innerWidth - clientX` 는 «패널이 창 오른쪽 끝» 전제라, 위젯 패널이 그 오른쪽에
       *  붙으면 바깥 패널 폭까지 섞였다(아스트라 10-20).
       * @param {{ panel: HTMLElement, handle: HTMLElement, key: string, cssVar: string, name: "bg"|"wg" }} o
       */
      const attachPanelResize = (o) => {
        const apply = (w) => {
          const cw = clampDrawerWidth(w);
          o.panel.style.width = cw + "px";
          document.body.style.setProperty(o.cssVar, cw + "px");
        };
        try {
          const saved = parseInt(localStorage.getItem(o.key) || "", 10);
          if (Number.isFinite(saved)) apply(saved);
        } catch { /* 저장소 못 읽음 — 기본 폭 */ }
        let drag = null;
        window.addEventListener("mousemove", (e) => {
          if (drag) apply(drag.w + (drag.x - e.clientX));
        });
        window.addEventListener("mouseup", () => {
          if (!drag) return;
          drag = null;
          o.handle.classList.remove("dragging");
          document.body.classList.remove("panel-resizing");
          try { localStorage.setItem(o.key, String(parseInt(o.panel.style.width, 10))); } catch { /* quota·프라이빗 */ }
          sidePanels.used(o.name);
        });
        o.handle.addEventListener("mousedown", (e) => {
          e.preventDefault();
          drag = { x: e.clientX, w: o.panel.getBoundingClientRect().width };
          o.handle.classList.add("dragging");
          document.body.classList.add("panel-resizing");
        });
        return { apply };
      };
