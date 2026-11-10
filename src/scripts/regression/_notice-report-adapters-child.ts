/**
 * `notice-report-contract` 의 자식 — **세 어댑터가 보고 기본 생략 계약을 같은 뜻으로 지키나**(2026-11-01,
 * `docs/decisions/2026-11-01-notify-owner-report-contract.md` §3-2·§3-3·§3-5).
 *
 * 각 어댑터의 **모델 경계**를 가짜로 둔다(claude = 가짜 SDK `withFakeClaudeQuery` · codex = 가짜 네트워크 · openai = 회귀 모델 주입) —
 *  모델 호출·외부 송신 0. 시나리오:
 *   plain — 허용 없는 턴: `report_to_user` 미노출 · 생략 증명 없음 · 글 조각에 출처 없음
 *   omit  — 허용 턴, 표시 없이 글로 끝남: 도구 노출 · `reportOmitted` · 글 조각(활동·델타) 모두 `audience:"internal"`
 *   mark  — 허용 턴, `report_to_user` 를 부르고 글: 증명 없음(평소대로 전달)
 *   fail  — 허용 턴, 호스트가 깨끗한 종료를 증명 못 함: claude = 성공 뒤 오류 result(흡수) · codex = 부작용 뒤 빈 글(대체 문구) ·
 *           openai = 도구 미지원 → 도구 없는 재시도
 *   swallow — (codex) 부작용 도구 뒤 요청 실패 → 어댑터가 오류를 안내문으로 삼켜 정상 반환
 *   flush   — (codex) 빈 응답이 이어져 호스트가 마무리를 강제(final flush)한 뒤 글로 끝남 — 증명 없음
 *   trunc   — (openai) 상대가 입력을 잘라 처리(입력 토큰 1) — 증명 없음
 *   noresult— (claude) 성공 결과 없이 글 조각만 남고 스트림이 끝남 — 증명 없음
 *   emptyhead — (claude) 빈 성공 result(묶인 알림의 합성 턴 모양)가 먼저 오고 → 글 조각 → 최종 result 없이 끝남 — 증명 없음(앞 성공이 뒤 글을 증명하지 않는다)
 *   silent  — (claude) 글 없이 성공 result 로 깨끗하게 끝남 — 증명 있음(양성 대조: 위 판정이 «글 없는 턴» 까지 막지 않는다)
 *   ctx / ctxplain — 허용 턴은 «직전 질문» 한 번짜리 줄을 꺼내지 않는다 / 허용 없는 턴은 꺼낸다(양성 대조 — 어댑터가 실제로 조립에 넘기는지)
 *   opt*  — 허용 턴에서 모델이 `prompt_options` 를 부르고 글로 끝남(2026-11-02, 선택지 실패 뒤 대체 질문 보호). 렌더 콜백은 가짜:
 *           optfail(전달 실패) · optunavail(이 턴 불가) — 증명 없음 / optretry(실패 → 같은 질문 성공) · optok(처음부터 성공) — 증명 있음 /
 *           optpartial(Q1 실패 · Q2 성공) — 증명 없음 / optmark(`report_to_user` + 실패 → 같은 질문 성공) — 증명 없음(명시 표시는 그대로)
 *   omitnext — omit 과 같은 장면. `optfail` 바로 뒤(같은 프로세스)에 둬서 미해결 질문 집합이 호출마다 새로 생기는지 본다 — 증명 있음
 * 출력: 마지막 줄 JSON 배열 `[{ scenario, exposed, omitted, text, textAud, deltaAud, calls, err? }]`.
 */
process.env.OPENAI_API_KEY = "sk-regression-not-a-key";
process.env.ANTHROPIC_API_KEY = "sk-ant-regression-not-a-key"; // 인증 판정 통과용(가짜 SDK 라 쓰이지 않는다)

import { mkdtempSync } from "node:fs";
import path from "node:path";
import { assertIsolated, fakeNetwork } from "./_framework.js";

type Scenario = "plain" | "omit" | "mark" | "fail" | "swallow" | "flush" | "trunc" | "noresult" | "emptyhead" | "silent" | "ctx" | "ctxplain"
  | "optfail" | "optunavail" | "optretry" | "optok" | "optpartial" | "optmark" | "omitnext";
const adapter = process.argv[2] as "claude" | "codex" | "openai";
const scenarios = (process.argv[3] ?? "plain,omit,mark,fail").split(",") as Scenario[];
assertIsolated();
process.env.TIGUCLAW_HOME = mkdtempSync(path.join(process.env.TIGUCLAW_HOME!, `notice-report-${adapter}-`));
const { initStore } = await import("../../store/sessions.js");
initStore();
const { getEventBus } = await import("../../core/eventbus.js");

const TK = "dashboard:regr-report";
let scenario: Scenario = "plain";
let calls = 0;
let exposed = false;
const textAud: string[] = [];
const deltaAud: string[] = [];
getEventBus().subscribe((ev) => {
  const p = ev.payload as { threadKey?: string; kind?: string; audience?: string } | undefined;
  if (p?.threadKey !== TK) return;
  if (ev.type === "llm.activity" && p.kind === "text") textAud.push(p.audience ?? "-");
  if (ev.type === "llm.delta") deltaAud.push(p.audience ?? "-");
});
type T = { name?: string; tools?: T[] };
const flat = (ts: T[]): string[] => ts.flatMap((t) => [t.name ?? "", ...flat(t.tools ?? [])]);
const hasReportTool = (names: string[]): boolean => names.some((n) => n === "report_to_user" || n.endsWith("report_to_user"));

let run: (input: Record<string, unknown>) => Promise<{ text?: string; reportOmitted?: true }>;

// ── 선택지 장면 — 모델이 낼 호출 순서와 가짜 렌더 콜백(채널 결과만 흉내 낸다, 송신 0) ──
const OPT: Partial<Record<Scenario, { asks: string[]; mark?: true }>> = {
  optfail: { asks: ["Q1"] }, optunavail: { asks: ["Q1"] }, optretry: { asks: ["Q1", "Q1"] }, optok: { asks: ["Q1"] },
  optpartial: { asks: ["Q1", "Q2"] }, optmark: { asks: ["Q1", "Q1"], mark: true },
};
/** 이 장면에서 모델이 차례로 부를 도구 — 선택지 질문들, 그다음 (있으면) 보고 표시. */
const toolSeq = (s: Scenario): Array<{ name: string; args: Record<string, unknown> }> => {
  const o = OPT[s];
  if (o === undefined) return [];
  return [
    ...(o.mark === true ? [{ name: "report_to_user", args: {} }] : []),
    ...o.asks.map((q) => ({ name: "prompt_options", args: { question: q, options: [{ label: "예" }, { label: "아니요" }] } })),
  ];
};
let renders = 0;
const renderSeen = new Map<string, number>();
const presentOptions = async (q: string): Promise<{ ok: boolean; error?: string; unavailable?: true }> => {
  renders += 1;
  const n = (renderSeen.get(q) ?? 0) + 1;
  renderSeen.set(q, n);
  if (scenario === "optunavail") return { ok: false, error: "회귀: 이 턴에선 불가", unavailable: true };
  if (scenario === "optfail") return { ok: false, error: "회귀: 전송 실패" };
  if ((scenario === "optretry" || scenario === "optmark") && n === 1) return { ok: false, error: "회귀: 일시 실패" };
  if (scenario === "optpartial" && q === "Q1") return { ok: false, error: "회귀: 전송 실패" };
  return { ok: true };
};

if (adapter === "claude") {
  const { runClaude, withFakeClaudeQuery } = await import("../../core/llm-runtime/adapters/claude-agent-sdk.js");
  type Srv = { instance: { _registeredTools: Record<string, { handler: (a: unknown, e: unknown) => Promise<unknown> }> } };
  const fake = ((args: { options: { mcpServers?: Record<string, unknown> } }) => {
    calls += 1;
    const ri = args.options.mcpServers?.["reply-intent"] as Srv | undefined;
    exposed = ri !== undefined && ri.instance._registeredTools.report_to_user !== undefined;
    return (async function* () {
      yield { type: "system", subtype: "init", session_id: "s", model: "claude-fake" };
      if (scenario === "mark") await ri!.instance._registeredTools.report_to_user!.handler({}, {}); // 모델이 표시했다
      for (const c of toolSeq(scenario)) {
        const srv = (c.name === "report_to_user" ? ri : args.options.mcpServers?.["prompt-options"]) as Srv;
        await srv.instance._registeredTools[c.name]!.handler(c.args, {});
      }
      if (scenario === "silent") {
        yield { type: "result", subtype: "success", is_error: false, result: "", num_turns: 1, session_id: "s", modelUsage: {}, usage: { input_tokens: 1, output_tokens: 1 } };
        return; // 글 없이 깨끗하게 끝난 턴
      }
      // 빈 성공 result 가 먼저 — SDK 가 묶인 백그라운드 알림에 여는 합성 턴의 모양(num_turns 0 · 본문 "")
      if (scenario === "emptyhead") yield { type: "result", subtype: "success", is_error: false, result: "", num_turns: 0, session_id: "s", modelUsage: {}, usage: { input_tokens: 0, output_tokens: 0 } };
      const say = scenario === "mark" ? "보고: 새 승인이 필요합니다" : "내부에서 답했습니다";
      yield { type: "assistant", session_id: "s", parent_tool_use_id: null, message: { role: "assistant", model: "claude-fake", content: [{ type: "text", text: say }] } };
      if (scenario === "noresult" || scenario === "emptyhead") return; // 성공 결과 없이 끝난 스트림 — 글 조각만 남는다
      yield { type: "result", subtype: "success", is_error: false, result: say, num_turns: 1, session_id: "s", modelUsage: {}, usage: { input_tokens: 1, output_tokens: 1 } };
      // 흡수된 실패 — 확정한 답 뒤의 예외(`keepAnswerOnThrow` — 어댑터는 답을 유지하고 `turnHadFailure` 를 세운다).
      //  ★성공 뒤 오류 result 는 지금 어댑터가 «다른 턴의 메시지일 수 있다» 로 갈라 실패로 세지 않는다(턴 경계 판정) — 그래서 예외로 만든다.
      if (scenario === "fail") throw new Error("회귀: 확정 답 뒤 예외");
    })();
  }) as never;
  run = (input) => withFakeClaudeQuery(fake, () => runClaude(input as never)) as never;
} else if (adapter === "codex") {
  const enc = new TextEncoder();
  let req = 0;
  (globalThis as unknown as { fetch: unknown }).fetch = fakeNetwork(async (url: string, init: { body?: unknown }): Promise<Response> => {
    if (!String(url).includes("/responses")) return new Response("not found", { status: 404 });
    calls += 1;
    req += 1;
    const raw = typeof init.body === "string" ? init.body : "";
    const body = raw !== "" ? (JSON.parse(raw) as { tools?: T[] }) : {};
    if (req === 1) exposed = hasReportTool(flat(body.tools ?? []));
    if (scenario === "swallow" && req >= 2) return new Response(JSON.stringify({ error: { message: "회귀: 요청 거부", type: "invalid_request_error" } }), { status: 400 });
    return new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          const send = (e: unknown) => c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
          const call = (name: string, args: Record<string, unknown>) => {
            const a = JSON.stringify(args);
            send({ type: "response.output_item.added", item: { type: "function_call", id: `fc${req}`, call_id: `c${req}`, name } });
            send({ type: "response.function_call_arguments.delta", delta: a });
            send({ type: "response.output_item.done", item: { type: "function_call", id: `fc${req}`, call_id: `c${req}`, name, arguments: a } });
          };
          const say = (t: string) => {
            send({ type: "response.output_text.delta", delta: t });
            send({ type: "response.output_item.done", item: { type: "message", id: `m${req}`, role: "assistant", content: [{ type: "output_text", text: t }] } });
          };
          const seq = toolSeq(scenario);
          if (req <= seq.length) call(seq[req - 1]!.name, seq[req - 1]!.args);
          else if (scenario === "mark" && req === 1) call("report_to_user", {});
          else if ((scenario === "fail" || scenario === "swallow") && req === 1) call("steer_worker", { job_id: "nope", message: "회귀" }); // 부작용 도구 → 뒤 글이 비면 호스트 대체 문구 · 뒤 요청이 실패하면 삼킴
          else if (scenario === "fail") { /* 글 없이 끝남 */ }
          else if (scenario === "flush" && req <= 3) { /* 빈 응답 — 재촉 2회 뒤 호스트가 마무리를 강제한다 */ }
          else if (scenario === "flush") say("강제 마무리 뒤의 글");
          else say(scenario === "mark" ? "보고: 새 승인이 필요합니다" : "내부에서 답했습니다");
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
    async *getStreamedResponse(r: { tools?: T[] }) {
      calls += 1;
      turnCalls += 1;
      if (turnCalls === 1) exposed = hasReportTool(flat(r.tools ?? []));
      // 도구 미지원 모델 — 첫 요청(도구 있음)이 거부되면 어댑터가 도구 없이 다시 묻는다.
      if (scenario === "fail" && turnCalls === 1) throw new Error("400 This model does not support tools");
      yield { type: "response_started" };
      const seq = toolSeq(scenario);
      if (turnCalls <= seq.length) {
        const c = seq[turnCalls - 1]!;
        yield { type: "response_done", response: { id: `r${turnCalls}`, usage: { inputTokens: 200000, outputTokens: 1, totalTokens: 200001, requests: 1 }, output: [{ type: "function_call", id: `fc${turnCalls}`, callId: `c${turnCalls}`, name: c.name, arguments: JSON.stringify(c.args), status: "completed" }] } };
        return;
      }
      if (scenario === "mark" && turnCalls === 1) {
        yield { type: "response_done", response: { id: "r0", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, requests: 1 }, output: [{ type: "function_call", id: "fc1", callId: "c1", name: "report_to_user", arguments: "{}", status: "completed" }] } };
        return;
      }
      const say = scenario === "mark" ? "보고: 새 승인이 필요합니다" : "내부에서 답했습니다";
      yield { type: "output_text_delta", delta: say };
      // 입력 토큰은 보낸 크기만큼 보고한다 — 1이면 어댑터가 «프롬프트가 잘렸다» 로 보고 생략을 증명하지 않는다(그건 따로 단언한다).
      const inTok = scenario === "trunc" ? 1 : 200000;
      yield { type: "response_done", response: { id: "r", usage: { inputTokens: inTok, outputTokens: 1, totalTokens: inTok + 1, requests: 1 }, output: [{ type: "message", id: "m", role: "assistant", status: "completed", content: [{ type: "output_text", text: say }] }] } };
    },
  });
  const { runOpenAi } = await import("../../core/llm-runtime/adapters/openai-agents-sdk.js");
  run = (input) => { turnCalls = 0; return runOpenAi({ ...input, model: "gpt-regression", provider: "openai" } as never) as never; };
}

const { rememberPendingOptions, pendingOptionsLine } = await import("../../core/pending-options.js");
const { presentFailure } = await import("../../core/llm-runtime/swallowed-failure.js");
type Out = { scenario: Scenario; exposed: boolean; omitted: boolean; text: string; textAud: string[]; deltaAud: string[]; calls: number; err?: string; display?: string; askedLeft?: boolean; renders?: number };
const out: Out[] = [];
for (const s of scenarios) {
  scenario = s;
  exposed = false;
  textAud.length = 0;
  deltaAud.length = 0;
  const before = calls;
  const input: Record<string, unknown> = { text: "[작업자 알림] 회귀", threadKey: TK, channel: "cli", cwd: process.env.TIGUCLAW_HOME };
  if (s !== "plain" && s !== "ctxplain") input.reportOmittable = true;
  if (s === "ctx" || s === "ctxplain") rememberPendingOptions(TK, "배포할까요?", ["예", "아니요"]);
  renders = 0;
  renderSeen.clear();
  if (OPT[s] !== undefined) input.presentOptions = presentOptions;
  let r: { text?: string; reportOmitted?: true } = {};
  let err: string | undefined;
  let display: string | undefined;
  try {
    r = await run(input);
  } catch (e) {
    err = (e instanceof Error ? e.message : String(e)).slice(0, 300);
    display = presentFailure(e, err);
  }
  await new Promise((res) => setTimeout(res, 200)); // 델타 코얼레스 타이머가 비울 틈
  // 한 번짜리 줄이 아직 남았나(꺼내 보면 지워진다 — 다음 장면에 안 남게).
  const askedLeft = s === "ctx" || s === "ctxplain" ? pendingOptionsLine(TK).includes("배포할까요?") : undefined;
  out.push({
    ...(askedLeft !== undefined ? { askedLeft } : {}),
    ...(OPT[s] !== undefined ? { renders } : {}),
    scenario: s, exposed, omitted: r.reportOmitted === true, text: String(r.text ?? "").slice(0, 120),
    textAud: [...textAud], deltaAud: [...new Set(deltaAud)], calls: calls - before, ...(err !== undefined ? { err, display } : {}),
  });
}
console.log(JSON.stringify(out));
process.exit(0);
