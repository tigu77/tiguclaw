/**
 * 앞선 도구 결과 다시 읽기를 **router → 어댑터 도구 등록 → 저장(turn_items) → 다음 턴의 도구 실행** 실제 경로로 돌린다. 네트워크 0.
 * RECALL-MARKER-9157 ← 가짜 모델이 1턴에 이 파일을 Read 한다. 2턴에 이 표식으로 찾고, 3턴에 참조로 전문을 읽는다.
 * 4턴은 **다른 대화**에서 같은 참조·같은 표식을 시도한다 — 읽히면 안 된다.
 */
import { fileURLToPath } from "node:url";
import { initStore } from "../../store/sessions.js";
import { registerAuthProvider } from "../../core/llm-runtime/auth-registry.js";
import type { IncomingMessage } from "../../channels/types.js";
import { assertIsolated, fakeNetwork, pinModelForTest } from "./_framework.js";
assertIsolated();
pinModelForTest("codex:gpt-5.6-sol");
initStore();
registerAuthProvider({ provider: "codex", getAccessToken: async () => "regression-fake-token" });

type Item = { type?: string; role?: string; call_id?: string; output?: string };
const MARK = "RECALL-" + "MARKER-9157"; // 이 줄 자체가 검색에 걸리지 않게 나눠 적는다(걸려야 하는 건 머리 주석)
let turn = 0;
let toolNamesT1: string[] = [];
const outputs = new Map<string, string>();
let refFromSearch = "";
globalThis.fetch = fakeNetwork(async (_url, init) => {
  const body = JSON.parse(String(init?.body)) as { input: Item[]; tools?: Array<{ name?: string }> };
  const last = body.input[body.input.length - 1];
  const turnStartReq = last?.type === "message" && last.role === "user";
  if (turnStartReq) {
    turn += 1;
    if (turn === 1) toolNamesT1 = (body.tools ?? []).map((t) => t.name ?? "");
  } else if (last?.type === "function_call_output" && last.call_id !== undefined) {
    outputs.set(last.call_id, last.output ?? "");
    if (last.call_id === "call-T2") {
      try { refFromSearch = (JSON.parse(last.output ?? "{}") as { hits?: Array<{ ref?: string }> }).hits?.[0]?.ref ?? ""; } catch { /* 판정은 부모가 */ }
    }
  }
  const args =
    turn === 1 ? { name: "Read", arguments: JSON.stringify({ path: fileURLToPath(import.meta.url), limit: 6 }) }
    : turn === 2 ? { name: "read_past_tool_result", arguments: JSON.stringify({ query: MARK }) }
    : turn === 3 ? { name: "read_past_tool_result", arguments: JSON.stringify({ ref: refFromSearch }) }
    : turn === 4 ? { name: "read_past_tool_result", arguments: JSON.stringify({ ref: refFromSearch }) }
    : { name: "read_past_tool_result", arguments: JSON.stringify({ query: MARK }) };
  const call = { type: "function_call", id: `fc-${turn}`, call_id: `call-T${turn}`, ...args };
  const msg = { type: "message", id: `m-${turn}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: `답${turn}`, annotations: [] }] };
  const output = turnStartReq ? [call] : [msg];
  const events = output.flatMap((item, output_index) => [
    { type: "response.output_item.added", output_index, item },
    ...(item.type === "message" ? [{ type: "response.output_text.delta", delta: `답${turn}` }] : []),
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
// ★실제 채널처럼 세션 정규화를 거친다 — 그때 저장 채널(세션 정체성)이 입력 채널(텔레그램)과 **갈린다**. 정규화 없이 돌리면 둘이 같아
//  «도구가 어느 채널로 대화를 잡나» 를 못 본다(변이: 입력 채널로 잡아도 통과했다).
const base = { channel: "telegram" as const, channelUserId: "u", receivedAt: Date.now(), reply: async () => {} };
const say = (session: string, text: string) =>
  route({ ...base, threadKey: `tg:${session}`, text } as IncomingMessage, { session: { explicitSessionId: `dashboard:${session}` } });
let error = "";
try {
  for (const text of ["파일 읽어", "아까 그 표식 찾아", "그거 전문"]) await say("recall-live", text);
  await say("recall-other", "남의 참조 읽기");
  await say("recall-other", "남의 표식 찾기");
} catch (e) { error = e instanceof Error ? e.message : String(e); }

const parse = (s: string | undefined): Record<string, unknown> => { try { return JSON.parse(s ?? "{}") as Record<string, unknown>; } catch { return { raw: s }; } };
realLog("RECALL_RESULT " + JSON.stringify({
  turns: turn,
  t1HasTool: toolNamesT1.includes("read_past_tool_result"),
  t1ReadHasMark: (outputs.get("call-T1") ?? "").includes(MARK),
  search: parse(outputs.get("call-T2")),
  read: parse(outputs.get("call-T3")),
  otherRead: parse(outputs.get("call-T4")),
  otherSearch: parse(outputs.get("call-T5")),
  ref: refFromSearch,
  mark: MARK,
  error,
}));
process.exit(0);
