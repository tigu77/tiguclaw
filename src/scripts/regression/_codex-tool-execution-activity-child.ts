/** 실제 Codex 어댑터 + 가짜 SSE/auth. Read 는 이 자식의 합성 파일만 읽는다. */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assertIsolated, fakeNetwork, pinModelForTest } from "./_framework.js";
import type { RegionAActivityPayload } from "../../core/llm-runtime/types.js";
assertIsolated();
if (process.env.TIGUCLAW_DISABLE_ENV_FILE !== "1" || process.env.TIGUCLAW_REGRESSION_NO_LIVE_MODEL !== "1") {
  throw new Error("Codex 활동 검사는 env 파일과 실모델을 차단한 러너에서만 실행한다");
}
pinModelForTest("codex:gpt-5.6-sol");
const mode = process.argv[2];
const cwd = path.join(process.env.TIGUCLAW_HOME!, "work");
mkdirSync(cwd);
writeFileSync(path.join(cwd, "fixture.txt"), "synthetic activity fixture");
process.env.CODEX_TOOL_SEARCH = "0";
process.env.CODEX_MAX_TOOL_ITERATIONS = "1";
process.env.CODEX_MAX_TOOL_ITERATIONS_HARD = mode === "cap" ? "2" : "8";
process.env.CODEX_MAX_TOTAL_ITERATIONS = "8";
if (mode === "hook-block") {
  // 기존 hooks-actually-run fixture 의 exit 2 계약. 합성 자식 홈의 Read 만 거절한다.
  const settingsPath = path.join(process.env.TIGUCLAW_HOME!, "settings.json");
  const { readFileSync } = await import("node:fs");
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  settings.hooks = { PreToolUse: [{ matcher: "^Read$", hooks: [{ type: "command", command: "exit 2" }] }] };
  writeFileSync(settingsPath, JSON.stringify(settings));
}
const { initStore } = await import("../../store/sessions.js");
const { registerAuthProvider } = await import("../../core/llm-runtime/auth-registry.js");
const { getEventBus } = await import("../../core/eventbus.js");
initStore();
registerAuthProvider({ provider: "codex", getAccessToken: async () => "regression-fake-token" });
const ac = new AbortController();
const activities: RegionAActivityPayload[] = [];
const unsubscribe = getEventBus().subscribe(event => {
  if (event.type !== "llm.activity") return;
  const p = event.payload as unknown as RegionAActivityPayload;
  activities.push(p);
  if ((mode === "before-batch" && p.kind === "text") ||
      (mode === "parallel-cancel" && p.kind === "tool" && p.phase !== "end")) {
    ac.abort(new Error("synthetic cancellation"));
  }
});
const call = (id: string, name = "Read", args = JSON.stringify({ path: "fixture.txt" })) => ({
  type: "response.output_item.done", item: { type: "function_call", id: `fc_${id}`, call_id: id, name, arguments: args },
});
let requests = 0;
const outputs: Array<{ call_id: string; output: string }> = [];
globalThis.fetch = fakeNetwork(async (_url, init) => {
  const body = JSON.parse(String(init?.body)) as { input: Array<{ type?: string; call_id: string; output: string }> };
  outputs.push(...body.input.filter(item => item.type === "function_call_output"));
  requests++;
  const first = requests === 1;
  const events: unknown[] = first
    ? mode === "errors"
      ? [call("ok"), call("json", "Read", "{"), call("unknown", "NotRegistered"), call("missing", "Read", JSON.stringify({ path: "missing.txt" }))]
      : mode === "passthrough"
        ? [call("external", "synthetic_external", "{}")]
        : [call("first"), ...(mode === "parallel-cancel" || mode === "before-batch" ? [call("second")] : [])]
    : mode === "cap" && requests === 2 ? [call("discarded")] : [];
  if (mode === "before-batch" && first) events.unshift({ type: "response.output_text.delta", delta: "synthetic pre-tool text" });
  if (!events.length) events.push({ type: "response.output_text.delta", delta: "synthetic done" });
  events.push({ type: "response.completed", response: { id: `synthetic_${requests}`, status: "completed", usage: { input_tokens: 10, output_tokens: 2 } } });
  // 기존 _adapter-contract-child 와 같은 added → done SSE 계약.
  const framed = events.flatMap(event => {
    const e = event as { type?: string; item?: { type?: string } };
    return e.type === "response.output_item.done" && e.item?.type === "function_call"
      ? [{ ...e, type: "response.output_item.added", item: { ...e.item, arguments: "" } }, e]
      : [e];
  });
  return new Response(framed.map(e => `data: ${JSON.stringify(e)}\n\n`).join(""));
});
const { runOpenAiCodex } = await import("../../core/llm-runtime/adapters/openai-codex-oauth.js");
let error = "";
let result;
try {
  result = await runOpenAiCodex({
    text: "합성 도구 활동 검사", channel: "cli", threadKey: `regr:tool-execution:${mode}`,
    cwd, model: "gpt-5.6-sol", abortSignal: ac.signal,
    // softcap 은 통과하고 hardcap 에서 batch 를 버리는 경로.
    ...(mode === "cap" ? { workerDepth: 1 } : {}),
    ...(mode === "passthrough" ? { externalTools: [{ name: "synthetic_external", parameters: { type: "object", properties: {} } }] } : {}),
  });
} catch (e) { error = String(e); }
// Promise.all 의 다른 콜백이 취소로 먼저 거절돼도 이미 진입한 호출의 end 를 확인한다.
const deadline = Date.now() + 2_000;
while (activities.filter(a => a.kind === "tool" && a.phase !== "end").length > activities.filter(a => a.kind === "tool" && a.phase === "end").length && Date.now() < deadline) {
  await new Promise(resolve => setTimeout(resolve, 10));
}
unsubscribe();
console.log("TOOL_ACTIVITY_RESULT " + JSON.stringify({ mode, requests, activities, outputs, error, external: result?.externalToolCalls }));
process.exit(0);
