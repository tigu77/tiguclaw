/**
 * 회귀: **요약에 접힌 긴 도구 결과의 목록이 요약과 따로 남는다** — ★행동 게이트 (2026-10-05).
 *
 * 압축을 자주 겪은 벤치 런(`multi-turn-recall`, v0.65.0·현재 둘 다 7/14)에서 요약이 원문 참조를 0개 남기자, 모델이 원문 회수 도구를
 * 떠올리지 못하고 1턴에 읽은 회의록의 값을 «확인할 수 없다» 로 답했다. 참조를 남기는 건 요약 모델의 재량이었다.
 * 이제 요청 때 보내는 요약 뒤에 **기록에서 만든** 목록이 붙는다 — 요약이 무엇을 빠뜨려도, 재압축이 요약을 다시 써도 남는다.
 *
 * 드라이버(`compactThreadHistory`)를 실제로 돌린다(요약기는 안 불린다 — 접을 만큼 크지 않은 대화).
 */
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "folded-tool-index",
  guards:
    "압축 뒤 요약이 원문 참조를 빠뜨리면 회수 도구를 쓸 단서가 사라져, 앞서 도구로 읽은 내용을 «확인할 수 없다» 로 답하던 것",
  run: async (): Promise<Assertion[]> => {
    const H = await import("../../core/llm-runtime/adapters/openai-codex-oauth-history.js");
    const { initStore, getDb } = await import("../../store/sessions.js");
    const { appendApiTurn } = await import("../../store/memory.js");
    const { resetThreadContext } = await import("../../store/thread-reset.js");
    const { upsertThreadSummary, clearThreadSummary, getThreadSummary } = await import("../../store/thread-summaries.js");
    const { readThreadToolResult, TOOL_RECALL_NAME, __toolRecallStatsForTest, FOLDED_SCAN_TURNS } = await import("../../store/tool-recall.js");
    initStore();
    const CH = "http-bridge" as const;
    const TK = "regr:folded-index";
    const SID = "regr-folded-index-sid";
    const call = (id: string, name: string, args: unknown) => ({ type: "function_call" as const, call_id: id, name, arguments: JSON.stringify(args) });
    const out = (id: string, output: string) => ({ type: "function_call_output" as const, call_id: id, output });
    const turn = (items: ReturnType<typeof call | typeof out>[]) =>
      appendApiTurn({ channel: CH, threadKey: TK, claudeSessionId: SID, userContent: "질문", assistantContent: "답", items });
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const LONG = (tag: string) => `${tag} ` + "가".repeat(H.FOLD_TOOL_OUTPUT_HEAD + 200);

    clearThreadSummary(CH, TK);
    turn([call("pre", "Read", { path: "old.md" }), out("pre", LONG("BEFORE-CLEAR"))]);
    await sleep(5);
    resetThreadContext(CH, TK); // 이 앞은 현재 맥락이 아니다
    await sleep(5);
    turn([call("n1", "Read", { path: "docs/notes.md" }), out("n1", LONG("WHITFIELD-42"))]);
    turn([call("s1", "Bash", { command: "ls" }), out("s1", "짧은 결과")]);
    turn([call("r1", TOOL_RECALL_NAME, { query: "x" }), out("r1", LONG("RECALL-SELF"))]);
    for (let i = 0; i < H.FOLDED_TOOL_INDEX_LIMIT + 5; i++) turn([call(`b${i}`, "Bash", { command: `step ${i}\n${"x".repeat(200)}` }), out(`b${i}`, LONG(`BULK-${i}`))]);
    const ids = (getDb().prepare(`SELECT id FROM transcripts WHERE claude_session_id = ? ORDER BY id`).all(SID) as { id: number }[]).map((r) => r.id);
    const watermark = ids[ids.length - 1]!;
    turn([call("after", "Read", { path: "new.md" }), out("after", LONG("AFTER-WATERMARK"))]); // 워터마크 뒤 = 원문으로 보이는 턴
    upsertThreadSummary({ threadKey: TK, summary: "요약 본문", compactedThrough: watermark });

    const drive = (postTurn = false) =>
      H.compactThreadHistory({
        channel: CH, threadKey: TK, provider: "codex-oauth", adapter: "codex",
        budget: { instructionsChars: 1_000, promptChars: 100 },
        summarize: async () => "",
        ...(postTurn ? { postTurn: true } : {}),
      });
    const a = await drive();
    const b = await drive();
    const after = await drive(true);
    const lines = a.summary.split("\n").filter((l) => l.startsWith("- ref "));
    const refs = lines.map((l) => /- ref (\S+)/.exec(l)![1]!);
    const bulkOrder = lines.map((l) => Number(/step (\d+)/.exec(l)?.[1] ?? -1));
    // 회의록 결과는 BULK 35건에 밀려 «최근 30건» 밖이다 — 상한이 실제로 걸리는지, 그리고 최근 것만 남는지 본다.
    const notesListed = lines.some((l) => l.includes("docs/notes.md"));
    // 그래서 회의록 하나만 접힌 작은 대화로 왕복을 따로 본다.
    const TK2 = "regr:folded-index-2", SID2 = "regr-folded-index-sid2";
    clearThreadSummary(CH, TK2);
    // 상한에 안 밀리는 작은 대화라 «빠져야 할 것» 이 정말 빠지는지도 여기서 본다(큰 대화에선 상한이 가려 변이 2개가 초록이었다).
    appendApiTurn({ channel: CH, threadKey: TK2, claudeSessionId: SID2, userContent: "질문", assistantContent: "답", items: [call("p0", "Read", { path: "old.md" }), out("p0", LONG("BEFORE-CLEAR"))] });
    await sleep(5);
    resetThreadContext(CH, TK2);
    await sleep(5);
    appendApiTurn({ channel: CH, threadKey: TK2, claudeSessionId: SID2, userContent: "질문", assistantContent: "답", items: [call("n1", "Read", { path: "docs/notes.md" }), out("n1", LONG("WHITFIELD-42"))] });
    appendApiTurn({ channel: CH, threadKey: TK2, claudeSessionId: SID2, userContent: "질문", assistantContent: "답", items: [call("s1", "Bash", { command: "ls" }), out("s1", "짧은 결과")] });
    // 회수 도구 자신의 결과(원본의 사본)는 칸을 차지하지 않는다 · 여러 줄 인자(heredoc)도 한 줄로.
    appendApiTurn({ channel: CH, threadKey: TK2, claudeSessionId: SID2, userContent: "질문", assistantContent: "답", items: [call("rr", TOOL_RECALL_NAME, { ref: "1#1" }), out("rr", LONG("RECALL-COPY"))] });
    appendApiTurn({ channel: CH, threadKey: TK2, claudeSessionId: SID2, userContent: "질문", assistantContent: "답", items: [call("ml", "Bash", { command: "python3 - <<'PY'\nprint(1)\nPY" }), out("ml", LONG("MULTILINE"))] });
    const ids2 = (getDb().prepare(`SELECT id FROM transcripts WHERE claude_session_id = ? ORDER BY id`).all(SID2) as { id: number }[]).map((r) => r.id);
    upsertThreadSummary({ threadKey: TK2, summary: "", compactedThrough: ids2[ids2.length - 1]! });
    const c = await H.compactThreadHistory({
      channel: CH, threadKey: TK2, provider: "codex-oauth", adapter: "codex",
      budget: { instructionsChars: 1_000, promptChars: 100 }, summarize: async () => "",
    });
    const cRef = /- ref (\S+) · Read\(\{"path":"docs\/notes\.md"\}\)/.exec(c.summary)?.[1];
    const round = cRef !== undefined ? readThreadToolResult(CH, TK2, cRef, 0) : undefined;
    const cLines = c.summary.split("\n").filter((l) => l.startsWith("- ref "));
    // ★캐시 — 워터마크·경계가 같으면 기록을 다시 읽지 않는다(적대 검토 F2: 요청마다 대화 전체를 훑었다).
    const loads0 = __toolRecallStatsForTest().turnLoads;
    const c2 = await H.compactThreadHistory({
      channel: CH, threadKey: TK2, provider: "codex-oauth", adapter: "codex",
      budget: { instructionsChars: 1_000, promptChars: 100 }, summarize: async () => "",
    });
    const cachedLoads = __toolRecallStatsForTest().turnLoads - loads0;
    // ★전체 상한 — 인자가 긴 결과 40건이어도 목록은 상한 안(항목 미리보기 상한이 지워져도 넘치지 않게 전체를 잰다).
    const TK3 = "regr:folded-index-3", SID3 = "regr-folded-index-sid3";
    clearThreadSummary(CH, TK3);
    for (let i = 0; i < 40; i++) appendApiTurn({ channel: CH, threadKey: TK3, claudeSessionId: SID3, userContent: "질문", assistantContent: "답", items: [call(`w${i}`, "mcp__project_filesystem_server__write_text_file", { path: `f${i}.ts`, content: "코".repeat(5_000) }), out(`w${i}`, LONG(`W-${i}`))] });
    const ids3 = (getDb().prepare(`SELECT id FROM transcripts WHERE claude_session_id = ? ORDER BY id`).all(SID3) as { id: number }[]).map((r) => r.id);
    upsertThreadSummary({ threadKey: TK3, summary: "s", compactedThrough: ids3[ids3.length - 1]! });
    const loads1 = __toolRecallStatsForTest().turnLoads;
    const big = H.foldedToolIndex(CH, TK3, ids3[ids3.length - 1]!);
    const bigLoads = __toolRecallStatsForTest().turnLoads - loads1;
    const bigLines = big.split("\n").slice(1);
    const bigHeadN = Number(/결과 (\d+)건/.exec(big)?.[1] ?? -1);
    // ★워터마크가 나아가면 목록도 새로 — 캐시 키에 워터마크가 빠지면 두 번째 압축부터 목록이 영구히 낡는다(재검토 M8).
    appendApiTurn({ channel: CH, threadKey: TK2, claudeSessionId: SID2, userContent: "질문", assistantContent: "답", items: [call("nx", "Read", { path: "docs/next.md" }), out("nx", LONG("NEXT-ONE"))] });
    const ids2b = (getDb().prepare(`SELECT id FROM transcripts WHERE claude_session_id = ? ORDER BY id`).all(SID2) as { id: number }[]).map((r) => r.id);
    upsertThreadSummary({ threadKey: TK2, summary: "", compactedThrough: ids2b[ids2b.length - 1]! });
    const c3 = await H.compactThreadHistory({
      channel: CH, threadKey: TK2, provider: "codex-oauth", adapter: "codex",
      budget: { instructionsChars: 1_000, promptChars: 100 }, summarize: async () => "",
    });
    // ★Claude 턴이 많이 섞여도(턴당 행 여럿·도구 기록 없음) 앞서 읽은 긴 결과가 남는다 — 창을 assistant 행으로 세면 빠졌다(재검토 A).
    const TK4 = "regr:folded-index-4", SID4 = "regr-folded-index-sid4";
    clearThreadSummary(CH, TK4);
    appendApiTurn({ channel: CH, threadKey: TK4, claudeSessionId: SID4, userContent: "질문", assistantContent: "답", items: [call("old", "Read", { path: "docs/first.md" }), out("old", LONG("FIRST-READ"))] });
    const { appendTranscript } = await import("../../store/memory.js");
    for (let i = 0; i < FOLDED_SCAN_TURNS + 50; i++) appendTranscript({ claudeSessionId: SID4, role: "assistant", content: `Claude 턴 ${i}` });
    appendApiTurn({ channel: CH, threadKey: TK4, claudeSessionId: SID4, userContent: "질문", assistantContent: "답", items: [call("s4", "Bash", { command: "ls" }), out("s4", "짧은 결과")] });
    const ids4 = (getDb().prepare(`SELECT id FROM transcripts WHERE claude_session_id = ? ORDER BY id`).all(SID4) as { id: number }[]).map((r) => r.id);
    const mixed = H.foldedToolIndex(CH, TK4, ids4[ids4.length - 1]!);

    return [
      assert(
        "★요약 뒤에 접힌 긴 결과 목록이 붙는다 — 최근 30건 · 오래된 순(결정적)",
        lines.length === H.FOLDED_TOOL_INDEX_LIMIT && bulkOrder.every((n, i) => i === 0 || n > bulkOrder[i - 1]!) && bulkOrder[bulkOrder.length - 1] === H.FOLDED_TOOL_INDEX_LIMIT + 4,
        { n: lines.length, first: lines[0]?.slice(0, 80), last: lines[lines.length - 1]?.slice(0, 80) },
      ),
      assert(
        "목록에서 빠지는 것: 짧은 결과 · 워터마크 뒤 · /clear 이전 · 회수 도구 자신 · 상한 밖의 오래된 것",
        !/짧은|Bash\(\{"command":"ls"\}\)/.test(a.summary) && !a.summary.includes("new.md") && !a.summary.includes("old.md") &&
          !lines.some((l) => l.includes(`· ${TOOL_RECALL_NAME}(`)) && !notesListed,
        a.summary.slice(0, 200),
      ),
      assert(
        "같은 입력이면 같은 글(프리픽스 캐시) · 저장된 요약엔 목록이 없다(재압축이 못 지운다) · 턴 뒤 경로는 만들지 않는다",
        a.summary === b.summary && getThreadSummary(TK)?.summary === "요약 본문" && after.summary === "요약 본문" && a.summary.startsWith("요약 본문\n\n"),
        { stored: getThreadSummary(TK)?.summary, after: after.summary.slice(0, 40) },
      ),
      assert(
        "★요약이 비어도 목록은 실린다 · 목록의 ref 로 원문을 실제로 다시 읽는다(왕복)",
        c.summary.startsWith("〔") && cLines.length === 2 && !c.summary.includes("RECALL") && round?.ok === true && JSON.stringify(round).includes("WHITFIELD-42") && refs.every((r) => /^\d+#\d+$/.test(r)),
        { lines: cLines, round: round?.ok },
      ),
      assert(
        "★머리말이 회수 도구 이름과 «추측하지 말고 다시 읽는다» 를 싣는다(이게 빠지면 모델이 도구를 떠올리지 못한 벤치 실패가 돌아온다) · 여러 줄 인자도 한 줄",
        c.summary.split("\n")[0]!.includes(`${TOOL_RECALL_NAME}(ref)`) && c.summary.split("\n")[0]!.includes("추측하지 말고") &&
          c.summary.split("\n").slice(1).every((l) => l.startsWith("- ref ")) && cLines.some((l) => l.includes("python3 - <<'PY'")),
        cLines,
      ),
      assert(
        "★목록 전체가 상한(4천 자) 안 · 상한 30건(숫자로) · 같은 워터마크면 기록을 다시 안 읽고(캐시) · 처음 만들 때도 30건 채우면 멈춘다",
        big.length <= 4_000 - 2 && bigLines.length < 30 && bigHeadN === bigLines.length && bigLines[bigLines.length - 1]!.includes("f39.ts") &&
          !big.includes("f0.ts") && H.FOLDED_TOOL_INDEX_MAX_CHARS === 4_000 && H.FOLDED_TOOL_INDEX_LIMIT === 30 && lines.length === 30 &&
          c2.summary === c.summary && cachedLoads === 0 && bigLoads <= 30,
        { bigLen: big.length, bigLines: bigLines.length, bigHeadN, last: bigLines[bigLines.length - 1]?.slice(0, 60), cachedLoads, bigLoads },
      ),
      assert(
        "★워터마크가 나아가면 새로 접힌 결과가 목록에 실린다(캐시가 낡지 않는다) · Claude 턴이 창을 먹어도 앞서 읽은 긴 결과가 남는다",
        c3.summary.includes("docs/next.md") && mixed.includes("docs/first.md"),
        { next: c3.summary.includes("docs/next.md"), mixed: mixed.slice(0, 120) },
      ),
    ];
  },
};
