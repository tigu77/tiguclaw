      const renderEvent = (ev) => {
        // 전송 계층 하트비트(2026-07-26) — EventBus 이벤트가 아니라 SSE liveness 신호.
        // 수신 시각 갱신은 호출자(connectStream)가 이미 했으므로 여기선 **렌더 0**으로 즉시 반환
        // (이벤트 카운트·로그·채팅 어디에도 안 샘).
        if (ev && ev.type === "stream.heartbeat") return;
        if (firstEvent) {
          const logEmpty = document.getElementById("log-empty");
          if (logEmpty) logEmpty.remove();
          firstEvent = false;
        }
        evCount += 1;
        evCountEl.textContent = evCount + "개 이벤트";
        const navEventCount = document.getElementById("nav-event-count");
        if (navEventCount) navEventCount.textContent = String(evCount);
        if (currentView === "overview") setTimeout(showOverview, 0);
        const ts = fmtTime(ev.ts);
        // 전체 활동뷰 라이브 분기(§4, 별도 경로) — 아래 채팅뷰 if/return 사슬과 완전히 분리된
        // 호출. return 없이 항상 실행되고 나서 기존 로직이 이어진다(채팅뷰 무회귀).
        handleActivityLiveEvent(ev);
        // 진행 표시 종료(모든 채널) — 턴 종료 신호는 렌더를 막지 않고(return 안 함) 표시만 해제.
        // channel.message.out 이 안 오는 에러 턴까지 확실히 끄기 위한 authoritative 종료.
        if (ev.type === "llm.turn_done" || ev.type === "llm.turn_error") {
          const tk = ev.payload && ev.payload.threadKey;
          markTurnCardDone(tk); // 턴 카드 마지막 스텝 pulse 정지(응답 누락·에러·hang 종료 대비).
          if (ev.type === "llm.turn_done") { cancelErrClear(tk); markTurnDone(tk); } // 성공 종결 = 즉시.
          else scheduleErrClear(tk); // 에러 = 폴백 가능 → 유예 클리어(후속 진행 이벤트가 취소).
        }
        if (ev.type === "endpoint.call") { captureEndpointCall(ev.payload || {}); return; } // 엔드포인트 뷰 데이터.
        if (ev.type === "channel.message.in" || ev.type === "channel.message.out") {
          const tk = ev.payload && ev.payload.threadKey;
          // 엔드포인트 turn(기계 API 호출)은 채팅서 제외 — 방어적(보통 endpoint 는 channel.message
          // 미발생, llm.delta/turn 만; 캡처는 delta 누적 경로가 담당). 진행표시도 스킵.
          if (isEndpointThread(tk)) return;
          // 아웃바운드 첨부(send_file, #2) = 턴 *중간* 산출물 — 최종 답변이 아니므로 턴 종료
          // (markTurnDone)·진행표시 해제를 하지 않는다(최종 text-out 이 마감). dedup 은 고유 ts 라
          // 최종 text-out(같은 role assistant, 다른 ts)과 키 충돌 없음. chat-history 로 이미 그렸으면 스킵.
          if (
            ev.type === "channel.message.out" &&
            ev.payload && ev.payload.attachments && ev.payload.attachments.length
          ) {
            cancelErrClear(tk); // 턴 살아있음(모든 세션) — 워킹표시 유지.
            if (!isActiveThread(tk)) return; // 멀티세션(B계층) — DOM 카드는 active 세션만.
            const akey = msgKey(ev.ts, "assistant");
            if (renderedMsgKeys.has(akey)) return;
            renderedMsgKeys.add(akey);
            renderChannelMessage(ev, ts);
            return;
          }
          // 진행 표시(모든 채널) — 인바운드=턴 시작(텔레그램·CLI 포함), 아웃바운드=턴 종료.
          // ★재연결 replay 방어 — 버퍼가 흘리는 과거 .in 은 phantom 진행표시(짝 turn_done 없음)를
          // 만든다. 최근(2분 이내) .in 만 활성화 → 이미 끝난 옛 턴이 '작업 중'으로 안 뜬다.
          // ★워킹표시(activeTurns)·유예클리어는 모든 세션 무조건 처리(§3.4 — SSE 조기드롭 금지).
          if (ev.type === "channel.message.in") {
            cancelErrClear(tk); // 새 진행 = 유예 클리어 취소.
            if (Date.now() - (ev.ts || 0) < 120000) markTurnActive(tk);
            // 큐 대기 버블 승격 — 이 in echo(=처리 시작=취소 불가 경계, D3)가 대기 중이던 낙관적
            // 버블과 일치하면 새로 안 그리고 배지·✕ 취소 버튼을 떼고 서버 ts 키를 등록(중복 렌더
            // 방지). 매칭은 correlationId(있으면) 우선 → 동일 텍스트 오매칭 해소, 없으면(텔레그램
            // echo 등) 텍스트-매칭 폴백(보존 §6). 낙관적 버블은 active 세션 DOM 에만 있으므로
            // active 일 때만 승격(pendingQueued 는 전환 시 비워짐).
            if (isActiveThread(tk)) {
              const inText = ev.payload && ev.payload.text;
              const inCid = ev.payload && ev.payload.correlationId;
              let pi = -1;
              if (inCid) pi = pendingQueued.findIndex((p) => p.cid && p.cid === inCid);
              if (pi === -1) pi = pendingQueued.findIndex((p) => p.text === inText);
              if (pi !== -1) {
                const { el } = pendingQueued.splice(pi, 1)[0];
                el.classList.remove("queued");
                const b = el.querySelector(".queued-badge"); if (b) b.remove();
                const xb = el.querySelector(".queued-cancel"); if (xb) xb.remove();
                el.dataset.ts = String(ev.ts);
                renderedMsgKeys.add(msgKey(ev.ts, "user"));
                return;
              }
            }
          } else { cancelErrClear(tk); markTurnDone(tk); } // out = 성공 종결(즉시).
          // ★멀티세션(B계층) — 채팅 스트림 DOM 은 active 세션만. 비active 는 워킹표시만 갱신하고
          // 스트림 미출력(원본은 chat_log/SSE 보존 = 전환 시 fetch 재빌드, §3.4).
          if (!isActiveThread(tk)) return;
          // dedup — chat-history 로 이미 그린 과거 메시지면(ts|role 일치) 스킵.
          const role = ev.type === "channel.message.out" ? "assistant" : "user";
          const key = msgKey(ev.ts, role);
          if (renderedMsgKeys.has(key)) return;
          renderedMsgKeys.add(key);
          renderChannelMessage(ev, ts);
          return;
        }
        if (ev.type === "llm.activity") {
          const ap = ev.payload || {};
          if (ap.ts == null) ap.ts = ev.ts; // 숫자 ts — dedup 키(기능 B)·주석에 사용.
          cancelErrClear(ap.threadKey); // 도구 활동 = 턴 살아있음(폴백 진행) → 유예 클리어 취소.
          // 도구 실행시간(#3) — phase:"end" 는 새 스텝이 아니라 같은 seq 의 시작 스텝에
          // durationMs 를 주석(잡 카드 스텝 · 메인 스트림 라인 양쪽). 여기서 가로채 렌더로 안 감.
          if (ap.phase === "end") { annotateToolDuration(ap); return; }
          // 워커 활동(threadKey=worker:<jobId>|agent:<jobId>)은 백그라운드 잡 카드 스텝으로 —
          // 모든 세션 무조건 처리(잡 카드=글로벌 드로어, 채팅 스트림 아님). 채팅 누수 차단.
          if (handleWorkerActivity(ap, ts)) return;
          // ★§3.4 마스터 데이터 보존 — 전 스레드 활동 원본을 activityByStep 에 무필터 저장(후속
          // 전체 활동 뷰 인에이블러). 렌더 게이트(B계층)는 아래 activeThreadKey 필터에서만 건다.
          activityByStep.set(stepKey(ap.threadKey || "?", ap.seq), ap);
          // 멀티세션(B계층) — 채팅 스트림 DOM(스폰 칩 포함)은 active 세션만. 세션 A 스폰 칩이 B 에
          // 새지 않음(§3.3 교차 누수 0 — 스폰 스텝의 부모 threadKey 가 곧 그 세션이므로 자연 격리).
          if (!isActiveThread(ap.threadKey)) return;
          renderActivity(ap, ts);
          return;
        }
        if (ev.type === "llm.delta") {
          const dp = ev.payload || {};
          cancelErrClear(dp.threadKey); // 델타 = 응답 스트리밍 중(폴백 진행) → 유예 클리어 취소.
          // 델타는 휘발성(최종 out 은 chat_log 보존) — active 세션만 스트림 렌더.
          if (!isActiveThread(dp.threadKey)) return;
          renderDelta(dp, ts);
          return;
        }
        if (ev.type === "prompt.options") {
          // 선택지가 특정 세션에 귀속(threadKey 있음)이면 그 탭에서만 렌더. 미지정(레거시)은 active.
          const ptk = ev.payload && ev.payload.threadKey;
          if (ptk && !isActiveThread(ptk)) return;
          renderPromptOptions(ev.payload || {}, ts, ev.ts);
          return;
        }
        // 스케줄 실패 통보(2026-07-26) — 발화는 됐는데 **전달이 실패**하면 종전엔 로그·DB·
        // 이벤트에만 남아 사용자가 유실을 몰랐다(아침 리포트 2건 실사고: 내용은 생성됐고
        // transcripts 에 있는데 텔레그램 502 로 미도달). 텔레그램이 죽어도 대시보드는 살아
        // 있으므로 **다른 전송로**인 여기에 사람이 읽을 수 있게 띄운다. 생성 단계 실패
        // (phase!=="dispatch")도 같이 알린다 — 어느 쪽이든 사용자는 결과를 못 받았다.
        if (ev.type === "scheduler.error") {
          const p = ev.payload || {};
          const what = p.label ? `'${p.label}'` : `스케줄 #${p.scheduleId ?? "?"}`;
          const where = p.destChannel ? ` → ${p.destChannel}` : "";
          const why = p.error ? ` (${String(p.error).slice(0, 120)})` : "";
          const tail = p.phase === "dispatch"
            ? " · 내용은 생성됐고 대화 기록에 남아 있습니다."
            : "";
          renderLocalChat("error", `⚠️ 스케줄 ${p.phase === "dispatch" ? "전송" : "실행"} 실패 — ${what}${where}${why}${tail}`);
          return;
        }
        if (typeof ev.type === "string" && ev.type.indexOf("worker.") === 0) {
          handleWorkerEvent(ev.payload || {}, ts);
          return;
        }
        // 백그라운드 셸 관측 레인(ADR 2026-07-17 §1) — worker.* 라우팅과 동형. handleShellEvent
        // (view-shells.js) 가 shell.started/shell.exited 를 registry 갱신+뷰 리렌더로 처리.
        if (typeof ev.type === "string" && ev.type.indexOf("shell.") === 0) {
          handleShellEvent(ev.type, ev.payload || {}, ts);
          return;
        }
        const div = document.createElement("div");
        div.className = "ev " + typeClass(ev.type);
        div.dataset.type = (ev.type || "").toLowerCase();
        applyFilter(div);
        const head = document.createElement("div");
        const tsEl = document.createElement("span");
        tsEl.className = "ts"; tsEl.textContent = ts;
        const tyEl = document.createElement("span");
        tyEl.className = "type"; tyEl.textContent = ev.type;
        head.appendChild(tsEl); head.appendChild(tyEl);
        div.appendChild(head);
        const pre = document.createElement("pre");
        pre.textContent = JSON.stringify(ev.payload, null, 2);
        div.appendChild(pre);
        // 일반 이벤트(알 수 없는 유형)는 채팅선 숨김·로그 패널(데드)용 → vtItems 오염 방지 위해
        // 숨은 log-sink 에 넣고 소량 상한만 유지(#ev-filter 는 logSink.children 를 순회).
        logSink.insertBefore(div, logSink.firstChild);
        while (logSink.children.length > LOG_SINK_MAX) logSink.removeChild(logSink.lastChild);
      };

      const renderLocalChat = (kind, text) => {
        const logEmpty = document.getElementById("log-empty");
        if (logEmpty && firstEvent) {
          // 대화 탭의 빈 상태는 유지하고, 로그 placeholder만 정리합니다.
          logEmpty.remove();
          firstEvent = false;
        }
        localChatCount += 1;
        refreshChatEmpty();
        if (currentView === "overview") setTimeout(showOverview, 0);
        const now = Date.now();
        const div = document.createElement("div");
        div.className = "ev local";
        div.dataset.ts = String(now); // 날짜 구분선 경계 판정용.
        const head = document.createElement("div");
        const tsEl = document.createElement("span");
        tsEl.className = "ts";
        tsEl.textContent = fmtTime(now);
        const tyEl = document.createElement("span");
        tyEl.className = "type";
        const chatLabel = { user: "나", reply: assistantName, error: "오류", info: "안내" };
        tyEl.textContent = chatLabel[kind] || kind;
        head.appendChild(tsEl); head.appendChild(tyEl);
        div.appendChild(head);
        const msg = document.createElement("div");
        msg.className = "chat-message";
        // 봇 답변(reply)만 마크다운, 사용자/오류는 평문(SSE 권위본과 일관).
        setChatBody(msg, text, kind === "reply");
        div.appendChild(msg);
        vtAppend(div);
      };

