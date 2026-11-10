// Actual adapter request count: structured rejections must not enter transport retry or whole-turn replay.
import { runOpenAiCodex } from "../../core/llm-runtime/adapters/openai-codex-oauth.js";
import { registerAuthProvider } from "../../core/llm-runtime/auth-registry.js";
import { initStore } from "../../store/sessions.js";
import { fakeNetwork } from "./_framework.js";
import type { RegionASdkInput } from "../../core/llm-runtime/types.js";
import { createReplayGuard, canReplay } from "../../core/llm-runtime/replay-safety.js";
initStore();
registerAuthProvider({ provider: "codex", getAccessToken: async () => "fixture-token" });
const source = process.argv[2] ?? "error";
const code = process.argv[3] ?? "policy_violation";
let calls = 0;
const sse = (events: unknown[]) => new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
globalThis.fetch = fakeNetwork(async () => {
  calls++;
  if (calls > 1) return sse([{ type: "response.output_text.delta", delta: "unexpected replay" }, { type: "response.completed", response: {} }]);
  const error = code.startsWith("type:") ? { type: code.slice(5), code: null, message: "fixture rejection" } : { code, message: "fixture rejection" };
  return sse([source === "error" ? { type: source, error } : { type: source, response: { error } }]);
});
const guard = createReplayGuard();
try {
  await runOpenAiCodex({ text: "fixture", threadKey: "worker:policy-probe", channel: "cli", history: [], memoryContext: "", subagentDepth: 1, workerDepth: 1, replay: guard, __skipAutoCompaction: true } as RegionASdkInput);
  console.log(JSON.stringify({ outcome: "returned", calls, blocked: !canReplay(guard) }));
} catch (e) { console.log(JSON.stringify({ outcome: "threw", calls, blocked: !canReplay(guard), error: String(e) })); }
process.exit(0);
