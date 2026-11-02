/**
 * `job-notice` 의 자식 셋째 — **어댑터가 실제로 모델 요청에 `notify_owner` 를 싣는가** (2026-10-25 독립 변이 사냥 구멍 1).
 * 소스 문자열(팩토리 호출이 있나)로는 «등록 줄을 끄는» 변이가 살아남았다 — 그래서 각 어댑터의 **모델 경계에서** 본다:
 *  claude = 가짜 SDK(`withFakeClaudeQuery`)가 받은 `options.mcpServers` · codex = 가짜 네트워크가 받은 요청 본문의 도구 ·
 *  openai = 회귀 모델 주입(`injectRegressionModel`)이 받은 요청의 도구. 모델 호출·외부 송신 0.
 * 입력 둘: 실행 중인 작업자(매니저) 턴 → 있어야 · 메인 턴 → 없어야(2026-11-01 보류 해제 — 보류 때는 둘 다 없음이었다).
 *  «없음» 은 관측이 죽어도 초록이 되므로 **양성 대조**를 같이 낸다: 그 턴이 실제로 매니저/메인으로 조립됐는가(`role` — 매니저 =
 *  `agents`/`spawn_agent` 있고 `workers`/`run_in_background` 없음 · 메인 = 그 반대쪽이 있음).
 * claude 는 그 턴에 어댑터가 **실제로 만든** `find_capabilities` 서버를 호출해 출력에 이 도구가 활성으로 나오는지도 본다
 *  (보류 때 카탈로그 항목을 뺐다 — 서버 도구 설명에서 요약을 다시 만드는 경로가 실제로 도는지).
 * ★**한 프로세스에서 순서대로** 돈다(데몬과 같은 모양) — 종전엔 턴마다 별도 프로세스였다: OpenAI Agents SDK 가 MCP 도구 목록을 서버 이름으로
 *  전역 캐시해 매니저 턴 뒤 메인 턴이 `steer_worker` 중복으로 죽던 결함(2026-10-26 고침 — `openai-mcp-tools-per-turn`)을 피하려던 우회였다.
 * ★설정(2026-11-02 `jobs.notifyOwner.enabled`, 기본 꺼짐) — 순서에 `on`·`off` 를 끼우면 그 자리에서 임시 홈 설정 파일을 바꾼다(**재시작 없이** 다음 턴부터
 *  반영되는가). 처음엔 키가 없다(= 제품 기본). 서브 턴(`sub` — 실제 서브 입력 모양 `agent:`·`turnOrigin:"subagent"`·`subagentDepth:1`)도 같이 잰다(GPT 설계 R1 #3).
 * 출력: 마지막 줄 JSON 배열 `[{ which, on, has, role, calls, … }]`(턴 순서대로 — `on`/`off` 는 기록 안 함). 인자: 어댑터 이름 · 쉼표로 이은 순서(`worker`|`main`|`sub`|`on`|`off`).
 */
process.env.OPENAI_API_KEY = "sk-regression-not-a-key";
process.env.ANTHROPIC_API_KEY = "sk-ant-regression-not-a-key"; // 인증 판정 통과용(가짜 SDK 라 쓰이지 않는다)

import { mkdtempSync } from "node:fs";
import path from "node:path";
import { assertIsolated, fakeNetwork } from "./_framework.js";

const adapter = process.argv[2] as "claude" | "codex" | "openai";
const seq = (process.argv[3] ?? "").split(",") as Array<"worker" | "main" | "sub" | "on" | "off">;
assertIsolated();
process.env.TIGUCLAW_HOME = mkdtempSync(path.join(process.env.TIGUCLAW_HOME!, `job-notice-${adapter}-`));
const { initStore } = await import("../../store/sessions.js");
initStore();
const wj = await import("../../core/worker-jobs.js");
const W = wj.registerJob({ label: "작업자", task: "t", threadKey: "dashboard:regr-notice-ad", channel: "cli", channelUserId: "u", kind: "worker" } as never);
const A = wj.registerJob({ label: "서브", task: "t", threadKey: `worker:${W}`, channel: "cli", channelUserId: "u", kind: "agent" } as never);
const inputs = {
  worker: { text: "해줘", threadKey: `worker:${W}`, channel: "cli", cwd: process.env.TIGUCLAW_HOME, workerDepth: 1, turnOrigin: "worker" },
  main: { text: "해줘", threadKey: "dashboard:regr-notice-ad", channel: "cli", cwd: process.env.TIGUCLAW_HOME },
  sub: { text: "[Subagent Task]: 해줘", threadKey: `agent:${A}`, channel: "cli", cwd: process.env.TIGUCLAW_HOME, subagentDepth: 1, turnOrigin: "subagent" },
};
const { setNotifyOwnerEnabled, loadNotifyOwnerEnabled } = await import("../../core/settings.js");

/** 그 턴의 모델 요청에 실린 도구 이름(또는 서버 키)을 한 줄로 모은다 — 접힌 묶음(`namespace`) 안의 도구도 편다. */
let seen = "";
let calls = 0;
let fcOut: { none?: string; query?: string; noneErr?: boolean; queryErr?: boolean } | undefined;
let run: (input: unknown) => Promise<unknown>;
type T = { name?: string; tools?: T[] };
const flat = (ts: T[]): string[] => ts.flatMap((t) => [t.name ?? "", ...flat(t.tools ?? [])]);

if (adapter === "claude") {
  const { runClaude, withFakeClaudeQuery } = await import("../../core/llm-runtime/adapters/claude-agent-sdk.js");
  type ToolResult = { content: Array<{ text?: string }>; isError?: boolean };
  type Srv = { instance: { _registeredTools: Record<string, { handler: (a: unknown, e: unknown) => Promise<ToolResult> }> } };
  let fcap: Srv | undefined;
  const fake = ((args: { options: { mcpServers?: Record<string, unknown> } }) => {
    calls += 1;
    seen = Object.keys(args.options.mcpServers ?? {}).join(",");
    fcap = args.options.mcpServers?.["find-capabilities"] as Srv | undefined;
    return (async function* () {
      yield { type: "system", subtype: "init", session_id: "s", model: "claude-fake" };
      yield { type: "assistant", session_id: "s", parent_tool_use_id: null, message: { role: "assistant", model: "claude-fake", content: [{ type: "text", text: "끝" }] } };
      yield { type: "result", subtype: "success", is_error: false, result: "끝", num_turns: 1, session_id: "s", modelUsage: {}, usage: { input_tokens: 1, output_tokens: 1 } };
    })();
  }) as never;
  run = async (input) => {
    fcap = undefined;
    const r = await withFakeClaudeQuery(fake, () => runClaude(input as never));
    // 이 턴에 어댑터가 실제로 만든 `find_capabilities` — 매니저 턴의 활성 이름으로 조립된 그 인스턴스를 그대로 부른다.
    const cap = fcap as Srv | undefined; // 가짜 query 안에서 대입된다(클로저 — 타입 좁힘이 못 본다)
    if (cap !== undefined && (input as { workerDepth?: number }).workerDepth === 1) {
      const h = cap.instance._registeredTools.find_capabilities!.handler;
      const a = await h({}, {});
      const b = await h({ query: "notify 소환자 알림 owner" }, {});
      const txt = (x: ToolResult): string => x.content.map((c) => c.text ?? "").join("");
      fcOut = { none: txt(a), query: txt(b), noneErr: a.isError === true, queryErr: b.isError === true };
    }
    return r;
  };
} else if (adapter === "codex") {
  const enc = new TextEncoder();
  (globalThis as unknown as { fetch: unknown }).fetch = fakeNetwork(async (url: string, init: { body?: unknown }): Promise<Response> => {
    if (!String(url).includes("/responses")) return new Response("not found", { status: 404 });
    calls += 1;
    const raw = typeof init.body === "string" ? init.body : "";
    const body = raw !== "" ? (JSON.parse(raw) as { tools?: T[] }) : {};
    seen = flat(body.tools ?? []).join(",");
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
    async *getStreamedResponse(req: { tools?: T[] }) {
      calls += 1;
      seen = flat(req.tools ?? []).join(",");
      yield { type: "response_started" };
      yield { type: "output_text_delta", delta: "끝" };
      yield { type: "response_done", response: { id: "r", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, requests: 1 }, output: [{ type: "message", id: "m", role: "assistant", status: "completed", content: [{ type: "output_text", text: "끝" }] }] } };
    },
  });
  const { runOpenAi } = await import("../../core/llm-runtime/adapters/openai-agents-sdk.js");
  run = (input) => runOpenAi({ ...(input as object), model: "gpt-regression", provider: "openai" } as never);
}

const names = (s: string): string[] => s.split(",");
const has = (s: string): boolean => (adapter === "claude" ? names(s).includes("notify-owner") : names(s).some((n) => n === "notify_owner" || n.endsWith("notify_owner")));
/** 양성 대조 — 그 턴이 실제로 무엇으로 조립됐나(«없음» 단언이 공허하게 통과하지 않게). */
const roleOf = (s: string): string => {
  const ns = names(s);
  const [mgrKey, mainKey] = adapter === "claude" ? ["agents", "workers"] : ["spawn_agent", "run_in_background"];
  const mgr = ns.some((n) => n === mgrKey || n.endsWith(`__${mgrKey}`));
  const main = ns.some((n) => n === mainKey || n.endsWith(`__${mainKey}`));
  // 서브 = 매니저 도구도 메인 도구도 없는데 도구는 실렸다(서브는 자식을 못 띄운다 — depth 게이트).
  return mgr && !main ? "manager" : main ? "main" : ns.some((n) => n !== "") ? "sub" : "unknown";
};
type Out = { which: string; on: boolean; has: boolean; role: string; calls: number; err?: string; seen: string; ms: number; fc?: typeof fcOut };
const out: Out[] = [];
for (const which of seq) {
  if (which === "on" || which === "off") { setNotifyOwnerEnabled(which === "on"); continue; }
  seen = "";
  fcOut = undefined;
  const before = calls;
  let err: string | undefined;
  const t0 = Date.now();
  try {
    await run(inputs[which]);
  } catch (e) {
    err = (e instanceof Error ? e.message : String(e)).slice(0, 300);
  }
  const ms = Date.now() - t0;
  const rec: Out = { which, on: loadNotifyOwnerEnabled(), has: has(seen), role: roleOf(seen), calls: calls - before, ...(err !== undefined ? { err } : {}), seen: seen.slice(0, 1200), ms };
  if (fcOut !== undefined) rec.fc = fcOut;
  out.push(rec);
}
console.log(JSON.stringify(out));
process.exit(0);
