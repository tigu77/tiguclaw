      // ── 다음 메시지 제안 고스트 (2026-08-10) ─────────────────────────────────
      // 턴이 끝나면 서버가 `chat.suggestion` 이벤트로 "사용자가 이어서 할 만한 말" 한 줄을
      // 보낸다(기본 꺼짐 — 설정 화면 토글). 입력창이 **비어 있을 때만** 회색으로 겹쳐 보이고,
      // Tab(또는 →)이면 입력창에 **채워진다**. 보내는 건 여전히 사용자다.
      //
      // ★Enter 는 절대 수락이 아니다. Enter=전송이라 수락과 겹치면 오발신이 되고, 그건
      //  되돌릴 수 없다(사용자가 보지도 않은 문장이 나간다).
      // ★슬래시 팝업과는 구조적으로 안 겹친다 — 슬래시는 입력이 "/…" 일 때만 뜨고,
      //  고스트는 입력이 **비었을 때만** 뜬다. 두 조건은 동시에 참일 수 없다.
      (() => {
        const input = document.getElementById("chat-input");
        const ghostEl = document.getElementById("chat-ghost");
        // 수락 버튼 — 없으면 키보드(Tab/→)만으로 동작(구버전 마크업 무손상).
        const acceptBtn = document.getElementById("chat-ghost-accept");
        if (!input || !ghostEl) return; // 노드 부재 = 기능만 없음(채팅 무손상).

        let suggestion = null; // 현재 제안 문자열(없으면 null).
        let suggestionThread = null; // 어느 세션의 제안인가(탭 전환 시 오염 방지).

        // ★새로고침·앱 전환에도 살아남게 (2026-08-10). SSE 재접속은 최근 50개를 재생하므로
        //  운 좋으면 되살아나고 아니면 사라진다 — **예측이 안 되는 게 제일 나쁘다**. 폰은
        //  백그라운드 갈 때마다 리로드되니 특히. 세션당 최신 하나뿐이라 저장 비용은 0.
        const LS_KEY = "dash.suggestion.v1";
        const lsAll = () => {
          try { return JSON.parse(localStorage.getItem(LS_KEY) || "{}") || {}; }
          catch { return {}; }
        };
        const lsSave = (tk, text, ts) => {
          if (!tk) return;
          try {
            const all = lsAll();
            all[tk] = { text, ts };
            // 세션이 늘어도 무한히 쌓이지 않게 — 최근 20개만.
            const keys = Object.keys(all);
            if (keys.length > 20) {
              keys.sort((a, b) => (all[a].ts || 0) - (all[b].ts || 0));
              for (const k of keys.slice(0, keys.length - 20)) delete all[k];
            }
            localStorage.setItem(LS_KEY, JSON.stringify(all));
          } catch { /* quota·프라이빗 모드 — 저장만 못 할 뿐 */ }
        };
        const lsDrop = (tk) => {
          if (!tk) return;
          try {
            const all = lsAll();
            delete all[tk];
            localStorage.setItem(LS_KEY, JSON.stringify(all));
          } catch { /* noop */ }
        };

        const visible = () => !ghostEl.hidden;

        // ★안내문(placeholder)은 여기서 정하지 않는다 — 고스트가 뜬다는 **사실만** 알리고,
        //  무슨 문구가 맞는지는 util.js 의 단일 판정이 정한다. 종전엔 여기서 초기값을
        //  스냅샷해 뒀다가 되돌렸는데, 안내문을 나중에 바꾸는 모듈들(mobile-nav·perf)이
        //  이 파일보다 뒤에 로드돼 폰 문구가 PC 것으로 바뀌었다. 그건 보정으로 덮을 게
        //  아니라 **같은 판단이 네 곳에 있던 것**이 문제였다(사용자 지적, 2026-08-10).
        const hide = () => {
          if (ghostEl.hidden) return;
          ghostEl.hidden = true;
          ghostEl.textContent = "";
          if (acceptBtn) acceptBtn.hidden = true;
          if (typeof setChatGhostShowing === "function") setChatGhostShowing(false);
        };

        // 뜰 조건: 제안이 있고 · 입력이 비었고 · 그 제안이 **지금 보고 있는 세션**의 것.
        const sync = () => {
          // 메모리에 없으면 저장된 것에서 되살린다(새로고침 직후·탭 전환 직후).
          if (suggestion === null && input.value === "") {
            const tk = typeof activeThreadKey === "string" ? activeThreadKey : "";
            const saved = tk === "" ? null : lsAll()[tk];
            if (saved && typeof saved.text === "string" && saved.text !== "") {
              suggestion = saved.text;
              suggestionThread = tk;
            }
          }
          if (
            suggestion === null ||
            input.value !== "" ||
            (suggestionThread !== null &&
              typeof isActiveThread === "function" &&
              !isActiveThread(suggestionThread))
          ) {
            hide();
            return;
          }
          ghostEl.textContent = suggestion;
          ghostEl.hidden = false;
          if (acceptBtn) acceptBtn.hidden = false;
          if (typeof setChatGhostShowing === "function") setChatGhostShowing(true);
        };

        // 수락 — 입력창에 **채우기만** 한다(전송 아님). autoGrow·슬래시 등 기존 입력
        // 파이프라인이 그대로 돌게 input 이벤트를 발화시킨다(다른 모듈이 값 변화를 안다).
        const accept = () => {
          if (!visible() || suggestion === null) return false;
          input.value = suggestion;
          try {
            if (input.parentElement && input.parentElement.dataset) {
              input.parentElement.dataset.replicatedValue = input.value;
            }
            input.dispatchEvent(new Event("input", { bubbles: true }));
            input.setSelectionRange(input.value.length, input.value.length);
          } catch { /* noop */ }
          // ★수락은 "이번엔 이걸 쓰겠다" 이지 "제안을 버린다" 가 아니다 (2026-08-10
          //  사용자 요청). 종전엔 여기서 메모리·저장소 양쪽을 지워, 붙인 걸 지우면 되살릴
          //  게 없었다. 남겨두면 입력이 다시 비는 순간 sync 가 도로 띄운다.
          //  실제로 버리는 건 전송·Esc·새 제안 도착뿐이다.
          hide();
          return true;
        };

        // ★키 처리는 **캡처 단계**에서. Tab 은 기본이 포커스 이동이고, 다른 모듈도 Tab 을
        //  쓴다(슬래시 수락). 여기서 먼저 잡되 **고스트가 보일 때만** 가로챈다 —
        //  안 보이면 아무것도 안 하고 그대로 흘려보낸다(기존 동작 무손상).
        input.addEventListener(
          "keydown",
          (e) => {
            if (!visible()) return;
            if (e.key === "Tab" || (e.key === "ArrowRight" && input.selectionStart === 0)) {
              if (accept()) {
                e.preventDefault();
                e.stopPropagation();
              }
              return;
            }
            if (e.key === "Escape") {
              lsDrop(suggestionThread);
              suggestion = null; // 이번 제안은 버린다(다음 턴에 새로 온다).
              hide();
              e.stopPropagation();
            }
          },
          true,
        );

        // ★모바일엔 Tab 키가 없다 — 수락 수단이 따로 필요하다. 그 자리를 **버튼**이 맡는다
        //  (2026-08-15 사용자 요청: "제안 메시지 바로 옆에 화살표 버튼이 있으니 깔끔하다").
        //
        //  종전엔 **입력창이 포커스되는 순간 수락**했다(모바일 한정). 터치를 가로채면 안
        //  된다는 제약 때문이었다 — 2026-08-10 에 고스트를 탭 가능하게 만들었더니 첫 터치가
        //  textarea 가 아니라 고스트에 맞았고, 포커스가 *프로그램적* 으로 옮겨져 iOS 가
        //  입력창을 키보드 위로 안 올려줬다. 그래서 터치를 흘려보내고 포커스로 수락했다.
        //
        //  ★그 대가가 "그냥 쓰려고 탭했는데 제안이 들어온다" 였다. 버튼은 그 딜레마를
        //   푼다 — 입력창 터치는 **브라우저 기본 그대로**(키보드 문제 재발 없음)이고,
        //   수락은 **명시적 행동 하나**가 된다. 우연히 발동하는 경로가 사라졌다.
        if (acceptBtn) {
          // 클릭은 **채우기까지만** — 보내는 건 여전히 사용자다(Tab 과 같은 입구).
          acceptBtn.addEventListener("click", (e) => {
            e.preventDefault();
            if (accept()) input.focus();
          });
          // 버튼을 누를 때 입력창이 blur 되며 값이 흔들리지 않게(포커스 이동 전에 처리).
          acceptBtn.addEventListener("mousedown", (e) => e.preventDefault());
        }

        // 타이핑·붙여넣기 등 값이 바뀌면 즉시 숨김(비었을 때만 뜨는 규칙).
        input.addEventListener("input", sync);
        // ★blur 로 숨기지 않는다 (2026-08-10 사용자 요청). 제안은 "포커스 중인 사람에게
        //  주는 힌트" 가 아니라 **턴이 끝났으니 이어서 할 말**이다 — 입력창을 안 보고 있을
        //  때야말로 보여야 한다. 종전엔 한 번 포커스했다 나가면 사라져, 새 제안이 올
        //  때까지 안 돌아왔다. 표시 조건은 그대로다(제안 있음 · 입력 비었음 · 이 세션 것).
        input.addEventListener("blur", sync);
        input.addEventListener("focus", sync);

        // 서버 이벤트 수신구 — sse.js 가 `chat.suggestion` 을 여기로 넘긴다.
        window.applyChatSuggestion = (payload, evTs) => {
          const p = payload || {};
          const text = typeof p.text === "string" ? p.text.trim() : "";
          if (text === "") return;
          const tk = typeof p.threadKey === "string" ? p.threadKey : null;
          const ts = typeof evTs === "number" && Number.isFinite(evTs) ? evTs : 0;
          // ★재접속 replay 가드 — /events 는 붙을 때 최근 50개를 **과거분까지** 재생한다.
          //  가드가 없으면 한참 전 턴의 제안이 되살아나 지금 흐름과 안 맞는 문장이 뜬다.
          //
          // ★2026-08-18 판정 교체(사용자 신고: "가끔 제안이 안 나온다").
          //  종전엔 `vtIsStaleForAppend` 를 빌려 썼다 — "중복을 피하려고 채팅·워커가 쓰는
          //  기준을 그대로 쓴다" 는 의도였는데, **그 판정은 다른 질문에 답한다**:
          //  *"이 메시지를 리스트 바닥에 붙이면 순서가 깨지는가"* (기준 = 리스트의 최신 ts).
          //  제안은 리스트에 안 붙는다 — 입력창 위 고스트라 "순서" 라는 개념이 없다.
          //  그래서 턴 답변 버블이 먼저 리스트에 실리고(그게 newest 가 된다) 제안이 그보다
          //  5초 넘게 늦게 오면 **정상 제안이 버려졌다**. 실측: 턴→제안 간격 중앙 3.9초,
          //  최대 11.9초, **10%가 5초 초과** — 사용자가 겪은 "가끔" 이 이 비율이다.
          //  ★통합은 이름이 같아서가 아니라 **질문이 같을 때** 한다(architecture §Q8).
          //
          //  제안에 맞는 질문은 "이게 이 세션의 **최신** 제안인가" 다 — 순서가 아니라 최신성.
          //  세션별 마지막 제안 ts 는 이미 localStorage 에 있으므로 그것과만 비교한다.
          //  replay 는 분 단위로 과거라 여전히 걸리고, 늦게 온 새 제안은 안 버려진다.
          const prev = tk === null ? null : lsAll()[tk];
          const prevTs = prev && typeof prev.ts === "number" ? prev.ts : 0;
          if (ts > 0 && prevTs > 0 && ts <= prevTs) return; // 같거나 더 오래된 것 = replay
          suggestion = text;
          suggestionThread = tk;
          lsSave(tk, text, ts);
          sync();
        };

        // ★탭 전환·**브라우저를 새로 연 뒤**에도 되살아나게 (2026-08-10 사용자 요청).
        //  종전엔 sync 를 부르는 계기가 SSE 수신·포커스·타이핑뿐이라, 새로 연 창에서는
        //  사용자가 입력창을 건드리기 전까진 저장된 제안이 안 보였다. localStorage 는
        //  브라우저를 닫아도 남으므로 **부를 사람만** 있으면 된다 — 그 자리가
        //  `restoreChatDraft`(이 탭의 입력 상태를 복원하는 단일 지점, 초기 로드에도 걸려
        //  있다)다. 만료는 두지 않는다: 제안은 그 세션의 마지막 턴에 붙은 것이라
        //  일주일 뒤에 돌아와도 대화가 그 자리면 여전히 유효하다.
        window.refreshChatSuggestion = () => {
          suggestion = null;      // 저장소에서 이 탭 것으로 다시 집게 한다.
          suggestionThread = null;
          sync();
        };

        // 전송하면 그 제안은 수명이 끝난다(다음 턴에 새 제안이 온다).
        window.clearChatSuggestion = () => {
          lsDrop(suggestionThread);
          suggestion = null;
          suggestionThread = null;
          hide();
        };
      })();
