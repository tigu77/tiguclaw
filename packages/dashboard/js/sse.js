      // ★턴 실패 고지 (2026-07-26) — "에러가 났는데 조용히 있는 거 아니냐"(사용자 지적).
      // 실제로 조용했다. 폴백은 두 종류인데 고지가 한쪽만 있었다:
      //   ① 풀 *간* 폴백(지정 모델 거부 → 기본 프로파일) → 답변에 ⚠️ 고지 있음.
      //   ② 풀 *안* 폴백(codex 실패 → 같은 풀의 claude) → **고지 0**. 정상 답변만 보인다.
      // 오늘 codex 빈 응답 3건이 전부 ②였고, 그래서 몇 주간 아무도 몰랐다.
      // 답변 본문은 오염시키지 않는다(성공한 답은 그대로) — 대신 실패 사실을 별도 줄로 남긴다.
      // 개별 건은 여기(대시보드), 급증(3건+)은 self-growth 자가 점검이 텔레그램으로 민다.
      const renderTurnFailure = (p, evTs) => {
        const tk = p.threadKey;
        if (isEndpointThread(tk)) return;   // 기계 API 호출 — 엔드포인트 뷰가 따로 보여준다.
        if (!isActiveThread(tk)) return;    // 멀티세션 — 자기 세션에만.
        const who = p.adapter ? String(p.adapter) : i18n("sys.model");
        const why = p.message ? ` — ${String(p.message).slice(0, 140)}` : "";
        // ★"다른 모델로 이어서" 는 **다음 후보가 실제로 있을 때만** (2026-07-30).
        //  종전엔 무조건 붙여서, 단일 모델 세션(의도적 설정)에서는 항상 거짓말이었다 —
        //  사용자는 오지 않을 답을 기다렸다(실측: 27분 과부하 중 7회 전부 후보 0).
        const next = p.hasFallback
          ? i18n("sys.fallback.trying")
          : i18n("sys.fallback.exhausted");
        // ★사용량 한도면 **언제 풀리는지** 말한다 (2026-08-01, 사용자 지적).
        //  429 원문에 resets_at 이 오는데 위 `why` 가 140자에서 잘라 **그 값 바로 앞에서**
        //  끊겼다. 서버는 그걸 파싱해 쿨다운까지 걸어놓고 있었으니 — 아는데 말을 안 한 것.
        //  이제 서버가 해제 시각을 payload 로 실어 준다(문구를 프런트가 다시 조립하지 않는다).
        let until = "";
        if (typeof p.cooldownUntilTs === "number" && p.cooldownUntilTs > Date.now()) {
          const d = new Date(p.cooldownUntilTs);
          const mins = Math.round((p.cooldownUntilTs - Date.now()) / 60000);
          // 날짜·시각 표기는 **화면 언어**를 따른다(고정 "ko-KR" 은 영어 화면에서도 한국식이었다).
          const loc = currentLocale();
          const when = mins >= 1440
            ? `${d.toLocaleDateString(loc, { month: "numeric", day: "numeric" })} ${d.toLocaleTimeString(loc, { hour: "2-digit", minute: "2-digit" })}`
            : d.toLocaleTimeString(loc, { hour: "2-digit", minute: "2-digit" });
          const dur = mins >= 1440
            ? i18n("sys.cooldown.days", { n: Math.round(mins / 1440) })
            : mins >= 60
              ? i18n("sys.cooldown.hours", { n: Math.round(mins / 60) })
              : i18n("sys.cooldown.mins", { n: mins });
          until = i18n("sys.cooldown.note", { when, dur });
        }
        renderLocalChat(
          "error",
          i18n("sys.turnFailed", { who, why, until, next }),
          { ts: evTs, key: "turn-failure|" + (tk || "") },
        );
      };

      // 대화 압축 통지 (2026-07-29) — 옛 대화가 요약으로 바뀐 상태 변화를 사용자에게 알린다.
      // 임계 초과 시에만 발생하므로 매 턴 뜨지 않는다. 자기 세션에만(멀티세션 누수 0).
      const renderCompacted = (p, evTs) => {
        const tk = p.threadKey;
        if (isEndpointThread(tk)) return;
        if (!isActiveThread(tk)) return;
        const turns = Number(p.foldedTurns) || 0;
        const from = Number(p.foldedChars) || 0;
        const to = Number(p.summaryChars) || 0;
        // 경과 — 기다린 시간이 얼마였는지 사후에도 보이게(진단의 1차 수치).
        const ms = Number(p.elapsedMs) || 0;
        const took = ms > 0 ? i18n("sys.compact.took", { sec: (ms / 1000).toFixed(1) }) : "";
        renderLocalChat(
          "info",
          i18n("sys.compact.done", { turns, from: from.toLocaleString(), to: to.toLocaleString(), took }),
          { ts: evTs, key: "compacted|" + (tk || "") + "|" + evTs },
        );
      };

      // ★압축 **직전** 표시 (2026-08-10) — 출발점은 "압축이 오래 걸리는데 뭘 하는지
      //  모르겠다" 였다. 종전엔 사후(`llm.compacted`)만 그려서, 정작 기다리는 동안엔
      //  스피너만 돌고 이유가 없었다. 요약은 6~8만 자를 LLM 에 넣는 호출이라 길다.
      //  codex(폴드 직전)·claude(SDK PreCompact 훅) 둘 다 같은 이벤트를 낸다.
      /**
       * 압축 안내에 **경과시간**을 얹는다 (2026-08-25 사용자 요청: "⏳ 16s 이것만 들어가도").
       *
       * ★왜 진행률(%)이 아닌가: 요약은 LLM **한 번 호출**이라 중간 진척이 없다. 아는 건
       *  "무엇을 하는 중인가" 와 "몇 초째" 뿐이다. 가짜 진행률 바는 90%에서 멈춰 서고,
       *  그건 아무것도 안 보여주는 것보다 나쁘다.
       * ★형식은 `util.js` 의 **공용 `fmtElapsed`** 를 쓴다 — 드로어·채널힌트·옵션칩이 이미 쓰는
       *  그 함수다. 표현을 두 벌 만들면 같은 시간이 화면마다 다르게 보인다(오늘 모델 배지에서
       *  겪은 부류). 뱃지 클래스(`dur-badge running`)도 드로어와 **같은 것**을 쓴다.
       */
      const compactingTimers = new Map(); // threadKey → { el, startTs }
      const tickCompacting = () => {
        const now = Date.now();
        for (const [key, e] of compactingTimers) {
          if (!e.el || !e.el.isConnected) { compactingTimers.delete(key); continue; }
          const b = e.el.querySelector(":scope .dur-badge.running");
          if (b) b.textContent = "⏳ " + fmtElapsed(now - e.startTs);
        }
      };
      setInterval(tickCompacting, 1000);
      /** 압축이 끝났다 = 더는 안 돈다. 표식을 걷는다(끝난 뒤에도 도는 유령 방지). */
      const stopCompactingTick = (tk) => {
        const e = compactingTimers.get(tk || "");
        if (!e) return;
        compactingTimers.delete(tk || "");
        const b = e.el && e.el.querySelector(":scope .dur-badge.running");
        if (b) b.remove();
      };

      const renderCompacting = (p, evTs) => {
        const tk = p.threadKey;
        if (isEndpointThread(tk)) return;
        if (!isActiveThread(tk)) return;
        const turns = Number(p.pendingTurns) || 0;
        const el = renderLocalChat(
          "info",
          turns > 0
            ? i18n("compact.running", { turns })
            : i18n("compact.runningNoTurns"),
          // key 에 ts 를 넣어 같은 스레드의 다음 압축과 안 겹치게(사후 렌더와 동형).
          { ts: evTs, key: "compacting|" + (tk || "") + "|" + evTs },
        );
        // 중복/보류로 안 그려졌으면(renderLocalChat 이 undefined) 틱도 안 건다.
        if (!el) return;
        const startTs = typeof evTs === "number" ? evTs : Date.now();
        const b = document.createElement("span");
        b.className = "dur-badge running";
        b.textContent = "⏳ " + fmtElapsed(Date.now() - startTs);
        const body = el.querySelector(":scope > .chat-message") || el;
        body.appendChild(b);
        compactingTimers.set(tk || "", { el, startTs });
      };

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
        evCountEl.textContent = i18n("sys.eventCount", { n: evCount });
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
          if (ev.type === "llm.turn_done") {
            cancelErrClear(tk); markTurnDone(tk); // 성공 종결 = 즉시.
            setTurnCost(tk, ev.payload || {});    // 턴 비용(토큰) 카드에 고정 — 2026-07-26.
          }
          else {
            scheduleErrClear(tk); // 에러 = 폴백 가능 → 유예 클리어(후속 진행 이벤트가 취소).
            renderTurnFailure(ev.payload || {}, ev.ts);
          }
        }
        // 엔드포인트·게이트웨이 = 같은 뷰(외부 호출 기록). kind 로 구분·필터한다.
        if (ev.type === "endpoint.call") { captureEndpointCall({ ...(ev.payload || {}), kind: "endpoint", ts: ev.ts }); return; }
        if (ev.type === "gateway.call") { captureEndpointCall({ ...(ev.payload || {}), kind: "gateway", ts: ev.ts }); return; }
        if (ev.type === "channel.message.in" || ev.type === "channel.message.out") {
          const tk = ev.payload && ev.payload.threadKey;
          // 엔드포인트 turn(기계 API 호출)은 채팅서 제외 — 방어적(보통 endpoint 는 channel.message
          // 미발생, llm.delta/turn 만; 캡처는 delta 누적 경로가 담당). 진행표시도 스킵.
          if (isEndpointThread(tk)) return;
          // ★합성 인바운드(워커·에이전트 완료 재주입) — **그리지 말고 켜기만** (2026-08-13).
          //  이 턴은 사용자가 친 말이 아니라 메인이 결과를 맥락 입혀 정리하는 구간이다.
          //  버블로 그리면 스캐폴딩이 "나" 로 새고, 안 그리면 종전처럼 화면이 통째로 빈다
          //  (사용자: "딱 빈공간인 느낌"). 둘 다 아니게 — 진행 표시만 켠다.
          //  ★안 본 배지도 안 올린다: 내가 못 본 **답변**이 생긴 게 아니라 일이 시작된 것이다.
          if (ev.type === "channel.message.in" && ev.payload && ev.payload.synthetic) {
            cancelErrClear(tk);
            if (Date.now() - (ev.ts || 0) < 120000) markTurnActive(tk, { reason: ev.payload.reason });
            return;
          }
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
            if (vtIsStaleForAppend(ev.ts)) return; // 첨부 out 도 동일 — replay 과거분 append 금지.
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
          // ★안 본 메시지 적재 (2026-08-12) — **활성 세션 가드보다 먼저** 해야 한다.
          //  아래 `!isActiveThread → return` 이 비활성 세션을 여기서 끊으므로, 그 뒤에 두면
          //  정작 세려던 경우(다른 탭에 온 답)에 한 번도 안 불린다. 실제로 그렇게 뒀다가
          //  헤드리스 검증에서 배지가 안 떠서 잡았다 — 가드 위/아래는 의미가 정반대다.
          //  세는 건 비서 답변(out)만: 인바운드는 내가 다른 채널에서 친 말이라 "안 본" 이 아니다.
          if (ev.type === "channel.message.out") bumpUnread(tk);
          // ★멀티세션(B계층) — 채팅 스트림 DOM 은 active 세션만. 비active 는 워킹표시만 갱신하고
          // 스트림 미출력(원본은 chat_log/SSE 보존 = 전환 시 fetch 재빌드, §3.4).
          if (!isActiveThread(tk)) return;
          // ★이력 로드 창이면 보류 (2026-07-28) — 이 창엔 리스트가 비어 있어 아래 stale 가드가
          //  꺼진다(빈 리스트 = 비교 기준 없음). 지금 붙이면 뒤이어 prepend 되는 이력 아래에
          //  옛 메시지가 남아 순서가 깨진다. 이력 렌더 후 시간순으로 다시 흘린다(chat-core).
          if (holdSseEventDuringHistory(ev)) return;
          // dedup — chat-history 로 이미 그린 과거 메시지면(ts|role 일치) 스킵.
          const role = ev.type === "channel.message.out" ? "assistant" : "user";
          const key = msgKey(ev.ts, role);
          if (renderedMsgKeys.has(key)) return;
          // ★재연결 replay 로 온 *과거* 메시지는 바닥에 붙이지 않는다 — 붙이면 옛 메시지가
          //  최신처럼 보인다(vtIsStaleForAppend 주석의 실측 사례). 원본은 chat_log 에 있어
          //  위로 스크롤하거나 새로고침하면 제 순서로 나온다 = 손실 아님.
          if (vtIsStaleForAppend(ev.ts)) {
            console.debug("[sse] stale replay 무시(순서 보호):", role, new Date(ev.ts).toISOString());
            return;
          }
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
          // ★여기부터는 **메인 턴의 활동**이다 — 진행 표시에 "지금 무엇을 하는 중" 을 싣는다
          //  (2026-08-21 사용자 요청: "뭐하는 중인지 구분해서 알 수 있을까"). 위 줄에서 워커·
          //  에이전트가 걸러졌으므로 백그라운드 잡이 메인 상태로 새지 않는다.
          setTurnPhase(ap.threadKey, ap.kind, ap.label);
          // ★§3.4 마스터 데이터 보존 — 전 스레드 활동 원본을 activityByStep 에 무필터 저장(후속
          // 전체 활동 뷰 인에이블러). 렌더 게이트(B계층)는 아래 activeThreadKey 필터에서만 건다.
          activityByStep.set(stepKey(ap.threadKey || "?", ap.seq), ap);
          // 멀티세션(B계층) — 채팅 스트림 DOM(스폰 칩 포함)은 active 세션만. 세션 A 스폰 칩이 B 에
          // 새지 않음(§3.3 교차 누수 0 — 스폰 스텝의 부모 threadKey 가 곧 그 세션이므로 자연 격리).
          if (!isActiveThread(ap.threadKey)) return;
          // ★이력 로드 창 보류 (2026-07-29 검토) — 메시지에만 걸려 있어 활동은 빈 리스트에
          //  그대로 붙었다(05d2f46 이 고친 것과 같은 버그가 이 경로에 남아 있었다).
          if (holdSseEventDuringHistory(ev)) return;
          // ★재연결 replay 순서 보호 (2026-07-28 검수) — dedup(renderedActivityKeys)이
          //  중복은 막지만 **순서**는 안 본다. 이력 페이지에 없던 옛 활동이 replay 로 오면
          //  최신 대화 아래에 도구 스텝이 붙는다(메시지·선택지에서 고친 것과 같은 부류).
          //  진행 중 활동은 항상 최신이라 이 가드에 안 걸린다(라이브 무영향).
          if (vtIsStaleForAppend(ev.ts)) {
            console.debug("[activity] stale replay 무시(순서 보호):", ap.label || ap.kind || "?");
            return;
          }
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
          if (ptk && !isActiveThread(ptk)) {
            // ★조용히 버리지 않는다 (2026-07-28) — 사용자에겐 "선택지가 안 뜬다"로만 보이고
            //  원인(다른 탭 소속)이 어디에도 안 남았다. 두 키를 함께 남겨 한 눈에 갈리게.
            console.warn(
              `[prompt-options] 다른 세션 소속이라 렌더 생략 — 이벤트=${ptk} 활성=${activeThreadKey}`,
            );
            return;
          }
          // ★재연결 replay 방어 (2026-07-28) — 이 렌더러엔 dedup 도 순서 가드도 없었다.
          //  replay 창(최근 50건)에 prompt.options 가 들어 있으면 **재연결할 때마다** 같은
          //  선택지가 채팅 바닥에 다시 그려진다("옛 메시지가 마지막에 들어온다" 실사고).
          //  메시지 경로가 이미 쓰는 두 가드를 그대로 적용한다: 같은 이벤트는 한 번만,
          //  그리고 이미 지나간 것은 바닥에 붙이지 않는다.
          //  ★진행 중 질문은 살린다 — 최신이면 stale 이 아니므로 재연결해도 버튼이 남는다.
          if (holdSseEventDuringHistory(ev)) return; // 이력 창 보류(2026-07-29).
          const okey = `${ev.ts}|${ptk || ""}`;
          if (renderedPromptOptionKeys.has(okey)) return;
          if (vtIsStaleForAppend(ev.ts)) {
            console.debug("[prompt-options] stale replay 무시(순서 보호):", new Date(ev.ts).toISOString());
            return;
          }
          renderedPromptOptionKeys.add(okey);
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
          const what = p.label ? `'${p.label}'` : i18n("sys.sched.fallbackLabel", { id: p.scheduleId ?? "?" });
          const where = p.destChannel ? ` → ${p.destChannel}` : "";
          const why = p.error ? ` (${String(p.error).slice(0, 120)})` : "";
          const isDelivery = p.phase === "dispatch" || p.phase === "dispatch_retry";
          // 자동 재전송이 예약된 실패는 **아직 확정이 아니다** — "유실됐다" 고 단정하지 않고
          // 무엇이 예정돼 있는지 알린다(결과는 복구/최종실패로 다시 알림). 재전송이 꺼져
          // 있거나 이미 재전송까지 실패한 건은 그대로 확정 실패.
          const tail = p.willRetry === true
            ? i18n("sys.deliver.retry")
            : isDelivery
              ? i18n("sys.deliver.kept")
              : "";
          const verb = p.phase === "dispatch_retry"
            ? i18n("sys.sendFailedFinal")
            : isDelivery
              ? i18n("sys.sendFailed")
              : i18n("sys.runFailed");
          renderLocalChat(
            p.willRetry === true ? "info" : "error",
            i18n("sys.sched.error", { verb, what, where, why, tail }),
            { ts: ev.ts, key: "scheduler.error" },
          );
          return;
        }
        // 자동 복구 통보(2026-07-26) — 전달만 실패한 스케줄을 스케줄러가 5분 뒤 1회 자동
        // 재전송해 되살렸다. 자동으로 **조치까지** 한 경우라 결과를 반드시 보인다: 사용자가
        // "그러지 마" 할 수 있어야 자동화가 정당하다(settings.json
        // scheduler.retryFailedDispatch=false 로 끈다).
        if (ev.type === "scheduler.recovered") {
          const p = ev.payload || {};
          const what = p.label ? `'${p.label}'` : i18n("sys.sched.fallbackLabel", { id: p.scheduleId ?? "?" });
          renderLocalChat(
            "info",
            i18n("sys.sched.recovered", { what }),
            { ts: ev.ts, key: "scheduler.recovered" },
          );
          return;
        }
        // 자동 지침 적재 통보(2026-07-26) — self-growth 가 반복 실패를 학습해 SELF_GROWTH.md
        // 에 **행동 지침을 자동으로** 박는다(source:"auto", 캡·TTL 로 자동 만료). 구조는 안전
        // 하지만 종전엔 **조용히** 들어가 사용자가 모르니 틀려도 교정할 수 없었다. 행동을 바꾸는
        // 변경은 보이게 한다 — 사용자가 즉시 부정하거나 확정(user 승격)할 기회를 준다.
        // ★directive 로 확정된 것만 알린다. reflection 강등(autoLanded=false)은 행동을 안 바꾸므로
        //   알리지 않는다(노이즈 억제 — 통보가 잦으면 무시하게 돼 없느니만 못하다).
        if (ev.type === "self_growth.failure.learned") {
          const p = ev.payload || {};
          if (p.autoLanded === true && p.target === "directive") {
            renderLocalChat(
              "info",
              i18n("sys.growth.learned", { name: p.memoryName, count: p.count ?? "?" }),
              { ts: ev.ts, key: "self-growth|" + (p.memoryName || "") },
            );
          }
          return;
        }
        // ★압축 고착 통지 (2026-07-30) — 발행은 했는데 **핸들러가 없어** 신호가 다시
        //  데몬 로그에만 있었다. "12일간 아무도 안 봤다"를 고친 신호를 또 안 보이게 두면
        //  같은 사고가 반복된다(감사 지적).
        if (ev.type === "llm.compaction_stuck") {
          const p = ev.payload || {};
          if (!isEndpointThread(p.threadKey) && isActiveThread(p.threadKey)) {
            renderLocalChat(
              "error",
              i18n("sys.compactStuck", {
                streak: p.streak || 3,
                chars: Number(p.foldChars || 0).toLocaleString(),
                reason: p.reason || i18n("common.unknown"),
              }),
              { ts: ev.ts, key: "compaction-stuck|" + (p.threadKey || "") },
            );
          }
          return;
        }
        // 다음 메시지 제안 — 고스트 모듈로 넘긴다(그 모듈이 표시 조건을 판단한다).
        if (ev.type === "chat.suggestion") {
          if (typeof window.applyChatSuggestion === "function") {
            window.applyChatSuggestion(ev.payload || {}, ev.ts);
          }
          return;
        }
        if (ev.type === "llm.compacting") {
          renderCompacting(ev.payload || {}, ev.ts);
          return;
        }
        if (ev.type === "llm.compacted") {
          stopCompactingTick((ev.payload || {}).threadKey);
          renderCompacted(ev.payload || {}, ev.ts);
          return;
        }
        // ★도구 지연 고지 (2026-08-06) — 종전엔 이 이벤트를 **아무도 안 그렸다**. 그래서
        //  도구가 멈춰도 화면엔 "작업 중 · 39분" 만 돌았고 사용자는 느린 건지 멈춘 건지
        //  구분할 수 없었다(회사 PC 실측). 경고가 로그에만 있으면 없는 것과 같다 —
        //  `llm.compaction_stuck` 때 고친 것과 같은 부류(발행은 했는데 소비처가 없음).
        if (ev.type === "llm.tool_slow") {
          const p = ev.payload || {};
          // ★서브에이전트류는 그리지 않는다 (2026-08-19 사용자 신고: "경고가 너무 자주 떠서
          //  혼란"). 오래 걸리는 게 정상이고(실측 평균 124초·최대 627초), 진행 스텝은
          //  **백그라운드 드로어에 실시간으로** 보인다 — 이 경고가 시키는 "확인해봐" 를
          //  사용자가 이미 다른 수단으로 하고 있다. 텔레그램 푸시는 같은 이유로 이미
          //  빼놨는데(shouldNotifyToolSlow) **화면에만 게이트가 없어** 여기로 새고 있었다.
          //  ★이름은 접두사가 붙어 올 수 있다(mcp__agents__spawn_agent) — 서버 판정과
          //   같은 규칙으로 벗겨서 본다.
          const bareTool = String(p.tool || "").startsWith("mcp__")
            ? String(p.tool).split("__").pop()
            : String(p.tool || "");
          const isSubagent = bareTool === "spawn_agent" || bareTool === "Agent" || bareTool === "Task";
          if (!isSubagent && !isEndpointThread(p.threadKey) && isActiveThread(p.threadKey)) {
            const secs = Math.round((Number(p.ms) || 180000) / 1000);
            renderLocalChat(
              "info",
              i18n("sys.toolSlow", { tool: p.tool || "?", sec: secs }),
              { ts: ev.ts, key: "tool-slow|" + (p.threadKey || "") + "|" + (p.tool || "") },
            );
          }
          return;
        }
        // 매니저 스티어(2026-08-05) — worker.* 접두사지만 **상태 전이가 아니다**(잡은 계속
        // running). 아래 generic 분기로 흘리면 status 없는 payload 가 "running" 으로 해석돼
        // 잡 상태를 건드리므로, 그 앞에서 타임라인 스텝으로 가로챈다.
        if (ev.type === "worker.steered") {
          const p = ev.payload || {};
          if (p.ts == null) p.ts = ev.ts; // 숫자 ts — dedup 키(llm.activity 동형).
          handleWorkerSteered(p, ts);
          return;
        }
        // ★서브에이전트가 도구를 한 번도 안 쓰고 끝났다 — 품질 신호(생애주기 아님).
        //  실측(2026-08-07): 파일을 읽으라 시켰는데 5초/도구 0회로 값을 지어냈다. 정상 건은
        //  9~30회 쓴다. 단정하지 않고 **보고 있는 세션에만** 한 줄 남긴다(사람이 결과를
        //  의심해야만 알던 것을 표면으로).
        if (ev.type === "llm.agent_no_tools") {
          const p = ev.payload || {};
          if (isActiveThread(p.threadKey)) {
            renderLocalChat(
              "info",
              i18n("sys.agentNoTools", { name: p.agentName || "agent", chars: p.resultChars ?? "?" }),
            );
          }
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

      /**
       * 로컬 채팅 줄(통지·오류·안내) 렌더.
       *
       * ★opts.ts 를 주면 **replay 방어**가 켜진다 (2026-07-28). 이벤트에서 온 통지는 반드시
       *  주라 — 안 주면 `Date.now()` 가 찍혀 **옛 통지가 방금 온 새 경고처럼** 바닥에 붙고,
       *  재연결마다 반복된다(스케줄 실패·턴 오류가 매번 다시 뜨던 실사고). 사용자가 직접
       *  만든 줄(전송 실패·안내 등 로컬 발생)은 언제나 지금이므로 안 줘도 된다.
       *  가드는 채팅 메시지와 동일: 같은 이벤트는 한 번만, 지나간 것은 바닥에 안 붙인다.
       */
      const renderLocalChat = (kind, text, opts) => {
        const evTs =
          opts && typeof opts.ts === "number" && Number.isFinite(opts.ts) ? opts.ts : null;
        if (evTs !== null) {
          // 이력 로드 창이면 통지도 보류한다(2026-07-29 검토) — 빈 리스트에선 아래 stale
          // 가드가 꺼지므로 옛 경고가 "방금 온 것" 처럼 붙는다. 이력 렌더 후 다시 흘린다.
          if (
            holdSseEventDuringHistory({
              ts: evTs,
              __render: () => renderLocalChat(kind, text, opts),
            })
          ) {
            return;
          }
          const nkey = `${(opts && opts.key) || kind}|${evTs}`;
          if (renderedNoticeKeys.has(nkey)) return; // replay 중복.
          if (vtIsStaleForAppend(evTs)) {
            console.debug("[notice] stale replay 무시(순서 보호):", nkey);
            return;
          }
          renderedNoticeKeys.add(nkey);
        }
        const logEmpty = document.getElementById("log-empty");
        if (logEmpty && firstEvent) {
          // 대화 탭의 빈 상태는 유지하고, 로그 placeholder만 정리합니다.
          logEmpty.remove();
          firstEvent = false;
        }
        localChatCount += 1;
        refreshChatEmpty();
        if (currentView === "overview") setTimeout(showOverview, 0);
        const now = evTs !== null ? evTs : Date.now(); // 통지는 **발생 시각**으로 표기.
        const div = document.createElement("div");
        div.className = "ev local";
        div.dataset.ts = String(now); // 날짜 구분선 경계 판정용.
        const head = document.createElement("div");
        const tsEl = document.createElement("span");
        tsEl.className = "ts";
        tsEl.textContent = fmtTime(now);
        const tyEl = document.createElement("span");
        tyEl.className = "type";
        const chatLabel = { user: i18n("common.sender.me"), reply: assistantName, error: i18n("common.error"), info: i18n("sys.notice") };
        tyEl.textContent = chatLabel[kind] || kind;
        head.appendChild(tsEl); head.appendChild(tyEl);
        div.appendChild(head);
        const msg = document.createElement("div");
        msg.className = "chat-message";
        // 봇 답변(reply)만 마크다운, 사용자/오류는 평문(SSE 권위본과 일관).
        setChatBody(msg, text, kind === "reply");
        div.appendChild(msg);
        vtAppend(div);
        // ★엘리먼트를 돌려준다 — 호출부가 여기에 경과시간 표식을 달 수 있게(압축 등).
        //  종전엔 아무것도 안 돌려줘서 "붙인 뒤 찾아오기" 가 필요했다.
        return div;
      };

