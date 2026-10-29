      // prompt.options 선택 상태 영속 — prompt.options 는 EventBus(SSE) 전용이라 영속 안 됨.
      // 재시작/리로드 시 SSE replay 로 버튼이 새로(미선택) 다시 그려진다. 사용자가 이미 고른
      // 질문이 미선택으로 보이는 것을 막기 위해, 클릭값을 안정 키로 localStorage 에 저장하고
      // 렌더 시 복원한다(이 브라우저). 키 = 이벤트 ts + 질문(replay 시 동일값이라 안정).
      const PO_KEY_CAP = 300;
      const poLoad = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
      const poSave = (k, v) => {
        try {
          localStorage.setItem(k, v);
          const keys = [];
          for (let i = 0; i < localStorage.length; i++) { const kk = localStorage.key(i); if (kk && kk.indexOf("po:") === 0) keys.push(kk); }
          if (keys.length > PO_KEY_CAP) { keys.sort(); for (let i = 0; i < keys.length - PO_KEY_CAP; i++) localStorage.removeItem(keys[i]); }
        } catch {}
      };
      const poRemove = (k) => { try { localStorage.removeItem(k); } catch {} };
      // ★선택지 카드 되살림 — 상관 id → 그 카드를 다시 고를 수 있게 하는 함수 (2026-10-28 A2, 설계 `2026-10-28-prompt-choice-release-followup.md` §4).
      //  서버가 «시작 전 취소» 를 확정해야만(✕ 응답 `cancelled`) 부른다 — 누르는 순간엔 안 연다(이미 시작했을 수 있다).
      //  ★수명은 POST 가 아니라 **큐 항목**이다: 504(받았고 아직 처리 중)로 POST 가 끝나도 항목은 큐에 살아 있다. 그래서 결과가 확정될 때
      //   (닫힘·취소·되돌림·504 아닌 수락)와 시작 신호(그 상관 id 의 승격 echo · ✕ already-started) 때만 지운다. 상한 50 — 삽입 순서로 오래된 것부터.
      const PROMPT_REOPENER_CAP = 50;
      const promptCardReopeners = new Map();
      const registerPromptCardReopener = (cid, fn) => {
        promptCardReopeners.delete(cid);
        promptCardReopeners.set(cid, fn);
        while (promptCardReopeners.size > PROMPT_REOPENER_CAP) promptCardReopeners.delete(promptCardReopeners.keys().next().value);
      };
      const forgetPromptCardReopener = (cid) => { if (cid) promptCardReopeners.delete(cid); };
      const reopenPromptCard = (cid) => {
        const fn = cid ? promptCardReopeners.get(cid) : undefined;
        if (!fn) return;
        promptCardReopeners.delete(cid);
        fn();
      };
      const buildPromptOptions = (payload, ts, rawTs) => {
        const options = Array.isArray(payload.options) ? payload.options : [];
        // ★조용히 삼키지 않는다 (2026-07-28). 여기서 그냥 return 하면 "선택지를 띄웠습니다"
        //  라는 답변만 남고 화면엔 아무것도 안 뜬다 — 사용자는 무엇이 잘못됐는지 알 길이
        //  없고(실제 신고: 같은 요청 3회 반복), 진단할 흔적도 안 남는다. 이벤트는 왔는데
        //  못 그린 경우이므로 원인은 페이로드에 있다 = 그 페이로드를 남긴다.
        if (options.length === 0) {
          console.warn(
            "[prompt-options] 선택지 0건 — 렌더 생략. 도구는 호출됐지만 보기가 비었다:",
            payload,
          );
          return;
        }
        const logEmpty = document.getElementById("log-empty");
        if (logEmpty && firstEvent) { logEmpty.remove(); firstEvent = false; }
        localChatCount += 1;
        refreshChatEmpty();
        if (currentView === "overview") setTimeout(showOverview, 0);
        const div = document.createElement("div");
        div.className = "ev local prompt-options";
        div.dataset.type = "prompt.options";
        if (rawTs != null) div.dataset.ts = String(rawTs); // 공통 관측 시각 그대로 — live 답글 원문 이동.
        const head = document.createElement("div");
        const tsEl = document.createElement("span");
        tsEl.className = "ts"; tsEl.textContent = ts;
        const tyEl = document.createElement("span");
        tyEl.className = "type"; tyEl.textContent = i18n("opts.head", { name: assistantName });
        head.appendChild(tsEl); head.appendChild(tyEl);
        div.appendChild(head);
        if (payload.question) {
          const q = document.createElement("div");
          q.className = "chat-message"; q.textContent = String(payload.question);
          div.appendChild(q);
        }
        if (payload.note) {
          const n = document.createElement("div");
          n.className = "prompt-note"; n.textContent = String(payload.note);
          div.appendChild(n);
        }
        const btnWrap = document.createElement("div");
        btnWrap.className = "prompt-buttons";
        const poKey = "po:" + (rawTs != null ? rawTs : ts) + "|" + String(payload.question || "");
        let chosen = false;
        // ★"기타(직접 입력)" 인라인 행 — 항상 포함. 옵션 값처럼 자유입력도 다음 메시지로 답이 됨.
        //  applyPick 이 참조하므로 먼저 생성(행 자체는 버튼 아래에 append).
        const otherRow = document.createElement("div");
        otherRow.className = "prompt-other-row";
        // ★여러 줄 답을 쓸 수 있게 textarea 다(2026-10-10 정태님: 한 줄 input 이라 Shift+Enter 줄바꿈이 안 되고 바로 보내졌다).
        const otherInput = document.createElement("textarea");
        otherInput.rows = 1;
        otherInput.className = "prompt-other-input";
        otherInput.placeholder = i18n("opts.other");
        const otherSend = document.createElement("button");
        otherSend.type = "button";
        otherSend.className = "prompt-other-send";
        otherSend.textContent = i18n("opts.send");
        otherRow.appendChild(otherInput); otherRow.appendChild(otherSend);
        const applyPick = (value) => {
          if (chosen) return;
          chosen = true;
          // 묶음 전체 비활성 + 선택 버튼 표시(중복 클릭·미선택 오표시 방지).
          let matched = false;
          for (const b of btnWrap.querySelectorAll("button")) {
            b.disabled = true;
            if (b.dataset.optvalue === value) { b.classList.add("picked"); matched = true; }
          }
          // 기타 행도 비활성. 매칭 버튼이 없으면(=자유입력/복원) 그 값을 기타 칸에 표시.
          otherInput.disabled = true; otherSend.disabled = true;
          // 복원(새로고침·이력)은 화면에 붙기 전이라 높이를 못 잰다 — 줄 수만큼 연다(여러 줄 답이 첫 줄만 보이던 것, 릴리스 검토 F3).
          if (!matched) { otherInput.value = value; otherInput.rows = Math.min(6, String(value).split("\n").length); otherRow.classList.add("picked"); }
        };
        // ★서버가 거절·취소한 선택을 «고른 것» 으로 남기지 않는다 (2026-10-28 A2). 종전엔 클릭 즉시 저장·표시하고 결과를 버려,
        //  다른 곳에서 이미 답한 질문(409)도 영구히 «선택됨» 이었다. 낙관 저장은 그대로 두고(큐 대기 중 새로 고침해도 고른 답이 보이게)
        //  결과가 오면 사실대로 고친다.
        const closedKey = poKey + "|closed";
        const closedNote = document.createElement("div");
        closedNote.className = "prompt-note prompt-closed-note";
        // 제출 세대 — 결과는 자기 세대일 때만 반영한다(취소 뒤 다시 고른 답을 늦게 온 첫 응답이 덮지 않게).
        let submitSeq = 0;
        const unpick = () => {
          chosen = false;
          for (const b of btnWrap.querySelectorAll("button")) { b.disabled = false; b.classList.remove("picked"); }
          otherInput.disabled = false; otherSend.disabled = false; otherRow.classList.remove("picked");
        };
        // 닫힌 질문 — 선택 표시는 걷되 **다시 열지 않는다**(같은 질문은 다시 보내도 거절된다). 서버 문구 한 줄.
        const showClosed = (msg) => {
          chosen = true;
          for (const b of btnWrap.querySelectorAll("button")) { b.disabled = true; b.classList.remove("picked"); }
          otherInput.disabled = true; otherSend.disabled = true; otherRow.classList.remove("picked");
          closedNote.textContent = String(msg || "");
          if (!closedNote.parentNode) div.appendChild(closedNote);
        };
        const settle = (seq, cid, r) => {
          if (seq !== submitSeq || !r) return;
          if (r.closed) {
            forgetPromptCardReopener(cid);
            poRemove(poKey);
            poSave(closedKey, String(r.error || ""));
            showClosed(r.error);
            return;
          }
          if (r.cancelled || r.restore === true) {
            forgetPromptCardReopener(cid);
            poRemove(poKey);
            unpick();
            return;
          }
          if (r.stillRunning) return; // 504 — 큐 항목은 살아 있다. 이후 ✕ 가 취소를 확정하면 되살린다.
          forgetPromptCardReopener(cid); // 수락(시작했거나 진행 턴이 받음) — 더는 취소될 수 없다.
        };
        const submit = (v) => {
          applyPick(v);
          poSave(poKey, v); // 선택 영속(리로드 복원용)
          const seq = ++submitSeq;
          let cid = null;
          const sent = submitOptionValue(v, payload.promptId, {
            // 답 큐 — 표시 탭과 다를 때 서버가 실어 준 값(대화 밖 작업의 질문, 2026-10-28 B4). 없으면 종전(이 탭).
            ...(typeof payload.answerThreadKey === "string" && payload.answerThreadKey !== "" ? { queueKey: payload.answerThreadKey } : {}),
            onCorrelation: (c) => {
              cid = c;
              registerPromptCardReopener(c, () => {
                if (seq !== submitSeq) return;
                submitSeq += 1; // 이 제출의 늦은 응답은 더 반영하지 않는다.
                poRemove(poKey);
                unpick();
              });
            },
          });
          Promise.resolve(sent).then((r) => settle(seq, cid, r), () => {});
        };
        const submitOther = () => {
          if (chosen) return;
          const v = otherInput.value.trim();
          if (v === "") { otherInput.focus(); return; }
          submit(v);
        };
        otherSend.addEventListener("click", submitOther);
        // Enter 규칙은 메인 입력창(perf.js)과 같다 — Shift+Enter 줄바꿈 · 한글 조합 중 Enter 는 조합 확정 · 터치 기기는 버튼으로 보낸다.
        otherInput.addEventListener("keydown", (e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !isTouchPrimary()) { e.preventDefault(); submitOther(); }
        });
        // 줄이 늘면 칸도 는다(상한은 CSS max-height — 넘으면 칸 안에서 스크롤).
        otherInput.addEventListener("input", () => {
          otherInput.style.height = "auto";
          otherInput.style.height = otherInput.scrollHeight + "px";
        });
        for (const opt of options) {
          const val = String(opt.value != null ? opt.value : (opt.label || ""));
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "prompt-option-btn";
          btn.dataset.optvalue = val;
          btn.textContent = String(opt.label || opt.value || "");
          btn.addEventListener("click", () => {
            if (chosen) return;
            submit(val); // 질문 id — 다른 채널에서 이미 답했으면 서버가 거절한다(그 사실로 카드를 고친다)
          });
          btnWrap.appendChild(btn);
        }
        div.appendChild(btnWrap);
        div.appendChild(otherRow);  // 기타 입력 행 = 옵션 버튼 아래에 항상.
        // ★재시작/리로드 복원 — 닫힌 질문이면 닫힘(문구 포함), 이미 고른 질문이면 그 버튼(또는 기타 칸)을 picked+비활성으로.
        const closedMsg = poLoad(closedKey);
        if (closedMsg != null) showClosed(closedMsg);
        else {
          const saved = poLoad(poKey);
          if (saved != null) applyPick(saved);
        }
        return div;
      };
      // 라이브 경로 — 빌드해서 스트림에 붙인다(종전 동작 그대로).
      const renderPromptOptions = (payload, ts, evTs) => {
        const div = buildPromptOptions(payload, ts, evTs);
        if (div) vtAppend(div);
      };
      // 이력 복원 경로 — 같은 빌더를 쓴다(문구·버튼·선택상태가 라이브와 갈릴 수 없다).
      registerChatKindBuilder("prompt.options", buildPromptOptions);

