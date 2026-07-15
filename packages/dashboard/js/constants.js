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

