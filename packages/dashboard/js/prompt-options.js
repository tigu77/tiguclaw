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
      const renderPromptOptions = (payload, ts, rawTs) => {
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
        const head = document.createElement("div");
        const tsEl = document.createElement("span");
        tsEl.className = "ts"; tsEl.textContent = ts;
        const tyEl = document.createElement("span");
        tyEl.className = "type"; tyEl.textContent = assistantName + " · 선택";
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
        const otherInput = document.createElement("input");
        otherInput.type = "text";
        otherInput.className = "prompt-other-input";
        otherInput.placeholder = "기타 — 직접 입력…";
        const otherSend = document.createElement("button");
        otherSend.type = "button";
        otherSend.className = "prompt-other-send";
        otherSend.textContent = "보내기";
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
          if (!matched) { otherInput.value = value; otherRow.classList.add("picked"); }
        };
        const submitOther = () => {
          if (chosen) return;
          const v = otherInput.value.trim();
          if (v === "") { otherInput.focus(); return; }
          applyPick(v);
          poSave(poKey, v);
          submitOptionValue(v);
        };
        otherSend.addEventListener("click", submitOther);
        otherInput.addEventListener("keydown", (e) => {
          if (e.key === "Enter") { e.preventDefault(); submitOther(); }
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
            applyPick(val);
            poSave(poKey, val);       // 선택 영속(리로드 복원용)
            submitOptionValue(val);
          });
          btnWrap.appendChild(btn);
        }
        div.appendChild(btnWrap);
        div.appendChild(otherRow);  // 기타 입력 행 = 옵션 버튼 아래에 항상.
        // ★재시작/리로드 복원 — 이미 고른 질문이면 그 버튼(또는 기타 칸)을 picked+비활성으로.
        const saved = poLoad(poKey);
        if (saved != null) applyPick(saved);
        vtAppend(div);
      };

