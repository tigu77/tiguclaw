      // ★`hook` 추가 (2026-08-23 사용자 제안: "훅 목록은 오히려 인벤토리나 각 프로젝트별로").
      //  서버는 처음부터 `hook` 을 내보내고 있었는데(`/api/inventory` 응답 키) 이 목록에만
      //  빠져 **화면에 아예 안 나왔다** — 손으로 관리하는 목록이 서버와 갈린 자리다
      //  ([[feedback_hand_maintained_lists]]).
      //  ★훅은 **모델이 안 부르는데 자동으로 도는** 유일한 능력이라 목록에 없으면
      //   "왜 이게 실행됐지" 를 추적할 데가 없다. 보이는 자리가 곧 진단면이다.
      //  `endpoint`·`command` 는 각자 전용 화면이 있어 여기 안 넣는다(의도적 제외).
      const CATEGORIES = ["channel", "external_plugin", "skill", "agent", "mcp", "hook"];
      const CATEGORY_LABEL = {
        channel: i18n("채널"),
        external_plugin: i18n("플러그인"),
        skill: i18n("스킬"),
        agent: i18n("에이전트"),
        mcp: "mcp",
        hook: i18n("훅"),
      };
      const CATEGORY_ICON = {
        channel: "📡",
        external_plugin: "🔌",
        skill: "🛠",
        agent: "🤖",
        mcp: "🧩",
        hook: "🪝",
      };
      const LAYERS = ["meta_infra", "in_tree", "discovered"];
      // (구 MAX_EVENTS/HARD_MAX_EVENTS 는 CC식 가상화 도입으로 제거 — 마운트 노드 수는 뷰포트±버퍼로
      //  바운드되고, 보관 아이템 상한은 VT_MAX_ITEMS(vtCap)가 담당한다.)
      // 렌더 dedup Set/Map(renderedActivityKeys·activityByStep) 상한 — DOM prune 과 무관하게
      // 활동/스텝마다 누적돼 세션이 길어지면 무한 증가(정상 사용에서도). DOM 윈도우(≤HARD_MAX)
      // 보다 훨씬 크게 잡아, 초과 시 가장 오래된(삽입순=시간순) 것부터 25% 버린다 — 버려지는 건
      // 이미 DOM 에서 prune 된 활동이라 무해(재도래 시 재렌더될 뿐).
      /**
       * 우측 드로어(백그라운드·대화 검색) 폭 제한 — **한 곳**에서 정한다.
       *
       * ★두 패널이 같은 자리에 같은 몸짓으로 뜨는데 한계가 다르면, 번갈아 열 때 폭이
       *  들쭉날쭉해 보인다(사용자 2026-08-23: "검색 목록 패널 최대 사이즈는 백그라운드
       *  패널 최대 사이즈만큼 똑같이"). 값을 각자 적으면 한쪽만 늙는다.
       */
      const DRAWER_MIN_W = 300;
      const DRAWER_MAX_W = 760;
      const clampDrawerWidth = (w) =>
        Math.max(DRAWER_MIN_W, Math.min(Math.min(DRAWER_MAX_W, window.innerWidth * 0.9), w));

      const KEY_CACHE_MAX = 5000;
      const capKeyStore = (store) => {
        if (store.size <= KEY_CACHE_MAX) return;
        let drop = store.size - Math.floor(KEY_CACHE_MAX * 0.75);
        for (const k of store.keys()) { store.delete(k); if (--drop <= 0) break; }
      };
      // 멀티세션 탭(ADR 2026-07-15) — 대시보드 세션 = dashboard:<...> threadKey. 기본 세션은
      // dashboard:default(현행 상수와 동일 = 무이관 연속성). activeThreadKey = 지금 화면에 렌더
      // 중인 세션(C계층 = 활성 참조). 전송·큐취소·폴백·워킹표시 대표는 이 값 기준. SSE 는 전
      // 스레드를 계속 수신(§3.4 하드룰)하되, 채팅 스트림 DOM(B계층)은 activeThreadKey 만 그린다.
      const DEFAULT_DASH_THREAD = "dashboard:default";
      let activeThreadKey = DEFAULT_DASH_THREAD;
      // 이벤트 threadKey 가 지금 활성 세션인가(미지정 = 활성으로 취급 — 구 `|| activeThreadKey` 폴백 동형).
      const isActiveThread = (tk) => !tk || tk === activeThreadKey;
      // ── 안 본 메시지 (2026-08-12, 사용자 제안) ─────────────────────────────
      // ★진행 점(`st-dot`)과 **다른 질문**이라 배지를 따로 둔다:
      //   진행 점 = "지금 도는가"(곧 저절로 사라짐) / 여기 = "내가 못 본 게 있나"(사람이 볼 일).
      //   한 배지로 합치면 둘 중 하나는 반드시 거짓말이 된다.
      // ★세는 것은 **비서 답변·시스템 통지(out)만**이다. 인바운드(in)는 내가 다른 채널에서
      //   직접 친 말이라 "안 본" 이 아니다 — 세면 텔레그램에서 말할 때마다 내 탭이 빨개진다.
      // ★활성 탭은 애초에 안 센다(보고 있는 중). 판정을 여기 한 곳에 둬서 sse(적재)와
      //   tabs(표시)가 같은 기준을 쓴다.
      // 휘발성(메모리) — 새로고침하면 0. 그때는 이력이 통째로 다시 그려지므로 "안 본" 이
      // 아니게 된다. 영속시키면 오히려 유령 배지가 남는다.
      const unreadByThread = new Map();
      const unreadCount = (tk) => unreadByThread.get(tk) || 0;
      const bumpUnread = (tk) => {
        if (!tk || isActiveThread(tk)) return;
        unreadByThread.set(tk, unreadCount(tk) + 1);
        if (typeof renderTabBar === "function") renderTabBar();
      };
      const clearUnread = (tk) => {
        if (!unreadByThread.delete(tk)) return;
        if (typeof renderTabBar === "function") renderTabBar();
      };
      // 채널 접두 표시명 — 탭으로 안 열려 있는 세션(텔레그램·CLI 등)의 폴백 라벨.
      const CHANNEL_LABEL = { dashboard: i18n("대시보드"), telegram: i18n("텔레그램"), cli: "CLI", http: "HTTP" };
      /**
       * 세션 threadKey → 사람이 읽는 라벨. 탭으로 열려 있으면 그 이름(사용자가 붙인 이름 포함),
       * 아니면 채널 접두로 폴백. 미상("")은 ""를 돌려주고 표시 정책은 호출자가 정한다.
       * ★잡 좌표(worker:/agent:)를 그대로 넣지 말 것 — 원 세션으로 환원한 뒤 부를 것.
       */
      const sessionLabelFor = (tk) => {
        if (typeof tk !== "string" || tk === "") return "";
        if (typeof openTabs !== "undefined" && Array.isArray(openTabs)) {
          const tab = openTabs.find((t) => t && t.threadKey === tk);
          if (tab && tab.name) return tab.name;
        }
        const i = tk.indexOf(":");
        const ch = i > 0 ? tk.slice(0, i) : tk;
        return CHANNEL_LABEL[ch] || ch;
      };

