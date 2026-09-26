import { initStore } from "../../store/sessions.js";
import { registerAuthProvider } from "../../core/llm-runtime/auth-registry.js";
import { assertIsolated, fakeNetwork } from "./_framework.js";
import { startDetachedAgent } from "../../core/llm-runtime/capabilities/agent-registry.js";
import { registerJob, createJobAbort, getJob, setJobResultChannel } from "../../core/worker-jobs.js";
import { createSteeringChannel } from "../../core/steering.js";
import { getEventBus } from "../../core/eventbus.js";
assertIsolated();
initStore();
registerAuthProvider({ provider: "codex", getAccessToken: async () => "fake-test-token" });
const warnings: string[] = [];
const warn = console.warn;
console.warn = (...args) => { warnings.push(args.map(String).join(" ")); };
let searches = true;
let requests = 0;
globalThis.fetch = fakeNetwork(async () => {
  requests++;
  const events = searches ? [
    { type: "response.web_search_call.in_progress", item_id: "ws_test", output_index: 0 },
    { type: "response.web_search_call.searching", item_id: "ws_test", output_index: 0 },
    { type: "response.web_search_call.completed", item_id: "ws_test", output_index: 0 },
    { type: "response.web_search_call.completed", item_id: "ws_test", output_index: 0 },
  ] : [];
  return new Response([...events,
    { type: "response.output_text.delta", delta: "검색했다고 주장하는 합성 답변 https://example.com" },
    { type: "response.completed", response: { id: "resp_test", status: "completed", usage: { input_tokens: 10, output_tokens: 2 } } },
  ].map(e => `data: ${JSON.stringify(e)}\n\n`).join(""));
});
const { runOpenAiCodex } = await import("../../core/llm-runtime/adapters/openai-codex-oauth.js");
const outcomes = [];
// 어댑터가 실제로 발행한 웹 검색 활동 — 대시보드는 같은 seq 의 끝(durationMs)이 와야 «실행 중» 을 끈다.
const searchActivity: { threadKey: unknown; seq: unknown; phase: unknown; durationMs: unknown }[] = [];
getEventBus().subscribe((ev) => {
  if (ev.type !== "llm.activity" || ev.payload?.label !== "web_search") return;
  const p = ev.payload as Record<string, unknown>;
  searchActivity.push({ threadKey: p.threadKey, seq: p.seq, phase: p.phase, durationMs: p.durationMs });
});
for (const enabled of [true, false]) {
  searches = enabled;
  const parent = registerJob({ kind: "worker", channel: "dashboard", channelUserId: "u", task: "test", label: "parent", threadKey: "dashboard:test" });
  setJobResultChannel(parent, createSteeringChannel());
  const child = registerJob({ kind: "agent", channel: "dashboard", channelUserId: "u", task: "test", label: "child", threadKey: `worker:${parent}`, detached: true });
  const before = warnings.length;
  startDetachedAgent({ jobId: child,
    agent: { name: "probe", description: "test", filePath: "/tmp/probe.md", source: "user" },
    def: "test", prompt: "https://example.com 을 검색해 주세요", targetCwd: process.cwd(),
    parentInput: { text: "test", channel: "dashboard", threadKey: `worker:${parent}` },
    abort: createJobAbort(child, {}),
    __runForTest: input => runOpenAiCodex({ ...input, model: "gpt-6-sol", reasoning: "low" }),
  });
  const deadline = Date.now() + 15000;
  while (getJob(child)?.status === "running" && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
  outcomes.push({ searches: enabled, status: getJob(child)?.status, warned: warnings.slice(before).some(x => x.includes("[agent-no-tools]")) });
}
console.warn = warn;
console.log("SEARCH_RESULT " + JSON.stringify({ requests, outcomes, searchActivity }));
process.exit(0);
