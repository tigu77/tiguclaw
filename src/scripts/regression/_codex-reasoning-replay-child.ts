import { initStore } from "../../store/sessions.js";
import { registerAuthProvider } from "../../core/llm-runtime/auth-registry.js";
import { assertIsolated, fakeNetwork } from "./_framework.js";
assertIsolated();
initStore();
process.env.CODEX_DEBUG_INPUT = "1";
const cap = process.argv.includes("cap");
if (cap)
    process.env.CODEX_MAX_TOOL_ITERATIONS_HARD = "1";
registerAuthProvider({ provider: "codex", getAccessToken: async () => "fake-test-token" });
const requests: Array<{
    input: Array<Record<string, unknown>>;
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
globalThis.fetch = fakeNetwork(async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    requestInExecution += 1;
    if (requestInExecution > 2)
        throw new Error("unexpected extra request");
    const first = requestInExecution === 1;
    const activeReasoning = { ...reasoning, id: `rs_loop_${execution}`, encrypted_content: `${reasoning.encrypted_content}_${execution}` };
    const output = first ? [activeReasoning, message, call] : [{ ...message, phase: "final_answer", content: [{ type: "output_text", text: "검사 완료", annotations: [] }] }];
    return new Response([...output.flatMap((item, output_index) => [{ type: "response.output_item.added", output_index, item }, ...(item.type === "message" ? [{ type: "response.output_text.delta", delta: first ? "읽겠습니다" : "검사 완료" }] : []), { type: "response.output_item.done", output_index, item }]), { type: "response.completed", response: { id: "resp_loop", status: "completed", output: [], usage: { input_tokens: 20, output_tokens: 2 } } }].map(e => `data: ${JSON.stringify(e)}\n\n`).join(""));
});
const { runOpenAiCodex } = await import("../../core/llm-runtime/adapters/openai-codex-oauth.js");
const input = { text: "파일을 읽고 결과를 알려주세요", channel: "cli" as const, threadKey: "regr:reasoning", model: "gpt-5.6-sol", reasoning: "low" as const };
for (execution = 0; execution < 2; execution += 1) {
    requestInExecution = 0;
    await runOpenAiCodex(input);
}
const sent = requests[1]?.input ?? [];
const start = sent.findIndex(x => x.type === "reasoning");
const tail = sent.slice(start, start + 4);
log("REPLAY_RESULT " + JSON.stringify({ capNoOrphan: cap && !sent.some(x => x.type === "function_call") && sent.some(x => x.role === "assistant"), ordered: start >= 0 && JSON.stringify(tail.slice(0, 3)) === JSON.stringify([{ ...reasoning, id: "rs_loop_0", encrypted_content: `${reasoning.encrypted_content}_0` }, message, call]) && tail[3]?.type === "function_call_output" && tail[3]?.call_id === "call_loop" && sent.filter(x => x.type === "function_call").length === 1 && sent.filter(x => x.type === "message" && x.role === "assistant").length === 1, isolated: requests.length === 4 && !requests[2]?.input.some(x => x.type === "reasoning") && requests[3]?.input.filter(x => x.type === "reasoning").length === 1 && requests[3]?.input.some(x => x.type === "reasoning" && x.id === "rs_loop_1" && x.encrypted_content === `${reasoning.encrypted_content}_1`) && !JSON.stringify(requests.slice(2)).includes(`${reasoning.encrypted_content}_0`), noLeak: !logs.join("\n").includes(reasoning.encrypted_content) }));
process.exit(0);
