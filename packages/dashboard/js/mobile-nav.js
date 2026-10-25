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
        let lastInsetH = null;
        const insetMq = window.matchMedia("(max-width: 900px)");
        const applyInset = () => {
          const h = insetChat.offsetHeight;
          document.documentElement.style.setProperty("--chat-inset", (h + 8) + "px");
          // ★바닥을 따라가던 중이면 바닥을 다시 잡는다 (2026-10-24, 입력 정보 접기 구현 중 실측). 입력창이 커지면 문서의
          //  스크롤 최대치만 늘고 scrollTop 은 그대로라 마지막 메시지가 그만큼 입력창 밑으로 들어갔다 — 헤드리스 390폭: 펼치기
          //  +64px → 28px 가림, 백그라운드 알약 +38px → 2px(그동안은 메시지 아래 여백 36px 가 가려 줬다). 모바일만(데스크톱은
          //  #stream 이 스크롤 상자라 그쪽 ResizeObserver 가 이미 잡는다) · 높이가 **바뀔 때만**(첫 측정은 판정 재료가 없다).
          //  «따라가는 중인가» 는 virtualization.js 한 곳(`vtPinBottom` → `pinsBottom`)이 정한다 — 위로 올려 읽는 중이면 그대로 둔다.
          const changed = lastInsetH !== null && h !== lastInsetH;
          lastInsetH = h;
          if (changed && insetMq.matches && typeof vtPinBottom === "function") vtPinBottom();
        };
        new ResizeObserver(applyInset).observe(insetChat);
        applyInset();
      }

      // ── 입력창 위 정보 한 번에 접기 (2026-10-24 사용자 — docs/decisions/2026-10-24-mobile-composer-info-collapse.md) ──
      // 태그·프로젝트·답글·첨부·백그라운드/셸 알약을 토글 한 번으로 숨긴다 — **모든 폭**(§12 «데스크탑이든 어디든 다같이»).
      // ★숨기기만 한다 — 각 줄은 자기 모듈이 계속 그리고(답글·첨부·연결은 그대로 실려 간다), 펼치면 최신이 보인다. 접힘은
      // **사용자 탭만** 바꾼다(갱신·폭 전환이 펼치거나 접지 않는다) — 예외 하나: 데스크톱에서 사용자가 새로 지정한 답글·붙인 첨부는
      // 화면만 펼친다(아래 `composerInfoAdded`, §13). 처음 상태는 펼침(비서 채택 기본, 결정 문서 §7).
      // 기기 화면 취향이라 이 브라우저에만 둔다. 숨김·배치는 CSS 가 하고, 화면엔 화살표만 — 이름은 아래 aria-label·title.
      const infoChat = document.getElementById("chat");
      const infoToggle = document.getElementById("chat-info-toggle");
      if (infoChat && infoToggle) {
        const INFO_KEY = "tgchat_info_collapsed";
        const infoBadgesEl = infoToggle.querySelector(".cit-badges");
        const infoEl = (id) => document.getElementById(id);
        const infoShown = (id) => { const e = infoEl(id); return e !== null && !e.hidden; };
        const infoCount = (id, sel) => { const e = infoEl(id); return e === null ? 0 : e.querySelectorAll(sel).length; };
        // 배지 = 묶음 DOM 에서 파생한다(모듈마다 카운터를 심지 않는다). [보이는 글, 읽어 줄 글].
        // ★태그는 세지 않는다 — 태그 «선택» 은 입력창 글자이고 입력창은 늘 보인다(칩으로 세면 칩 없는 태그를 못 센다, 설계 R1).
        // ★알약은 «있음» 만 — 알약 글자(건수)는 관측 밖이라 숫자를 실으면 낡는다.
        const infoBadges = () => {
          const out = [];
          const p = infoCount("chat-projects", ".ctx-linked");
          if (p > 0) out.push(["📁 " + p, i18n("chat.info.badge.projects", { n: p })]);
          if (infoShown("chat-reply")) out.push(["↩", i18n("chat.info.badge.reply")]);
          const a = infoCount("chat-attach", ".att-chip");
          if (a > 0) out.push(["📎 " + a, i18n("chat.info.badge.attach", { n: a })]);
          if (infoShown("chat-bg-active")) out.push(["🔄", i18n("chat.info.badge.bg")]);
          if (infoShown("chat-shell-active")) out.push(["🖥️", i18n("chat.info.badge.shell")]);
          return out;
        };
        let infoSig = null;
        const paintInfo = () => {
          const collapsed = infoChat.classList.contains("info-collapsed");
          const badges = collapsed ? infoBadges() : []; // 배지는 «숨은 것» 의 요약이다 — 펼친 동안엔 원래 줄이 보인다.
          const label = [i18n(collapsed ? "chat.info.expand" : "chat.info.collapse"), ...badges.map((b) => b[1])].join(", ");
          const sig = label + "|" + badges.map((b) => b[0]).join("|");
          if (sig === infoSig) return; // 같으면 안 쓴다 — 셸 알약은 1초마다 hidden 을 다시 대입한다(값이 같아도 관측이 깬다).
          infoSig = sig;
          infoBadgesEl.replaceChildren(...badges.map((b) => {
            const s = document.createElement("span");
            s.className = "cit-badge";
            s.textContent = b[0];
            return s;
          }));
          infoToggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
          infoToggle.setAttribute("aria-label", label);
          infoToggle.title = label;
        };
        const setInfoCollapsed = (on) => {
          infoChat.classList.toggle("info-collapsed", on);
          try { localStorage.setItem(INFO_KEY, on ? "1" : "0"); } catch {}
          paintInfo();
        };
        let savedCollapsed = false;
        try { savedCollapsed = localStorage.getItem(INFO_KEY) === "1"; } catch {}
        infoChat.classList.toggle("info-collapsed", savedCollapsed);
        // 누를 때 입력창 포커스(=폰 키보드)를 빼앗지 않는다. 키보드 조작(Enter·Space)은 mousedown 이 없어 그대로 클릭이 된다.
        infoToggle.addEventListener("mousedown", (e) => e.preventDefault());
        infoToggle.addEventListener("click", () => setInfoCollapsed(!infoChat.classList.contains("info-collapsed")));
        // 사용자가 **방금** 답글 대상을 지정하거나 첨부를 붙였다(reply.js `startReply` · chat-send.js `addFiles` 가 알린다 — 복원·첫 렌더·
        //  제거는 알리지 않는다). 데스크톱(>900px)에서 접혀 있으면 펼친다 — 배지만 생기면 무엇에 답하고 무엇을 붙였는지 모르는 채 보낸다
        //  (결정 문서 §13). ★표시만 편다 — 저장값은 사용자 탭만 바꾼다(다시 접으면 그대로 접히고, 새로 고치면 저장한 대로).
        //  모바일은 종전대로 펴지 않는다 — 접기는 가상 키보드가 뜬 좁은 화면의 채팅 높이를 벌려고 있고, 답글·첨부 다음엔 대개 바로 입력(키보드)한다.
        //  펼치면 답글 줄만이 아니라 숨긴 줄 전부가 돌아온다. 확인은 입력창 바로 위 요약 줄의 배지(↩·📎)가 한다.
        const infoMobileMq = window.matchMedia("(max-width: 900px)");
        window.composerInfoAdded = () => {
          if (infoMobileMq.matches) return;
          infoChat.classList.remove("info-collapsed"); // 이미 펼쳐져 있으면 아무것도 안 바뀐다(paintInfo 도 같은 글이면 안 쓴다).
          paintInfo(); // 답글이 이미 떠 있던 채 대상을 바꾸면 hidden 이 안 바뀌어 배지 관측이 깨지 않는다 — 여기서 직접 칠한다.
        };
        // 관측은 배지가 읽는 자리에만 — #chat 전체를 보면 1초마다 다시 쓰는 진행 표시와 토글 자신까지 걸린다(설계 §2-3).
        const infoMo = new MutationObserver(paintInfo);
        for (const id of ["chat-projects", "chat-attach"]) { const e = infoEl(id); if (e) infoMo.observe(e, { childList: true }); }
        for (const id of ["chat-reply", "chat-bg-active", "chat-shell-active"]) {
          const e = infoEl(id);
          if (e) infoMo.observe(e, { attributes: true, attributeFilter: ["hidden"] });
        }
        paintInfo();
      }

      // ── fixed 세션 탭 높이 → --tabs-inset (모바일 채팅, 2026-09-25) — 탭을 고정했으니 문서 위쪽에
      // 그만큼 자리를 비운다(안 비우면 채팅 제목 줄과 첫 메시지가 탭 밑에 깔린다). 입력창과 같은 방식.
      // 고정되는 것은 바깥 상자다 — 그 높이만큼 비운다(없으면 탭 목록).
      const insetTabs = document.getElementById("session-tabs-bar") || document.getElementById("session-tabs");
      if (insetTabs && typeof ResizeObserver === "function") {
        const applyTabsInset = () => {
          document.documentElement.style.setProperty("--tabs-inset", insetTabs.offsetHeight + "px");
        };
        new ResizeObserver(applyTabsInset).observe(insetTabs);
        applyTabsInset();
      }

      // ── 바운스 중엔 탭 목록을 스크롤 컨테이너에서 뺀다 (2026-09-26 정태님 실기, iOS 18 시뮬레이터 재현) ──
      // iOS 18 Safari 는 fixed 상자 안의 스크롤 컨테이너를 **페이지 바운스(범위 밖 끌기) 중에 안 그린다** —
      // 탭 목록 상자(배경)는 제자리인데 탭 버튼만 사라졌다. 탭 목록을 스크롤 컨테이너가 아니게(overflow:visible
      // ·clip) 하면 바운스 중에도 보이고, 합성 레이어·쌓임 맥락·will-change·contain 은 모두 무효였다(시뮬레이터
      // 실측). iOS 26 에선 안 난다. 그래서 **바운스하는 동안만** clip 으로 두고, 넘겨 둔 위치는 translate 로
      // 유지한다(app.css `.bounce-frozen`). 바운스 중엔 어차피 탭을 넘길 수 없다(손가락이 대화 위에 있다).
      const tabsStrip = document.getElementById("session-tabs");
      if (tabsStrip) {
        const tabsMq = window.matchMedia("(max-width: 900px)");
        let frozen = false;
        const setFrozen = (on) => {
          if (on === frozen) return;
          frozen = on;
          if (on) {
            tabsStrip.style.setProperty("--tabs-x", tabsStrip.scrollLeft + "px");
            tabsStrip.classList.add("bounce-frozen");
          } else {
            const x = parseFloat(tabsStrip.style.getPropertyValue("--tabs-x")) || 0;
            tabsStrip.classList.remove("bounce-frozen");
            tabsStrip.scrollLeft = x;
          }
        };
        window.addEventListener("scroll", () => {
          const se = document.scrollingElement || document.documentElement;
          const y = window.scrollY;
          setFrozen(tabsMq.matches && document.body.getAttribute("data-tab") === "chat" &&
            (y < 0 || y > se.scrollHeight - se.clientHeight + 1));
        }, { passive: true });
        // 끝 이벤트를 놓쳐 얼어 있으면 탭을 만지는 순간 푼다(넘기기는 늘 된다).
        tabsStrip.addEventListener("touchstart", () => setFrozen(false), { passive: true });
      }

      // 안내문(placeholder)은 여기서 정하지 않는다 — 폭·입력장치·고스트 상태를 한 곳
      // (util.js computeChatPlaceholder)에서 조합한다. 종전엔 여기와 perf.js 가 서로를
      // 덮어써 **로드 순서가 승자를 정했다**(perf.js 문구는 폰에서 한 번도 안 보였다).

      // 모바일 — `.chat-head-actions` 의 버튼을 sticky 헤더로 이동(원래 #stream-bar 안이라
      // 페이지스크롤로 사라져 접근 불가였다). ID 기반 클릭핸들러·배지 갱신은 이동해도 유지.
      // 데스크탑은 chat-head 그대로.
      //
      // ★**하나만 옮기고 옆을 빼먹었다** (2026-09-09 정태님: *"모바일 채팅에서 검색이
      //  안보여"*). 백그라운드 버튼에 이 이동을 달면서 **바로 옆에 나란히 있던 검색
      //  버튼**을 안 옮겼다 — 같은 상자에 있으니 같은 운명인데, 이름을 하나만 적었다.
      //  그래서 폰에서는 대화 맨 위까지 스크롤해 올라가야만 검색이 나왔다(긴 대화에선
      //  사실상 없는 기능).
      // ★그래서 **이름을 열거하지 않는다** — 옮기는 대상은 «그 상자 안의 버튼 전부» 다.
      //  셋째 버튼이 생겨도 저절로 따라온다([[feedback_hand_maintained_lists]]).
      // ★순서는 마크업 순서를 지킨다(검색 → 백그라운드) — 화면마다 자리가 바뀌면 손이
      //  기억하지 못한다.
      // ★**폭이 바뀌면 다시 판정한다** (2026-09-09, 적대 검토 P3). 종전엔 **로드 시점 1회**
      //  만 봤다 — 넓은 창에서 열었다가 좁히면(폰 회전도 900px 경계를 넘는다: 세로 430 /
      //  가로 932) 버튼이 `#stream-bar` 에 그대로 남아 **0×0 으로 갇힌다.** 그게 바로
      //  *"모바일 채팅에서 검색이 안보여"* 그 상태다 — 고친 버그가 다른 문으로 돌아온다.
      // ★되돌리기도 한다: 넓어지면 원래 자리(`.chat-head-actions`)로 보낸다. 한쪽만 하면
      //  데스크탑 헤더에 채팅 버튼이 남는다.
      const mnHeader = document.querySelector("header");
      const mnHome = document.querySelector(".chat-head-actions");
      const mnPlaceActions = () => {
        if (!mnHeader || !mnHome) return;
        // ★오른쪽 패널 버튼(백그라운드·위젯)은 원래 헤더에 산다(2026-10-20) — 채팅 버튼(검색)은 그 **앞**에 둔다.
        const mnLive = mnHeader.querySelector("#bg-toggle") || mnHeader.querySelector(".live");
        // ★목록을 **매번 새로 읽는다** — 옮긴 뒤엔 셀렉터가 안 잡히므로, 양쪽에서 모은다.
        const btns = [
          ...mnHome.querySelectorAll(":scope > button"),
          ...mnHeader.querySelectorAll(":scope > button[data-chat-action]"),
        ];
        const narrow = window.matchMedia("(max-width: 900px)").matches;
        for (const b of btns) {
          b.dataset.chatAction = "1"; // 헤더로 간 뒤에도 «이건 채팅 것» 임을 알 수 있게
          if (narrow) {
            if (b.parentElement !== mnHeader) {
              if (mnLive) mnHeader.insertBefore(b, mnLive);
              else mnHeader.appendChild(b);
            }
          } else if (b.parentElement !== mnHome) {
            mnHome.appendChild(b);
          }
        }
      };
      mnPlaceActions();
      window.matchMedia("(max-width: 900px)").addEventListener("change", mnPlaceActions);

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
