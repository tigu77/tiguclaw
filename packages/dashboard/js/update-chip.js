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
      const updateChip = (() => {
        const chip = document.getElementById("update-chip");
        if (!chip) return { refresh: () => {}, state: () => null };

        let inFlight = false;
        let current = null;

        const render = (a) => {
          current = a;
          // 홈 「상태 요약」의 버전 행이 같은 판정을 문장으로 읽는다 — 늦게 도착하므로 다시 그린다.
          if (currentView === "overview") setTimeout(showOverview, 0);
          if (!a || a.state === "unknown" || a.state === "up-to-date") {
            chip.hidden = true;
            return;
          }
          chip.hidden = false;
          if (a.state === "blocked") {
            chip.className = "hdr-btn update-chip blocked";
            chip.textContent = "업데이트 보류";
            chip.title = a.blockedReason || "지금은 업데이트할 수 없습니다.";
            return;
          }
          chip.className = "hdr-btn update-chip ready";
          // ★건수를 표시하지 않는다 (2026-08-21 사용자 지적). `behind` 는 **원격 레포의
          //  커밋 수**라, 그중 하나가 상류 커밋 수십 개를 묶은 sync 일 수 있다 — 사용자가
          //  받는 변화의 양과 무관하다. 정확해 보이는데 뜻이 다른 숫자는 없는 것보다 나쁘다.
          //  (`behind` 는 응답에 그대로 남는다 — 진단에는 쓰이고 화면에만 안 쓴다.)
          chip.textContent = "업데이트";
          chip.title = "받을 업데이트가 있습니다. 눌러서 업데이트합니다.";
        };

        const refresh = async () => {
          try {
            const r = await fetch("/api/update-availability");
            render(r.ok ? await r.json() : null);
          } catch {
            render(null); // 판정 실패 = 조용히 숨김(§모르면 조용하다)
          }
        };

        /**
         * 업데이트 후 복귀 대기 — 데몬이 죽었다 살아나는 구간을 넘긴다.
         *
         * ★`/api/health` 가 다시 응답하면 그때 새로고침한다. 고정 시간 sleep 으로 하면
         *  느린 기계에선 죽은 화면을, 빠른 기계에선 헛기다림을 준다. 상한을 두고
         *  못 돌아오면 **새로고침하지 않고** 사용자에게 알린다 — 빈 화면으로 끝내지 않는다.
         */
        const reloadWhenBack = async () => {
          const deadline = Date.now() + 180_000;
          while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 2000));
            try {
              const r = await fetch("/api/health", { cache: "no-store" });
              if (r.ok) {
                showToast("업데이트 완료 — 새로고침합니다.", "good");
                setTimeout(() => window.location.reload(), 600);
                return;
              }
            } catch {
              /* 아직 안 떴다 — 계속 기다린다 */
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

        return { refresh, state: () => current };
      })();

      // 최초 1회 + 30분마다. ★주기를 설정으로 빼지 않는다 — 필요해지면 그때 뺀다
      //  (미래 가능성을 위한 옵션 금지). git fetch 한 번이라 이 주기면 무해하다.
      updateChip.refresh();
      setInterval(() => updateChip.refresh(), 30 * 60 * 1000);
