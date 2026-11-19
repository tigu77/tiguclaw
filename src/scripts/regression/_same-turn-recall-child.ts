/**
 * `tool-output-same-turn-recall` 의 자식 — **긴 도구 결과의 가운데를 같은 턴에 회수**하는 실경로(router → Codex 어댑터 → 가짜 공급자).
 * 네트워크·실모델 0. 출력: 마지막 줄 `SAME_TURN_RESULT <json>`.
 *
 * 1턴(대화 A): Read 로 큰 파일(가운데 표식) → 모델 입력엔 앞·뒤 보기 + 안내(실행 참조·offset) → 파일을 바꾼다(재실행이면 바뀐 값이 나온다)
 *   → 안내의 참조·offset 으로 read_past_tool_result 를 끝까지 이어 부른다.
 * 2턴(대화 A): 다음 턴 요청에 되살아난 그 결과가 1턴 보기와 같은 글인지 · 같은 실행 참조로 저장본을 읽는다.
 * 3턴(대화 B): A 의 실행 참조 → 거절 · 4턴(A, /clear 뒤): A 의 실행 참조 → 거절 · 5턴(A): 기록되지 않은 실행 참조 → 거절.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { initStore } from "../../store/sessions.js";
import { registerAuthProvider } from "../../core/llm-runtime/auth-registry.js";
import type { IncomingMessage } from "../../channels/types.js";
import { assertIsolated, fakeNetwork, pinModelForTest } from "./_framework.js";
assertIsolated();
pinModelForTest("codex:gpt-5.6-sol");
initStore();
registerAuthProvider({ provider: "codex", getAccessToken: async () => "regression-fake-token" });

const dir = mkdtempSync(path.join(process.env.TIGUCLAW_HOME!, "same-turn-"));
const file = path.join(dir, "big.txt");
const SENT = "MID-SENTINEL-" + "4242";
const SECRET = "sk-proj-" + "SAMETURNSECRETABCDEFGHIJKLMNOP99";
const lines = Array.from({ length: 420 }, (_, i) =>
  i === 210 ? `가운데 ${SENT} 비밀 ${SECRET} "따옴표" \\역슬래시\\ 끝`
  : `줄${String(i).padStart(3, "0")} ${"본문내용abc".repeat(9)}`);
writeFileSync(file, lines.join("\n"));

type Item = { type?: string; role?: string; call_id?: string; output?: string; name?: string; content?: Array<{ text?: string }> };
const state = {
  stage: "" as string,
  visible: "" as string, // 1턴 모델 입력에 실린 Read 결과
  ref: "" as string,
  offset0: -1,
  pages: [] as string[], // 재조회 응답 원문(JSON)
  turn2Replayed: undefined as string | undefined,
  turn2Read: "" as string,
  otherRead: "" as string,
  clearedRead: "" as string,
  unknownRead: "" as string,
  readCalls: 0,
  toolNames: [] as string[],
};
let callSeq = 0;
const sse = (items: unknown[], text?: string): Response => {
  const events = [
    ...items.flatMap((item, output_index) => [
      { type: "response.output_item.added", output_index, item },
      { type: "response.output_item.done", output_index, item },
    ]),
    ...(text !== undefined ? [{ type: "response.output_text.delta", delta: text }] : []),
    { type: "response.completed", response: { id: `r${++callSeq}`, status: "completed", output: [], usage: { input_tokens: 10, output_tokens: 1 } } },
  ];
  return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), { status: 200 });
};
const call = (name: string, args: unknown): Response => {
  const id = `call-${++callSeq}`;
  if (name === "Read") state.readCalls += 1;
  return sse([{ type: "function_call", id: `fc-${id}`, call_id: id, name, arguments: JSON.stringify(args) }]);
};
const done = (t: string): Response => sse([{ type: "message", id: `m${++callSeq}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: t, annotations: [] }] }], t);
const userText = (it: Item | undefined): string => (it?.content ?? []).map((c) => c.text ?? "").join("");

globalThis.fetch = fakeNetwork(async (_url, init) => {
  const body = JSON.parse(String(init?.body)) as { input: Item[]; tools?: Array<{ name?: string }> };
  const last = body.input[body.input.length - 1];
  if (last?.type === "message" && last.role === "user") {
    const t = userText(last);
    if (t.includes("STAGE-1")) {
      state.stage = "1";
      state.toolNames = (body.tools ?? []).map((x) => x.name ?? "");
      return call("Read", { path: file });
    }
    if (t.includes("STAGE-2")) {
      state.stage = "2";
      // 다음 턴: 되살아난 1턴 Read 결과(같은 글이어야 한다)
      const outs = body.input.filter((x) => x.type === "function_call_output").map((x) => x.output ?? "");
      state.turn2Replayed = outs.find((o) => o.includes("…[중략"));
      return call("read_past_tool_result", { ref: state.ref, offset: state.offset0 });
    }
    if (t.includes("STAGE-OTHER")) { state.stage = "other"; return call("read_past_tool_result", { ref: state.ref }); }
    if (t.includes("STAGE-CLEARED")) { state.stage = "cleared"; return call("read_past_tool_result", { ref: state.ref }); }
    if (t.includes("STAGE-UNKNOWN")) { state.stage = "unknown"; return call("read_past_tool_result", { ref: "rzzzzzzzz.1" }); }
    return done("?");
  }
  if (last?.type === "function_call_output") {
    const out = last.output ?? "";
    if (state.stage === "1" && state.visible === "") {
      state.visible = out;
      const m = /"ref":"(r[0-9a-z]{8}\.\d+)","offset":(\d+)/.exec(out);
      state.ref = m?.[1] ?? "";
      state.offset0 = m === null ? -1 : Number(m[2]);
      // ★원 도구를 다시 실행하면 바뀐 값이 나온다 — 재조회는 당시 결과(보존본)를 돌려줘야 한다.
      writeFileSync(file, lines.map((l) => l.replace(SENT, "CHANGED-AFTER")).join("\n"));
      if (state.ref === "") return done("참조 없음");
      return call("read_past_tool_result", { ref: state.ref, offset: state.offset0 });
    }
    if (state.stage === "1") {
      state.pages.push(out);
      const p = JSON.parse(out) as { nextOffset?: number; eof?: boolean };
      if (p.eof === true || p.nextOffset === undefined || state.pages.length > 20) return done("끝까지 읽었습니다");
      return call("read_past_tool_result", { ref: state.ref, offset: p.nextOffset });
    }
    if (state.stage === "2") { state.turn2Read = out; return done("다음 턴도 읽었습니다"); }
    if (state.stage === "other") { state.otherRead = out; return done("."); }
    if (state.stage === "cleared") { state.clearedRead = out; return done("."); }
    if (state.stage === "unknown") { state.unknownRead = out; return done("."); }
  }
  return done(".");
});
console.log = () => {};
console.warn = () => {};

const { route } = await import("../../core/router.js");
const { resetThreadContext } = await import("../../store/thread-reset.js");
const { getDb } = await import("../../store/sessions.js");
const base = { channel: "telegram" as const, channelUserId: "u", receivedAt: Date.now(), reply: async () => {} };
const say = (session: string, text: string) =>
  route({ ...base, threadKey: `tg:${session}`, text } as IncomingMessage, { session: { explicitSessionId: `dashboard:${session}` } });
let error = "";
let stored: { ref?: string; output?: string } | undefined;
try {
  await say("same-a", "STAGE-1 큰 파일 읽어");
  const row = getDb().prepare(`SELECT item FROM turn_items WHERE item LIKE '{"type":"function_call_output","ref":%' ORDER BY rowid DESC LIMIT 1`).get() as { item: string } | undefined;
  stored = row === undefined ? undefined : JSON.parse(row.item) as { ref?: string; output?: string };
  await say("same-a", "STAGE-2 이어서");
  await say("same-b", "STAGE-OTHER 남의 참조");
  resetThreadContext("http-bridge", "dashboard:same-a");
  await new Promise((r) => setTimeout(r, 5));
  await say("same-a", "STAGE-CLEARED 지운 뒤");
  await say("same-a", "STAGE-UNKNOWN 모르는 참조");
} catch (e) { error = e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e); }

// ★큰 한 줄 — `process.exit` 가 파이프 쓰기를 자르지 않게 다 쓴 뒤 끝낸다.
process.stdout.write("SAME_TURN_RESULT " + JSON.stringify({
  ...state,
  sentinel: SENT,
  secret: SECRET,
  stored: stored === undefined ? null : { ref: stored.ref, chars: stored.output?.length, hasSecret: stored.output?.includes(SECRET), hasSent: stored.output?.includes(SENT) },
  error,
}) + "\n", () => process.exit(0));
