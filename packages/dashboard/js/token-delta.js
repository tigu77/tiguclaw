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
        card.attemptEnded = false; // 새 내용이 붙었다 = 이 카드는 지금 시도의 것이다(폴백한 어댑터가 같은 카드에 이어 쓸 때).
        ensureReplyBubble(card, ts);
        setTurnModel(card, p.model, metaEffort(thread, p.model)); // 델타에도 model 이 실린다 — 스트리밍 시작 즉시 표시.
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
          card.attemptEnded = false; // 새 내용 = 지금 시도의 카드
          const txt = String(p.text || "");
          if (!card.replyBubble && txt !== "") ensureReplyBubble(card, ts); // 델타 없는 세그먼트 = 버블 신설.
          setTurnModel(card, p.model, metaEffort(thread, p.model));
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
          // ★**기본은 펼침이다** (2026-09-10 정태님). 2026-07-10 부터 새 카드가 시작되면 직전
          //  카드를 자동으로 접었는데(도구 클러터↓), 그건 «접기» 가 답변 버블을 안 건드리던
          //  시절의 균형이었다. 이제 접기가 턴 전체를 줄이므로 자동으로 접으면 **사용자가
          //  안 시킨 숨김**이 된다. 접는 건 사용자가 정한다.
          card = createTurnCard(p, ts, adapter, thread);
          if (continuation && prevCard.sawTextSegment) card.sawTextSegment = true;
          cardByThread.set(thread, card);
          vtAppend(card.group);
        }
        card.attemptEnded = false; // 새 스텝 = 지금 시도의 카드
        setTurnModel(card, p.model, metaEffort(thread, p.model)); // 도구 스텝 — 시작/완료 모두 model 을 싣는다(어댑터 수정 후).
        card.body.appendChild(buildActivityLine(p));
        card.lastSeq = p.seq ?? 0;
        card.count += 1;
        card.countEl.textContent = i18n("tok.stepCount", { n: card.count });
        // 진행 중/접힘 시 헤더 미리보기 — 도구명 + 상세(무슨 파일/명령인지 한눈에).
        {
          const skill = skillStepInfo(p);
          card.lastEl.textContent = skill
            ? i18n("tok.step.skill", { name: skill.name })
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
        if (!card) return;
        // 이 시도는 끝났다 — 뒤에 오는 turn_meta(폴백한 다음 어댑터·답 없이 끝난 턴 뒤의 다음 턴)는 이 카드 것이 아니다.
        //  turn_error 는 카드를 닫지 않아(폴백이 이어질 수 있다), 종전엔 codex 시도 카드가 claude 의 turn_meta 로
        //  «claude · 강도 기본» 라벨을 단 채 남았다 — claude 는 seq 를 새로 시작해 자기 카드를 따로 만든다(적대 검토).
        card.attemptEnded = true;
        if (card.el && !card.el.classList.contains("done")) {
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
      // ★실제 응답 모델 표시 (2026-07-27) — payload.model 은 "요청한 프로파일"이 아니라 **그 스텝에
      //  실제로 답한 모델**이다. 둘은 폴백·쿨다운으로 갈린다(codex 한도 소진 → claude 승계 등).
      //  값이 없으면 아무것도 그리지 않는다(거짓값 금지 — setTurnCost 와 같은 규칙).
      // ★모델 옆 추론 강도 (2026-09-29) — 어댑터가 **실제로 보낸** 값만(turn_done·기록·잡 합계가 싣는다).
      //  실시간 카드·기록 카드·잡 카드가 이 한 모양을 쓴다(두 벌이면 한쪽만 바뀐다). 없으면 모델만.
      /**
       * 모델 옆 강도 — **판단은 여기 한 곳** (2026-09-30 정태님: 채팅·잡 카드가 모델 프로파일 화면과 같은 모양으로).
       * 보낸 강도가 있으면 «강도 high». 어댑터가 «안 보냈다» 를 **명시**했으면(`"default"` = 서버 `REASONING_NOT_SENT` —
       * Claude 는 실행기가 모델별 기본을 보낸다, 실측 opus-5-5 는 medium. 그 값을 알 길이 없어 지어내지 않는다) «강도 기본».
       * ★강도가 **없으면 모름**이다 — 아무것도 안 붙인다. 종전엔 «claude 모델 + 강도 없음» 을 «기본» 으로 읽어, 옛 기록·새로고침 중
       *  진행 턴·모델 미지정 턴까지 «기본» 이라 단언했다(적대 검토 — high 를 보낸 턴도 그렇게 보였다).
       */
      const effortOf = (m, r) => {
        const v = typeof r === "string" ? r.trim() : "";
        if (v === "default") return { text: i18n("models.effort.default"), title: i18n("tok.effort.default") };
        if (v !== "") return { text: i18n("models.effort.badge", { v }), title: i18n("tok.effort.title") };
        return null;
      };
      /** 같은 판단의 글자 모양 — 바뀌었나 비교하는 키·툴팁 등 글자만 필요한 자리. */
      const modelWithEffort = (m, r) => {
        const e = effortOf(m, r);
        return e === null ? m : m + " · " + e.text;
      };
      /** 모델 이름 + 프로파일 화면과 **같은 배지**(`model-spec-reasoning`) — 채팅 카드·답변 버블·잡 카드·기록이 같이 쓴다. */
      const renderModelLabel = (el, m, r) => {
        if (!el) return;
        el.textContent = m;
        const e = effortOf(m, r);
        if (e === null) return;
        const b = document.createElement("span");
        b.className = "model-spec-reasoning";
        b.textContent = e.text;
        b.title = e.title;
        el.appendChild(b);
      };
      const setTurnModel = (card, model, reasoning) => {
        const m = typeof model === "string" ? model.trim() : "";
        if (!card || m === "") return;
        // 강도는 turn_done 에만 실린다 — 활동 이벤트(모델만)가 이미 붙은 강도를 지우지 않게, 같은 모델이면 이어 받는다.
        const r = typeof reasoning === "string" && reasoning.trim() !== ""
          ? reasoning.trim()
          : card.modelSeen === m ? card.reasoningSeen : undefined;
        const label = modelWithEffort(m, r);
        if (card.labelSeen === label) return;
        card.modelSeen = m;
        card.reasoningSeen = r;
        card.labelSeen = label;
        const target = card.modelEl || card.replyModelEl; // 카드 헤더 우선, 없으면 답변 버블.
        if (!target) return;
        // ★현재 모델만 표시 (2026-07-27 사용자 지정). 종전엔 턴 도중 모델이 바뀌면 "이전→현재"
        //  로 남겼는데, 폴백 이력까지 화면에 들고 있을 필요는 없다는 판단. 폴백 사실은 turn_error
        //  통지·로그·events 에 이미 남는다. 표시는 "지금 무엇으로 답했나" 하나만.
        renderModelLabel(target, m, r);
        target.title = i18n("tok.model.title");
      };
      /** 턴이 끝났다 — 실제로 보낸 추론 강도를 모델 옆에 붙인다(turn_done 이 싣는다). */
      const setTurnEffort = (thread, payload) => {
        const card = cardByThread.get(thread);
        // ★끝난 시도의 카드엔 붙이지 않는다 — 카드를 안 만드는 조용한 턴(델타·활동 0)의 turn_done 이 앞 턴 카드의 모델·강도를
        //  덮었다(적대 검토 F5). turn_done 은 값을 붙인 **뒤에** 표시를 단다(sse.js) — 그래서 자기 턴의 카드는 받는다.
        if (card && payload && !card.attemptEnded) setTurnModel(card, payload.model, payload.reasoning);
      };
      /**
       * 턴 시작의 «이 모델 · 이 강도»(`llm.turn_meta`) — 카드는 첫 활동 때 생기므로 **스레드별로 들고 있다가** 카드에
       * 모델을 달 때 같이 넘긴다(같은 모델일 때만). 끝의 turn_done 이 최종값이다.
       */
      const turnMetaByThread = new Map();
      const metaEffort = (thread, model) => {
        const x = turnMetaByThread.get(thread);
        return x && typeof model === "string" && x.model === model.trim() ? x.reasoning : undefined;
      };
      const setTurnMeta = (thread, payload) => {
        if (!payload || typeof payload.model !== "string" || payload.model.trim() === "") return;
        turnMetaByThread.delete(thread); // 삽입 순서 = 최근성 — 오래된 것부터 버린다.
        turnMetaByThread.set(thread, { model: payload.model.trim(), reasoning: payload.reasoning });
        if (turnMetaByThread.size > 200) turnMetaByThread.delete(turnMetaByThread.keys().next().value);
        // ★**아직 닫히지 않은 카드**에만 — 새 턴의 카드는 첫 활동 때 생기므로 이 순간 맵에 있는 카드는 대개 **끝난 앞 턴**
        //  것이다. 종전엔 그 카드의 모델·강도를 새 턴 값으로 덮어써, 앞 턴을 gpt-6-sol·high 로 답했는데 다음 턴이 Claude 로
        //  가면 앞 카드가 «claude · 강도 기본» 으로 바뀌었다(적대 검토 — 거짓값).
        const open = cardByThread.get(thread);
        if (open && !open.closed && !open.attemptEnded) setTurnModel(open, payload.model, payload.reasoning);
      };

      /**
       * 토큰 한 줄(`↓입력 · N회 · 캐시 % · ↑출력`)과 정확값 툴팁 — **채팅 턴과 백그라운드 잡이
       * 같이 쓴다**(2026-09-23). 두 벌이면 «캐시 100% 금지» 같은 규칙이 한쪽에서만 지켜진다.
       * `head` 는 툴팁 첫머리(무엇의 합계인가) — 호출자가 정한다.
       */
      const usageSummary = ({ input: shownIn, cached, output, iters, head }) => {
        // ★`shownIn`·`cached` 이름은 회귀 `usage-token-semantics` 가 적중률 식을 떼어 돌릴 때 쓴다.
        const parts = ["↓" + fmtTokens(shownIn)];
        if (iters > 1) parts.push(i18n("tok.iters", { n: iters }));   // 몇 번 재전송했나 = 낭비의 직접 신호.
        // 캐시 적중률 — 재전송분 중 캐시로 처리된 몫. 낮으면 루프가 비싸다는 신호.
        if (Number.isFinite(cached) && cached > 0) {
          // ★«전부» 라고 말하려면 **실제로 전부**여야 한다 (2026-09-08 정태님이 100% 를 보고 물음).
          //  `Math.round` 는 99.5% 를 100% 로 올린다. 그런데 매 턴 최소한 **새 메시지**는
          //  캐시에 없으므로 «캐시 100%» 는 원리적으로 참일 수 없는 문장이다 — 실측으로도
          //  `cached == input` 인 턴은 **0건**이었다(99.5%~ 로 반올림된 턴은 82건).
          //  올림을 막는 게 아니라 **단언을 못 하게** 한다: 전부가 아니면 99 에서 멈춘다.
          const pct =
            cached >= shownIn ? 100 : Math.min(99, Math.round((cached / shownIn) * 100));
          parts.push(i18n("tok.cacheRate", { pct }));
        }
        parts.push("↑" + fmtTokens(output));
        const title =
          head +
          (Number.isFinite(cached) && cached > 0
            ? i18n("tok.exact.cache", {
                cached: cached.toLocaleString(),
                effective: (shownIn - cached).toLocaleString(),
              })
            : "") +
          i18n("tok.exact.out", { out: output.toLocaleString() });
        return { text: parts.join(" · "), title };
      };

      /**
       * 턴 비용 한 줄 — **실시간 카드와 기록 카드가 같이 쓴다** (2026-09-29). 종전엔 실시간(turn_done)에만 있어서
       * 새로고침·다른 기기에선 비용 줄이 통째로 없었다(도입부터). `sp` 는 서버가 고른 `spend`(`turn-spend.ts`).
       * 없거나 입력 0 이면 null(표시 안 함 — 거짓값 금지).
       */
      const costLine = (sp, { lastIn, iterations, missingRequests = 0 } = {}) => {
        const shownIn = Number(sp && sp.input);
        if (!Number.isFinite(shownIn) || shownIn <= 0) return null;
        const iters = Number(sp.requests) || 1;
        // 사용량을 못 받은 전송 시도(Codex 재시도 등)가 있으면 합계는 하한이다 — 잡 카드와 같은
        //  규칙으로 «+» 를 달고 적중률은 말하지 않는다.
        const s = usageSummary({
          input: shownIn,
          cached: missingRequests > 0 ? undefined : Number(sp.cached),
          output: Number(sp.output) || 0,
          iters,
          head: (iters > 1 && !(Number(iterations) > 1)
            ? i18n("tok.exact.requests", { iters, total: shownIn.toLocaleString() })
            : iters > 1
            ? i18n("tok.exact.loop", {
                iters,
                total: shownIn.toLocaleString(),
                last: Number.isFinite(Number(lastIn)) ? Number(lastIn).toLocaleString() : "?",
              })
            : i18n("tok.exact.single", { total: shownIn.toLocaleString() })) +
            (missingRequests > 0
              ? i18n("bg.usage.requestsUnknown", { n: missingRequests }) + i18n("bg.usage.cacheUnknown")
              : ""),
        });
        return { text: s.text + (missingRequests > 0 ? "+" : ""), title: s.title };
      };

      const setTurnCost = (thread, payload) => {
        const card = cardByThread.get(thread);
        if (card && card.attemptEnded) return; // 끝난 시도의 카드 — 조용한 턴의 비용이 앞 턴 카드를 덮지 않게(setTurnEffort 와 같은 판정).
        // 스텝 카드 헤더 우선, 없으면(도구 0 = 텍스트만 답한 턴) 답변 버블 헤더.
        const target = card && (card.costEl || card.replyCostEl);
        if (!target) return;
        // ★턴 실비용은 **서버가 고른 `spend`** 를 읽는다 (2026-09-23) — `turn-spend.ts` 한 곳.
        const line = costLine(payload && payload.spend, {
          lastIn: payload && payload.inputTokens,
          iterations: payload && payload.iterations,
          missingRequests: Number(payload && payload.unreportedRequests) || 0,
        });
        if (line === null) return;
        target.textContent = line.text;
        target.title = line.title;
      };

      /**
       * ★사용자가 진행 중 턴에 끼어들었다 — **그 자리에서 턴 그룹을 닫는다** (2026-08-12).
       *
       * 사고(사용자 실측, 회사돌쇠): 16:57 에 보낸 메시지 **위에** 17:02 답변이 떴다.
       *  뿌리는 **자리와 시각을 서로 다른 시계가 정한 것**이다 —
       *   · 답변 말풍선의 *자리*: 턴이 시작될 때 만들어진 그룹(≈16:52)이 정한다
       *     (`renderChannelMessage` 의 out 경로가 `completeTurnGroup` 그룹에 append).
       *   · 그 말풍선의 *표시 시각*: 답변이 나온 때(17:02)로 찍힌다.
       *  그 사이(작업 중)에 온 사용자 메시지는 스트림 맨 아래로 가므로, 구조적으로
       *  **끼어든 메시지는 답변보다 위에 올 수 없었다.** 새로고침하면 정상으로 보이는 게
       *  증거다 — 이력은 `ts` 로 정렬하니까(기록은 멀쩡, 라이브 렌더만 어긋남).
       *
       * 그래서 끼어든 순간 그룹을 닫아, **이후 출력이 새 그룹**(=그 메시지 아래)으로 가게 한다.
       * 진행 중 평문 버블은 버린다 — 부분 텍스트라 권위가 없고(최종 out 이 전체본을 가져온다),
       * 남겨두면 끼어든 메시지 위에 조각이 남아 같은 말이 두 번 보인다.
       */
      const interruptOpenTurn = (thread) => {
        const card = cardByThread.get(thread);
        if (!card || !vtIndex.has(card.group) || card.closed) return false;
        if (card.replyBubble && card.replyBubble.parentNode) {
          card.replyBubble.parentNode.removeChild(card.replyBubble);
        }
        card.replyBubble = null; card.replyMsg = null; card.replyRaw = "";
        card.closed = true;      // 이후 델타·활동 = 새 그룹(끼어든 메시지 아래).
        card.interrupted = true; // 최종 out 이 이 옛 그룹으로 되돌아오지 않게(렌더 분기).
        scheduleRelayout();
        return true;
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
        card.countEl.textContent = i18n("tok.stepCountDone", { n: card.count });
        card.el.classList.add("done");
        // ★진행중/최신 턴은 펼친 채 유지(사용자 요청 2026-07-10) — 완료돼도 자동접힘 안 함.
        // 직전 턴 정리는 새 턴 시작 시 renderActivity 가 접는다(최신만 펼침 → 클러터 방지).
        return card.group;
      };

