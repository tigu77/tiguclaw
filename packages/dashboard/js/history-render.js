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
        const head = document.createElement("div");
        head.className = "bubble-meta"; // 라이브 답변 버블과 같은 간격(새로고침해도 동일해야 함).
        const tsEl = document.createElement("span");
        tsEl.className = "ts";
        tsEl.textContent = fmtTime(entry.ts);
        const tyEl = document.createElement("span");
        tyEl.className = "type";
        tyEl.textContent = isNotice ? "시스템 알림" : (isOut ? assistantName : "나");
        head.appendChild(tsEl); head.appendChild(tyEl);
        { const chb = buildChannelBadge(entry.channel); if (chb) head.appendChild(chb); } // 텔레그램 등 원격 채널 경유 표시.
        // 실제 응답 모델 — 라이브 답변 버블(ensureReplyBubble) 파리티. 값 없으면 요소를 만들지
        //  않는다(거짓값 금지 + 사용자 메시지·통지처럼 모델 개념이 없는 행에 빈 배지 방지).
        if (isOut && typeof entry.model === "string" && entry.model.trim() !== "") {
          const mEl = document.createElement("span");
          mEl.className = "turn-model";
          mEl.textContent = entry.model.trim();
          mEl.title = "이 답변에 실제로 응답한 모델";
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
            // 미리보기 — 클릭 시 원본 새 탭(경량, 의존 0).
            chip.dataset.zoom = "1";
            chip.addEventListener("click", () => window.open(src, "_blank", "noopener"));
          } else {
            const ic = document.createElement("div"); ic.className = "att-fileicon";
            ic.textContent = ((String(name).split(".").pop() || "FILE").slice(0, 4)).toUpperCase();
            const nm = document.createElement("div"); nm.className = "att-fname"; nm.textContent = name;
            chip.appendChild(ic); chip.appendChild(nm);
          }
          // 받기 버튼(다운로드) — 아웃바운드 카드에서만(인바운드 무회귀). download 속성으로 저장.
          if (download && dlHref) {
            const dl = document.createElement("a");
            dl.className = "att-dl";
            dl.href = dlHref;
            dl.setAttribute("download", name);
            dl.title = "받기";
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
        if (renderedMsgKeys.has(key)) return null;
        renderedMsgKeys.add(key);
        // ★notice·model 을 반드시 함께 넘긴다 (2026-07-27). 종전엔 여기서 빠뜨려, chat_log 에
        //  값이 있어도 **새로고침하면 시스템 통지 구분도 모델 표시도 사라졌다**(사용자 신고
        //  "안 보이는 애들"의 정체). 필드를 추가할 때 이 전달 지점을 같이 안 고치면 저장은
        //  되는데 화면엔 없는 상태가 조용히 생긴다.
        return buildHistoryDiv({
          ts: entry.ts, role, text: entry.text, attachments: entry.attachments, channel: entry.channel,
          ...(entry.notice === true ? { notice: true } : {}),
          ...(typeof entry.model === "string" && entry.model !== "" ? { model: entry.model } : {}),
        });
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
        label.textContent = skill ? "스킬: " + skill.name : (a.label || "tool");
        line.appendChild(icon); line.appendChild(label);
        // diff 있는 스텝은 diff 헤더가 경로+N/-M 을 보여주므로 verbose detail 생략(접힘 간결).
        // 스킬 스텝은 detail(=name=…)이 라벨과 중복 → 생략.
        const hasDiff = a.diff && Array.isArray(a.diff.lines);
        if (a.detail && !hasDiff && !skill) {
          const d = document.createElement("span");
          d.className = "hist-tool-detail"; d.textContent = a.detail;
          line.appendChild(d);
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
          modelEl.title = "이 런이 실제로 사용한 모델";
        }
        const count = document.createElement("span");
        count.className = "hist-turn-count"; count.textContent = acts.length + "단계";
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
      const groupMergedItems = (entries, activities) => {
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
              renderedMsgKeys.add(msgKey(it.m.ts, "assistant"));
              sawTextThread = null;
              continue;
            }
            sawTextThread = null;
            units.push({ kind: "msg", entry: it.m });
          } else {
            const a = it.a; const seq = typeof a.seq === "number" ? a.seq : 0;
            if (a.kind === "text") {
              flush();                                  // 텍스트 앞의 도구 런 마감(seq 순 교차).
              units.push({ kind: "text", act: a });     // 항상 보이는 마크다운 버블(도구 런과 교차).
              sawTextThread = a.threadKey;
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
      let loadingOlder = false; // 동시 로드 가드.
      let reachedOldest = false; // 빈/부분 배치 → 더 없음.

      // 더 로드 — 상단 근처 스크롤이 트리거. 과거 배치(ASC)를 vtPrependOlder 로 앞에 붙인다.
      // vtPrependOlder 가 늘어난 위 높이만큼 scrollTop 을 밀어 보던 위치 유지(점프 0). try/catch 로 라이브 무손상.
      const loadOlderHistory = async () => {
        if (loadingOlder || reachedOldest || oldestLoadedTs === null) return;
        loadingOlder = true;
        try {
          const r = await fetch(
            "/api/chat-history?limit=" + HISTORY_PAGE + "&beforeTs=" + oldestLoadedTs +
              "&threadKey=" + encodeURIComponent(activeThreadKey), // 멀티세션 — active 세션만 더보기.
          );
          if (!r.ok) return;
          const data = await r.json().catch(() => ({}));
          const entries = Array.isArray(data.entries) ? data.entries : [];
          const activities = Array.isArray(data.activities) ? data.activities : [];
          if (entries.length === 0) {
            reachedOldest = true; // 더 없음.
            return;
          }
          // 도구 스텝·diff·출력·묶음도 함께 복원(초기 로드와 동일 로직, older prepend 방향).
          renderHistoryBatch(entries, activities, true);
          oldestLoadedTs = entries[0].ts; // 배치 最古(ASC[0]) = 다음 beforeTs.
          if (entries.length < HISTORY_PAGE) reachedOldest = true; // 페이지 미만 = 마지막 묶음.
        } catch (err) {
          console.warn("older history load failed:", err && err.message ? err.message : err);
        } finally {
          loadingOlder = false;
        }
      };

      // SSE 연결 *전에* 과거 이력을 await 로드해 채팅 흐름을 복원한다. 비어있으면 chat-empty
      // 안내가 그대로 유지된다(첫 사용). 실패는 무해 — 라이브 SSE 경로엔 영향 0(과거 로드는 추가).
      // 초기 limit 100(기능 2). 100 미만이면 더 없음(reachedOldest), 아니면 센티넬 관찰 시작.
      // 비서 이름을 정적 문구(채팅 설명 등)에 반영 — 라벨은 렌더 시점에 assistantName 참조.
      const applyAssistantName = () => {
        const desc = document.querySelector(".chat-desc");
        if (desc) desc.textContent = assistantName + "와 대화합니다. 진행 단계는 대화에 바로, 백그라운드 작업은 옆 패널에서 확인합니다.";
      };

      const loadChatHistory = async () => {
        beginHistoryLoad(); // 이 창의 SSE 메시지는 보류 — 빈 리스트에 붙으면 순서가 깨진다.
        try {
          // 멀티세션(ADR 2026-07-15) — 초기 로드도 active 세션(기본=dashboard:default)만. 미지정이면
          // 전 스레드 병합이라 텔레그램/워커가 섞임(D4 위배). threadKey 로 스코프.
          const r = await fetch("/api/chat-history?limit=" + HISTORY_PAGE + "&threadKey=" + encodeURIComponent(activeThreadKey));
          if (!r.ok) return;
          const data = await r.json().catch(() => ({}));
          // 비서 표시 이름(AGENT.md 이름, 폴백 tiguclaw) — 라벨/문구에 반영. 빈 이력이어도 세팅.
          if (typeof data.assistantName === "string" && data.assistantName.trim() !== "") {
            assistantName = data.assistantName.trim();
            applyAssistantName();
          }
          const entries = Array.isArray(data.entries) ? data.entries : [];
          const activities = Array.isArray(data.activities) ? data.activities : [];
          if (entries.length === 0 && activities.length === 0) return; // 빈 이력.
          // 메시지 + 도구 스텝(기능 B)을 병합·묶음 렌더(초기=prepend). 각 dedup 키 등록 →
          // 곧 연결될 SSE replay 가 같은 메시지/스텝을 중복 렌더 안 하게.
          renderHistoryBatch(entries, activities, false);
          // 가장 오래된 ts = 다음 페이지의 beforeTs (메시지 기준 — 페이지네이션은 메시지 축).
          oldestLoadedTs =
            entries.length > 0 ? entries[0].ts : (activities.length > 0 ? activities[0].ts : oldestLoadedTs);
          // 첫 로드가 페이지 미만 = 더 없음. 아니면 상단 스크롤이 loadOlderHistory 를 트리거(스크롤 리스너).
          if (entries.length < HISTORY_PAGE) reachedOldest = true;
          refreshChatEmpty();
          scrollChatToNewest(); // 초기 로드 후 최신(하단) 고정 — 앵커 드리프트 보정.
          if (currentView === "overview") setTimeout(showOverview, 0);
        } catch (err) {
          // 무해 — 라이브 경로 무손상. 콘솔만.
          console.warn("chat-history load failed:", err && err.message ? err.message : err);
        } finally {
          endHistoryLoad(); // 실패·조기 return 경로 포함 — 보류분을 반드시 흘린다(유실 0).
        }
      };

