      // ── 과거 대화 이력 렌더(기능 B) ──────────────────────────────────────
      // chat_log 에서 온 과거 메시지를 단순 채팅 버블로 렌더한다. 라이브 경로(renderChannelMessage)
      // 와 달리 스텝 카드·도구 활동·턴 그룹화가 없다(이벤트 미영속 = 설계 한계, 메시지 버블만).
      // 사용자=평문·비서=마크다운(setChatBody) 으로 라이브 버블과 동일 모양.
      // 버블 div 생성만(가상화 삽입은 renderHistoryBatch 가 vtAppend/vtPrependOlder 로 수행).
      const buildHistoryDiv = (entry) => {
        // ★대화 가시 이벤트(선택지·통지) 복원 — **라이브와 같은 빌더**를 레지스트리에서
        //  찾아 쓴다(2026-08-01). 종전엔 이런 것들이 DB 에 없어서 탭 이동에서만 사라졌다.
        //  문구를 여기서 다시 짓지 않는 이유: 같은 문장이 두 곳에서 조립되면 반드시 갈린다.
        //  라이브가 이미 그린 건이면 dedup 키가 막는다(아래 renderedPromptOptionKeys 등과 공유).
        if (typeof entry.kind === "string" && entry.kind !== "") {
          const build = chatKindBuilders.get(entry.kind);
          if (!build) return null; // 모르는 종류는 조용히 건너뛴다(구버전 프런트 안전).
          const okey = `${entry.ts}|${entry.threadKey || ""}`;
          if (renderedPromptOptionKeys.has(okey)) return null;
          renderedPromptOptionKeys.add(okey);
          return build(entry.data || {}, fmtTime(entry.ts), entry.ts) || null;
        }
        const isOut = entry.role === "assistant";
        // 시스템 통지 — 라이브(renderChannelMessage) 파리티. 새로고침해도 구분이 유지돼야
        //  한다(chat_log.notice 컬럼 → /chat-history entries 로 그대로 따라온다).
        const isNotice = isOut && entry.notice === true;
        const div = document.createElement("div");
        div.className = isNotice ? "ev local channel-chat sys-notice" : "ev local channel-chat";
        div.dataset.type = isOut ? "channel.message.out" : "channel.message.in";
        div.dataset.ts = String(entry.ts); // prune 후 oldestLoadedTs 복구용 수치 ts.
        // 복합 커서의 두 번째 축도 같이 심는다 — 프루닝은 DOM 만 보고 커서를 되살리므로
        // id 가 없으면 ts 만 새로 당겨지고 id 는 옛 값에 남아 커서가 조용히 퇴행한다.
        if (typeof entry.id === "number") div.dataset.id = String(entry.id);
        const head = document.createElement("div");
        head.className = "bubble-meta"; // 라이브 답변 버블과 같은 간격(새로고침해도 동일해야 함).
        const tsEl = document.createElement("span");
        tsEl.className = "ts";
        tsEl.textContent = fmtTime(entry.ts);
        const tyEl = document.createElement("span");
        tyEl.className = "type";
        tyEl.textContent = isNotice ? i18n("common.systemNotice") : (isOut ? assistantName : i18n("common.sender.me"));
        head.appendChild(tsEl); head.appendChild(tyEl);
        { const chb = buildChannelBadge(entry.channel); if (chb) head.appendChild(chb); } // 텔레그램 등 원격 채널 경유 표시.
        // 실제 응답 모델 — 라이브 답변 버블(ensureReplyBubble) 파리티. 값 없으면 요소를 만들지
        //  않는다(거짓값 금지 + 사용자 메시지·통지처럼 모델 개념이 없는 행에 빈 배지 방지).
        if (isOut && typeof entry.model === "string" && entry.model.trim() !== "") {
          const mEl = document.createElement("span");
          mEl.className = "turn-model";
          mEl.textContent = entry.model.trim();
          mEl.title = i18n("hist.model.title");
          head.appendChild(mEl);
        }
        div.appendChild(head);
        const msg = document.createElement("div");
        msg.className = "chat-message";
        setChatBody(msg, entry.text, isOut); // 비서=마크다운, 사용자=평문.
        // ★내 입력 원문 보관 — ↑/↓ 히스토리가 읽는다(input-history.js). 표시 DOM 을 긁으면
        //  시각·첨부 칩 같은 주변 텍스트가 섞인다. 표시와 원문은 다른 것이라 원문을 남긴다.
        //  생성 지점이 여기 하나뿐이라(이력·라이브 낙관 버블 모두 이 함수) 한 번만 실으면 된다.
        if (!isOut && typeof entry.text === "string" && entry.text !== "") {
          div.dataset.raw = entry.text;
        }
        // 영속 첨부(rel 메타) → 이력·새로고침에도 이미지/파일 미리보기(서빙 엔드포인트 경유).
        // 아웃바운드(비서 send_file) 이면 받기 버튼·캡션·텍스트 프리뷰 포함(인바운드는 무회귀).
        if (entry.attachments && entry.attachments.length) {
          msg.appendChild(buildAttachmentsPreview(entry.attachments, { download: isOut }));
        }
        div.appendChild(msg);
        return div;
      };

      // 보낸 메시지 버블 안 첨부 미리보기(읽기전용 썸네일/파일칩). 전송 시 클라이언트가 가진 base64 로
      // 즉시 렌더 — 첨부칩과 동일 비주얼, ✕ 제거버튼만 없음. (관측 이벤트·chat_log 엔 첨부가 안 실리므로
      // 새로고침 후 과거 이력엔 안 남는 건 알려진 한계 — 라이브 세션 동안엔 보인다.)
      // 첨부 미리보기 — 두 소스 지원: (1) 전송 직후 낙관적 버블 = 클라 base64(dataBase64/mimeType/
      // filename), (2) 이력/타클라이언트 = 영속 메타(rel/mime/name/kind → /api/attachments/<rel> 서빙).
      // opts.download(아웃바운드=send_file 카드) 이면 칩에 ⬇받기 버튼 + (텍스트류) 인라인 프리뷰 +
      // caption 을 붙인다. 인바운드(유저 업로드)는 opts 없음 = 기존 그대로(무회귀). 이미지는 클릭 확대
      // (원본 새 탭). 텍스트/마크다운/코드는 서빙 파일을 best-effort fetch 해 앞부분 프리뷰(실패=무시).
      const TEXT_PREVIEW_EXTS = ["md","txt","json","csv","js","ts","jsx","tsx","py","sh","bash","html","css","yml","yaml","xml","log","ini","toml","sql"];
      const isTextLike = (mime, name) =>
        /^text\//.test(mime) || mime === "application/json" ||
        TEXT_PREVIEW_EXTS.includes((String(name).split(".").pop() || "").toLowerCase());
      const buildAttachmentsPreview = (attachments, opts) => {
        const download = !!(opts && opts.download);
        const wrap = document.createElement("div");
        wrap.className = "chat-atts";
        attachments.forEach((a) => {
          // ★**위젯 첨부** (2026-08-28, 위젯 플랫폼 증분 1). 플러그인이 그리는 카드다.
          //  여기 한 곳만 고치면 **라이브(`channel-hints.js`)와 복원(아래 `buildHistoryDiv`)이
          //  같이** 간다 — 둘이 이 함수를 공유하기 때문이고, 그게 첨부를 이음매로 고른
          //  이유이기도 하다(저장·복원·가상화·프루닝·검색이 전부 메시지 것을 탄다).
          //  ★비동기다(플러그인 스크립트를 처음 한 번 데려온다). 실패하면 자리만 남고
          //   나머지 첨부·채팅은 그대로다.
          if (a.kind === "widget") {
            const box = document.createElement("div");
            box.className = "chat-widget";
            box.dataset.widget = String(a.widget || "");
            wrap.appendChild(box);
            void widgetHost.mount(box, a);
            return;
          }
          const mime = a.mime || a.mimeType || "";
          const name = a.name || a.filename || "file";
          const isImg = mime.startsWith("image/") || a.kind === "image";
          const src = a.dataBase64
            ? "data:" + mime + ";base64," + a.dataBase64
            : a.rel
              ? "/api/attachments/" + a.rel
              : null;
          // 받기 대상 — 서빙 rel 우선(파일 저장), 없으면 data URI(낙관적 버블).
          const dlHref = a.rel ? "/api/attachments/" + a.rel : src;
          // ★**여는 주소는 표시 주소와 다르다** (2026-08-11 사용자 신고: 방금 보낸 파일을
          //  누르면 빈 화면). `src` 는 *표시*용이라 낙관적 버블에선 `data:` URI 인데,
          //  브라우저는 **`data:` 최상위 이동을 차단**한다 — 새 탭이 그냥 빈 화면이 된다.
          //  서빙 rel 이 있으면 그걸 쓰고, 없으면 base64 를 **blob URL** 로 바꿔 연다
          //  (blob 은 최상위 이동이 허용된다). 둘 다 없으면 열지 않는다(빈 탭 0).
          const openHref = () => {
            const t = attachmentOpenTarget(a); // 판정은 util.js(순수) — 여기선 수행만.
            if (t.kind === "served") return t.url;
            if (t.kind === "none") return null;
            try {
              const bin = atob(a.dataBase64);
              const buf = new Uint8Array(bin.length);
              for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
              return URL.createObjectURL(new Blob([buf], { type: mime || "application/octet-stream" }));
            } catch {
              return null; // 손상된 base64 — 조용히 열기만 포기(표시는 그대로).
            }
          };
          const cell = document.createElement("div");
          cell.className = "att-cell";
          const chip = document.createElement("div");
          chip.className = "att-chip" + (isImg && src ? " att-img" : " att-file");
          chip.title = name + (a.bytes ? " · " + fmtBytes(a.bytes) : "");
          if (isImg && src) {
            const img = document.createElement("img");
            img.className = "att-thumb";
            img.src = src;
            img.alt = name;
            chip.appendChild(img);
          } else {
            const ic = document.createElement("div"); ic.className = "att-fileicon";
            ic.textContent = ((String(name).split(".").pop() || "FILE").slice(0, 4)).toUpperCase();
            const nm = document.createElement("div"); nm.className = "att-fname"; nm.textContent = name;
            chip.appendChild(ic); chip.appendChild(nm);
          }
          // 열기 — 이미지든 문서든 **열 주소가 있으면** 연다. 종전엔 이미지에만 붙어 있어
          //  파일 칩은 눌러도 아무 일이 없었고, 이미지는 위 이유로 빈 화면이었다.
          {
            const href = openHref();
            if (href) {
              chip.dataset.zoom = "1";
              chip.addEventListener("click", () => window.open(href, "_blank", "noopener"));
            }
          }
          // 받기 버튼(다운로드) — 아웃바운드 카드에서만(인바운드 무회귀). download 속성으로 저장.
          if (download && dlHref) {
            const dl = document.createElement("a");
            dl.className = "att-dl";
            dl.href = dlHref;
            dl.setAttribute("download", name);
            dl.title = i18n("hist.receive");
            dl.textContent = "⬇";
            chip.appendChild(dl);
          }
          cell.appendChild(chip);
          // 캡션(send_file caption) — 있으면 칩 아래 설명.
          if (a.caption) {
            const cap = document.createElement("div");
            cap.className = "att-caption";
            cap.textContent = a.caption;
            cell.appendChild(cap);
          }
          // 텍스트류 인라인 프리뷰(아웃바운드·서빙 rel 한정) — best-effort fetch, 실패 시 조용히 제거.
          if (download && a.rel && !isImg && isTextLike(mime, name)) {
            const pre = document.createElement("pre");
            pre.className = "att-textpreview";
            pre.textContent = "…";
            fetch("/api/attachments/" + a.rel)
              .then((r) => (r.ok ? r.text() : Promise.reject(new Error("fetch"))))
              .then((t) => { pre.textContent = t.slice(0, 800) + (t.length > 800 ? "\n…" : ""); })
              .catch(() => { pre.remove(); });
            cell.appendChild(pre);
          }
          wrap.appendChild(cell);
        });
        return wrap;
      };

      // 메시지 유닛 → element(+dedup 키 등록). 이미 렌더됐으면 null(SSE/다른 페이지 중복 방지).
      const buildHistoryMsgEl = (entry) => {
        // ★대화 가시 이벤트(kind)는 **메시지 dedup 키를 쓰지 않는다** (2026-08-01).
        //  msgKey 는 ts|role 이라, 같은 ts 의 비서 답변과 충돌해 한쪽이 조용히 사라진다.
        //  자기 키(ts|threadKey)는 buildHistoryDiv 안에서 건다.
        if (typeof entry.kind === "string" && entry.kind !== "") return buildHistoryDiv(entry);
        const role = entry.role === "assistant" ? "assistant" : "user";
        const key = msgKey(entry.ts, role);
        // ★같은 ms·같은 역할 행이 둘이면 `ts|role` 로는 **한쪽이 조용히 사라진다**
        //  (2026-08-23 3라운드). 복합 커서가 DB 에서 다 가져와도 여기서 버리면 소용없다 —
        //  같은 증상의 두 번째 경로다. 라이브 DB 실측 3,997행 중 3행(0.08%)이 해당한다.
        //  이력 행은 `id` 가 유일하므로 그걸로 가른다. `ts|role` 도 **같이** 등록해
        //  SSE replay 억제는 그대로 둔다(그쪽은 id 를 모른다 — 버스 이벤트라 적재 전이다).
        const rowKey = typeof entry.id === "number" ? key + "|#" + entry.id : null;
        if (rowKey !== null) {
          if (renderedMsgKeys.has(rowKey)) return null;
          renderedMsgKeys.add(rowKey);
          renderedMsgKeys.add(key);
        } else {
          if (renderedMsgKeys.has(key)) return null;
          renderedMsgKeys.add(key);
        }
        // ★**열거하지 않고 통째로 넘긴다** (2026-08-23 3라운드). 여기서 필드를 손으로
        //  옮겨 적다가 **세 번** 빠뜨렸다: notice·model(2026-07-27, 새로고침하면 시스템 통지
        //  구분도 모델 표시도 사라졌다 — 사용자 신고 "안 보이는 애들") 그리고 `id`
        //  (2026-08-23, 복합 커서의 두 번째 축을 DOM 에 심는 코드를 넣어놓고 여기서 걸러져
        //  **한 번도 안 심겼다** — 실측 `[data-ts]` 31개 / `[data-id]` 0개. 프루닝 후 커서
        //  복구가 통째로 무효였다). 바로 위에 "필드를 추가할 때 이 전달 지점을 같이 안
        //  고치면 조용히 사라진다" 고 적어두고도 또 그랬다 — 경고를 적는 것으로는 안 된다.
        //  `buildHistoryDiv` 가 자기가 쓸 것만 골라 읽으므로 남는 필드는 무해하다.
        //  [[feedback_hand_maintained_lists]] 손으로 관리하는 목록 = 드리프트 신호.
        return buildHistoryDiv({ ...entry, role });
      };

      // 이력 도구 스텝(기능 B) — 영속 llm.activity 복원. 낱줄 element 빌더(카드 크롬 없음).
      // 라이브 buildActivityLine 과 동형: diff/출력 리치 블록 + 스텝 단위 클릭 sticky 토글.
      const buildHistStepLine = (a) => {
        const line = document.createElement("div");
        line.className = "hist-step";
        if (a.ts != null) line.dataset.ts = String(a.ts);
        const skill = skillStepInfo(a);
        const icon = document.createElement("span");
        icon.className = "hist-tool-icon"; icon.textContent = skill ? "🛠" : "🔧";
        const label = document.createElement("span");
        label.className = skill ? "hist-tool-label hist-skill" : "hist-tool-label";
        label.textContent = skill ? i18n("common.skillStep", { name: skill.name }) : (a.label || "tool");
        line.appendChild(icon); line.appendChild(label);
        // diff 있는 스텝은 diff 헤더가 경로+N/-M 을 보여주므로 verbose detail 생략(접힘 간결).
        // 스킬 스텝은 detail(=name=…)이 라벨과 중복 → 생략.
        const hasDiff = a.diff && Array.isArray(a.diff.lines);
        if (a.detail && !hasDiff && !skill) {
          const d = document.createElement("span");
          d.className = "hist-tool-detail"; d.textContent = a.detail;
          line.appendChild(d);
        }
        // ★모델·시퀀스 메타 + 배경 스폰 칩 — 라이브(buildActivityLine)와 **같은 판정**으로
        //  붙인다 (2026-08-20 사용자 신고 "누구를 소환했다 정보와 배지가 없어졌다").
        //  종전엔 이 빌더에 둘 다 없어서, 턴이 끝나 이력으로 다시 그려지는 순간 사라졌다 —
        //  위 주석이 "라이브와 동형" 이라고 적어둔 채로. 같은 판단이 두 곳이면 한쪽이 늙는다.
        if (a.model || a.seq != null) {
          const meta = document.createElement("span");
          meta.className = "hist-tool-meta";
          meta.textContent = (a.model ? a.model + " · " : "") + "#" + (a.seq ?? "");
          line.appendChild(meta);
        }
        if (typeof isSpawnStep === "function" && isSpawnStep(a.label, a.jobId)) {
          const bg = document.createElement("span");
          bg.className = "act-bg-link";
          const dot = document.createElement("span");
          dot.className = "act-bg-dot";
          const txt = document.createElement("span");
          txt.textContent = i18n("common.bg.open");
          bg.appendChild(dot); bg.appendChild(txt);
          bg.title = i18n("common.bg.openTitle");
          bg.addEventListener("click", (e) => {
            e.stopPropagation(); // 스텝 펼침·턴 접힘과 분리(라이브 동형).
            if (typeof openBg === "function") openBg();
          });
          line.appendChild(bg);
        }
        if (hasDiff) line.appendChild(buildDiffBlock(a.diff));
        if (a.output && typeof a.output.text === "string") line.appendChild(buildOutputBlock(a.output));
        if (a.plan) line.appendChild(buildPlanBlock(a.plan)); // ExitPlanMode 계획 — 항상 보이게.
        // 클릭 = 스텝 펼침/접힘(리치 블록 있으면). 부모 turn 접힘으로 전파 방지(stopPropagation).
        if (line.querySelector(":scope > .act-diff, :scope > .act-output, :scope > .act-plan")) {
          line.style.cursor = "pointer";
          line.addEventListener("click", (e) => { e.stopPropagation(); line.classList.toggle("expanded"); });
        }
        return line;
      };

      // 이력 turn 묶음 — 연속된 같은 턴의 도구 스텝을 접이식 "N단계" 카드로(라이브 turn-card 파리티).
      // 새로고침 후에도 라이브처럼 그룹핑돼 보이게. 기본 접힘(완료된 라이브 턴의 done-collapsed 동형).
      const buildHistoryTurnEl = (acts) => {
        for (const a of acts) renderedActivityKeys.add(actKey(a.ts, a.threadKey, a.seq));
        const turn = document.createElement("div");
        turn.className = "ev local hist-turn";
        turn.dataset.type = "llm.activity";
        turn.dataset.ts = String(acts[0].ts);
        const head = document.createElement("div");
        head.className = "hist-turn-head";
        const caret = document.createElement("span");
        caret.className = "hist-turn-caret"; caret.textContent = "▸";
        // 어댑터 뱃지(codex/claude 등) — 라이브 turn-card 파리티(이력 카드도 어댑터 표시).
        // 어댑터 없으면(구 데이터) 기존 🔧 아이콘 폴백.
        const adp = acts[0] && acts[0].adapter ? String(acts[0].adapter) : "";
        const badge = document.createElement("span");
        if (adp) { badge.className = "act-badge act-" + (ADAPTERS.includes(adp) ? adp : "other"); badge.textContent = adp; }
        else { badge.className = "hist-turn-icon"; badge.textContent = "🔧"; }
        // 실제 응답 모델 (2026-07-27) — 라이브 turn-card 파리티(새로고침해도 안 사라지게).
        //  한 런 안에서 바뀌었으면(폴백) 첫→마지막으로. 라이브에선 setTurnModel 이 같은 일을 한다.
        const models = acts.map((a) => (typeof a.model === "string" ? a.model.trim() : "")).filter(Boolean);
        const mLast = models[models.length - 1] || "";
        const modelEl = document.createElement("span");
        modelEl.className = "turn-model";
        if (mLast) { // 현재(마지막) 모델만 — 전환 표기 없음.
          modelEl.textContent = mLast;
          modelEl.title = i18n("hist.model.runTitle");
        }
        const count = document.createElement("span");
        count.className = "hist-turn-count"; count.textContent = i18n("tok.stepCount", { n: acts.length });
        const preview = document.createElement("span");
        preview.className = "hist-turn-preview";
        preview.textContent = acts.map((a) => { const s = skillStepInfo(a); return s ? "🛠 " + s.name : (a.label || "tool"); }).slice(0, 6).join(" · ");
        head.appendChild(caret); head.appendChild(badge); head.appendChild(modelEl); head.appendChild(count); head.appendChild(preview);
        const body = document.createElement("div");
        body.className = "hist-turn-body";
        for (const a of acts) body.appendChild(buildHistStepLine(a));
        head.addEventListener("click", () => turn.classList.toggle("expanded"));
        turn.appendChild(head); turn.appendChild(body);
        return turn;
      };

      // 이력 텍스트 세그먼트(인터리브, 2026-07-13) — 항상 보이는 어시스턴트 마크다운 버블(라이브
      // 세그먼트 버블 파리티). 도구 런 카드(hist-turn)와 seq 순으로 교차 배치된다. actKey 등록으로
      // 이후 SSE replay 가 같은 세그먼트를 중복 렌더 안 하게(도구 스텝과 동일 dedup).
      const buildHistoryTextEl = (a) => {
        renderedActivityKeys.add(actKey(a.ts, a.threadKey, a.seq));
        // ★model 을 버블로 전달 (2026-07-27). 이 버블의 출처는 kind:"text" 활동이고 거기엔
        //  실제 응답 모델이 실려 있는데(활동 API 실측 364/364), 종전엔 여기서 떨어뜨려
        //  **새로고침 후 답변 버블에 모델이 하나도 안 보였다**(사용자 신고 "카드들에 제대로
        //  안 되고 있다"). 도구 런 카드에만 넣고 *가장 흔한 답변 버블*을 빠뜨린 누락이다.
        return buildHistoryDiv({
          ts: a.ts, role: "assistant", text: a.text,
          ...(typeof a.model === "string" && a.model.trim() !== "" ? { model: a.model.trim() } : {}),
        });
      };

      // 메시지+활동 → 시간순 병합 후 연속된 같은 턴(threadKey·seq 증가)의 활동을 turn 으로 묶은
      // ASC 유닛 배열. 라이브 turn-card 파리티. 메시지·threadKey 변경·seq 리셋이 경계.
      /**
       * 세그먼트 자리에 그릴 **본문**을 고른다 — 정본(chat_log) 우선, 위치는 세그먼트.
       *
       * events 의 텍스트 세그먼트는 페이로드 상한에 걸려 **잘린 채 저장될 수 있다**
       * (실측 2026-08-08: 12,650자 답변이 301자). chat_log 는 대화 정본이라 무손실이다.
       * 판정: 세그먼트가 정본의 **앞부분**이면(= 잘린 전체 답변) 정본으로 올린다.
       * 한 턴에 세그먼트가 여럿이면(도구와 교차) 뒤쪽 것은 정본의 *뒷부분*이라 안 걸린다
       * — 그래야 앞 세그먼트 내용이 중복되지 않는다.
       *
       * @returns 올릴 본문(문자열) 또는 null(그대로 둔다).
       */
      const canonicalBodyFor = (segText, entryText) => {
        if (typeof entryText !== "string" || entryText === "") return null;
        const segRaw = String(segText || "");
        if (segRaw === "") return null;
        const seg = segRaw.endsWith("…") ? segRaw.slice(0, -1) : segRaw;
        if (seg === "" || entryText.length <= segRaw.length) return null;
        return entryText.startsWith(seg) ? entryText : null;
      };

      const groupMergedItems = (entries, activities) => {
        let lastTextUnit = null; // 마지막 텍스트 세그먼트 유닛(정본 본문으로 올릴 대상).
        const merged = [
          ...entries.map((e) => ({ ts: e.ts, m: e })),
          ...activities.map((a) => ({ ts: a.ts, a })),
        ].sort((x, y) => x.ts - y.ts);
        const units = [];
        let cur = null; // { threadKey, lastSeq, acts } — 연속 도구 런(텍스트 경계에서 끊김).
        let sawTextThread = null; // 직전 텍스트 세그먼트 스레드 → 뒤따르는 flat assistant row dedup.
        const flush = () => { if (cur && cur.acts.length) units.push({ kind: "turn", acts: cur.acts }); cur = null; };
        for (const it of merged) {
          if (it.m) {
            flush();
            // ★대화 가시 이벤트(kind 행: 선택지 등)는 **텍스트의 중복이 아니다** (2026-08-02).
            //  사고: "선택지가 한 번 뜬 뒤 새로고침하면 다시 안 뜬다". 생산(chat_log kind 행)·
            //  저장·읽기·빌더·dedup 이 **전부 있었는데** 여기서 버려졌다 — 아래 가드가
            //  `role==="assistant"` 행을 *텍스트 세그먼트의 중복*으로 보고 드롭하는데,
            //  선택지 행도 assistant 라 같이 걸렸다. 실측: 19:57:33 텍스트 세그먼트 **바로 뒤
            //  같은 초**에 선택지가 온다(모델이 말한 뒤 선택지를 띄우므로 늘 이 순서다).
            //  ★`kind` 행은 2026-08-01 에 생긴 **새 값**인데 그 값을 분기·열거하는 이 자리를
            //   같이 안 봤다. 첨부(`mHasAtt`)가 이미 같은 이유로 예외인데 한 번 더 놓쳤다.
            //  `sawTextThread` 는 건드리지 않는다 — 선택지는 텍스트 세그먼트를 끝내지 않는다.
            if (typeof it.m.kind === "string" && it.m.kind !== "") {
              units.push({ kind: "msg", entry: it.m });
              continue;
            }
            // 인터리브(2026-07-13): 이 턴이 kind:"text" 세그먼트를 가졌으면 뒤의 flat assistant
            // chat_log 행은 세그먼트의 중복 → 드롭(단 msgKey 등록해 SSE out replay 도 재렌더 안 함).
            // ★단 첨부(send_file) 를 실은 assistant 행은 텍스트 세그먼트의 중복이 아니므로 절대 드롭
            // 하지 않는다(아웃바운드 첨부 카드 보존, #2). 순수 텍스트 행만 세그먼트 중복으로 간주.
            const mHasAtt = it.m.attachments && it.m.attachments.length;
            if (it.m.role === "assistant" && !mHasAtt && sawTextThread && it.m.threadKey === sawTextThread) {
              // ★버리기 전에 **본문을 정본으로 올린다** (2026-08-08 사용자 신고).
              //  세그먼트(`llm.activity kind:"text"`)는 events 에 있고 그 테이블엔 페이로드
              //  상한이 있어 **긴 답변이 잘린 채 저장될 수 있다**(실측: 12,650자 답변이 301자).
              //  chat_log 는 대화 **정본**이라 무손실이다. 종전엔 세그먼트를 그리고 정본을
              //  통째로 버려서, 화면이 잘린 사본을 보여주고 **새로고침해도 그대로**였다.
              //  ★역할을 나눈다: 세그먼트는 **위치**(도구와의 인터리브 순서), 정본은 **내용**.
              //  판정은 "세그먼트가 정본의 앞부분인가" — 한 턴에 세그먼트가 여럿이면(도구와
              //  교차) 마지막 것은 정본의 *뒷부분*이라 이 검사에 안 걸린다(중복 방지).
              if (lastTextUnit) {
                const body = canonicalBodyFor(lastTextUnit.act.text, it.m.text);
                if (body !== null) lastTextUnit.act = { ...lastTextUnit.act, text: body };
              }
              renderedMsgKeys.add(msgKey(it.m.ts, "assistant"));
              sawTextThread = null;
              lastTextUnit = null;
              continue;
            }
            sawTextThread = null;
            lastTextUnit = null;
            units.push({ kind: "msg", entry: it.m });
          } else {
            const a = it.a; const seq = typeof a.seq === "number" ? a.seq : 0;
            if (a.kind === "text") {
              flush();                                  // 텍스트 앞의 도구 런 마감(seq 순 교차).
              const tu = { kind: "text", act: a };       // 항상 보이는 마크다운 버블(도구 런과 교차).
              units.push(tu);
              sawTextThread = a.threadKey;
              lastTextUnit = tu;                          // 정본 승격 대상(위 참조).
            } else if (cur && cur.threadKey === a.threadKey && seq > cur.lastSeq) {
              cur.acts.push(a); cur.lastSeq = seq;
            } else {
              flush(); cur = { threadKey: a.threadKey, lastSeq: seq, acts: [a] };
            }
          }
        }
        flush();
        return units;
      };

      // 이력 배치 렌더 — 초기 로드(append=false: vtAppend, ASC)와 페이지네이션(append=true: older
      // 배치를 vtPrependOlder 로 앞에 붙임)이 같은 병합·묶음 로직을 공유. 둘 다 최종 vtItems 는 ASC 유지.
      const renderHistoryBatch = (entries, activities, append) => {
        // 엔드포인트 turn 은 채팅서 제외(방어적 — endpoint 는 chat_log 에 안 남지만 안전).
        const chatEntries = entries.filter((e) => !isEndpointThread(e.threadKey));
        const units = groupMergedItems(chatEntries, activities); // 항상 ASC(최古→최新).
        // 유닛 → element. turn=도구 런 카드, text=마크다운 세그먼트 버블(인터리브), msg=flat 메시지.
        const buildUnit = (u) =>
          u.kind === "turn" ? buildHistoryTurnEl(u.acts)
          : u.kind === "text" ? buildHistoryTextEl(u.act)
          : buildHistoryMsgEl(u.entry);
        // 초기 로드(append=false): 오래된→최신 순으로 vtAppend. 페이지네이션(append=true, older
        // 배치): 노드를 모아 vtPrependOlder 로 앞(위)에 붙인다 — 둘 다 최종 vtItems 는 ASC 유지.
        if (append) {
          const nodes = [];
          for (const u of units) {
            const el = buildUnit(u);
            if (el === null) continue;
            nodes.push(el);
            localChatCount += 1;
          }
          vtPrependOlder(nodes);
        } else {
          for (const u of units) {
            const el = buildUnit(u);
            if (el === null) continue;
            vtAppend(el);
            localChatCount += 1;
          }
        }
      };

      // ── 페이지네이션 상태(기능 2) ────────────────────────────────────────
      // 초기 최근 HISTORY_PAGE + 위(최古)로 스크롤 시 더 로드. 트리거는 가상화 스크롤 리스너가
      // scrollTop < VT_BUFFER(상단 근처)에서 loadOlderHistory() 를 호출(구 IntersectionObserver 센티넬 대체).
      const HISTORY_PAGE = 20;
      let oldestLoadedTs = null; // 현재 로드된 가장 오래된 메시지 ts(다음 beforeTs).
      // ★복합 커서의 두 번째 축 — 같은 ts 가 여럿이면 `ts <` 만으로는 경계 행이 유실된다
      //  (2026-08-23 적대 검토 D-1: 라이브에 동률 그룹 18개, 대부분 질문·답 쌍이라
      //  **질문이 사라지고 답만 남았다**).
      let oldestLoadedId = null;
      // ★두 축을 **함께** 옮긴다. 종전엔 네 곳이 손으로 같은 두 줄을 썼고, 그중 **부팅
      //  초기 로드 한 곳이 id 를 안 세웠다**(2026-08-23 2라운드 D1 실측: 동률 3행 그룹
      //  15개에서 첫 "위로 더보기" 가 그룹을 가르면 형제 1건이 영영 안 왔다 — 44/45).
      //  두 축이 한 곳에서만 움직이면 갈릴 수가 없다. [[feedback_hand_maintained_lists]]
      // ★판단을 **순수 함수**로 뽑는다 (2026-08-24 5라운드). 종전엔 이 안에서 바로
      //  모듈 변수를 대입해서, `id` 를 `null` 로 바꾸는 변이(=2라운드 4점 결함 복원)를
      //  스위트가 못 봤다. "다섯 자리를 한 곳으로 합쳤다" 고 적었지만 **그 한 곳**을
      //  지키는 검사가 없으면 합친 의미가 없다. 이제 회귀가 이 함수를 직접 돌린다.
      const cursorFrom = (entries, fallbackTs) => {
        if (Array.isArray(entries) && entries.length > 0) {
          return {
            ts: entries[0].ts, // 배치 最古(ASC[0]) = 다음 beforeTs.
            id: typeof entries[0].id === "number" ? entries[0].id : null,
          };
        }
        // ts 만 아는 자리에선 두 번째 축을 **비운다**(옛 id 를 남기면
        // `(ts = T AND id < I_old)` 가 항상 거짓 = 조용한 퇴행).
        return { ts: fallbackTs, id: null };
      };
      const setOldestCursor = (entries, fallbackTs) => {
        const c = cursorFrom(entries, fallbackTs);
        oldestLoadedTs = c.ts;
        oldestLoadedId = c.id;
      };
      /**
       * 이력 페이지 URL — **커서 두 축을 여기 한 곳에서만** 싣는다.
       *
       * ★종전엔 "위로 더보기" 와 "점프" 두 곳이 각자 문자열을 이어붙였고, 한쪽에서
       *  `&beforeId=` 를 빼도 회귀 1,620건이 전부 초록이었다(2026-08-23 4R 실측:
       *  헤드리스 52행 중 50행 도달 — 동률 2행 영구 유실). 서버 쪽엔 그물을 걸었는데
       *  **보내는 쪽**은 제품 코드를 한 줄도 안 지나는 검사뿐이었다. 이 사고의 자기
       *  진단("보내는 쪽을 grep 했으면 30초")이 가리킨 자리가 그대로였다.
       *  순수 함수로 뽑으면 브라우저 없이 검사할 수 있다 —
       *  [[feedback_simple_composable_no_duplication]] "검사가 껄끄러우면 코드가 잘못 놓인 것".
       */
      const historyPageQuery = (limit, beforeTs, beforeId) =>
        "/api/chat-history?limit=" + limit +
        (beforeTs !== null && beforeTs !== undefined ? "&beforeTs=" + beforeTs : "") +
        (beforeId !== null && beforeId !== undefined ? "&beforeId=" + beforeId : "");
      window.historyPageQuery = historyPageQuery; // 회귀가 부른다(브라우저 없이 판정).
      let loadingOlder = false; // 동시 로드 가드.
      let reachedOldest = false; // 빈/부분 배치 → 더 없음.

      // 더 로드 — 상단 근처 스크롤이 트리거. 과거 배치(ASC)를 vtPrependOlder 로 앞에 붙인다.
      // vtPrependOlder 가 늘어난 위 높이만큼 scrollTop 을 밀어 보던 위치 유지(점프 0). try/catch 로 라이브 무손상.
      const loadOlderHistory = async () => {
        if (loadingOlder || reachedOldest || oldestLoadedTs === null) return;
        loadingOlder = true;
        try {
          const r = await fetch(
            historyPageQuery(HISTORY_PAGE, oldestLoadedTs, oldestLoadedId) +
              "&threadKey=" + encodeURIComponent(activeThreadKey), // 멀티세션 — active 세션만 더보기.
          );
          if (!r.ok) return; // ★더보기 실패는 전체 상태를 안 바꾼다(이미 내용이 있다).
          const data = await r.json().catch(() => ({}));
          const entries = Array.isArray(data.entries) ? data.entries : [];
          const activities = Array.isArray(data.activities) ? data.activities : [];
          if (entries.length === 0) {
            reachedOldest = true; // 더 없음.
            return;
          }
          // 도구 스텝·diff·출력·묶음도 함께 복원(초기 로드와 동일 로직, older prepend 방향).
          renderHistoryBatch(entries, activities, true);
          setOldestCursor(entries, oldestLoadedTs);
          if (entries.length < HISTORY_PAGE) reachedOldest = true; // 페이지 미만 = 마지막 묶음.
        } catch (err) {
          console.warn("older history load failed:", err && err.message ? err.message : err);
        } finally {
          loadingOlder = false;
        }
      };

      /**
       * 그 `ts` 의 메시지가 **로드될 때까지** 과거를 당겨온 뒤 거기로 스크롤한다.
       * 검색 결과 점프의 착지 절차.
       *
       * ★서버에 `aroundTs` 를 새로 만들지 않았다. 그러면 "로드된 창의 맨 아래가 최신이
       *  아닌" 상태가 생기고, SSE 로 들어오는 라이브 메시지가 그 창 바닥에 붙어 **옛
       *  대화와 새 대화가 이어진 것처럼** 보인다(2026-07-28 에 같은 부류를 겪었다).
       *  기존 페이지네이션(`beforeTs`)으로 **과거만 더 당기면** 그 불변식이 안 깨진다 —
       *  목록은 여전히 "맨 아래가 최신" 이고, 위로 더 길어질 뿐이다. 가상화라 감당된다.
       *
       * ★페이지를 크게(200) 쓴다. 평소 더보기는 20인데, 점프는 **한 번에 목적지까지**
       *  가야 한다 — 20씩이면 2천 건 뒤 메시지에 왕복 100번이다.
       * ★상한을 둔다(10회 = 2,000건). 못 닿으면 **말한다** — 조용히 아무 일도 안
       *  일어나면 사용자는 고장으로 읽는다.
       */
      const JUMP_PAGE = 200;
      const JUMP_MAX_PAGES = 10;
      window.jumpToMessageTs = async (ts) => {
        if (typeof ts !== "number" || !Number.isFinite(ts)) return "bad-ts";
        if (window.vtScrollToTs && (await window.vtScrollToTs(ts))) return "ok";
        for (let i = 0; i < JUMP_MAX_PAGES; i++) {
          if (reachedOldest || oldestLoadedTs === null) break;
          if (oldestLoadedTs <= ts) break; // 이미 그 시점보다 과거까지 로드됨.
          let entries = [];
          try {
            const r = await fetch(
              historyPageQuery(JUMP_PAGE, oldestLoadedTs, oldestLoadedId) +
                "&threadKey=" + encodeURIComponent(activeThreadKey),
            );
            if (!r.ok) break;
            const data = await r.json().catch(() => ({}));
            entries = Array.isArray(data.entries) ? data.entries : [];
            const activities = Array.isArray(data.activities) ? data.activities : [];
            if (entries.length === 0) { reachedOldest = true; break; }
            renderHistoryBatch(entries, activities, true);
            setOldestCursor(entries, oldestLoadedTs);
            if (entries.length < JUMP_PAGE) reachedOldest = true;
          } catch (err) {
            console.warn("jump history load failed:", err && err.message ? err.message : err);
            break;
          }
          if (window.vtScrollToTs && (await window.vtScrollToTs(ts))) return "ok";
        }
        return window.vtScrollToTs && (await window.vtScrollToTs(ts)) ? "ok" : "not-found";
      };

      // SSE 연결 *전에* 과거 이력을 await 로드해 채팅 흐름을 복원한다. 비어있으면 chat-empty
      // 안내가 그대로 유지된다(첫 사용). 실패는 무해 — 라이브 SSE 경로엔 영향 0(과거 로드는 추가).
      // 초기 limit 100(기능 2). 100 미만이면 더 없음(reachedOldest), 아니면 센티넬 관찰 시작.
      // 비서 이름을 정적 문구(채팅 설명 등)에 반영 — 라벨은 렌더 시점에 assistantName 참조.
      const applyAssistantName = () => {
        const desc = document.querySelector(".chat-desc");
        if (desc) desc.textContent = i18n("chat.descWith", { name: assistantName });
      };

      const loadChatHistory = async () => {
        beginHistoryLoad(); // 이 창의 SSE 메시지는 보류 — 빈 리스트에 붙으면 순서가 깨진다.
        setHistoryLoadState("loading"); // 받아보기 전엔 "없다"고 말하지 않는다.
        try {
          // 멀티세션(ADR 2026-07-15) — 초기 로드도 active 세션(기본=dashboard:default)만. 미지정이면
          // 전 스레드 병합이라 텔레그램/매니저가 섞임(D4 위배). threadKey 로 스코프.
          const r = await fetch("/api/chat-history?limit=" + HISTORY_PAGE + "&threadKey=" + encodeURIComponent(activeThreadKey));
          if (!r.ok) { setHistoryLoadState("error"); return; } // 실패와 빈 대화는 다른 상태다.
          const data = await r.json().catch(() => ({}));
          // 비서 표시 이름(AGENT.md 이름, 폴백 tiguclaw) — 라벨/문구에 반영. 빈 이력이어도 세팅.
          if (typeof data.assistantName === "string" && data.assistantName.trim() !== "") {
            assistantName = data.assistantName.trim();
            applyAssistantName();
          }
          const entries = Array.isArray(data.entries) ? data.entries : [];
          const activities = Array.isArray(data.activities) ? data.activities : [];
          if (entries.length === 0 && activities.length === 0) return; // 빈 이력(아래 finally 가 ready 로 닫는다).
          // 메시지 + 도구 스텝(기능 B)을 병합·묶음 렌더(초기=prepend). 각 dedup 키 등록 →
          // 곧 연결될 SSE replay 가 같은 메시지/스텝을 중복 렌더 안 하게.
          renderHistoryBatch(entries, activities, false);
          // 가장 오래된 ts = 다음 페이지의 beforeTs (메시지 기준 — 페이지네이션은 메시지 축).
          setOldestCursor(entries, activities.length > 0 ? activities[0].ts : oldestLoadedTs);
          // 첫 로드가 페이지 미만 = 더 없음. 아니면 상단 스크롤이 loadOlderHistory 를 트리거(스크롤 리스너).
          if (entries.length < HISTORY_PAGE) reachedOldest = true;
          refreshChatEmpty();
          scrollChatToNewest(); // 초기 로드 후 최신(하단) 고정 — 앵커 드리프트 보정.
          if (currentView === "overview") setTimeout(showOverview, 0);
        } catch (err) {
          // 무해 — 라이브 경로 무손상. 콘솔만.
          console.warn("chat-history load failed:", err && err.message ? err.message : err);
          setHistoryLoadState("error");
        } finally {
          endHistoryLoad(); // 실패·조기 return 경로 포함 — 보류분을 반드시 흘린다(유실 0).
          // ★"loading" 으로 굳는 경로가 없게 — 성공·빈이력·조기 return 전부 여기서 닫힌다.
          //  이미 error 로 확정된 건 덮지 않는다(실패를 성공처럼 말하지 않는다).
          if (historyLoadState === "loading") setHistoryLoadState("ready");
        }
      };

