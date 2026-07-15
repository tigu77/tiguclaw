      // ── 파일 첨부(#2) — 붙여넣기/드롭/파일선택 → base64 큐 → 전송 시 함께 POST. ──
      const ATT_MAX = 10, ATT_MAX_BYTES = 10 * 1024 * 1024;
      let pendingAttachments = []; // [{filename, mimeType, dataBase64, bytes}]
      const attachEl = document.getElementById("chat-attach");
      const fileInput = document.getElementById("chat-file");
      const attachBtn = document.getElementById("chat-attach-btn");
      const fmtBytes = (b) =>
        b < 1024 ? b + "B" : b < 1048576 ? Math.round(b / 1024) + "KB" : (b / 1048576).toFixed(1) + "MB";
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
          x.type = "button"; x.className = "att-x"; x.textContent = "✕"; x.title = "제거";
          x.addEventListener("click", () => { pendingAttachments.splice(i, 1); renderAttachChips(); });
          chip.appendChild(x);
          attachEl.appendChild(chip);
        });
      };
      const readAsBase64 = (file) => new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => { const s = String(r.result); const c = s.indexOf(","); resolve(c >= 0 ? s.slice(c + 1) : s); };
        r.onerror = () => reject(r.error || new Error("read failed"));
        r.readAsDataURL(file);
      });
      const addFiles = async (files) => {
        for (const f of files) {
          if (pendingAttachments.length >= ATT_MAX) { showToast(`첨부는 최대 ${ATT_MAX}개까지`, "warn"); break; }
          if (f.size > ATT_MAX_BYTES) { showToast(`'${f.name}' 이(가) 10MB 초과 — 제외`, "warn"); continue; }
          try {
            const dataBase64 = await readAsBase64(f);
            pendingAttachments.push({ filename: f.name || "file", mimeType: f.type || "application/octet-stream", dataBase64, bytes: f.size });
          } catch { showToast(`'${f.name}' 읽기 실패`, "bad"); }
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
        const text = input.value.trim();
        if (text.length === 0 && pendingAttachments.length === 0) return;
        // 큐 스냅샷 후 즉시 비움(전송 중 사용자가 새 첨부 추가 가능 — 다음 메시지로).
        const atts = pendingAttachments;
        pendingAttachments = [];
        renderAttachChips();
        input.value = "";
        growWrap.dataset.replicatedValue = ""; // 전송 후 복제 비워 한 줄 높이로 리셋.
        slashClose(); // 전송 시 슬래시 팝업 닫음(value 비움은 input 이벤트를 안 쏘므로 명시적으로).
        input.focus();
        // 전송 = 최신을 보겠다는 의도 → 현재 스크롤 위치와 무관하게 하단으로 고정하고 이후
        // 응답도 따라가게 한다(stickBottom 재활성). 요구: "메시지 보내면 자동으로 끝까지 스크롤".
        stickBottom = true;
        scrollChatToNewest();
        // 답글 인용 — 특정 메시지에 답글 중이면 그 원문을 replyToText 로 실어 전송 후 칩 비움.
        const replyToText = replyingTo ? replyingTo.text : undefined;
        clearReply();
        // 공용 전송 — "작업 중…" 표시 + 긴 턴 가짜 timeout 방지(답은 SSE). 비차단: 워커
        // 발사 등을 기다리며 입력을 막지 않는다(전송 버튼 상시 활성 — 이어서 말 걸 수 있게).
        await sendChatMessage(text, atts, replyToText);
      });
