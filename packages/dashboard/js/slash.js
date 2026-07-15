      // ── 슬래시 명령 자동완성(/) — 클로드코드 슬래시 메뉴 동형. 입력값이 "/접두사"(맨 앞·공백 전)일
      //    때만 /api/commands 캐시에서 필터해 팝업으로 띄우고 ↑/↓·Enter/Tab·Esc·클릭으로 수락·삽입.
      //    로드/매치 실패 시 팝업만 안 뜨고 채팅은 그대로(회귀 0). ──
      let slashCommands = [];  // [{name, description}] — fetch 실패 시 빈 배열 = 팝업 미표시.
      let slashMatches = [];   // 현재 접두사로 필터된 목록.
      let slashActive = -1;    // 선택 인덱스(-1 = 닫힘).
      const slashPopup = document.getElementById("chat-slash");
      fetch("/api/commands")
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => { if (d && Array.isArray(d.commands)) slashCommands = d.commands.filter((c) => c && c.name); })
        .catch(() => {}); // 실패 = happy path 무손상(팝업만 미표시).
      const slashOpen = () => !!slashPopup && !slashPopup.hidden && slashMatches.length > 0;
      const slashClose = () => {
        slashActive = -1; slashMatches = [];
        if (slashPopup) { slashPopup.hidden = true; slashPopup.innerHTML = ""; }
      };
      const slashRender = () => {
        if (!slashPopup) return;
        slashPopup.innerHTML = "";
        slashMatches.forEach((c, i) => {
          const item = document.createElement("div");
          item.className = "slash-item" + (i === slashActive ? " active" : "");
          const n = document.createElement("span"); n.className = "slash-name"; n.textContent = "/" + c.name;
          item.appendChild(n);
          if (c.description) {
            const d = document.createElement("span"); d.className = "slash-desc"; d.textContent = c.description;
            item.appendChild(d);
          }
          // mousedown(클릭 아님) — textarea blur 전에 수락해서 blur-close 와 경합하지 않게. preventDefault 로 포커스 유지.
          item.addEventListener("mousedown", (e) => { e.preventDefault(); slashAccept(i); });
          item.addEventListener("mousemove", () => { if (slashActive !== i) { slashActive = i; slashRender(); } });
          slashPopup.appendChild(item);
        });
        slashPopup.hidden = false;
      };
      // 입력 전체가 "/접두사"(맨 앞 슬래시 + 공백 없음)일 때만 팝업. 중간 "/" 는 무시.
      const slashSync = () => {
        if (!slashPopup) return;
        const m = input.value.match(/^\/(\w*)$/);
        if (!m || slashCommands.length === 0) { slashClose(); return; }
        const prefix = m[1].toLowerCase();
        slashMatches = slashCommands.filter((c) => String(c.name).toLowerCase().startsWith(prefix));
        if (slashMatches.length === 0) { slashClose(); return; }
        if (slashActive < 0 || slashActive >= slashMatches.length) slashActive = 0;
        slashRender();
      };
      // 수락 = 입력 전체를 "/name " 로 교체(맨 앞 명령) + autogrow 트리거 + 팝업 닫음. 전송하지 않음.
      const slashAccept = (i) => {
        const c = slashMatches[i];
        if (!c) { slashClose(); return; }
        const text = "/" + c.name + " ";
        input.value = text;
        input.focus();
        input.setSelectionRange(text.length, text.length);
        input.dispatchEvent(new Event("input", { bubbles: true })); // autogrow + slashSync(→닫힘, 공백 있음).
        slashClose();
      };
      // 팝업 열림 시 키 가로챔. 처리했으면 true(호출부에서 기존 Enter=전송 스킵). IME 조합 중엔 미개입.
      const slashKeydown = (e) => {
        if (!slashOpen() || e.isComposing) return false;
        if (e.key === "ArrowDown") { e.preventDefault(); slashActive = (slashActive + 1) % slashMatches.length; slashRender(); return true; }
        if (e.key === "ArrowUp") { e.preventDefault(); slashActive = (slashActive - 1 + slashMatches.length) % slashMatches.length; slashRender(); return true; }
        if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); slashAccept(slashActive); return true; }
        if (e.key === "Escape") { e.preventDefault(); slashClose(); return true; }
        return false;
      };
      input.addEventListener("input", slashSync); // 타이핑/백스페이스에 팝업 갱신.
      input.addEventListener("blur", slashClose); // 포커스 이탈 시 닫음(항목 mousedown 은 preventDefault 로 blur 안 남).

      // textarea 자동 높이 — CSS-only(.grow-wrap ::after 복제). 매 키입력마다 height="auto"→
      // scrollHeight 읽기(강제 동기 리플로우, mount된 stream 전체 레이아웃 플러시 = 타이핑 랙)를
      // 없앤다. 핸들러는 복제 텍스트만 갱신 → 레이아웃 읽기 0, 그리드가 텍스트만큼 자란다.
      const growWrap = input.parentElement; // .grow-wrap
