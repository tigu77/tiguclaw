      // ── 메인 메뉴 접기(아이콘 레일) — 넓은 화면(901px 이상)만 (2026-11-01, [설계](../../../docs/decisions/2026-10-31-main-menu-collapse-design.md)) ──
      // ★상태는 한 곳 — `body.nav-rail` 클래스가 «접혔다» 의 유일한 표식이고, 바꾸는 곳은 아래 `setNavRail` 하나(사용자 토글만).
      //  폭 전환·뷰 이동·새로 고침은 바꾸지 않는다. 저장은 이 브라우저에만(`dash.navRail.v1`, 기존 `dash.*.v1` 관례). 저장값 없으면 펼침.
      // ★레일 모양·효력 범위는 전부 CSS(`@media (min-width:901px)`)가 정한다 — 900px 이하에선 클래스가 남아도 효과가 없고 드로어 그대로다.
      // ★이름은 시각적으로만 숨긴다(CSS) — 접근 이름이 펼침과 글자 그대로 같고, 번역·카운트 갱신 자리가 늘지 않는다.
      //  그래서 툴팁은 접근 트리 밖(`aria-hidden`)에 두고, 내용은 띄울 때마다 버튼의 `.label`·`.hint` 에서 읽는다(늘 최신).
      const navRailBody = document.body;
      const navRailSidebar = document.getElementById("sidebar");
      const navRailToggle = document.getElementById("nav-rail-toggle");
      const NAV_RAIL_KEY = "dash.navRail.v1";
      /** 데스크톱 경계 — CSS 미디어와 같은 문자열(기존 모듈 관례). */
      const navRailNarrow = window.matchMedia("(max-width: 900px)");
      const navRailHover = window.matchMedia("(hover: hover)");

      const navRailOn = () => navRailBody.classList.contains("nav-rail") && !navRailNarrow.matches;

      // 툴팁 — 하나만, body 에 붙인다(사이드바는 overflow-y:auto 라 안에 두면 잘린다).
      const navRailTip = document.createElement("div");
      navRailTip.className = "nav-rail-tip";
      navRailTip.setAttribute("aria-hidden", "true");
      navRailTip.hidden = true;
      document.body.appendChild(navRailTip);
      let navRailTipFor = null;

      const hideNavRailTip = () => {
        navRailTipFor = null;
        navRailTip.hidden = true;
      };
      /** 붙어 있던 버튼이 사이드바의 보이는 영역(붙인 머리줄 아래) 안에 있으면 옮기고, 벗어났으면 닫는다. */
      const placeNavRailTip = () => {
        const btn = navRailTipFor;
        if (!btn || !navRailSidebar) return;
        const r = btn.getBoundingClientRect();
        const sb = navRailSidebar.getBoundingClientRect();
        const brand = navRailSidebar.querySelector(".nav-brand");
        const top = brand ? brand.getBoundingClientRect().bottom : sb.top;
        const mid = r.top + r.height / 2;
        if (r.height === 0 || mid < top || mid > sb.bottom) { hideNavRailTip(); return; }
        navRailTip.style.left = Math.round(r.right + 8) + "px";
        navRailTip.style.top = Math.round(mid) + "px";
      };
      const showNavRailTip = (btn) => {
        if (!navRailOn()) return;
        const text = (sel) => { const e = btn.querySelector(sel); return e ? e.textContent.trim() : ""; };
        const label = text(".label");
        if (label === "") return;
        const hint = text(".hint");
        navRailTip.textContent = hint === "" ? label : label + " · " + hint;
        navRailTipFor = btn;
        navRailTip.hidden = false;
        placeNavRailTip();
      };

      const paintNavRailToggle = () => {
        if (!navRailToggle) return;
        const rail = navRailBody.classList.contains("nav-rail");
        const label = i18n(rail ? "nav.rail.expand" : "nav.rail.collapse");
        navRailToggle.setAttribute("aria-expanded", rail ? "false" : "true");
        navRailToggle.setAttribute("aria-label", label);
        navRailToggle.title = label;
        const glyph = navRailToggle.querySelector(".nrt-glyph");
        if (glyph) glyph.textContent = rail ? "›" : "‹";
      };

      /** 사용자 토글만 부른다. 접기·펼치기 직후 패널 공간을 기존 규칙으로 다시 판정한다(애니메이션 없음 → 바로 잰다). */
      const setNavRail = (on) => {
        navRailBody.classList.toggle("nav-rail", on);
        try { localStorage.setItem(NAV_RAIL_KEY, on ? "1" : "0"); } catch { /* 프라이빗·quota — 이번 화면에만 */ }
        hideNavRailTip();
        paintNavRailToggle();
        if (typeof sidePanels === "object" && sidePanels) sidePanels.enforce();
      };

      try { navRailBody.classList.toggle("nav-rail", localStorage.getItem(NAV_RAIL_KEY) === "1"); } catch { /* 못 읽음 — 펼침 */ }
      paintNavRailToggle();

      if (navRailToggle) {
        navRailToggle.addEventListener("click", () => setNavRail(!navRailBody.classList.contains("nav-rail")));
      }

      if (navRailSidebar) {
        const navBtn = (e) => (e.target && e.target.closest ? e.target.closest(".nav-button") : null);
        navRailSidebar.addEventListener("pointerover", (e) => {
          if (!navRailHover.matches || e.pointerType === "touch") return;
          const btn = navBtn(e);
          if (btn && btn !== navRailTipFor) showNavRailTip(btn);
        });
        navRailSidebar.addEventListener("pointerout", (e) => {
          const btn = navBtn(e);
          if (!btn || btn !== navRailTipFor) return;
          if (e.relatedTarget && btn.contains(e.relatedTarget)) return; // 버튼 안 자식 사이 이동
          hideNavRailTip();
        });
        navRailSidebar.addEventListener("focusin", (e) => {
          const btn = navBtn(e);
          if (btn && btn.matches(":focus-visible")) showNavRailTip(btn);
        });
        navRailSidebar.addEventListener("focusout", (e) => {
          if (navBtn(e) === navRailTipFor) hideNavRailTip();
        });
        navRailSidebar.addEventListener("click", (e) => { if (navBtn(e)) hideNavRailTip(); });
        // ★스크롤은 닫지 않고 다시 잰다 — Tab 이 일으킨 자동 스크롤 뒤에도 지금 포커스된 항목 이름이 남는다.
        navRailSidebar.addEventListener("scroll", () => { if (navRailTipFor) placeNavRailTip(); }, { passive: true });

        // 붙인 머리줄 높이 → `scroll-padding-top`(CSS 가 쓴다) — Tab 자동 스크롤이 항목을 머리줄 밑에 숨기지 않게.
        const navBrand = navRailSidebar.querySelector(".nav-brand");
        if (navBrand && typeof ResizeObserver === "function") {
          new ResizeObserver(() => {
            navRailSidebar.style.setProperty("--nav-brand-h", navBrand.offsetHeight + "px");
          }).observe(navBrand);
        }
      }
      document.addEventListener("keydown", (e) => { if (e.key === "Escape") hideNavRailTip(); });
      navRailNarrow.addEventListener("change", hideNavRailTip);
