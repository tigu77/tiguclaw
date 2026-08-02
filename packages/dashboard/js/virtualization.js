      // ── CC식 가상화(윈도잉) — #stream 을 위→아래(최古 위·최新 아래) 흐름으로 바운드 렌더 ──
      // vtItems: 오래된→최신 순서로 실 DOM 노드(스트리밍 중에도 살아있게 detached 로 보관)를 들고,
      // 뷰포트±버퍼만 마운트한다. 높이는 ResizeObserver 로 실측(측정 전 추정치). 스틱-투-바텀은
      // scrollTop=scrollHeight, 프리펜드/측정 시엔 앵커 보정으로 점프 0. (구 역방향 flex·상한 prune·
      // 날짜구분 MutationObserver·센티넬 IntersectionObserver 를 전부 대체.)
      const VT_EST_H = 72;         // 미측정 아이템 추정 높이(px).
      const VT_DIVIDER_EST_H = 28; // 날짜 구분선 추정 높이(px).
      const VT_GAP = 8;            // .vt-window flex gap 과 일치(슬롯 높이 = 실측 + gap).
      const VT_BUFFER = 800;       // 뷰포트 위·아래 여분 마운트(px). older 로드 트리거 임계도 겸함.
      const VT_MAX_ITEMS = 4000;   // 보관 아이템 상한(하단 고정 시 최古 detached 부터 드롭).

      // sizer(스크롤바 총높이) > window(마운트 서브셋). #chat-empty·#log-empty 는 #stream 직속 형제로 유지.
      const vtSizer = document.createElement("div");
      vtSizer.className = "vt-sizer";
      const vtWindow = document.createElement("div");
      vtWindow.className = "vt-window";
      vtSizer.appendChild(vtWindow);
      stream.appendChild(vtSizer);
      // 일반 이벤트(알 수 없는 유형) 싱크 — 채팅선 숨김·로그 패널(데드)용. vtItems 오염 방지.
      const logSink = document.createElement("div");
      logSink.id = "log-sink";
      logSink.style.display = "none";
      stream.appendChild(logSink);
      const LOG_SINK_MAX = 300;

      const vtItems = [];        // { node, h, measured, isDivider, top } — 오래된→최신.
      const vtIndex = new Map(); // node -> item.
      let stickBottom = true;    // 하단(최신) 고정 팔로우. 사용자가 위로 스크롤하면 해제.
      let vtJumpTop = false;     // Home 원샷 — 로드된 맨위로 프로그램적 점프(리스너/loadOlder 미발화).
      let vtProgrammatic = false; // 프로그램적 scrollTop 조정 가드(scroll 리스너 무시).
      // ★프로그램적 스크롤의 async scroll 이벤트는 다음 프레임 이후에도 늦게(stale) 도착한다.
      // vtProgrammatic 를 next-rAF 로 풀면 그 사이 도착한 stale 이벤트가 리스너에 새어, 스트리밍
      // (연속 pin) 중 st(옛값)<lastScrollTop(새값) 으로 "위로 스크롤" 오판 → stickBottom 해제 →
      // 하단 팔로우가 끊긴다("전송 후 스크롤 바닥 안 감", busy 스트리밍서 재현). 마지막 프로그램적
      // 스크롤 후 짧은 창(ms) 동안 scroll 이벤트를 프로그램적으로 간주해 stale 유입을 흡수한다.
      // 사용자 wheel/touch/키 제스처는 이 창과 무관하게 즉시 unstick(아래 별도 리스너)이라 무영향.
      let vtProgUntil = 0;
      const perfNow = () => (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());
      let lastScrollTop = 0;     // 직전 scrollTop — 사용자 스크롤 방향(위/아래) 판정용. 작은 위 스크롤도 stick 해제.
      // ★팔로우 판정 근거 = 의도 추측이 아니라 실측 관측 (2026-07-27, 4번째 재발에서 방향 전환).
      //  이 자리는 세 번 고쳤는데(40e0d51·4b5d5c1·1343212) 전부 "pin 을 더 세게" 였고, 정작 새는
      //  곳은 stickBottom 이 *꺼지는* 쪽이었다. wheel deltaY<0 는 **실제 스크롤이 0px 이어도**
      //  팔로우를 비가역적으로 껐다(헤드리스 실측: 전송 후 팬텀 wheel 1회 → 도착 메시지가 638px
      //  아래로 밀림 = "맨 아래에 위에만 살짝 보임"). 그래서 제스처는 *신호* 로만 쓰고, 해제·복귀
      //  확정은 둘 다 **실측 gap** 으로 한다. 아래 두 상수가 그 유일한 기준이다.
      const NEAR_BOTTOM_PX = 80;  // 이보다 가까우면 "바닥에 있다"(팔로우 재개 가능).
      const MOVED_EPS_PX = 8;     // 이보다 덜 움직였으면 스크롤한 게 아니다(팬텀 제스처 차단).
      const gapNow = () => getScrollH() - getScrollTop() - getClientH();
      // 사용자 우선권 창 — 실제 제스처 직후엔 pin 이 사용자와 싸우지 않는다(해제 확정 전이라도).
      let userIntentUntil = 0;

      // ── 모바일 페이지 스크롤 모드 (2026-07-19) — 다른 메뉴 패널처럼 문서(window)가 스크롤 ──
      // 데스크탑(>900px)은 기존 #stream 내부 스크롤·윈도잉 그대로(무접촉). 모바일 채팅에선 #right/
      // #stream 이 페이지 흐름(CSS height:auto)이라 문서가 스크롤하고 헤더가 함께 흐른다(입력창은
      // CSS sticky 하단 고정). 이 모드에선 (a) 렌더는 전량 마운트(윈도잉 오프셋 회피 — pageScroll()
      // 분기), (b) 스크롤 읽기/쓰기는 scEl()(=문서 스크롤러)로 라우팅, (c) 스크롤 리스너는 window
      // 에도 붙는다. vtCap 은 그대로 동작해 렌더 노드 수 상한 유지(폭주 방지).
      const mqMobile = window.matchMedia("(max-width: 900px)");
      const pageScroll = () =>
        mqMobile.matches && document.body.getAttribute("data-tab") === "chat";
      const scEl = () => (pageScroll() ? (document.scrollingElement || document.documentElement) : stream);
      const getScrollTop = () => scEl().scrollTop;
      const getClientH = () => scEl().clientHeight;
      const getScrollH = () => scEl().scrollHeight;

      const slotH = (it) =>
        (it.measured ? it.h : (it.isDivider ? VT_DIVIDER_EST_H : VT_EST_H)) + VT_GAP;

      // 메시지 노드 → 수치 ts(날짜 경계 판정). 턴 그룹은 내부 첫 [data-ts] 를 본다.
      const vtTsOf = (el) => {
        if (el.classList && el.classList.contains("date-divider")) return null;
        if (el.dataset && el.dataset.ts) return Number(el.dataset.ts);
        const inner = el.querySelector ? el.querySelector("[data-ts]") : null;
        return inner && inner.dataset.ts ? Number(inner.dataset.ts) : null;
      };

      // ★현재 렌더된 마지막(최신) 아이템의 ts — **파생 상태**(저장 플래그 아님).
      //  용도: SSE 재연결 replay 로 들어온 *과거* 메시지를 바닥에 append 하는 것을 막는다.
      //  (2026-07-27 사용자 신고 "옛날 메시지가 갑자기 최근으로 보일때가 있네" — 70분 전
      //   메시지가 최신 아래에 붙는 것을 헤드리스로 재현.)
      //  왜 생기나: vtCap 이 prune 하면서 그 메시지의 dedup 키를 **일부러 지운다**(뒤로
      //  스크롤 시 재렌더되게 — 그건 옳다). 그 상태에서 재연결 replay 가 같은 이벤트를 다시
      //  흘리면 "처음 보는 메시지" 가 되어 append = 순서 붕괴. 자동 재연결(d2d25d6) 이후
      //  replay 빈도가 올라 눈에 띄기 시작했다.
      //  ★플래그로 최신 ts 를 들고 다니면 탭 전환·이력 재빌드마다 초기화 지점이 늘어난다
      //   (오늘 stickBottom 에서 겪은 실패). 리스트 끝에서 읽으면 언제나 참이다.
      const vtNewestTs = () => {
        for (let i = vtItems.length - 1; i >= 0; i--) {
          const t = vtTsOf(vtItems[i].node);
          if (t !== null && Number.isFinite(t)) return t;
        }
        return 0;
      };
      // 근소한 역전(같은 순간 다른 채널에서 도착 등)까지 버리지 않도록 여유를 둔다.
      // replay 는 분 단위로 과거라 이 창에 걸리지 않는다.
      const VT_STALE_TOLERANCE_MS = 5000;
      /** 이 ts 의 메시지를 지금 바닥에 붙이면 순서가 깨지는가(= 재연결 replay 로 온 과거분). */
      const vtIsStaleForAppend = (ts) => {
        if (typeof ts !== "number" || !Number.isFinite(ts)) return false;
        const newest = vtNewestTs();
        return newest > 0 && ts < newest - VT_STALE_TOLERANCE_MS;
      };

      // 하단 재-pin(원인 D, 2026-07-19) — stick 유지 중일 때만 바닥에 즉시 재고정. relayout 의
      // stickBottom 분기(setScrollTop=바닥)와 같은 일을 하되 *ResizeObserver 콜백 안에서 동기적으로*
      // 실행한다는 점이 핵심이다. 왜 필요한가: 멀티라인 메시지를 보내면 입력창(textarea)이 여러 줄
      // →한 줄로 줄어 #stream 의 clientHeight 가 늘고, 브라우저가 스크롤 최대치 감소분만큼 scrollTop 을
      // 아래로 클램프한다. 그 클램프가 쏘는 (비프로그램적) scroll 이벤트가 다음 프레임에서 onScroll 의
      // 방향판정(`st < lastScrollTop-1`)에 걸려 stick 을 잘못 해제 → 뒤이어 도착하는 그 큰 메시지가
      // 바닥을 안 따라간다(짧은 1줄 메시지는 입력창이 안 줄어 클램프도 없어 정상 — 버그 비대칭의 원인).
      // async 인 scheduleRelayout 로는 relayout 이 다음 프레임에 돌아 클램프 이벤트에게 선수를 뺏긴다.
      // 여기서 total/sizer 를 즉시 재계산해 scrollHeight 를 최신화한 뒤 setScrollTop(가드 vtProgrammatic)
      // 으로 바닥을 다시 잡아 lastScrollTop 을 바닥으로 동기 → 지연 클램프 이벤트가 와도 st==lastScrollTop
      // 라 오해제되지 않는다. stickBottom=false(사용자가 위로 스크롤)면 no-op → 사용자 스크롤 존중(회귀 0).
      const vtPinBottom = () => {
        if (!stickBottom || vtJumpTop) return;
        if (perfNow() < userIntentUntil) return; // 실제 제스처 직후 = 사용자 우선(바닥으로 튕기지 않음).
        let total = 0;
        for (const it of vtItems) { it.top = total; total += slotH(it); }
        vtSizer.style.height = total + "px";
        // ★착지점은 모델 추정(total+40)이 아니라 실측 scrollHeight — 브라우저가 max 로 클램프한다.
        //  미측정 아이템이 크면 추정치는 바닥에 못 닿았다(실측 최대 3,381px 미달). +40 슬랙이
        //  뷰포트 높이보다 작아 open-loop 오차가 그대로 노출되던 구조를 닫는다.
        setScrollTop(getScrollH());
      };

      // 아이템 높이 실측 — 측정되면 model 갱신 후 relayout(추정→실측 정합). stick 유지 중이면 실측
      // 콜백에서 즉시 바닥 재-pin(추정→실측으로 커진 높이만큼 바닥이 더 내려간 것을 그 자리에서 따라감).
      const vtObserver = new ResizeObserver((entries) => {
        let changed = false;
        for (const e of entries) {
          const it = vtIndex.get(e.target);
          if (!it) continue;
          const h = e.target.offsetHeight;
          if (h > 0 && (!it.measured || Math.abs(it.h - h) > 0.5)) {
            it.h = h; it.measured = true; changed = true;
          }
        }
        if (changed) { vtPinBottom(); scheduleRelayout(); }
      });
      // 컨테이너(#stream) 크기 변화 = 입력창 자동높이 변동 등 → 클램프 유발. stick 이면 동기 재-pin.
      const vtContainerRO = new ResizeObserver(() => { vtPinBottom(); scheduleRelayout(); });
      vtContainerRO.observe(stream);

      let vtRaf = 0;
      const scheduleRelayout = () => {
        if (vtRaf) return;
        vtRaf = requestAnimationFrame(() => { vtRaf = 0; relayout(); });
      };
      const setScrollTop = (v) => {
        vtProgrammatic = true;
        vtProgUntil = perfNow() + 160; // stale scroll 이벤트 흡수 창(위 주석).
        const el = scEl();
        el.scrollTop = v;
        lastScrollTop = el.scrollTop; // 프로그램적 이동 = 사용자 스크롤 방향 비교 기준을 즉시 동기(스냅 후 오판 방지).
        requestAnimationFrame(() => { vtProgrammatic = false; });
      };

      const relayout = () => {
        const pS = pageScroll();       // 모바일 페이지 스크롤 모드?
        const clientH = getClientH();  // 데스크탑=#stream, 모바일=뷰포트(윈도 스크롤러).
        // 앵커(프리펜드/측정 점프 방지) — top 재계산 *전* OLD top 으로 현재 뷰 상단 아이템의 화면
        // 오프셋을 기록해야 위쪽 높이 변화를 실제로 보정한다. (재계산 후 잡으면 off 가 상쇄돼 no-op.)
        let anchor = null;
        if (!stickBottom && !vtJumpTop && clientH > 0) {
          const st = getScrollTop();
          for (const it of vtItems) {
            if (it.top + slotH(it) > st) { anchor = { it: it, off: it.top - st }; break; }
          }
        }

        // 누적 top(슬롯=실측+gap) + 총합 → sizer 높이(스크롤바). 위 루프의 OLD top 을 여기서 NEW 로 갱신.
        let total = 0;
        for (const it of vtItems) { it.top = total; total += slotH(it); }
        vtSizer.style.height = total + "px";
        if (clientH === 0) return; // 숨김(다른 뷰) → 마운트 스킵.

        // 마운트 범위 결정. 모바일 페이지 스크롤 = 전량 마운트(문서가 스크롤하므로 윈도잉 오프셋
        // 회피 — vtCap 이 노드 상한 유지). 데스크탑 = ±버퍼 윈도잉(스틱이면 하단, Home 점프면 상단).
        let first = -1, last = -1;
        if (pS) {
          if (vtItems.length > 0) { first = 0; last = vtItems.length - 1; }
        } else {
          const scrollTop = stickBottom ? Math.max(0, total - clientH) : (vtJumpTop ? 0 : getScrollTop());
          const viewTop = scrollTop - VT_BUFFER;
          const viewBot = scrollTop + clientH + VT_BUFFER;
          for (let i = 0; i < vtItems.length; i++) {
            const it = vtItems[i];
            if (it.top + slotH(it) < viewTop) continue;
            if (it.top > viewBot) break;
            if (first === -1) first = i;
            last = i;
          }
        }

        // 마운트 집합 교체 — 범위 밖 detach, 범위 안을 순서대로 mount(노드 참조·observer 유지).
        if (first === -1) {
          while (vtWindow.firstChild) vtWindow.removeChild(vtWindow.firstChild);
          vtWindow.style.transform = "translateY(0px)";
        } else {
          const desired = [];
          for (let i = first; i <= last; i++) desired.push(vtItems[i].node);
          const desiredSet = new Set(desired);
          for (const ch of Array.from(vtWindow.children)) {
            if (!desiredSet.has(ch)) vtWindow.removeChild(ch);
          }
          for (let k = 0; k < desired.length; k++) {
            const node = desired[k];
            const cur = vtWindow.children[k];
            if (cur !== node) vtWindow.insertBefore(node, cur || null);
          }
          vtWindow.style.transform = "translateY(" + vtItems[first].top + "px)";
        }

        // 스크롤 위치 확정 — 스틱이면 하단, 아니면 앵커 복원(둘 다 프로그램적 = 리스너 무시).
        // 모바일 페이지 스크롤에선 하단 = 문서 전체 높이(헤더·입력 포함)라 getScrollH() 로 클램프.
        if (stickBottom) {
          setScrollTop(pS ? getScrollH() : total + 40); // 브라우저가 최대(하단)로 클램프.
        } else if (vtJumpTop) {
          setScrollTop(0); vtJumpTop = false; // 로드된 맨위 안착(프로그램적 = loadOlder 미발화).
        } else if (anchor && !pS) {
          // 앵커 복원은 데스크탑 윈도잉·측정 점프 방지용. 페이지스크롤(pS)에선 네이티브 스크롤 +
          // vtPrependOlder 의 delta 보정이 이미 안정화하므로 setScrollTop 을 또 걸면 스크롤과 싸운다.
          setScrollTop(anchor.it.top - anchor.off);
        }
        // "↓ 최신" 점프버튼 갱신 — 프로그램적 스크롤(setScrollTop=vtProgrammatic)은 scroll
        // 리스너가 조기 return 해 updateChatJump 를 건너뛴다. relayout 끝에서 stickBottom 기준
        // 직접 갱신해야 전송 후 하단인데(stickBottom=true) 버튼이 남던 버그를 막는다.
        updateChatJump();
      };

      // 날짜 구분선 재계산 — 구조 변경(append/prependOlder/history batch/cap) 후 호출. 오래된→최신
      // walk 하며 날짜 바뀌는 첫 아이템 앞에 divider 를 둔다. ★기존 divider 는 dateKey 로 풀링해
      // *재사용*(측정 높이 h 보존): 매 append 마다 전량 파괴·재생성하면 화면 밖 divider 가 미측정
      // 추정치로 되돌아 총높이가 흔들리고, 앵커가 그만큼 스크롤을 밀어 사용자가 이력 열람 중
      // 새 메시지마다 위로 튕겼다(원인 C). 경계는 날짜당 1회 = dateKey 유일 → 안전한 재사용 키.
      const vtRecomputeDividers = () => {
        const pool = new Map(); // dateKey -> 재사용 후보 divider item(측정 h 보존).
        for (let i = vtItems.length - 1; i >= 0; i--) {
          const it = vtItems[i];
          if (it.isDivider) {
            if (it.dateKey != null && !pool.has(it.dateKey)) pool.set(it.dateKey, it);
            else { // 중복 키(비정상 순서) = 폐기.
              vtObserver.unobserve(it.node);
              vtIndex.delete(it.node);
              if (it.node.parentNode) it.node.parentNode.removeChild(it.node);
            }
            vtItems.splice(i, 1);
          }
        }
        let prevKey = null;
        for (let i = 0; i < vtItems.length; i++) {
          const ts = vtTsOf(vtItems[i].node);
          if (ts === null) continue;
          const k = dateKey(ts);
          if (k !== prevKey) {
            let it = pool.get(k);
            if (it) { pool.delete(k); } // 재사용 — h/measured/node 그대로(DOM 마운트 유지, relayout 이 정렬).
            else {
              const div = document.createElement("div");
              div.className = "date-divider";
              const span = document.createElement("span");
              span.textContent = fmtDate(ts);
              div.appendChild(span);
              it = { node: div, h: 0, measured: false, isDivider: true, top: 0, dateKey: k };
              vtIndex.set(div, it);
              vtObserver.observe(div);
            }
            vtItems.splice(i, 0, it);
            prevKey = k;
            i++; // 방금 삽입한 divider 건너뜀.
          }
        }
        for (const it of pool.values()) { // 더 이상 필요 없는 잔여 divider 폐기.
          vtObserver.unobserve(it.node);
          vtIndex.delete(it.node);
          if (it.node.parentNode) it.node.parentNode.removeChild(it.node);
        }
      };

      const vtMakeItem = (node) => ({
        node: node, h: 0, measured: false,
        isDivider: !!(node.classList && node.classList.contains("date-divider")), top: 0,
      });

      // 아이템 추가. 이름은 append 지만 **자리는 ts 가 정한다**(2026-07-29).
      //
      // ★왜 정렬 삽입인가: 종전엔 무조건 맨 뒤로 push 했다. 그래서 어떤 경로로든 과거
      //  항목이 한 번 들어오면 리스트가 즉시 시간 역순이 됐고("15:01:52 아래에 14:12:53"
      //  실사고), 우리는 그걸 **호출부마다** stale 가드를 달아 막아 왔다 — 메시지·활동·
      //  선택지·통지·첨부… 그리고 새 경로가 생길 때마다 또 샜다(오늘까지 3회). 가드를
      //  네 번째로 얹는 대신, 리스트가 **구조적으로** ASC 를 유지하게 한다. 그러면 늦게
      //  도착한 과거 항목은 버려지지도(정보 손실) 바닥에 붙지도(순서 붕괴) 않고 제자리에
      //  꽂힌다. 호출부 가드는 그대로 둔다 — 애초에 안 그리는 게 더 싸므로 중복이 아니라
      //  1차 방어다.
      //
      // 비용: 정상 흐름(도착=최신)에서는 while 이 0회 — push 와 동일. 역행분만 뒤에서
      //  몇 칸 걸어 들어간다. ts 없는 항목(구분선·ts 미상)은 만나면 멈춰 그 뒤에 놓는다.
      const vtAppend = (node) => {
        if (vtIndex.has(node)) return;
        const it = vtMakeItem(node);
        const ts = vtTsOf(node);
        let idx = vtItems.length;
        if (ts !== null && Number.isFinite(ts)) {
          while (idx > 0) {
            const prev = vtTsOf(vtItems[idx - 1].node);
            if (prev === null || !Number.isFinite(prev) || prev <= ts) break;
            idx--;
          }
        }
        vtItems.splice(idx, 0, it);
        vtIndex.set(node, it);
        vtObserver.observe(node);
        vtRecomputeDividers();
        vtCap();
        scheduleRelayout();
      };

      // 과거 배치(오래된→최신)를 앞(위)에 붙임. 늘어난 위 높이만큼 scrollTop 을 먼저 밀어 점프 방지
      // (측정 후 앵커가 정밀 보정). older 로드는 not-stick(스크롤업) 상태에서만 호출됨.
      const vtPrependOlder = (nodes) => {
        if (!nodes || !nodes.length) return;
        const newItems = [];
        let addedH = 0;
        for (const node of nodes) {
          if (vtIndex.has(node)) continue;
          const it = vtMakeItem(node);
          newItems.push(it);
          vtIndex.set(node, it);
          vtObserver.observe(node);
          addedH += slotH(it);
        }
        if (!newItems.length) return;
        vtItems.unshift.apply(vtItems, newItems);
        if (addedH) setScrollTop(getScrollTop() + addedH);
        vtRecomputeDividers();
        scheduleRelayout();
      };

      const vtRemove = (node) => {
        const it = vtIndex.get(node);
        if (!it) return;
        vtObserver.unobserve(node);
        vtIndex.delete(node);
        const idx = vtItems.indexOf(it);
        if (idx !== -1) vtItems.splice(idx, 1);
        if (node.parentNode === vtWindow) vtWindow.removeChild(node);
        scheduleRelayout();
      };

      const vtClear = () => {
        for (const it of vtItems) {
          vtObserver.unobserve(it.node);
          if (it.node.parentNode) it.node.parentNode.removeChild(it.node);
        }
        vtItems.length = 0;
        vtIndex.clear();
        scheduleRelayout();
      };

      // 보관 상한 — 하단 고정(라이브) 중일 때만 최古 detached 아이템부터 드롭(보던 이력 보존).
      // dedup 키 정리 + oldestLoadedTs 갱신(구 refreshOldestCursorAfterPrune 대체)을 접어 넣는다.
      const vtCap = () => {
        if (!stickBottom || vtItems.length <= VT_MAX_ITEMS) return;
        let dropped = 0;
        while (vtItems.length > VT_MAX_ITEMS) {
          const it = vtItems[0];
          if (it.node.parentNode === vtWindow) break; // 마운트(가시) 최古면 중단.
          vtObserver.unobserve(it.node);
          vtIndex.delete(it.node);
          vtItems.shift();
          if (it.node.dataset && it.node.dataset.ts) {
            const t = parseInt(it.node.dataset.ts, 10);
            const ty = it.node.dataset.type || "";
            if (Number.isFinite(t) && ty.indexOf("channel.message") === 0) {
              const role = ty.endsWith(".out") ? "assistant" : "user";
              renderedMsgKeys.delete(msgKey(t, role));
            }
          }
          dropped += 1;
        }
        if (dropped) {
          for (const it of vtItems) {
            const ts = vtTsOf(it.node);
            if (ts !== null) { oldestLoadedTs = ts; break; }
          }
          if (reachedOldest) reachedOldest = false; // 앞이 더 있을 수 있음 → 재로드 가능.
          vtRecomputeDividers();
        }
        capKeyStore(renderedActivityKeys);
        capKeyStore(activityByStep);
      };

      // 채팅을 최신(하단)으로 고정 — 뷰 진입·전송·초기 이력 로드 후.
      const scrollChatToNewest = () => {
        stickBottom = true;
        scheduleRelayout();
        // 전송/로드 직후 추정→실측·입력창 축소 클램프가 여러 프레임에 걸쳐 바닥을 흔들어 "종종 끝까지
        //   스크롤 안 됨"이 났다(단일 relayout/pin 이 지연 height 변화보다 먼저 끝나 놓침). 몇 프레임
        //   연속 재-pin 해 지연분을 넘어 확실히 바닥 안착. stickBottom 풀리면(사용자 위로 스크롤) 즉시
        //   중단 = 존중. rAF 체인이라 비용 미미.
        let n = 0;
        const settle = () => {
          if (!stickBottom || vtJumpTop || n++ >= 4) return;
          vtPinBottom();
          requestAnimationFrame(settle);
        };
        requestAnimationFrame(settle);
      };

      // 스크롤 리스너 — stick 추적 + 점프버튼 + 상단 근처면 older 로드(센티넬 IntersectionObserver 대체).
      // scEl() 로 라우팅 — 데스크탑=#stream 스크롤, 모바일=문서(window) 스크롤. 그래서 #stream 과
      // window 둘 다에 붙이되(모드별로 한쪽만 발화), 핸들러는 활성 스크롤러를 읽는다.
      const onScroll = () => {
        const st = getScrollTop();
        const gap = gapNow();
        // ★재stick 은 프로그램적 가드 **밖** — "지금 바닥에 있다" 는 누가 스크롤했든 참인 관측이다.
        //  종전엔 이 판정이 가드 뒤에 있어, 콘텐츠가 움직이는 동안 vtProgUntil 이 계속 갱신되며
        //  복귀가 사실상 영구 차단됐다(한 번 새면 사용자가 "↓최신" 을 누를 때까지 안 돌아옴).
        //  단 사용자 우선권 창에는 재개하지 않는다(위로 스크롤 중인 사람을 되잡지 않기 위해).
        if (gap < NEAR_BOTTOM_PX && st >= lastScrollTop && perfNow() >= userIntentUntil) stickBottom = true;
        // 프로그램적 스크롤(+그 stale 잔향 창) 은 **해제** 판정에서만 제외 — 위 vtProgUntil 주석.
        if (vtProgrammatic || perfNow() < vtProgUntil) { lastScrollTop = st; return; }
        // 위로 스크롤 = 과거 열람 의도 → 해제. 단 실제로 움직였을 때만(팬텀 이벤트 차단).
        if (st < lastScrollTop - 1 && gap > MOVED_EPS_PX) stickBottom = false;
        lastScrollTop = st;
        updateChatJump();
        // 모바일 페이지스크롤(전체 마운트)에선 스크롤마다 relayout 불필요 — 아이템 위치가 고정이라
        // 재마운트/anchor-setScrollTop 이 네이티브 스크롤과 싸워 *끊김*을 만든다. 데스크탑(윈도잉)만
        // 스크롤 중 relayout(가시범위 재계산). 콘텐츠 변화(append/prepend/measure)는 별도 경로.
        if (!pageScroll()) scheduleRelayout();
        if (st < VT_BUFFER && !loadingOlder && !reachedOldest) void loadOlderHistory();
      };
      stream.addEventListener("scroll", onScroll, { passive: true });
      window.addEventListener("scroll", () => { if (pageScroll()) onScroll(); }, { passive: true });
      // 사용자 위로-스크롤 제스처 = 명시적 unstick(과거 열람 의도) — scroll 이벤트가 프로그램적
      // 잔향 창(vtProgUntil)에 흡수되는 동안에도 실제 유저 제스처는 즉시 stick 을 해제하게 한다
      // (스트리밍 중에도 위로 스크롤해 과거를 볼 수 있음). 아래로 향한 제스처는 무시(팔로우 유지·
      // nearBottom 재stick 은 onScroll 이 담당). touch 는 시작 Y 대비 아래로 끌면(=콘텐츠 위로)
      // 위로-스크롤. wheel/touch 는 데스크탑=#stream·모바일=문서 공통 발생.
      // ★제스처는 *신호* 일 뿐 — 해제 확정은 다음 프레임의 실측 gap 이 한다. deltaY<0 만 보고 껐더니
      //  실제 스크롤 0px 인 팬텀 wheel(트랙패드 관성·대각 스와이프 등)이 팔로우를 비가역적으로 끄고
      //  있었다(재현 실측). 우선권 창은 즉시 열어 pin 이 사용자와 싸우지 않게 하고, 해제는 정말로
      //  바닥에서 떨어졌을 때만. 해제되면 그 자리에서 "↓최신" 을 띄운다(종전엔 무피드백이었다).
      const userScrollUp = () => {
        userIntentUntil = perfNow() + 400;
        requestAnimationFrame(() => {
          if (gapNow() > MOVED_EPS_PX) { stickBottom = false; updateChatJump(); }
        });
      };
      stream.addEventListener("wheel", (e) => { if (e.deltaY < 0) userScrollUp(); }, { passive: true });
      window.addEventListener("wheel", (e) => { if (pageScroll() && e.deltaY < 0) userScrollUp(); }, { passive: true });
      let _touchY = 0;
      const onTouchStart = (e) => { _touchY = e.touches && e.touches[0] ? e.touches[0].clientY : 0; };
      const onTouchMove = (e) => { const y = e.touches && e.touches[0] ? e.touches[0].clientY : 0; if (y - _touchY > 6) userScrollUp(); _touchY = y; };
      stream.addEventListener("touchstart", onTouchStart, { passive: true });
      stream.addEventListener("touchmove", onTouchMove, { passive: true });
      window.addEventListener("touchstart", (e) => { if (pageScroll()) onTouchStart(e); }, { passive: true });
      window.addEventListener("touchmove", (e) => { if (pageScroll()) onTouchMove(e); }, { passive: true });

      /**
       * 편집 중인 요소인가 — 전역 키 단축키가 양보해야 하는 대상.
       * input(텍스트류)·textarea·select·contenteditable. readOnly/disabled 는 편집 아님.
       */
      const isEditableTarget = (el) => {
        if (!el || typeof el.tagName !== "string") return false;
        const tag = el.tagName.toUpperCase();
        if (tag === "TEXTAREA" || tag === "SELECT") return !el.disabled;
        if (tag === "INPUT") {
          // 버튼류(button/checkbox/radio/submit 등)는 편집이 아니다 — 그 위에선 단축키 유효.
          const t = String(el.type || "text").toLowerCase();
          const nonText = ["button", "checkbox", "radio", "submit", "reset", "file", "image", "range", "color"];
          return !nonText.includes(t) && !el.readOnly && !el.disabled;
        }
        return el.isContentEditable === true;
      };

      // 키보드 네비 — PageUp/Down·Home·End 로 채팅 리스트 스크롤. 가상화(absolute vt-window)라
      // 네이티브 키 스크롤이 안 먹어서 명시 처리한다. 채팅 뷰 활성 + 입력창에 실 초안이 없을 때만
      // (작성 중이면 커서 이동 존중). preventDefault 로 브라우저 기본(포커스 요소 scrollIntoView
      // 로 인한 가로 밀림)도 막는다.
      document.addEventListener("keydown", (e) => {
        if (document.body.getAttribute("data-main") !== "stream") return; // 채팅 뷰만
        if (e.key !== "PageDown" && e.key !== "PageUp" && e.key !== "Home" && e.key !== "End") return;
        if (e.altKey || e.ctrlKey || e.metaKey) return; // 조합키는 브라우저/OS 몫.
        // ★편집 중인 요소면 **무조건** 양보한다 (2026-07-29 사용자 신고). 종전엔 `chat-input`
        //  하나만, 그것도 "내용이 있을 때만" 봐서 — 선택지의 '기타' 입력, 세션 이름 편집,
        //  검색 필드 등 **다른 모든 입력에서 Home/End 가 채팅 스크롤로 먹혔다**. 빈 입력창
        //  에서도 커서 이동은 정당한 동작이다(빈 값이라고 편집 중이 아닌 게 아니다).
        //  판정은 "무슨 요소인가"(input/textarea/contenteditable/select)로 — 특정 id 목록은
        //  새 입력이 생길 때마다 또 빠진다(이번이 그 사례).
        const tgt = e.target;
        if (isEditableTarget(tgt)) return;
        e.preventDefault();
        const page = Math.max(60, getClientH() * 0.9);
        if (e.key === "PageDown") { stickBottom = false; scEl().scrollTop += page; }
        else if (e.key === "PageUp") { stickBottom = false; scEl().scrollTop -= page; }
        else if (e.key === "End") scrollChatToNewest();          // 맨아래(최신) 고정.
        else if (e.key === "Home") { stickBottom = false; vtJumpTop = true; scheduleRelayout(); } // 로드된 맨위 안착.
      });

      // 최신으로 점프 버튼 — 하단 고정이면 숨김, 위로 스크롤(과거 열람) 중이면 표시.
      const chatJump = document.getElementById("chat-jump");
      const updateChatJump = () => { if (chatJump) chatJump.hidden = stickBottom; };
      if (chatJump) {
        chatJump.addEventListener("click", () => {
          stickBottom = true;
          scrollChatToNewest();
          updateChatJump();
        });
      }

      // 파일 확장자 → highlight.js 언어. diff 코드 하이라이팅 언어 판별(경로 기반).
      const HL_EXT = { cs:"csharp", ts:"typescript", tsx:"typescript", js:"javascript", jsx:"javascript", mjs:"javascript", cjs:"javascript", py:"python", java:"java", go:"go", rs:"rust", cpp:"cpp", cc:"cpp", cxx:"cpp", hpp:"cpp", h:"cpp", c:"c", rb:"ruby", php:"php", sh:"bash", bash:"bash", zsh:"bash", json:"json", jsonc:"json", yaml:"yaml", yml:"yaml", toml:"ini", ini:"ini", sql:"sql", css:"css", scss:"scss", less:"less", html:"xml", htm:"xml", xml:"xml", vue:"xml", svelte:"xml", md:"markdown", kt:"kotlin", kts:"kotlin", swift:"swift", lua:"lua", dart:"dart", scala:"scala", pl:"perl", r:"r", ps1:"powershell" };
      const hlLangFromPath = (p) => {
        if (!p || typeof p !== "string") return null;
        const ext = (p.split(/[\\/]/).pop() || "").split(".").pop().toLowerCase();
        return HL_EXT[ext] || null;
      };

      // 리치 diff 블록(Edit/Write, ADR 2026-07-09) — 접이식 초록·빨강 diff. 라이브 스텝·
      // 이력 줄 공용. 캡처(런타임)가 구조화한 diff 를 여기선 *렌더*만(초록/빨강 뷰=채널 몫).
      /**
       * diff 각 줄의 **파일 내 줄 번호** — 순수 함수(DOM 안 봄. 그래서 검사 가능하다).
       *
       * ★한 칸에 두 체계를 섞지 않는다. 편집 후 파일 기준 번호만 쓰고, **지워진 줄은
       *  번호가 없다**(결과 파일에 그 줄이 없으므로 — 있는 척하면 클릭해 가 봤을 때 딴 줄이다).
       *  삭제 위치는 앞뒤 문맥 줄 번호와 헤더의 시작 줄로 읽힌다.
       *
       * @param lines ActivityDiffLine[] — {op,text}
       * @param startLine 이 diff 가 시작하는 파일 줄(1-based). 없으면 전부 null.
       * @returns lines 와 같은 길이의 (번호|null) 배열
       */
      const diffLineNos = (lines, startLine) => {
        const rows = Array.isArray(lines) ? lines : [];
        if (typeof startLine !== "number" || !(startLine >= 1)) return rows.map(() => null);
        let n = Math.floor(startLine);
        return rows.map((ln) => {
          const op = ln && ln.op;
          if (op === "-") return null;   // 결과 파일엔 없는 줄
          const cur = n; n += 1;
          return cur;
        });
      };

      /**
       * 번호 칸의 폭 — 번호가 **하나도 없으면 0**(칸 자체를 만들지 않는다).
       *
       * ★`Math.max(0, ...)` 로 뭉뚱그리면 번호가 없어도 폭 1 이 나와 빈 칸이 생긴다
       *  (실제로 그랬다 — 헤드리스 실측에서 잡았다). 없음과 0 은 다른 것이다.
       */
      const diffNoWidth = (nos) => {
        const known = (nos || []).filter((x) => typeof x === "number");
        return known.length === 0 ? 0 : String(Math.max.apply(null, known)).length;
      };

      const buildDiffBlock = (diff) => {
        const wrap = document.createElement("div");
        wrap.className = "act-diff";
        const head = document.createElement("div");
        head.className = "act-diff-head";
        const caret = document.createElement("span");
        caret.className = "act-diff-caret"; caret.textContent = "▸";
        head.appendChild(caret);
        if (diff.path) {
          const ps = document.createElement("span");
          ps.className = "act-diff-path";
          // 경로 옆에 시작 줄 — 에디터에서 `파일:줄` 로 바로 찾아가는 관습 그대로.
          const pathText =
            diff.path + (typeof diff.startLine === "number" ? ":" + diff.startLine : "");
          ps.textContent = pathText;
          // ★클릭 = `경로:줄` 복사 (2026-08-02). 에디터로 *직접 열기*는 안 한다 —
          //  브라우저는 file:// 를 못 열고, 데몬이 OS `open` 을 대신 실행하는 방식은
          //  대시보드에 로그인이 없어(포트에 닿는 것이 곧 권한) 임의 실행 통로가 되며,
          //  폰에서 누르면 **데몬 기계에서** 창이 떠 누른 사람은 못 본다.
          //  복사는 폰 포함 모든 환경에서 동작하고 위험이 0이다.
          ps.title = "클릭하면 경로 복사";
          ps.classList.add("act-diff-path-copy");
          ps.addEventListener("click", (e) => {
            e.stopPropagation(); // 부모 스텝 토글을 뺏지 않는다(헤더는 원래 토글 대상).
            if (!navigator.clipboard) return;
            navigator.clipboard.writeText(pathText).then(
              () => {
                try {
                  if (typeof showToast === "function") showToast("경로를 복사했습니다", "ok");
                } catch { /* noop */ }
              },
              () => { /* 권한 거부 등 — 조용히 무시(복사는 보조 기능) */ },
            );
          });
          head.appendChild(ps);
          // ★편집기로 열기 — 서버가 OS 기본앱으로 연다(`/api/open-path`). 안전은 서버가
          //  진다: 등록 프로젝트 **루트 하위**만 + realpath 로 심링크 탈출 차단 +
          //  **실행권한 파일 거부**(macOS `open` 은 .app·스크립트를 실행한다). 프록시엔
          //  same-origin(CSRF) 가드가 걸려 있어 외부 페이지가 이 부작용을 못 쏜다.
          const ob = document.createElement("button");
          ob.type = "button";
          ob.className = "act-diff-open";
          ob.textContent = "↗";
          ob.title = "기본 앱으로 열기(등록된 프로젝트 안의 파일만)";
          ob.addEventListener("click", (e) => {
            e.stopPropagation();
            fetch("/api/open-path", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ path: diff.path }),
            })
              .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
              .then(({ ok, d }) => {
                if (ok) return;
                // 실패 사유를 그대로 보여준다 — "안 열렸다" 만으론 왜인지 모른다.
                try {
                  if (typeof showToast === "function") {
                    showToast((d && d.error) || "열기 실패", "warn");
                  }
                } catch { /* noop */ }
              })
              .catch(() => {
                try {
                  if (typeof showToast === "function") showToast("열기 요청 실패", "bad");
                } catch { /* noop */ }
              });
          });
          head.appendChild(ob);
        }
        const stat = document.createElement("span");
        stat.className = "act-diff-stat";
        const add = document.createElement("span");
        add.className = "dadd"; add.textContent = "+" + (diff.added || 0);
        const del = document.createElement("span");
        del.className = "ddel"; del.textContent = "-" + (diff.removed || 0);
        stat.appendChild(add); stat.appendChild(document.createTextNode(" ")); stat.appendChild(del);
        head.appendChild(stat);
        const body = document.createElement("div");
        body.className = "act-diff-body";
        const pre = document.createElement("pre");
        pre.className = "act-diff-pre";
        const lang = hlLangFromPath(diff.path); // 경로 확장자로 언어 판별(있으면 코드부 하이라이트).
        const nos = diffLineNos(diff.lines, diff.startLine);
        // 번호 폭은 가장 큰 번호에 맞춘다(줄마다 들쭉날쭉하면 코드가 계단처럼 흔들린다).
        const noW = diffNoWidth(nos);
        let li = -1;
        for (const ln of (diff.lines || [])) {
          li += 1;
          const row = document.createElement("div");
          const op = ln.op === "+" ? "add" : ln.op === "-" ? "del" : "ctx";
          row.className = "dl dl-" + op;
          const text = ln.text != null ? ln.text : "";
          // op 접두(+/-/공백)는 색 신호로 유지, 코드부는 hljs 로 언어별 하이라이트(줄 단위).
          // 번호가 없으면(파일을 못 읽음·상한 초과) 거터 자체를 안 만든다 — 빈 칸만 남기지 않는다.
          if (noW > 0) {
            const noSpan = document.createElement("span");
            noSpan.className = "dl-no";
            noSpan.textContent = String(nos[li] == null ? "" : nos[li]).padStart(noW, "\u00a0");
            row.appendChild(noSpan);
          }
          const opSpan = document.createElement("span");
          opSpan.className = "dl-op"; opSpan.textContent = (ln.op || " ") + " ";
          const codeSpan = document.createElement("span");
          codeSpan.className = "dl-code";
          if (lang && text && typeof window.hljs !== "undefined") {
            try { codeSpan.innerHTML = window.hljs.highlight(text, { language: lang, ignoreIllegal: true }).value; }
            catch { codeSpan.textContent = text; }
          } else { codeSpan.textContent = text; }
          row.appendChild(opSpan); row.appendChild(codeSpan);
          pre.appendChild(row);
        }
        if (diff.truncated) {
          const t = document.createElement("div");
          t.className = "dl dl-trunc"; t.textContent = "… (이하 생략 — 크기 제한)";
          pre.appendChild(t);
        }
        body.appendChild(pre);
        // 토글은 스텝(부모) 단위 — 헤더는 접힘 시 요약(경로 + N/-M)만 보여준다(클릭 핸들러 없음).
        wrap.appendChild(head); wrap.appendChild(body);
        return wrap;
      };

      // 리치 출력 블록(Bash/Read/Grep/Glob, ADR 2026-07-09 슬라이스 2/3) — 접이식 결과 프리뷰.
      const buildOutputBlock = (output) => {
        const wrap = document.createElement("div");
        wrap.className = "act-output" + (output.isError ? " err" : "");
        const head = document.createElement("div");
        head.className = "act-output-head";
        const caret = document.createElement("span");
        caret.className = "act-diff-caret"; caret.textContent = "▸";
        const lbl = document.createElement("span");
        lbl.className = "act-output-lbl";
        lbl.textContent = output.isError ? "출력 (에러)" : "출력";
        head.appendChild(caret); head.appendChild(lbl);
        const body = document.createElement("div");
        body.className = "act-diff-body";
        const pre = document.createElement("pre");
        pre.className = "act-output-pre";
        pre.textContent = (output.text != null ? output.text : "") + (output.truncated ? "\n… (이하 생략 — 크기 제한)" : "");
        body.appendChild(pre);
        // 토글은 스텝(부모) 단위 — 헤더는 접힘 시 요약("출력")만. (클릭 핸들러 없음.)
        wrap.appendChild(head); wrap.appendChild(body);
        return wrap;
      };

      // ExitPlanMode 계획 카드 — 계획(마크다운)을 *항상 보이게* 렌더(펼침 뒤 숨김 아님, 사용자가
      // 계획을 봐야 하므로). detail 1줄로 잘려 안 보이던 갭 수정(A안). renderMarkdown 은 봇출력용
      // sanitize 렌더(markdown.js) 재사용. plan 없으면 호출 안 함.
      const buildPlanBlock = (plan) => {
        const wrap = document.createElement("div");
        wrap.className = "act-plan";
        const head = document.createElement("div");
        head.className = "act-plan-head";
        head.textContent = "📋 계획 (승인 대기)";
        const body = document.createElement("div");
        body.className = "act-plan-body md";
        try {
          body.innerHTML = (typeof renderMarkdown === "function")
            ? renderMarkdown(String(plan))
            : "";
          if (!body.innerHTML) body.textContent = String(plan); // 폴백(마크다운 실패=평문).
        } catch { body.textContent = String(plan); }
        wrap.appendChild(head); wrap.appendChild(body);
        return wrap;
      };

      // 리치 diff/출력이 없는 도구 스텝용 인라인 상세 블록 — 옛 사이드바(#step-detail) 대체.
      // 모든 도구 스텝을 "그 자리에서 펼침"으로 통일(2026-07-15). .act-output/.act-diff-body 재사용
      // 으로 기존 펼침 CSS·클릭 쿼리(:scope > .act-output)에 그대로 얹힘. 보여줄 게 없으면 null.
      const buildDetailBlock = (p) => {
        const detail = p && p.detail != null ? String(p.detail).trim() : "";
        const meta = [p && p.kind, p && p.adapter, p && p.model].filter(Boolean).join(" · ");
        if (detail === "" && meta === "") return null;
        const wrap = document.createElement("div");
        wrap.className = "act-output";
        const head = document.createElement("div");
        head.className = "act-output-head";
        const caret = document.createElement("span");
        caret.className = "act-diff-caret"; caret.textContent = "▸";
        const lbl = document.createElement("span");
        lbl.className = "act-output-lbl"; lbl.textContent = "상세";
        head.appendChild(caret); head.appendChild(lbl);
        const body = document.createElement("div");
        body.className = "act-diff-body";
        const pre = document.createElement("pre");
        pre.className = "act-output-pre";
        pre.textContent = (meta ? meta + "\n\n" : "") + (detail || "(상세 정보 없음)");
        body.appendChild(pre);
        wrap.appendChild(head); wrap.appendChild(body);
        return wrap;
      };

      // ── 표면 A — 백그라운드 셸 인라인 칩 (ADR 2026-07-17 §5-A, Phase 3b) ──────────────
      // 백엔드 무변경(계약: "도구 result 텍스트에 bash_<id> 가 이미 있음 → 클라이언트에서 파싱").
      // file-ops launchBgShell 의 고정 문구 "…(bash_id: bash_xxxxxxxx). BashOutput(…" 만 매칭
      // (codex/openai 전용) — claude SDK 네이티브 Bash 의 tool_result 문구는 다른 포맷("Command
      // running in background with ID: …")이라 이 정규식이 매칭 안 함 = 이 칩은 자연히 미부착.
      // claude 백그라운드 셸은 표면 C(view-shells.js)가 SSE 관측 브리지로 별도 표시(ADR §6) —
      // 의도된 비대칭, cross-adapter 폴백 아님(어댑터 안에서 각자 닫힘, feedback_no_cross_adapter_fallback).
      const SHELL_CHIP_ID_RE = /\(bash_id:\s*(bash_[a-z0-9]+)\)/i;

      const shellChipStatusLabel = (entry) => {
        if (!entry || entry.status === "running") return "실행 중";
        if (entry.status === "killed") return "killed";
        return "exited(" + (entry.exitCode != null ? entry.exitCode : "?") + ")";
      };

      // shellRegistry(view-shells.js 공유, 단일 진실 소스)의 최신 상태를 부착된 칩(들)에 반영.
      // view-shells.js 의 handleShellStarted/handleShellExited·requestKillShell 이 매 상태변화마다
      // 이 함수를 호출(cross-file, typeof 가드 — 로드순서 무관, syncAgentsCounts 패턴 동형).
      const syncShellChip = (shellId) => {
        if (!shellId) return;
        const entry = (typeof shellRegistry !== "undefined") ? shellRegistry.get(shellId) : null;
        const chips = document.querySelectorAll(".act-shell-chip");
        for (const chip of chips) {
          if (chip.dataset.shellId !== shellId) continue;
          const running = !entry || entry.status === "running";
          const dot = chip.querySelector(".act-shell-chip-dot");
          if (dot) dot.className = "act-shell-chip-dot" + (running ? " running" : entry.status === "killed" ? " killed" : " exited");
          const txt = chip.querySelector(".act-shell-chip-txt");
          if (txt) txt.textContent = "🖥️ " + shellChipStatusLabel(entry);
          const killBtn = chip.querySelector(".act-shell-chip-kill");
          if (killBtn) {
            const killable = !entry || entry.killable !== false; // 부재=killable:true(계약).
            killBtn.style.display = (running && killable) ? "" : "none";
            killBtn.disabled = !!(entry && entry.killRequested);
            killBtn.title = entry && entry.killRequested ? "중지 요청…" : "셸 강제 종료";
          }
          const sdkNote = chip.querySelector(".act-shell-chip-sdk");
          if (sdkNote) sdkNote.style.display = (running && entry && entry.killable === false) ? "" : "none";
        }
      };

      // 도구 스텝 라인에 셸 칩을 부착(멱등 — 이미 이 shellId 로 부착돼 있으면 상태만 재동기화).
      // annotateToolDuration(background-drawer.js phase:end)이 output 텍스트에서 shellId 를
      // 찾으면 이 함수를 호출 — 그 자리(백그라운드 Bash 스텝 라인)에 라이브 칩을 얹는다.
      const attachShellChip = (lineEl, shellId) => {
        if (!lineEl || !shellId) return;
        let chip = lineEl.querySelector(":scope > .act-shell-chip");
        if (chip && chip.dataset.shellId === shellId) { syncShellChip(shellId); return; }
        if (chip) chip.remove(); // 방어적(정상 경로 X) — 다른 shellId 칩이 이미 있으면 교체.
        chip = document.createElement("span");
        chip.className = "act-shell-chip";
        chip.dataset.shellId = shellId;
        chip.title = "백그라운드 셸 " + shellId;
        const dot = document.createElement("span"); dot.className = "act-shell-chip-dot running";
        const txt = document.createElement("span"); txt.className = "act-shell-chip-txt"; txt.textContent = "🖥️ 실행 중";
        const sdkNote = document.createElement("span"); sdkNote.className = "act-shell-chip-sdk"; sdkNote.style.display = "none";
        sdkNote.textContent = "SDK 소유"; sdkNote.title = "claude 백그라운드 셸은 대화 턴 안에서만 제어됩니다.";
        const killBtn = document.createElement("button");
        killBtn.type = "button"; killBtn.className = "act-shell-chip-kill"; killBtn.textContent = "⏹️";
        killBtn.title = "셸 강제 종료";
        // 워커/서브 스폰 칩(.act-bg-link)과 클릭 핸들러 패턴 동형 — 스텝 펼침 클릭과 분리.
        killBtn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          if (typeof requestKillShell === "function") void requestKillShell(shellId);
        });
        chip.appendChild(dot); chip.appendChild(txt); chip.appendChild(sdkNote); chip.appendChild(killBtn);
        lineEl.appendChild(chip);
        syncShellChip(shellId); // 부착 시점 최신 상태 즉시 반영(이미 종료돼 있었을 수도 있음).
      };

      const buildActivityLine = (p) => {
        const line = document.createElement("div");
        // 스텝 = 클릭 가능 요소(P4 사이드바 상세가 여기 붙는다). 지금은 자리 예약만(no-op).
        line.className = "act-line act-step";
        line.dataset.threadkey = p.threadKey || "?";
        if (p.seq != null) line.dataset.seq = String(p.seq);
        const skill = skillStepInfo(p);
        const icon = document.createElement("span");
        icon.className = "act-icon";
        icon.textContent = skill ? "🛠" : (p.kind === "tool" ? "🔧" : "▶");
        const label = document.createElement("span");
        label.className = skill ? "act-label act-skill" : "act-label";
        label.textContent = skill ? "스킬: " + skill.name : (p.label || p.kind || "activity");
        // 인라인 상세(중립 detail = path=…, cmd: … 등). 단 diff 있는 스텝(Edit/Write)은 diff
        // 헤더가 경로+N/-M 을 이미 보여주므로 verbose 한 old_string=… 은 접힘 한 줄에서 생략(간결).
        // 스킬 스텝은 detail(=name=…)이 라벨과 중복이라 생략.
        const hasDiff = p.diff && Array.isArray(p.diff.lines);
        const detail = p.detail && !hasDiff && !skill
          ? Object.assign(document.createElement("span"), {
              className: "act-detail", textContent: p.detail,
            })
          : null;
        const meta = document.createElement("span");
        meta.className = "act-meta";
        meta.textContent = (p.model ? p.model + " · " : "") + "#" + (p.seq ?? "");
        line.appendChild(icon); line.appendChild(label);
        if (detail) line.appendChild(detail);
        line.appendChild(meta);
        // 인라인 스폰 스텝 ↔ 백그라운드 잡 링크(2026-07-13) — 서브에이전트/워커를 띄운 스텝이면
        // "🤖 백그라운드 ↗" 칩을 붙인다. 라벨 매칭은 어댑터-불문(원칙 #2): claude native Task
        // (=p.jobId), codex/openai bare `spawn_agent`/`run_in_background`, 그리고 claude 가
        // path= 크로스프로젝트 위임 시 쓰는 MCP 라벨 `mcp__agents__spawn_agent`·
        // `mcp__workers__run_in_background`(접미사 매칭으로 흡수). 클릭 시 드로어를 열고, jobId 가
        // 있으면(claude native Task) 그 잡카드로 스크롤·하이라이트(그 외는 graceful = 드로어 열기만).
        const spawnLabel = p.label || "";
        if (
          p.jobId ||
          spawnLabel === "Task" ||
          spawnLabel.endsWith("spawn_agent") ||
          spawnLabel.endsWith("run_in_background")
        ) {
          const bg = document.createElement("span");
          bg.className = "act-bg-link";
          const job = p.jobId ? jobCards.get(p.jobId) : null;
          const dot = document.createElement("span");
          dot.className = "act-bg-dot" + (job && job.status ? " " + job.status : "");
          const txt = document.createElement("span");
          txt.textContent = "🤖 백그라운드 ↗";
          bg.appendChild(dot); bg.appendChild(txt);
          bg.title = "백그라운드 작업 열기";
          bg.addEventListener("click", (e) => {
            e.stopPropagation(); // 스텝 펼침/상세 클릭과 분리.
            openBg();
            const j = p.jobId ? jobCards.get(p.jobId) : null;
            if (j && j.el && j.el.scrollIntoView) {
              j.el.scrollIntoView({ block: "nearest" });
              j.el.classList.add("bg-flash");
              setTimeout(() => { try { j.el.classList.remove("bg-flash"); } catch {} }, 1500);
            }
          });
          line.appendChild(bg);
        }
        // 리치 diff(Edit/Write) — 있으면 스텝 줄 아래 접이식 블록(flex-wrap 로 다음 줄).
        if (hasDiff) line.appendChild(buildDiffBlock(p.diff));
        // ExitPlanMode 계획 — 항상 보이는 계획 카드(즉시 append).
        if (p.plan) line.appendChild(buildPlanBlock(p.plan));
        // 클릭 = 도구 스텝 펼침/접힘(항상 인라인, sticky·hover 무관). 리치 diff·출력이 있으면
        // 그 블록을, 없으면 인라인 상세 블록(buildDetailBlock)을 lazy 생성해 그 자리에서 펼친다.
        // (2026-07-15 — 옛 사이드바 상세 분기 제거, 모든 도구 클릭을 인라인 펼침으로 통일.)
        line.addEventListener("click", () => {
          let block = line.querySelector(":scope > .act-diff, :scope > .act-output, :scope > .act-plan");
          if (!block) {
            const stored = activityByStep.get(stepKey(line.dataset.threadkey, line.dataset.seq)) || p;
            block = buildDetailBlock(stored);
            if (block) line.appendChild(block);
          }
          if (block) line.classList.toggle("expanded");
        });
        return line;
      };

      // 진행 중 턴 카드 경과시간 틱 (2026-07-26) — 열려 있는(미완료) 카드만 1초마다 갱신.
      // 카드 하나당 타이머를 두지 않고 단일 인터벌로 순회(cardByThread 는 스레드당 1개라 소수).
      // 마운트된 카드만(vtIndex) 갱신 = 비활성 세션·detached 노드는 건너뜀.
      setInterval(() => {
        if (typeof cardByThread === "undefined" || typeof fmtElapsed !== "function") return;
        for (const c of cardByThread.values()) {
          if (!c || c.closed || !c.elapsedEl || !vtIndex.has(c.group)) continue;
          c.elapsedEl.textContent = fmtElapsed(Date.now() - (c.startTs || Date.now()));
        }
      }, 1000);

      // 서브에이전트 threadKey = `${부모}::sub::<name>::<ts>` (agent-registry spawn_agent).
      // → 에이전트명 추출(없으면 null). 멀티에이전트 턴에서 "누가 무엇을" 구분 라벨용.
      const agentOfThread = (thread) => {
        const m = /::sub::(.+?)::/.exec(thread || "");
        return m ? m[1] : null;
      };

      // 턴 그룹 = 스텝 리스트(접이식 turn-card) + 답변 버블을 한 묶음으로 잡는 컨테이너.
      // 그룹 자체가 stream 에 삽입되고, 그 안에 스텝 카드 → (도착 시) 답변 버블 순으로 쌓인다.
      const createTurnCard = (p, ts, adapter, thread) => {
        const group = document.createElement("div");
        group.className = "turn-group";
        group.dataset.threadkey = thread;
        // ★숫자 ts 를 반드시 싣는다 (2026-07-29). 종전엔 헤더에 **표시용 문자열**만 있고
        //  dataset.ts 가 없어서, 이 그룹은 순서 기계장치에 **투명**했다(vtTsOf → null).
        //  그래서 화면 맨 아래가 도구 카드일 때 vtNewestTs() 가 그 카드를 건너뛰고 더
        //  오래된 메시지를 "최신"으로 잡았고, replay 로 온 과거 활동이 stale 판정을
        //  빠져나가 바닥에 붙었다(= 옛 카드가 최신 대화 사이에 끼는 실사고). 날짜 구분선도
        //  같은 이유로 도구 카드 주변에서 경계를 못 잡았다.
        if (p && typeof p.ts === "number" && Number.isFinite(p.ts)) group.dataset.ts = String(p.ts);
        // 로그 패널 필터(stream 직속 자식의 dataset.type 매칭)와 일관되도록 그룹에도 타입 표기.
        group.dataset.type = "llm.activity";

        applyFilter(group);
        const el = document.createElement("div");
        el.className = "ev turn-card in-group";
        el.dataset.type = "llm.activity";
        el.dataset.threadkey = thread;
        const head = document.createElement("div");
        head.className = "turn-head";
        const caret = document.createElement("span");
        caret.className = "turn-caret"; caret.textContent = "▼";
        const badge = document.createElement("span");
        badge.className = "act-badge act-" + adapter;
        badge.textContent = p.adapter || "?";
        const th = document.createElement("span");
        th.className = "turn-thread"; th.textContent = thread;
        const tsEl = document.createElement("span");
        tsEl.className = "ts"; tsEl.textContent = ts;
        const lastEl = document.createElement("span");
        lastEl.className = "turn-last"; lastEl.textContent = "";
        const countEl = document.createElement("span");
        countEl.className = "turn-count"; countEl.textContent = "0단계";
        head.appendChild(caret); head.appendChild(badge);
        // 서브에이전트면 "🤖 <name>" 라벨 — 누가 하는 작업인지 한눈에. raw threadKey 는 숨김.
        const agentName = agentOfThread(thread);
        if (agentName) {
          const ab = document.createElement("span");
          ab.className = "agent-badge";
          ab.textContent = "🤖 " + agentName;
          head.appendChild(ab);
          th.style.display = "none";
        }
        head.appendChild(th);
        // 진행 중 경과시간 (2026-07-26) — 서브에이전트가 끝나고 부모 턴이 조용히 이어지는
        //  구간에서 카드가 "멈춘 것처럼" 보이던 문제. 입력창 옆 상태줄(10px)은 모바일에서
        //  잘 안 보이므로, **사용자 시선이 있는 카드 자체**가 살아있음을 1초 틱으로 증명한다.
        //  완료 시 completeTurnGroup 이 최종값으로 고정.
        const elapsedEl = document.createElement("span");
        elapsedEl.className = "turn-elapsed";
        // 턴 비용 (2026-07-26) — 완료 시 turn_done 의 토큰을 여기 박는다. 종전엔 한 턴이
        //  25만 토큰을 써도 화면에 흔적이 없어 "이 턴 왜 비쌌나"를 사후에도 알 수 없었다.
        //  진행 중엔 비어 있고(아직 측정값이 없다) 완료 시에만 채운다.
        const costEl = document.createElement("span");
        costEl.className = "turn-cost";
        // 실제 모델 (2026-07-27) — adapter 배지는 "누가"(claude/codex)만 말하고 정작 *어떤 모델*이
        //  답했는지는 스텝을 클릭해야 보였다. 모델 프로파일(요청한 것)과 실제 응답 모델은 폴백·
        //  쿨다운으로 갈릴 수 있어(지금 codex 한도 소진 상태가 정확히 그 경우), 그 차이가 보이는
        //  게 이 표시의 핵심 가치다. 턴 도중 바뀌면 setTurnModel 이 "이전→현재" 로 드러낸다.
        const modelEl = document.createElement("span");
        modelEl.className = "turn-model";
        head.appendChild(tsEl); head.appendChild(lastEl); head.appendChild(countEl); head.appendChild(modelEl); head.appendChild(elapsedEl); head.appendChild(costEl);
        const body = document.createElement("div");
        body.className = "turn-body";
        // 수동 접힘(.collapsed) = 두 패널 공통(헤더 클릭, 기존 로그 토글 보존).
        // 완료 자동접힘(.done-collapsed) = 채팅 패널만(로그 패널 회귀 0). 수동 클릭이 우선.
        const setOpen = (open) => {
          el.classList.toggle("collapsed", !open);
          el.classList.remove("done-collapsed"); // 수동 조작이 자동접힘을 해제.
          caret.textContent = open ? "▼" : "▶";
        };
        head.addEventListener("click", () => setOpen(
          el.classList.contains("collapsed") || el.classList.contains("done-collapsed"),
        ));
        el.appendChild(head); el.appendChild(body);
        group.appendChild(el);
        // replyBubble = 이 턴의 진행(타이핑) 답변 슬롯(P5). 첫 delta 때 생성, out 도착 시 승격.
        return {
          group, el, body, countEl, lastEl, setOpen,
          elapsedEl, costEl, startTs: Date.now(), // 진행 중 경과 틱(위 주석) — 완료 시 고정.
          modelEl, replyModelEl: null, modelSeen: "", // 실제 응답 모델(카드 헤더 우선, 없으면 버블).
          lastSeq: -1, count: 0, closed: false,
          replyBubble: null, replyMsg: null, replyRaw: "",
          // 인터리브(2026-07-13): sawTextSegment=이 턴이 kind:"text" 세그먼트를 냈나(out 중복 방지),
          // closedByText=직전 텍스트 세그먼트가 도구 런을 닫음(다음 도구는 새 카드로 → 텍스트↔도구 교차).
          sawTextSegment: false, closedByText: false,
        };
      };

      // delta-only 턴(스텝 활동 없이 토큰만 오는 경우)용 경량 그룹 — 진행 버블만 담는다.
      // 이후 activity 가 오면 renderActivity 의 isNewTurn 판정(seq 리셋/closed)으로 자연 정리.
      const createDeltaGroup = (p, ts, adapter, thread) => {
        const group = document.createElement("div");
        group.className = "turn-group";
        group.dataset.threadkey = thread;
        if (p && typeof p.ts === "number" && Number.isFinite(p.ts)) group.dataset.ts = String(p.ts);
        group.dataset.type = "channel.message.out";
        applyFilter(group);
        return {
          group, el: null, body: null, countEl: null, lastEl: null,
          setOpen: () => {}, lastSeq: -1, count: 0, closed: false,
          costEl: null, replyCostEl: null, // 비용 표시 자리(카드 헤더 없음 → 버블 헤더 사용).
          modelEl: null, replyModelEl: null, modelSeen: "", // 모델 표시도 동일(버블 헤더 사용).
          replyBubble: null, replyMsg: null, replyRaw: "",
          sawTextSegment: false, closedByText: false, // 인터리브 상태(createTurnCard 와 동형).
        };
      };

      // 진행(타이핑) 버블을 그 턴 그룹 안(스텝 카드 아래)에 생성. 평문 누적용 빈 버블.
      const ensureReplyBubble = (card, ts) => {
        if (card.replyBubble) return card.replyBubble;
        const div = document.createElement("div");
        div.className = "ev local channel-chat";
        div.dataset.type = "channel.message.out";
        const head = document.createElement("div");
        head.className = "bubble-meta"; // 채팅 버블 메타 줄 간격(생성 지점 4곳 공통).
        // 메타 줄(시각·이름·모델·비용)이 서로 붙어 읽기 어려웠다 — 스텝 카드 헤더(.turn-head,
        // gap:8px)와 같은 간격 규칙을 쓴다(2026-07-28 사용자 요청).
        head.className = "bubble-meta";
        const tsEl = document.createElement("span");
        tsEl.className = "ts"; tsEl.textContent = ts;
        const tyEl = document.createElement("span");
        tyEl.className = "type"; tyEl.textContent = assistantName;
        head.appendChild(tsEl); head.appendChild(tyEl);
        // ★턴 비용 자리 (2026-07-26) — 도구 없이 텍스트만 답하는 턴은 스텝 카드(헤더)가 아예
        //  안 생겨서(createDeltaGroup: el/countEl = null) 카드 헤더에만 두면 **가장 흔한 턴에
        //  비용이 안 보인다**. 답변 버블 헤더는 두 경로 모두에 있으므로 여기에도 자리를 만들고,
        //  setTurnCost 가 카드 헤더 → 버블 헤더 순으로 채운다.
        const costEl = document.createElement("span");
        costEl.className = "turn-cost";
        // 모델도 같은 이유로 버블 헤더에 자리를 둔다 — 도구 없이 텍스트만 답하는 턴(가장 흔하다)엔
        //  스텝 카드 헤더가 아예 없어서, 카드에만 두면 정작 제일 자주 보는 턴에 모델이 안 보인다.
        const modelEl = document.createElement("span");
        modelEl.className = "turn-model";
        head.appendChild(modelEl);
        head.appendChild(costEl);
        card.replyCostEl = costEl;
        card.replyModelEl = modelEl;
        if (card.modelSeen) modelEl.textContent = card.modelSeen; // 버블이 늦게 생겨도 이미 본 모델 반영.
        div.appendChild(head);
        const msg = document.createElement("div");
        // streaming = 평문 + 깜빡이는 커서. out 도착 시 마크다운 전체본으로 승격(streaming 제거).
        msg.className = "chat-message streaming";
        div.appendChild(msg);
        card.group.appendChild(div); // 스텝 카드(있으면) 다음 = 라이브 답변 슬롯.
        card.replyBubble = div;
        card.replyMsg = msg;
        card.replyRaw = "";
        return div;
      };

