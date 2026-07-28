      const CATEGORIES = ["channel", "external_plugin", "skill", "agent", "mcp"];
      const CATEGORY_LABEL = {
        channel: "채널",
        external_plugin: "플러그인",
        skill: "스킬",
        agent: "에이전트",
        mcp: "mcp",
      };
      const CATEGORY_ICON = {
        channel: "📡",
        external_plugin: "🔌",
        skill: "🛠",
        agent: "🤖",
        mcp: "🧩",
      };
      const LAYERS = ["meta_infra", "in_tree", "discovered"];
      // (구 MAX_EVENTS/HARD_MAX_EVENTS 는 CC식 가상화 도입으로 제거 — 마운트 노드 수는 뷰포트±버퍼로
      //  바운드되고, 보관 아이템 상한은 VT_MAX_ITEMS(vtCap)가 담당한다.)
      // 렌더 dedup Set/Map(renderedActivityKeys·activityByStep) 상한 — DOM prune 과 무관하게
      // 활동/스텝마다 누적돼 세션이 길어지면 무한 증가(정상 사용에서도). DOM 윈도우(≤HARD_MAX)
      // 보다 훨씬 크게 잡아, 초과 시 가장 오래된(삽입순=시간순) 것부터 25% 버린다 — 버려지는 건
      // 이미 DOM 에서 prune 된 활동이라 무해(재도래 시 재렌더될 뿐).
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
      // 채널 접두 표시명 — 탭으로 안 열려 있는 세션(텔레그램·CLI 등)의 폴백 라벨.
      const CHANNEL_LABEL = { dashboard: "대시보드", telegram: "텔레그램", cli: "CLI", http: "HTTP" };
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

