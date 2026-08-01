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
import { assert, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";

const CH = "http-bridge" as const;

export const check: RegressionCheck = {
  name: "context-reset",
  guards:
    "/clear 후에도 codex 롤링 요약이 남아 옛 맥락이 따라오던 것 + 세 어댑터 중 일부만 끊기던 것",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const out: Assertion[] = [];
    const { initStore, saveSession, deleteSession, setContextBoundary, getDb } =
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
    const wired = await sourceOrder("../../index.ts", [
      /if \(trimmed === "\/reset" \|\| trimmed === "\/clear"\) \{/,
      /deleteSession\(sidChannel, msg\.threadKey\)/,
      /setContextBoundary\(sidChannel, msg\.threadKey, Date\.now\(\)\)/,
      /clearThreadSummary\(sidChannel, msg\.threadKey\)/,
    ]);
    out.push(
      assert(
        "★/clear 핸들러가 세 단계를 모두 부른다(어댑터 하나만 끊기는 일 0)",
        wired.ok,
        wired.detail,
      ),
    );
    return out;
  },
};
