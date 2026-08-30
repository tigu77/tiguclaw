/**
 * 회귀: **채팅 검색이 단어 안쪽까지 찾는다** + 결과가 어느 세션인지 말한다 (2026-08-22).
 *
 * ★이름을 고쳤다 (2026-08-25 사용자: *"chat-search-finds-korean 이건 뭐야 언어특정일 필요
 *  있나"*). 맞는 지적이다 — 지키는 **성질**은 "단어 경계 안쪽도 찾는다" 이고, 한국어는
 *  그게 처음 깨진 **사례**일 뿐이다. 같은 성질이 필요한 곳은 더 있다: 영어 `update` 를
 *  쳐서 `updated` 를 찾는 것, 독일어 합성어, 일본어·터키어 교착. 이름이 사례를 말하면
 *  다른 언어에서 같은 결함이 나도 "그건 저 검사 밖" 처럼 읽힌다.
 *
 * ★왜 LIKE 인가 — FTS5 기본 토크나이저는 `윈도우에서` 를 한 토큰으로 잘라 `윈도우`
 *  검색에 **안 걸린다**(통제 실험으로 확인). 어미·조사가 붙거나 말이 이어 붙는 언어에선
 *  부분일치가 곧 사용자의 기대다. 규모도 그걸 허락한다(실측 3,947행·2MB 스캔 14ms). 여기에 FTS 색인을 새로
 *  만들면 SQLite 가 이미 주는 것을 재구현하는 것이다(원칙 #5).
 *  → 그래서 이 검사는 **"부분일치가 되는가"** 를 지킨다. 구현이 무엇이든(LIKE 든 trigram
 *    FTS 든) 조사 붙은 어절을 못 찾으면 빨간불이다 — 검사가 지키는 것은 **동작**이지
 *    구현이 아니다(2026-08-23 정정: FTS5 `tokenize='trigram'` 은 부분일치가 되므로,
 *    "FTS 로 갈면 빨간불" 은 틀린 말이었다. 근거는 `core/chat-search.ts` 주석에).
 *
 * ★판단이 순수 함수(`core/chat-search.ts`)라 **동작을 직접 돌린다** — 데몬을 안 띄운다.
 *  브리지 핸들러에 뒀다면 정규식 grep 밖에 못 했을 검사다(원칙 게이트 Q7).
 */
import {
  MIN_QUERY_LEN,
  makeSnippet,
  normalizeChatQuery,
} from "../../core/chat-search.js";
import { sourceHas } from "./_wiring.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const run = async (): Promise<Assertion[]> => {
  const out: Assertion[] = [];

  // ── ① 질의 정규화 — 너무 짧으면 안 받는다(한 글자는 사실상 전체 스캔) ────────
  out.push(
    assert(
      "한 글자 질의는 거절한다",
      normalizeChatQuery("가") === null && MIN_QUERY_LEN === 2,
      `MIN_QUERY_LEN=${MIN_QUERY_LEN}`,
    ),
  );
  out.push(
    assert(
      "공백만 있는 질의는 거절한다",
      normalizeChatQuery("   ") === null,
      "빈 질의 거절",
    ),
  );

  // ── ② ★LIKE 와일드카드 무력화 — `100%` 를 치면 `%` 는 **글자**여야 한다 ──────
  //  안 막으면 `%` 가 와일드카드로 동작해 엉뚱한 게 잡힌다. 검색창에 친 글자는 글자다.
  {
    const q = normalizeChatQuery("100% 확실");
    const ok = q !== null && q.like.includes("100\\%") && !q.like.includes("100% ");
    out.push(
      assert(
        "★`%`·`_` 를 이스케이프한다(사용자가 친 글자를 글자로 찾는다)",
        ok,
        ok ? `like=${q?.like}` : `★와일드카드가 살아 있다 — like=${q?.like}`,
      ),
    );
    const b = normalizeChatQuery("a\\b_c");
    const okb =
      b !== null && b.like.startsWith("a\\\\b") && b.like.includes("\\_c");
    out.push(
      assert(
        "역슬래시를 **먼저** 이스케이프한다(순서가 틀리면 이중 이스케이프)",
        okb,
        okb ? `like=${b?.like}` : `★순서 오류 — like=${b?.like}`,
      ),
    );
  }

  // ── ③ ★한국어 조사 어절 부분일치 — 이 기능의 존재 이유 ─────────────────────
  {
    const q = normalizeChatQuery("윈도우");
    const hay = "어제 윈도우에서 데몬이 죽었다";
    // LIKE 는 부분일치라 `윈도우에서` 안의 `윈도우` 를 찾는다. 스니펫이 그걸 짚어야 한다.
    const s = q === null ? null : makeSnippet(hay, q);
    const found = s !== null && s.matchStart >= 0;
    out.push(
      assert(
        "★조사가 붙은 어절(`윈도우에서`)에서 `윈도우` 를 찾는다",
        found,
        found
          ? `matchStart=${s?.matchStart}`
          : "★못 찾는다 — 부분일치가 깨졌다(FTS 토크나이저와 같은 증상)",
      ),
    );
  }

  // ── ④ 스니펫은 일치 **주변**을 준다 — 앞부분만 주면 왜 걸렸는지 모른다 ───────
  {
    const q = normalizeChatQuery("바늘");
    const hay = `${"가".repeat(300)} 바늘 ${"나".repeat(300)}`;
    const s = q === null ? null : makeSnippet(hay, q);
    const centered =
      s !== null &&
      s.matchStart > 0 &&
      s.text.includes("바늘") &&
      s.text.startsWith("…") &&
      s.text.endsWith("…");
    out.push(
      assert(
        "★긴 글에서 일치 주변을 잘라 준다(앞부분만 X)",
        centered,
        centered ? `len=${s?.text.length}` : `★주변이 안 나온다 — ${s?.text.slice(0, 40)}`,
      ),
    );
  }

  // ── ⑤ 대소문자 무시 — `Windows` 로 쳐도 `windows` 를 찾는다 ─────────────────
  {
    const q = normalizeChatQuery("WINDOWS");
    const s = q === null ? null : makeSnippet("a windows b", q);
    out.push(
      assert(
        "대소문자를 무시하고 찾는다",
        s !== null && s.matchStart >= 0,
        `matchStart=${s?.matchStart}`,
      ),
    );
  }

  // ── ⑥ ★세션 구분이 결과에 실린다 (사용자 요구) ──────────────────────────────
  //  가로질러 찾는 순간 "이게 어느 대화였나" 가 첫 질문이다. 그리고 표시명은 **서버가**
  //  정한다 — 클라가 threadKey 로 파생하면 같은 세션이 화면마다 다른 이름으로 보인다
  //  (`/sessions` 가 이미 겪고 서버로 옮긴 문제라, 두 번째로 겪지 않는다).
  {
    // ★**쿼리를 실제로 돌린다** (2026-08-23). 종전엔 이 자리가 SQL 을 **문자열로 대조**
    //  했고, 하필 그 문자열이 틀린 조인(`t.thread_key`)이었다 — `threads` 의 키 컬럼은
    //  `channel_thread_id` 다. 그래서 검사는 초록인데 **엔드포인트는 항상 500**
    //  (`no such column: t.thread_key`)이었고, 아무도 몰랐다. 검사가 틀린 구현을
    //  박제한 것이다([[feedback_gate_must_actually_run]] — 오늘 세 번째 같은 부류).
    //  이제 진짜 DB 에 넣고 진짜로 찾는다. 스키마가 바뀌면 여기서 터진다.
    const { initStore, getDb, setThreadName } = await import("../../store/sessions.js");
    const { recordChatMessage, searchChatLog } = await import("../../store/chat-log.js");
    initStore();
    const tk = `dashboard:regr-chat-search-${Date.now()}`;
    getDb()
      .prepare(
        `INSERT OR IGNORE INTO threads
           (channel, channel_thread_id, claude_session_id, last_used_at, created_at)
         VALUES ('http-bridge', ?, '', ?, ?)`,
      )
      .run(tk, Date.now(), Date.now());
    setThreadName(tk, "검색테스트방");
    recordChatMessage({
      threadKey: tk,
      channel: "dashboard",
      role: "user",
      text: "윈도우에서 업데이트가 자꾸 실패해",
      ts: Date.now(),
    } as never);

    // ★같은 성질을 **다른 언어로도** 한 번 더 본다 — 한국어만 넣어두면 이 검사가
    //  "한국어 검사" 로 읽히고, 토크나이저를 갈아 끼울 때 영어 어형변화가 조용히 깨진다.
    recordChatMessage({
      threadKey: tk,
      channel: "dashboard",
      role: "assistant",
      text: "The installer updated itself and Zeitverschiebung was logged.",
      ts: Date.now(),
    } as never);

    const q = normalizeChatQuery("윈도우");
    const hits = q === null ? [] : searchChatLog(q.like, { limit: 20, threadKey: tk });
    out.push(
      assert(
        "★쿼리가 실제로 돈다 — 조사 붙은 어절을 부분일치로 찾는다(한국어 사례)",
        hits.length === 1 && hits[0]!.text.includes("업데이트"),
        `${hits.length}건`,
      ),
      assert(
        "★결과에 세션 표시명이 실린다(어느 대화였나 — 가로질러 찾으면 첫 질문)",
        hits[0]?.sessionLabel === "검색테스트방",
        `표시명=${String(hits[0]?.sessionLabel)}`,
      ),
    );

    // 같은 성질 — 영어 어형변화(`update` → `updated`)와 독일어 합성어 안쪽.
    for (const [term, want] of [["update", "updated"], ["verschiebung", "Zeitverschiebung"]] as const) {
      const qq = normalizeChatQuery(term);
      const hh = qq === null ? [] : searchChatLog(qq.like, { limit: 20, threadKey: tk });
      out.push(
        assert(
          `★단어 안쪽도 찾는다 — "${term}" 로 "${want}" (한국어 전용 성질이 아니다)`,
          hh.some((x) => x.text.includes(want)),
          `${hh.length}건`,
        ),
      );
    }

    // ── ★검색 대상 = 대시보드에 보이는 세션뿐 (2026-08-23 사용자 결정) ────────────
    //  종전엔 `LEFT JOIN` 이라 `threads` 행이 **없는** 좌표도 통과했다 — 레거시 `tg:` ·
    //  `verify:*` · `rerun-missed-schedules` 의 대화가 검색에 나왔다(실측 257행).
    //  같은 판정(`visibleSessionSql`)을 목록과 검색이 함께 쓰는지 **돌려서** 본다.
    {
      const orphanTk = `verify:regr-orphan-${Date.now()}`; // threads 행 없음 = 세션 아님.
      const internalTk = `agent:regr-internal-${Date.now()}`; // 내부 파생 = 목록에서도 제외.
      getDb()
        .prepare(
          // ★`claude_session_id` 가 NOT NULL 이다 — 빼면 `OR IGNORE` 가 **조용히 삼킨다**.
          //  처음에 그래서 픽스처가 만들려던 상태(내부 파생 세션)를 못 만들었고, 검사는
          //  "행이 아예 없어서" 통과했다 = 공허한 검사(변이 테스트가 잡아냈다).
          `INSERT OR IGNORE INTO threads
             (channel, channel_thread_id, claude_session_id, last_used_at, created_at)
           VALUES ('http-bridge', ?, '', ?, ?)`,
        )
        .run(internalTk, Date.now(), Date.now());
      for (const tk2 of [orphanTk, internalTk]) {
        recordChatMessage({
          threadKey: tk2,
          channel: "dashboard",
          role: "user",
          text: "윈도우에서 업데이트가 자꾸 실패해",
          ts: Date.now(),
        } as never);
      }
      const q2 = normalizeChatQuery("윈도우");
      const all = q2 === null ? [] : searchChatLog(q2.like, { limit: 200 });
      const keys = new Set(all.map((h) => h.threadKey));
      out.push(
        assert(
          "★threads 행이 없는 좌표는 검색 대상이 아니다(세션이 아니다)",
          !keys.has(orphanTk),
          keys.has(orphanTk) ? `★${orphanTk} 노출` : "제외 확인",
        ),
        assert(
          "★내부 파생 스레드(agent:/worker:/…)는 검색 대상이 아니다 — 목록과 같은 규칙",
          !keys.has(internalTk),
          keys.has(internalTk) ? `★${internalTk} 노출` : "제외 확인",
        ),
      );
    }

  }

  // ── ⑥b ★비서도 이 검색에 닿는다 (2026-08-25 사용자 신고) ────────────────────
  //  *"단검 이미지 만들어 달라고 한 게 언제였더라?"* 에 비서가 검색할 길이 없어 Claude
  //  Code 의 jsonl 을 grep 하고 **스크립트를 짜서 DB 를 직접 열었다**(29초). 검색은 이미
  //  있었고 회귀도 있었지만 **화면에만** 붙어 있었다 — 능력이 있는데 도구가 없으면
  //  비서에겐 없는 것과 같다. 그래서 ①도구로 등록됐는지 ②그 함수가 실제로 찾는지 둘 다 본다.
  {
    const { memoryToolNames } = await import("../../core/memory-mcp.js");
    const names = memoryToolNames();
    out.push(
      assert(
        "★지난 대화 검색이 **비서 도구로** 등록돼 있다(화면에만 있으면 비서에겐 없는 것)",
        names.includes("search_conversations"),
        names.join(" "),
      ),
    );
    const { searchConversations } = await import("../../core/chat-search.js");
    const r = await searchConversations("윈도우", { limit: 1 });
    out.push(
      assert(
        "★도구가 쓰는 조합이 실제로 돈다(정규화→조회→스니펫→총건수)",
        !r.tooShort && r.hits.length === 1 && r.hits[0]!.snippet.includes("업데이트"),
        `hits=${r.hits.length} total=${r.total} snippet=${String(r.hits[0]?.snippet).slice(0, 30)}`,
      ),
      assert(
        "★상한에 잘렸으면 그 사실을 말한다(total 이 목록보다 크다)",
        r.total >= r.hits.length && r.limit === 1,
        `total=${r.total} hits=${r.hits.length} limit=${r.limit}`,
      ),
      assert(
        "너무 짧은 질의는 오류가 아니라 '아직 검색할 게 아니다'",
        (await searchConversations("가")).tooShort === true,
        "tooShort",
      ),
    );
  }

  // ── ⑥c ★키워드가 없는 회상 — 기간으로 훑는다 (2026-08-25 사용자 요청) ──────────
  //  *"2주전에 주요 대화 주제가 뭔지"* · *"저번달에 집중한 주제"*. 이 길이 없으면 비서는
  //  키워드를 **짐작해서** 두드린다 — 실측 한 턴에 `search_conversations` **56회**.
  {
    const { initStore, getDb, setThreadName } = await import("../../store/sessions.js");
    const { recordChatMessage } = await import("../../store/chat-log.js");
    const { browseConversationPeriod, parseDayBoundary } = await import("../../core/chat-search.js");
    initStore();
    const day = 86_400_000;
    const base = Date.now() - 20 * day;
    const mk = (suffix: string, name: string, n: number, at: number): string => {
      const tk = `dashboard:regr-period-${suffix}-${Date.now()}`;
      getDb()
        .prepare(
          `INSERT OR IGNORE INTO threads
             (channel, channel_thread_id, claude_session_id, name, last_used_at, created_at)
           VALUES ('dashboard', ?, 'x', ?, ?, ?)`,
        )
        .run(tk, name, at, at);
      for (let i = 0; i < n; i++) {
        recordChatMessage({ threadKey: tk, channel: "dashboard", role: "user", text: `말 ${i}`, ts: at } as never);
      }
      setThreadName(tk, name);
      return tk;
    };
    // ★적게 한 쪽을 **더 최근**으로 둔다 — 안 그러면 "많이 한 순" 과 "최근 순" 이 같은
    //  답을 내서, 정렬을 시간순으로 바꾸는 변이가 통과한다(첫 판에 실제로 통과했다).
    mk("hot", "주제-많이한것", 9, base - 2 * 3_600_000);
    mk("cold", "주제-조금한것", 2, base);
    mk("out", "주제-기간밖", 7, base - 10 * day); // 창 밖 — 나오면 안 된다

    const since = base - day;
    const until = base + day;
    const r = await browseConversationPeriod(since, until, { limit: 30 });
    const topics = r.sessions.map((x) => x.topic);
    out.push(
      assert(
        "★기간 안의 대화가 **주제(세션 이름)별로** 묶여 나온다",
        topics.includes("주제-많이한것") && topics.includes("주제-조금한것"),
        topics.slice(0, 5).join(" · "),
      ),
      assert(
        "★많이 오간 주제가 먼저다(그게 '주로 무슨 얘기' 의 답이다)",
        topics.indexOf("주제-많이한것") < topics.indexOf("주제-조금한것"),
        `${topics.indexOf("주제-많이한것")} < ${topics.indexOf("주제-조금한것")}`,
      ),
      assert(
        "★기간 밖은 안 나온다(창이 정말 걸리는가)",
        !topics.includes("주제-기간밖"),
        topics.includes("주제-기간밖") ? "★샜다" : "제외 확인",
      ),
      assert(
        "메시지 수가 실제 건수다",
        r.sessions.find((x) => x.topic === "주제-많이한것")?.messages === 9,
        String(r.sessions.find((x) => x.topic === "주제-많이한것")?.messages),
      ),
    );

    // ★총계는 **상한과 무관**해야 한다 — 목록을 더하면 그 합도 잘린 값이다(첫 판의 결함).
    const capped = await browseConversationPeriod(since, until, { limit: 1 });
    out.push(
      assert(
        "★목록이 잘려도 총계는 진짜 값이다(잘렸다는 사실을 말할 수 있어야 한다)",
        capped.sessions.length === 1 &&
          capped.totalSessions >= 2 &&
          capped.totalMessages >= 11,
        `보인 ${capped.sessions.length} / 전체 세션 ${capped.totalSessions} · 메시지 ${capped.totalMessages}`,
      ),
    );

    // ★`YYYY-MM-DD` 는 **로컬 자정** — UTC 로 읽으면 한국에선 하루가 어긋난다.
    const local = parseDayBoundary("2026-08-01");
    const d = local === null ? null : new Date(local);
    out.push(
      assert(
        "★날짜만 온 경우 로컬 자정으로 읽는다(UTC 로 읽으면 '8월' 이 하루 어긋난다)",
        d !== null && d.getDate() === 1 && d.getHours() === 0 && d.getMonth() === 7,
        d === null ? "파싱 실패" : d.toString().slice(0, 24),
      ),
    );
  }

  // ── ⑦ ★판단이 핸들러에 없다 — 있으면 검사가 데몬을 띄워야 한다(Q7) ──────────
  {
    // ★2026-08-25: 조합(정규화→조회→스니펫→총건수)까지 코어로 올라갔다. 비서의
    //  `search_conversations` 도구가 **같은 함수**를 쓰기 때문이다 — 핸들러에 조합이
    //  남아 있으면 도구가 그걸 다시 써야 하고, `%` 이스케이프 하나만 갈려도 화면과
    //  도구가 다른 답을 준다.
    const h = await sourceHas("../../../plugins/http-bridge", [
      /pathname === "\/chat-search"/,
      /searchConversations/,
    ]);
    const bad = await sourceHas("../../../plugins/http-bridge", [
      /ESCAPE|SNIPPET_LEN|toLowerCase\(\)\.indexOf|normalizeChatQuery|makeSnippet/,
    ]);
    out.push(
      assert(
        "★브리지는 배관만 한다(질의·조회·스니펫 조합을 코어에서 가져다 쓴다)",
        h.ok && !bad.ok,
        h.ok && !bad.ok
          ? "배관 전용 확인"
          : `★핸들러에 판단이 새어 있다(누락 ${h.missing.join(" ")})`,
      ),
    );
  }

  return out;
};

export const check: RegressionCheck = {
  name: "chat-search-finds-inside-words",
  guards:
    "채팅 검색이 단어 안쪽(조사·어미가 붙은 어절, 영어 어형변화)을 못 찾던 것(FTS 토크나이저 증상) + 사용자가 친 `%` 가 와일드카드로 동작하던 것 + 가로질러 찾았는데 어느 세션인지 알 수 없던 것",
  run,
};
