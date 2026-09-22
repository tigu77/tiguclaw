import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { initStore } from "../../store/sessions.js";
import { registerAuthProvider } from "../../core/llm-runtime/auth-registry.js";
import { assertIsolated } from "./_framework.js";
assertIsolated();
initStore();
process.env.CODEX_COMPACT_KEEP_RECENT = "1";
registerAuthProvider({ provider: "codex", getAccessToken: async () => "fake-regression-token" });
const refs = [1, 2, 3].map(i => `opaque${i}.${"a".repeat(64)}`);
let calls = 0;
const server = createSdkMcpServer({ name: "saved-probe", version: "1", tools: [
  tool("saved_probe", "합성 미디어 결과", {}, async () => ({ content: [
    { type: "text" as const, text: "합성 긴 결과\n" + "x".repeat(20_000) },
    { type: "image" as const, mimeType: "image/png", data: "U1RVSg==", _meta: { "tiguclaw/saved-screen": refs[calls++] } },
  ] })),
] });
const requests: { input: { type: string; call_id?: string; output?: string }[] }[] = [];
globalThis.fetch = async (_url, init) => {
  requests.push(JSON.parse(String(init?.body)));
  if (requests.length > 4) throw new Error("unexpected request");
  const call = { type: "function_call", id: `fc_${requests.length}`, call_id: `call_${requests.length}`, name: "saved_probe", arguments: "{}" };
  const events = requests.length <= 3 ? [
    { type: "response.output_item.added", item: call },
    { type: "response.output_item.done", item: call },
  ] : [{ type: "response.output_text.delta", delta: "확인 완료" }];
  return new Response([...events, { type: "response.completed", response: { id: "fixture", status: "completed", usage: { input_tokens: 20, output_tokens: 1 } } }].map(e => `data: ${JSON.stringify(e)}\n\n`).join(""));
};
const { runOpenAiCodex } = await import("../../core/llm-runtime/adapters/openai-codex-oauth.js");
await runOpenAiCodex({ text: "합성 저장 화면을 확인하세요", channel: "cli", threadKey: "regr:saved-screen", model: "gpt-5.6-sol", reasoning: "low", extraMcpServers: { "saved-probe": server } });
const first = requests[3]?.input.find(x => x.type === "function_call_output" && x.call_id === "call_1")?.output ?? "";
console.log("SAVED_WIRE " + JSON.stringify({ requests: requests.length, calls, compacted: first.includes("이전 도구 출력 생략"), refPreserved: first.includes(refs[0]!), privateMeta: JSON.stringify(requests[3]).includes("tiguclaw/saved-screen") }));
process.exit(0);
