      // ── 한 번 타이머(2026-10-20) — 건 대화의 백그라운드 패널에 «⏱ 3분 뒤 · 빌드 확인» + 멈추기 ──
      // 인벤토리엔 안 쌓는다(정태님 «인벤토리에 쌓이는 게 별로»). 서버(GET /api/timers)는 전부 주고 **화면이 거른다** —
      // 잡 카드와 같은 규칙: «현재 세션» 이면 그 대화가 건 것만, «전체 세션» 이면 전부(`bgSessionScope`, background-drawer.js).
      // 다시 받는 때: 패널 열기·세션 옮기기·탭이 다시 보일 때(`resyncBackground`) + 턴이 끝날 때(비서가 방금 걸었거나 타이머가 막 울렸다).
      // 남은 시간은 30초마다 다시 그리고, 울릴 시각이 지났으면 다시 받는다(울리면 서버에서 지워진다).
      const bgTimersBox = document.getElementById("bg-timers");
      const bgTimersList = document.getElementById("bg-timers-list");
      let bgTimers = [];
      let bgTimersGen = 0;

      const timerLeftText = (runAt) => {
        const ms = runAt - Date.now();
        if (ms <= 30000) return i18n("bg.timers.now");
        const min = Math.round(ms / 60000);
        if (min < 60) return i18n("bg.timers.inMin", { n: min });
        if (min >= 24 * 60) return i18n("bg.timers.at", { when: new Date(runAt).toLocaleString() });
        const h = Math.floor(min / 60);
        const m = min % 60;
        return m === 0 ? i18n("bg.timers.inHour", { h }) : i18n("bg.timers.inHourMin", { h, m });
      };

      const renderBgTimers = () => {
        if (!bgTimersBox || !bgTimersList) return;
        const all = typeof bgSessionScope === "string" && bgSessionScope === "all";
        const mine = bgTimers
          .filter((x) => x && typeof x.runAt === "number" && (all || x.originThreadKey === activeThreadKey))
          .sort((a, b) => a.runAt - b.runAt);
        bgTimersList.textContent = "";
        for (const x of mine) {
          const row = document.createElement("div");
          row.className = "bg-timer" + (x.enabled ? "" : " off");
          const when = document.createElement("span");
          when.className = "bg-timer-when";
          // 꺼진 타이머 둘 — 실행기가 실패로 꺼 둔 것(«실패», 사유는 툴팁)과 사용자가 끈 것(«꺼짐»).
          const failed = !x.enabled && x.lastStatus === "error";
          if (failed) row.classList.add("failed");
          when.textContent = "⏱ " + (x.enabled ? timerLeftText(x.runAt) : i18n(failed ? "bg.timers.failed" : "bg.timers.off"));
          when.title = failed && x.lastError ? x.lastError : new Date(x.runAt).toLocaleString();
          const label = document.createElement("span");
          label.className = "bg-timer-label";
          label.textContent = x.label;
          label.title = x.prompt || x.label;
          const stop = document.createElement("button");
          stop.type = "button";
          stop.className = "bg-timer-stop";
          stop.textContent = i18n("bg.timers.stop");
          stop.setAttribute("aria-label", i18n("bg.timers.stopAria", { label: x.label }));
          stop.addEventListener("click", () => cancelBgTimer(x.id, stop));
          row.append(when, label, stop);
          bgTimersList.appendChild(row);
        }
        bgTimersBox.hidden = mine.length === 0;
      };

      // 늦게 온 옛 응답이 새 목록을 덮지 않게 — 받을 때마다 세대를 올리고 마지막 것만 쓴다.
      const loadBgTimers = () => {
        const gen = ++bgTimersGen;
        return fetch("/api/timers")
          .then((r) => (r.ok ? r.json() : null))
          .then((d) => {
            if (gen !== bgTimersGen || !d || !Array.isArray(d.timers)) return;
            bgTimers = d.timers;
            renderBgTimers();
          })
          .catch(() => { /* 미도달 — 다음 계기에 다시 */ });
      };

      const cancelBgTimer = (id, btn) => {
        btn.disabled = true;
        fetch("/api/cancel-timer", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) })
          .then((r) => {
            // 404 = 이미 울렸거나 지워졌다 — 목록에서 빼면 된다.
            if (!r.ok && r.status !== 404) throw new Error("cancel failed");
            // ★멈추기 전에 떠난 목록 조회가 늦게 오면 멈춘 타이머를 화면에 되살린다(아스트라 10-20 P2) — 세대를 올려 그 응답을 버리고, 지금 목록을 다시 받는다.
            bgTimersGen += 1;
            bgTimers = bgTimers.filter((x) => x.id !== id);
            renderBgTimers();
            loadBgTimers();
          })
          .catch(() => {
            btn.disabled = false;
            showToast(i18n("bg.timers.stopFailed"), "error");
          });
      };

      // 턴 끝마다 불린다 — 연달아 끝나도 한 번만 받는다.
      let bgTimersSoon = null;
      window.resyncTimers = () => {
        if (bgTimersSoon !== null) return;
        bgTimersSoon = setTimeout(() => { bgTimersSoon = null; loadBgTimers(); }, 400);
      };
      window.renderBgTimers = renderBgTimers;

      setInterval(() => {
        if (bgTimers.length === 0 || document.visibilityState !== "visible") return;
        if (bgTimers.some((x) => x.enabled && x.runAt < Date.now() - 5000)) loadBgTimers();
        else renderBgTimers();
      }, 30000);

      loadBgTimers();
