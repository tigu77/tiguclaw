/**
 * `job-notice` 의 자식 셋째 — **어댑터가 실제로 모델 요청에 `notify_owner` 를 싣는가** (2026-10-25 독립 변이 사냥 구멍 1).
 * 소스 문자열(팩토리 호출이 있나)로는 «등록 줄을 끄는» 변이가 살아남았다 — 그래서 각 어댑터의 **모델 경계에서** 본다:
 *  claude = 가짜 SDK(`withFakeClaudeQuery`)가 받은 `options.mcpServers` · codex = 가짜 네트워크가 받은 요청 본문의 도구 ·
 *  openai = 회귀 모델 주입(`injectRegressionModel`)이 받은 요청의 도구. 모델 호출·외부 송신 0.
 * 입력 둘: 실행 중인 작업자(매니저) 턴 → 있어야 · 메인 턴 → 없어야.
 * ★**한 프로세스에서 순서대로** 돈다(데몬과 같은 모양) — 종전엔 턴마다 별도 프로세스였다: OpenAI Agents SDK 가 MCP 도구 목록을 서버 이름으로
 *  전역 캐시해 매니저 턴 뒤 메인 턴이 `steer_worker` 중복으로 죽던 결함(2026-10-26 고침 — `openai-mcp-tools-per-turn`)을 피하려던 우회였다.
 * 출력: 마지막 줄 JSON 배열 `[{ which, has, calls }]`(턴 순서대로). 인자: 어댑터 이름 · 쉼표로 이은 턴 순서(`worker`|`main`).
 */
process.env.OPENAI_API_KEY = "sk-regression-not-a-key";
process.env.ANTHROPIC_API_KEY = "sk-ant-regression-not-a-key"; // 인증 판정 통과용(가짜 SDK 라 쓰이지 않는다)

import { mkdtempSync } from "node:fs";
import path from "node:path";
import { assertIsolated, fakeNetwork } from "./_framework.js";

const adapter = process.argv[2] as "claude" | "codex" | "openai";
const seq = (process.argv[3] ?? "").split(",") as Array<"worker" | "main">;
assertIsolated();
process.env.TIGUCLAW_HOME = mkdtempSync(path.join(process.env.TIGUCLAW_HOME!, `job-notice-${adapter}-`));
const { initStore } = await import("../../store/sessions.js");
initStore();
const wj = await import("../../core/worker-jobs.js");
const W = wj.registerJob({ label: "작업자", task: "t", threadKey: "dashboard:regr-notice-ad", channel: "cli", channelUserId: "u", kind: "worker" } as never);
const inputs = {
  worker: { text: "해줘", threadKey: `worker:${W}`, channel: "cli", cwd: process.env.TIGUCLAW_HOME, workerDepth: 1, turnOrigin: "worker" },
  main: { text: "해줘", threadKey: "dashboard:regr-notice-ad", channel: "cli", cwd: process.env.TIGUCLAW_HOME },
};
/** 그 턴의 모델 요청에 실린 도구 이름(또는 서버 키)을 한 줄로 모은다. */
let seen = "";
let calls = 0;
let run: (input: unknown) => Promise<unknown>;

if (adapter === "claude") {
  const { runClaude, withFakeClaudeQuery } = await import("../../core/llm-runtime/adapters/claude-agent-sdk.js");
  const fake = ((args: { options: { mcpServers?: Record<string, unknown> } }) => {
    calls += 1;
    seen = Object.keys(args.options.mcpServers ?? {}).join(",");
    return (async function* () {
      yield { type: "system", subtype: "init", session_id: "s", model: "claude-fake" };
      yield { type: "assistant", session_id: "s", parent_tool_use_id: null, message: { role: "assistant", model: "claude-fake", content: [{ type: "text", text: "끝" }] } };
      yield { type: "result", subtype: "success", is_error: false, result: "끝", num_turns: 1, session_id: "s", modelUsage: {}, usage: { input_tokens: 1, output_tokens: 1 } };
    })();
  }) as never;
  run = (input) => withFakeClaudeQuery(fake, () => runClaude(input as never));
} else if (adapter === "codex") {
  const enc = new TextEncoder();
  (globalThis as unknown as { fetch: unknown }).fetch = fakeNetwork(async (url: string, init: { body?: unknown }): Promise<Response> => {
    if (!String(url).includes("/responses")) return new Response("not found", { status: 404 });
    calls += 1;
    const body = typeof init.body === "string" ? (JSON.parse(init.body) as { tools?: Array<{ name?: string }> }) : {};
    seen = (body.tools ?? []).map((t) => t.name ?? "").join(",");
    return new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          const send = (e: unknown) => c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
          send({ type: "response.output_text.delta", delta: "끝" });
          send({ type: "response.output_item.done", item: { type: "message", id: "m1", role: "assistant", content: [{ type: "output_text", text: "끝" }] } });
          send({ type: "response.completed", response: { id: "r1", usage: { input_tokens: 10, output_tokens: 5 } } });
          c.close();
        },
      }),
      { status: 200 },
    );
  });
  const { registerAuthProvider } = await import("../../core/llm-runtime/auth-registry.js");
  registerAuthProvider({ provider: "codex", getAccessToken: async () => "regression-fake-token" });
  const { runOpenAiCodex } = await import("../../core/llm-runtime/adapters/openai-codex-oauth.js");
  run = (input) => runOpenAiCodex(input as never);
} else {
  (globalThis as unknown as { fetch: unknown }).fetch = async () => { throw new Error("REGRESSION_NETWORK_BLOCKED"); };
  const { injectRegressionModel } = await import("../../core/llm-runtime/regression-model-guard.js");
  injectRegressionModel({
    getResponse: async () => { throw new Error("스트림만 쓴다"); },
    async *getStreamedResponse(req: { tools?: Array<{ name?: string }> }) {
      calls += 1;
      seen = (req.tools ?? []).map((t) => t.name ?? "").join(",");
      yield { type: "response_started" };
      yield { type: "output_text_delta", delta: "끝" };
      yield { type: "response_done", response: { id: "r", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, requests: 1 }, output: [{ type: "message", id: "m", role: "assistant", status: "completed", content: [{ type: "output_text", text: "끝" }] }] } };
    },
  });
  const { runOpenAi } = await import("../../core/llm-runtime/adapters/openai-agents-sdk.js");
  run = (input) => runOpenAi({ ...(input as object), model: "gpt-regression", provider: "openai" } as never);
}

const has = (s: string): boolean => (adapter === "claude" ? s.split(",").includes("notify-owner") : s.split(",").some((n) => n === "notify_owner" || n.endsWith("notify_owner")));
const out: Array<{ which: string; has: boolean; calls: number; err?: string; seen: string }> = [];
for (const which of seq) {
  seen = "";
  const before = calls;
  let err: string | undefined;
  try {
    await run(inputs[which]);
  } catch (e) {
    err = (e instanceof Error ? e.message : String(e)).slice(0, 300);
  }
  out.push({ which, has: has(seen), calls: calls - before, ...(err !== undefined ? { err } : {}), seen: seen.slice(0, 400) });
}
console.log(JSON.stringify(out));
process.exit(0);
