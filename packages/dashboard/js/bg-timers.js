      // ── 한 번 타이머(2026-10-20) — 건 대화의 백그라운드 패널에 «⏱ 3분 뒤 · 빌드 확인» + 멈추기 ──
      // 인벤토리엔 안 쌓는다(정태님 «인벤토리에 쌓이는 게 별로»). 서버(GET /api/timers)는 전부 주고 **화면이 거른다** —
      // 잡 카드와 같은 규칙: «현재 세션» 이면 그 대화에서 실행할 것만, «전체 세션» 이면 전부(`bgSessionScope`, background-drawer.js).
      // 다시 받는 때: 패널 열기·세션 옮기기·탭이 다시 보일 때(`resyncBackground`) + 턴이 끝날 때(비서가 방금 걸었거나 타이머가 막 울렸다).
      // 남은 시간은 30초마다 다시 그리고, 울릴 시각이 지났으면 다시 받는다(울리면 서버에서 지워진다).
      const bgTimersBox = document.getElementById("bg-timers");
      const bgTimersList = document.getElementById("bg-timers-list");
      const bgTimersCount = document.getElementById("bg-timers-count");
      const bgSchedulesBox = document.getElementById("bg-schedules");
      const bgSchedulesList = document.getElementById("bg-schedules-list");
      const bgSchedulesCount = document.getElementById("bg-schedules-count");
      const bgSchedulesOff = document.getElementById("bg-schedules-off");
      const bgSchedulesOffList = document.getElementById("bg-schedules-off-list");
      const bgSchedulesOffSummary = document.getElementById("bg-schedules-off-summary");
      let bgTimers = [];
      let bgSchedules = [];
      let bgTimersGen = 0;
      /** «그 카드로» 가 강조 중인 타이머 — 다시 그려도 남게(위 줄 그리기가 읽는다). */
      const bgTimerFlash = { id: "", until: 0 };
      // ★목록을 리소스로도 낸다(2026-10-21 «백그라운드 작업» 위젯 — 패널의 축약판). 범위와 무관한 전체 — 거르는 건 받는 쪽이다.
      const timersRes = window.resourceStore.owned("bg-timers");

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

      // 실행기와 같은 정본: origin이 없으면 scheduler:<id> 전용 세션. 표시·범위·reveal이 공유한다.
      const timerThreadKey = (x) => x.originThreadKey ?? ("scheduler:" + x.id);
      // 같은 id의 노드를 보존한다. 주기/배지 갱신은 이름·Stop·세션 배지·꺼짐 summary의
      // focus와 native details.open을 건드리지 않는다(정렬로 옮길 때만 focus 복구).
      const bgTimerRows = new Map();
      const bgScheduleRows = new Map();
      const bgTimerDetail = document.createElement("div");
      bgTimerDetail.id = "bg-reservation-detail";
      bgTimerDetail.className = "bg-reservation-detail";
      bgTimerDetail.setAttribute("role", "tooltip");
      bgTimerDetail.hidden = true;
      document.body.appendChild(bgTimerDetail);
      let bgDetailOwner = null;
      let bgDetailPinned = false;
      let bgDetailLeave = null;
      const closeBgTimerDetail = () => {
        if (bgDetailLeave !== null) clearTimeout(bgDetailLeave);
        bgDetailLeave = null;
        if (bgDetailOwner) bgDetailOwner.label.removeAttribute("aria-describedby");
        bgDetailOwner = null;
        bgDetailPinned = false;
        bgTimerDetail.hidden = true;
      };
      window.closeBgTimerDetail = closeBgTimerDetail;
      const positionBgTimerDetail = () => {
        if (!bgDetailOwner) return;
        const anchor = bgDetailOwner.label.getBoundingClientRect();
        const panel = document.getElementById("bg-panel").getBoundingClientRect();
        const left = Math.max(8, panel.left);
        const right = Math.min(window.innerWidth - 8, panel.right);
        const top = Math.max(8, panel.top);
        const bottom = Math.min(window.innerHeight - 8, panel.bottom);
        bgTimerDetail.style.maxWidth = Math.max(0, right - left) + "px";
        bgTimerDetail.style.maxHeight = Math.max(0, bottom - top) + "px";
        const rect = bgTimerDetail.getBoundingClientRect();
        bgTimerDetail.style.left = Math.max(left, Math.min(anchor.left, right - rect.width)) + "px";
        bgTimerDetail.style.top = Math.max(top, Math.min(anchor.bottom + 4, bottom - rect.height)) + "px";
      };
      const showBgTimerDetail = (entry) => {
        if (bgDetailLeave !== null) clearTimeout(bgDetailLeave);
        bgDetailLeave = null;
        if (bgDetailOwner && bgDetailOwner !== entry) closeBgTimerDetail();
        bgDetailOwner = entry;
        // 안전 whitelist: label + 표시 시각/주기만. prompt/자유문을 복제하지 않는다.
        bgTimerDetail.textContent = entry.detail;
        entry.label.setAttribute("aria-describedby", bgTimerDetail.id);
        bgTimerDetail.hidden = false;
        positionBgTimerDetail();
      };
      const pinBgTimerDetail = (entry) => { showBgTimerDetail(entry); bgDetailPinned = true; };
      const leaveBgTimerDetail = () => {
        if (bgDetailLeave !== null) clearTimeout(bgDetailLeave);
        bgDetailLeave = setTimeout(() => {
          bgDetailLeave = null;
          if (!bgDetailPinned && bgDetailOwner && document.activeElement !== bgDetailOwner.label) closeBgTimerDetail();
        }, 120); // 이름에서 tooltip으로 포인터 이동은 허용한다(WCAG hoverable).
      };
      bgTimerDetail.addEventListener("pointerenter", () => {
        if (bgDetailLeave !== null) clearTimeout(bgDetailLeave);
        bgDetailLeave = null;
      });
      bgTimerDetail.addEventListener("pointerleave", leaveBgTimerDetail);
      document.addEventListener("pointerdown", (e) => {
        if (bgDetailOwner && !bgDetailOwner.label.contains(e.target) && !bgTimerDetail.contains(e.target)) closeBgTimerDetail();
      });
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && bgDetailOwner) { e.preventDefault(); e.stopPropagation(); closeBgTimerDetail(); }
      }, true);
      window.addEventListener("resize", closeBgTimerDetail);
      const bgReservationScroll = document.getElementById("bg-scroll");
      if (bgReservationScroll) bgReservationScroll.addEventListener("scroll", closeBgTimerDetail);
      if (bgSchedulesOff) bgSchedulesOff.addEventListener("toggle", () => {
        if (!bgSchedulesOff.open && bgDetailOwner && bgSchedulesOff.contains(bgDetailOwner.row)) closeBgTimerDetail();
      });

      // ⋮ 메뉴가 열린 카드. 그 카드가 사라지거나 접힌 «꺼짐» 영역으로 옮겨지면 메뉴를 닫고, 포커스가
      // 그 카드나 메뉴 안에 있었으면 렌더 끝에 보이는 자리(묶음 머리줄·꺼짐 요약)로 옮긴다(GPT R1 #2).
      let bgMenuEntry = null;
      let bgFocusFallback = "";
      const focusInBgReservation = (entry) => {
        const a = document.activeElement;
        if (!a || a === document.body) return false;
        return entry.row.contains(a) || (isMenuOpenAt(entry.menu) && typeof a.closest === "function" && a.closest(".ctx-menu") !== null);
      };
      const releaseBgReservation = (entry, fallback) => {
        const hadFocus = focusInBgReservation(entry);
        if (isMenuOpenAt(entry.menu)) closeMenu();
        if (bgMenuEntry === entry) bgMenuEntry = null;
        if (hadFocus) bgFocusFallback = fallback;
      };
      const bgShown = (el) => { for (let n = el; n; n = n.parentNode) if (n.hidden === true) return false; return !!el; };
      const applyBgFocusFallback = () => {
        const want = bgFocusFallback;
        bgFocusFallback = "";
        if (!want) return;
        const a = document.activeElement;
        if (a && a !== document.body && a.isConnected) return;
        // 마지막 예약이 사라져 두 묶음이 모두 숨으면 패널 닫기 버튼(늘 보인다)으로(GPT R2 #1).
        const order = { timers: ["bg-timers-head", "bg-schedules-head", "bg-close"], schedules: ["bg-schedules-head", "bg-timers-head", "bg-close"], off: ["bg-schedules-off-summary", "bg-schedules-head", "bg-close"] }[want] || [];
        for (const id of order) {
          const el = document.getElementById(id);
          if (el && el.isConnected && bgShown(el)) { el.focus({ preventScroll: true }); return; }
        }
      };

      const makeBgReservationRow = (x, schedule) => {
        const row = document.createElement("div");
        row.className = schedule ? "bg-schedule" : "bg-timer";
        row.dataset[schedule ? "scheduleId" : "timerId"] = String(x.id);
        const when = document.createElement("span");
        when.className = schedule ? "bg-schedule-when" : "bg-timer-when";
        const info = document.createElement("div");
        info.className = "bg-timer-info";
        const label = document.createElement("button");
        label.type = "button";
        label.className = "bg-timer-label";
        const session = document.createElement("div");
        session.className = "bg-timer-session";
        const raw = document.createElement("span");
        raw.className = "bg-job-rawtk";
        const badge = document.createElement("button");
        badge.type = "button";
        badge.className = "bg-job-session";
        const entry = { row, when, label, badge, raw, x, detail: "" };
        badge.addEventListener("click", (e) => {
          e.stopPropagation();
          closeBgTimerDetail();
          jumpToBgSession(timerThreadKey(entry.x));
        });
        label.addEventListener("pointerenter", (e) => {
          if (e.pointerType !== "touch" && !bgDetailPinned) showBgTimerDetail(entry);
        });
        label.addEventListener("pointerleave", leaveBgTimerDetail);
        label.addEventListener("focus", () => showBgTimerDetail(entry));
        label.addEventListener("blur", () => { if (bgDetailOwner === entry && !bgDetailPinned) closeBgTimerDetail(); });
        // hover/focus는 preview, click은 pin. touch의 pointerdown→focus→click 첫 입력도
        // preview가 열렸다는 이유로 닫지 않는다. 둘째 click만 닫음. Enter/Space는 native click.
        label.addEventListener("click", (e) => {
          e.stopPropagation();
          if (bgDetailOwner === entry && bgDetailPinned) closeBgTimerDetail();
          else pinBgTimerDetail(entry);
        });
        session.append(raw, badge);
        info.append(when, label, session);
        row.appendChild(info);
        // ⋮ 옵션 = 첫 줄 오른쪽 끝(2026-11-12 정태님 확정 «정확히 두 줄 · 우상단 끝 [⋮] · 그 왼쪽 세션 배지»).
        // 기존 ⋯ 메뉴 프리미티브(context-menu.js)를 그대로 쓴다 — 위치·한 번에 한 메뉴·Esc/바깥/스크롤 닫기·화살표.
        // 메뉴 대상은 열 때의 id 로 고정한다(목록이 다시 그려지거나 순서가 바뀌어도 다른 예약을 겨누지 않는다).
        const menu = attachKebab(info, "reservation", () => {
          closeBgTimerDetail();
          bgMenuEntry = entry;
          const tk = timerThreadKey(entry.x);
          // 이동은 배지와 같은 조건 — 이름을 아는 세션만(이름 미상 원시 좌표는 비클릭이 기존 계약, GPT R1 #3).
          return { type: "reservation", targetId: String(entry.x.id), rawId: entry.x.id, kind: schedule ? "schedule" : "timer", threadKey: tk, named: sessionNameFor(tk) !== "", label: entry.x.label };
        }, { returnFocus: true });
        menu.classList.add("bg-timer-menu");
        menu.textContent = "⋮";
        menu.setAttribute("aria-haspopup", "menu");
        entry.menu = menu;
        return entry;
      };
      const updateBgReservationRow = (entry, x, schedule) => {
        entry.x = x;
        entry.label.textContent = x.label;
        entry.label.setAttribute("aria-label", x.label);
        entry.row.classList.toggle("off", !x.enabled);
        const tk = timerThreadKey(x);
        entry.raw.textContent = tk;
        entry.raw.title = tk;
        updateSessionBadge({ ownerTk: tk, sessBadgeEl: entry.badge, rawTkEl: entry.raw });
        entry.menu.setAttribute("aria-label", i18n("common.menu") + " — " + x.label);
        if (schedule) {
          const next = typeof x.nextRun === "number" && Number.isFinite(x.nextRun) ? new Date(x.nextRun).toLocaleString() : i18n("bg.schedules.unknown");
          entry.when.textContent = !x.enabled ? i18n("bg.timers.off") : x.triggerType === "reboot" ? i18n("bg.schedules.reboot") : i18n("bg.schedules.waiting", { when: next });
          if (x.triggerType === "cron") entry.when.textContent += " · " + x.cronExpr + " · " + x.timezone;
          entry.when.title = entry.when.textContent; // 첫 줄은 말줄임 — 전체는 hover 와 내용 상세(focus·탭)로 본다.
          entry.detail = x.label + "\n" + entry.when.textContent;
        } else {
          const failed = !x.enabled && x.lastStatus === "error";
          entry.row.classList.toggle("failed", failed);
          entry.row.classList.toggle("bg-flash", String(x.id) === bgTimerFlash.id && bgTimerFlash.until > Date.now());
          entry.when.textContent = "⏱ " + (x.enabled ? timerLeftText(x.runAt) : i18n(failed ? "bg.timers.failed" : "bg.timers.off"));
          entry.when.title = failed && x.lastError ? x.lastError : new Date(x.runAt).toLocaleString();
          entry.detail = x.label + "\n" + new Date(x.runAt).toLocaleString();
        }
        if (bgDetailOwner === entry) { bgTimerDetail.textContent = entry.detail; positionBgTimerDetail(); }
      };
      const syncBgReservationRows = (items, rows, list, schedule) => {
        if (!list) return;
        items.forEach((x, i) => {
          const key = String(x.id);
          let entry = rows.get(key);
          if (!entry) { entry = makeBgReservationRow(x, schedule); rows.set(key, entry); }
          updateBgReservationRow(entry, x, schedule);
          if (list.children[i] !== entry.row) list.insertBefore(entry.row, list.children[i] || null);
        });
      };
      const pruneBgReservationRows = (rows, keep, kind) => {
        for (const [id, entry] of rows) if (!keep.has(id)) {
          if (bgDetailOwner === entry) closeBgTimerDetail();
          releaseBgReservation(entry, kind);
          entry.row.remove();
          rows.delete(id);
        }
      };
      const renderBgTimers = () => {
        const focus = document.activeElement;
        const detailOwner = bgDetailOwner;
        const detailPinned = bgDetailPinned;
        const all = typeof bgSessionScope === "string" && bgSessionScope === "all";
        const inScope = (x) => all || timerThreadKey(x) === activeThreadKey;
        const mine = bgTimers.filter((x) => x && typeof x.runAt === "number" && inScope(x)).sort((a, b) => a.runAt - b.runAt);
        if (bgTimersCount) bgTimersCount.textContent = i18n("bg.timers.count", { n: mine.length });
        pruneBgReservationRows(bgTimerRows, new Set(mine.map((x) => String(x.id))), "timers");
        syncBgReservationRows(mine, bgTimerRows, bgTimersList, false);
        if (bgTimersBox) bgTimersBox.hidden = mine.length === 0;
        const schedules = bgSchedules.filter((x) => x && (x.triggerType === "cron" || x.triggerType === "reboot") && inScope(x));
        const enabled = schedules.filter((x) => x.enabled).sort((a, b) => (a.nextRun ?? Infinity) - (b.nextRun ?? Infinity) || a.id - b.id);
        const off = schedules.filter((x) => !x.enabled).sort((a, b) => a.id - b.id);
        pruneBgReservationRows(bgScheduleRows, new Set(schedules.map((x) => String(x.id))), "schedules");
        syncBgReservationRows(enabled, bgScheduleRows, bgSchedulesList, true);
        syncBgReservationRows(off, bgScheduleRows, bgSchedulesOffList, true);
        if (bgMenuEntry && bgSchedulesOff && !bgSchedulesOff.open && bgSchedulesOff.contains(bgMenuEntry.row)) releaseBgReservation(bgMenuEntry, "off");
        if (bgSchedulesCount) bgSchedulesCount.textContent = i18n("bg.timers.count", { n: schedules.length });
        if (bgSchedulesOffSummary) bgSchedulesOffSummary.textContent = i18n("bg.schedules.offCount", { n: off.length });
        if (bgSchedulesOff) bgSchedulesOff.hidden = off.length === 0;
        if (bgSchedulesBox) bgSchedulesBox.hidden = schedules.length === 0;
        if (focus && focus.isConnected && document.activeElement !== focus) focus.focus({ preventScroll: true });
        applyBgFocusFallback();
        // 행 이동의 native blur/focus로 열린 상세가 사라지지 않게 한다. 사라진 id나
        // 접힌 꺼짐 영역으로 옮겨진 항목은 다시 열지 않는다.
        if (!detailOwner && bgDetailOwner) closeBgTimerDetail(); // 닫힌 채 focus만 있던 버튼은 재배치로 열지 않는다.
        if (detailOwner && detailOwner.row.isConnected) {
          if (bgSchedulesOff && bgSchedulesOff.contains(detailOwner.row) && !bgSchedulesOff.open) closeBgTimerDetail();
          else { showBgTimerDetail(detailOwner); bgDetailPinned = detailPinned; }
        }
      };

      // 늦게 온 옛 응답이 새 목록을 덮지 않게 — 받을 때마다 세대를 올리고 마지막 것만 쓴다.
      const loadBgTimers = () => {
        const gen = ++bgTimersGen;
        return fetch("/api/timers")
          .then((r) => (r.ok ? r.json() : null))
          .then((d) => {
            if (gen !== bgTimersGen || !d || !Array.isArray(d.timers)) return;
            bgTimers = d.timers;
            bgSchedules = Array.isArray(d.schedules) ? d.schedules : [];
            timersRes.set(bgTimers);
            renderBgTimers();
          })
          .catch(() => { /* 미도달 — 다음 계기에 다시 */ });
      };

      // 멈추는 중인 타이머 id — 그동안 ⋮ 메뉴의 «멈추기»를 끈다(옛 멈추기 버튼의 disabled 자리).
      const bgTimerStopping = new Set();
      const cancelBgTimer = (id) => {
        const key = String(id);
        if (bgTimerStopping.has(key)) return;
        bgTimerStopping.add(key);
        fetch("/api/cancel-timer", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) })
          .then((r) => {
            // 404 = 이미 울렸거나 지워졌다 — 목록에서 빼면 된다.
            if (!r.ok && r.status !== 404) throw new Error("cancel failed");
            bgTimerStopping.delete(key);
            // ★멈추기 전에 떠난 목록 조회가 늦게 오면 멈춘 타이머를 화면에 되살린다(아스트라 10-20 P2) — 세대를 올려 그 응답을 버리고, 지금 목록을 다시 받는다.
            bgTimersGen += 1;
            bgTimers = bgTimers.filter((x) => x.id !== id);
            timersRes.set(bgTimers);
            renderBgTimers();
            loadBgTimers();
          })
          .catch(() => {
            bgTimerStopping.delete(key);
            // 멈추는 중에 다시 연 메뉴는 «멈추기»가 꺼진 채 굳어 있다 — 닫는다(다시 열면 켜져 있다, GPT R1 #1).
            const entry = bgTimerRows.get(key);
            if (entry && isMenuOpenAt(entry.menu)) {
              const a = document.activeElement;
              closeMenu(!!a && typeof a.closest === "function" && a.closest(".ctx-menu") !== null);
            }
            showToast(i18n("bg.timers.stopFailed"), "error");
          });
      };

      // ── ⋮ 메뉴(예약 카드) — 카드에 원래 있던 동작만: 상세 보기(내용 누르기와 같은 고정 상세) · 세션으로 이동
      //  (배지와 같은 길·같은 조건 — 이름을 아는 세션만) · 타이머만 멈추기.
      //  반복 스케줄에는 멈추기·삭제가 없다(서버 `/cancel-timer` 는 타이머만 지운다 — 새 API 를 만들지 않는다).
      //  멈추기는 종전 버튼처럼 확인창 없이 바로 한다(danger 확인을 새로 끼우지 않는다).
      const bgReservationEntry = (ctx) => (ctx.kind === "timer" ? bgTimerRows : bgScheduleRows).get(ctx.targetId);
      registerBuiltinHandler("reservation.detail", (ctx) => {
        const entry = bgReservationEntry(ctx);
        if (!entry || !entry.row.isConnected) return;
        pinBgTimerDetail(entry);
      });
      registerBuiltinHandler("reservation.jump", (ctx) => {
        const entry = bgReservationEntry(ctx);
        const tk = entry ? timerThreadKey(entry.x) : ctx.threadKey;
        if (sessionNameFor(tk) !== "") jumpToBgSession(tk);
      });
      registerBuiltinHandler("reservation.stop", (ctx) => { if (ctx.kind === "timer") cancelBgTimer(ctx.rawId); });
      registerMenuItems("reservation", (ctx) => {
        const items = [{ id: "detail", label: i18n("bg.detail.show"), icon: "🔎", action: { kind: "builtin", handler: "reservation.detail" } }];
        if (ctx.named) items.push({ id: "jump", label: i18n("common.jumpSession"), icon: "↪️", action: { kind: "builtin", handler: "reservation.jump" } });
        if (ctx.kind === "timer") {
          items.push({ id: "stop", label: i18n("bg.timers.stop"), icon: "⏹️", group: "stop", enabled: !bgTimerStopping.has(ctx.targetId), action: { kind: "builtin", handler: "reservation.stop" } });
        }
        return items;
      });

      // 턴 끝마다 불린다 — 연달아 끝나도 한 번만 받는다.
      let bgTimersSoon = null;
      window.resyncTimers = () => {
        if (bgTimersSoon !== null) return;
        bgTimersSoon = setTimeout(() => { bgTimersSoon = null; loadBgTimers(); }, 400);
      };
      window.renderBgTimers = renderBgTimers;

      // 위젯의 «보여 줘»(`ctx.reveal({ kind: "timer", id })`) — 패널의 공통 판정(`revealBgCard`)을 탄다.
      // 타이머엔 펼칠 상세·완료 필터는 없고, 접힌 묶음만 공통 경로로 편다.
      window.addEventListener("tigu:reveal", (ev) => {
        const d = ev.detail || {};
        if (d.kind !== "timer" || (typeof d.id !== "string" && typeof d.id !== "number")) return;
        const x = bgTimers.find((t) => String(t.id) === String(d.id));
        bgTimerFlash.id = String(d.id);
        bgTimerFlash.until = Date.now() + 900;
        setTimeout(renderBgTimers, 950); // 강조를 걷는 다시 그리기
        revealBgCard({
          find: () => (bgTimersList ? bgTimersList.querySelector('.bg-timer[data-timer-id="' + CSS.escape(String(d.id)) + '"]') : null),
          inScope: x ? timerThreadKey(x) === activeThreadKey : true,
          groupHead: "bg-timers-head",
          rerender: renderBgTimers,
        });
      });

      setInterval(() => {
        if ((bgTimers.length === 0 && bgSchedules.length === 0) || document.visibilityState !== "visible") return;
        if (bgTimers.some((x) => x.enabled && x.runAt < Date.now() - 5000) || bgSchedules.some((x) => x.enabled && typeof x.nextRun === "number" && x.nextRun < Date.now() - 5000)) loadBgTimers();
        else renderBgTimers();
      }, 30000);

      loadBgTimers();
