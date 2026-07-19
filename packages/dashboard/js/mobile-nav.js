      // ── 모바일 네비 (클로드코드 앱식, 2026-07-19) — ☰ 호출 → #sidebar 좌측 드로어 + ‹ 뒤로 ──
      // 데스크탑은 무영향(버튼 CSS 로 숨김, menu-open 클래스는 모바일 드로어에만 의미).
      // 뷰 전환(nav-button)·data-main show/hide 는 기존 로직 그대로 — 여기선 드로어 열고닫기와
      // 뒤로 버튼만 얹는다.
      const mnBody = document.body;
      const menuToggle = document.getElementById("menu-toggle");
      const menuBackdrop = document.getElementById("menu-backdrop");
      const hdrBack = document.getElementById("hdr-back");
      const mnCloseMenu = () => mnBody.classList.remove("menu-open");
      const toggleMenu = () => mnBody.classList.toggle("menu-open");
      if (menuToggle) menuToggle.addEventListener("click", toggleMenu);
      if (menuBackdrop) menuBackdrop.addEventListener("click", mnCloseMenu);
      // 메뉴 항목 선택 시 드로어 자동 닫힘(뷰 전환은 기존 nav-button 핸들러가 담당).
      for (const btn of document.querySelectorAll("#sidebar .nav-button")) {
        btn.addEventListener("click", mnCloseMenu);
      }
      // Esc 로도 닫기(접근성).
      document.addEventListener("keydown", (e) => { if (e.key === "Escape") mnCloseMenu(); });

      // ‹ 뒤로 — 상세/서브 뷰에서 홈(overview)으로 복귀. overview 면 숨김. (드로어 네비의 escape 어포던스.)
      const updateBack = () => { if (hdrBack) hdrBack.hidden = (mnBody.dataset.view === "overview" || !mnBody.dataset.view); };
      if (hdrBack) {
        hdrBack.addEventListener("click", () => {
          const home = document.querySelector('#sidebar .nav-button[data-view="overview"]');
          if (home) home.click();
          mnCloseMenu();
        });
        new MutationObserver(updateBack).observe(mnBody, { attributes: true, attributeFilter: ["data-view"] });
        updateBack();
      }

      // ── 세션탭 pull-to-refresh (모바일, 2026-07-19) — sticky 세션탭 스트립을 아래로 당기면 새로고침 ──
      // 채팅은 하단고정·무한스크롤이라 네이티브 pull-to-refresh 가 안 걸린다(상단 scrollTop=0 에
      // 못 머묾 — 위로 가면 과거 로드). 그래서 세션탭 위 *세로 당김*을 커스텀으로 잡아 reload().
      // 가로 탭 스크롤(overflow-x)과는 dx/dy 비교로 구분 — 세로 우세 + 임계 초과만 발동.
      const ptrTabs = document.getElementById("session-tabs");
      if (ptrTabs) {
        const ptrPill = document.createElement("div");
        ptrPill.className = "ptr-pill"; ptrPill.textContent = "↻ 놓으면 새로고침"; ptrPill.hidden = true;
        mnBody.appendChild(ptrPill);
        let ptrY0 = null, ptrX0 = null, ptrArmed = false;
        const PTR_THRESH = 72;
        ptrTabs.addEventListener("touchstart", (e) => {
          if (e.touches.length !== 1) { ptrY0 = null; return; }
          ptrY0 = e.touches[0].clientY; ptrX0 = e.touches[0].clientX; ptrArmed = false;
        }, { passive: true });
        ptrTabs.addEventListener("touchmove", (e) => {
          if (ptrY0 == null) return;
          const dy = e.touches[0].clientY - ptrY0;
          const dx = e.touches[0].clientX - ptrX0;
          ptrArmed = dy > PTR_THRESH && dy > Math.abs(dx) * 1.4; // 세로 우세 + 임계.
          ptrPill.hidden = !ptrArmed;
        }, { passive: true });
        const ptrEnd = () => {
          if (ptrArmed) { ptrPill.textContent = "↻ 새로고침 중…"; location.reload(); }
          else ptrPill.hidden = true;
          ptrY0 = null; ptrArmed = false;
        };
        ptrTabs.addEventListener("touchend", ptrEnd, { passive: true });
        ptrTabs.addEventListener("touchcancel", ptrEnd, { passive: true });
      }

      // ── fixed 입력창 높이 → --chat-inset (모바일, 2026-07-19) — 하단 여백을 입력창 실제 높이에
      // 맞춰 마지막 메시지가 안 가리게. 입력이 2행/멀티라인으로 커지거나 컨텍스트 태그가 붙어
      // 높이가 변해도 ResizeObserver 가 추종. (데스크탑은 이 변수를 안 써 무해.) +8 여유.
      const insetChat = document.getElementById("chat");
      if (insetChat && typeof ResizeObserver === "function") {
        const applyInset = () => {
          document.documentElement.style.setProperty("--chat-inset", (insetChat.offsetHeight + 8) + "px");
        };
        new ResizeObserver(applyInset).observe(insetChat);
        applyInset();
      }

      // 모바일 — 빈 입력창 안내문(placeholder)을 짧게(긴 안내는 화면 좁은 폰에서 과함).
      const mnInput = document.getElementById("chat-input");
      if (mnInput && window.matchMedia("(max-width: 900px)").matches) {
        mnInput.setAttribute("placeholder", "메시지 입력…");
      }

      // 모바일 — 백그라운드 버튼을 sticky 헤더로 이동(원래 #stream-bar 안이라 페이지스크롤로 사라져
      // 접근 불가였다). ID 기반 클릭핸들러·배지 갱신은 이동해도 유지. 데스크탑은 chat-head 그대로.
      const mnBgToggle = document.getElementById("bg-toggle");
      const mnHeader = document.querySelector("header");
      const mnLive = mnHeader ? mnHeader.querySelector(".live") : null;
      if (mnBgToggle && mnHeader && window.matchMedia("(max-width: 900px)").matches) {
        if (mnLive) mnHeader.insertBefore(mnBgToggle, mnLive);
        else mnHeader.appendChild(mnBgToggle);
      }
