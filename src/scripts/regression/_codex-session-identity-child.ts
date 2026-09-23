import { initStore } from "../../store/sessions.js";
import { registerAuthProvider } from "../../core/llm-runtime/auth-registry.js";
import { assertIsolated, fakeNetwork } from "./_framework.js";
assertIsolated();
initStore();
let account: string | undefined = "account-a";
let nonce = 0;
registerAuthProvider({ provider: "codex", getAccessToken: async () => `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: account }, nonce: ++nonce })).toString("base64url")}.synthetic` });
const rows: { key: string; session: string | null; thread: string | null; tools: number }[][] = [];
let current: typeof rows[number] = [];
globalThis.fetch = fakeNetwork(async (_url, init) => {
  const body = JSON.parse(String(init?.body));
  // 실제 Headers 생성으로 CRLF/Unicode 원시 키 전송도 검출한다.
  const headers = new Headers(init?.headers);
  current.push({ key: body.prompt_cache_key, session: headers.get("session-id"), thread: headers.get("thread-id"), tools: body.tools.length });
  const output = current.length === 1 ? [{ type: "function_call", id: "fc", call_id: "call", name: "Read", arguments: '{"path":"/nonexistent-session-test"}' }] : [];
  return new Response([...output.map(item => ({ type: "response.output_item.done", output_index: 0, item })), ...(output.length ? [] : [{ type: "response.output_text.delta", delta: "OK" }]), { type: "response.completed", response: { id: "resp", status: "completed", output, usage: { input_tokens: 1, output_tokens: 1 } } }].map(e => `data: ${JSON.stringify(e)}\n\n`).join(""));
});
const { runOpenAiCodex } = await import("../../core/llm-runtime/adapters/openai-codex-oauth.js");
const parent = "telegram:테스트\r\nx-injected: value";
for (const [acct, threadKey] of [["account-a", parent], ["account-a", parent], ["account-a", "worker:job-1"], ["account-a", "agent:job-1"], ["account-b", parent], [undefined, "legacy:thread"]] as const) {
  account = acct; current = []; rows.push(current);
  await runOpenAiCodex({ text: "Read then reply OK", channel: "cli", threadKey, model: "gpt-5.6-sol", reasoning: "low" });
}
console.log("SESSION_ID_RESULT " + JSON.stringify(rows));
process.exit(0);
