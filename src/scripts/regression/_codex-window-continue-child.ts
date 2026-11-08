/** 실제 어댑터 + 실제 도구 + 합성 SSE. ordinary continue는 보고 왕복 없이 창만 옮긴다. */
import { mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assertIsolated, fakeNetwork, pinModelForTest } from "./_framework.js";
import type { RegionAActivityPayload } from "../../core/llm-runtime/types.js";
assertIsolated();
if (process.env.TIGUCLAW_DISABLE_ENV_FILE !== "1" || process.env.TIGUCLAW_REGRESSION_NO_LIVE_MODEL !== "1") throw new Error("isolated fake-network runner required");
pinModelForTest("codex:gpt-5.6-sol");
const mode = process.argv[2];
const total = mode === "total" ? 6 : mode === "reserved" ? 2 : mode === "one-slot" ? 1 : mode === "cap-reserved" ? 3 : 8;
process.env.CODEX_TOOL_SEARCH = "0";
process.env.CODEX_MAX_TOOL_ITERATIONS = "1";
process.env.CODEX_MAX_TOOL_ITERATIONS_HARD = "2";
process.env.CODEX_MAX_TOTAL_ITERATIONS = String(total);
const cwd = path.join(process.env.TIGUCLAW_HOME!, "work");
mkdirSync(cwd);
writeFileSync(path.join(cwd, "fixture.txt"), "synthetic window fixture");
const { initStore } = await import("../../store/sessions.js");
const { registerAuthProvider } = await import("../../core/llm-runtime/auth-registry.js");
const { getEventBus } = await import("../../core/eventbus.js");
initStore();
registerAuthProvider({ provider: "codex", getAccessToken: async () => "synthetic-token" });
const ac = new AbortController();
// workerDepth>0에서는 화면 text 이벤트가 없다. 창 이동 직후의 기존 로그를
// 관측해 취소하고, 다음 루프 진입 가드가 fetch보다 먼저 작동하는지 확인한다.
const warn = console.warn.bind(console);
console.warn = (...args: unknown[]) => {
  warn(...args);
  if (mode === "cancel" && String(args[0]).startsWith("[codex-tool-cap-continue]")) ac.abort(new Error("synthetic boundary cancellation"));
};
const activities: RegionAActivityPayload[] = [];
const unsubscribe = getEventBus().subscribe(event => {
  if (event.type !== "llm.activity") return;
  const p = event.payload as unknown as RegionAActivityPayload;
  activities.push(p);
});
const call = (id: string, name: string, args: Record<string, unknown>) => ({ type: "function_call", id: `fc_${id}`, call_id: id, name, arguments: JSON.stringify(args) });
const read = (id: string) => call(id, "Read", { path: "fixture.txt" });
// append는 같은 제안을 두 번 실행하면 내용이 두 줄이 되어 idempotent Write보다 강한 증거다.
const effect = (id: string) => {
  // Both POSIX echo and cmd echo: no switches/on/off, spaces, escapes or metacharacters.
  if (!/^(?:effect_[a-z0-9_]+|discarded)$/.test(id)) throw new Error("invalid synthetic effect id");
  return call(id, "Bash", { command: `echo ${id}>> effects.log`, timeout: 5 });
};
const reasoning = (id: string) => ({ type: "reasoning", id: `rs_${id}`, summary: [], encrypted_content: `synthetic-cipher-${id}` });
const msg = (text: string, phase = "final_answer") => ({ type: "message", id: "synthetic_message", role: "assistant", status: "completed", phase, content: [{ type: "output_text", text, annotations: [] }] });
type Body = { input: Array<Record<string, unknown>>; tools: unknown[]; reasoning?: unknown };
const requests: Body[] = [];
const script: string[] = [];
globalThis.fetch = fakeNetwork(async (_url, init) => {
  const body = JSON.parse(String(init?.body)) as Body;
  // 증거에는 필요한 replay 항목과 도구 수만 남긴다. 시스템 지침·초기 입력·도구 schema를
  // 매 요청 출력하면 pipe 종료 시 JSON이 잘리고 회귀 증거 자체가 무효가 된다.
  requests.push({ input: body.input.filter(x => x.type !== "message" || x.role === "assistant"), tools: body.tools.map(() => null), reasoning: body.reasoning });
  const n = requests.length;
  if (n > total + 1) throw new Error("unexpected extra request");
  let items: Array<{ type: string }>;
  if (body.tools.length === 0) {
    script.push("final-report");
    // final-slot 빈 답의 FINAL CHANCE 재시도는 제거 대상이 아니다.
    items = mode === "empty-final" && script.filter(x => x === "final-report").length === 1 ? [] : [msg("synthetic final report")];
  } else if (n === 1) {
    script.push("execute-first");
    items = [reasoning("first"), read("read_first"), effect("effect_first")];
  } else if (n === 2) {
    script.push("discard-boundary");
    items = [reasoning("discarded"), ...(mode === "cancel" ? [msg("boundary cancel", "commentary")] : []), effect("discarded"), read("discarded_read")];
  } else if (mode === "external") {
    script.push("external-return");
    items = [call("external", "synthetic_external", {})];
  } else if (mode === "total") {
    script.push(n === 4 ? "discard-boundary" : "execute-next");
    items = [reasoning(`step${n}`), read(`read_${n}`), effect(`effect_${n}`)];
  } else if (n === 3) {
    script.push("execute-next");
    items = [reasoning("next"), read("read_next"), effect("effect_next")];
  } else {
    script.push("natural-finish");
    items = [msg("synthetic natural finish")];
  }
  const events = [
    ...items.flatMap((item, output_index) => [
      { type: "response.output_item.added", output_index, item: item.type === "function_call" ? { ...item, arguments: "" } : item },
      ...(item.type === "message" ? [{ type: "response.output_text.delta", delta: (item as ReturnType<typeof msg>).content[0]!.text }] : []),
      { type: "response.output_item.done", output_index, item },
    ]),
    { type: "response.completed", response: { id: `synthetic_${n}`, status: "completed", output: [], usage: { input_tokens: 10, output_tokens: 2 } } },
  ];
  return new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(""));
});
const { runOpenAiCodex } = await import("../../core/llm-runtime/adapters/openai-codex-oauth.js");
let error = "";
let result;
try {
  result = await runOpenAiCodex({
    text: "합성 창 계속 검사", channel: "cli", threadKey: mode === "main" || mode === "empty-final" ? `regr:window:${mode}` : `worker:window-${mode}`,
    cwd, model: "gpt-5.6-sol", workerDepth: 1, abortSignal: ac.signal,
    ...(mode === "external" ? { externalTools: [{ name: "synthetic_external", parameters: { type: "object", properties: {} } }] } : {}),
  });
} catch (e) { error = String(e); }
unsubscribe();
console.log("WINDOW_RESULT " + JSON.stringify({ mode, total, requests, script, activities, error, text: result?.text, turnItems: result?.turnItems, external: result?.externalToolCalls, effects: existsSync(path.join(cwd, "effects.log")) ? readFileSync(path.join(cwd, "effects.log"), "utf8").trim().split(/\r?\n/) : [] }));
process.exit(0);
