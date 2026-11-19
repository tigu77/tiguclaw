/**
 * 회귀: **긴 도구 결과의 생략 부분을 같은 턴에서 원 도구 재실행 없이 회수한다** (2026-11-19 뉴돌쇠 — 예약 목록 가운데 유실로 게시 보류).
 *
 * 사고: Codex 가 16,000자를 넘는 도구 결과의 가운데를 진입 순간 버렸고, 보조 맵·저장본·재조회도 같은 잘린 값이라 그 턴에도 다음 턴에도
 *  되찾을 길이 없었다(안내는 «Read offset/limit 또는 Grep» — MCP 결과엔 쓸 수 없다). 설계: docs/decisions/2026-11-19-tool-output-recovery-design.md §3-1.
 *
 * 재는 것:
 *  ① 실경로(자식 — router → Codex 어댑터 → 가짜 공급자 · 네트워크 0): 큰 Read 결과의 보기 안내에 실행 참조·offset → 같은 턴 재조회로
 *     가운데 표식 회수(파일을 바꿔도 당시 값 = 재실행 0) · 응답마다 JSON ≤ 진입 상한 · 이어 붙이면 보존본 · eof · 가림 ·
 *     다음 턴 되살린 글 = 1턴 보기 · 다음 턴 같은 실행 참조로 저장본 회수 · 다른 대화 / clear 뒤 / 기록 안 된 실행 참조 거절
 *  ② 경계(R1·R2·R4): 가림으로 원결과·보존본이 상한을 엇갈려 넘는 두 경우와 둘 다 넘는 긴 토큰 — 턴 안 글 = 다음 턴 글 ·
 *     `turnItemsReplayedChars` 일치 · 결과 하나의 글 ≤ 상한
 *  ③ 턴 안 압축 최소 길이 경계(1,999/2,000/2,001 · 설정 변경) — 생략된 결과마다 참조가 있고 그 참조로 회수
 *  ④ 재조회 응답: 이스케이프 많은 본문·긴 인자(part:"args")·서로게이트 — 페이지마다 응답 JSON ≤ 상한, 이어 붙이면 원문 · 검색 응답도 상한 안
 *  ⑤ 보존 상한(100,000자, 표식 포함)·회수 불가 명시 · 짧은 결과 불변 · 단건 읽기는 턴 전체를 파싱하지 않는다 · 다음 턴 증분 실측
 * 등급: **동작**.
 */
import { fileURLToPath } from "node:url";
import { assert, assertIsolated, spawnWithin, type Assertion, type RegressionCheck } from "./_framework.js";

type Handler = (args: unknown, extra: unknown) => Promise<{ content: Array<{ type: string; text?: string }> }>;
const handlerOf = (srv: unknown, name: string): Handler => {
  const t = (srv as { instance: { _registeredTools: Record<string, { handler: Handler }> } }).instance._registeredTools[name];
  if (t === undefined) throw new Error(`도구 ${name} 없음`);
  return t.handler;
};
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export const check: RegressionCheck = {
  name: "tool-output-same-turn-recall",
  guards:
    "긴 도구 결과의 가운데를 Codex 가 진입 순간 버리고 저장·재조회도 잘린 값이라 같은 턴에도 다음 턴에도 되찾지 못하던 것(뉴돌쇠 11-18·19 예약 목록 → 게시 보류)",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const out: Assertion[] = [];
    const { redactSecrets } = await import("../../core/outbound-sanitize.js");
    const { fitsToolEntry } = await import("../../store/tool-recall.js");
    // ── ① 실경로
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const home = mkdtempSync(`${tmpdir()}/tiguclaw-regression-same-turn-`);
    const child = await spawnWithin(90_000, "같은 턴 회수 실경로", ["--import", "tsx", fileURLToPath(new URL("./_same-turn-recall-child.ts", import.meta.url))], { env: { ...process.env, TIGUCLAW_HOME: home } })
      .finally(() => rmSync(home, { recursive: true, force: true }));
    const line = child.out.split(/\r?\n/).find((l) => l.startsWith("SAME_TURN_RESULT "));
    const R = (line === undefined ? {} : JSON.parse(line.slice("SAME_TURN_RESULT ".length))) as {
      visible?: string; ref?: string; offset0?: number; pages?: string[]; turn2Replayed?: string; turn2Read?: string; otherRead?: string;
      clearedRead?: string; unknownRead?: string; readCalls?: number; toolNames?: string[]; sentinel?: string; secret?: string; error?: string;
      stored?: { ref?: string; chars?: number; hasSecret?: boolean; hasSent?: boolean } | null;
    };
    const { TOOL_OUTPUT_ENTRY_CAP: CAP, TOOL_OUTPUT_RETAIN_CHARS } = await import("../../core/llm-runtime/tool-output-limits.js");
    const pages = (R.pages ?? []).map((p) => JSON.parse(p) as { ok?: boolean; text?: string; offset?: number; nextOffset?: number; eof?: boolean; truncated?: boolean; chars?: number });
    const joined = pages.map((p) => p.text ?? "").join("");
    const visible = R.visible ?? "";
    const head = visible.split("\n…[중략")[0] ?? "";
    out.push(assert("재현 조건: 자식이 끝까지 돌았고 1턴 Read 결과가 진입 상한을 넘었다(보기 + 안내)",
      R.error === "" && !child.timedOut && visible.includes("…[중략") && visible.length <= CAP && (R.toolNames ?? []).includes("read_past_tool_result"),
      { error: R.error, err: child.err.slice(-400), visible: visible.length }));
    out.push(assert("★1턴 보기 안내에 실행 참조와 이어 읽을 위치(= 보인 앞부분 길이)가 있고 «Read offset/limit·Grep» 은 없다",
      /^r[0-9a-z]{8}\.\d+$/.test(R.ref ?? "") && R.offset0 === head.length && !visible.includes("Read offset/limit") && !visible.includes(R.sentinel ?? "∅"),
      { ref: R.ref, offset: R.offset0, head: head.length }));
    out.push(assert("★같은 턴 재조회로 가운데 표식을 회수한다 — 파일을 바꾼 뒤라도 당시 값(원 도구 재실행 0, Read 호출 1회)",
      joined.includes(R.sentinel ?? "∅") && !joined.includes("CHANGED-AFTER") && R.readCalls === 1, { readCalls: R.readCalls, pages: pages.length }));
    out.push(assert("★재조회 응답마다 JSON 전체 ≤ 진입 상한 · 이어 읽기 표지(nextOffset) 연속 · 마지막은 eof",
      pages.length >= 1 && (R.pages ?? []).every((p) => p.length <= CAP) && pages.every((p, i) => i === 0 || p.offset === pages[i - 1]!.nextOffset) &&
        pages[pages.length - 1]!.eof === true && pages.slice(0, -1).every((p) => p.truncated === true),
      { sizes: (R.pages ?? []).map((p) => p.length), offsets: pages.map((p) => [p.offset, p.nextOffset, p.eof]) }));
    out.push(assert("★가림: 보존본·재조회·저장본 어디에도 비밀 원문이 없다(가림을 우회하지 않는다)",
      !joined.includes(R.secret ?? "∅") && !visible.includes(R.secret ?? "∅") && R.stored?.hasSecret === false && joined.includes("[REDACTED]"),
      { stored: R.stored }));
    out.push(assert("★저장본: 실행 참조를 함께 남기고 가운데 표식까지 보존(종전은 잘린 값)",
      R.stored?.ref === R.ref && R.stored?.hasSent === true && (R.stored?.chars ?? 0) === (pages[0]?.chars ?? -1), { stored: R.stored, chars: pages[0]?.chars }));
    out.push(assert("★다음 턴: 되살린 그 결과가 1턴 보기와 같은 글(입력 증가 없음·프리픽스 같음)",
      R.turn2Replayed === visible, { same: R.turn2Replayed === visible, t2: R.turn2Replayed?.length, t1: visible.length }));
    const t2 = JSON.parse(R.turn2Read || "{}") as { ok?: boolean; text?: string };
    out.push(assert("★다음 턴: 같은 실행 참조로 저장본에서 가운데를 읽는다", t2.ok === true && (t2.text ?? "").includes(R.sentinel ?? "∅"), { ok: t2.ok }));
    const other = JSON.parse(R.otherRead || "{}") as { ok?: boolean; unavailable?: string };
    const cleared = JSON.parse(R.clearedRead || "{}") as { ok?: boolean; unavailable?: string };
    const unknown = JSON.parse(R.unknownRead || "{}") as { ok?: boolean; unavailable?: string; note?: string };
    out.push(assert("★다른 대화는 그 실행 참조를 못 읽고 · /clear 뒤엔 before_boundary · 기록 안 된 실행 참조는 not_found(사유 안내)",
      other.ok === false && other.unavailable === "not_found" && cleared.ok === false && cleared.unavailable === "before_boundary" &&
        unknown.ok === false && unknown.unavailable === "not_found" && (unknown.note ?? "").includes("실행 참조"),
      { other, cleared, unknown }));

    // ── 순수·저장 계층
    const H = await import("../../core/llm-runtime/adapters/openai-codex-oauth-history.js");
    const { createToolOutputLedger } = await import("../../core/llm-runtime/tool-output-ledger.js");
    const { createToolRecallMcpServer } = await import("../../core/llm-runtime/capabilities/tool-recall-mcp.js");
    type In = Parameters<typeof H.appendToolResultsToInput>[0];
    const room = { requestChars: 0, deferTextCompaction: true };
    const runTurn = (outputs: { id: string; out: string; args?: string }[], ledger = createToolOutputLedger()) => {
      const input: In = [];
      for (const o of outputs) input.push({ type: "function_call", call_id: o.id, name: "Probe", arguments: o.args ?? "{}" } as never);
      H.appendToolResultsToInput(input, outputs.map((o) => ({ callId: o.id, name: "Probe", output: o.out, media: [] })), room, ledger);
      const visible = new Map(input.filter((x) => x.type === "function_call_output").map((x) => [(x as { call_id: string }).call_id, (x as { output: string }).output]));
      const stored = H.collectTurnItems(input, "답");
      const replayed = H.replayTurnItems(stored, 10_000_000);
      const replayedOut = new Map(replayed.filter((x) => x.type === "function_call_output").map((x) => [(x as { call_id: string }).call_id, (x as { output: string }).output]));
      return { input, visible, stored, replayed, replayedOut, ledger };
    };
    // ② 경계 — (가) 원 ≤ 상한 < P · (나) P ≤ 상한 < 원 · 둘 다 초과 긴 토큰 · 비밀 없는 큰 결과
    const fill = (n: number, c = "가"): string => c.repeat(n);
    const caseA = fill(CAP - 4 - 5) + " sk-ab" + "끝";            // 원 = CAP-2 … 가림(+5) → P > 상한
    const caseB = "sk-" + "z".repeat(30) + " " + fill(CAP - 20);   // 원 > 상한 … 가림(-23) → P ≤ 상한
    const caseC = "sk-" + "a".repeat(8_997) + " " + "b".repeat(20_000); // 원 29,001 → P 20,011 (둘 다 초과)
    const caseD = fill(30_000, "나");
    const T = runTurn([{ id: "A", out: caseA }, { id: "B", out: caseB }, { id: "C", out: caseC }, { id: "D", out: caseD }]);
    const pA = H.preserveToolOutput(caseA), pB = H.preserveToolOutput(caseB), pC = H.preserveToolOutput(caseC);
    const sameAll = ["A", "B", "C", "D"].every((k) => T.visible.get(k) === T.replayedOut.get(k));
    out.push(assert("재현 조건: 경계 두 경우와 긴 토큰 사례의 길이",
      caseA.length <= CAP && pA.length > CAP && caseB.length > CAP && pB.length <= CAP && caseC.length === 29_001 && pC.length === 20_011,
      { a: [caseA.length, pA.length], b: [caseB.length, pB.length], c: [caseC.length, pC.length] }));
    out.push(assert("★경계·긴 토큰·큰 결과 모두 턴 안 글 = 다음 턴 되살린 글 · 결과 하나의 글 ≤ 상한",
      sameAll && [...T.visible.values()].every((v) => v.length <= CAP),
      Object.fromEntries(["A", "B", "C", "D"].map((k) => [k, [T.visible.get(k)?.length, T.replayedOut.get(k)?.length]]))));
    out.push(assert("★(가)는 앞·뒤 보기 + 참조 · (나)는 보존본 전체(가린 것) · 긴 토큰은 가린 보존본의 앞 8,000자 보기",
      (T.visible.get("A") ?? "").includes("…[중략") && /"ref":"r[0-9a-z]{8}\.\d+"/.test(T.visible.get("A") ?? "") && T.visible.get("B") === pB &&
        (T.visible.get("C") ?? "").startsWith("[REDACTED] bbb") && (T.visible.get("C") ?? "").includes("…[중략"),
      { a: T.visible.get("A")?.slice(-200), c: T.visible.get("C")?.slice(0, 20) }));
    out.push(assert("★turnItemsReplayedChars = 실제로 되살린 항목 JSON 길이(ref 필드는 보내는 모양·크기에서 빠진다)",
      H.turnItemsReplayedChars(T.stored) === T.replayed.reduce((n, it) => n + JSON.stringify(it).length, 0) && !JSON.stringify(T.replayed).includes('"ref":"r'),
      { replayed: H.turnItemsReplayedChars(T.stored) }));
    // 짧은 결과 불변(가림 대상 없음) — 입력·저장 모두 종전과 같다
    const S = runTurn([{ id: "S", out: "짧은 결과 OK" }, { id: "S2", out: fill(CAP) }]);
    out.push(assert("★짧은 결과(원·보존본 ≤ 상한)는 모델 입력·저장 모두 원결과 그대로 · 참조 없음",
      S.visible.get("S") === "짧은 결과 OK" && S.visible.get("S2") === fill(CAP) &&
        S.stored.every((it) => it.type !== "function_call_output" || ((it as { ref?: string }).ref === undefined)),
      { s2: S.visible.get("S2")?.length }));

    // ③ 턴 안 압축 — 최소 길이 경계와 설정 변경
    const compactCase = (sizes: number[], minOutputChars?: number) => {
      const ledger = createToolOutputLedger();
      const input: In = [];
      const outs = sizes.map((n, i) => ({ id: `k${i}`, out: `첫줄 K${i}\n` + "다".repeat(Math.max(0, n - `첫줄 K${i}\n`.length)) }));
      for (const o of outs) {
        input.push({ type: "function_call", call_id: o.id, name: "Probe", arguments: "{}" } as never);
        H.appendToolResultsToInput(input, [{ callId: o.id, name: "Probe", output: o.out, media: [] }], room, ledger);
      }
      const n = H.compactOldToolOutputs(input, { keepRecent: 1, batchChars: 0, ...(minOutputChars !== undefined ? { minOutputChars } : {}) });
      const recall = handlerOf(createToolRecallMcpServer({ channel: "http-bridge", threadKey: "regr:compact-recall" }, ledger), "read_past_tool_result");
      const rows = input.filter((x) => x.type === "function_call_output") as { call_id: string; output: string }[];
      return { n, outs, rows, recall };
    };
    const C1 = compactCase([1_999, 2_000, 2_001, 50]);
    const checkCompacted = async (c: ReturnType<typeof compactCase>) => Promise.all(c.rows.map(async (r, i) => {
      const compacted = r.output.startsWith("\u0000__codex_compacted__\u0000");
      const ref = /"ref":"(r[0-9a-z]{8}\.\d+)"/.exec(r.output)?.[1];
      const back = ref === undefined ? undefined : JSON.parse((await c.recall({ ref }, {})).content[0]!.text ?? "{}") as { text?: string; eof?: boolean };
      return { i, compacted, ref: ref !== undefined, same: back?.text === c.outs[i]!.out && back?.eof === true };
    }));
    const r1 = await checkCompacted(C1);
    out.push(assert("★턴 안 압축 경계: 2,000·2,001자는 생략되고 각자 참조로 원문을 되찾는다 · 1,999자는 그대로(참조 없음)",
      r1[0]!.compacted === false && r1[0]!.ref === false && r1[1]!.compacted && r1[1]!.ref && r1[1]!.same && r1[2]!.compacted && r1[2]!.ref && r1[2]!.same,
      r1));
    const C2 = compactCase([600, 400, 50], 500);
    const r2 = await checkCompacted(C2);
    out.push(assert("★압축 최소 길이를 바꾸면(500) 등록도 따라간다 — 600자는 생략+참조+회수, 400자는 그대로",
      r2[0]!.compacted && r2[0]!.ref && r2[0]!.same && r2[1]!.compacted === false, r2));

    // ④ 재조회 응답 — 이스케이프·긴 인자·서로게이트
    const nasty = Array.from({ length: 14_000 }, (_, i) => (i % 3 === 0 ? '"' : i % 3 === 1 ? "\\" : "\u0001")).join("") + "😀".repeat(4_000) + "끝NASTY-END";
    const longArgs = JSON.stringify({ content: "인자" + "\u0002".repeat(4_000) + "ARGS-END" });
    const E = runTurn([{ id: "E", out: nasty, args: longArgs }]);
    const eRef = /"ref":"(r[0-9a-z]{8}\.\d+)"/.exec(E.visible.get("E") ?? "")?.[1] ?? "";
    const eRecall = handlerOf(createToolRecallMcpServer({ channel: "http-bridge", threadKey: "regr:esc" }, E.ledger), "read_past_tool_result");
    const readAll = async (part: "output" | "args") => {
      const raws: string[] = [];
      for (let off = 0, n = 0; n < 80; n++) {
        const raw = (await eRecall({ ref: eRef, offset: off, part }, {})).content[0]!.text ?? "";
        raws.push(raw);
        const p = JSON.parse(raw) as { nextOffset?: number; eof?: boolean };
        if (p.eof === true || p.nextOffset === undefined) break;
        off = p.nextOffset;
      }
      return { raws, text: raws.map((r) => (JSON.parse(r) as { text: string }).text).join("") };
    };
    const eOut = await readAll("output");
    const eArgs = await readAll("args");
    const ePreserved = H.preserveToolOutput(nasty);
    out.push(assert("★이스케이프·서로게이트 많은 본문: 페이지마다 응답 JSON ≤ 상한 · 이어 붙이면 보존본 그대로 · 쪼개진 서로게이트 0",
      eRef !== "" && eOut.raws.length > 2 && eOut.raws.every((r) => r.length <= CAP) && eOut.text === ePreserved &&
        eOut.raws.every((r) => !LONE.test((JSON.parse(r) as { text: string }).text)),
      { pages: eOut.raws.length, max: Math.max(...eOut.raws.map((r) => r.length)), same: eOut.text === ePreserved }));
    const firstE = JSON.parse(eOut.raws[0] ?? "{}") as { args?: string; argsChars?: number; argsTruncated?: boolean };
    out.push(assert("★긴 인자: 응답엔 미리보기 + argsChars, part:\"args\" 로 이어 읽어 인자 전문(가린 것)과 같다 · 페이지마다 ≤ 상한",
      firstE.argsTruncated === true && firstE.argsChars === longArgs.length && (firstE.args ?? "").length <= 1_001 &&
        eArgs.text === longArgs && eArgs.raws.every((r) => r.length <= CAP),
      { argsChars: firstE.argsChars, pages: eArgs.raws.length }));
    // 검색 응답 상한 — 저장된 대화에 이스케이프 많은 적중 12건
    const { initStore } = await import("../../store/sessions.js");
    const { appendApiTurn } = await import("../../store/memory.js");
    const { __toolRecallStatsForTest: stats, readThreadToolResult } = await import("../../store/tool-recall.js");
    initStore();
    const CH = "http-bridge" as const, Q = "regr:recall-budget";
    appendApiTurn({ channel: CH, threadKey: Q, claudeSessionId: "regr-same-turn-q", userContent: "q", assistantContent: "a",
      items: Array.from({ length: 12 }, (_, i) => [
        { type: "function_call" as const, call_id: `q${i}`, name: "Grep", arguments: JSON.stringify({ q: "\u0003".repeat(180) }) },
        { type: "function_call_output" as const, call_id: `q${i}`, output: "\u0003".repeat(300) + "HITQ" + "\u0003".repeat(300) },
      ]).flat() });
    const qRecall = handlerOf(createToolRecallMcpServer({ channel: CH, threadKey: Q }), "read_past_tool_result");
    const qRaw = (await qRecall({ query: "HITQ" }, {})).content[0]!.text ?? "";
    const qRes = JSON.parse(qRaw) as { total?: number; hits?: unknown[]; truncated?: boolean };
    appendApiTurn({ channel: CH, threadKey: "regr:recall-budget-bearer", claudeSessionId: "regr-same-turn-qb", userContent: "q", assistantContent: "a",
      items: Array.from({ length: 12 }, (_, i) => [
        { type: "function_call" as const, call_id: `qb${i}`, name: "Read", arguments: "{}" },
        { type: "function_call_output" as const, call_id: `qb${i}`, output: H.preserveToolOutput("Bearer tok ".repeat(14) + "HITB" + " Bearer tok".repeat(14) + "\u0003".repeat(40)) },
      ]).flat() });
    const qbRaw = (await handlerOf(createToolRecallMcpServer({ channel: CH, threadKey: "regr:recall-budget-bearer" }), "read_past_tool_result")({ query: "HITB" }, {})).content[0]!.text ?? "";
    const qbIn: In = [{ type: "function_call", call_id: "qbx", name: "read_past_tool_result", arguments: "{}" } as never];
    H.appendToolResultsToInput(qbIn, [{ callId: "qbx", name: "read_past_tool_result", output: qbRaw, media: [] }], room);
    out.push(assert("★검색 응답: 가린 표식이 많은 적중이어도 원문·가린 뒤 길이 모두 ≤ 상한 · 입력 = 원문(재절단 0)",
      qbRaw.length <= CAP && redactSecrets(qbRaw).length <= CAP && (qbIn[1] as { output: string }).output === qbRaw,
      { raw: qbRaw.length, red: redactSecrets(qbRaw).length }));
    out.push(assert("★검색 응답도 JSON 전체 ≤ 상한 — 넘치면 뒤 적중을 빼고 truncated · 전체 수는 그대로",
      qRaw.length <= CAP && qRes.total === 12 && (qRes.hits?.length ?? 0) < 10 && (qRes.hits?.length ?? 0) > 0 && qRes.truncated === true,
      { chars: qRaw.length, hits: qRes.hits?.length, total: qRes.total }));

    // ④' 재조회 응답이 진입 경로를 다시 지나도 가림이 겹치지 않는다(구현 검토 R1 ①) — Bearer 가 든 보존본의 페이지가 그대로 입력에 실리고 파싱된다
    const bearerOut = "앞 " + "가".repeat(9_000) + " Authorization: Bearer abcDEF123456token 가운데 " + "나".repeat(20_000) + " 끝";
    const BT = runTurn([{ id: "BT", out: bearerOut }]);
    const btRef = /"ref":"(r[0-9a-z]{8}\.\d+)"/.exec(BT.visible.get("BT") ?? "")?.[1] ?? "";
    const btRecall = handlerOf(createToolRecallMcpServer({ channel: "http-bridge", threadKey: "regr:bearer" }, BT.ledger), "read_past_tool_result");
    const btPages: { raw: string; entered: string }[] = [];
    for (let off = 0, n = 0; n < 20; n++) {
      const raw = (await btRecall({ ref: btRef, offset: off }, {})).content[0]!.text ?? "";
      const inp: In = [{ type: "function_call", call_id: `rp${n}`, name: "read_past_tool_result", arguments: "{}" } as never];
      H.appendToolResultsToInput(inp, [{ callId: `rp${n}`, name: "read_past_tool_result", output: raw, media: [] }], room, BT.ledger);
      btPages.push({ raw, entered: (inp[1] as { output: string }).output });
      const p = JSON.parse(raw) as { nextOffset?: number; eof?: boolean };
      if (p.eof === true || p.nextOffset === undefined) break;
      off = p.nextOffset;
    }
    const btJoined = btPages.map((p) => { try { return (JSON.parse(p.entered) as { text: string }).text; } catch { return "∅PARSE"; } }).join("");
    // ★가림은 멱등이 아니다(`Bearer [REDACTED]` 를 다시 가리면 `]` 가 붙는다) — 그래서 응답 크기를 «가린 뒤 길이» 로도 잰다. 턴 안 입력은 원문 페이지,
    //  저장은 그 페이지를 가린 것(상한 안). 공유 가림 함수는 바꾸지 않는다(구현 검토 R6 — 멱등화 시도가 가림 약화 반례를 냈다).
    out.push(assert("★Bearer 가 든 결과: 재조회 페이지가 진입 경로를 지나도 그대로(재절단 0) · 가린 뒤 길이도 상한 안 · 파싱되고 이어 붙이면 보존본",
      btRef !== "" && btPages.length >= 2 && btPages.every((p) => p.entered === p.raw && p.raw.length <= CAP && redactSecrets(p.raw).length <= CAP) && btJoined === H.preserveToolOutput(bearerOut) && btJoined.includes("Bearer [REDACTED] "),
      { pages: btPages.length, same: btPages.map((p) => p.entered === p.raw), joined: btJoined === H.preserveToolOutput(bearerOut) }));
    // 재조회 응답에 요청에서 온 글(검색어·틀린 참조)이 섞여도 가린 채 진입·저장된다(구현 검토 R2) — 진입은 이 도구 결과를 다시 가리지 않으므로
    const SECRET_Q = "Bearer synthetic-q-" + "SECRETVALUE99";
    const echoQ = (await btRecall({ query: SECRET_Q }, {})).content[0]!.text ?? "";
    const echoR = (await btRecall({ ref: "Bearer synth-" + "REFSECRET77" }, {})).content[0]!.text ?? "";
    const echoIn: In = [
      { type: "function_call", call_id: "eq", name: "read_past_tool_result", arguments: "{}" } as never,
      { type: "function_call", call_id: "er", name: "read_past_tool_result", arguments: "{}" } as never,
    ];
    H.appendToolResultsToInput(echoIn, [
      { callId: "eq", name: "read_past_tool_result", output: echoQ, media: [] },
      { callId: "er", name: "read_past_tool_result", output: echoR, media: [] },
    ], room, BT.ledger);
    const echoStored = JSON.stringify(H.collectTurnItems(echoIn, "답"));
    const echoVisible = JSON.stringify(echoIn);
    out.push(assert("★검색어·틀린 참조를 되돌려 주는 응답도 가린 채 모델 입력·저장에 들어간다(원문 비밀 0)",
      !echoStored.includes("SECRETVALUE99") && !echoStored.includes("REFSECRET77") && !echoVisible.includes("SECRETVALUE99") && !echoVisible.includes("REFSECRET77") &&
        echoQ.includes("Bearer [REDACTED]") && echoR.includes("Bearer [REDACTED]"),
      { q: echoQ.slice(0, 120), r: echoR.slice(0, 160) }));
    // 재조회 이름으로 들어오는 어댑터 오류·가리지 않은 도구 이름도 일반 결과처럼 가려진다(구현 검토 R3) · 가림은 멱등이다
    const errIn: In = [{ type: "function_call", call_id: "ee", name: "read_past_tool_result", arguments: "{}" } as never];
    H.appendToolResultsToInput(errIn, [{ callId: "ee", name: "read_past_tool_result", output: "Error: Unexpected token in JSON: sk-ab" + "ERRSECRET12345", media: [] }], room, BT.ledger);
    const errStored = JSON.stringify(H.collectTurnItems(errIn, "답"));
    out.push(assert("★재조회 이름의 어댑터 오류도 저장 전에 가려진다(이름으로 가림을 건너뛰지 않는다)",
      !errStored.includes("ERRSECRET12345"), { errStored: errStored.slice(0, 200) }));
    // 저장된 도구 이름(가리지 않고 저장된다)을 재조회 응답·검색 적중으로 되돌려 줄 땐 가린다 — 모델 입력·저장 모두(구현 검토 R4)
    const TOOLSEC = "sk-ab" + "TOOLSECRET12345";
    appendApiTurn({ channel: CH, threadKey: "regr:recall-toolname", claudeSessionId: "regr-same-turn-toolname", userContent: "q", assistantContent: "a",
      items: [{ type: "function_call" as const, call_id: "tn", name: TOOLSEC, arguments: "{}" }, { type: "function_call_output" as const, call_id: "tn", output: "TOOLNAME-HIT 결과" }] });
    const tnRecall = handlerOf(createToolRecallMcpServer({ channel: CH, threadKey: "regr:recall-toolname" }), "read_past_tool_result");
    const tnSearch = (await tnRecall({ query: "TOOLNAME-HIT" }, {})).content[0]!.text ?? "";
    const tnRef = ((JSON.parse(tnSearch) as { hits?: Array<{ ref?: string }> }).hits ?? [])[0]?.ref ?? "";
    const tnRead = (await tnRecall({ ref: tnRef }, {})).content[0]!.text ?? "";
    const tnIn: In = [{ type: "function_call", call_id: "tr", name: "read_past_tool_result", arguments: "{}" } as never];
    H.appendToolResultsToInput(tnIn, [{ callId: "tr", name: "read_past_tool_result", output: tnRead, media: [] }], room, BT.ledger);
    out.push(assert("★재조회 응답·검색 적중의 도구 이름은 가려서 돌려준다(모델 입력·저장 모두 원문 0)",
      tnRef !== "" && !tnSearch.includes("TOOLSECRET12345") && !tnRead.includes("TOOLSECRET12345") &&
        !JSON.stringify(tnIn).includes("TOOLSECRET12345") && !JSON.stringify(H.collectTurnItems(tnIn, "답")).includes("TOOLSECRET12345"),
      { search: tnSearch.slice(0, 160), read: tnRead.slice(0, 160) }));
    // 가린 뒤 길이가 원문보다 길어지는 경계(구현 검토 R7 재현) — 서로게이트 보정 뒤에도 재가림 길이가 상한 안 · 검색 응답도 같은 판정
    const prevR7 = process.env.REGR_R7_SECRET;
    process.env.REGR_R7_SECRET = "x".repeat(80) + "ABCDEFGH\\ud83d";
    let r7: Record<string, unknown> = {};
    try {
      const { toolRecallResponse } = await import("../../store/tool-recall.js");
      // 검토 재현 모양을 경계 주변으로 훑는다 — 페이지 끝이 서로게이트 쌍 한가운데에 걸리는 길이를 포함한다(그때만 JSON 이 고립 서로게이트를
      //  `\ud83d` 로 적어 합성 환경값과 맞고, 고친 끝에선 안 맞아 가린 뒤 길이가 원문보다 길어진다).
      const bad: unknown[] = [];
      let multiPage = 0, splitHit = 0;
      for (let k = 15_600; k <= 15_800; k += 1) {
        const r7Out = "Bearer token ".repeat(10) + "x".repeat(k) + "ABCDEFGH😀" + "y".repeat(800);
        const pagesR7: string[] = [];
        for (let off = 0, n = 0; n < 20; n++) {
          const raw = JSON.stringify(toolRecallResponse({ ok: true, ref: "rabcdefgh.1", at: 0, tool: "Read", args: "{}", text: r7Out }, { offset: off }));
          pagesR7.push(raw);
          const pg = JSON.parse(raw) as { nextOffset?: number; eof?: boolean };
          if (pg.eof === true || pg.nextOffset === undefined) break;
          off = pg.nextOffset;
        }
        if (pagesR7.length >= 2) multiPage += 1;
        if (pagesR7.some((raw) => redactSecrets(raw).length > raw.length)) splitHit += 1;
        const joined = pagesR7.map((raw) => (JSON.parse(raw) as { text: string }).text).join("");
        pagesR7.forEach((raw, n) => {
          const inp: In = [{ type: "function_call", call_id: `r7p${n}`, name: "read_past_tool_result", arguments: "{}" } as never];
          H.appendToolResultsToInput(inp, [{ callId: `r7p${n}`, name: "read_past_tool_result", output: raw, media: [] }], room);
          const entered = (inp[1] as { output: string }).output;
          if (raw.length > CAP || redactSecrets(raw).length > CAP || entered !== raw) bad.push({ k, n, raw: raw.length, red: redactSecrets(raw).length });
        });
        if (joined !== r7Out) bad.push({ k, joined: false });
      }
      r7 = { ok: bad.length === 0 && multiPage > 50 && splitHit > 0, bad: bad.slice(0, 5), multiPage, splitHit };
    } finally {
      if (prevR7 === undefined) delete process.env.REGR_R7_SECRET; else process.env.REGR_R7_SECRET = prevR7;
    }
    out.push(assert("★가린 뒤 길이가 늘어나는 경계(서로게이트 보정 포함): 페이지마다 원문·가린 뒤 모두 ≤ 상한 · 입력 = 원문 페이지", r7.ok === true, r7));
    // 상한을 아주 낮게 둔 설정(256) — 메타가 예산을 먹어도 참조 페이지·검색 응답이 상한 안이고 나아간다(구현 검토 R8)
    {
      const { toolRecallResponse, toolRecallSearchResponse } = await import("../../store/tool-recall.js");
      const LOW = 256;
      const loaded = { ok: true as const, ref: "rabcdefgh.1", at: 0, tool: "Read", args: JSON.stringify({ path: "a".repeat(200) }), text: "x".repeat(100_000) };
      const lowPages: string[] = [];
      for (let off = 0, n = 0; n < 5; n++) {
        const raw = JSON.stringify(toolRecallResponse(loaded, { offset: off }, LOW));
        lowPages.push(raw);
        off = (JSON.parse(raw) as { nextOffset?: number }).nextOffset ?? off;
      }
      const lowOffsets = lowPages.map((r) => (JSON.parse(r) as { offset: number }).offset);
      const emptySearch = JSON.stringify(toolRecallSearchResponse({ total: 0, totalCapped: false, hits: [] }, "q".repeat(200), LOW));
      const { toolRecallFailureResponse } = await import("../../store/tool-recall.js");
      const failNul = JSON.stringify(toolRecallFailureResponse({ ok: false, reason: "bad_ref", ref: "\u0000".repeat(40) }, "참조 형식이 아닙니다(예: 1234#2 또는 rk3f9a2xq.3).", LOW));
      const failLong = JSON.stringify(toolRecallFailureResponse({ ok: false, reason: "not_found", ref: "9".repeat(198) + "#1" }, "그런 기록이 없습니다.", LOW));
      out.push(assert("★상한 256 설정: 참조 페이지가 상한 안이고 매번 나아간다 · 빈 검색 응답·실패 응답(이스케이프 많은 참조·긴 참조)도 상한 안(최소 응답)",
        lowPages.every((r) => fitsToolEntry(r, LOW)) && lowOffsets.every((o, i) => i === 0 || o > lowOffsets[i - 1]!) && fitsToolEntry(emptySearch, LOW) &&
          fitsToolEntry(failNul, LOW) && fitsToolEntry(failLong, LOW) && (JSON.parse(failNul) as { unavailable?: string }).unavailable === "bad_ref",
        { pages: lowPages.map((r) => r.length), offsets: lowOffsets, emptySearch: emptySearch.length, failNul: failNul.length, failLong: failLong.length }));
    }
    // 상한만 낮춘 설정 — 보기 전체(앞·뒤·안내)가 상한 안(구현 검토 R1 ③). 기본값에선 앞·뒤 8,000/4,000 그대로.
    const p20 = "c".repeat(20_000);
    const lowCaps = [12_000, 9_000, 5_000].map((cap) => ({ cap, len: H.capToolOutputForEntry(p20, { cap, ref: "rabcdefgh.12" }).length }));
    const dflt = H.capToolOutputForEntry(p20, { ref: "rabcdefgh.12" });
    out.push(assert("★진입 상한을 낮춘 설정에서도 보기 전체 ≤ 상한 · 기본값은 앞 8,000·뒤 4,000 그대로",
      lowCaps.every((c) => c.len <= c.cap) && dflt.length <= CAP && dflt.startsWith("c".repeat(8_000) + "\n") && dflt.endsWith("\n" + "c".repeat(4_000)),
      { lowCaps, dflt: dflt.length }));

    // ⑤ 보존 상한 · 단건 읽기 비용 · 다음 턴 증분
    // 10만 자 이하는 손실 없이 보존된다 — 숫자를 제품 상수에서 끌어오지 않는다(독립 변이 사냥 M11: 상수를 9만으로 줄여도 초록이었다)
    const under = "a".repeat(47_493) + "MIDDLE-WITNESS" + "b".repeat(47_494);
    const pUnder = H.preserveToolOutput(under);
    out.push(assert("★95,001자 결과는 그대로 보존된다(가운데 표식 포함 · 회수 불가 표식 없음)",
      under.length === 95_001 && pUnder === under && pUnder.includes("MIDDLE-WITNESS") && !pUnder.includes("회수 불가"), { len: pUnder.length }));
    const huge = "머" + "x".repeat(150_000) + "TAIL-KEEP";
    const pHuge = H.preserveToolOutput(huge);
    const vHuge = H.capToolOutputForEntry(pHuge, { ref: "rabcdefgh.1" });
    out.push(assert("★보존 상한: 표식 포함 ≤ 100,000자 · 끝은 남고 «회수 불가» 를 본문과 보기 안내에 적는다",
      pHuge.length <= TOOL_OUTPUT_RETAIN_CHARS && pHuge.endsWith("TAIL-KEEP") && pHuge.includes("회수 불가") && vHuge.includes("보관되지 않아 회수할 수 없습니다"),
      { chars: pHuge.length }));
    const bigTurn = Array.from({ length: 8 }, (_, i) => [
      { type: "function_call" as const, call_id: `b${i}`, name: "Read", arguments: "{}" },
      { type: "function_call_output" as const, call_id: `b${i}`, output: `BIG${i} ` + "y".repeat(60_000) },
    ]).flat();
    appendApiTurn({ channel: CH, threadKey: "regr:recall-cost", claudeSessionId: "regr-same-turn-cost", userContent: "q", assistantContent: "a", items: bigTurn });
    const { getDb } = await import("../../store/sessions.js");
    const tid = (getDb().prepare(`SELECT transcript_id AS t FROM turn_items WHERE item LIKE '%BIG3 %' LIMIT 1`).get() as { t: number }).t;
    const s0 = stats();
    const one = readThreadToolResult(CH, "regr:recall-cost", `${tid}#7`);
    const s1 = stats();
    // query 칸으로 들어온 긴 참조(앞에 0)도 정규형으로 돌려줘 낮은 상한에서 최소 응답이 상한 안(구현 검토 R9)
    {
      const { loadThreadToolResult, toolRecallResponse, fitsToolEntry: fitsE } = await import("../../store/tool-recall.js");
      const padded = `${"0".repeat(190)}${tid}#15`;
      const viaPad = loadThreadToolResult(CH, "regr:recall-cost", padded);
      const lowResp = viaPad.ok ? JSON.stringify(toolRecallResponse(viaPad, {}, 256)) : "";
      out.push(assert("★앞에 0 을 붙인 긴 참조도 같은 기록을 읽고 정규형 참조를 돌려준다 · 상한 256 에서 응답이 상한 안",
        viaPad.ok && viaPad.ref === `${tid}#15` && fitsE(lowResp, 256), { ok: viaPad.ok, ref: viaPad.ok ? viaPad.ref : viaPad.reason, len: lowResp.length }));
    }
    out.push(assert("★단건 읽기는 그 턴 전체를 JS 로 파싱하지 않는다(턴 읽기 0회) · 짝 인자·결과는 맞다",
      one.ok && one.text.startsWith("BIG3 ") && s1.turnLoads === s0.turnLoads, { loads: s1.turnLoads - s0.turnLoads, ok: one.ok }));
    // 이어 읽기는 저장소를 다시 훑지 않는다 — 한 실행(도구 인스턴스) 안에서 한 결과를 끝까지 읽는 동안 조회 1회(구현 검토 R1 ②)
    const costRecall = handlerOf(createToolRecallMcpServer({ channel: CH, threadKey: "regr:recall-cost" }), "read_past_tool_result");
    const c0 = stats().resultLoads;
    let costPages = 0;
    for (let off = 0, n = 0; n < 20; n++) {
      const p = JSON.parse((await costRecall({ ref: `${tid}#15`, offset: off }, {})).content[0]!.text ?? "{}") as { nextOffset?: number; eof?: boolean };
      costPages += 1;
      if (p.eof === true || p.nextOffset === undefined) break;
      off = p.nextOffset;
    }
    const c1 = stats().resultLoads;
    out.push(assert("★한 결과를 여러 페이지로 끝까지 읽어도 저장소 조회는 1회",
      costPages >= 4 && c1 - c0 === 1, { pages: costPages, loads: c1 - c0 }));
    // 다음 턴 증분 실측 — 비밀 없는 큰 결과: 종전 저장(자른 뒤 가림) 대비 새 보기
    const plain = "줄내용 " + "w".repeat(22_735);
    const oldStored = (await import("../../core/outbound-sanitize.js")).redactSecrets(
      `${plain.slice(0, 8_000)}\n…[중략 ${plain.length - 12_000}자 — 전체 출력이 잘렸습니다. 특정 부분이 필요하면 Read offset/limit 또는 Grep 으로 좁혀 재요청하세요.]…\n${plain.slice(-4_000)}`);
    const P1 = runTurn([{ id: "P", out: plain }]);
    const newShown = P1.replayedOut.get("P") ?? "";
    const delta = newShown.length - oldStored.length;
    out.push(assert("다음 턴 증분(비밀 없는 큰 결과) = 안내 문구 차이뿐 — 본문은 같고 차이는 안내 길이만(200자 미만)",
      newShown.split("\n…[중략")[0] === oldStored.split("\n…[중략")[0] && delta > 0 && delta < 200, { old: oldStored.length, new: newShown.length, delta }));
    return out;
  },
};
