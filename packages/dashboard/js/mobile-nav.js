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

      // ── 드로어를 **손가락으로** 연다·닫는다 (2026-09-05 사용자 요청) ──────────
      // ☰ 버튼은 열 수만 있고 닫는 건 백드롭 탭뿐이었다 — 폰에선 «가장자리에서 밀어 열고
      // 밀어 닫는» 게 기본 문법이고, 그게 없으면 한 손으로 쓰기가 어렵다.
      //
      // ★세로 스크롤을 뺏지 않는 것이 이 코드의 전부다. 드로어 안은 세로로 긴 목록이라,
      //  손가락이 «가로로 갈 작정» 임을 확인하기 전엔 아무것도 가로채지 않는다(아래 판정).
      //  이 레포는 같은 자리에서 한 번 당했다 — 세션탭 pull-to-refresh 가 `touch-action`
      //  선언을 뒤집어 스트립을 훑을 때마다 새로고침이 됐고, 그래서 걷어냈다(위 주석).
      const mnSidebar = document.getElementById("sidebar");
      /** 가장자리에서 시작해야 «여는 제스처» 다 — 화면 어디서나 열리면 목록 스와이프와 싸운다. */
      const DRAWER_EDGE_PX = 24;

      /**
       * 이 움직임을 드로어가 **가져갈까** — 순수 판정.
       * 가로가 세로보다 확실히 클 때만(≥8px 이동 + |dx|>|dy|), 그리고 방향이 맞을 때만.
       */
      const drawerEngage = (v) => {
        if (Math.abs(v.dx) < 8 || Math.abs(v.dx) <= Math.abs(v.dy)) return false;
        return v.open === true ? v.dx < 0 : v.startX <= DRAWER_EDGE_PX && v.dx > 0;
      };

      /**
       * 손을 뗐을 때 **열린 채로 둘까** — 순수 판정. 거리(60%/40%)와 속도(플릭) 둘 다 본다.
       * ★플릭을 따로 보는 이유: 짧고 빠른 밀기는 거리가 짧아도 «열어라» 는 뜻이다. 거리만
       *  보면 빠른 손이 매번 실패하고, 그러면 사용자는 제스처가 없는 줄 안다.
       */
      const drawerSettle = (v) => {
        const speed = v.elapsedMs > 0 ? v.dx / v.elapsedMs : 0;
        if (Math.abs(speed) > 0.35) return speed > 0;
        return v.open === true ? v.width + v.dx > v.width * 0.6 : v.dx > v.width * 0.4;
      };

      if (mnSidebar) {
        let track = null; // {startX, startY, t0, open, width, engaged}
        const isMobile = () => window.matchMedia("(max-width: 900px)").matches;
        const paintDrag = (dx) => {
          const w = track.width;
          const x = track.open ? Math.max(-w, Math.min(0, dx)) : Math.min(0, -w + Math.max(0, dx));
          mnSidebar.style.transform = "translateX(" + x + "px)";
          if (menuBackdrop) menuBackdrop.style.opacity = String(Math.max(0, Math.min(1, (w + x) / w)));
        };
        const endDrag = (keepOpen) => {
          mnSidebar.style.transform = "";
          if (menuBackdrop) menuBackdrop.style.opacity = "";
          mnBody.classList.remove("menu-dragging");
          mnBody.classList.toggle("menu-open", keepOpen);
          track = null;
        };
        document.addEventListener("touchstart", (e) => {
          if (!isMobile() || e.touches.length !== 1) return;
          const t = e.touches[0];
          const open = mnBody.classList.contains("menu-open");
          // 닫혀 있으면 «왼쪽 가장자리»에서만, 열려 있으면 드로어 위에서만 추적한다.
          if (!open && t.clientX > DRAWER_EDGE_PX) return;
          if (open && !mnSidebar.contains(e.target)) return; // 백드롭 탭은 기존 클릭이 닫는다.
          track = { startX: t.clientX, startY: t.clientY, t0: Date.now(), open, width: mnSidebar.offsetWidth || 280, engaged: false };
        }, { passive: true });
        document.addEventListener("touchmove", (e) => {
          if (track === null || e.touches.length !== 1) return;
          const t = e.touches[0];
          const dx = t.clientX - track.startX, dy = t.clientY - track.startY;
          if (!track.engaged) {
            if (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) { track = null; return; } // 세로 스크롤이다 — 놔준다.
            if (!drawerEngage({ dx, dy, startX: track.startX, open: track.open })) return;
            track.engaged = true;
            mnBody.classList.add("menu-dragging"); // 끄는 동안엔 전환 애니메이션을 끈다(손가락을 따라와야 한다).
          }
          e.preventDefault(); // 가로로 가져간 뒤에만 막는다.
          paintDrag(dx);
        }, { passive: false });
        const finish = (e) => {
          if (track === null) return;
          if (!track.engaged) { track = null; return; }
          const t = (e.changedTouches && e.changedTouches[0]) || null;
          const dx = t === null ? 0 : t.clientX - track.startX;
          endDrag(drawerSettle({ dx, elapsedMs: Date.now() - track.t0, width: track.width, open: track.open }));
        };
        document.addEventListener("touchend", finish, { passive: true });
        document.addEventListener("touchcancel", finish, { passive: true });
      }

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
          // ★행 클래스를 **열거하지 않는다** (2026-09-05). `.provider-item` 만 보던 탓에
          //  플러그인 뷰(행이 `.plugin-item`)가 통째로 빠졌다 — 폰에서 누르면 상세가 목록
          //  아래에 깔렸고, 거기 인증 버튼이 있다. «-item» 으로 끝나는 행이면 상세로 넘어간다.
          // ★조상까지 셀렉터에 넣으면 **안 걸린다**(실측): 행의 자기 핸들러가 목록을 다시
          //  그려서, 이벤트가 여기 올라올 때 `e.target` 은 이미 **떨어져 나간 노드**다 —
          //  전파 경로는 유지되지만 조상 사슬은 끊긴다. 그래서 «어느 목록 안인가» 는
          //  리스너가 붙은 자리(#workbench)가 이미 말하고, 여기선 행 자신만 본다.
          if (e.target && e.target.closest && e.target.closest('[class*="-item"]')) {
            mnSetDetail(true);
          }
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
