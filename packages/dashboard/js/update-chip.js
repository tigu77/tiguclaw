      /**
       * 헤더 업데이트 칩 — "받을 게 있으면 뜨고, 누르면 확인 후 업데이트, 끝나면 새로고침".
       *
       * ★**판단은 여기 없다.** 뜰지 말지·왜 막혔는지는 코어(`checkUpdateAvailability`)가
       *  `state` 로 답해서 온다. 화면이 `behind > 0 && dirty.length === 0` 같은 조건을
       *  다시 조립하면 그게 판단의 두 번째 사본이고, 두 벌은 갈린다(가장자리는 판단하지 않는다).
       *
       * ★**모르면 조용하다.** `unknown`(git 없음·원격 없음·네트워크 실패)은 아무것도 안 띄운다.
       *  없는 업데이트를 있다고 하는 것보다 낫고, 상시 뜨는 배지는 곧 배경소음이 된다.
       */
      /**
       * 헤더 칩이 **무엇을 보일지** — 순수 판정 (2026-08-21 적대 검토 F4·F6).
       *
       * ★**뜨는 상태를 열거한다.** 종전엔 `unknown`·`up-to-date`·falsy 를 빼고 *나머지 전부*
       *  를 available 로 흘렸다. 그래서 코어가 새 state 를 내거나 프록시가 `state` 없는 200 을
       *  주면 칩이 뜨고, 누르면 `POST /api/self-update` 를 쐈다. 같은 배치의 홈 버전 행은
       *  정반대로 조용했다 — **두 화면이 같은 값에 반대로 행동**했다.
       *
       * ★순수 함수로 뽑은 이유: 렌더 안에 있으면 검사가 브라우저를 띄워야만 확인된다. 뽑으면
       *  홈(`versionStatusRow`)과 **실행으로 대조**할 수 있다 — 그게 "두 벌이 갈리지 않는다"
       *  를 말로 적는 것과 지키는 것의 차이다(적대 검토가 이 자리에 그물이 0이라고 지적했다).
       *
       * @returns {{show:boolean, kind:string, label:string, title:string}}
       */
      const updateChipView = (availability) => {
        const state = availability && availability.state;
        if (state === "available")
          return {
            show: true,
            kind: "ready",
            label: "업데이트", // ★건수 없음 — `behind` 는 원격 커밋 수라 받는 변화량과 무관하다.
            title: "받을 업데이트가 있습니다. 눌러서 업데이트합니다.",
          };
        if (state === "blocked")
          return {
            show: true,
            kind: "blocked",
            label: "업데이트 보류",
            title: availability.blockedReason || "지금은 업데이트할 수 없습니다.",
          };
        return { show: false, kind: "", label: "", title: "" }; // 모르면 조용하다.
      };

      const updateChip = (() => {
        // ★판정이 도착했을 때 알릴 곳 — **직접 부르지 않는다** (2026-08-21 적대 검토 F1).
        //  이 파일은 index.html 에서 `view-overview.js` 보다 **두 칸 먼저** 로드된다. 그래서
        //  여기서 `showOverview` 를 이름으로 부르면 전방 참조이고, fetch 가 스크립트 배달보다
        //  빠른 순간 `ReferenceError` 가 난다 — 그런데 그 예외를 `refresh` 의 catch 가 삼키고
        //  `render(null)` 이 또 던져서, **받을 업데이트가 있는데 칩도 홈도 조용해진다**(다음
        //  기회는 30분 뒤 타이머). 실측으로 재현됐다.
        //  ★고침은 방향을 뒤집는 것이다: 늦게 로드되는 쪽이 **자기 파일에서 등록**한다.
        //   그러면 순서에 무관하고, 새 소비자가 생겨도 여기를 안 고친다
        //   (이 레포가 같은 사고 뒤에 `chatKindBuilders` 로 세워 둔 해법과 같은 형상).
        const subscribers = [];
        const notify = (a) => {
          for (const fn of subscribers) {
            try { fn(a); } catch { /* 한 소비자 실패가 칩을 죽이지 않는다 */ }
          }
        };

        const chip = document.getElementById("update-chip");
        if (!chip) return { refresh: () => {}, state: () => null, onChange: (fn) => subscribers.push(fn) };

        let inFlight = false;
        let current = null;

        const render = (a) => {
          current = a;
          notify(a);
          const v = updateChipView(a);
          chip.hidden = !v.show;
          if (!v.show) return;
          chip.className = "hdr-btn update-chip " + v.kind;
          chip.textContent = v.label;
          chip.title = v.title;
        };

        const refresh = async () => {
          try {
            const r = await fetch("/api/update-availability");
            render(r.ok ? await r.json() : null);
          } catch {
            render(null); // 판정 실패 = 조용히 숨김(§모르면 조용하다)
          }
        };

        /** `/api/health` 의 프로세스 가동시간(ms). 못 읽으면 null(=데몬이 없거나 응답 불가). */
        const readUptime = async () => {
          try {
            const r = await fetch("/api/health", { cache: "no-store" });
            if (!r.ok) return null;
            const h = await r.json();
            return typeof h.uptime_ms === "number" ? h.uptime_ms : null;
          } catch {
            return null;
          }
        };

        /**
         * 업데이트 후 복귀 대기 — **새 프로세스**가 뜰 때까지.
         *
         * ★"응답하면 복귀" 는 틀렸다 (2026-08-21 적대 검토 F5). 코어는 `status:"updating"` 을
         *  먼저 돌려주고 재시작을 **5초 뒤로 예약**한다(`self-update.ts` DEFAULT_RESTART_DELAY_MS).
         *  칩은 2초 자고 물었으므로 **아직 살아 있는 옛 데몬**이 200 을 줬고, 그걸 "완료"로 읽어
         *  ~2.6초에 새로고침했다. 그래서 이 함수의 주석이 말하는 "죽었다 살아나는 구간" 에는
         *  **한 번도 들어가지 않았고**, 새로고침된 화면은 옛 프로세스의 버전을 물고 굳었다 —
         *  모바일에서 버전을 보이게 하려고 만든 행이 업데이트 직후에 틀린 값을 말했다.
         *
         * ★판정을 `uptime_ms` **감소**로 바꾼다. 재시작하면 가동시간이 리셋되므로 프로세스가
         *  실제로 바뀐 것이 확실하다. "응답 실패를 먼저 봐야 한다" 로 하면 재시작이 폴링 사이에
         *  끼는 순간 영영 못 보고 거짓 실패를 낸다 — 이건 그 창에 무관하다.
         *  버전 비교로는 안 된다: sync 는 버전을 안 올리는 경우가 대부분이다.
         */
        const reloadWhenBack = async () => {
          const before = await readUptime();
          const deadline = Date.now() + 180_000;
          while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 2000));
            const now = await readUptime();
            // null = 아직 안 떴다. before 가 null 이면(원래 못 읽었다) 응답 복귀만으로 판정한다.
            if (now === null) continue;
            if (before === null || now < before) {
              showToast("업데이트 완료 — 새로고침합니다.", "good");
              setTimeout(() => window.location.reload(), 600);
              return;
            }
          }
          showToast("업데이트 후 데몬이 돌아오지 않았습니다. 로그를 확인하세요.", "bad");
        };

        chip.addEventListener("click", async () => {
          if (inFlight || !current) return;
          if (current.state === "blocked") {
            window.alert(current.blockedReason || "지금은 업데이트할 수 없습니다.");
            return;
          }
          if (!window.confirm(
            "최신 버전으로 업데이트할까요?\n\n" +
            "진행 중인 작업이 중단되고, 데몬이 재시작된 뒤 이 화면은 자동으로 새로고침됩니다."
          )) return;

          inFlight = true;
          chip.disabled = true;
          showToast("업데이트 중… 타입체크까지 통과해야 반영됩니다.", "warn");
          try {
            const r = await fetch("/api/self-update", { method: "POST" });
            const data = await r.json().catch(() => ({}));
            // 코어가 낸 status 를 그대로 해석한다 — 화면이 성패를 재판정하지 않는다.
            if (data.status === "updating") {
              showToast("업데이트 적용 — 재시작을 기다립니다.", "good");
              await reloadWhenBack();
            } else if (data.status === "busy") {
              showToast("이미 다른 업데이트가 진행 중입니다.", "warn");
            } else if (data.status === "up-to-date") {
              showToast("이미 최신입니다.", "good");
              await refresh();
            } else {
              showToast("업데이트 실패: " + (data.error || data.status || ("HTTP " + r.status)), "bad");
              await refresh();
            }
          } catch {
            // 재시작이 응답보다 빠르면 연결이 끊긴다 — 실패가 아니라 정상 흐름이다.
            showToast("업데이트 진행 중 (응답 끊김) — 복귀를 기다립니다.", "warn");
            await reloadWhenBack();
          } finally {
            inFlight = false;
            chip.disabled = false;
          }
        });

        return { refresh, state: () => current, onChange: (fn) => subscribers.push(fn) };
      })();

      // 최초 1회 + 30분마다. ★주기를 설정으로 빼지 않는다 — 필요해지면 그때 뺀다
      //  (미래 가능성을 위한 옵션 금지). git fetch 한 번이라 이 주기면 무해하다.
      updateChip.refresh();
      setInterval(() => updateChip.refresh(), 30 * 60 * 1000);
