// 상한 마무리(tools:[]) 요청이 글을 흘리다 끊겼을 때 — 이어 쓰기 재전송 본문에 부분 글·이어 쓰기 지시가 실리고 검색 항목은 빠지는가
//  (2026-10-12 적대 검토 F3: 검색 항목을 거른 **사본**을 보내는 요청에서 끊김 복구가 원본 배열에만 덧붙이면, 재전송 본문에 부분 글이 빠져
//  모델이 처음부터 다시 써 글이 겹친다). 레드팀 재현 스크립트를 그대로 옮겼다.
import { initStore } from "../../store/sessions.js";
import { registerAuthProvider } from "../../core/llm-runtime/auth-registry.js";
import { assertIsolated, fakeNetwork } from "./_framework.js";
assertIsolated();
initStore();
process.env.CODEX_MAX_TOOL_ITERATIONS_HARD = "2";
registerAuthProvider({ provider: "codex", getAccessToken: async () => "fake-test-token" });
type Body = { input?: unknown[]; tools?: unknown[] };
const requests: Body[] = [];
const out = console.log.bind(console);
console.log = () => {};
console.warn = () => {};
console.error = () => {};
const reasoning = { type: "reasoning", id: "rs", summary: [], encrypted_content: "x" };
const msg = (t: string) => ({ type: "message", id: "m", role: "assistant", status: "completed", content: [{ type: "output_text", text: t, annotations: [] }] });
const call = (n: number) => ({ type: "function_call", id: `fc${n}`, call_id: `c${n}`, name: "Read", arguments: JSON.stringify({ path: "/nonexistent-flush-cut" }) });
const ws = { type: "web_search_call", id: "ws", status: "completed", action: { type: "search", query: "q" } };
const sse = (items: Array<{ type: string }>, text: string): string =>
  [
    ...items.flatMap((item, i) => [
      { type: "response.output_item.added", output_index: i, item },
      ...(item.type === "message" ? [{ type: "response.output_text.delta", delta: text }] : []),
      { type: "response.output_item.done", output_index: i, item },
    ]),
    { type: "response.completed", response: { id: "r", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1 } } },
  ].map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
globalThis.fetch = fakeNetwork(async (_u: unknown, init?: RequestInit) => {
  requests.push(JSON.parse(String(init?.body)) as Body);
  const n = requests.length;
  if (n === 1) return new Response(sse([reasoning, ws, msg("읽겠습니다"), call(1)], "읽겠습니다"));
  if (n === 2) return new Response(sse([reasoning, msg("또"), call(2)], "또"));
  if (n === 3) {
    // 마무리 요청 — 글을 조금 흘리고 끊긴다
    const enc = new TextEncoder();
    const head = [
      { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "m3", role: "assistant", status: "in_progress", content: [] } },
      { type: "response.output_text.delta", delta: "앞부분" },
    ].map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
    const stream = new ReadableStream({ start(c) { c.enqueue(enc.encode(head)); setTimeout(() => c.error(new TypeError("terminated")), 20); } });
    return new Response(stream);
  }
  return new Response(sse([msg("뒷부분")], "뒷부분"));
}) as never;
const { runOpenAiCodex } = await import("../../core/llm-runtime/adapters/openai-codex-oauth.js");
let text: string | undefined;
let err: string | undefined;
try {
  text = (await runOpenAiCodex({ text: "검색하고 읽어줘", channel: "cli", threadKey: "regr:flush-cut", model: "gpt-5.6-sol", reasoning: "low" } as never)).text;
} catch (e) {
  err = String(e).slice(0, 160);
}
const last = requests[requests.length - 1];
const lastInput = JSON.stringify(last?.input ?? []);
out("FLUSH_CUT " + JSON.stringify({
  requests: requests.length,
  flushNoTools: requests[2]?.tools?.length === 0,
  retryNoTools: last?.tools?.length === 0,
  retryHasPartial: lastInput.includes("앞부분"),
  retryHasNudge: lastInput.includes("이어서 쓰세요"),
  retryHasSearch: lastInput.includes("web_search_call"),
  text,
  err,
}));
process.exit(0);
