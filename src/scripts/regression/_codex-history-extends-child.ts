/**
 * 다음 턴 첫 요청이 **직전 턴 첫 요청의 연장**인지를 실제 경로(router → 퍼사드 → 어댑터 → 저장 → 다음 턴 조립)로 본다. 네트워크 0.
 * 부모: `codex-history-extends-previous-request.ts`.
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

type Body = { input: Array<Record<string, unknown>> };
const reqs: Array<{ turn: number; input: Body["input"] }> = [];
let turn = 0;
// 턴 1·3 은 도구를 한 번 부르고, 턴 2·4 는 바로 답한다 — 두 모양 모두에서 연장이어야 한다.
globalThis.fetch = fakeNetwork(async (_url, init) => {
  const body = JSON.parse(String(init?.body)) as Body;
  const last = body.input[body.input.length - 1] as { type?: string; role?: string };
  const start = last?.type === "message" && last.role === "user";
  if (start) turn += 1;
  reqs.push({ turn, input: body.input });
  const useTool = start && turn % 2 === 1;
  const call = { type: "function_call", id: `fc-${turn}`, call_id: `call-T${turn}`, name: "Read", arguments: JSON.stringify({ path: fileURLToPath(import.meta.url), limit: 3 }) };
  const msg = { type: "message", id: `m-${turn}`, role: "assistant", status: "completed", phase: "final_answer", content: [{ type: "output_text", text: `답 ${turn}`, annotations: [] }] };
  const output = useTool ? [call] : [msg];
  const events = output.flatMap((item, output_index) => [
    { type: "response.output_item.added", output_index, item },
    ...(item.type === "message" ? [{ type: "response.output_text.delta", delta: `답 ${turn}` }] : []),
    { type: "response.output_item.done", output_index, item },
  ]);
  return new Response(
    [...events, { type: "response.completed", response: { id: `r${turn}`, status: "completed", output: [], usage: { input_tokens: 10, output_tokens: 1 } } }]
      .map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""),
    { status: 200 },
  );
});
const realLog = console.log.bind(console);
console.log = () => {};
console.warn = () => {};

const { route } = await import("../../core/router.js");
const { loadThreadHistoryWithIds } = await import("../../store/memory.js");
const { getDb } = await import("../../store/sessions.js");
const base = { channel: "dashboard" as const, channelUserId: "u", reply: async () => {} };
let error = "";
try {
  for (const text of ["첫 질문", "둘째 질문", "셋째 질문", "넷째 질문"]) await route({ ...base, receivedAt: Date.now(), threadKey: "regr:history-extends", text } as IncomingMessage);
} catch (e) { error = e instanceof Error ? e.message : String(e); }

const J = (x: unknown) => JSON.stringify(x);
/** 다음 턴 첫 요청이 직전 턴 첫 요청을 통째로 앞머리에 두는가 — 아니면 처음 갈린 자리. */
const extensions = [2, 3, 4].map((t) => {
  const prev = reqs.find((r) => r.turn === t - 1)?.input ?? [];
  const cur = reqs.find((r) => r.turn === t)?.input ?? [];
  let i = 0;
  while (i < prev.length && i < cur.length && J(prev[i]) === J(cur[i])) i++;
  return { turn: t, prevLen: prev.length, matched: i };
});
// 기록은 발화 원문 그대로다 — 보낸 그대로는 따로 묶인다(요약·검색·다른 어댑터가 원문을 본다).
const idx = getDb().prepare(`SELECT DISTINCT channel, thread_key FROM transcript_index`).all() as Array<{ channel: string; thread_key: string }>;
const rows = idx.flatMap((r) => loadThreadHistoryWithIds(r.channel as "http-bridge", r.thread_key, { itemsAfter: 0 }));
const users = rows.filter((r) => r.role === "user");
realLog("EXTENDS_RESULT " + J({
  turns: turn,
  extensions,
  userContents: users.map((u) => u.content),
  sentHasScaffold: users.map((u) => (u.sent ?? "").includes("<system-reminder>")),
  error,
}));
process.exit(0);
