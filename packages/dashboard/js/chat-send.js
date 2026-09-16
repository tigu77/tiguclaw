      // ── 파일 첨부(#2) — 붙여넣기/드롭/파일선택 → base64 큐 → 전송 시 함께 POST. ──
      /**
       * **상한은 서버가 준다 — 여기에 숫자를 적지 않는다** (2026-09-15 정태님 신고).
       *
       * ★종전엔 개수 10개·파일당 10MiB 가 이 줄에 상수로 박혀 있었다. 서버 상한을
       *  20MB 로 올렸을 때 이 줄이 안 따라와, 화면이 10MB 초과를 **보내기도 전에** 거절했다.
       *  같은 계약이 네 곳(서버·텔레그램·여기·문구)에 살면 두 곳만 올라가는 일이 생긴다.
       * ★못 받으면 `null` 로 남긴다 = **미리 막지 않는다.** 그 경우 초과분은 올라가서
       *  서버가 거절하고, 그 문장이 채팅에 그대로 뜬다(`sendChatMessage` 의 `!r.ok` 경로).
       *  느리지만 **정직하다** — 모를 때 막는 것이 이번 사고의 형상이었다.
       */
      let attachLimits = null;
      let attachLimitsInFlight = null;
      /**
       * 상한을 **모르면 다시 묻는다** (2026-09-15 아스트라 지적).
       *
       * ★종전엔 부팅 때 한 번만 물었다. 그때 브리지가 잠깐 안 떠 있었으면 `attachLimits` 가
       *  **페이지가 살아 있는 내내 `null`** 로 남아, 화면이 영영 미리 안내를 못 했다.
       * ★동시 중복 요청은 안 만든다 — 진행 중이면 그 약속을 같이 기다린다.
       * ★그래도 **못 받으면 미리 막지 않는다**(서버가 판정한다). 재조회는 안내를 되살리는
       *  것이지 차단을 되살리는 게 아니다.
       */
      const ensureAttachLimits = () => {
        if (attachLimits) return Promise.resolve(attachLimits);
        if (!attachLimitsInFlight) {
          attachLimitsInFlight = fetch("/api/health")
            .then((r) => r.json())
            .then((h) => { attachLimits = attachLimitsFrom(h); return attachLimits; })
            .catch(() => null)
            .finally(() => { attachLimitsInFlight = null; });
        }
        return attachLimitsInFlight;
      };
      void ensureAttachLimits();
      let pendingAttachments = []; // [{filename, mimeType, dataBase64, bytes}]
      const attachEl = document.getElementById("chat-attach");
      const fileInput = document.getElementById("chat-file");
      const attachBtn = document.getElementById("chat-attach-btn");
      // fmtBytes 는 util.js 로 옮겼다 — history-render.js 가 더 먼저 로드돼 쓴다(2026-07-31).
      // 컴포저 버튼이 «전송/정지» 중 무엇인지 정하려면 **지금 칠 말이 있나**를 알아야 하는데,
      // 그 사실은 여기(입력창·첨부 큐)만 안다. 사본을 만들지 않고 getter 를 내준다 —
      // 판정 자체는 axis1-options.js 의 `composerAction` 한 곳에 있다.
      window.composerHasDraft = () => input.value.trim() !== "" || pendingAttachments.length > 0;
      const repaintComposer = () => { if (typeof window.refreshComposerButton === "function") window.refreshComposerButton(); };
      input.addEventListener("input", repaintComposer);

      const renderAttachChips = () => {
        attachEl.innerHTML = "";
        pendingAttachments.forEach((a, i) => {
          const isImg = (a.mimeType || "").startsWith("image/");
          const chip = document.createElement("div");
          chip.className = "att-chip" + (isImg ? " att-img" : " att-file");
          chip.title = a.filename + " · " + fmtBytes(a.bytes);
          if (isImg) {
            // 이미지 = 실제 썸네일 미리보기(base64 data URI).
            const img = document.createElement("img");
            img.className = "att-thumb";
            img.src = "data:" + a.mimeType + ";base64," + a.dataBase64;
            img.alt = a.filename;
            chip.appendChild(img);
          } else {
            // 그 외 = 확장자 라벨 + 파일명 카드.
            const ic = document.createElement("div"); ic.className = "att-fileicon";
            ic.textContent = ((a.filename.split(".").pop() || "FILE").slice(0, 4)).toUpperCase();
            const nm = document.createElement("div"); nm.className = "att-fname"; nm.textContent = a.filename;
            chip.appendChild(ic); chip.appendChild(nm);
          }
          const x = document.createElement("button");
          x.type = "button"; x.className = "att-x"; x.textContent = "✕"; x.title = i18n("common.remove");
          x.addEventListener("click", () => { pendingAttachments.splice(i, 1); renderAttachChips(); });
          chip.appendChild(x);
          attachEl.appendChild(chip);
        });
        repaintComposer(); // 첨부만 있어도 «칠 말이 있다» — 그럼 이 버튼은 전송이다.
      };
      const readAsBase64 = (file) => new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => { const s = String(r.result); const c = s.indexOf(","); resolve(c >= 0 ? s.slice(c + 1) : s); };
        r.onerror = () => reject(r.error || new Error("read failed"));
        r.readAsDataURL(file);
      });
      const addFiles = async (files) => {
        await ensureAttachLimits(); // 모르면 여기서 한 번 더 묻는다(부팅 때 못 받았을 수 있다).
        for (const f of files) {
          const queuedBytes = pendingAttachments.reduce((n, a) => n + (a.bytes || 0), 0);
          const why = attachRejection(pendingAttachments.length, queuedBytes, f.size, attachLimits);
          if (why === "count") { showToast(i18n("chat.attach.max", { n: attachLimits.count }), "warn"); break; }
          if (why === "size") { showToast(i18n("chat.attach.tooBig", { name: f.name, limit: fmtBytes(attachLimits.fileBytes) }), "warn"); continue; }
          if (why === "total") { showToast(i18n("chat.attach.totalTooBig", { name: f.name, limit: fmtBytes(attachLimits.totalBytes) }), "warn"); continue; }
          try {
            const dataBase64 = await readAsBase64(f);
            pendingAttachments.push({ filename: f.name || "file", mimeType: f.type || "application/octet-stream", dataBase64, bytes: f.size });
          } catch { showToast(i18n("chat.attach.readFailed", { name: f.name }), "bad"); }
        }
        renderAttachChips();
      };
      attachBtn.addEventListener("click", () => fileInput.click());
      fileInput.addEventListener("change", () => { if (fileInput.files && fileInput.files.length) addFiles([...fileInput.files]); fileInput.value = ""; });
      // 붙여넣기 — 클립보드에 파일(이미지 등)이 있으면 첨부. 텍스트 붙여넣기는 기본 동작 유지.
      input.addEventListener("paste", (e) => {
        const files = e.clipboardData && e.clipboardData.files ? [...e.clipboardData.files] : [];
        if (files.length) { e.preventDefault(); addFiles(files); }
      });
      // 드래그&드롭 — 채팅 패널(#right) 어디든. Files 타입일 때만 가로챈다.
      const dropZone = document.getElementById("right") || document.getElementById("chat");
      const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files");
      const clearDragOver = () => dropZone.classList.remove("drag-over");
      dropZone.addEventListener("dragover", (e) => { if (hasFiles(e)) { e.preventDefault(); dropZone.classList.add("drag-over"); } });
      // ★relatedTarget = 드래그가 *들어가는* 요소. dropZone 밖(또는 null=창 밖)으로 나갈 때만
      // 해제. 기존 `e.target === dropZone` 는 자식 요소 위로 나가면 안 떠서 점선이 stuck 됐다.
      dropZone.addEventListener("dragleave", (e) => {
        if (!e.relatedTarget || !dropZone.contains(e.relatedTarget)) clearDragOver();
      });
      dropZone.addEventListener("drop", (e) => {
        clearDragOver();
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) { e.preventDefault(); addFiles([...e.dataTransfer.files]); }
      });
      // 안전망 — 드래그 취소(Esc)·dropZone 밖 드롭·창 밖 종료 등 dragleave 가 안 오는 경우에도
      // stuck 점선을 확실히 해제(전역 drop/dragend).
      window.addEventListener("drop", clearDragOver);
      window.addEventListener("dragend", clearDragOver);

      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        // ⏹ 정지 — 버튼이 정지 모드면 이 제출은 «진행 중 턴 중단» 이다. 사용자가 `/stop` 을
        // 친 것과 **똑같은 경로**로 보낸다(새 API·새 판단 0). `/stop` 은 아웃오브밴드라
        // 직렬 큐를 안 타고 그 스레드의 턴을 곧장 abort 한다. 실제 종료 반영은 SSE(turn_done)
        // 가 하고, 그때 `paintComposerButton` 이 버튼을 전송으로 되돌린다.
        if (sendBtn && sendBtn.dataset.mode === "stop") {
          sendBtn.dataset.stopping = "1";
          repaintComposer();
          await sendChatMessage("/stop", [], undefined);
          return;
        }
        const text = input.value.trim();
        if (text.length === 0 && pendingAttachments.length === 0) return;
        // ★**보낸 방을 지금 떠 둔다** (2026-09-15, 레드팀 O4). 복원 분기가 `activeThreadKey`
        //  를 «그때» 다시 읽으면, 보내는 사이 탭을 옮겼을 때 **A 의 글이 B 의 입력창에
        //  꽂히고 B 의 draft 로 저장된다** — 그대로 B 에 보낼 수도 있다. 컴포저는 탭이
        //  공유하고 draft 는 스레드별이라 생기는 어긋남이다.
        const sentFrom = activeThreadKey;
        // 큐 스냅샷 후 즉시 비움(전송 중 사용자가 새 첨부 추가 가능 — 다음 메시지로).
        const atts = pendingAttachments;
        pendingAttachments = [];
        renderAttachChips();
        input.value = "";
        growWrap.dataset.replicatedValue = ""; // 전송 후 복제 비워 한 줄 높이로 리셋.
        try { if (window.clearChatDraft) window.clearChatDraft(activeThreadKey); } catch {} // 전송했으니 이 탭 draft 비움.
        try { if (window.histReset) window.histReset(); } catch {} // 전송했으니 히스토리 커서도 밖으로.
        slashClose(); // 전송 시 슬래시 팝업 닫음(value 비움은 input 이벤트를 안 쏘므로 명시적으로).
        focusChatInput();
        // 전송했으면 이번 제안은 수명이 끝났다 — 다음 턴에 새로 온다.
        if (typeof window.clearChatSuggestion === "function") window.clearChatSuggestion();
        // 전송 = 최신을 보겠다는 의도 → 현재 스크롤 위치와 무관하게 하단으로 고정하고 이후
        // 응답도 따라가게 한다(stickBottom 재활성). 요구: "메시지 보내면 자동으로 끝까지 스크롤".
        stickBottom = true;
        scrollChatToNewest();
        // 답글 인용 — 특정 메시지에 답글 중이면 그 원문을 replyToText 로 실어 전송 후 칩 비움.
        const replyToText = replyingTo ? replyingTo.text : undefined;
        clearReply();
        // 공용 전송 — "작업 중…" 표시 + 긴 턴 가짜 timeout 방지(답은 SSE). 비차단: 매니저
        // 발사 등을 기다리며 입력을 막지 않는다(전송 버튼 상시 활성 — 이어서 말 걸 수 있게).
        repaintComposer(); // 입력창을 비웠다 — 턴이 돌기 시작하면 이 버튼이 정지가 된다.
        const sent = await sendChatMessage(text, atts, replyToText);
        // ★**못 보냈으면 첨부를 되돌린다** (2026-09-15 아스트라 지적). 큐를 전송 전에 비우는
        //  건 «전송 중에도 새 첨부를 받으려고» 다(다음 메시지로). 그런데 서버가 거절하면
        //  붙인 파일이 **그냥 사라졌다** — 사용자는 다시 끌어다 놔야 하는 줄도 모른다.
        // ★그 사이 사용자가 새로 붙였을 수 있으므로 **앞에 되돌리고**, 개수 상한은 지킨다
        //  (되돌리다 상한을 넘기면 그게 또 조용한 손실이다).
        // ★판정은 `sendRejectionAction` 한 곳이다 — 여기서 `ok` 를 다시 해석하지 않는다.
        //  «전송 성공이 아니다»(ok:false)와 «서버가 안 받았다»(restore)는 다른 사실이고,
        //  종전엔 그 둘이 한 조건에 묶여 **504(=아직 진행 중)에도 보낸 글이 입력창으로
        //  되돌아왔다**(정태님 신고 2회). 되돌릴지는 `restore` 만 본다.
        if (sent && sent.restore === true) {
          // ★**텍스트도 같이 되돌린다** (2026-09-15 2차 정정, 아스트라 지적). 첫 판은
          //  첨부만 되돌렸다 — 413 을 맞으면 **쓴 글이 그대로 사라졌다.** 되돌릴 것은
          //  «이 전송에 실린 것» 전부다.
          // ★**기다리는 동안 새로 친 글을 덮지 않는다** — 입력창이 비어 있을 때만 되돌리고,
          //  아니면 앞에 이어 붙인다(사용자가 친 것이 더 최신이므로 뒤에 둔다).
          if (atts.length > 0 && sentFrom === activeThreadKey) {
            // ★**자르지 않는다** (2026-09-16 아스트라 P2). 종전엔 `.slice(0, cap)` 이었는데,
            //  되돌릴 것이 상한을 채우면 **기다리는 동안 새로 붙인 파일이 조용히 사라졌다** —
            //  바로 위 주석이 "되돌리다 상한을 넘기면 그게 또 조용한 손실이다" 라고 적어두고
            //  그 손실을 저지르고 있었다. 실패 복원은 **사용자가 넣은 것을 지우지 않는다.**
            // ★넘친 채로 두는 것이 안전한 이유: 칩마다 ×가 있어 지울 수 있고, 다음 전송에서
            //  `attachRejection` 이 막는다. 즉 **보이고 되돌릴 수 있는 상태**다 —
            //  조용히 사라지는 것과는 다르다. 넘쳤으면 그 자리에서 말한다.
            const restored = restoreAttachments(atts, pendingAttachments, attachLimits);
            pendingAttachments = restored.next;
            renderAttachChips();
            if (restored.overCap) {
              showToast(i18n("chat.attach.max", { n: restored.cap }), "warn");
            }
          } else if (atts.length > 0) {
            try { if (window.stashChatDraft) window.stashChatDraft(sentFrom, "", atts); } catch {}
          }
          if (text !== "" && sentFrom === activeThreadKey) {
            const typedSince = input.value;
            input.value = typedSince === "" ? text : `${text}\n${typedSince}`;
            growWrap.dataset.replicatedValue = input.value;
            try { if (window.saveChatDraft) window.saveChatDraft(sentFrom); } catch {}
          } else if (text !== "") {
            // ★방을 옮겼으면 **그 방의 draft 로만** 돌려놓는다 — 지금 보고 있는 방의
            //  입력창은 건드리지 않는다(남의 방에 내 글이 꽂히는 것이 O4 다).
            try { if (window.stashChatDraft) window.stashChatDraft(sentFrom, text); } catch {}
          }
          repaintComposer();
        }
      });

      // ── 세션 탭별 draft(입력 대기 텍스트 + 첨부) 보존 ──────────────────────────
      // 탭 전환 시 떠나는 탭 threadKey 로 현재 입력+첨부를 저장, 들어오는 탭 것을 복원(tabs.js 가
      //   switchToThread/newTab/closeTab 에서 window.* 호출). 텍스트는 localStorage 영속(몇 KB, 새로고침·
      //   재접속 생존), 첨부(base64)는 메모리 Map 만 — 용량이 커 localStorage 쿼터를 깨므로 영속 안 함
      //   (세션 동안만·새로고침 소실). 서버가 준 개수·용량 캡이 이미 바운드.
      const DRAFTS_LS = "tc:drafts";
      const chatDrafts = new Map(); // threadKey -> { text, attachments:[{filename,mimeType,dataBase64,bytes}] }
      try { // 부팅 시 텍스트 draft 복원(첨부는 영속 대상 아님).
        const raw = JSON.parse(localStorage.getItem(DRAFTS_LS) || "{}");
        for (const tk in raw) {
          if (typeof raw[tk] === "string" && raw[tk]) chatDrafts.set(tk, { text: raw[tk], attachments: [] });
        }
      } catch { /* 손상 무시 */ }
      const persistDraftText = () => {
        // 텍스트만 직렬화(첨부 제외 = 쿼터 안전). 빈 draft 는 키 누락.
        try {
          const obj = {};
          for (const [tk, d] of chatDrafts) { if (d.text) obj[tk] = d.text; }
          localStorage.setItem(DRAFTS_LS, JSON.stringify(obj));
        } catch { /* 쿼터/비활성 무시 */ }
      };
      /**
       * **지금 보고 있지 않은 방의 draft 에 되돌려 놓는다** (2026-09-15, 레드팀 O4).
       *
       * ★`saveChatDraft` 는 «현재 입력창» 을 그 방에 저장하는 것이라 여기 못 쓴다 —
       *  그걸 쓰면 지금 보고 있는 방의 글이 남의 방 draft 로 간다.
       * ★기존 draft 가 있으면 **앞에** 이어 붙인다(보낸 것이 먼저 쓰인 글이다).
       */
      window.stashChatDraft = (tk, text, attachments) => {
        if (!tk) return;
        const prev = chatDrafts.get(tk) || { text: "", attachments: [] };
        const merged = {
          text: text ? (prev.text ? `${text}\n${prev.text}` : text) : prev.text,
          attachments: [...(attachments || []), ...prev.attachments],
        };
        if (merged.text.trim() !== "" || merged.attachments.length > 0) {
          chatDrafts.set(tk, merged);
        }
        persistDraftText();
      };

      window.saveChatDraft = (tk) => {
        if (!tk) return;
        const text = input.value;
        if (text.trim() !== "" || pendingAttachments.length > 0) {
          chatDrafts.set(tk, { text, attachments: pendingAttachments.slice() });
        } else {
          chatDrafts.delete(tk);
        }
        persistDraftText();
      };
      // 입력 상태를 복원하는 이 지점이 고스트 제안도 같이 되살린다(탭 전환·새 창).
      window.restoreChatDraft = (tk) => {
        const d = (tk && chatDrafts.get(tk)) || { text: "", attachments: [] };
        input.value = d.text;
        if (growWrap) growWrap.dataset.replicatedValue = d.text; // autogrow 높이 복원.
        pendingAttachments = d.attachments.slice();
        renderAttachChips();
        if (typeof window.refreshChatSuggestion === "function") window.refreshChatSuggestion();
      };
      window.clearChatDraft = (tk) => {
        if (!tk) return;
        chatDrafts.delete(tk);
        persistDraftText();
      };
      // 부팅 복원 — chat-send.js 는 tabs.js 뒤에 로드되므로 loadTabs()가 activeThreadKey 를 이미
      //   세팅한 뒤다. 초기 활성 탭의 저장 draft 를 입력창에 복원(첨부는 영속 안 해 텍스트만).
      try { if (typeof activeThreadKey !== "undefined") window.restoreChatDraft(activeThreadKey); } catch {}
      repaintComposer(); // 부팅 1회 — 새로고침으로 들어와도 첫 그림이 맞다(복원된 진행 중 턴 포함).
