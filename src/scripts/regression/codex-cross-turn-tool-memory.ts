/**
 * 회귀: **이전 턴에 도구로 읽은 것이 다음 턴 입력에 남는다** (2026-09-27, 벤치 multi-turn-recall 7/14).
 *
 * ★사고: Codex 어댑터가 이전 턴을 «사용자 텍스트 · 최종 답» 두 줄로만 되살려, 턴 안에서 도구로 읽은 내용이
 *  턴이 끝나면 버려졌다. 같은 모델의 쌩 Codex·Claude Code 는 14/14. 처방: 턴 항목을 비서 답 행에 묶어 저장하고
 *  «사용자 → 도구 항목 → 답» 으로 되살린다. 설계·검토: docs/decisions/2026-09-27-codex-cross-turn-tool-memory*.md
 *
 * 제품 함수를 그대로 부른다(모형 없음): 턴 안 입력 배열을 실제 빌더로 쌓고 → `collectTurnItems` → `appendApiTurn`
 *  → `compactThreadHistory` → `recentTurnsAfter` → `buildCodexInputArray` 로 다음 턴 입력을 만든다. 모델 호출 0.
 */
import { fileURLToPath } from "node:url";
import { assert, spawnWithin, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "codex-cross-turn-tool-memory",
  guards: "이전 턴 도구 호출·출력·작업 중 지시가 다음 턴 입력에서 사라지던 것 · 큰 턴 하나가 이전 이력을 통째로 비우던 것 · 요약이 도구 사실을 못 보던 것",
  run: async (): Promise<Assertion[]> => {
    const { initStore, getDb } = await import("../../store/sessions.js");
    const { appendApiTurn, loadThreadHistoryWithIds } = await import("../../store/memory.js");
    const { clearThreadSummary } = await import("../../store/thread-summaries.js");
    const H = await import("../../core/llm-runtime/adapters/openai-codex-oauth-history.js");
    type Item = import("../../core/llm-runtime/adapters/openai-codex-oauth-history.js").ResponseInputItem;
    initStore();
    const CH = "http-bridge" as const;
    const room = { requestChars: 0 };
    const current = (text: string): Item => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });

    /** 실제 빌더로 한 턴을 쌓는다 — 호출·출력 N개 · 하네스 독촉 · 작업 중 지시 · 추론 · 최종 답. */
    const runTurn = async (label: string, outputs: string[], opts: { steer?: string; unmatched?: boolean; compactInTurn?: boolean; talk?: string[] } = {}) => {
      const arr = H.buildCodexInputArray([], "", current(`${label} 질문`));
      const start = arr.length;
      arr.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: `${label} 읽어 보겠습니다` }] });
      outputs.forEach((_, i) => arr.push({ type: "function_call", id: `fc_${label}_${i}`, call_id: `c_${label}_${i}`, name: "Read", arguments: `{"path":"${label}-${i}.md"}` }));
      H.appendToolResultsToInput(arr, outputs.map((o, i) => ({ callId: `c_${label}_${i}`, name: "Read", output: o, media: [] })), room);
      if (opts.unmatched === true) arr.push({ type: "function_call", call_id: `c_${label}_orphan`, name: "Bash", arguments: "{}" });
      // 작업 중 비서 발화 — 접을 때 **줄지 않는** 내용(도구 결과는 참조로 준다, 2026-09-30). 큰 턴을 이걸로 만든다.
      for (const t of opts.talk ?? []) arr.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: t }] });
      arr.push({ type: "message", role: "user", content: [{ type: "input_text", text: "지금까지 도구를 3회 사용했습니다. 계속 진행하세요" }] }); // 하네스 독촉
      if (opts.steer !== undefined) arr.push(await H.buildSteeringInputItem({ text: opts.steer, attachments: [] } as never));
      if (opts.compactInTurn === true) H.compactOldToolOutputs(arr, { batchChars: 0, keepRecent: 0, minOutputChars: 1 });
      arr.push({ type: "reasoning", id: "rs_1", summary: [], encrypted_content: "SECRET-CIPHER" });
      const final = `${label} 답입니다`;
      arr.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: final }] });
      return { items: H.collectTurnItems(arr.slice(start), final), final };
    };
    const TK = (s: string) => `regr:cross-turn-memory:${s}:${Date.now()}`;
    const sidOf = (tk: string) => `codex-${tk}`;
    const persist = (tk: string, label: string, t: { items: ReturnType<typeof H.collectTurnItems>; final: string }) =>
      appendApiTurn({ channel: CH, threadKey: tk, claudeSessionId: sidOf(tk), userContent: `${label} 질문`, assistantContent: t.final, items: t.items });
    const nextInput = async (tk: string, fixedChars: number, summarize?: (t: string) => void) => {
      const r = await H.compactThreadHistory({
        channel: CH, threadKey: tk, provider: `regr-ctm-${tk}`, adapter: "codex", budget: { instructionsChars: fixedChars, promptChars: 0 },
        summarize: async (text: string) => { summarize?.(text); return "요약본 ".repeat(20); },
      });
      const win = H.recentTurnsAfter(r.allTurns, r.watermark, { budgetUsedChars: fixedChars + r.summary.length });
      let boundary = { summaryCount: 0, historyCount: 0 };
      const input = H.buildCodexInputArray(win, r.summary, current("다음 질문"), (b) => { boundary = b; });
      return { r, win, input, boundary };
    };
    const outputsOf = (xs: Item[]) => xs.filter((x): x is Extract<Item, { type: "function_call_output" }> => x.type === "function_call_output");

    // ── A. 왕복: 저장 → 다음 턴 입력 ──
    const tkA = TK("a");
    clearThreadSummary(CH, tkA);
    const t1 = await runTurn("T1", ["문서 첫 줄\n마감은 FACT-7731 이다", "둘째 문서"], { steer: "타임아웃은 20초로 해 주세요", unmatched: true, compactInTurn: true });
    persist(tkA, "T1", t1);
    const A = await nextInput(tkA, 10_000);
    const types = A.input.map((x) => (x.type === "message" ? `${x.type}:${x.role}` : x.type));
    const outsA = outputsOf(A.input);

    // ── B. 이력 출력은 턴 안 몰아서 압축에서 빠진다 · 상한 근처(batchChars 0)만 예외 ──
    const hist = H.buildCodexInputArray([{ role: "user", content: "q" }, { role: "assistant", content: "a",
      items: Array.from({ length: 6 }, (_, i) => [
        { type: "function_call" as const, call_id: `h${i}`, name: "Read", arguments: "{}" },
        { type: "function_call_output" as const, call_id: `h${i}`, output: `HIST-${i} ` + "가".repeat(30_000) },
      ]).flat() }], "", current("now"));
    // 압축은 새 결과를 붙이기 **전에** 돈다 — 여러 번 불러야 새 출력까지 쌓인 상태에서 판정한다(한 번이면 공짜 초록).
    for (const round of [0, 1, 2, 3]) H.appendToolResultsToInput(hist, Array.from({ length: 5 }, (_, i) => ({ callId: `n${round}_${i}`, name: "Read", output: `NEW-${i} ` + "나".repeat(30_000), media: [] })), room);
    const newCompacted = outputsOf(hist).filter((o) => o.output.includes("이전 도구 출력 생략")).length;
    const histAfterNormal = outputsOf(hist).filter((o) => o.output.startsWith("HIST-")).length;
    H.compactOldToolOutputs(hist, { batchChars: 0 });
    const histAfterForced = outputsOf(hist).filter((o) => o.output.startsWith("HIST-")).length;

    // ── C. 큰 턴(아스트라 재현): 16K 안쪽 결과 14개 = 21만 자 ──
    const tkC = TK("c");
    clearThreadSummary(CH, tkC);
    persist(tkC, "C0", await runTurn("C0", ["앞 턴 사실 EARLY-42"]));
    const big = await runTurn("C1", Array.from({ length: 14 }, (_, i) => `BIG-${i} ` + "다".repeat(15_000 - 8)));
    persist(tkC, "C1", big);
    const bigRawChars = big.items.reduce((n, it) => n + JSON.stringify(it).length, 0);
    const C = await nextInput(tkC, 50_000);
    const C2 = await nextInput(tkC, 50_000);
    const bigTurn = C.win.find((t) => t.content === "C1 답입니다");

    // ── D. 요약 입력에 도구 사실·작업 중 지시(역할 표식)가 들어가고, 접힌 턴 항목은 지우지 않는다 ──
    const tkD = TK("d");
    clearThreadSummary(CH, tkD);
    persist(tkD, "D0", await runTurn("D0", ["접힐 사실 FOLD-9001 " + "라".repeat(4_000)], { steer: "보고서는 표로 주세요" }));
    for (let i = 1; i <= 12; i++) persist(tkD, `D${i}`, await runTurn(`D${i}`, ["마".repeat(5_000)]));
    let foldInput = "";
    const D = await nextInput(tkD, 150_000, (t) => { foldInput += t; });
    const d0Id = loadThreadHistoryWithIds(CH, tkD).find((t) => t.content === "D0 답입니다")?.id ?? -1;
    const rowsKept = (getDb().prepare("SELECT count(*) AS n FROM turn_items WHERE transcript_id = ?").get(d0Id) as { n: number }).n;
    const loadedAfterFold = loadThreadHistoryWithIds(CH, tkD, { itemsAfter: D.r.watermark }).find((t) => t.id === d0Id)?.items;

    // ── E. 원자성: 항목 직렬화가 실패하면 그 턴의 행이 하나도 안 남는다 ──
    const tkE = TK("e");
    let threw = false;
    try {
      appendApiTurn({ channel: CH, threadKey: tkE, claudeSessionId: sidOf(tkE), userContent: "u", assistantContent: "a",
        items: [{ type: "function_call_output", call_id: "x", output: 1n as never }] });
    } catch { threw = true; }
    const rowsE = (getDb().prepare("SELECT count(*) AS n FROM transcripts WHERE claude_session_id = ?").get(sidOf(tkE)) as { n: number }).n;

    // ── F. 안 되살리는 어댑터(openai)는 항목 크기를 세지 않는다 ──
    const F = await H.compactThreadHistory({ channel: CH, threadKey: tkA, provider: "regr-ctm-f", adapter: "openai", budget: { instructionsChars: 10_000, promptChars: 0 }, summarize: async () => "x" });

    // ── J. openai 쪽에서 접어도 Codex 턴의 도구 사실이 요약에 들어간다(적대 검토 P2-3 — 종전엔 영구 소실) ──
    const tkJ = TK("j");
    clearThreadSummary(CH, tkJ);
    // openai 는 항목 크기를 안 세므로 **텍스트만으로** 요약 기준을 넘긴다(질문을 길게).
    const persistLong = async (label: string, outputs: string[]) => {
      const t = await runTurn(label, outputs);
      appendApiTurn({ channel: CH, threadKey: tkJ, claudeSessionId: sidOf(tkJ), userContent: `${label} 질문 ` + "파".repeat(3_000), assistantContent: t.final, items: t.items });
    };
    await persistLong("J0", ["오픈AI 쪽 사실 OAI-FOLD-6161 " + "차".repeat(4_000)]);
    for (let i = 1; i <= 12; i++) await persistLong(`J${i}`, ["카".repeat(500)]);
    let foldJ = "";
    await H.compactThreadHistory({ channel: CH, threadKey: tkJ, provider: "regr-ctm-j", adapter: "openai", budget: { instructionsChars: 179_900, promptChars: 0 },
      summarize: async (t: string) => { foldJ += t; return "요약본 ".repeat(20); } });

    // ── K. 이스케이프가 많은 결과·큰 인자 — 상한을 지키면서 예산을 실제로 쓰고, 깎은 인자는 유효한 JSON ──
    const cap = H.turnItemsReplayChars();
    const jsonOut = JSON.stringify({ rows: Array.from({ length: 400 }, (_, i) => ({ k: `v"${i}"`, p: "a\\b\n" })) }).slice(0, 15_000);
    const K = H.replayTurnItems([
      ...Array.from({ length: 14 }, (_, i) => [
        { type: "function_call" as const, call_id: `k${i}`, name: "Write", arguments: JSON.stringify({ path: `f${i}.js`, content: "const s = \"x\";\n".repeat(1_500) }) },
        { type: "function_call_output" as const, call_id: `k${i}`, output: jsonOut },
      ]).flat(),
    ], cap);
    const kChars = H.turnItemsChars(K);
    const kOutputs = K.filter((x) => x.type === "function_call_output").map((x) => (x as { output: string }).output.length);
    const kArgsValid = K.filter((x) => x.type === "function_call").every((x) => { try { JSON.parse((x as { arguments: string }).arguments); return true; } catch { return false; } });

    // ── L. 호출이 수백 개(뼈대만으로 넘침) — 오래된 쌍부터 통째로 빠지고, 최근 쌍·짧은 항목은 온전하다 ──
    const L = H.replayTurnItems(Array.from({ length: 400 }, (_, i) => [
      { type: "function_call" as const, call_id: `l${i}`, name: "Edit", arguments: JSON.stringify({ path: `src/file-${i}.ts`, old: "a".repeat(40) }) },
      { type: "function_call_output" as const, call_id: `l${i}`, output: `ok ${i} ` + "b".repeat(280) },
    ]).flat(), cap);
    const lLast = L.filter((x) => x.type === "function_call_output").at(-1) as { output: string } | undefined;
    const lPairs = L.filter((x) => x.type === "function_call").length;
    const lNoteN = Number(/도구 호출 (\d+)건/.exec(L[0]?.type === "message" ? L[0].text : "")?.[1] ?? -1);
    // 작은 쌍 수백 개 + 최근 큰 인자 하나 — 쌍을 빼다 큰 항목까지 통째로 사라지는 절벽이 없어야 한다(재검토 ①).
    const Lbig = H.replayTurnItems([
      ...Array.from({ length: 250 }, (_, i) => [
        { type: "function_call" as const, call_id: `e${i}`, name: "Edit", arguments: JSON.stringify({ path: `src/f${i}.ts`, old: "a".repeat(40) }) },
        { type: "function_call_output" as const, call_id: `e${i}`, output: `ok ${i} ` + "b".repeat(280) },
      ]).flat(),
      { type: "function_call" as const, call_id: "w", name: "Write", arguments: JSON.stringify({ path: "big.ts", content: "c".repeat(100_000) }) },
      { type: "function_call_output" as const, call_id: "w", output: "written big.ts" },
    ], cap);
    // 짧은 항목(200자 이하)은 큰 항목과 섞여도 깎이지 않는다.
    const Kshort = H.replayTurnItems([
      ...Array.from({ length: 20 }, (_, i) => [
        { type: "function_call" as const, call_id: `s${i}`, name: "Read", arguments: "{}" },
        { type: "function_call_output" as const, call_id: `s${i}`, output: "s".repeat(150) },
      ]).flat(),
      { type: "function_call" as const, call_id: "big", name: "Read", arguments: "{}" },
      { type: "function_call_output" as const, call_id: "big", output: "B".repeat(120_000) },
    ], cap);
    // 착수 조건 로그 — 상한을 넘는 턴을 모으면 한 줄 남긴다(아스트라 후속 B).
    const logged: string[] = [];
    const realLog = console.log;
    console.log = (...a: unknown[]) => { logged.push(a.map(String).join(" ")); };
    try { await runTurn("LOG", Array.from({ length: 8 }, () => "라".repeat(15_000))); } finally { console.log = realLog; }

    // ── M. 수동 /compact 도 도구 사실을 요약 입력에 넣는다(적대 검토 G5 — 이 경로엔 검사가 0 이었다) ──
    const tkM = TK("m");
    clearThreadSummary(CH, tkM);
    persist(tkM, "M0", await runTurn("M0", ["수동 압축 사실 MANUAL-7171"]));
    for (let i = 1; i <= 40; i++) persist(tkM, `M${i}`, await runTurn(`M${i}`, ["타".repeat(200)]));
    let foldM = "";
    H.setSummarizerPort(async (t: string) => { foldM += t; return "요약본 ".repeat(20); });
    let manual: unknown;
    try { manual = await H.compactThreadNow(CH, tkM, "fake-model", "fake-token", undefined); } finally { H.setSummarizerPort(null); }

    // ── N. 실제 경로(router → 퍼사드 → 어댑터 루프 → 저장 → 다음 턴) — 이음매 둘과 답 중복 ──
    // ★전용 홈 — 스위트 공유 홈엔 앞선 검사가 남긴 모델 설정이 있어 다른 풀(claude)을 고른다(실측: 단독 초록·전체 빨강).
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const childHome = mkdtempSync(`${tmpdir()}/tiguclaw-regression-cross-turn-`);
    const child = await spawnWithin(90_000, "턴 간 도구 기억 실경로", ["--import", "tsx", fileURLToPath(new URL("./_codex-cross-turn-memory-child.ts", import.meta.url))], { env: { ...process.env, TIGUCLAW_HOME: childHome } })
      .finally(() => rmSync(childHome, { recursive: true, force: true }));
    const line = child.out.split(/\r?\n/).find((l) => l.startsWith("CROSS_TURN_RESULT "));
    const N = (line === undefined ? {} : JSON.parse(line.slice("CROSS_TURN_RESULT ".length))) as { turns?: number; t2HasT1?: boolean; t3T1Count?: number; t3T2Count?: number; t2AnswerCount?: number };

    // ── S. 저장 전 비밀값 가리기(전체 검토 2026-09-28) — 모델이 읽은 `.env` 같은 도구 결과가 DB 에 남고 다음 턴에 다시 간다.
    const secretEnv = "REGR_CROSS_TURN_API_TOKEN";
    const savedSecret = process.env[secretEnv];
    process.env[secretEnv] = "tok_REGRsecretValue_1234567890abcdef";
    let secretItems: ReturnType<typeof H.collectTurnItems> = [];
    try {
      secretItems = (await runTurn("SEC", [`API_TOKEN=${process.env[secretEnv]}\nOPENAI_API_KEY=sk-proj-REGRABCDEFGHIJKLMNOPQRSTUV12\n일반 줄 PLAIN-4242`])).items;
    } finally { if (savedSecret === undefined) delete process.env[secretEnv]; else process.env[secretEnv] = savedSecret; }
    const secretDump = JSON.stringify(secretItems);
    // 도구 **인자**도 가린다 — 모델이 명령에 키를 넣어 부른 경우(적대 검토 G2: 인자 가리기를 빼도 초록이었다).
    const argDump = JSON.stringify(H.collectTurnItems([
      { type: "function_call", call_id: "c_arg", name: "Bash", arguments: JSON.stringify({ command: "curl -H 'Authorization: Bearer sk-proj-REGRARGSABCDEFGHIJKLMNOP99' https://x" }) },
      { type: "function_call_output", call_id: "c_arg", output: "ok" },
    ] as Item[], "끝"));

    // ── G. 창 안전망(요약 실패 시): 도구 항목까지는 안 들어가도 텍스트는 남긴다 — 큰 최신 턴에서 멈추지 않는다 ──
    const G = H.recentTurnsAfter([
      { id: 1, role: "user", content: "옛 질문" }, { id: 2, role: "assistant", content: "옛 답" },
      { id: 3, role: "user", content: "새 질문" }, { id: 4, role: "assistant", content: "새 답", items: [], itemsChars: 50_000 },
    ], 0, { budgetUsedChars: 0, charCap: 1_000 });

    // ── H. 벤치 모양(2026-09-27 9/14 의 원인): 43KB 문서를 나눠 읽은 6.4만 자 턴 — 조각 꼬리의 사실이 남는다 ──
    const tkH = TK("h");
    clearThreadSummary(CH, tkH);
    persist(tkH, "H0", await runTurn("H0", [0, 1, 2, 3].map((i) => "바".repeat(15_000) + (i === 2 ? " TAIL-FACT-3131" : ""))));
    const Hn = await nextInput(tkH, 50_000);
    const hTurn = Hn.win.find((t) => t.content === "H0 답입니다");

    // ── I. 요약 1회분(4만)보다 큰 턴은 조각으로 나눠 요약하고, 꼬리 사실이 요약 입력에 닿는다 ──
    //  ★큰 턴은 **작업 중 발화**로 만든다(2026-09-30) — 도구 결과는 접을 때 참조+앞부분만 가므로 더는 요약 입력을 키우지 않는다
    //   (그 계약·되찾기는 `tool-recall-reads-this-conversation` ④). 이 장치(조각 나누기)가 지키는 건 줄지 않는 큰 내용이다.
    const tkI = TK("i");
    clearThreadSummary(CH, tkI);
    persist(tkI, "I0", await runTurn("I0", ["짧은 결과"], { talk: [0, 1, 2, 3, 4].map((i) => "사".repeat(14_000) + (i === 4 ? " FOLD-TAIL-5151" : "")) }));
    for (let i = 1; i <= 6; i++) persist(tkI, `I${i}`, await runTurn(`I${i}`, ["아".repeat(3_000)]));
    const pieces: string[] = [];
    const In = await nextInput(tkI, 150_000, (t) => { pieces.push(t); });
    const i0Id = loadThreadHistoryWithIds(CH, tkI).find((t) => t.content === "I0 답입니다")?.id ?? -1;

    // ── O. 조각 나누기 계약(아스트라 후속 A) — 호출 ≤ 4 · 조각 ≤ 예산 · 이어 붙이면 원문 · 계획과 실행이 같은 입력을 잰다 ──
    const repro = ("x".repeat(59) + "\n").repeat(6) + "x".repeat(40); // 아스트라 재현: 종전 6호출
    const reproSizes: number[] = [];
    const reproJoined: string[] = [];
    await H.summarizeInChunks(repro, 100, async (piece: string) => { reproSizes.push(piece.length); reproJoined.push(piece); return "요약 " + "가".repeat(60); });
    // 조각 결과의 **순서**와 조각별 **목표 분량** — 이어 붙인 요약이 시간순이어야 한다.
    const orderTargets: { len: number; target: number }[] = [];
    // 조각이 커야 목표 분량이 하한에 안 붙는다(작으면 전체 길이로 잘못 줘도 같아 보인다).
    const ordered = await H.summarizeInChunks("A".repeat(20_000) + "B".repeat(20_000) + "C".repeat(20_000), 25_000, async (piece: string, target: number) => {
      orderTargets.push({ len: piece.length, target }); return `조각-${piece[0]} ` + "나".repeat(60); });
    // 조각 하나가 짧은 거절 문구면 전체가 실패다(부분 성공 위장 금지).
    // ★조각은 동시에 부른다(10-04) — 첫 응답 전에 모든 호출이 시작돼야 하고, 늦게 끝난 조각도 제자리에 붙는다.
    let thrownCalls = 0;
    let inFlight = 0;
    let peak = 0;
    const lateFirst = await H.summarizeInChunks("A".repeat(20_000) + "B".repeat(20_000) + "C".repeat(20_000), 25_000, async (piece: string) => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, piece[0] === "A" ? 30 : piece[0] === "B" ? 15 : 1)); // A 가 가장 늦게 끝난다
      inFlight--; return `조각-${piece[0]} ` + "라".repeat(60); });
    // 조각 하나가 **던지면** 전체가 그 오류로 거부된다 — «빈 요약» 으로 삼키면 429 가 쿨다운 대신 «요약 0자» 로 바뀐다(10-04 적대 검토).
    let thrown: unknown;
    try {
      await H.summarizeInChunks("x".repeat(250), 100, async (piece: string) => {
        if (piece === "x".repeat(piece.length) && thrownCalls++ === 1) throw new Error("429 rate limited");
        return "요약 " + "마".repeat(60);
      });
    } catch (e) { thrown = e; }
    let refusedCall = 0;
    const refused = await H.summarizeInChunks("x".repeat(250), 100, async () => (++refusedCall === 2 ? "요약할 수 없습니다." : "요약 " + "다".repeat(60)));
    // 서로게이트 쌍(이모지)을 쪼개지 않는다.
    const emoji = "a" + "🙂".repeat(199); // 399 코드 유닛 — 홀수 오프셋이라 고른 경계(100)가 쌍 한가운데에 떨어진다
    const emojiParts = H.splitForFold(emoji, 101, 4);
    const emojiSplit = emojiParts.some((x) => /[\uD800-\uDBFF]$/.test(x) || /^[\uDC00-\uDFFF]/.test(x));
    // 짧은 턴이 많아도 한 패스의 **최종 입력**이 예산 안(머리말 포함).
    const shortPlan = H.planHistoryCompaction(Array.from({ length: 400 }, (_, i) => ({ id: i + 1, role: i % 2 === 0 ? ("user" as const) : ("assistant" as const), content: "ab" })), 0, { triggerChars: 1, keepRecent: 2, maxFoldChars: 1_000 });
    const shortLen = H.foldPromptOf(shortPlan.toFold).length;
    const shapes: Record<string, (L: number) => string> = {
      "줄바꿈 없음": (L) => "가".repeat(L),
      "경계마다 줄바꿈": (L) => ("y".repeat(99) + "\n").repeat(Math.ceil(L / 100)).slice(0, L),
      "긴 한 줄 + 끝 줄바꿈": (L) => "z".repeat(L - 1) + "\n",
      "한글·이스케이프": (L) => ('{"k":"값\\"\n'.repeat(L)).slice(0, L),
    };
    const splitBad: string[] = [];
    for (const [name, mk] of Object.entries(shapes)) for (const L of [101, 199, 200, 201, 333, 399, 400]) {
      const t = mk(L);
      const parts = H.splitForFold(t, 100, 4);
      if (parts.length !== Math.ceil(L / 100) || parts.some((x) => x.length > 100 || x.length === 0) || parts.join("") !== t) splitBad.push(`${name}/${L}:${parts.map((x) => x.length).join(",")}`);
    }
    let overThrows = false;
    try { H.splitForFold("a".repeat(401), 100, 4); } catch { overThrows = true; }
    // 머리말 때문에 경계를 넘는 턴 · 4조각 용량을 넘는 턴 — 계획이 **최종 입력**으로 판정한다.
    const B = 1_000;
    const edge = H.planHistoryCompaction([{ id: 1, role: "assistant", content: "e".repeat(B * 4 - 2) }, { id: 2, role: "user", content: "u" }, { id: 3, role: "assistant", content: "a" }], 0, { triggerChars: 1, keepRecent: 2, maxFoldChars: B });
    const huge = H.planHistoryCompaction([{ id: 1, role: "assistant", content: "h".repeat(B * 9) + "ANSWER-END" }, { id: 2, role: "user", content: "u" }, { id: 3, role: "assistant", content: "a" }], 0, { triggerChars: 1, keepRecent: 2, maxFoldChars: B });
    // 질문 + 큰 답은 한 단위 — 질문만 따로 한 패스를 먹지 않는다.
    // ★사용자 메시지는 **첫머리가 지시**다 — 잘라야 할 때 앞도 남긴다(2026-10-05 벤치: 일지 첫 줄의 규칙 변경이 잘려 18→11점).
    const ask = H.planHistoryCompaction([{ id: 1, role: "user", content: "RULE-HEAD-7171 " + "from now on drop sev4 and keep earlier days. ".repeat(12) + "RULE-BODY-END-7373 " + "l".repeat(B * 9) + " LOG-END-7272" }, { id: 2, role: "assistant", content: "a" }, { id: 3, role: "user", content: "u" }, { id: 4, role: "assistant", content: "a" }], 0, { triggerChars: 1, keepRecent: 2, maxFoldChars: B });
    const askBody = ask.toFold.map((t) => t.content).join("\n");
    const qa = H.planHistoryCompaction([{ id: 1, role: "user", content: "질문" }, { id: 2, role: "assistant", content: "q".repeat(B * 3) }, { id: 3, role: "user", content: "u" }, { id: 4, role: "assistant", content: "a" }], 0, { triggerChars: 1, keepRecent: 2, maxFoldChars: B });
    const edgeLen = H.foldPromptOf(edge.toFold).length, hugeLen = H.foldPromptOf(huge.toFold).length;

    // ── P. 중간 조각 실패 → 부분 성공으로 넘어가지 않는다(워터마크 유지) · 다음 시도에서 진행한다 ──
    const tkP = TK("p");
    clearThreadSummary(CH, tkP);
    persist(tkP, "P0", await runTurn("P0", ["짧은 결과"], { talk: [0, 1, 2, 3, 4].map((i) => "자".repeat(14_000) + (i === 4 ? " MIDFAIL-8181" : "")) }));
    for (let i = 1; i <= 6; i++) persist(tkP, `P${i}`, await runTurn(`P${i}`, ["차".repeat(3_000)]));
    const p0Id = loadThreadHistoryWithIds(CH, tkP).find((t) => t.content === "P0 답입니다")?.id ?? -1;
    let pCall = 0;
    const P1 = await H.compactThreadHistory({ channel: CH, threadKey: tkP, provider: `regr-ctm-p1-${tkP}`, adapter: "codex", budget: { instructionsChars: 150_000, promptChars: 0 },
      // 꼬리 사실이 든 조각(마지막)만 짧은 거절 문구 — 빈 결과가 아니어도 부분 성공으로 넘어가면 안 된다.
      summarize: async (t: string) => { pCall += 1; return t.includes("MIDFAIL-8181") ? "요약할 수 없습니다." : "요약본 ".repeat(20); } });
    const pSizes: number[] = [];
    const pBig: number[] = [];
    const P2 = await H.compactThreadHistory({ channel: CH, threadKey: tkP, provider: `regr-ctm-p2-${tkP}`, adapter: "codex", budget: { instructionsChars: 150_000, promptChars: 0 },
      summarize: async (t: string) => { pSizes.push(t.length); if (t.includes("자자자")) pBig.push(t.length); return "요약본 ".repeat(20); } });

    // ── Q. 수동 /compact 도 큰 턴을 조각으로 부른다(두 호출부 모두 연결) ──
    const tkQ = TK("q");
    clearThreadSummary(CH, tkQ);
    persist(tkQ, "Q0", await runTurn("Q0", ["짧은 결과"], { talk: [0, 1, 2, 3, 4].map((i) => "카".repeat(14_000) + (i === 4 ? " MANUAL-TAIL-9191" : "")) }));
    for (let i = 1; i <= 40; i++) persist(tkQ, `Q${i}`, await runTurn(`Q${i}`, ["타".repeat(200)]));
    const qPieces: string[] = [];
    H.setSummarizerPort(async (t: string) => { qPieces.push(t); return "요약본 ".repeat(20); });
    // 큰 턴은 앞의 작은 턴과 한 패스에 섞이지 않는다(예산을 넘는 턴은 혼자 접힌다) — 두 번 부른다.
    try { for (let i = 0; i < 2; i++) await H.compactThreadNow(CH, tkQ, "fake-model", "fake-token", undefined); } finally { H.setSummarizerPort(null); }

    return [
      assert("★O 아스트라 재현(400자·예산 100): 호출 ≤ 4 · 조각 ≤ 예산 · 이어 붙이면 원문", reproSizes.length <= 4 && reproSizes.every((n) => n <= 100) && reproJoined.join("") === repro, reproSizes),
      assert("★O 모양 넷 × 길이 일곱: 조각 수 = ceil(길이/예산) · 각 ≤ 예산 · 빈 조각 없음 · 원문 보존", splitBad.length === 0, splitBad),
      assert("O 4조각 용량을 넘는 입력은 나누지 않고 던진다(부분 요약 금지)", overThrows, overThrows),
      assert("★O 조각 요약은 시간순으로 이어 붙고, 조각마다 자기 길이에 맞는 목표 분량을 받는다(전체 길이 기준과 다르다)",
        /^조각-A[^]*조각-B[^]*조각-C/.test(ordered) && orderTargets.length === 3 && orderTargets.every((x) => x.target === H.summaryTargetFor(x.len))
          && H.summaryTargetFor(20_000) !== H.summaryTargetFor(60_000), { ordered: ordered.slice(0, 40), orderTargets }),
      assert("★O 조각 하나가 짧은 거절 문구면 전체 실패(빈 결과)", refused === "", refused.slice(0, 40)),
      assert("★O 조각 하나가 던지면 전체가 그 오류로 거부(빈 요약으로 삼키지 않는다)", thrown instanceof Error && /429/.test(thrown.message), String(thrown)),
      assert("★O 조각은 동시에 부르고(첫 응답 전에 셋 다 시작) 늦게 끝난 조각도 제자리에 붙는다", peak === 3 && /^조각-A[^]*조각-B[^]*조각-C/.test(lateFirst), { peak, head: lateFirst.slice(0, 40) }),
      assert("★O 이모지를 나눠도 서로게이트 쌍이 쪼개지지 않는다", !emojiSplit && emojiParts.join("") === emoji, emojiParts.map((x) => x.length)),
      assert("★O 짧은 턴이 많아도 한 패스의 최종 입력(머리말 포함)이 예산 안", shortLen <= 1_000 && shortPlan.toFold.length > 10, { shortLen, turns: shortPlan.toFold.length }),
      assert("★O 질문 + 큰 답은 한 단위로 접힌다 · 잘릴 땐 뒤쪽(결론)을 남긴다",
        qa.toFold.length === 2 && qa.toFold[0]?.content === "질문" && qa.chunkChars === B && huge.toFold.at(-1)?.content.endsWith("ANSWER-END") === true, { qa: qa.toFold.map((t) => t.content.length), hugeTail: huge.toFold.at(-1)?.content.slice(-12) }),
      assert("★O 잘라야 하는 큰 사용자 메시지는 **앞(지시)과 끝을 둘 다** 남기고 가운데를 버린다",
        askBody.includes("RULE-HEAD-7171") && askBody.includes("RULE-BODY-END-7373") && askBody.includes("LOG-END-7272") && /가운데 \d+자 생략/.test(askBody), { head: askBody.slice(0, 40), tail: askBody.slice(-20) }),
      assert("★O 머리말 때문에 경계를 넘는 턴·용량을 넘는 턴도 최종 입력이 4조각 용량 안이고 조각으로 부른다",
        edge.chunkChars === B && edgeLen <= B * 4 && huge.chunkChars === B && hugeLen <= B * 4, { edgeLen, hugeLen, cap: B * 4 }),
      assert("★P 중간 조각 실패: 워터마크가 큰 턴을 넘지 않는다(부분 성공 위장 없음)", P1.watermark < p0Id, { watermark: P1.watermark, p0Id }),
      assert("★P 다음 시도에서 큰 턴을 넘어 진행하고, 조각은 **줄어든 예산**(실패로 절반 = 2만) 안이다", P2.watermark >= p0Id && pBig.length >= 2 && pBig.every((n) => n <= 20_000), { watermark: P2.watermark, p0Id, sizes: pSizes, big: pBig }),
      assert("★Q 수동 /compact 도 큰 턴을 조각으로 — 여러 호출 · 각 ≤ 4만 · 꼬리 사실이 닿는다",
        qPieces.length >= 2 && qPieces.every((x) => x.length <= 40_000) && qPieces.some((x) => x.includes("MANUAL-TAIL-9191")), qPieces.map((x) => x.length)),
      assert("★H 6.4만 자 턴(저수위 안)은 깎이지 않는다 — 셋째 조각 꼬리의 사실이 다음 턴 입력에 있다",
        (hTurn?.itemsChars ?? 0) > 60_000 && outputsOf(Hn.input).some((o) => o.output.includes("TAIL-FACT-3131")), { chars: hTurn?.itemsChars, cap: H.turnItemsReplayChars() }),
      assert("★I 큰 턴은 조각으로 요약된다 — 여러 번 부르고, 각 입력은 예산(4만) 안, 꼬리 사실이 닿고, 잘림 표식 없음",
        In.r.watermark >= i0Id && pieces.length >= 2 && pieces.every((p) => p.length <= 40_000) && pieces.some((p) => p.includes("FOLD-TAIL-5151")) && !pieces.some((p) => p.includes("요약 입력 상한으로")),
        { watermark: In.r.watermark, i0Id, calls: pieces.length, sizes: pieces.map((p) => p.length) }),
      assert("★S 저장될 도구 결과에서 비밀값(환경 변수 값·sk- 키)이 가려지고, 일반 글자는 남는다",
        !secretDump.includes("tok_REGRsecretValue_1234567890abcdef") && !secretDump.includes("sk-proj-REGRABCDEFGHIJKLMNOPQRSTUV12") && secretDump.includes("PLAIN-4242"),
        secretDump.slice(0, 200)),
      assert("도구 인자 속 비밀값도 가린다(명령은 남긴다)", !argDump.includes("sk-proj-REGRARGSABCDEFGHIJKLMNOP99") && argDump.includes("curl"), argDump.slice(0, 300)),
      assert("★G 창 안전망: 큰 최신 턴은 텍스트로 남고 그 앞 턴도 남는다(종전 0턴)", G.length === 4 && G[3]?.items === undefined, G),
      assert("★A 이전 턴의 도구 출력(사실)이 다음 턴 입력에 있다", outsA.some((o) => o.output.includes("FACT-7731")), outsA.map((o) => o.output.slice(0, 40))),
      assert("★A 순서: 사용자 → 중간 발화 → 호출 → 출력 → 작업 중 지시 → 비서 답 → 현재 턴",
        types.join(",") === "message:user,message:assistant,function_call,function_call,function_call_output,function_call_output,message:user,message:assistant,message:user", types),
      assert("★A 저장된 출력은 턴 안 압축 **전** 원문이다(압축 표식이 아니다)", outsA.every((o) => !o.output.includes("이전 도구 출력 생략")) && outsA[0]?.output.includes("FACT-7731") === true, outsA.map((o) => o.output.slice(0, 30))),
      assert("★A 작업 중 사용자 지시는 남고 하네스 독촉은 «사용자 지시» 로 저장되지 않는다",
        t1.items.some((i) => i.type === "message" && i.role === "user" && i.text.includes("20초")) && !t1.items.some((i) => i.type === "message" && i.text.includes("계속 진행하세요")), t1.items),
      assert("A 추론(암호문)·짝 없는 호출·최종 답 중복은 저장하지 않는다",
        !JSON.stringify(t1.items).includes("SECRET-CIPHER") && !JSON.stringify(t1.items).includes("orphan") && !t1.items.some((i) => i.type === "message" && i.text === "T1 답입니다") && t1.items.every((i) => !("id" in i)), t1.items),
      assert("★A 출처 경계 = 이력 **항목** 수(턴 수가 아니다)", A.boundary.historyCount === A.input.length - 1 - A.boundary.summaryCount, A.boundary),
      assert("★B 이력에서 온 출력은 턴 안 몰아서 압축(128K)에서 빠지고, 상한 근처 즉시 압축에선 접힌다", histAfterNormal === 6 && newCompacted > 0 && histAfterForced < 6, { histAfterNormal, newCompacted, histAfterForced }),
      assert("C 재현 조건: 큰 턴 원문이 20만 자를 넘는다(없으면 아래는 공짜 초록)", bigRawChars > 200_000, bigRawChars),
      assert("★C 큰 턴 뒤에도 앞 턴이 창에 남는다(종전 0턴)", C.win.some((t) => t.content === "C0 답입니다") && outputsOf(C.input).some((o) => o.output.includes("EARLY-42")), C.win.map((t) => t.content.slice(0, 12))),
      assert("★C 큰 턴은 되살릴 상한 안으로 들어오고, 호출·출력 짝은 전부 남는다",
        bigTurn !== undefined && (bigTurn.itemsChars ?? 0) <= H.turnItemsReplayChars() && outputsOf(C.input).filter((o) => o.output.startsWith("BIG-")).length === 14, { chars: bigTurn?.itemsChars, cap: H.turnItemsReplayChars() }),
      assert("C 되살린 모양은 결정적이다(같은 기록 → 같은 입력 — 캐시 보존)", JSON.stringify(C.input) === JSON.stringify(C2.input), { first: JSON.stringify(C.input).length, second: JSON.stringify(C2.input).length }),
      assert("★D 요약 입력에 접힌 턴의 도구 사실과 역할 표식이 들어간다", D.r.watermark >= d0Id && foldInput.includes("FOLD-9001") && foldInput.includes("[사용자 — 작업 중 추가 지시] 보고서는 표로"), { watermark: D.r.watermark, d0Id, has: foldInput.includes("FOLD-9001") }),
      assert("★D 접힌 턴의 도구 항목은 지우지 않고(원기록) 적재에서만 빠진다", rowsKept > 0 && loadedAfterFold === undefined, { rowsKept, loaded: loadedAfterFold?.length }),
      assert("★E 한 턴 기록은 한 트랜잭션 — 항목 저장이 실패하면 사용자·비서 행도 안 남는다", threw && rowsE === 0, { threw, rowsE }),
      assert("F 도구 항목을 안 보내는 어댑터(openai)는 그 크기를 세지 않는다", F.allTurns.every((t) => (t.itemsChars ?? 0) === 0), F.allTurns.map((t) => t.itemsChars)),
      assert("★J openai 쪽에서 접어도 Codex 턴의 도구 사실이 요약 입력에 들어간다", foldJ.includes("OAI-FOLD-6161"), { folded: foldJ.length }),
      assert("★K 이스케이프가 많아도 상한 안이고, 예산을 실제로 쓴다(출력마다 1,000자 넘게 남김)", kChars <= cap && kChars > cap * 0.9 && kOutputs.every((n) => n > 1_000), { kChars, cap, minOut: Math.min(...kOutputs) }),
      assert("★K 깎은 인자도 유효한 JSON 이다", kArgsValid, K.filter((x) => x.type === "function_call").map((x) => (x as { arguments: string }).arguments.slice(0, 30))),
      assert("★L 호출 수백 개: 상한 안 · 오래된 쌍만 통째로 빠짐 · 표식 수 = 실제로 뺀 쌍 수 · 최근 쌍 남음 · 짝 없는 항목 없음",
        H.turnItemsChars(L) <= cap && L[0]?.type === "message" && lNoteN === 400 - lPairs && lLast?.output.startsWith("ok 399 ") === true
          && lPairs === L.filter((x) => x.type === "function_call_output").length,
        { chars: H.turnItemsChars(L), cap, head: L[0], pairs: lPairs, noteN: lNoteN }),
      assert("★L 작은 쌍 수백 + 큰 인자 하나: 절벽 없음 — 큰 Write 와 많은 쌍이 남는다(표식 한 줄만 남지 않는다)",
        H.turnItemsChars(Lbig) <= cap && Lbig.some((x) => x.type === "function_call" && x.call_id === "w") && Lbig.filter((x) => x.type === "function_call").length > 100,
        { chars: H.turnItemsChars(Lbig), items: Lbig.length }),
      assert("★K 짧은 항목(200자 이하)은 큰 항목과 섞여도 깎이지 않는다", Kshort.filter((x) => x.type === "function_call_output" && x.call_id !== "big").every((x) => (x as { output: string }).output === "s".repeat(150)), Kshort.filter((x) => x.type === "function_call_output").map((x) => (x as { output: string }).output.length)),
      assert("B 착수 조건 로그: 되살릴 상한을 넘는 턴을 모으면 한 줄 남긴다", logged.some((l) => l.startsWith("[turn-items]")), logged.slice(0, 2)),
      assert("★M 수동 /compact 도 도구 사실을 요약 입력에 넣는다", foldM.includes("MANUAL-7171"), { manual, folded: foldM.length }),
      assert("★N 실경로: 1턴 도구 결과가 2턴 입력에 있다(퍼사드 배선)", N.turns === 3 && N.t2HasT1 === true, N),
      assert("★N 실경로: 3턴 입력에 1·2턴 결과가 **한 번씩만** — 이력이 다시 저장돼 불어나지 않는다(turnStart 이음매)", N.t3T1Count === 1 && N.t3T2Count === 1, N),
      assert("★N 실경로: 답이 메시지 둘로 와도 이력에 최종 답은 한 번", N.t2AnswerCount === 1, { ...N, err: child.err.slice(-300) }),
    ];
  },
};
