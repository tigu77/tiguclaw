/**
 * `openai-plugin-tool-cancel` 의 자식 — OpenAI 어댑터(`runOpenAi`) 턴 하나를 돌리며 플러그인 도구가 **그 턴의 취소 신호를 받는지** 낸다.
 * 모델 호출 0(회귀 모델 주입) · 네트워크 차단 · 실제 화면/입력 0.
 * - 플러그인 두 개: `regr-cancel-plug` 는 코어와 겹치는 이름(`read_memory`)이 있어 이름 선점 래퍼(`hideTakenTools`)를,
 *   `regr-cancel-plug2` 는 겹침이 없어 공유 브리지 그대로의 분기를 지난다. 인자 ② 로 어느 쪽 도구를 부를지 고른다.
 * - 도구 handler 는 MCP `extra.signal` 의 abort 를 기다린다(취소 모드 시한 5초 · 완료 모드 50ms 뒤 정상 반환).
 * 인자: ① `abort`(handler 시작 뒤 턴 취소) | `complete`(취소 없음) ② `wrapped` | `direct`.
 * 출력: 마지막 줄 JSON `{ mode, branch, started, handlerAborted, handlerMs, calls, sawDone, err? }`.
 */
process.env.OPENAI_API_KEY = "sk-regression-not-a-key";

import { mkdtempSync } from "node:fs";
import path from "node:path";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { assertIsolated } from "./_framework.js";

const mode = process.argv[2] === "abort" ? "abort" : "complete";
const branch = process.argv[3] === "wrapped" ? "wrapped" : "direct";
assertIsolated();
process.env.TIGUCLAW_HOME = mkdtempSync(path.join(process.env.TIGUCLAW_HOME!, "openai-plugin-cancel-"));
const { initStore } = await import("../../store/sessions.js");
initStore();
const cwd = process.env.TIGUCLAW_HOME;

let markStarted: () => void = () => {};
const started = new Promise<void>((r) => { markStarted = r; });
const rec: { started: boolean; handlerAborted?: boolean; handlerMs?: number; calls: number; sawDone: boolean } = { started: false, calls: 0, sawDone: false };
let markHandled: () => void = () => {};
const handled = new Promise<void>((r) => { markHandled = r; });
const waitTool = (name: string) =>
  tool(name, "취소 신호를 기다리는 회귀용 도구", {}, async (_a: unknown, extra: unknown) => {
    const signal = (extra as { signal?: AbortSignal } | undefined)?.signal;
    const t0 = Date.now();
    rec.started = true;
    markStarted();
    const aborted = await new Promise<boolean>((resolve) => {
      if (signal?.aborted === true) return resolve(true);
      signal?.addEventListener("abort", () => resolve(true), { once: true });
      setTimeout(() => resolve(false), mode === "abort" ? 5_000 : 50);
    });
    rec.handlerAborted = aborted;
    rec.handlerMs = Date.now() - t0;
    markHandled();
    return { content: [{ type: "text" as const, text: aborted ? "cancelled-regr" : "done-regr" }] };
  });
const toolName = branch === "wrapped" ? "regr_wait_wrapped" : "regr_wait_direct";
const plugins = {
  "regr-cancel-plug": createSdkMcpServer({
    name: "regr-cancel-plug",
    version: "1",
    tools: [
      waitTool("regr_wait_wrapped"),
      tool("read_memory", "코어와 겹치는 이름 — 선점 래퍼 분기를 만든다", {}, async () => ({ content: [{ type: "text" as const, text: "x" }] })),
    ],
  }),
  "regr-cancel-plug2": createSdkMcpServer({ name: "regr-cancel-plug2", version: "1", tools: [waitTool("regr_wait_direct")] }),
};

(globalThis as unknown as { fetch: unknown }).fetch = async () => { throw new Error("REGRESSION_NETWORK_BLOCKED"); };
const { injectRegressionModel } = await import("../../core/llm-runtime/regression-model-guard.js");
injectRegressionModel({
  getResponse: async () => { throw new Error("스트림만 쓴다"); },
  async *getStreamedResponse(req: { input?: unknown }) {
    rec.calls += 1;
    yield { type: "response_started" };
    if (rec.calls === 1) {
      yield { type: "response_done", response: { id: "r1", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, requests: 1 }, output: [{ type: "function_call", id: "fc1", callId: "c-wait", name: toolName, arguments: "{}", status: "completed" }] } };
      return;
    }
    rec.sawDone = JSON.stringify(req.input ?? "").includes("done-regr");
    yield { type: "output_text_delta", delta: "끝" };
    yield { type: "response_done", response: { id: "r2", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, requests: 1 }, output: [{ type: "message", id: "m", role: "assistant", status: "completed", content: [{ type: "output_text", text: "끝" }] }] } };
  },
});
const { runOpenAi } = await import("../../core/llm-runtime/adapters/openai-agents-sdk.js");

const ac = new AbortController();
let err: string | undefined;
const run = runOpenAi({
  text: "해줘", channel: "cli", cwd, threadKey: "dashboard:regr-plugin-cancel", extraMcpServers: plugins,
  model: "gpt-regression", provider: "openai", abortSignal: ac.signal,
} as never).catch((e: unknown) => { err = (e instanceof Error ? e.message : String(e)).slice(0, 300); });
if (mode === "abort") {
  await Promise.race([started, new Promise((r) => setTimeout(r, 10_000))]);
  ac.abort(new Error("regression: user stop"));
}
await run;
// 턴이 먼저 끝나도 handler 가 신호를 받았는지(또는 시한까지 돌았는지)를 본다.
await Promise.race([handled, new Promise((r) => setTimeout(r, 7_000))]);
console.log(JSON.stringify({ mode, branch, started: rec.started, handlerAborted: rec.handlerAborted, handlerMs: rec.handlerMs, calls: rec.calls, sawDone: rec.sawDone, ...(err !== undefined ? { err } : {}) }));
process.exit(0);
