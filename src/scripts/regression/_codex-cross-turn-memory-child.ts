/**
 * 턴 간 도구 기억을 **router → 퍼사드 → 어댑터 루프 → 저장 → 다음 턴 조립** 실제 경로로 돌린다. 네트워크 0.
 *
 * ★왜 따로 있나(적대 검토 2026-09-27): 부품 검사만으로는 이음매 둘이 비었다 — 어댑터가 «이 턴에 새로 생긴 조각» 을
 *  자르는 자리(`turnStart`)를 0 으로 바꾸면 이력이 매 턴 다시 저장돼 제곱으로 불어나는데 전체 스위트가 초록이었고,
 *  퍼사드가 `items` 를 넘기지 않아 기능 전체가 꺼져도 초록이었다.
 * MEMORY-MARKER-4242 ← 가짜 모델이 1턴에 이 파일을 Read 한다. 이 표식이 다음 턴 입력에 **정확히 한 번** 있어야 한다.
 */
import { fileURLToPath } from "node:url";
import { initStore } from "../../store/sessions.js";
import { registerAuthProvider } from "../../core/llm-runtime/auth-registry.js";
import type { IncomingMessage } from "../../channels/types.js";
import { assertIsolated, fakeNetwork } from "./_framework.js";
assertIsolated();
process.env.REGION_A_MODELS = "codex:gpt-5.6-sol";
initStore();
registerAuthProvider({ provider: "codex", getAccessToken: async () => "regression-fake-token" });

type Item = { type?: string; role?: string; call_id?: string; output?: string; content?: Array<{ text?: string }> };
const firstRequests: Item[][] = [];
let turn = 0;
globalThis.fetch = fakeNetwork(async (_url, init) => {
  const body = JSON.parse(String(init?.body)) as { input: Item[] };
  const last = body.input[body.input.length - 1];
  const turnStartReq = last?.type === "message" && last.role === "user";
  if (turnStartReq) { turn += 1; firstRequests.push(body.input); }
  // 턴 시작 요청 → 도구 호출 1개 / 도구 결과 뒤 → 메시지 **두 개**로 답(commentary + final_answer).
  const call = { type: "function_call", id: `fc-${turn}`, call_id: `call-T${turn}`, name: "Read", arguments: JSON.stringify({ path: fileURLToPath(import.meta.url), limit: 12 }) };
  const msg = (id: string, phase: string, text: string) => ({ type: "message", id, role: "assistant", status: "completed", phase, content: [{ type: "output_text", text, annotations: [] }] });
  const output = turnStartReq ? [call] : [msg(`m1-${turn}`, "commentary", "확인해 보니 "), msg(`m2-${turn}`, "final_answer", `결론은 X${turn}`)];
  const events = output.flatMap((item, output_index) => [
    { type: "response.output_item.added", output_index, item },
    ...(item.type === "message" ? [{ type: "response.output_text.delta", delta: (item as { content: Array<{ text: string }> }).content[0]!.text }] : []),
    { type: "response.output_item.done", output_index, item },
  ]);
  return new Response(
    [...events, { type: "response.completed", response: { id: `resp-${turn}`, status: "completed", output: [], usage: { input_tokens: 10, output_tokens: 1 } } }]
      .map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""),
    { status: 200 },
  );
});
const realLog = console.log.bind(console);
console.log = () => {};
console.warn = () => {};

const { route } = await import("../../core/router.js");
const base = { channel: "dashboard" as const, channelUserId: "u", receivedAt: Date.now(), reply: async () => {} };
let error = "";
try {
  for (const text of ["첫 질문", "둘째 질문", "셋째 질문"]) await route({ ...base, threadKey: "regr:cross-turn-live", text } as IncomingMessage);
} catch (e) { error = e instanceof Error ? e.message : String(e); }

const outs = (xs: Item[] | undefined, id: string) => (xs ?? []).filter((x) => x.type === "function_call_output" && x.call_id === id);
const textOf = (xs: Item[] | undefined) => JSON.stringify(xs ?? []);
const count = (hay: string, needle: string) => hay.split(needle).length - 1;
realLog("CROSS_TURN_RESULT " + JSON.stringify({
  turns: firstRequests.length,
  t2HasT1: outs(firstRequests[1], "call-T1").some((o) => (o.output ?? "").includes("MEMORY-MARKER-4242")),
  t3T1Count: outs(firstRequests[2], "call-T1").length,
  t3T2Count: outs(firstRequests[2], "call-T2").length,
  t2AnswerCount: count(textOf(firstRequests[1]), "결론은 X1"),
  error,
}));
process.exit(0);
