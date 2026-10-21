      // ── Edit·Write 카드의 «지금 파일에서 보기»(2026-10-21 — 설계 docs/decisions/2026-10-21-edit-card-full-file-view-design.md v2) ──
      // 카드(⤢)를 누르면 위에 **기존 조각 카드 그대로**, 아래에 **지금 디스크의 그 파일**(GET /api/file-view — 누를 때만 읽는다, 저장 없음).
      // ★지금 파일은 «수정 직후의 파일» 이 아니다 — 그렇게 부르지 않는다. 강조는 조각의 수정 후 내용이 지금 파일에 **정확히 한 곳**
      //  있을 때만(`locateEdit`). 확신할 수 없으면 칠하지 않고 이유를 말한다 — 추정 범위를 칠하지 않는다(아스트라 10-21).

      /** 관측 빌더의 줄당 컷(`_activity-diff.ts LINE_MAX`) — 이 길이에 «…» 로 끝나면 잘린 줄이다(잘려도 `truncated` 는 안 붙는다). */
      const FV_CLIP_LEN = 400;

      /**
       * 조각의 수정 후 내용이 지금 파일의 어디인가 — `{ fromLine, toLine }`(1부터, 양끝 포함) 또는 `{ reason }`(로캘 키). 순수 함수.
       *  ★Edit·Write 를 가르지 않는다 — 같은 규칙 하나(diff 에 도구 종류가 없다). Write 조각이 파일 전체와 같으면 자연히 전체다.
       *  ★줄이 아니라 **문자열**로 찾는다 — 줄 중간 수정(`foo→bar`)은 조각에 줄 전체가 없다.
       *  ★겹치는 출현도 센다 — 첫 일치 **+1** 부터 다시 찾는다(`aaa` 안의 `aa` 는 두 곳이다).
       */
      const locateEdit = (content, diff) => {
        if (!diff || !Array.isArray(diff.lines)) return { reason: "fv.reason.notFound" };
        if (diff.truncated === true) return { reason: "fv.reason.truncated" };
        if (diff.lines.some((l) => typeof l.text === "string" && l.text.length === FV_CLIP_LEN && l.text.endsWith("…"))) {
          return { reason: "fv.reason.truncated" };
        }
        const text = diff.lines.filter((l) => l.op !== "-").map((l) => (typeof l.text === "string" ? l.text : "")).join("\n");
        if (text === "") return { reason: "fv.reason.onlyRemoved" };
        const at = content.indexOf(text);
        if (at < 0) return { reason: "fv.reason.notFound" };
        if (content.indexOf(text, at + 1) >= 0) return { reason: "fv.reason.many" };
        let fromLine = 1;
        for (let i = 0; i < at; i += 1) if (content.charCodeAt(i) === 10) fromLine += 1;
        let span = 0;
        for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) span += 1;
        return { fromLine, toLine: fromLine + span };
      };

      /** 열 수 있는 절대 경로 — 관측이 푼 `absPath`, 없으면(옛 카드) `path` 가 절대일 때만. 지어내지 않는다. */
      const fileViewPathOf = (diff) => {
        if (diff && typeof diff.absPath === "string" && diff.absPath !== "") return diff.absPath;
        const p = diff && typeof diff.path === "string" ? diff.path : "";
        return p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p) ? p : null;
      };

      let fvGen = 0;
      let fvRoot = null;

      const closeFileView = () => {
        fvGen += 1; // 닫은 뒤 도착한 응답은 버린다
        if (fvRoot !== null) { fvRoot.remove(); fvRoot = null; }
        document.removeEventListener("keydown", fvOnKey, true);
      };
      const fvOnKey = (e) => {
        if (e.key === "Escape") { e.stopPropagation(); closeFileView(); }
      };

      /** 지금 파일을 앞·강조·뒤 세 조각으로 — 줄마다 노드를 만들지 않는다(2MB 파일도 노드 몇 개). */
      const renderFileBody = (wrap, content, hit) => {
        const lines = content.split("\n");
        if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop(); // 끝 개행이 빈 줄을 만들지 않게
        const gutter = document.createElement("pre");
        gutter.className = "fv-gutter";
        gutter.setAttribute("aria-hidden", "true");
        gutter.textContent = lines.map((_, i) => String(i + 1)).join("\n");
        const code = document.createElement("pre");
        code.className = "fv-code";
        let mark = null;
        if (hit && typeof hit.fromLine === "number") {
          const before = lines.slice(0, hit.fromLine - 1).join("\n");
          const mid = lines.slice(hit.fromLine - 1, hit.toLine).join("\n");
          const after = lines.slice(hit.toLine).join("\n");
          if (before !== "" || hit.fromLine > 1) code.appendChild(document.createTextNode(before + "\n"));
          mark = document.createElement("mark");
          mark.className = "fv-hit";
          mark.textContent = mid;
          code.appendChild(mark);
          if (hit.toLine < lines.length) code.appendChild(document.createTextNode("\n" + after));
        } else {
          code.textContent = lines.join("\n");
        }
        wrap.append(gutter, code);
        return mark;
      };

      const openFileView = (diff) => {
        closeFileView();
        const gen = ++fvGen;
        const target = fileViewPathOf(diff);
        const root = document.createElement("div");
        root.className = "fv-back";
        root.setAttribute("role", "dialog");
        root.setAttribute("aria-modal", "true");
        root.addEventListener("click", (e) => { if (e.target === root) closeFileView(); });
        const box = document.createElement("div");
        box.className = "fv-box";
        const head = document.createElement("div");
        head.className = "fv-head";
        const title = document.createElement("span");
        title.className = "fv-title";
        title.textContent = (diff && (diff.path || diff.absPath)) || "";
        const jump = document.createElement("button");
        jump.type = "button";
        jump.className = "fv-jump";
        jump.textContent = i18n("fv.jump");
        jump.hidden = true;
        const close = document.createElement("button");
        close.type = "button";
        close.className = "fv-close";
        close.textContent = "✕";
        close.setAttribute("aria-label", i18n("common.close"));
        close.addEventListener("click", closeFileView);
        head.append(title, jump, close);
        // 위 = 기존 조각 카드 그대로(같은 함수 — 카드와 갈리지 않게). 본문은 펼친 채로.
        const frag = document.createElement("div");
        frag.className = "fv-frag";
        if (diff && typeof buildDiffBlock === "function") frag.appendChild(buildDiffBlock(diff, { inFileView: true }));
        const note = document.createElement("div");
        note.className = "fv-note";
        const file = document.createElement("div");
        file.className = "fv-file";
        box.append(head, frag, note, file);
        root.appendChild(box);
        document.body.appendChild(root);
        fvRoot = root;
        document.addEventListener("keydown", fvOnKey, true);
        // 지금 파일을 못 보여 줄 때 — 이유를 말하고 빈 파일 칸은 접는다(조각은 위에 그대로 있다).
        const unavailable = (reason) => {
          note.textContent = i18n("fv.unavailable", { reason });
          file.hidden = true;
        };
        if (target === null) {
          unavailable(i18n("fv.noPath"));
          return Promise.resolve();
        }
        note.textContent = i18n("fv.loading");
        return fetch("/api/file-view?path=" + encodeURIComponent(target))
          .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
          .then(({ ok, d }) => {
            if (gen !== fvGen) return; // 닫았거나 다른 카드를 열었다
            if (!ok || !d || typeof d.content !== "string") {
              unavailable((d && d.error) || i18n("fv.failed"));
              return;
            }
            const where = locateEdit(d.content, diff);
            const hit = typeof where.fromLine === "number" ? where : null;
            note.textContent = i18n("fv.current") + " · " + (hit
              ? i18n("fv.hit", { from: hit.fromLine, to: hit.toLine })
              : i18n(where.reason));
            const mark = renderFileBody(file, d.content, hit);
            if (mark !== null) {
              // ★세로로만 옮긴다 — `scrollIntoView` 는 가로도 맞춰, 강조 줄이 화면보다 길면 줄번호 칸이 왼쪽 밖으로 밀렸다(헤드리스 390폭 실측).
              const go = () => {
                const fr = file.getBoundingClientRect();
                const mr = mark.getBoundingClientRect();
                file.scrollTop += mr.top - fr.top - fr.height / 2;
              };
              jump.hidden = false;
              jump.addEventListener("click", go);
              go();
            }
          })
          .catch(() => {
            if (gen === fvGen) unavailable(i18n("fv.failed"));
          });
      };
      window.openFileView = openFileView;
