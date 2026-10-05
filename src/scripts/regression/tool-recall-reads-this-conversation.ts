/**
 * 회귀: **이 대화에서 앞서 실행한 도구의 결과를 다시 읽는다 — 이 대화의 것만, 당시 그대로** (2026-09-30, 압축 후 업무 연속성 단계 A).
 *
 * 사고(09-29 재현): 이력이 요약되면 도구 결과 원문이 입력에서 빠지고, 요약이 놓친 사실은 «기억나지 않습니다» 가 됐다.
 *  원문은 `turn_items` 에 남아 있었다 — 다시 읽을 길이 없었을 뿐이다.
 * ① 실경로(자식, 네트워크 0): router → Codex 어댑터가 도구를 **실제로 등록**하고, 1턴의 Read 결과가 저장돼 2턴 검색·3턴 참조
 *    읽기로 돌아오고, 다른 대화에서는 같은 참조·표식이 안 읽힌다.
 * ② 저장 계층: 대화 격리 · `/clear` 경계 · 틀린 참조는 비슷한 것으로 대신하지 않고 사유로 거절 · 인자로도 찾음 · 검색어의
 *    `%`·`_`·따옴표·줄바꿈이 문자 그대로 · 긴 결과는 이어 읽기 · 목록 상한과 전체 수.
 * ③ 도구 응답(인자 전달 배선) · OpenAI 이벤트→기록 변환을 실행해서 본다(실경로는 실모델 가드로 불가).
 * ④ 참조 접기: 실제 압축 드라이버가 요약기에 넣은 참조로 원문 전체를 되찾는다(접는 쪽·읽는 쪽 이음매).
 */
import { fileURLToPath } from "node:url";
import { assert, assertIsolated, spawnWithin, type Assertion, type RegressionCheck } from "./_framework.js";

type Handler = (args: unknown, extra: unknown) => Promise<{ content: Array<{ type: string; text?: string }> }>;
const handlerOf = (srv: unknown, name: string): Handler => {
  const t = (srv as { instance: { _registeredTools: Record<string, { handler: Handler }> } }).instance._registeredTools[name];
  if (t === undefined) throw new Error(`도구 ${name} 없음`);
  return t.handler;
};

export const check: RegressionCheck = {
  name: "tool-recall-reads-this-conversation",
  guards:
    "이력이 요약돼 도구 결과 원문이 입력에서 빠진 뒤 되찾을 길이 없던 것(09-29 «기억나지 않습니다») — 회수 도구 미등록 · 다른 대화·/clear 이전 기록이 읽힘 · 틀린 참조를 비슷한 것으로 대신함 · 검색어 특수문자 오작동 · 긴 결과 잘림 무표시",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    // ① 실경로 — 전용 홈(모델 고정 설정이 뒤 검사로 새지 않게)
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const home = mkdtempSync(`${tmpdir()}/tiguclaw-regression-tool-recall-`);
    const child = await spawnWithin(90_000, "도구 결과 다시 읽기 실경로", ["--import", "tsx", fileURLToPath(new URL("./_tool-recall-child.ts", import.meta.url))], { env: { ...process.env, TIGUCLAW_HOME: home } })
      .finally(() => rmSync(home, { recursive: true, force: true }));
    const line = child.out.split(/\r?\n/).find((l) => l.startsWith("RECALL_RESULT "));
    const R = (line === undefined ? {} : JSON.parse(line.slice("RECALL_RESULT ".length))) as {
      turns?: number; t1HasTool?: boolean; t1ReadHasMark?: boolean; error?: string; ref?: string; mark?: string;
      search?: { ok?: boolean; total?: number; hits?: Array<{ ref?: string; tool?: string; snippet?: string }> };
      read?: { ok?: boolean; tool?: string; text?: string; ref?: string };
      otherRead?: { ok?: boolean; unavailable?: string };
      otherSearch?: { ok?: boolean; total?: number };
    };

    // ①' OpenAI — ★실경로 자식은 러너에서 못 돈다: 실모델 금지 가드가 OpenAI 를 fetch 가짜로도 막는다(SDK 내부 경로라 엄격 —
    //  regression-model-guard.ts). 대신 **스트림 이벤트 → 저장 항목 변환**을 순수 함수로 두고 SDK 모양 합성 이벤트로 실행한다.
    //  어댑터 안에서 그 함수를 부르는지만 소스로 본다(모양만 보던 종전 그물은 변이 6개가 전부 통과했다 — 적대 검토 G4).
    const OA = await import("../../core/llm-runtime/adapters/openai-agents-sdk.js");
    const ev = (name: string, rawItem: unknown) => ({ type: "run_item_stream_event", name, item: { rawItem } });
    const bigOut = "OA-HEAD " + "x".repeat(30_000) + " OA-TAIL";
    const oaEvents = [
      ev("tool_called", { type: "function_call", callId: "o1", name: "Read", arguments: '{"path":"/a.txt"}' }),
      ev("tool_output", { type: "function_call_result", callId: "o1", output: [{ type: "text", text: bigOut }] }),
      ev("tool_called", { type: "function_call", call_id: "o2", name: "Bash", arguments: '{"cmd":"env"}' }),
      ev("tool_output", { type: "function_call_result", call_id: "o2", output: "OPENAI_API_KEY=sk-proj-REGRRECALLABCDEFGHIJKLMNOP12" }),
      ev("tool_called", { type: "function_call", callId: "o3", name: "Grep", arguments: "{}" }), // 결과 없는 호출 — 짝이 없으면 버린다
      { type: "raw_model_stream_event", data: { type: "output_text_delta", delta: "잡음" } },
    ];
    const oaSlice = oaEvents.map((e) => OA.openAiTurnToolItem(e)).filter((x) => x !== undefined);
    const oaField = OA.openAiTurnItemsField(oaSlice, "끝");
    const oaItems = oaField.turnItems ?? [];
    const oaOut1 = oaItems.find((x) => x.type === "function_call_output" && x.call_id === "o1") as { output: string } | undefined;
    const oaEmpty = OA.openAiTurnItemsField([], "끝");
    const { readFile } = await import("node:fs/promises");
    const { stripComments } = await import("./_wiring.js");
    const src = async (rel: string) => stripComments(await readFile(fileURLToPath(new URL(rel, import.meta.url)), "utf8"));
    const oaSrc = await src("../../core/llm-runtime/adapters/openai-agents-sdk.ts");
    const oaWired = /const toolRec = openAiTurnToolItem\(ev\);\s*if \(toolRec !== undefined\) turnToolItems\.push\(toolRec\);/.test(oaSrc) &&
      /\.\.\.openAiTurnItemsField\(turnToolItems,\s*text\)/.test(oaSrc);
    const regs = await Promise.all(["openai-agents-sdk.ts", "openai-codex-oauth.ts", "claude-agent-sdk.ts"].map(async (f) =>
      /createToolRecallMcpServer\(input\)/.test(await src(`../../core/llm-runtime/adapters/${f}`))));
    // OpenAI 는 도구를 쓰는 턴에만(lean 턴 = 도구 0) — 조건이 뒤집히면 도구가 lean 턴에만 붙는다(적대 검토 O6).
    const oaGate = /if \(!toolsNone\) \{\s*mcpServers\.push\(\s*await adaptClaudeMcpServer\(\s*createToolRecallMcpServer\(input\)/.test(oaSrc);

    // ② 저장 계층
    const { initStore, getDb } = await import("../../store/sessions.js");
    const { appendApiTurn } = await import("../../store/memory.js");
    const { resetThreadContext } = await import("../../store/thread-reset.js");
    const { searchThreadToolResults: search, readThreadToolResult: read, TOOL_RECALL_READ_CHARS } = await import("../../store/tool-recall.js");
    initStore();
    const CH = "http-bridge" as const;
    const call = (id: string, name: string, args: unknown) => ({ type: "function_call" as const, call_id: id, name, arguments: JSON.stringify(args) });
    const out = (id: string, output: string) => ({ type: "function_call_output" as const, call_id: id, output });
    const turn = (tk: string, sid: string, items: ReturnType<typeof call | typeof out>[], ch: "http-bridge" | "telegram" = CH) =>
      appendApiTurn({ channel: ch, threadKey: tk, claudeSessionId: sid, userContent: "질문", assistantContent: "답", items });
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    const A = "regr:recall-a", B = "regr:recall-b";
    turn(A, "sa", [call("a1", "Read", { path: "/srv/old.txt" }), out("a1", "옛 비밀 OLD-4411")]);
    await sleep(5);
    resetThreadContext(CH, A); // /clear — 이 앞은 이 대화의 현재 맥락이 아니다
    await sleep(5);
    turn(A, "sa", [call("a2", "Read", { path: "/srv/config.ts" }), out("a2", '진행률 100%_done · 말하길 "hi"\n다음 줄 NEW-7788')]);
    turn(A, "sa", [call("a3", "Bash", { cmd: "echo" }), out("a3", "진행률 100X done")]);
    turn(A, "sa", [call("a4", "Read", { path: "/srv/big.log" }), out("a4", "L".repeat(45_000))]);
    turn(A, "sa", Array.from({ length: 12 }, (_, i) => [call(`m${i}`, "Grep", { q: i }), out(`m${i}`, `반복 MANY-${i}`)]).flat());
    await sleep(5);
    turn(A, "sa", [call("w1", "Read", { path: "C:\\Users\\alice\\notes.md" }), out("w1", "윈도우 파일 내용 Ärger 확인")]);
    turn(A, "sa", [call("w2", "Read", { path: "de.md" }), out("w2", "섞인 대소문자 ÄöÜ 메모")]); // 세 모양 어디에도 안 맞는 저장값
    // 같은 call_id 가 한 턴에 둘(OpenAI 호환 공급자 모양) — 참조가 서로 다른 결과를 가리켜야 한다.
    turn(A, "sa", [call("dup", "Read", { path: "/a" }), out("dup", "첫번째 FIRST-111"), call("dup", "Read", { path: "/b" }), out("dup", "두번째 SECOND-222")]);
    // 병렬 호출 모양(호출 둘 → 결과 둘, 같은 call_id) — 먼저 연 호출이 먼저 온 결과와 짝이다(접기의 짝짓기와 같은 규칙).
    turn(A, "sa", [call("par", "Read", { path: "/p1" }), call("par", "Read", { path: "/p2" }), out("par", "병렬 첫 PAR-1111"), out("par", "병렬 둘 PAR-2222")]);
    // 검색어가 결과·인자 둘 다에 걸리는 것 — 한 번만 센다.
    turn(A, "sa", [call("both", "Grep", { pattern: "BOTH-3030" }), out("both", "찾음 BOTH-3030")]);
    // 회수 도구 자신의 결과(검색어·조각을 담는다) — 검색에서 빠져야 한다.
    turn(A, "sa", [call("rc", "read_past_tool_result", { query: "NEW-7788" }), out("rc", '{"hits":[{"snippet":"NEW-7788"}]}')]);
    turn(B, "sb", [call("b1", "Read", { path: "/other.txt" }), out("b1", "남의 값 NEW-7788")]);
    // 같은 threadKey 를 다른 채널에 — 다른 대화다.
    turn(A, "st", [call("t1", "Read", { path: "/tg.txt" }), out("t1", "텔레그램 채널 값 NEW-7788")], "telegram");

    // 세기 상한 — 한 턴에 1,005쌍이 걸리면 1,000 에서 멈추고 «이상» 으로 알린다.
    turn("regr:recall-cap", "scap", Array.from({ length: 1_005 }, (_, i) => [call(`k${i}`, "Grep", { q: i }), out(`k${i}`, `CAPHIT-${i}`)]).flat());
    const { __toolRecallStatsForTest: stats, TOOL_RECALL_COUNT_CAP } = await import("../../store/tool-recall.js");
    const s0 = stats();
    const manyProbe = search(CH, A, "MANY-"); // 한 턴에 12건 적중
    const s1 = stats();
    const capped = search(CH, "regr:recall-cap", "CAPHIT-");
    const newHit = search(CH, A, "NEW-7788");
    const oldHit = search(CH, A, "OLD-4411");
    const pct = search(CH, A, "100%");
    const quote = search(CH, A, '말하길 "hi"\n다음');
    const byArg = search(CH, A, "config.ts");
    const many = search(CH, A, "MANY-");
    const win = search(CH, A, "C:\\Users\\alice");
    const umlaut = search(CH, A, "ärger");
    const mixed = search(CH, A, "äöü");
    const jsonKey = search(CH, A, "call_id");
    const both = search(CH, A, "BOTH-3030");
    const recent = search(CH, A, "진행률");
    const second = search(CH, A, "SECOND-222");
    const first = search(CH, A, "FIRST-111");
    const par1 = read(CH, A, search(CH, A, "PAR-1111").hits[0]?.ref ?? "");
    const par2 = read(CH, A, search(CH, A, "PAR-2222").hits[0]?.ref ?? "");
    const newRef = newHit.hits[0]?.ref ?? "";
    const full = read(CH, A, newRef);
    const inB = read(CH, B, newRef);
    const bSearch = search(CH, B, "NEW-7788");
    const tgSearch = search("telegram", A, "NEW-7788");
    const oldTid = (getDb().prepare(`SELECT transcript_id AS t FROM turn_items WHERE item LIKE '%OLD-4411%'`).get() as { t: number } | undefined)?.t;
    const beforeClear = read(CH, A, `${oldTid ?? 0}#1`);
    const callItem = read(CH, A, newRef.replace(/#\d+$/, "#0"));
    const secondRead = read(CH, A, second.hits[0]?.ref ?? "");
    const firstRead = read(CH, A, first.hits[0]?.ref ?? "");
    const bigRef = search(CH, A, "big.log").hits[0]?.ref ?? "";
    const big1 = read(CH, A, bigRef);
    const big2 = big1.ok && big1.nextOffset !== undefined ? read(CH, A, bigRef, big1.nextOffset) : undefined;
    const big3 = big2?.ok === true && big2.nextOffset !== undefined ? read(CH, A, bigRef, big2.nextOffset) : undefined;

    // ③ 도구 응답 — 도구가 인자를 **넘기는** 배선(offset·잘림 표시·ref 우선)까지
    const { createToolRecallMcpServer } = await import("../../core/llm-runtime/capabilities/tool-recall-mcp.js");
    const h = handlerOf(createToolRecallMcpServer({ channel: "telegram", sessionChannel: CH, threadKey: A }), "read_past_tool_result");
    const call$ = async (a: unknown) => JSON.parse((await h(a, {})).content.map((c) => c.text ?? "").join("")) as Record<string, unknown>;
    const noArgs = await call$({});
    const badRef = await call$({ ref: "abc" });
    const viaTool = await call$({ ref: bigRef, offset: TOOL_RECALL_READ_CHARS });
    const refWins = await call$({ ref: newRef, query: "MANY-" });
    const toolSearch = await call$({ query: "NEW-7788" });
    const zero = await call$({ query: "ZERO-HIT-0000" });
    // 참조 번호를 query 칸에 넣는 실수(벤치 실측) — 참조로 읽는다. 참조 모양이 아닌 글은 종전대로 검색.
    const refInQuery = await call$({ query: ` ${newRef} ` });
    // 반대 방향 — 참조 모양이 **섞인** 검색어는 검색이다(통째로 참조일 때만 참조로 읽는다).
    const mixedRef = await call$({ query: `NEW-7788 ${newRef}` });

    // ④ 참조 접기의 이음매 — **실제 압축 드라이버**가 요약기에 넘긴 입력에서 참조를 꺼내, 그 참조로 원문 전체를 되찾는다.
    const H = await import("../../core/llm-runtime/adapters/openai-codex-oauth-history.js");
    const C = "regr:recall-fold";
    const longOut = "머리말 FOLD-HEAD-0101 " + "가".repeat(3_000) + " 깊은곳 FOLD-DEEP-7373 " + "나".repeat(3_000);
    const longArgs = { path: "/srv/w.ts", content: "ARG-HEAD-1212 " + "코".repeat(3_000) + " ARG-DEEP-3434" };
    turn(C, "sc", [call("f1", "Read", { path: "/srv/long.txt" }), out("f1", longOut), call("f2", "Bash", { cmd: "ls" }), out("f2", "짧은결과 FOLD-SHORT-4545"),
      call("f3", "Write", longArgs), out("f3", "ok")]);
    // 도구가 아주 많은 턴 — 되살릴 모양은 한 턴 9만 자로 깎이지만, 접기는 **원 항목**으로 해 참조가 전부 남아야 한다(적대 검토 P2).
    turn(C, "sc", Array.from({ length: 250 }, (_, i) => [call(`g${i}`, "Grep", { q: i }), out(`g${i}`, `MANYTOOL-${i} ` + "다".repeat(12_000))]).flat());
    // 접기 쪽 같은 call_id — 인자가 긴 두 호출이 각자 **자기** 결과를 가리켜야 한다(적대 재검토 G2).
    const dupA = { path: "/dupA", content: "DUPARG-A " + "아".repeat(1_000) }, dupB = { path: "/dupB", content: "DUPARG-B " + "자".repeat(1_000) };
    //  병렬 순서(호출 둘 → 결과 둘)여야 드러난다 — 번갈아 오면 짝짓기 표시가 없어도 우연히 맞는다.
    turn(C, "sc", [call("dd", "Write", dupA), call("dd", "Write", dupB), out("dd", "DUPOUT-A " + "차".repeat(1_000)), out("dd", "DUPOUT-B " + "카".repeat(1_000))]);
    // 짧은 결과가 아주 많은 턴(600쌍 × 300자) — 턴 상한을 넘으면 짧은 것까지 참조로 줄여 **참조가 전부** 남는다(적대 재검토 P2).
    turn(C, "sc", Array.from({ length: 600 }, (_, i) => [call(`h${i}`, "Grep", { q: i }), out(`h${i}`, `SHORTMANY-${i} ` + "타".repeat(290))]).flat());
    for (let i = 0; i < 34; i++) turn(C, "sc", []);
    const seen: string[] = [];
    H.setSummarizerPort(async (text: string) => { seen.push(text); return "요약: " + "요".repeat(80); });
    const manual = await H.compactThreadNow(CH, C, "fake-model", "fake-token", undefined);
    const manual2 = await H.compactThreadNow(CH, C, "fake-model", "fake-token", undefined);
    const manual3 = await H.compactThreadNow(CH, C, "fake-model", "fake-token", undefined);
    const manual4 = await H.compactThreadNow(CH, C, "fake-model", "fake-token", undefined);
    H.setSummarizerPort(null);
    const foldIn = seen.join("\n");
    const foldRef = /\[도구 결과 · ref (\d+#\d+) · \d+자/.exec(foldIn)?.[1] ?? "";
    const argRef = /\[도구 호출 · ref (\d+#\d+) · 인자/.exec(foldIn)?.[1] ?? "";
    const back = read(CH, C, foldRef);
    const argBack = read(CH, C, argRef);
    const manyRefs = new Set([...foldIn.matchAll(/ref (\d+#\d+) · 12\d{3}자/g)].map((m) => m[1])).size;
    const shortRefs = new Set([...foldIn.matchAll(/ref (\d+#\d+) · 3\d{2}자/g)].map((m) => m[1])).size;
    const dupRefs = [...foldIn.matchAll(/\[도구 호출 · ref (\d+#\d+) · 인자 \d+자[^\]]*\] Write\(\{"path":"\/dup([AB])"/g)].map((m) => ({ ref: m[1]!, which: m[2]! }));
    const dupReads = dupRefs.map((d) => ({ which: d.which, r: read(CH, C, d.ref) }));
    const toolMeta = (createToolRecallMcpServer({ channel: CH, threadKey: A }) as unknown as { instance: { _registeredTools: Record<string, { _meta?: Record<string, unknown> }> } }).instance._registeredTools["read_past_tool_result"]?._meta ?? {};

    return [
      assert("재현 조건: 실경로 자식이 다섯 턴을 돌았고 1턴 Read 결과에 표식이 있었다", R.turns === 5 && R.t1ReadHasMark === true && R.error === "", { turns: R.turns, mark: R.t1ReadHasMark, error: R.error, err: child.err.slice(-300) }),
      assert("★Codex 어댑터가 도구를 실제로 등록한다(모델에게 보낸 도구 목록에 있다)", R.t1HasTool === true, R.t1HasTool),
      assert("★실경로: 2턴 검색이 1턴의 Read 결과를 찾고 참조를 준다", R.search?.ok === true && R.search.total === 1 && R.search.hits?.[0]?.tool === "Read" && (R.search.hits[0].snippet ?? "").includes(R.mark ?? "∅"), R.search),
      assert("★실경로: 3턴에 그 참조로 당시 결과 전문을 읽는다", R.read?.ok === true && R.read.ref === R.ref && (R.read.text ?? "").includes(R.mark ?? "∅"), { ref: R.ref, read: R.read?.ok }),
      assert("★실경로: 다른 대화에서는 같은 참조가 거절되고(other_conversation) 같은 표식도 안 찾아진다", R.otherRead?.ok === false && R.otherRead.unavailable === "other_conversation" && R.otherSearch?.ok === true && R.otherSearch.total === 0, { otherRead: R.otherRead, otherSearch: R.otherSearch }),
      assert("★OpenAI 변환(실행): 호출·결과 이벤트 → 짝 맞춘 기록 · 결과는 진입 상한 · 비밀값 가림 · 짝 없는 호출과 잡음은 버림",
        oaItems.length === 4 && oaItems[0]?.type === "function_call" && (oaItems[0] as { arguments: string }).arguments.includes("/a.txt") &&
          oaOut1 !== undefined && oaOut1.output.length < bigOut.length && oaOut1.output.includes("OA-HEAD") && oaOut1.output.includes("OA-TAIL") &&
          !JSON.stringify(oaItems).includes("sk-proj-REGRRECALLABCDEFGHIJKLMNOP12") && oaEmpty.turnItems === undefined,
        { n: oaItems.length, out1: oaOut1?.output.length, empty: oaEmpty }),
      assert("★OpenAI 어댑터가 그 변환을 스트림마다 부르고 반환에 싣는다 · 세 어댑터 모두 입력을 통째로 넘겨 등록(대화 식은 도구 한 곳)", oaWired && oaGate && regs.every(Boolean), { oaWired, oaGate, regs }),
      assert("이 대화의 결과를 찾는다 · 다른 대화·다른 채널의 같은 값은 섞이지 않는다",
        newHit.total === 1 && newHit.hits[0]?.tool === "Read" && bSearch.total === 1 && bSearch.hits[0]?.ref !== newRef && tgSearch.total === 1 && tgSearch.hits[0]?.ref !== newRef,
        { a: newHit.total, b: bSearch.total, tg: tgSearch.total }),
      assert("★회수 도구 자신의 결과는 검색에 안 걸린다(같은 검색을 되풀이해도 원본이 밀려나지 않는다)", newHit.total === 1, newHit.hits.map((x) => x.tool)),
      assert("★/clear 이전 결과는 검색에 안 나오고, 참조로도 before_boundary 로 거절된다", oldHit.total === 0 && oldTid !== undefined && !beforeClear.ok && beforeClear.reason === "before_boundary", { oldHit: oldHit.total, beforeClear }),
      assert("★다른 대화의 참조는 other_conversation — 비슷한 기록으로 대신하지 않는다", !inB.ok && inB.reason === "other_conversation", inB),
      assert("참조로 당시 결과 전문·도구 이름·인자를 돌려준다", full.ok && full.text.includes("NEW-7788") && full.tool === "Read" && full.args.includes("config.ts") && full.nextOffset === undefined, full),
      assert("틀린 참조 형식·없는 기록·도구 결과가 아닌 항목은 각자의 사유로 거절",
        (read(CH, A, "abc") as { reason?: string }).reason === "bad_ref" && (read(CH, A, "999999#1") as { reason?: string }).reason === "not_found" && (callItem as { reason?: string }).reason === "not_tool_result",
        { callItem }),
      assert("★같은 call_id 가 한 턴에 둘이어도 검색한 결과와 읽은 결과가 같다(인자도 그 호출의 것)",
        secondRead.ok && secondRead.text.includes("SECOND-222") && secondRead.args.includes("/b") && firstRead.ok && firstRead.text.includes("FIRST-111") && firstRead.args.includes("/a"),
        { second: second.hits[0]?.ref, first: first.hits[0]?.ref }),
      assert("같은 call_id 병렬 호출은 먼저 연 호출이 먼저 온 결과와 짝이다(순서대로)",
        par1.ok && par1.args.includes("/p1") && par2.ok && par2.args.includes("/p2"), { p1: par1.ok && par1.args, p2: par2.ok && par2.args }),
      assert("인자(경로)로도 찾는다 — 참조는 언제나 그 호출의 결과 항목", byArg.total === 1 && byArg.hits[0]?.ref === newRef, byArg),
      assert("★윈도우 경로(역슬래시)도 풀린 모양으로 찾는다", win.total === 1 && win.hits[0]?.tool === "Read", win),
      assert("비ASCII 대소문자(ä/Ä)도 찾는다 · ★섞인 대소문자(ÄöÜ ← äöü)도", umlaut.total === 1 && mixed.total === 1, { umlaut: umlaut.total, mixed: mixed.total }),
      assert("★저장 모양(JSON 키·call_id)에만 걸리는 검색어는 적중이 아니다", jsonKey.total === 0, jsonKey.total),
      assert("결과·인자 둘 다에 걸려도 한 번만 센다", both.total === 1, both.total),
      assert("최근 순이다", recent.total === 2 && (recent.hits[0]?.snippet ?? "").includes("100X") && (recent.hits[1]?.snippet ?? "").includes("100%"), recent.hits.map((x) => x.snippet)),
      assert("★검색어의 %·_ 는 문자 그대로(와일드카드 아님) — «100%» 는 «100X» 를 안 찾는다", pct.total === 1 && pct.hits[0]?.snippet.includes("100%_done") === true, pct),
      assert("검색어의 따옴표·줄바꿈도 저장 모양(JSON)과 무관하게 찾는다", quote.total === 1, quote),
      assert("목록은 상한(10)까지, 전체 수는 따로 알린다", many.hits.length === 10 && many.total === 12, { shown: many.hits.length, total: many.total }),
      assert("★검색은 적중한 턴마다 **한 번만** 읽는다(N+1 금지) · 상한을 넘은 적중엔 조각을 안 만든다",
        manyProbe.total === 12 && s1.turnLoads - s0.turnLoads === 1 && s1.snippets - s0.snippets === 10, { loads: s1.turnLoads - s0.turnLoads, snippets: s1.snippets - s0.snippets }),
      assert("전체 수는 상한(1,000)까지만 세고 «이상» 으로 알린다", capped.total === TOOL_RECALL_COUNT_CAP && capped.totalCapped === true, { total: capped.total, capped: capped.totalCapped }),
      assert("0건이면 그 뜻(보관은 Codex·OpenAI 결과만)을 알린다 — «그런 실행이 없었다» 로 읽지 않게", zero.total === 0 && typeof zero.note === "string" && String(zero.note).includes("Claude"), zero),
      assert("★Claude 에는 접힌 채 실린다(이름만 — 순수 Claude 대화의 매 요청 비용을 안 늘린다)", typeof toolMeta["anthropic/searchHint"] === "string", toolMeta),
      assert("★긴 결과는 잘렸다고 알리고 이어 읽는다 — 이어 붙이면 원문과 같다",
        big1.ok && big1.text.length === TOOL_RECALL_READ_CHARS && big1.nextOffset === TOOL_RECALL_READ_CHARS &&
          big2?.ok === true && big3?.ok === true && big3.nextOffset === undefined &&
          big1.text.length + big2.text.length + big3.text.length === 45_000,
        { b1: big1.ok && big1.text.length, b2: big2?.ok && big2.text.length, b3: big3?.ok && big3.text.length }),
      assert("도구 응답: 인자가 없으면 오류, 틀린 참조는 unavailable + 사유 문장", noArgs.ok === false && typeof noArgs.error === "string" && badRef.ok === false && badRef.unavailable === "bad_ref" && typeof badRef.note === "string", { noArgs, badRef }),
      assert("★도구가 offset 을 넘기고 잘림을 알린다 · ref 가 query 보다 우선 · 세션 채널로 대화를 잡는다(입력 채널 아님)",
        viaTool.ok === true && viaTool.offset === TOOL_RECALL_READ_CHARS && viaTool.truncated === true && viaTool.nextOffset === TOOL_RECALL_READ_CHARS * 2 &&
          refWins.ref === newRef && typeof refWins.text === "string" && toolSearch.total === 1,
        { viaTool: { offset: viaTool.offset, truncated: viaTool.truncated, next: viaTool.nextOffset }, refWins: refWins.ref, toolSearch: toolSearch.total }),
      assert("★참조 번호를 query 칸에 넣어도 그 결과를 읽는다(검색 0건으로 포기하지 않게)",
        refInQuery.ok === true && refInQuery.ref === newRef && typeof refInQuery.text === "string" && refInQuery.text === refWins.text &&
          mixedRef.ref === undefined && typeof mixedRef.total === "number",
        { ref: refInQuery.ref, ok: refInQuery.ok, mixedRef: { ref: mixedRef.ref, total: mixedRef.total } }),
      assert("재현 조건: 수동 압축이 도구 결과가 든 턴들을 접었다", manual.ok === true && manual2.ok === true && manual3.ok === true && manual4.ok === true && seen.length >= 1, { manual, manual2, manual3, manual4, calls: seen.length }),
      assert("★짧은 결과가 아주 많은 턴(600쌍)도 턴 상한 안에서 참조가 전부 남는다(앞쪽이 잘려 참조가 빠지지 않는다)", shortRefs === 600 && !foldIn.includes("요약 입력 상한으로 앞쪽"), { shortRefs }),
      assert("★접기 쪽 같은 call_id: 인자가 긴 두 호출이 각자 자기 결과를 가리킨다(참조로 읽으면 그 호출의 인자·결과)",
        dupReads.length === 2 && dupReads.every((d) => d.r.ok && d.r.args.includes(`DUPARG-${d.which}`) && d.r.text.includes(`DUPOUT-${d.which}`)),
        dupReads.map((d) => ({ which: d.which, ok: d.r.ok }))),
      assert("★접을 때 긴 도구 결과는 참조+앞부분만 — 원문 깊은 곳은 요약기에 안 들어간다(요약기 입력이 결과 양에 비례하지 않는다)",
        foldRef !== "" && foldIn.includes("FOLD-HEAD-0101") && !foldIn.includes("FOLD-DEEP-7373"),
        { foldRef, head: foldIn.includes("FOLD-HEAD-0101"), deep: foldIn.includes("FOLD-DEEP-7373") }),
      assert("★긴 호출 인자도 참조+앞부분만 — 그 참조로 인자 전문을 되찾는다",
        argRef !== "" && foldIn.includes("ARG-HEAD-1212") && !foldIn.includes("ARG-DEEP-3434") && argBack.ok && argBack.args.includes("ARG-DEEP-3434"),
        { argRef, deep: foldIn.includes("ARG-DEEP-3434"), back: argBack.ok }),
      assert("짧은 도구 결과는 그대로 접는다(줄일 게 없다 — 참조·잘림 표시도 안 붙는다)", foldIn.includes("[도구 결과] 짧은결과 FOLD-SHORT-4545"), foldIn.includes("FOLD-SHORT-4545")),
      assert("★이음매: 요약기 입력의 참조로 read_past_tool_result 가 원문 **전체**를 되찾는다(접은 쪽과 읽는 쪽이 같은 참조)",
        back.ok && back.text === longOut && back.tool === "Read", back.ok ? { chars: back.chars } : back),
      assert("★도구가 아주 많은 턴(250개)도 결과마다 참조가 남는다 — 되살릴 모양(깎인 것)이 아니라 원 항목으로 접는다", manyRefs === 250, { manyRefs }),
    ];
  },
};
