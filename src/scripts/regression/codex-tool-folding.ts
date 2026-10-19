/**
 * 회귀: **Codex 도구 접기** — 드문 도구를 서버별 묶음으로 접고, 펼친 결과를 같은 턴·다음 턴에 잃지 않는다 (2026-10-17).
 *
 * 계약: `docs/decisions/2026-10-17-tool-folding-contract.md`(아스트라 검토 A~E). 실측: 같은 날 조사·탐침(T1~T3).
 * 사고(코드 대조로 드러난 것): 응답에 검색 항목이 하나라도 있으면 재전송 판정이 응답 전체를 버리고 호출만 다시 만들어, **펼친 정의와
 *  `namespace` 가 같은 턴 다음 요청부터 사라졌다**(웹 검색이 2026-09-28 에 같은 병으로 같은 검색을 반복했다).
 *
 * 본다:
 *  ① 조립 — 꺼짐이면 그대로 · 켜짐이면 `onDemand` 만 서버별 묶음 · 펼친 것 순서 유지 · 이름 충돌·이름 모양 위반 서버는 펼침 ·
 *     접힌 것 0 이면 `tool_search` 없음 · 묶음 설명은 남은 도구 힌트로만
 *  ② 턴 안 — 실제 SSE 모양을 파서에 넣어: 검색 항목이 재전송 대상 · `id` 빠짐 · 호출의 `namespace` 보존 · 짝 대조 통과 · 미완성 검색은 재전송 안 함
 *  ③ 저장·복원 — 호출의 `namespace` 만 저장(정의 저장 없음) → 다음 턴 이력에 되살아남 → 이번에도 접혀 있으면 첫 호출 앞에 현재 정의로
 *     검색 항목 한 번 · 이번엔 없는 묶음이면 `namespace` 를 뗌 · 현재 턴 항목은 안 건드림
 *  ④ 실행 — `namespace` 가 등록 정보의 소속 서버와 다르면 실행하지 않는다
 *
 * 등급: **실행**(리프 모듈 · 실제 파서·저장·복원 함수).
 */
import {
  buildCodexInputArray,
  collectTurnItems,
  compatibleReplayOutput,
  parseCodexSse,
  type ResponseInputItem,
} from "../../core/llm-runtime/adapters/openai-codex-oauth-history.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { foldCodexTools, namespaceMatches, withoutToolSearch, withRestoredToolSearch, type FoldEntry } from "../../core/llm-runtime/adapters/_codex-tool-folding.js";
import { assert, spawnWithin, type Assertion, type RegressionCheck } from "./_framework.js";
import { readSourceSync, stripComments } from "./_wiring.js";

const fn = (name: string): FoldEntry["tool"] => ({ type: "function", name, description: `${name} 설명`, parameters: { type: "object", properties: {} }, strict: false });
const sse = (events: unknown[]): ReadableStream<Uint8Array> => {
  const enc = new TextEncoder();
  return new ReadableStream({ start(c) { for (const e of events) c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`)); c.close(); } });
};

export const check: RegressionCheck = {
  name: "codex-tool-folding",
  guards: "Codex 도구 접기 — 검색 항목이 섞인 응답을 통째로 재전송에서 빼 펼친 정의·namespace 가 사라지던 것(같은 턴 다음 요청부터) + 조립·복원·실행 계약",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    // ① 조립
    const entries: FoldEntry[] = [
      { tool: fn("search_memory"), server: "memory", hint: null },
      { tool: fn("archive_memory"), server: "memory", hint: "메모리를 인덱스에서 내린다" },
      { tool: fn("register_command"), server: "commands", hint: "명령 등록" },
      { tool: fn("delete_command"), server: "commands", hint: "명령 삭제" },
      { tool: fn("odd"), server: "bad name!", hint: "이름 모양 위반" },
      { tool: fn("dup"), server: "search_memory", hint: "펼친 도구와 이름이 겹침" },
    ];
    const off = foldCodexTools(entries, false);
    const on = foldCodexTools(entries, true);
    const none = foldCodexTools(entries.filter((e) => e.hint === null), true);
    const names = on.tools.map((t) => (t.type === "namespace" ? `ns:${t.name}` : t.name));
    const commands = on.namespaces.get("commands");
    out.push(assert("① 꺼짐이면 그대로 · 켜짐이면 onDemand 만 서버별 묶음(펼친 것 앞·원래 순서) · 이름 위반·충돌 서버는 펼침 · 접힌 것 0 이면 tool_search 없음",
      off.tools.length === entries.length && !off.searchTool &&
        names.join(",") === "search_memory,odd,dup,ns:memory,ns:commands" && on.searchTool &&
        commands !== undefined && commands.tools.every((t) => t.defer_loading === true) && /register_command — 명령 등록/.test(commands.description) &&
        !/archive_memory/.test(commands.description) && !none.searchTool && none.namespaces.size === 0,
      { names, offN: off.tools.length, commandsDesc: commands?.description, noneSearch: none.searchTool }));

    // ② 턴 안 — 관측한 모양 그대로(서버 실행 검색 + 펼친 도구 호출)
    const ns = { type: "namespace", name: "commands", description: "d", tools: [{ ...fn("register_command"), defer_loading: true }] };
    const searchCall = { id: "tsc_1", type: "tool_search_call", status: "completed", arguments: { paths: ["commands"] }, call_id: null, execution: "server" };
    const searchOut = { id: "tso_1", type: "tool_search_output", status: "completed", call_id: null, execution: "server", tools: [ns] };
    const call = { id: "fc_1", type: "function_call", status: "completed", call_id: "call_1", name: "register_command", namespace: "commands", arguments: "{\"name\":\"인사\"}" };
    const parsed = await parseCodexSse(sse([
      { type: "response.output_item.done", output_index: 0, item: searchCall },
      { type: "response.output_item.done", output_index: 1, item: searchOut },
      { type: "response.output_item.added", output_index: 2, item: { ...call, status: "in_progress", arguments: "" } },
      { type: "response.output_item.done", output_index: 2, item: call },
      { type: "response.completed", response: { output: [searchCall, searchOut, call], usage: { input_tokens: 1, output_tokens: 1 } } },
    ]));
    const replay = compatibleReplayOutput(parsed);
    const types = (replay ?? []).map((i) => i.type);
    const replayedSearch = (replay ?? []).filter((i) => i.type === "tool_search_call" || i.type === "tool_search_output");
    const replayedCall = (replay ?? []).find((i) => i.type === "function_call") as { namespace?: string } | undefined;
    out.push(assert("② 검색 항목이 섞인 응답도 재전송된다 — 검색 항목(id 뺌) · 호출의 namespace · 짝 대조 통과 · 파서의 호출에도 namespace",
      types.join(",") === "tool_search_call,tool_search_output,function_call" && replayedSearch.every((i) => !("id" in i)) &&
        replayedCall?.namespace === "commands" && parsed.toolCalls[0]?.namespace === "commands",
      { types, ids: replayedSearch.map((i) => ("id" in i ? "id남음" : "id없음")), callNs: replayedCall?.namespace, parsedNs: parsed.toolCalls[0]?.namespace }));
    const partial = await parseCodexSse(sse([
      { type: "response.output_item.done", output_index: 0, item: { ...searchCall, status: "in_progress" } },
      { type: "response.completed", response: { output: [{ ...searchCall, status: "in_progress" }], usage: { input_tokens: 1, output_tokens: 1 } } },
    ]));
    out.push(assert("② 미완성 검색 항목은 재전송하지 않는다(완료된 검색처럼 싣지 않음)", compatibleReplayOutput(partial) === undefined,
      { replay: compatibleReplayOutput(partial)?.map((i) => i.type) ?? "없음" }));

    // ③ 저장·복원
    const turnSlice = [...(replay ?? []), { type: "function_call_output", call_id: "call_1", output: "등록됨" }] as ResponseInputItem[];
    const stored = collectTurnItems(turnSlice, "만들었어요");
    const storedCall = stored.find((i) => i.type === "function_call") as { namespace?: string } | undefined;
    const storedHasDefinition = JSON.stringify(stored).includes("defer_loading") || stored.some((i) => (i.type as string).startsWith("tool_search"));
    const current: ResponseInputItem = { type: "message", role: "user", content: [{ type: "input_text", text: "그 명령 지워줘" }] };
    const history = buildCodexInputArray(
      [{ role: "user", content: "명령 만들어줘" } as never, { role: "assistant", content: "만들었어요", items: stored } as never],
      "", current);
    const historyEnd = history.length - 1; // 마지막이 현재 턴
    const restoredHere = withRestoredToolSearch(history, historyEnd, on.namespaces) as Array<{ type: string; namespace?: string; tools?: Array<{ name?: string; tools?: unknown[] }> }>;
    const rTypes = restoredHere.map((i) => i.type);
    const firstCall = rTypes.indexOf("function_call");
    const rebuilt = restoredHere.find((i) => i.type === "tool_search_output");
    const gone = withRestoredToolSearch(history, historyEnd, null) as Array<{ type: string; namespace?: string }>;
    const twice = withRestoredToolSearch([...history.slice(0, historyEnd), ...history.slice(0, historyEnd), current], historyEnd * 2, on.namespaces) as Array<{ type: string }>;
    const currentTurnCall = withRestoredToolSearch([current, { type: "function_call", call_id: "c", name: "register_command", namespace: "commands", arguments: "{}" }] as ResponseInputItem[], 1, null) as Array<{ namespace?: string }>;
    out.push(assert("③ 저장은 호출의 namespace 만(정의 없음) → 다음 턴 이력에 되살아남 → 접혀 있으면 첫 호출 앞에 현재 정의로 검색 항목 · 한 번만 · 없는 묶음이면 namespace 뗌 · 현재 턴은 안 건드림",
      storedCall?.namespace === "commands" && !storedHasDefinition &&
        rTypes[firstCall - 2] === "tool_search_call" && rTypes[firstCall - 1] === "tool_search_output" &&
        rebuilt?.tools?.[0]?.name === "commands" && (rebuilt?.tools?.[0]?.tools?.length ?? 0) === 2 &&
        twice.filter((i) => i.type === "tool_search_output").length === 1 &&
        gone.every((i) => i.namespace === undefined) && !gone.some((i) => i.type.startsWith("tool_search")) &&
        currentTurnCall[1]?.namespace === "commands",
      { storedNs: storedCall?.namespace, storedHasDefinition, rTypes, rebuiltTools: rebuilt?.tools?.[0]?.tools?.length, twice: twice.filter((i) => i.type === "tool_search_output").length }));

    // ④ 실행
    out.push(assert("④ 호출의 namespace 는 등록 정보의 소속 서버와 같아야 실행 — 다르면 거부, 없으면(펼친 도구) 이름만으로",
      namespaceMatches("commands", "commands") && !namespaceMatches("memory", "commands") && namespaceMatches(undefined, "commands"),
      { same: namespaceMatches("commands", "commands"), other: namespaceMatches("memory", "commands") }));

    // 배선 — 어댑터가 이 모듈을 그 자리에서 쓴다(기본 꺼짐 · 카탈로그 지원 · tool_search 조건 · 보낼 사본에서 복원 · 실행 검증)
    const a = stripComments(readSourceSync("src/core/llm-runtime/adapters/openai-codex-oauth.ts"));
    const w = {
      gate: /process\.env\.CODEX_TOOL_SEARCH !== "0" && catalogSupportsToolSearch\("codex", model\) === true/.test(a),
      // 외부 MCP 서버 도구는 표식이 없어도 접는다(빈 힌트 = 설명엔 이름만) · read_past_tool_result 는 Codex 에서 펼친다(2026-10-18 결정).
      externalFolded: /externalServerToolNames\.has\(tool\.name\) \? "" : null/.test(a),
      // read_past_tool_result 를 따로 펼치는 예외가 없다 — Claude 와 같이 접힌다(2026-10-19 정태님).
      recallSameAsClaude: !/tool\.name === "read_past_tool_result"/.test(a),
      searchToolOnlyWhenFolded: /\.\.\.\(toolFolding\.searchTool \? \[\{ type: "tool_search" as const \}\] : \[\]\)/.test(a),
      // 보낼 사본에서 — 도구 없는 요청(마무리)·접기 꺼짐이면 흔적 전부 빼기, 아니면 이력 복원.
      restoreOnCopy: /finalFlushRequested \|\| !toolFolding\.searchTool\s*\?\s*withoutToolSearch\(inputArray\)\s*:\s*withRestoredToolSearch\(inputArray, turnStart, toolFolding\.namespaces\)/.test(a),
      execCheck: /!namespaceMatches\(tc\.namespace, bridge\.name\)/.test(a),
      fallbackKeepsNs: /\.\.\.\(tc\.namespace !== undefined \? \{ namespace: tc\.namespace \} : \{\}\)/.test(a),
    };
    // 외부 서버 묶음 — 설명엔 **이름만**(서버가 커질수록 설명이 정의만큼 커지면 접는 의미가 없다) · 정의는 전부 접힘.
    const ext = foldCodexTools([
      { tool: fn("read_wiki_structure"), server: "deepwiki", hint: "" },
      { tool: fn("ask_wiki_question"), server: "deepwiki", hint: "" },
      { tool: fn("Bash"), server: "file-ops", hint: null },
    ], true);
    const dw = ext.namespaces.get("deepwiki");
    out.push(assert("외부 MCP 서버는 서버별 묶음으로 접힌다 — 설명엔 도구 이름만 · 정의는 접힘 · 표식 없는 우리 도구는 펼침",
      dw?.description === "deepwiki: read_wiki_structure · ask_wiki_question" && dw.tools.every((t) => t.defer_loading === true) &&
        ext.tools.some((t) => t.type === "function" && t.name === "Bash") && ext.searchTool,
      { desc: dw?.description, flat: ext.tools.filter((t) => t.type === "function").map((t) => (t as { name: string }).name) }));
    // ── 적대 검토(10-19) — 기본 켜짐이라 모든 Codex 턴에 닿는다 ─────────────────────────────────────────────
    // 이름: 펼쳐 둔 **모든** 도구 이름·공급자 예약어와 겹치는 묶음은 접지 않는다(이름 모양 위반으로 펼친 외부 서버의 도구 `github` vs 서버 `github`).
    const clash = foldCodexTools([
      { tool: fn("github"), server: "my docs", hint: "" },
      { tool: fn("gh_search"), server: "github", hint: "" },
      { tool: fn("ws_tool"), server: "web_search", hint: "" },
    ], true);
    const clashKinds = clash.tools.map((t) => `${t.type}:${(t as { name: string }).name}`);
    out.push(assert("이름 — 펼친 외부 도구 이름과 같은 서버·공급자 예약어(web_search) 서버는 접지 않는다(같은 이름이 둘 실리지 않게)",
      !clash.namespaces.has("github") && !clash.namespaces.has("web_search") && new Set(clashKinds.map((k) => k.split(":")[1])).size === clashKinds.length,
      clashKinds));
    // 복원: 묶음은 있어도 그 도구가 이번엔 없으면 소속을 뗀다.
    const nsNow = foldCodexTools([{ tool: fn("new_tool"), server: "deepwiki", hint: "" }], true).namespaces;
    const restoredGone = withRestoredToolSearch([{ type: "function_call", name: "old_tool", namespace: "deepwiki" } as { type: string }], 1, nsNow) as Array<{ type: string; namespace?: string }>;
    out.push(assert("복원 — 묶음에 그 도구가 이번엔 없으면 namespace 를 떼고 검색 항목을 만들지 않는다",
      restoredGone.length === 1 && restoredGone[0]?.namespace === undefined, restoredGone));
    const stripped = withoutToolSearch([
      { type: "tool_search_call" }, { type: "tool_search_output" }, { type: "function_call", name: "x", namespace: "commands" } as { type: string },
    ]) as Array<{ type: string; namespace?: string }>;
    out.push(assert("도구 없는 요청용 사본 — 검색 항목을 빼고 namespace 를 뗀다(이 턴 구간 포함)",
      stripped.length === 1 && stripped[0]?.namespace === undefined, stripped));
    // 실행 — 실제 runOpenAiCodex(가짜 네트워크).
    const child = path.join(path.dirname(fileURLToPath(import.meta.url)), "_codex-fold-child.ts");
    const runChild = async (mode: string): Promise<{ text: string | null; err: string | null; shape: Array<{ tools: number; folded: boolean; traces: number }>; sizes?: number[] }> => {
      const r = await spawnWithin(60_000, `codex-fold(${mode})`, ["--import", "tsx", child, mode], { stdio: ["ignore", "pipe", "pipe"], env: process.env });
      const line = r.out.trim().split("\n").filter((l) => l.startsWith("{")).pop();
      return line === undefined ? { text: null, err: r.err.slice(-200), shape: [] } : JSON.parse(line);
    };
    const empty = await runChild("empty");
    const flushReqs = empty.shape.filter((x) => x.tools === 0);
    out.push(assert("★빈 응답 마무리 요청(tools: []) — 이 턴의 검색 항목·namespace 를 싣지 않는다(서버가 도구 없는 요청의 검색 항목을 거절)",
      empty.shape[0]?.folded === true && flushReqs.length >= 1 && flushReqs.every((x) => x.traces === 0), empty));
    const rej = await runChild("reject400");
    out.push(assert("★접기 안전망 — 접힌 요청이 400 이면 이 턴은 접기를 끄고 한 번 다시 보내 답을 받는다(다른 어댑터로 넘기지 않는다)",
      rej.err === null && rej.text === "끝" && rej.shape.length === 2 && rej.shape[0]?.folded === true && rej.shape[1]?.folded === false && rej.shape[1]?.traces === 0, rej));
    const later = await runChild("reject400-later");
    const afterReject = later.shape.slice(2); // 1=접힌 첫 요청 · 2=접힌 채 400 · 그 뒤 전부
    out.push(assert("★접기 안전망 — 둘째 요청이 400 이어도 그 뒤 요청은 전부 펼친 채·흔적 없이(같은 턴의 다음 iteration 까지)",
      later.err === null && later.text === "끝" && later.shape[1]?.folded === true && afterReject.length >= 2 && afterReject.every((x) => !x.folded && x.traces === 0), later));
    const then503 = await runChild("reject400-then-503");
    out.push(assert("접기 안전망의 재전송도 재시도 루프 안 — 재전송이 503 이면 재시도가 흡수해 답을 받는다",
      then503.err === null && then503.text === "끝" && then503.shape.length === 3, then503));
    const plain = await runChild("plain400");
    out.push(assert("접히지 않은 요청의 400 은 다시 보내지 않는다(안전망은 접힌 요청에만)",
      plain.err !== null && plain.shape.length === 1, plain));
    // ★펼친 재전송은 접힌 본문보다 **크지 않다** — 그래서 입력 상한(iteration 0, 본문 글자 수)을 다시 볼 필요가 없다(아스트라 10-19 Q2 를 성질로 닫음).
    //  접힌 묶음은 정의 전체를 복사해 `defer_loading`·감싸개·검색 도구를 **더하고**, 펼칠 때 입력은 검색 흔적을 **빼기만** 한다(`withoutToolSearch`).
    //  접기가 정의를 덜 싣게 바뀌는 날 이 단언이 빨개진다 — 그때 펼친 재전송에 상한 검사를 붙여라.
    out.push(assert("★접기 안전망 — 펼친 재전송 본문 ≤ 접힌 본문(그래서 상한을 통과한 접힌 요청의 펼친 재전송은 상한을 넘을 수 없다)",
      rej.sizes !== undefined && rej.sizes.length === 2 && rej.sizes[1]! <= rej.sizes[0]!, rej.sizes));
    // 연쇄 충돌 — 한 서버를 펼치면 그 도구 이름이 다른 묶음과 또 겹친다(반복이 한 번이면 둘이 실린다).
    const chain = foldCodexTools([
      { tool: fn("alpha"), server: "x y", hint: "" },
      { tool: fn("beta"), server: "alpha", hint: "" },
      { tool: fn("gamma"), server: "beta", hint: "" },
      { tool: fn("delta"), server: "Web_Search", hint: "" },
    ], true);
    const chainNames = chain.tools.map((t) => (t as { name: string }).name);
    out.push(assert("연쇄 충돌·대소문자 예약어 — 펼친 이름과 겹치는 묶음이 사슬로 이어져도 같은 이름이 둘 실리지 않는다 · Web_Search 도 예약어",
      new Set(chainNames).size === chainNames.length && !chain.namespaces.has("beta") && !chain.namespaces.has("Web_Search"), chainNames));
    const extRun = await runChild("external") as Awaited<ReturnType<typeof runChild>> & { external?: { folded: boolean; flat: boolean } };
    out.push(assert("★외부 MCP 서버(실제 HTTP, mcp.json) — 그 도구는 표식이 없어도 서버 이름 묶음으로 접혀 실린다(펼친 채로는 안 실린다)",
      extRun.external?.folded === true && extRun.external.flat === false && extRun.text === "끝", extRun.external ?? extRun));
    out.push(assert("배선 — 기본 켜짐(CODEX_TOOL_SEARCH=0 이면 끔)·카탈로그 지원 모델만 · 외부 서버 접기 · read_past_tool_result 는 Claude 와 같이 접힘 · 접힌 것 있을 때만 tool_search · 보낼 사본에서 복원 · 실행 전 namespace 검증 · 재구성 호출도 namespace 보존",
      Object.values(w).every(Boolean), w));
    return out;
  },
};
