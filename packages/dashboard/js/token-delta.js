      // ── P5 L3 — 토큰 델타 증분 렌더 ───────────────────────────────────────
      // 같은 threadKey 의 진행 버블에 delta 를 순서대로 평문 append(미완성 마크다운 깜빡임 회피).
      // 스텝 그룹(P3)이 진행 중이면 그 그룹의 답변 슬롯으로, 없으면 경량 delta 그룹을 새로 만든다.
      // 최종 권위는 channel.message.out — 도착 시 이 버블을 마크다운 전체본으로 승격(renderChannelMessage).
      const renderDelta = (p, ts) => {
        const delta = String(p.delta || "");
        if (delta === "") return;
        const thread = p.threadKey || activeThreadKey;
        if (isEndpointThread(thread)) return; // 엔드포인트 스트리밍은 채팅에 안 뿌린다(뷰 데이터는 endpoint.call 이벤트).
        const adapter = ADAPTERS.includes(p.adapter) ? p.adapter : "other";
        let card = cardByThread.get(thread);
        // 진행 버블을 붙일 그룹이 없거나 이미 닫힌(답변 완료) 턴이면 새 경량 그룹 시작.
        if (!card || !vtIndex.has(card.group) || card.closed) {
          card = createDeltaGroup(p, ts, adapter, thread);
          cardByThread.set(thread, card);
          vtAppend(card.group);
        }
        ensureReplyBubble(card, ts);
        // 평문 누적(textContent) — 스트리밍 중 부분 마크다운/미완 코드펜스 위험·깜빡임 회피.
        card.replyRaw += delta;
        card.replyMsg.textContent = card.replyRaw;
        // firstEvent/evCount 는 renderEvent 진입부에서 이미 처리됨(델타도 이벤트 1건).
        refreshChatEmpty();
        if (currentView === "overview") setTimeout(showOverview, 0);
      };

      const renderActivity = (p, ts) => {
        const thread = p.threadKey || "?";
        // dedup(기능 B) — chat-history 가 이미 그린 영속 스텝/세그먼트면 SSE replay 는 스킵(중복 차단).
        const ak = actKey(p.ts != null ? p.ts : ts, thread, p.seq);
        if (renderedActivityKeys.has(ak)) return;
        renderedActivityKeys.add(ak);
        // 마스터 데이터 저장: 전체 payload 를 threadKey+seq 키로(클릭 시 상세 조회 · 텍스트도 일관 저장).
        activityByStep.set(stepKey(thread, p.seq), p);
        const adapter = ADAPTERS.includes(p.adapter) ? p.adapter : "other";

        // ── kind:"text" = 어시스턴트 텍스트 세그먼트(인터리브, 2026-07-13) ─────────────
        // seq 순서상 자기 뒤 도구보다 먼저 도착(백엔드가 도구 전에 flush) → 진행 중 델타 버블을
        // 이 세그먼트의 권위 마크다운으로 확정하고, 카드를 "텍스트로 닫힘" 표시해 다음 도구가
        // 새 카드(=텍스트 아래)로 내려가게 한다. 델타 없이 세그먼트만 온 경우 버블을 새로 만든다.
        if (p.kind === "text") {
          let card = cardByThread.get(thread);
          if (!card || !vtIndex.has(card.group) || card.closed) {
            card = createDeltaGroup(p, ts, adapter, thread);
            cardByThread.set(thread, card);
            vtAppend(card.group);
          }
          const txt = String(p.text || "");
          if (!card.replyBubble && txt !== "") ensureReplyBubble(card, ts); // 델타 없는 세그먼트 = 버블 신설.
          if (card.replyMsg) {
            setChatBody(card.replyMsg, txt, true);       // 평문 델타 → 세그먼트 마크다운 전체본(자가치유).
            card.replyMsg.classList.remove("streaming");  // 타이핑 커서 off(세그먼트 확정).
          }
          card.replyBubble = null; card.replyMsg = null; card.replyRaw = "";
          card.sawTextSegment = true;   // out.text 최종 버블 중복 렌더 방지(§5.1).
          card.closedByText = true;     // 다음 도구는 새 카드로.
          if ((p.seq ?? -1) > card.lastSeq) card.lastSeq = p.seq;
          refreshChatEmpty();
          scheduleRelayout();
          if (currentView === "overview") setTimeout(showOverview, 0);
          return;
        }

        let card = cardByThread.get(thread);
        const prevCard = card; // 직전 턴/런(있으면) — 새 카드 시작 시 접어 최신만 펼침 유지.
        // 새 카드 = 카드 없음 / 제거됨 / seq 리셋 / 답변으로 닫힘 / delta-only 그룹 / 직전 텍스트가 런을 닫음.
        const isNewTurn =
          !card || !vtIndex.has(card.group) || card.closed || !card.el ||
          (p.seq ?? 0) <= card.lastSeq || card.closedByText;
        if (isNewTurn) {
          // 같은 턴의 연속(텍스트 세그먼트가 도구 런을 분할, 또는 delta-only 뒤 첫 도구)이면
          // sawTextSegment 를 승계해 turn 종료 시 out.text 이중 렌더를 막는다(seq 증가 = 같은 run).
          const continuation =
            prevCard && !prevCard.closed && vtIndex.has(prevCard.group) &&
            (prevCard.closedByText || !prevCard.el) && (p.seq ?? 0) > prevCard.lastSeq;
          // ★최신/진행중 카드만 펼침(2026-07-10) — 새 카드 시작 시 직전 카드를 접는다(도구 클러터↓,
          // 단 직전 카드의 텍스트 버블은 turn-body 밖 그룹 형제라 접혀도 계속 보인다).
          if (prevCard && prevCard.el) {
            prevCard.el.classList.add("done-collapsed");
            const pc = prevCard.el.querySelector(".turn-caret"); if (pc) pc.textContent = "▶";
          }
          card = createTurnCard(p, ts, adapter, thread);
          if (continuation && prevCard.sawTextSegment) card.sawTextSegment = true;
          cardByThread.set(thread, card);
          vtAppend(card.group);
        }
        card.body.appendChild(buildActivityLine(p));
        card.lastSeq = p.seq ?? 0;
        card.count += 1;
        card.countEl.textContent = card.count + "단계";
        // 진행 중/접힘 시 헤더 미리보기 — 도구명 + 상세(무슨 파일/명령인지 한눈에).
        {
          const skill = skillStepInfo(p);
          card.lastEl.textContent = skill
            ? "🛠 스킬: " + skill.name
            : (p.label || p.kind || "") + (p.detail ? " · " + p.detail : "");
        }
        card.setOpen(true); // 진행 중엔 펼쳐서 라이브로 보이게.
      };

      // 답변(channel.message.out) 도착 시, 같은 threadKey 의 진행 중 턴 그룹을 마무리한다.
      // 답변 버블을 그 그룹 안(스텝 아래)에 배치 + 스텝 카드를 "n단계 완료" 로 접는다.
      // 진행 중 그룹이 없으면 null 반환 → 호출부가 기존 단독 버블로 렌더(회귀 0).
      // 턴 종료 시 마지막 스텝 pulse 정지용 — 카드에 .done 만 붙인다(collapse·closed 안 함).
      // completeTurnGroup(응답 도착)은 그대로 full 완료(접기)를 한다. 응답이 안 와도(에러·
      // Edit hang·타임아웃 종료) turn_done/turn_error 에서 이걸 불러 스텝이 영영 깜빡이는 것 방지.
      const markTurnCardDone = (thread) => {
        const card = cardByThread.get(thread);
        if (card && card.el && !card.el.classList.contains("done")) {
          card.el.classList.add("done");
        }
      };
      // ── 턴 비용 표시 (2026-07-26) ───────────────────────────────────────
      // 실측 동기: codex 148턴 평균 입력 68,629 토큰(최대 257,501), 출력 평균 1,025 —
      // 입력:출력이 300~2000:1 인데 화면엔 아무 흔적이 없었다. codex 는 매 도구 반복마다
      // 누적 입력을 통째로 재전송하는 구조(store:false)라, **캐시가 먹는지**가 실효 비용을
      // 좌우한다. cached_tokens 는 종전에 CODEX_DEBUG_USAGE=1 콘솔로만 나가고 버려졌다.
      // 여기서 "입력 68.6K (캐시 62%) · 출력 1.0K" 로 사후에도 보이게 만든다.
      const fmtTokens = (n) => {
        const v = Number(n) || 0;
        if (v >= 1000000) return (v / 1000000).toFixed(1) + "M";
        if (v >= 1000) return (v / 1000).toFixed(1) + "K";
        return String(v);
      };
      const setTurnCost = (thread, payload) => {
        const card = cardByThread.get(thread);
        // 스텝 카드 헤더 우선, 없으면(도구 0 = 텍스트만 답한 턴) 답변 버블 헤더.
        const target = card && (card.costEl || card.replyCostEl);
        if (!target) return;
        const inTok = Number(payload && payload.inputTokens);
        if (!Number.isFinite(inTok) || inTok <= 0) return; // 미보고 어댑터 = 표시 안 함(거짓값 금지).
        const outTok = Number(payload && payload.outputTokens) || 0;
        // ★도구 루프가 여러 번 돈 턴은 **합계**가 진짜 비용이다(codex 는 매 iteration
        //  전체 입력을 재전송). 합계가 오면 그걸 쓰고, 없으면(1회 턴·다른 어댑터) 단일값.
        const iters = Number(payload && payload.iterations);
        const inTotal = Number(payload && payload.inputTokensTotal);
        const useTotal = Number.isFinite(iters) && iters > 1 && Number.isFinite(inTotal) && inTotal > 0;
        const shownIn = useTotal ? inTotal : inTok;
        const cached = useTotal
          ? Number(payload && payload.cachedTokensTotal)
          : Number(payload && payload.cachedTokens);
        const parts = ["↓" + fmtTokens(shownIn)];
        if (useTotal) parts.push(iters + "회");   // 몇 번 재전송했나 = 낭비의 직접 신호.
        // 캐시 적중률 — 재전송분 중 캐시로 처리된 몫. 낮으면 루프가 비싸다는 신호.
        if (Number.isFinite(cached) && cached > 0) {
          parts.push("캐시 " + Math.round((cached / shownIn) * 100) + "%");
        }
        parts.push("↑" + fmtTokens(outTok));
        target.textContent = parts.join(" · ");
        const exact = (useTotal
            ? "도구 루프 " + iters + "회 · 입력 합계 " + shownIn.toLocaleString() + " 토큰(마지막 회 "
              + inTok.toLocaleString() + ")"
            : "입력 " + shownIn.toLocaleString() + " 토큰")
          + (Number.isFinite(cached) && cached > 0
              ? " (캐시 적중 " + cached.toLocaleString() + " — 실효 " + (shownIn - cached).toLocaleString() + ")"
              : "")
          + " / 출력 " + outTok.toLocaleString() + " 토큰";
        target.title = exact;
        // 입력이 유난히 큰 턴은 눈에 띄게(임계는 관측 평균의 ~3배 — 확실히 이상한 것만).
        if (shownIn >= 200000) target.classList.add("heavy");
      };

      const completeTurnGroup = (thread) => {
        const card = cardByThread.get(thread);
        if (!card || !vtIndex.has(card.group) || card.closed) return null;
        card.closed = true;
        // 경과시간 최종 고정(진행 틱은 closed 로 멈춤 — 마지막 1초 오차 없이 정확값으로).
        if (card.elapsedEl && typeof fmtElapsed === "function") {
          card.elapsedEl.textContent = fmtElapsed(Date.now() - (card.startTs || Date.now()));
        }
        // delta-only 경량 그룹(스텝 카드 없음)은 접을 카드가 없다 — 그룹만 반환.
        if (!card.el) return card.group;
        card.countEl.textContent = card.count + "단계 완료";
        card.el.classList.add("done");
        // ★진행중/최신 턴은 펼친 채 유지(사용자 요청 2026-07-10) — 완료돼도 자동접힘 안 함.
        // 직전 턴 정리는 새 턴 시작 시 renderActivity 가 접는다(최신만 펼침 → 클러터 방지).
        return card.group;
      };

