      // ── CC식 가상화(윈도잉) — #stream 을 위→아래(최古 위·최新 아래) 흐름으로 바운드 렌더 ──
      // vtItems: 오래된→최신 순서로 실 DOM 노드(스트리밍 중에도 살아있게 detached 로 보관)를 들고,
      // 뷰포트±버퍼만 마운트한다. 높이는 ResizeObserver 로 실측(측정 전 추정치). 스틱-투-바텀은
      // scrollTop=scrollHeight, 프리펜드/측정 시엔 앵커 보정으로 점프 0. (구 역방향 flex·상한 prune·
      // 날짜구분 MutationObserver·센티넬 IntersectionObserver 를 전부 대체.)
      const VT_EST_H = 72;         // 미측정 아이템 추정 높이(px).
      const VT_DIVIDER_EST_H = 28; // 날짜 구분선 추정 높이(px).
      const VT_GAP = 8;            // .vt-window flex gap 과 일치(슬롯 높이 = 실측 + gap).
      const VT_BUFFER = 800;       // 뷰포트 위·아래 여분 마운트(px). older 로드 트리거 임계도 겸함.
      const VT_MAX_ITEMS = 4000;   // 보관 아이템 상한(하단 고정 시 최古 detached 부터 드롭).

      // sizer(스크롤바 총높이) > window(마운트 서브셋). #chat-empty·#log-empty 는 #stream 직속 형제로 유지.
      const vtSizer = document.createElement("div");
      vtSizer.className = "vt-sizer";
      const vtWindow = document.createElement("div");
      vtWindow.className = "vt-window";
      vtSizer.appendChild(vtWindow);
      stream.appendChild(vtSizer);
      // 일반 이벤트(알 수 없는 유형) 싱크 — 채팅선 숨김·로그 패널(데드)용. vtItems 오염 방지.
      const logSink = document.createElement("div");
      logSink.id = "log-sink";
      logSink.style.display = "none";
      stream.appendChild(logSink);
      const LOG_SINK_MAX = 300;

      const vtItems = [];        // { node, h, measured, isDivider, top } — 오래된→최신.
      const vtIndex = new Map(); // node -> item.
      let stickBottom = true;    // 하단(최신) 고정 팔로우. 사용자가 위로 스크롤하면 해제.
      let vtJumpTop = false;     // Home 원샷 — 로드된 맨위로 프로그램적 점프(리스너/loadOlder 미발화).
      let vtProgrammatic = false; // 프로그램적 scrollTop 조정 가드(scroll 리스너 무시).
      let lastScrollTop = 0;     // 직전 scrollTop — 사용자 스크롤 방향(위/아래) 판정용. 작은 위 스크롤도 stick 해제.

      const slotH = (it) =>
        (it.measured ? it.h : (it.isDivider ? VT_DIVIDER_EST_H : VT_EST_H)) + VT_GAP;

      // 메시지 노드 → 수치 ts(날짜 경계 판정). 턴 그룹은 내부 첫 [data-ts] 를 본다.
      const vtTsOf = (el) => {
        if (el.classList && el.classList.contains("date-divider")) return null;
        if (el.dataset && el.dataset.ts) return Number(el.dataset.ts);
        const inner = el.querySelector ? el.querySelector("[data-ts]") : null;
        return inner && inner.dataset.ts ? Number(inner.dataset.ts) : null;
      };

      // 아이템 높이 실측 — 측정되면 model 갱신 후 relayout(추정→실측 정합).
      const vtObserver = new ResizeObserver((entries) => {
        let changed = false;
        for (const e of entries) {
          const it = vtIndex.get(e.target);
          if (!it) continue;
          const h = e.target.offsetHeight;
          if (h > 0 && (!it.measured || Math.abs(it.h - h) > 0.5)) {
            it.h = h; it.measured = true; changed = true;
          }
        }
        if (changed) scheduleRelayout();
      });
      const vtContainerRO = new ResizeObserver(() => scheduleRelayout());
      vtContainerRO.observe(stream);

      let vtRaf = 0;
      const scheduleRelayout = () => {
        if (vtRaf) return;
        vtRaf = requestAnimationFrame(() => { vtRaf = 0; relayout(); });
      };
      const setScrollTop = (v) => {
        vtProgrammatic = true;
        stream.scrollTop = v;
        lastScrollTop = stream.scrollTop; // 프로그램적 이동 = 사용자 스크롤 방향 비교 기준을 즉시 동기(스냅 후 오판 방지).
        requestAnimationFrame(() => { vtProgrammatic = false; });
      };

      const relayout = () => {
        const clientH = stream.clientHeight;
        // 앵커(프리펜드/측정 점프 방지) — top 재계산 *전* OLD top 으로 현재 뷰 상단 아이템의 화면
        // 오프셋을 기록해야 위쪽 높이 변화를 실제로 보정한다. (재계산 후 잡으면 off 가 상쇄돼 no-op.)
        let anchor = null;
        if (!stickBottom && !vtJumpTop && clientH > 0) {
          const st = stream.scrollTop;
          for (const it of vtItems) {
            if (it.top + slotH(it) > st) { anchor = { it: it, off: it.top - st }; break; }
          }
        }

        // 누적 top(슬롯=실측+gap) + 총합 → sizer 높이(스크롤바). 위 루프의 OLD top 을 여기서 NEW 로 갱신.
        let total = 0;
        for (const it of vtItems) { it.top = total; total += slotH(it); }
        vtSizer.style.height = total + "px";
        if (clientH === 0) return; // 숨김(다른 뷰) → 마운트 스킵.

        // 가시 범위(±버퍼). 스틱이면 하단, Home 점프면 상단(0) 기준으로 범위를 잡는다.
        const scrollTop = stickBottom ? Math.max(0, total - clientH) : (vtJumpTop ? 0 : stream.scrollTop);
        const viewTop = scrollTop - VT_BUFFER;
        const viewBot = scrollTop + clientH + VT_BUFFER;
        let first = -1, last = -1;
        for (let i = 0; i < vtItems.length; i++) {
          const it = vtItems[i];
          if (it.top + slotH(it) < viewTop) continue;
          if (it.top > viewBot) break;
          if (first === -1) first = i;
          last = i;
        }

        // 마운트 집합 교체 — 범위 밖 detach, 범위 안을 순서대로 mount(노드 참조·observer 유지).
        if (first === -1) {
          while (vtWindow.firstChild) vtWindow.removeChild(vtWindow.firstChild);
          vtWindow.style.transform = "translateY(0px)";
        } else {
          const desired = [];
          for (let i = first; i <= last; i++) desired.push(vtItems[i].node);
          const desiredSet = new Set(desired);
          for (const ch of Array.from(vtWindow.children)) {
            if (!desiredSet.has(ch)) vtWindow.removeChild(ch);
          }
          for (let k = 0; k < desired.length; k++) {
            const node = desired[k];
            const cur = vtWindow.children[k];
            if (cur !== node) vtWindow.insertBefore(node, cur || null);
          }
          vtWindow.style.transform = "translateY(" + vtItems[first].top + "px)";
        }

        // 스크롤 위치 확정 — 스틱이면 하단, 아니면 앵커 복원(둘 다 프로그램적 = 리스너 무시).
        if (stickBottom) {
          setScrollTop(total + 40); // 브라우저가 최대(하단)로 클램프.
        } else if (vtJumpTop) {
          setScrollTop(0); vtJumpTop = false; // 로드된 맨위 안착(프로그램적 = loadOlder 미발화).
        } else if (anchor) {
          setScrollTop(anchor.it.top - anchor.off);
        }
        // "↓ 최신" 점프버튼 갱신 — 프로그램적 스크롤(setScrollTop=vtProgrammatic)은 scroll
        // 리스너가 조기 return 해 updateChatJump 를 건너뛴다. relayout 끝에서 stickBottom 기준
        // 직접 갱신해야 전송 후 하단인데(stickBottom=true) 버튼이 남던 버그를 막는다.
        updateChatJump();
      };

      // 날짜 구분선 재계산 — 구조 변경(append/prependOlder/history batch/cap) 후 호출. 오래된→최신
      // walk 하며 날짜 바뀌는 첫 아이템 앞에 divider 를 둔다. ★기존 divider 는 dateKey 로 풀링해
      // *재사용*(측정 높이 h 보존): 매 append 마다 전량 파괴·재생성하면 화면 밖 divider 가 미측정
      // 추정치로 되돌아 총높이가 흔들리고, 앵커가 그만큼 스크롤을 밀어 사용자가 이력 열람 중
      // 새 메시지마다 위로 튕겼다(원인 C). 경계는 날짜당 1회 = dateKey 유일 → 안전한 재사용 키.
      const vtRecomputeDividers = () => {
        const pool = new Map(); // dateKey -> 재사용 후보 divider item(측정 h 보존).
        for (let i = vtItems.length - 1; i >= 0; i--) {
          const it = vtItems[i];
          if (it.isDivider) {
            if (it.dateKey != null && !pool.has(it.dateKey)) pool.set(it.dateKey, it);
            else { // 중복 키(비정상 순서) = 폐기.
              vtObserver.unobserve(it.node);
              vtIndex.delete(it.node);
              if (it.node.parentNode) it.node.parentNode.removeChild(it.node);
            }
            vtItems.splice(i, 1);
          }
        }
        let prevKey = null;
        for (let i = 0; i < vtItems.length; i++) {
          const ts = vtTsOf(vtItems[i].node);
          if (ts === null) continue;
          const k = dateKey(ts);
          if (k !== prevKey) {
            let it = pool.get(k);
            if (it) { pool.delete(k); } // 재사용 — h/measured/node 그대로(DOM 마운트 유지, relayout 이 정렬).
            else {
              const div = document.createElement("div");
              div.className = "date-divider";
              const span = document.createElement("span");
              span.textContent = fmtDate(ts);
              div.appendChild(span);
              it = { node: div, h: 0, measured: false, isDivider: true, top: 0, dateKey: k };
              vtIndex.set(div, it);
              vtObserver.observe(div);
            }
            vtItems.splice(i, 0, it);
            prevKey = k;
            i++; // 방금 삽입한 divider 건너뜀.
          }
        }
        for (const it of pool.values()) { // 더 이상 필요 없는 잔여 divider 폐기.
          vtObserver.unobserve(it.node);
          vtIndex.delete(it.node);
          if (it.node.parentNode) it.node.parentNode.removeChild(it.node);
        }
      };

      const vtMakeItem = (node) => ({
        node: node, h: 0, measured: false,
        isDivider: !!(node.classList && node.classList.contains("date-divider")), top: 0,
      });

      // 최신 아이템 추가(하단). stick 이면 relayout 이 따라간다.
      const vtAppend = (node) => {
        if (vtIndex.has(node)) return;
        const it = vtMakeItem(node);
        vtItems.push(it);
        vtIndex.set(node, it);
        vtObserver.observe(node);
        vtRecomputeDividers();
        vtCap();
        scheduleRelayout();
      };

      // 과거 배치(오래된→최신)를 앞(위)에 붙임. 늘어난 위 높이만큼 scrollTop 을 먼저 밀어 점프 방지
      // (측정 후 앵커가 정밀 보정). older 로드는 not-stick(스크롤업) 상태에서만 호출됨.
      const vtPrependOlder = (nodes) => {
        if (!nodes || !nodes.length) return;
        const newItems = [];
        let addedH = 0;
        for (const node of nodes) {
          if (vtIndex.has(node)) continue;
          const it = vtMakeItem(node);
          newItems.push(it);
          vtIndex.set(node, it);
          vtObserver.observe(node);
          addedH += slotH(it);
        }
        if (!newItems.length) return;
        vtItems.unshift.apply(vtItems, newItems);
        if (addedH) setScrollTop(stream.scrollTop + addedH);
        vtRecomputeDividers();
        scheduleRelayout();
      };

      const vtRemove = (node) => {
        const it = vtIndex.get(node);
        if (!it) return;
        vtObserver.unobserve(node);
        vtIndex.delete(node);
        const idx = vtItems.indexOf(it);
        if (idx !== -1) vtItems.splice(idx, 1);
        if (node.parentNode === vtWindow) vtWindow.removeChild(node);
        scheduleRelayout();
      };

      const vtClear = () => {
        for (const it of vtItems) {
          vtObserver.unobserve(it.node);
          if (it.node.parentNode) it.node.parentNode.removeChild(it.node);
        }
        vtItems.length = 0;
        vtIndex.clear();
        scheduleRelayout();
      };

      // 보관 상한 — 하단 고정(라이브) 중일 때만 최古 detached 아이템부터 드롭(보던 이력 보존).
      // dedup 키 정리 + oldestLoadedTs 갱신(구 refreshOldestCursorAfterPrune 대체)을 접어 넣는다.
      const vtCap = () => {
        if (!stickBottom || vtItems.length <= VT_MAX_ITEMS) return;
        let dropped = 0;
        while (vtItems.length > VT_MAX_ITEMS) {
          const it = vtItems[0];
          if (it.node.parentNode === vtWindow) break; // 마운트(가시) 최古면 중단.
          vtObserver.unobserve(it.node);
          vtIndex.delete(it.node);
          vtItems.shift();
          if (it.node.dataset && it.node.dataset.ts) {
            const t = parseInt(it.node.dataset.ts, 10);
            const ty = it.node.dataset.type || "";
            if (Number.isFinite(t) && ty.indexOf("channel.message") === 0) {
              const role = ty.endsWith(".out") ? "assistant" : "user";
              renderedMsgKeys.delete(msgKey(t, role));
            }
          }
          dropped += 1;
        }
        if (dropped) {
          for (const it of vtItems) {
            const ts = vtTsOf(it.node);
            if (ts !== null) { oldestLoadedTs = ts; break; }
          }
          if (reachedOldest) reachedOldest = false; // 앞이 더 있을 수 있음 → 재로드 가능.
          vtRecomputeDividers();
        }
        capKeyStore(renderedActivityKeys);
        capKeyStore(activityByStep);
      };

      // 채팅을 최신(하단)으로 고정 — 뷰 진입·전송·초기 이력 로드 후.
      const scrollChatToNewest = () => {
        stickBottom = true;
        scheduleRelayout();
      };

      // 스크롤 리스너 — stick 추적 + 점프버튼 + 상단 근처면 older 로드(센티넬 IntersectionObserver 대체).
      stream.addEventListener("scroll", () => {
        if (vtProgrammatic) { lastScrollTop = stream.scrollTop; return; }
        const st = stream.scrollTop;
        const nearBottom = (stream.scrollHeight - st - stream.clientHeight) < 80;
        // 사용자 스크롤 존중 — 위로 스크롤(작은 델타 포함) = 과거 열람 의도 → 즉시 stick 해제(재-스냅 금지).
        // 아래로 내려와 바닥 근처(threshold)일 때만 팔로우 재개. 위치 임계값만 보면 <80px 위 스크롤이
        // stick 을 유지해 relayout/ResizeObserver 가 바닥으로 튕겼다(원인 A).
        if (st < lastScrollTop - 1) stickBottom = false;
        else if (nearBottom) stickBottom = true;
        lastScrollTop = st;
        updateChatJump();
        scheduleRelayout();
        if (st < VT_BUFFER && !loadingOlder && !reachedOldest) void loadOlderHistory();
      }, { passive: true });

      // 키보드 네비 — PageUp/Down·Home·End 로 채팅 리스트 스크롤. 가상화(absolute vt-window)라
      // 네이티브 키 스크롤이 안 먹어서 명시 처리한다. 채팅 뷰 활성 + 입력창에 실 초안이 없을 때만
      // (작성 중이면 커서 이동 존중). preventDefault 로 브라우저 기본(포커스 요소 scrollIntoView
      // 로 인한 가로 밀림)도 막는다.
      document.addEventListener("keydown", (e) => {
        if (document.body.getAttribute("data-main") !== "stream") return; // 채팅 뷰만
        if (e.key !== "PageDown" && e.key !== "PageUp" && e.key !== "Home" && e.key !== "End") return;
        if (e.altKey || e.ctrlKey || e.metaKey) return; // 조합키는 브라우저/OS 몫.
        const tgt = e.target;
        if (tgt && tgt.id === "chat-input" && tgt.value && tgt.value.trim() !== "") return; // 작성 중 = 커서 이동 존중.
        e.preventDefault();
        const page = Math.max(60, stream.clientHeight * 0.9);
        if (e.key === "PageDown") { stickBottom = false; stream.scrollTop += page; }
        else if (e.key === "PageUp") { stickBottom = false; stream.scrollTop -= page; }
        else if (e.key === "End") scrollChatToNewest();          // 맨아래(최신) 고정.
        else if (e.key === "Home") { stickBottom = false; vtJumpTop = true; scheduleRelayout(); } // 로드된 맨위 안착.
      });

      // 최신으로 점프 버튼 — 하단 고정이면 숨김, 위로 스크롤(과거 열람) 중이면 표시.
      const chatJump = document.getElementById("chat-jump");
      const updateChatJump = () => { if (chatJump) chatJump.hidden = stickBottom; };
      if (chatJump) {
        chatJump.addEventListener("click", () => {
          stickBottom = true;
          scrollChatToNewest();
          updateChatJump();
        });
      }

      // 파일 확장자 → highlight.js 언어. diff 코드 하이라이팅 언어 판별(경로 기반).
      const HL_EXT = { cs:"csharp", ts:"typescript", tsx:"typescript", js:"javascript", jsx:"javascript", mjs:"javascript", cjs:"javascript", py:"python", java:"java", go:"go", rs:"rust", cpp:"cpp", cc:"cpp", cxx:"cpp", hpp:"cpp", h:"cpp", c:"c", rb:"ruby", php:"php", sh:"bash", bash:"bash", zsh:"bash", json:"json", jsonc:"json", yaml:"yaml", yml:"yaml", toml:"ini", ini:"ini", sql:"sql", css:"css", scss:"scss", less:"less", html:"xml", htm:"xml", xml:"xml", vue:"xml", svelte:"xml", md:"markdown", kt:"kotlin", kts:"kotlin", swift:"swift", lua:"lua", dart:"dart", scala:"scala", pl:"perl", r:"r", ps1:"powershell" };
      const hlLangFromPath = (p) => {
        if (!p || typeof p !== "string") return null;
        const ext = (p.split(/[\\/]/).pop() || "").split(".").pop().toLowerCase();
        return HL_EXT[ext] || null;
      };

      // 리치 diff 블록(Edit/Write, ADR 2026-07-09) — 접이식 초록·빨강 diff. 라이브 스텝·
      // 이력 줄 공용. 캡처(런타임)가 구조화한 diff 를 여기선 *렌더*만(초록/빨강 뷰=채널 몫).
      const buildDiffBlock = (diff) => {
        const wrap = document.createElement("div");
        wrap.className = "act-diff";
        const head = document.createElement("div");
        head.className = "act-diff-head";
        const caret = document.createElement("span");
        caret.className = "act-diff-caret"; caret.textContent = "▸";
        head.appendChild(caret);
        if (diff.path) {
          const ps = document.createElement("span");
          ps.className = "act-diff-path"; ps.textContent = diff.path;
          head.appendChild(ps);
        }
        const stat = document.createElement("span");
        stat.className = "act-diff-stat";
        const add = document.createElement("span");
        add.className = "dadd"; add.textContent = "+" + (diff.added || 0);
        const del = document.createElement("span");
        del.className = "ddel"; del.textContent = "-" + (diff.removed || 0);
        stat.appendChild(add); stat.appendChild(document.createTextNode(" ")); stat.appendChild(del);
        head.appendChild(stat);
        const body = document.createElement("div");
        body.className = "act-diff-body";
        const pre = document.createElement("pre");
        pre.className = "act-diff-pre";
        const lang = hlLangFromPath(diff.path); // 경로 확장자로 언어 판별(있으면 코드부 하이라이트).
        for (const ln of (diff.lines || [])) {
          const row = document.createElement("div");
          const op = ln.op === "+" ? "add" : ln.op === "-" ? "del" : "ctx";
          row.className = "dl dl-" + op;
          const text = ln.text != null ? ln.text : "";
          // op 접두(+/-/공백)는 색 신호로 유지, 코드부는 hljs 로 언어별 하이라이트(줄 단위).
          const opSpan = document.createElement("span");
          opSpan.className = "dl-op"; opSpan.textContent = (ln.op || " ") + " ";
          const codeSpan = document.createElement("span");
          codeSpan.className = "dl-code";
          if (lang && text && typeof window.hljs !== "undefined") {
            try { codeSpan.innerHTML = window.hljs.highlight(text, { language: lang, ignoreIllegal: true }).value; }
            catch { codeSpan.textContent = text; }
          } else { codeSpan.textContent = text; }
          row.appendChild(opSpan); row.appendChild(codeSpan);
          pre.appendChild(row);
        }
        if (diff.truncated) {
          const t = document.createElement("div");
          t.className = "dl dl-trunc"; t.textContent = "… (이하 생략 — 크기 제한)";
          pre.appendChild(t);
        }
        body.appendChild(pre);
        // 토글은 스텝(부모) 단위 — 헤더는 접힘 시 요약(경로 + N/-M)만 보여준다(클릭 핸들러 없음).
        wrap.appendChild(head); wrap.appendChild(body);
        return wrap;
      };

      // 리치 출력 블록(Bash/Read/Grep/Glob, ADR 2026-07-09 슬라이스 2/3) — 접이식 결과 프리뷰.
      const buildOutputBlock = (output) => {
        const wrap = document.createElement("div");
        wrap.className = "act-output" + (output.isError ? " err" : "");
        const head = document.createElement("div");
        head.className = "act-output-head";
        const caret = document.createElement("span");
        caret.className = "act-diff-caret"; caret.textContent = "▸";
        const lbl = document.createElement("span");
        lbl.className = "act-output-lbl";
        lbl.textContent = output.isError ? "출력 (에러)" : "출력";
        head.appendChild(caret); head.appendChild(lbl);
        const body = document.createElement("div");
        body.className = "act-diff-body";
        const pre = document.createElement("pre");
        pre.className = "act-output-pre";
        pre.textContent = (output.text != null ? output.text : "") + (output.truncated ? "\n… (이하 생략 — 크기 제한)" : "");
        body.appendChild(pre);
        // 토글은 스텝(부모) 단위 — 헤더는 접힘 시 요약("출력")만. (클릭 핸들러 없음.)
        wrap.appendChild(head); wrap.appendChild(body);
        return wrap;
      };

      // 리치 diff/출력이 없는 도구 스텝용 인라인 상세 블록 — 옛 사이드바(#step-detail) 대체.
      // 모든 도구 스텝을 "그 자리에서 펼침"으로 통일(2026-07-15). .act-output/.act-diff-body 재사용
      // 으로 기존 펼침 CSS·클릭 쿼리(:scope > .act-output)에 그대로 얹힘. 보여줄 게 없으면 null.
      const buildDetailBlock = (p) => {
        const detail = p && p.detail != null ? String(p.detail).trim() : "";
        const meta = [p && p.kind, p && p.adapter, p && p.model].filter(Boolean).join(" · ");
        if (detail === "" && meta === "") return null;
        const wrap = document.createElement("div");
        wrap.className = "act-output";
        const head = document.createElement("div");
        head.className = "act-output-head";
        const caret = document.createElement("span");
        caret.className = "act-diff-caret"; caret.textContent = "▸";
        const lbl = document.createElement("span");
        lbl.className = "act-output-lbl"; lbl.textContent = "상세";
        head.appendChild(caret); head.appendChild(lbl);
        const body = document.createElement("div");
        body.className = "act-diff-body";
        const pre = document.createElement("pre");
        pre.className = "act-output-pre";
        pre.textContent = (meta ? meta + "\n\n" : "") + (detail || "(상세 정보 없음)");
        body.appendChild(pre);
        wrap.appendChild(head); wrap.appendChild(body);
        return wrap;
      };

      // ── 표면 A — 백그라운드 셸 인라인 칩 (ADR 2026-07-17 §5-A, Phase 3b) ──────────────
      // 백엔드 무변경(계약: "도구 result 텍스트에 bash_<id> 가 이미 있음 → 클라이언트에서 파싱").
      // file-ops launchBgShell 의 고정 문구 "…(bash_id: bash_xxxxxxxx). BashOutput(…" 만 매칭
      // (codex/openai 전용) — claude SDK 네이티브 Bash 의 tool_result 문구는 다른 포맷("Command
      // running in background with ID: …")이라 이 정규식이 매칭 안 함 = 이 칩은 자연히 미부착.
      // claude 백그라운드 셸은 표면 C(view-shells.js)가 SSE 관측 브리지로 별도 표시(ADR §6) —
      // 의도된 비대칭, cross-adapter 폴백 아님(어댑터 안에서 각자 닫힘, feedback_no_cross_adapter_fallback).
      const SHELL_CHIP_ID_RE = /\(bash_id:\s*(bash_[a-z0-9]+)\)/i;

      const shellChipStatusLabel = (entry) => {
        if (!entry || entry.status === "running") return "실행 중";
        if (entry.status === "killed") return "killed";
        return "exited(" + (entry.exitCode != null ? entry.exitCode : "?") + ")";
      };

      // shellRegistry(view-shells.js 공유, 단일 진실 소스)의 최신 상태를 부착된 칩(들)에 반영.
      // view-shells.js 의 handleShellStarted/handleShellExited·requestKillShell 이 매 상태변화마다
      // 이 함수를 호출(cross-file, typeof 가드 — 로드순서 무관, syncAgentsCounts 패턴 동형).
      const syncShellChip = (shellId) => {
        if (!shellId) return;
        const entry = (typeof shellRegistry !== "undefined") ? shellRegistry.get(shellId) : null;
        const chips = document.querySelectorAll(".act-shell-chip");
        for (const chip of chips) {
          if (chip.dataset.shellId !== shellId) continue;
          const running = !entry || entry.status === "running";
          const dot = chip.querySelector(".act-shell-chip-dot");
          if (dot) dot.className = "act-shell-chip-dot" + (running ? " running" : entry.status === "killed" ? " killed" : " exited");
          const txt = chip.querySelector(".act-shell-chip-txt");
          if (txt) txt.textContent = "🖥️ " + shellChipStatusLabel(entry);
          const killBtn = chip.querySelector(".act-shell-chip-kill");
          if (killBtn) {
            const killable = !entry || entry.killable !== false; // 부재=killable:true(계약).
            killBtn.style.display = (running && killable) ? "" : "none";
            killBtn.disabled = !!(entry && entry.killRequested);
            killBtn.title = entry && entry.killRequested ? "중지 요청…" : "셸 강제 종료";
          }
          const sdkNote = chip.querySelector(".act-shell-chip-sdk");
          if (sdkNote) sdkNote.style.display = (running && entry && entry.killable === false) ? "" : "none";
        }
      };

      // 도구 스텝 라인에 셸 칩을 부착(멱등 — 이미 이 shellId 로 부착돼 있으면 상태만 재동기화).
      // annotateToolDuration(background-drawer.js phase:end)이 output 텍스트에서 shellId 를
      // 찾으면 이 함수를 호출 — 그 자리(백그라운드 Bash 스텝 라인)에 라이브 칩을 얹는다.
      const attachShellChip = (lineEl, shellId) => {
        if (!lineEl || !shellId) return;
        let chip = lineEl.querySelector(":scope > .act-shell-chip");
        if (chip && chip.dataset.shellId === shellId) { syncShellChip(shellId); return; }
        if (chip) chip.remove(); // 방어적(정상 경로 X) — 다른 shellId 칩이 이미 있으면 교체.
        chip = document.createElement("span");
        chip.className = "act-shell-chip";
        chip.dataset.shellId = shellId;
        chip.title = "백그라운드 셸 " + shellId;
        const dot = document.createElement("span"); dot.className = "act-shell-chip-dot running";
        const txt = document.createElement("span"); txt.className = "act-shell-chip-txt"; txt.textContent = "🖥️ 실행 중";
        const sdkNote = document.createElement("span"); sdkNote.className = "act-shell-chip-sdk"; sdkNote.style.display = "none";
        sdkNote.textContent = "SDK 소유"; sdkNote.title = "claude 백그라운드 셸은 대화 턴 안에서만 제어됩니다.";
        const killBtn = document.createElement("button");
        killBtn.type = "button"; killBtn.className = "act-shell-chip-kill"; killBtn.textContent = "⏹️";
        killBtn.title = "셸 강제 종료";
        // 워커/서브 스폰 칩(.act-bg-link)과 클릭 핸들러 패턴 동형 — 스텝 펼침 클릭과 분리.
        killBtn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          if (typeof requestKillShell === "function") void requestKillShell(shellId);
        });
        chip.appendChild(dot); chip.appendChild(txt); chip.appendChild(sdkNote); chip.appendChild(killBtn);
        lineEl.appendChild(chip);
        syncShellChip(shellId); // 부착 시점 최신 상태 즉시 반영(이미 종료돼 있었을 수도 있음).
      };

      const buildActivityLine = (p) => {
        const line = document.createElement("div");
        // 스텝 = 클릭 가능 요소(P4 사이드바 상세가 여기 붙는다). 지금은 자리 예약만(no-op).
        line.className = "act-line act-step";
        line.dataset.threadkey = p.threadKey || "?";
        if (p.seq != null) line.dataset.seq = String(p.seq);
        const skill = skillStepInfo(p);
        const icon = document.createElement("span");
        icon.className = "act-icon";
        icon.textContent = skill ? "🛠" : (p.kind === "tool" ? "🔧" : "▶");
        const label = document.createElement("span");
        label.className = skill ? "act-label act-skill" : "act-label";
        label.textContent = skill ? "스킬: " + skill.name : (p.label || p.kind || "activity");
        // 인라인 상세(중립 detail = path=…, cmd: … 등). 단 diff 있는 스텝(Edit/Write)은 diff
        // 헤더가 경로+N/-M 을 이미 보여주므로 verbose 한 old_string=… 은 접힘 한 줄에서 생략(간결).
        // 스킬 스텝은 detail(=name=…)이 라벨과 중복이라 생략.
        const hasDiff = p.diff && Array.isArray(p.diff.lines);
        const detail = p.detail && !hasDiff && !skill
          ? Object.assign(document.createElement("span"), {
              className: "act-detail", textContent: p.detail,
            })
          : null;
        const meta = document.createElement("span");
        meta.className = "act-meta";
        meta.textContent = (p.model ? p.model + " · " : "") + "#" + (p.seq ?? "");
        line.appendChild(icon); line.appendChild(label);
        if (detail) line.appendChild(detail);
        line.appendChild(meta);
        // 인라인 스폰 스텝 ↔ 백그라운드 잡 링크(2026-07-13) — 서브에이전트/워커를 띄운 스텝이면
        // "🤖 백그라운드 ↗" 칩을 붙인다. 라벨 매칭은 어댑터-불문(원칙 #2): claude native Task
        // (=p.jobId), codex/openai bare `spawn_agent`/`run_in_background`, 그리고 claude 가
        // path= 크로스프로젝트 위임 시 쓰는 MCP 라벨 `mcp__agents__spawn_agent`·
        // `mcp__workers__run_in_background`(접미사 매칭으로 흡수). 클릭 시 드로어를 열고, jobId 가
        // 있으면(claude native Task) 그 잡카드로 스크롤·하이라이트(그 외는 graceful = 드로어 열기만).
        const spawnLabel = p.label || "";
        if (
          p.jobId ||
          spawnLabel === "Task" ||
          spawnLabel.endsWith("spawn_agent") ||
          spawnLabel.endsWith("run_in_background")
        ) {
          const bg = document.createElement("span");
          bg.className = "act-bg-link";
          const job = p.jobId ? jobCards.get(p.jobId) : null;
          const dot = document.createElement("span");
          dot.className = "act-bg-dot" + (job && job.status ? " " + job.status : "");
          const txt = document.createElement("span");
          txt.textContent = "🤖 백그라운드 ↗";
          bg.appendChild(dot); bg.appendChild(txt);
          bg.title = "백그라운드 작업 열기";
          bg.addEventListener("click", (e) => {
            e.stopPropagation(); // 스텝 펼침/상세 클릭과 분리.
            openBg();
            const j = p.jobId ? jobCards.get(p.jobId) : null;
            if (j && j.el && j.el.scrollIntoView) {
              j.el.scrollIntoView({ block: "nearest" });
              j.el.classList.add("bg-flash");
              setTimeout(() => { try { j.el.classList.remove("bg-flash"); } catch {} }, 1500);
            }
          });
          line.appendChild(bg);
        }
        // 리치 diff(Edit/Write) — 있으면 스텝 줄 아래 접이식 블록(flex-wrap 로 다음 줄).
        if (hasDiff) line.appendChild(buildDiffBlock(p.diff));
        // 클릭 = 도구 스텝 펼침/접힘(항상 인라인, sticky·hover 무관). 리치 diff·출력이 있으면
        // 그 블록을, 없으면 인라인 상세 블록(buildDetailBlock)을 lazy 생성해 그 자리에서 펼친다.
        // (2026-07-15 — 옛 사이드바 상세 분기 제거, 모든 도구 클릭을 인라인 펼침으로 통일.)
        line.addEventListener("click", () => {
          let block = line.querySelector(":scope > .act-diff, :scope > .act-output");
          if (!block) {
            const stored = activityByStep.get(stepKey(line.dataset.threadkey, line.dataset.seq)) || p;
            block = buildDetailBlock(stored);
            if (block) line.appendChild(block);
          }
          if (block) line.classList.toggle("expanded");
        });
        return line;
      };

      // 서브에이전트 threadKey = `${부모}::sub::<name>::<ts>` (agent-registry spawn_agent).
      // → 에이전트명 추출(없으면 null). 멀티에이전트 턴에서 "누가 무엇을" 구분 라벨용.
      const agentOfThread = (thread) => {
        const m = /::sub::(.+?)::/.exec(thread || "");
        return m ? m[1] : null;
      };

      // 턴 그룹 = 스텝 리스트(접이식 turn-card) + 답변 버블을 한 묶음으로 잡는 컨테이너.
      // 그룹 자체가 stream 에 삽입되고, 그 안에 스텝 카드 → (도착 시) 답변 버블 순으로 쌓인다.
      const createTurnCard = (p, ts, adapter, thread) => {
        const group = document.createElement("div");
        group.className = "turn-group";
        group.dataset.threadkey = thread;
        // 로그 패널 필터(stream 직속 자식의 dataset.type 매칭)와 일관되도록 그룹에도 타입 표기.
        group.dataset.type = "llm.activity";

        applyFilter(group);
        const el = document.createElement("div");
        el.className = "ev turn-card in-group";
        el.dataset.type = "llm.activity";
        el.dataset.threadkey = thread;
        const head = document.createElement("div");
        head.className = "turn-head";
        const caret = document.createElement("span");
        caret.className = "turn-caret"; caret.textContent = "▼";
        const badge = document.createElement("span");
        badge.className = "act-badge act-" + adapter;
        badge.textContent = p.adapter || "?";
        const th = document.createElement("span");
        th.className = "turn-thread"; th.textContent = thread;
        const tsEl = document.createElement("span");
        tsEl.className = "ts"; tsEl.textContent = ts;
        const lastEl = document.createElement("span");
        lastEl.className = "turn-last"; lastEl.textContent = "";
        const countEl = document.createElement("span");
        countEl.className = "turn-count"; countEl.textContent = "0단계";
        head.appendChild(caret); head.appendChild(badge);
        // 서브에이전트면 "🤖 <name>" 라벨 — 누가 하는 작업인지 한눈에. raw threadKey 는 숨김.
        const agentName = agentOfThread(thread);
        if (agentName) {
          const ab = document.createElement("span");
          ab.className = "agent-badge";
          ab.textContent = "🤖 " + agentName;
          head.appendChild(ab);
          th.style.display = "none";
        }
        head.appendChild(th);
        head.appendChild(tsEl); head.appendChild(lastEl); head.appendChild(countEl);
        const body = document.createElement("div");
        body.className = "turn-body";
        // 수동 접힘(.collapsed) = 두 패널 공통(헤더 클릭, 기존 로그 토글 보존).
        // 완료 자동접힘(.done-collapsed) = 채팅 패널만(로그 패널 회귀 0). 수동 클릭이 우선.
        const setOpen = (open) => {
          el.classList.toggle("collapsed", !open);
          el.classList.remove("done-collapsed"); // 수동 조작이 자동접힘을 해제.
          caret.textContent = open ? "▼" : "▶";
        };
        head.addEventListener("click", () => setOpen(
          el.classList.contains("collapsed") || el.classList.contains("done-collapsed"),
        ));
        el.appendChild(head); el.appendChild(body);
        group.appendChild(el);
        // replyBubble = 이 턴의 진행(타이핑) 답변 슬롯(P5). 첫 delta 때 생성, out 도착 시 승격.
        return {
          group, el, body, countEl, lastEl, setOpen,
          lastSeq: -1, count: 0, closed: false,
          replyBubble: null, replyMsg: null, replyRaw: "",
          // 인터리브(2026-07-13): sawTextSegment=이 턴이 kind:"text" 세그먼트를 냈나(out 중복 방지),
          // closedByText=직전 텍스트 세그먼트가 도구 런을 닫음(다음 도구는 새 카드로 → 텍스트↔도구 교차).
          sawTextSegment: false, closedByText: false,
        };
      };

      // delta-only 턴(스텝 활동 없이 토큰만 오는 경우)용 경량 그룹 — 진행 버블만 담는다.
      // 이후 activity 가 오면 renderActivity 의 isNewTurn 판정(seq 리셋/closed)으로 자연 정리.
      const createDeltaGroup = (p, ts, adapter, thread) => {
        const group = document.createElement("div");
        group.className = "turn-group";
        group.dataset.threadkey = thread;
        group.dataset.type = "channel.message.out";
        applyFilter(group);
        return {
          group, el: null, body: null, countEl: null, lastEl: null,
          setOpen: () => {}, lastSeq: -1, count: 0, closed: false,
          replyBubble: null, replyMsg: null, replyRaw: "",
          sawTextSegment: false, closedByText: false, // 인터리브 상태(createTurnCard 와 동형).
        };
      };

      // 진행(타이핑) 버블을 그 턴 그룹 안(스텝 카드 아래)에 생성. 평문 누적용 빈 버블.
      const ensureReplyBubble = (card, ts) => {
        if (card.replyBubble) return card.replyBubble;
        const div = document.createElement("div");
        div.className = "ev local channel-chat";
        div.dataset.type = "channel.message.out";
        const head = document.createElement("div");
        const tsEl = document.createElement("span");
        tsEl.className = "ts"; tsEl.textContent = ts;
        const tyEl = document.createElement("span");
        tyEl.className = "type"; tyEl.textContent = assistantName;
        head.appendChild(tsEl); head.appendChild(tyEl);
        div.appendChild(head);
        const msg = document.createElement("div");
        // streaming = 평문 + 깜빡이는 커서. out 도착 시 마크다운 전체본으로 승격(streaming 제거).
        msg.className = "chat-message streaming";
        div.appendChild(msg);
        card.group.appendChild(div); // 스텝 카드(있으면) 다음 = 라이브 답변 슬롯.
        card.replyBubble = div;
        card.replyMsg = msg;
        card.replyRaw = "";
        return div;
      };

