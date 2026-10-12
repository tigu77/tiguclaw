import { initStore } from "../../store/sessions.js";
import { registerAuthProvider } from "../../core/llm-runtime/auth-registry.js";
import { assertIsolated, fakeNetwork } from "./_framework.js";
assertIsolated();
initStore();
process.env.CODEX_DEBUG_INPUT = "1";
const cap = process.argv.includes("cap");
// 웹 검색이 섞인 응답 — 같은 턴의 다음 요청에 추론과 검색 항목을 그대로 싣는가(2026-10-12 맥돌쇠 반복의 근본 원인)
const search = process.argv.includes("search");
let retryPending = process.argv.includes("retry");
const usageResults: unknown[] = [];
if (cap)
    process.env.CODEX_MAX_TOOL_ITERATIONS_HARD = search ? "2" : "1";
registerAuthProvider({ provider: "codex", getAccessToken: async () => "fake-test-token" });
const requests: Array<{
    input: Array<Record<string, unknown>>;
    tools?: unknown[];
}> = [];
const logs: string[] = [];
const log = console.log.bind(console);
console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
console.error = console.log;
console.warn = console.log;
let execution = 0;
let requestInExecution = 0;
const reasoning = { type: "reasoning", id: "rs_loop", summary: [], encrypted_content: "opaque-adapter-replay-secret" };
const message = { type: "message", id: "msg_loop", role: "assistant", status: "completed", phase: "commentary", content: [{ type: "output_text", text: "읽겠습니다", annotations: [] }] };
// 실제 도구 실패 결과도 추론/호출과 연결되어 다음 요청에 도달해야 한다.
const call = { type: "function_call", id: "fc_loop", call_id: "call_loop", name: "Read", arguments: JSON.stringify({ path: "/nonexistent-reasoning-regression-file" }) };
const webSearch = { type: "web_search_call", id: "ws_loop", status: "completed", action: { type: "search", query: "리야드 공항", sources: [{ type: "url", url: "https://example.test/a" }] } };
globalThis.fetch = fakeNetwork(async (_url, init) => {
    if (retryPending) { retryPending = false; return new Response("synthetic retry", { status: 503 }); }
    requests.push(JSON.parse(String(init?.body)));
    requestInExecution += 1;
    // 검색+상한: 1차(검색·호출 실행) → 2차(검색 항목 실림, 또 호출 → 상한) → 3차(도구 없는 마무리)
    const searchCap = search && cap;
    if (requestInExecution > (searchCap ? 3 : 2))
        throw new Error("unexpected extra request");
    const first = requestInExecution === 1 || (searchCap && requestInExecution === 2);
    const activeReasoning = { ...reasoning, id: `rs_loop_${execution}`, encrypted_content: `${reasoning.encrypted_content}_${execution}` };
    const output = first ? (search && requestInExecution === 1 ? [activeReasoning, webSearch, message, call] : searchCap ? [activeReasoning, message, { ...call, id: "fc_loop_2", call_id: "call_loop_2" }] : [activeReasoning, message, call]) : [{ ...message, phase: "final_answer", content: [{ type: "output_text", text: "검사 완료", annotations: [] }] }];
    return new Response([...output.flatMap((item, output_index) => [{ type: "response.output_item.added", output_index, item }, ...(item.type === "message" ? [{ type: "response.output_text.delta", delta: first ? "읽겠습니다" : "검사 완료" }] : []), { type: "response.output_item.done", output_index, item }]), { type: "response.completed", response: { id: "resp_loop", status: "completed", output: [], usage: { input_tokens: 20, output_tokens: 2 } } }].map(e => `data: ${JSON.stringify(e)}\n\n`).join(""));
});
const { runOpenAiCodex } = await import("../../core/llm-runtime/adapters/openai-codex-oauth.js");
const input = { text: "파일을 읽고 결과를 알려주세요", channel: "cli" as const, threadKey: "regr:reasoning", model: "gpt-5.6-sol", reasoning: "low" as const };
for (execution = 0; execution < 2; execution += 1) {
    requestInExecution = 0;
    usageResults.push((await runOpenAiCodex(input)).usage);
}
const sent = requests[1]?.input ?? [];
const start = sent.findIndex(x => x.type === "reasoning");
const tail = sent.slice(start, start + 4);
log("REPLAY_RESULT " + JSON.stringify({ capNoOrphan: cap && !sent.some(x => x.type === "function_call") && sent.some(x => x.role === "assistant"), ordered: start >= 0 && JSON.stringify(tail.slice(0, 3)) === JSON.stringify([{ ...reasoning, id: "rs_loop_0", encrypted_content: `${reasoning.encrypted_content}_0` }, message, call]) && tail[3]?.type === "function_call_output" && tail[3]?.call_id === "call_loop" && sent.filter(x => x.type === "function_call").length === 1 && sent.filter(x => x.type === "message" && x.role === "assistant").length === 1, isolated: requests.length === 4 && !requests[2]?.input.some(x => x.type === "reasoning") && requests[3]?.input.filter(x => x.type === "reasoning").length === 1 && requests[3]?.input.some(x => x.type === "reasoning" && x.id === "rs_loop_1" && x.encrypted_content === `${reasoning.encrypted_content}_1`) && !JSON.stringify(requests.slice(2)).includes(`${reasoning.encrypted_content}_0`), noLeak: !logs.join("\n").includes(reasoning.encrypted_content) }));
if (search) {
    const ws = sent.filter(x => x.type === "web_search_call");
    // 상한 마무리 요청 = 첫 실행의 마지막 요청(3차)
    const flush = cap ? requests[2] : undefined;
    log("SEARCH_RESULT " + JSON.stringify({
        cap,
        reasoningKept: sent.some(x => x.type === "reasoning" && x.id === "rs_loop_0"),
        searchKept: ws.length === 1,
        searchShape: ws[0] === undefined ? null : JSON.stringify(ws[0]),
        searchTool: JSON.stringify(requests[1]?.tools ?? []).includes("web_search"),
        flushNoTools: flush === undefined ? null : flush.tools?.length === 0,
        flushHasSearch: flush === undefined ? null : flush.input.some(x => x.type === "web_search_call"),
        flushHasReasoning: flush === undefined ? null : flush.input.some(x => x.type === "reasoning"),
    }));
}
log("RETRY_USAGE " + JSON.stringify(usageResults));
process.exit(0);
