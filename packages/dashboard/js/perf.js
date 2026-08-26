      // @diagnostic-only — 이 파일은 **화면이 아니라 진단면**이다(콘솔 로그와 같은 등급).
      //   `?perf=1` 일 때만 뜨고 사용자 대면 문구가 아니므로 i18n 대상이 아니다.
      //   ★이 표식은 회귀(`i18n-catalogs-and-coverage`)가 읽는다 — 종전엔 그쪽이 파일명
      //   목록(`DIAGNOSTIC_ONLY`)을 들고 있어서, 새 진단 파일이 생기면 **거기를 고쳐야**
      //   했고 아무도 안 고쳤다. 선언을 파일 안에 두면 목록이 사라지고 드리프트도 없다.
      // ── 성능 진단(?perf=1 일 때만; 평소엔 분기 1회로 사실상 0 비용) ──────────
      // 목적: 타이핑 랙의 진짜 숫자를 사용자 실세션에서 직접 본다(추측 금지).
      //   · 키입력 리플로우 = 입력 핸들러 비용(이제 레이아웃 읽기 없음 → ~0ms 이어야 정상)
      //   · stream 노드 수 = 마운트된(레이아웃 대상) DOM 크기 = 비용의 레버
      const PERF = new URLSearchParams(location.search).get("perf") === "1";
      let perfLastMs = 0;
      const autoGrowInput = () => {
        const t0 = PERF ? performance.now() : 0;
        growWrap.dataset.replicatedValue = input.value; // 레이아웃 읽기 없음(쓰기만).
        if (PERF) perfLastMs = performance.now() - t0;
      };
      input.addEventListener("input", autoGrowInput);
      autoGrowInput(); // 초기 복제 동기화.
      if (PERF) {
        const hud = document.createElement("div");
        hud.style.cssText = "position:fixed;bottom:8px;left:8px;z-index:99999;background:rgba(0,0,0,.85);color:#a5d6a4;font:11px/1.55 ui-monospace,Menlo,monospace;padding:7px 10px;border-radius:8px;border:1px solid #444;white-space:pre;pointer-events:none;";
        document.body.appendChild(hud);
        const tick = () => {
          const kids = stream ? stream.children.length : 0;
          const sub = stream ? stream.getElementsByTagName("*").length : 0;
          const tot = document.getElementsByTagName("*").length;
          hud.textContent =
            "키입력 리플로우: " + perfLastMs.toFixed(2) + " ms\n" +
            "stream 자식(메시지): " + kids + "\n" +
            "stream 하위 노드 전체: " + sub + "\n" +
            "문서 전체 노드: " + tot;
          setTimeout(tick, 400);
        };
        tick();
      }
      input.addEventListener("input", updateActiveChips); // 타이핑/백스페이스에 칩 활성표시 동기화.

      // 데스크톱(마우스/키보드): Enter=전송, Shift+Enter=줄바꿈. 모바일(터치 주입력): Enter=줄바꿈,
      // 전송은 '전송' 버튼으로 — 소프트키보드에서 Enter 로 오전송되는 일이 없게. 판별은 화면폭이 아니라
      // 주 포인터가 터치인지(pointer:coarse) — 좁은 데스크톱 창은 물리 키보드라 Enter=전송 유지.
      // IME 조합 중(한글)에는 데스크톱에서도 전송 금지(Enter=조합 확정용).
      // ★판정은 util.js 의 `isTouchPrimary` 하나다 — 안내문이 이 동작을 설명하므로 둘이
      //  갈리면 화면이 거짓말을 한다(실제로 그랬다, 2026-08-10).
      input.addEventListener("keydown", (e) => {
        if (slashKeydown(e)) return; // 슬래시 팝업 열림 → ↑/↓·Enter/Tab·Esc 가로챔(전송 안 함).
        // ↑/↓ 입력 히스토리(셸 동작) — **슬래시 팝업 다음**이다. 팝업이 열려 있으면 위에서
        //  이미 가로챘고, 그 순서가 뒤집히면 슬래시 목록 탐색이 죽는다.
        if (historyKeydown(e, input)) return;
        if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !isTouchPrimary()) {
          e.preventDefault();
          form.requestSubmit();
        }
      });
      // 안내문은 여기서 정하지 않는다 — util.js 의 computeChatPlaceholder 단일 판정.
      refreshChatPlaceholder();

