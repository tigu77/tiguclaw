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

      // 안내문(placeholder)은 여기서 정하지 않는다 — 폭·입력장치·고스트 상태를 한 곳
      // (util.js computeChatPlaceholder)에서 조합한다. 종전엔 여기와 perf.js 가 서로를
      // 덮어써 **로드 순서가 승자를 정했다**(perf.js 문구는 폰에서 한 번도 안 보였다).

      // 모바일 — 백그라운드 버튼을 sticky 헤더로 이동(원래 #stream-bar 안이라 페이지스크롤로 사라져
      // 접근 불가였다). ID 기반 클릭핸들러·배지 갱신은 이동해도 유지. 데스크탑은 chat-head 그대로.
      const mnBgToggle = document.getElementById("bg-toggle");
      const mnHeader = document.querySelector("header");
      const mnLive = mnHeader ? mnHeader.querySelector(".live") : null;
      if (mnBgToggle && mnHeader && window.matchMedia("(max-width: 900px)").matches) {
        if (mnLive) mnHeader.insertBefore(mnBgToggle, mnLive);
        else mnHeader.appendChild(mnBgToggle);
      }

      // ── 모바일 마스터-디테일 (2026-07-19) — 모듈·인벤토리·프로젝트 상세를 리스트 밑 스택 대신
      // 전환 화면으로. 세 뷰 공통 리스트 아이템(.provider-item) 탭 → body.m-detail(상세 전체화면),
      // ‹목록 뒤로 버튼 → 리스트 복귀. 뷰 전환(nav) 시엔 항상 리스트부터(m-detail 해제). 데스크탑 무영향.
      const mnWorkbench = document.getElementById("workbench");
      const mnDetailBack = document.getElementById("wb-detail-back");
      const mnSetDetail = (on) => mnBody.classList.toggle("m-detail", on);
      if (mnWorkbench) {
        mnWorkbench.addEventListener("click", (e) => {
          if (!window.matchMedia("(max-width: 900px)").matches) return;
          if (e.target && e.target.closest && e.target.closest(".provider-item")) mnSetDetail(true);
        });
      }
      if (mnDetailBack) mnDetailBack.addEventListener("click", () => mnSetDetail(false));
      // 뷰 전환(data-view 변경) 시 상세 초기화 — 새 뷰는 리스트부터.
      new MutationObserver(() => mnSetDetail(false)).observe(mnBody, { attributes: true, attributeFilter: ["data-view"] });

      // ── 마지막 본 페이지 복원 (2026-08-10) ────────────────────────────────
      // 모든 뷰 모듈(showX)이 정의된 **뒤**여야 하므로 로드 순서상 마지막인 여기서 부른다.
      // 실패·미저장이면 아무것도 안 하고 기존 동작(채팅)으로 남는다 — 갇히지 않는 게 우선.
      try {
        if (typeof window.restoreLastView === "function") window.restoreLastView();
      } catch { /* 복원 실패 = 채팅 유지 */ }
