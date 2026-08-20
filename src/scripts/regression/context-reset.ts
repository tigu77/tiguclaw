/**
 * 회귀: **`/clear`(=`/reset`)가 세 어댑터를 모두 끊는다** (2026-08-01 승격).
 *
 * 초기화는 **세 가지를 같이** 해야 성립한다 — 어느 하나만 빠져도 사용자에겐 "초기화했는데
 * 옛 얘기를 한다" 로 보인다:
 *   ①`deleteSession` — claude 세션(resume) 끊기
 *   ②`setContextBoundary(now)` — codex/openai 는 세션 대신 **매 턴 히스토리를 재전송**하므로
 *     그 시각 이전 턴을 컷
 *   ③`clearThreadSummary` — codex 롤링 요약 드롭. **요약은 경계 이전 대화를 접은 것**이라
 *     안 지우면 초기화 후에도 옛 맥락이 그대로 따라온다(`/reset·/clear P0, 2026-07-10`).
 *
 * ★검사가 없었다. 셋 중 하나가 빠져도 조용히 통과했고, 실제로 ③이 빠져 사고가 났던 이력이
 *  주석에 남아 있다. 그래서 **각각을 따로 지운 상태**까지 만들어 본다 — "셋 다 했을 때
 *  된다" 만 보면 하나가 빠진 걸 못 잡는다.
 *
 * ★초기화 ≠ 삭제: 원문 `transcripts` 는 그대로 남는다(보존 원칙). 컨텍스트에서 내릴 뿐이다.
 */
import { readFile } from "node:fs/promises";
import { assert, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";

const CH = "http-bridge" as const;

export const check: RegressionCheck = {
  name: "context-reset",
  guards:
    "/clear 후에도 codex 롤링 요약이 남아 옛 맥락이 따라오던 것 + 세 어댑터 중 일부만 끊기던 것",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const out: Assertion[] = [];
    const {
      initStore,
      saveSession,
      deleteSession,
      clearSessionContext,
      setThreadName,
      setContextBoundary,
      getDb,
    } =
      await import("../../store/sessions.js");
    const { loadThreadHistoryWithIds } = await import("../../store/memory.js");
    const { upsertThreadSummary, getThreadSummary, clearThreadSummary } = await import(
      "../../store/thread-summaries.js"
    );
    initStore();

    /** 대화 3턴 + 롤링 요약 + claude 세션을 갖춘 스레드를 만든다. */
    const seed = (tk: string, sid: string): void => {
      getDb()
        .prepare(
          `INSERT INTO transcript_index (channel,thread_key,claude_session_id,jsonl_path,indexed_at,lines_indexed)
           VALUES (?,?,?,?,?,?)`,
        )
        .run(CH, tk, sid, "/tmp/x.jsonl", Date.now(), 0);
      const ins = getDb().prepare(
        `INSERT INTO transcripts (claude_session_id,ts,role,content) VALUES (?,?,?,?)`,
      );
      ["첫 질문", "답변", "둘째 질문"].forEach((t, i) => {
        ins.run(sid, Date.now() - 5000 + i, i % 2 === 1 ? "assistant" : "user", t);
      });
      upsertThreadSummary({
        threadKey: tk,
        summary: "이전 대화 요약본입니다".repeat(5),
        compactedThrough: 1,
      });
      saveSession({ channel: CH, threadKey: tk, claudeSessionId: sid } as never);
    };

    // ★① 셋 다 하면 — 히스토리·요약·세션이 전부 끊긴다.
    seed("clear:all", "sid-all");
    const before = {
      turns: loadThreadHistoryWithIds(CH, "clear:all").length,
      summary: (getThreadSummary("clear:all")?.summary ?? "").length,
    };
    const had = deleteSession(CH, "clear:all");
    setContextBoundary(CH, "clear:all", Date.now());
    clearThreadSummary(CH, "clear:all");
    const after = {
      turns: loadThreadHistoryWithIds(CH, "clear:all").length,
      summary: (getThreadSummary("clear:all")?.summary ?? "").length,
    };
    out.push(
      assert(
        "검사 전제 — 초기화 전에는 히스토리와 요약이 있다",
        before.turns === 3 && before.summary > 0,
        `턴 ${before.turns} · 요약 ${before.summary}자`,
      ),
    );
    out.push(
      assert(
        "★/clear 후 히스토리·요약·세션이 모두 끊긴다",
        after.turns === 0 && after.summary === 0 && had,
        `턴 ${after.turns} · 요약 ${after.summary}자 · 세션삭제=${String(had)}`,
      ),
    );
    // 초기화 후 새 대화는 정상적으로 보여야 한다(과잉 차단 0).
    getDb()
      .prepare(`INSERT INTO transcripts (claude_session_id,ts,role,content) VALUES (?,?,?,?)`)
      .run("sid-all", Date.now() + 5000, "user", "초기화 후 새 질문");
    const fresh = loadThreadHistoryWithIds(CH, "clear:all").map((t) => t.content);
    out.push(
      assert(
        "초기화 후 새 대화는 보인다(경계가 미래까지 막지 않는다)",
        fresh.length === 1 && fresh[0] === "초기화 후 새 질문",
        `${fresh.length}턴: ${fresh.join(",")}`,
      ),
    );
    // ★초기화 ≠ 삭제 — 원문은 남는다.
    const rawCount = (
      getDb()
        .prepare(`SELECT COUNT(*) AS c FROM transcripts WHERE claude_session_id = ?`)
        .get("sid-all") as { c: number }
    ).c;
    out.push(
      assert(
        "★원문 transcripts 는 지워지지 않는다(초기화 ≠ 삭제)",
        rawCount === 4,
        `${rawCount}행 보존`,
      ),
    );

    // ★② 하나씩 빠뜨려 본다 — "셋 다 했을 때 된다" 만 보면 누락을 못 잡는다.
    //  요약 드롭만 빼면(2026-07-10 사고 형상) 히스토리는 끊겨도 **옛 맥락이 그대로 남는다**.
    seed("clear:nosum", "sid-nosum");
    deleteSession(CH, "clear:nosum");
    setContextBoundary(CH, "clear:nosum", Date.now());
    // clearThreadSummary 생략
    const leftover = (getThreadSummary("clear:nosum")?.summary ?? "").length;
    out.push(
      assert(
        "★요약 드롭을 빠뜨리면 옛 맥락이 남는다(이 검사가 그것을 본다)",
        leftover > 0,
        leftover > 0
          ? `요약 ${leftover}자 잔존 — 세 번째 단계가 필요한 이유`
          : "★잔존 0 — 검사가 무의미해졌다(요약 경로 변경?)",
      ),
    );
    // 경계만 빼면 히스토리가 그대로 따라온다.
    seed("clear:nobound", "sid-nobound");
    deleteSession(CH, "clear:nobound");
    clearThreadSummary(CH, "clear:nobound");
    // setContextBoundary 생략
    out.push(
      assert(
        "★경계 설정을 빠뜨리면 옛 히스토리가 그대로 따라온다",
        loadThreadHistoryWithIds(CH, "clear:nobound").length === 3,
        `${loadThreadHistoryWithIds(CH, "clear:nobound").length}턴 잔존`,
      ),
    );

    // ★③ 배선 — 핸들러가 실제로 셋을 **이 순서로** 부르는가(요약 드롭이 빠지면 위 ②가 현실이 된다).
    const { sourceOrder } = await import("./_wiring.js");
    // ★2026-08-20: `/clear` 와 `/reset` 이 갈렸다 — 각각 **자기 블록**을 잘라서 본다.
    //  `sourceOrder` 로 파일 전체를 훑으면 이웃 블록의 줄에 매칭된다(실제로 그렇게 오탐이
    //  났다). 블록을 먼저 자르는 게 판정의 전제다.
    //  ★그 뒤 `/reset` 은 아예 없앴다(사용자 결정) — 아래가 되살아남을 지킨다.
    const idxSrc = await readFile(new URL("../../index.ts", import.meta.url), "utf8");
    const blockOf = (head: string): string => {
      const at = idxSrc.indexOf(head);
      if (at < 0) return "";
      // 다음 `if (trimmed === ` 까지가 그 블록.
      const next = idxSrc.indexOf('if (trimmed === "', at + head.length);
      return idxSrc.slice(at, next < 0 ? at + 1200 : next);
    };
    const clearBlock = blockOf('if (trimmed === "/clear") {');
    const wired = {
      ok:
        clearBlock !== "" &&
        /clearSessionContext\(sidChannel, msg\.threadKey\)/.test(clearBlock) &&
        /setContextBoundary\(sidChannel, msg\.threadKey, Date\.now\(\)\)/.test(clearBlock) &&
        /clearThreadSummary\(sidChannel, msg\.threadKey\)/.test(clearBlock),
      detail: clearBlock === "" ? "★/clear 블록 미발견" : "세 단계 모두 호출",
    };
    out.push(
      assert(
        "★`/reset` 은 없다 (2026-08-20 사용자 결정) — 되돌릴 수 없이 이름·설정·탭까지 지우는 명령을 두지 않는다",
        !idxSrc.includes('trimmed === "/reset"'),
        idxSrc.includes('trimmed === "/reset"') ? "★되살아났다" : "없음",
      ),
      assert(
        "★대화를 지우는 명령이 **아무것도** 없다 — 치우는 수단은 보관(archive)이다",
        !/deleteSession\(/.test(idxSrc),
        /deleteSession\(/.test(idxSrc) ? "★세션 삭제 경로가 생겼다" : "삭제 경로 0",
      ),
      assert(
        "★/clear 블록이 deleteSession 을 부르지 않는다 — 그게 세션을 날린 원인이었다",
        clearBlock !== "" && !/deleteSession\(/.test(clearBlock),
        clearBlock === ""
          ? "★블록 미발견"
          : /deleteSession\(/.test(clearBlock)
            ? "★여전히 호출 — 세션이 날아간다"
            : "미호출",
      ),
    );
    out.push(
      assert(
        "★/clear 핸들러가 세 단계를 모두 부른다(어댑터 하나만 끊기는 일 0)",
        wired.ok,
        wired.detail,
      ),
    );
    // ── ★`/clear` 는 **맥락만** 지운다 — 세션(이름·탭)은 남는다 (2026-08-20 사용자 신고) ──
    //  신고: "/clear 로 세션 컨텍스트 초기화 하니까 세션이 날아간다 · 두 세션 다 탭에서
    //  없어졌다". 원인: `/clear` 가 `deleteSession` 을 불러 `threads` 행을 통째로 지웠다.
    //  ★근거 주석은 *"이 세션의 모든 상태 초기화(사용자 결정 2026-05-28)"* 였는데, 그때는
    //   **세션이 하나뿐**이라 지울 이름도 탭도 없었다 — "전부 지움" 이 곧 "맥락 지움" 이었다.
    //   멀티세션(2026-07-15)이 들어오며 같은 코드의 의미가 조용히 바뀌었다.
    //   **결정이 늙은 게 아니라 전제가 늙었다.**
    //  ★이 회귀 자신도 `deleteSession` 을 직접 불러서 이 결함을 못 봤다 — 검사가 제품과
    //   같은 함수를 부르는 게 아니라 **같은 가정**을 복제하고 있었다.
    {
      const tk = "clear:keeps-identity";
      seed(tk, "sid-keep");
      setThreadName(tk, "가시피버 재구성");
      // ★이어가기 게이트(`system_prompt_hash`)를 **실제로 채워** 둔다. 안 채우면 처음부터
      //  NULL 이라 "지웠는지" 를 잴 수 없다 — 그 상태에선 지우는 줄을 없애도 검사가 통과한다
      //  (변이로 확인했다). 픽스처가 비어 있으면 검사도 비어 있다.
      getDb()
        .prepare(`UPDATE threads SET system_prompt_hash = ? WHERE channel_thread_id = ?`)
        .run("hash-of-current-prompt", tk);
      const nameOf = (): string | null => {
        const r = getDb()
          .prepare(`SELECT name, claude_session_id AS sid FROM threads WHERE channel_thread_id = ?`)
          .get(tk) as { name: string | null; sid: string | null } | undefined;
        return r === undefined ? null : r.name;
      };
      const hashOf = (): string | null => {
        const r = getDb()
          .prepare(`SELECT system_prompt_hash AS h FROM threads WHERE channel_thread_id = ?`)
          .get(tk) as { h: string | null } | undefined;
        return r === undefined ? null : r.h;
      };
      const sidOf = (): string | null => {
        const r = getDb()
          .prepare(`SELECT claude_session_id AS sid FROM threads WHERE channel_thread_id = ?`)
          .get(tk) as { sid: string | null } | undefined;
        return r === undefined ? null : r.sid;
      };
      const rowsBefore = (getDb()
        .prepare(`SELECT COUNT(*) AS c FROM threads WHERE channel_thread_id = ?`)
        .get(tk) as { c: number }).c;

      const had = clearSessionContext(CH, tk);
      setContextBoundary(CH, tk, Date.now());
      clearThreadSummary(CH, tk);

      const rowsAfter = (getDb()
        .prepare(`SELECT COUNT(*) AS c FROM threads WHERE channel_thread_id = ?`)
        .get(tk) as { c: number }).c;

      out.push(
        assert("전제: 세션이 있었다", rowsBefore === 1 && had, `rows=${rowsBefore} had=${had}`),
        assert(
          "★/clear 후에도 **세션 행이 남는다** — 탭이 사라지면 안 된다",
          rowsAfter === 1,
          `rows=${rowsAfter}`,
        ),
        assert(
          "★대화 이름이 보존된다 — 사용자가 붙인 이름은 맥락이 아니다",
          nameOf() === "가시피버 재구성",
          `${nameOf() ?? "(사라짐)"}`,
        ),
        // ★두 축을 **따로** 본다. 묶어서 보면 하나만 지워도 통과한다(실제로 그랬다).
        //  실제 이어가기 게이트는 **해시**다 — 어댑터가
        //  `prior.systemPromptHash === SYSTEM_PROMPT_HASH` 일 때만 resume 을 건다.
        //  그러니 해시를 안 지우면 `/clear` 해도 옛 대화를 그대로 이어간다.
        assert(
          "★이어가기 **해시**가 지워진다 — 이게 실제 resume 게이트다",
          hashOf() === null,
          `system_prompt_hash=${hashOf() ?? "null"}`,
        ),
        assert(
          "이어가기 id 도 비워진다(흔적 제거 — NOT NULL 이라 빈 문자열)",
          (sidOf() ?? "") === "",
          `claude_session_id="${sidOf() ?? ""}"`,
        ),
        assert(
          "히스토리도 경계 뒤로 끊긴다",
          loadThreadHistoryWithIds(CH, tk).length === 0,
          `${loadThreadHistoryWithIds(CH, tk).length}턴`,
        ),
        assert(
          "요약도 지워진다",
          (getThreadSummary(tk)?.summary ?? "") === "",
          `${(getThreadSummary(tk)?.summary ?? "").length}자`,
        ),
      );

      // `/reset` 은 종전대로 **세션까지** 지운다 — 두 명령의 의미가 갈려 있어야 한다.
      const tk2 = "clear:reset-still-deletes";
      seed(tk2, "sid-reset");
      setThreadName(tk2, "지워질 이름");
      deleteSession(CH, tk2);
      const rows2 = (getDb()
        .prepare(`SELECT COUNT(*) AS c FROM threads WHERE channel_thread_id = ?`)
        .get(tk2) as { c: number }).c;
      out.push(
        assert(
          "/reset 은 여전히 세션까지 지운다(두 명령이 같은 일을 하면 이름이 거짓말이다)",
          rows2 === 0,
          `rows=${rows2}`,
        ),
      );
    }

    return out;
  },
};
