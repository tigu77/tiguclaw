/**
 * `read-card-path-actions` 의 자식 — **세 어댑터가 Read 스텝에 그 Read 를 실제로 푼 기준의 절대 경로를 싣나**(2026-11-05,
 * `docs/decisions/2026-11-05-read-card-path-actions.md` 검증 계획 — 아스트라 R1-3).
 *
 * 모델 경계만 가짜다(claude = 가짜 SDK `withFakeClaudeQuery` · codex = 가짜 네트워크 · openai = 회귀 모델 주입 — `_notice-report-adapters-child.ts` 관용구).
 *  모델 호출·외부 송신 0. 모델이 **상대 경로** Read 를 부르고, 홈과 프로젝트에 같은 이름·다른 내용의 파일을 둔다.
 *   home — `input.cwd` 없음(메인 대화 모양): 기준 = 홈
 *   proj — `input.cwd` = 프로젝트 폴더
 * codex·openai 는 file-ops 가 **실제로 읽는다** — 출력이 어느 파일의 내용인지로 «표시한 경로 = 읽은 파일» 을 대조한다.
 * claude 는 SDK 네이티브 Read 라 가짜 SDK 에선 실행되지 않는다 — 실린 경로만 본다(SDK 는 같은 `cwd` 를 options.cwd 로 받는다).
 * 출력: 마지막 줄 JSON 배열 `[{ scenario, file, outText, err? }]`.
 */
process.env.OPENAI_API_KEY = "sk-regression-not-a-key";
process.env.ANTHROPIC_API_KEY = "sk-ant-regression-not-a-key"; // 인증 판정 통과용(가짜 SDK 라 쓰이지 않는다)

import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assertIsolated, fakeNetwork } from "./_framework.js";

type Scenario = "home" | "proj";
const adapter = process.argv[2] as "claude" | "codex" | "openai";
assertIsolated();
const HOME = realpathSync(mkdtempSync(path.join(process.env.TIGUCLAW_HOME!, `read-ref-${adapter}-`)));
process.env.TIGUCLAW_HOME = HOME;
const PROJ = path.join(HOME, "proj");
mkdirSync(path.join(HOME, "notes"), { recursive: true });
mkdirSync(path.join(PROJ, "notes"), { recursive: true });
writeFileSync(path.join(HOME, "notes", "a.txt"), "HOME-MARK-1\nHOME-MARK-2\n");
writeFileSync(path.join(PROJ, "notes", "a.txt"), "PROJ-MARK-1\nPROJ-MARK-2\n");
const { initStore } = await import("../../store/sessions.js");
initStore();
const { getEventBus } = await import("../../core/eventbus.js");

const TK = "dashboard:regr-read-ref";
const REL = "notes/a.txt";
const ARGS = adapter === "claude" ? { file_path: REL, offset: 2 } : { path: REL, offset: 2 };
let file: unknown;
let outText = "";
getEventBus().subscribe((ev) => {
  if (ev.type !== "llm.activity") return;
  const p = ev.payload as { threadKey?: string; kind?: string; label?: string; phase?: string; file?: unknown; output?: { text?: string } };
  if (p?.threadKey !== TK || p.kind !== "tool" || p.label !== "Read") return;
  if (p.phase === "end") outText = String(p.output?.text ?? "");
  else file = p.file ?? null;
});

let run: (input: Record<string, unknown>) => Promise<unknown>;
if (adapter === "claude") {
  const { runClaude, withFakeClaudeQuery } = await import("../../core/llm-runtime/adapters/claude-agent-sdk.js");
  const fake = (() =>
    (async function* () {
      yield { type: "system", subtype: "init", session_id: "s", model: "claude-fake" };
      yield { type: "assistant", session_id: "s", parent_tool_use_id: null, message: { role: "assistant", model: "claude-fake", content: [{ type: "tool_use", id: "tu1", name: "Read", input: ARGS }] } };
      yield { type: "assistant", session_id: "s", parent_tool_use_id: null, message: { role: "assistant", model: "claude-fake", content: [{ type: "text", text: "읽었습니다" }] } };
      yield { type: "result", subtype: "success", is_error: false, result: "읽었습니다", num_turns: 1, session_id: "s", modelUsage: {}, usage: { input_tokens: 1, output_tokens: 1 } };
    })()) as never;
  run = (input) => withFakeClaudeQuery(fake, () => runClaude(input as never)) as never;
} else if (adapter === "codex") {
  const enc = new TextEncoder();
  let req = 0;
  (globalThis as unknown as { fetch: unknown }).fetch = fakeNetwork(async (url: string): Promise<Response> => {
    if (!String(url).includes("/responses")) return new Response("not found", { status: 404 });
    req += 1;
    return new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          const send = (e: unknown) => c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
          if (req === 1) {
            const a = JSON.stringify(ARGS);
            send({ type: "response.output_item.added", item: { type: "function_call", id: "fc1", call_id: "c1", name: "Read" } });
            send({ type: "response.function_call_arguments.delta", delta: a });
            send({ type: "response.output_item.done", item: { type: "function_call", id: "fc1", call_id: "c1", name: "Read", arguments: a } });
          } else {
            send({ type: "response.output_text.delta", delta: "읽었습니다" });
            send({ type: "response.output_item.done", item: { type: "message", id: `m${req}`, role: "assistant", content: [{ type: "output_text", text: "읽었습니다" }] } });
          }
          send({ type: "response.completed", response: { id: `r${req}`, usage: { input_tokens: 10, output_tokens: 5 } } });
          c.close();
        },
      }),
      { status: 200 },
    );
  });
  const { registerAuthProvider } = await import("../../core/llm-runtime/auth-registry.js");
  registerAuthProvider({ provider: "codex", getAccessToken: async () => "regression-fake-token" });
  const { runOpenAiCodex } = await import("../../core/llm-runtime/adapters/openai-codex-oauth.js");
  run = (input) => { req = 0; return runOpenAiCodex(input as never) as never; };
} else {
  (globalThis as unknown as { fetch: unknown }).fetch = async () => { throw new Error("REGRESSION_NETWORK_BLOCKED"); };
  const { injectRegressionModel } = await import("../../core/llm-runtime/regression-model-guard.js");
  let turnCalls = 0;
  injectRegressionModel({
    getResponse: async () => { throw new Error("스트림만 쓴다"); },
    async *getStreamedResponse() {
      turnCalls += 1;
      yield { type: "response_started" };
      if (turnCalls === 1) {
        yield { type: "response_done", response: { id: "r1", usage: { inputTokens: 200000, outputTokens: 1, totalTokens: 200001, requests: 1 }, output: [{ type: "function_call", id: "fc1", callId: "c1", name: "Read", arguments: JSON.stringify(ARGS), status: "completed" }] } };
        return;
      }
      yield { type: "output_text_delta", delta: "읽었습니다" };
      yield { type: "response_done", response: { id: "r2", usage: { inputTokens: 200000, outputTokens: 1, totalTokens: 200001, requests: 1 }, output: [{ type: "message", id: "m", role: "assistant", status: "completed", content: [{ type: "output_text", text: "읽었습니다" }] }] } };
    },
  });
  const { runOpenAi } = await import("../../core/llm-runtime/adapters/openai-agents-sdk.js");
  run = (input) => { turnCalls = 0; return runOpenAi({ ...input, model: "gpt-regression", provider: "openai" } as never) as never; };
}

const out: Array<{ scenario: Scenario; file: unknown; outText: string; base: string; err?: string }> = [];
for (const scenario of ["home", "proj"] as Scenario[]) {
  file = undefined;
  outText = "";
  const input: Record<string, unknown> = { text: "notes/a.txt 를 읽어 줘", threadKey: TK, channel: "cli" };
  if (scenario === "proj") input.cwd = PROJ;
  let err: string | undefined;
  try {
    await run(input);
  } catch (e) {
    err = (e instanceof Error ? e.message : String(e)).slice(0, 300);
  }
  await new Promise((res) => setTimeout(res, 100));
  out.push({ scenario, file, outText: outText.slice(0, 300), base: scenario === "proj" ? PROJ : HOME, ...(err !== undefined ? { err } : {}) });
}
console.log(JSON.stringify(out));
process.exit(0);
