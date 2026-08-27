// 대화 검색 — 전 세션 가로질러 (2026-08-23)
//
// 사용자 결정: **버튼 → 드로어**("검색 버튼이 따로 있는 건 어때?" → "아예 다른 패널로
// 뜨는 게 어떨까, 백그라운드 패널처럼"). 검색은 가끔 쓰므로 상시 입력창으로 채팅 상단을
// 늘 먹지 않고, 인라인 패널도 열릴 때마다 대화를 아래로 밀어 같은 문제였다.
//
// ★백그라운드 패널과 달리 **레이아웃을 밀지 않는다**(사용자: "사이즈 연동은 아니고") —
//  열고 닫기가 잦은 흐름이라 채팅 폭이 그때마다 바뀌면 더 성가시다. `body.cs-open` 이
//  패널만 슬라이드한다.
//
// ★여기는 **배관만** 한다: 질의 정규화·스니펫·세션 표시명은 전부 서버가 정한다
//  (`core/chat-search.ts` + `store/chat-log.ts`). 클라가 파생하면 같은 세션이 화면마다
//  다른 이름으로 보인다 — `/sessions` 가 이미 겪고 서버로 옮긴 문제라 두 번 겪지 않는다.
//
// ★세션 점프는 `window.openSessionByKey`(tabs.js) 하나로 간다. 탭 생성 규칙을 여기서
//  다시 만들면 두 번째 규칙이 생긴다.
(() => {
  const btn = document.getElementById("chat-search-btn");
  const panel = document.getElementById("cs-panel");
  const backdrop = document.getElementById("cs-backdrop");
  const input = document.getElementById("chat-search-input");
  const closeBtn = document.getElementById("chat-search-close");
  const statusEl = document.getElementById("chat-search-status");
  const resultsEl = document.getElementById("chat-search-results");
  const countEl = document.getElementById("chat-search-count");
  const prevBtn = document.getElementById("chat-search-prev");
  const nextBtn = document.getElementById("chat-search-next");
  if (!btn || !panel || !input || !resultsEl) return;

  const MIN_LEN = 2; // 서버 MIN_QUERY_LEN 과 같은 값 — 서버가 최종 판정(여기선 조기 안내만).
  let seq = 0; // 늦게 도착한 응답이 새 질의 결과를 덮지 않게.
  let timer;
  // ★결과를 눌러도 드로어를 **안 닫는다** (2026-08-23 사용자 요청) — 브라우저 기본 찾기처럼
  //  "3/5" 를 보며 이전·다음으로 오간다. 그래서 목록과 커서를 들고 있어야 한다.
  let hits = [];
  let cursor = -1; // 현재 보고 있는 결과 index. -1 = 아직 안 고름.
  // ── 더보기 (2026-08-23 사용자 요청: "50개 넘어서도 보여줘야 할 것 같은데") ─────────
  //  ★상한을 올리는 대신 **이어 받는다.** 1,438건을 한 번에 뿌리면 사람이 훑을 양이
  //   아니고 DOM 만 무거워진다. 목록 바닥에 닿으면 다음 50건을 붙인다(채팅의 "위로
  //   스크롤하면 과거를 더 불러온다" 와 같은 몸짓 — 같은 문제엔 같은 해법).
  let curQuery = "";   // 지금 화면에 뿌려진 결과의 질의(더보기가 같은 질의로 이어받게).
  let total = 0;       // 서버가 센 실제 매치 수.
  let loadingMore = false;
  let exhausted = false;

  // ── 세션 좁히기 (2026-08-26 사용자 요청) ────────────────────────────────────
  //  ★**입구는 둘, 상태는 하나**다: 「이 세션만」 토글과 결과의 세션 라벨 클릭이 같은 값을
  //   세팅한다. 두 벌을 두면 토글과 칩이 서로 다른 말을 하게 된다.
  //  ★목록형 선택자를 안 만든 이유는 실측이다 — 최근 30일 활동 세션 **53개 중 이름 붙은 게
  //   7개**라(나머지는 `dashboard:<uuid>`) 목록에서 **고를 수가 없다.** 그래서 "고르기" 를
  //   **"보고 나서 좁히기"** 로 뒤집었다: 결과에 이미 세션 라벨이 있으니 그걸 누른다.
  //  ★거르지 않고 **다시 던진다**. 전체 결과가 50건 상한이라 클라에서 거르면 그 세션 것이
  //   상한 밖으로 밀려 "있는데 안 나오는" 상태가 된다.
  const mineToggle = document.getElementById("chat-search-mine");
  const scopeChip = document.getElementById("chat-search-scope-chip");
  let scopeKey = null; // threadKey | null(전 세션)
  let scopeLabel = ""; // 사람이 읽는 이름 — 없으면 threadKey 를 그대로 쓴다

  /**
   * 검색 URL — **한 곳에서만 만든다.** 첫 질의와 더보기(커서)가 각자 조립하면 한쪽에만
   * 필터가 실려 "좁혔는데 더보기하면 전 세션이 섞이는" 상태가 된다.
   */
  const searchUrl = (q, extra) =>
    `/api/chat-search?q=${encodeURIComponent(q)}&limit=50` +
    (scopeKey !== null ? `&threadKey=${encodeURIComponent(scopeKey)}` : "") +
    (extra || "");

  /**
   * 좁히기를 세팅/해제하고 **다시 검색한다**. 입구가 어디든 여기로 모인다.
   * @param key threadKey, 또는 `null` 이면 전 세션
   */
  const setScope = (key, label) => {
    const next = key || null;
    if (next === scopeKey) return; // 같은 값 재적용 = 질의 낭비.
    scopeKey = next;
    scopeLabel = next === null ? "" : label || sessionNameFor(next) || next;
    if (mineToggle) mineToggle.checked = scopeKey !== null && scopeKey === activeThreadKey;
    if (scopeChip) {
      if (scopeKey === null) {
        scopeChip.hidden = true;
        scopeChip.textContent = "";
      } else {
        scopeChip.hidden = false;
        // ★칩이 **무엇으로 좁혀졌는지** 말한다. 안 보이면 "왜 결과가 없지" 가 된다.
        scopeChip.textContent = i18n("search.scope.chip", { name: scopeLabel }) + " ✕";
        scopeChip.title = i18n("search.scope.clear");
      }
    }
    // 거르지 않고 다시 던진다 — 이유는 위 블록 주석(50건 상한).
    if (curQuery !== "") run(curQuery);
  };

  const setStatus = (t) => {
    if (statusEl) statusEl.textContent = t;
  };

  if (mineToggle) {
    mineToggle.addEventListener("change", () => {
      setScope(mineToggle.checked ? activeThreadKey : null);
    });
  }
  if (scopeChip) scopeChip.addEventListener("click", () => setScope(null));

  const isOpen = () => document.body.classList.contains("cs-open");
  const open = () => {
    document.body.classList.add("cs-open");
    panel.setAttribute("aria-hidden", "false");
    input.focus();
    input.select();
  };
  // ★결과를 비우는 자리는 **다섯 곳**이고(닫기·HTTP 실패·너무짧음·서버 tooShort·네트워크
  //  실패) 전부 같은 판단이다. 종전엔 그 판단이 분기마다 손으로 흩어져 있었고 **HTTP 실패
  //  한 곳에만 완전판**이 들어갔다 — 나머지는 목록만 지우고 `hits`·`cursor` 를 남겼다.
  //  실측(2026-08-23 2라운드 D4): 백스페이스 한 번으로 두 글자 미만이 되면 화면은 0행인데
  //  카운터가 `0/50` 이고 ↑ 를 누르면 사라진 결과의 대화로 점프했다. 목록을 지우는 것과
  //  상태를 비우는 것이 갈리면 화면과 상태가 어긋난다 — 한 함수로 묶어 갈릴 수 없게 한다.
  const clearResults = () => {
    resultsEl.textContent = "";
    hits = [];
    cursor = -1;
    curQuery = "";
    syncNav();
  };
  const close = () => {
    document.body.classList.remove("cs-open");
    panel.setAttribute("aria-hidden", "true");
    setStatus("");
    clearResults();
  };

  const fmtWhen = (ts) => {
    try {
      const d = new Date(ts);
      const now = new Date();
      const sameDay =
        d.getFullYear() === now.getFullYear() &&
        d.getMonth() === now.getMonth() &&
        d.getDate() === now.getDate();
      const hh = String(d.getHours()).padStart(2, "0");
      const mm = String(d.getMinutes()).padStart(2, "0");
      return sameDay
        ? `${hh}:${mm}`
        : `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
    } catch {
      return "";
    }
  };

  // 기호 제거 규칙은 `markdown.js` 의 `stripMarkdownText` 한 곳 — 전체 활동의 한 줄
  // 프리뷰도 같은 것을 쓴다(같은 질문엔 같은 답).
  const stripMarkdown = (raw) =>
    typeof stripMarkdownText === "function" ? stripMarkdownText(raw) : String(raw ?? "");

  /**
   * 스니펫을 렌더하고 매치를 강조한다. 텍스트 노드로만 짓는다(`innerHTML` X — 남의 대화 본문).
   *
   * ★강조 위치는 **정리된 텍스트에서 다시 찾는다.** 서버가 준 `matchStart` 는 기호가 붙은
   *  원문 기준이라, 기호를 걷어내면 그만큼 어긋난다(`**윈도우**` 면 2칸). 질의는 클라가
   *  들고 있으니 다시 찾는 게 정확하다 — **무엇을 찾을지**(스니펫 범위·세션명)는 그대로
   *  서버 판정을 따른다.
   */
  const renderSnippet = (hit, query) => {
    const frag = document.createDocumentFragment();
    const text = stripMarkdown(hit.snippet);
    const q = String(query ?? "").trim();
    const at = q === "" ? -1 : text.toLowerCase().indexOf(q.toLowerCase());
    if (at < 0) {
      frag.appendChild(document.createTextNode(text));
      return frag;
    }
    frag.appendChild(document.createTextNode(text.slice(0, at)));
    const mk = document.createElement("mark");
    mk.textContent = text.slice(at, at + q.length);
    frag.appendChild(mk);
    frag.appendChild(document.createTextNode(text.slice(at + q.length)));
    return frag;
  };

  /** "3/5" 와 이전·다음 버튼 상태 — 커서가 바뀔 때마다 한 곳에서 갱신한다. */
  const syncNav = () => {
    const n = hits.length;
    if (countEl) countEl.textContent = n === 0 ? "" : `${cursor < 0 ? 0 : cursor + 1}/${n}`;
    if (prevBtn) prevBtn.disabled = n === 0;
    if (nextBtn) nextBtn.disabled = n === 0;
    [...resultsEl.querySelectorAll(".cs-hit")].forEach((el, i) => {
      el.classList.toggle("cs-active", i === cursor);
    });
  };

  /** i 번째 결과로 이동 — 목록은 그대로 두고 대화만 옮긴다. 양끝에서 순환한다. */
  const goTo = (i) => {
    if (hits.length === 0) return;
    cursor = ((i % hits.length) + hits.length) % hits.length;
    syncNav();
    const row = resultsEl.querySelectorAll(".cs-hit")[cursor];
    if (row && row.scrollIntoView) row.scrollIntoView({ block: "nearest" });
    const hit = hits[cursor];
    if (typeof window.openSessionByKey !== "function") {
      setStatus(i18n("search.jump.noTabs"));
      return;
    }
    // 못 닿으면 **말한다** — 조용히 넘어가면 사용자는 클릭이 씹혔다고 읽는다.
    window.notifyJumpMiss = (why) => {
      setStatus(
        why === "not-found"
          ? i18n("search.jump.tooOld")
          : i18n("search.jump.failed"),
      );
    };
    const ok = window.openSessionByKey(hit.threadKey, {
      label: hit.sessionLabel,
      channel: hit.channel,
      jumpTs: hit.ts,
    });
    if (!ok) setStatus(i18n("search.jump.noSession"));
  };

  const render = (found, query, meta, append) => {
    if (append !== true) {
      resultsEl.textContent = "";
      hits = [];
      cursor = -1;
      exhausted = false;
    }
    curQuery = query;
    if (meta && typeof meta.total === "number") total = meta.total;
    const before = hits.length;
    hits = append === true ? hits.concat(found) : found;
    if (found.length === 0) exhausted = true;
    syncNav();
    void before;
    if (hits.length === 0) {
      // ★좁혀진 상태에서 0건이면 **왜 없는지**와 **빠져나갈 길**을 같이 말한다 —
      //  안 그러면 "검색이 고장났나" 로 읽힌다(칩은 위에 있지만 눈이 결과 쪽에 있다).
      setStatus(
        i18n("search.noResults", { q: query }) +
          (scopeKey !== null ? " " + i18n("search.scope.emptyHere") : ""),
      );
      return;
    }
    if (hits.length >= total) exhausted = true;
    // ★얼마나 보고 있는지 **항상** 말한다. 종전엔 "50건" 이라고만 해서 그게 전부인 줄
    //  알았다(실측: `는` 은 1,438건). 이제 더 있으면 이어 받으므로, 남았다는 사실도 함께.
    setStatus(
      hits.length < total
        ? i18n("search.partial", { q: query, total: total.toLocaleString(), shown: hits.length })
        : i18n("search.count", { q: query, n: hits.length.toLocaleString() }),
    );
    for (const hit of (append === true ? found : hits)) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "cs-hit";
      row.title = i18n("search.jump.action");

      const head = document.createElement("div");
      head.className = "cs-hit-head";
      const who = document.createElement("span");
      who.className = "cs-hit-role";
      who.textContent = hit.role === "user" ? i18n("common.sender.me") : i18n("common.sender.assistant");
      // ★세션 라벨이 곧 **좁히기 입구**다(2026-08-26). 목록형 선택자를 못 두는 대신
      //  (이름 없는 세션이 대부분) 결과를 보고 그 세션으로 좁힌다. 행 전체는 "그 대화로
      //  점프" 이므로 여기서 전파를 끊는다.
      const sess = document.createElement("span");
      sess.className = "cs-hit-session";
      sess.textContent = hit.sessionLabel || hit.threadKey;
      sess.title = i18n("search.scope.chip", { name: hit.sessionLabel || hit.threadKey });
      sess.addEventListener("click", (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
        setScope(hit.threadKey, hit.sessionLabel);
      });
      const when = document.createElement("span");
      when.className = "cs-hit-when";
      when.textContent = fmtWhen(hit.ts);
      head.append(who, sess, when);

      const body = document.createElement("div");
      body.className = "cs-hit-body";
      body.appendChild(renderSnippet(hit, query));

      row.append(head, body);
      // ★닫지 않는다. 누른 것을 커서로 삼고 목록은 그대로 — 이어서 이전·다음으로 오간다
      //  (2026-08-23 사용자 요청). 이동·안내는 전부 `goTo` 한 곳이 한다.
      const myIndex = resultsEl.querySelectorAll(".cs-hit").length;
      row.addEventListener("click", () => goTo(myIndex));
      resultsEl.appendChild(row);
    }
  };

  /** 목록 바닥 근처 → 다음 50건. 같은 질의로 이어받고, 다 받았으면 조용히 멈춘다. */
  const loadMore = async () => {
    if (loadingMore || exhausted || hits.length === 0 || curQuery === "") return;
    loadingMore = true;
    // ★`run()` 에 있는 "늦은 응답 버리기" 가 여기에도 있어야 한다 (2026-08-23 적대 검토).
    //  없으면 더보기 인플라이트 중에 새 질의가 렌더된 뒤 옛 히트가 **새 목록 뒤에 붙고**
    //  `total` 까지 옛 값으로 덮인다(질의가 달라 강조도 안 됨). 같은 판단이 두 곳인데
    //  한 곳에만 있었다.
    //  ★단 **읽기만 한다** — 올리면 안 된다 (2026-08-23 2라운드 D3). 종전엔 `++seq` 라
    //   더보기가 **먼저 시작한 새 질의의 응답을 무효화**했다: 사용자가 새 검색어를 치고
    //   그 응답이 오기 전에 옛 목록을 스크롤하면, 친 검색이 아무 일도 없던 것처럼
    //   사라지고 옛 결과가 그대로 남았다(헤드리스 실증). `seq` 를 올릴 권리는 **새 질의를
    //   여는 쪽**(`run`)에만 있다. 여기 필요한 건 "그 사이 새 질의가 떴는가" 관찰뿐이다.
    const my = seq;
    const q0 = curQuery;
    try {
      const cursorTs = hits[hits.length - 1].ts;
      const r = await fetch(
        searchUrl(
          q0,
          `&beforeTs=${cursorTs}` +
            // 복합 커서 — 같은 ts 가 여럿일 때 경계 행이 유실되는 것을 막는다(검토 D-1).
            (typeof hits[hits.length - 1].id === "number"
              ? `&beforeId=${hits[hits.length - 1].id}`
              : ""),
        ),
      );
      if (my !== seq || q0 !== curQuery) return; // 더 새 질의가 떴다 — 이 응답은 버린다.
      if (!r.ok) return;
      const data = await r.json().catch(() => ({}));
      if (my !== seq || q0 !== curQuery) return;
      const more = Array.isArray(data.hits) ? data.hits : [];
      if (more.length === 0) { exhausted = true; return; }
      render(more, q0, { total: typeof data.total === "number" ? data.total : total }, true);
    } catch (e) {
      console.warn("chat-search 더보기 실패:", e && e.message ? e.message : e);
    } finally {
      loadingMore = false;
    }
  };
  resultsEl.addEventListener("scroll", () => {
    const gap = resultsEl.scrollHeight - resultsEl.scrollTop - resultsEl.clientHeight;
    if (gap < 240) void loadMore();
  });

  const run = async (raw) => {
    const q = String(raw ?? "").trim();
    if (q.length < MIN_LEN) {
      // ★`seq` 를 여기서도 올린다 (2026-08-23 3라운드). 안 올리면 **지운 질의의 응답**이
      //  뒤늦게 도착해 되살아난다 — 실측(지연 1.2초): "알파" 를 치고 응답 전에 "알" 로
      //  백스페이스하면 목록에 50행이 뜨고 카운터가 `0/50` 인 채 붙는다. 거기서 ↑ 를
      //  누르면 사라진 검색의 대화로 점프한다. `clearResults()` 는 **화면**을 비울 뿐
      //  날아오는 응답을 무효화하지 못한다. 질의를 닫는 것도 `run` 의 일이다.
      seq += 1;
      clearResults();
      setStatus(q === "" ? "" : i18n("search.tooShort", { n: MIN_LEN }));
      return;
    }
    const my = ++seq;
    setStatus(i18n("search.searching"));
    try {
      const r = await fetch(searchUrl(q));
      if (my !== seq) return; // 더 새 질의가 떴다 — 이 응답은 버린다.
      const data = await r.json().catch(() => ({}));
      if (!r.ok || data.error) {
        // ★옛 결과를 남기지 않는다 — 남기면 "실패" 문구 아래 이전 질의 결과가 보이고,
        //  그 상태에서 ↑/↓ 를 누르면 엉뚱한 대화로 점프한다(적대 검토 D9).
        clearResults();
        setStatus(i18n("search.failed", { err: data.error || r.status }));
        return;
      }
      if (data.tooShort === true) {
        clearResults();
        setStatus(i18n("search.tooShort", { n: MIN_LEN }));
        return;
      }
      render(Array.isArray(data.hits) ? data.hits : [], q, {
        total: typeof data.total === "number" ? data.total : null,
        limit: typeof data.limit === "number" ? data.limit : null,
      });
    } catch (e) {
      if (my !== seq) return;
      clearResults();
      setStatus(i18n("search.failed", { err: e && e.message ? e.message : e }));
    }
  };

  // ── 폭 드래그 조절 + 영속 (2026-08-23 사용자 요청) ──────────────────────────────
  //  백그라운드 패널과 **같은 몸짓**(왼쪽 가장자리 드래그, localStorage 저장). 단 그쪽처럼
  //  `--bg-panel-w` 로 레이아웃을 밀지 않는다 — 검색은 채팅 폭을 안 바꾸기로 했으므로
  //  공유 변수를 만들 이유가 없다(안 쓰는 상태를 만들면 다음 사람이 쓴다).
  //  PC 전용 — 모바일은 핸들을 숨긴다(폭이 화면 폭이라 조절할 게 없다).
  (() => {
    const handle = document.getElementById("cs-resize");
    if (handle === null) return;
    const KEY = "tc:csPanelWidth";
    const clamp = clampDrawerWidth; // 백그라운드 패널과 **같은 한계**(constants.js).
    const apply = (w) => { panel.style.width = `${clamp(w)}px`; };
    const saved = parseInt(localStorage.getItem(KEY) || "", 10);
    if (Number.isFinite(saved)) apply(saved);
    let dragging = false;
    window.addEventListener("mousemove", (e) => {
      if (dragging) apply(window.innerWidth - e.clientX);
    });
    window.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      handle.classList.remove("dragging");
      document.body.classList.remove("cs-resizing");
      try {
        localStorage.setItem(KEY, String(parseInt(panel.style.width, 10)));
      } catch {
        /* quota·프라이빗 모드 — 이번 세션에만 적용될 뿐 동작은 정상 */
      }
    });
    handle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      dragging = true;
      handle.classList.add("dragging");
      document.body.classList.add("cs-resizing");
    });
  })();

  btn.addEventListener("click", () => (isOpen() ? close() : open()));
  if (closeBtn) closeBtn.addEventListener("click", close);
  // 드로어 바깥을 누르면 닫힌다 — 백그라운드 패널과 같은 몸짓(같은 부류는 같게).
  if (backdrop) backdrop.addEventListener("click", close);
  // Esc 는 입력창에 포커스가 없어도 먹어야 한다(결과를 스크롤하다 닫는 흐름).
  // ★Ctrl/⌘+F = 대화 검색 (2026-08-23 사용자 요청). Slack·Discord 와 같은 몸짓이다.
  //  ★**채팅 화면일 때만** 가로챈다 — 대시보드 다른 화면(홈·모듈·인벤토리…)에서 이걸
  //   먹으면 브라우저 기본 찾기를 빼앗아 그 화면에서 텍스트를 못 찾는다. 우리가 대신
  //   줄 게 없는 자리에서 남의 기능을 뺏지 않는다. 판정은 `document.body.dataset.view`
  //   (`setActiveNav` 가 이미 쓰는 값) — 새 상태를 만들지 않는다.
  //  ★이미 열려 있으면 **닫지 않고 입력창에 포커스**한다. 브라우저 찾기의 관습이고,
  //   결과를 보다 다시 Ctrl+F 를 누르는 흐름에서 토글이면 패널이 사라져 성가시다.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isOpen()) {
      close();
      return;
    }
    const isFind = (e.ctrlKey || e.metaKey) && !e.altKey && (e.key === "f" || e.key === "F");
    if (!isFind) return;
    if (document.body.dataset.view !== "chat") return; // 다른 화면 = 브라우저 찾기 그대로.
    e.preventDefault();
    if (isOpen()) {
      input.focus();
      input.select();
    } else {
      open();
    }
  });
  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => void run(input.value), 220); // 타이핑마다 때리지 않는다.
  });
  if (prevBtn) prevBtn.addEventListener("click", () => goTo(cursor - 1));
  if (nextBtn) nextBtn.addEventListener("click", () => goTo(cursor + 1));
  // ★키 배정 (2026-08-23 사용자 확정): **↑/↓ = 이전/다음, Enter = 검색.**
  //  처음엔 브라우저 찾기 관습대로 Enter 를 "다음" 에 걸었는데, 여기는 검색창이 계속
  //  떠 있는 패널이라 타이핑을 끝내고 누르는 Enter 가 "찾아라" 로 읽히는 게 자연스럽다.
  //  ★패널 전체에 건다 — 결과 행을 클릭한 뒤에도 포커스가 입력창 밖에 있으므로,
  //   입력창에만 걸면 그때부터 화살표가 안 먹는다(이동 중에 못 이동하는 꼴).
  panel.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { close(); return; }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (hits.length === 0) return;
      e.preventDefault(); // 입력창 캐럿 이동·목록 스크롤 대신 결과 이동.
      goTo(e.key === "ArrowDown" ? cursor + 1 : cursor - 1);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      clearTimeout(timer);
      void run(input.value); // 디바운스를 안 기다리고 즉시 검색.
    }
  });
})();
