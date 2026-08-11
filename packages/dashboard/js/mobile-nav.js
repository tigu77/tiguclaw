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

      // ── 세션탭 pull-to-refresh 제거 (2026-08-11 사용자 지시) ─────────────────
      // 2026-07-19 에 넣었던 커스텀 당겨서-새로고침을 뺀다. 탭을 훑으려고 스트립을
      // 만질 때마다 새로고침 위험이 있었고, 무엇보다 **같은 것을 두 곳이 정하고**
      // 있었다 — CSS 는 `touch-action:pan-x` 로 "여기서 세로 제스처는 없다" 고
      // 선언하는데, 이 핸들러가 세로 당김을 잡아 그 선언을 뒤집었다.
      // 스트립의 스크롤 성질은 CSS 에 산다(app.css `.session-tabs`). 새로고침은
      // 브라우저 기본 제스처와 `tiguclaw restart`/버튼이 이미 맡는다.

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
