/**
 * `openai-cancel-is-not-success` 의 **동작** 검사용 자식 — OpenAI 어댑터 `runOpenAi` 를 **실제 SDK 루프 끝까지** 가짜 Model 로 돌린다.
 *
 * ★왜 자식인가: 가짜 Model 주입·인증 env·`fetch` 차단·요약 임계(모듈 상수)를 전역으로 바꾼다 — 스위트 프로세스에서 하면 뒤 검사가
 *  그 오염을 물려받는다(`_codex-cancel-child` 와 같은 이유). 시나리오 하나 = 프로세스 하나.
 * ★주입은 `injectRegressionModel` 하나(회귀 모드에서만 받는다) — 실모델 가드는 그대로다. `fetch` 는 **표식 없이** 막아,
 *  주입이 닿지 않은 모델 생성 자리가 있으면 실제 OpenAI 로 나가는 대신 즉시 실패한다(아스트라 회신 §5).
 *
 * 출력: 마지막 줄에 JSON 한 줄.
 */
// ★요약 임계는 import 전에 — 모듈 최상위 상수다.
process.env.CODEX_COMPACT_TRIGGER_CHARS = "3000";
process.env.OPENAI_API_KEY = "sk-regression-not-a-key";

import { mkdtempSync } from "node:fs";
import path from "node:path";
import { assertIsolated } from "./_framework.js";

const scenario = process.argv[2] ?? "";
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2, requests: 1 };
const message = (text: string) => ({ type: "message", id: "m", role: "assistant", status: "completed", content: [{ type: "output_text", text }] });
const call = (name: string, args = "{}", n = 1) => ({ type: "function_call", id: `fc${n}`, callId: `c${n}`, name, arguments: args, status: "completed" });
const abortError = (): Error => Object.assign(new Error("aborted"), { name: "AbortError" });

const main = async (): Promise<void> => {
  assertIsolated();
  // 이 프로세스만의 홈 — 뒤 검사에 저장소가 새지 않게.
  process.env.TIGUCLAW_HOME = mkdtempSync(path.join(process.env.TIGUCLAW_HOME!, "openai-run-"));
  // ★표식 없는 차단 — 주입이 안 닿은 경로가 실제 네트워크로 나가면 여기서 터진다.
  (globalThis as unknown as { fetch: unknown }).fetch = async () => {
    throw new Error("REGRESSION_NETWORK_BLOCKED");
  };
  const { injectRegressionModel } = await import("../../core/llm-runtime/regression-model-guard.js");
  const { initStore } = await import("../../store/sessions.js");
  const { appendApiTurn } = await import("../../store/memory.js");
  const { getThreadSummary } = await import("../../store/thread-summaries.js");
  const { UserCancelledError } = await import("../../core/steering.js");
  const { TurnTimeoutError } = await import("../../core/llm-runtime/turn-timeout.js");
  const { getEventBus } = await import("../../core/eventbus.js");
  const { runOpenAi } = await import("../../core/llm-runtime/adapters/openai-agents-sdk.js");
  initStore();

  // 요약 시나리오는 파생 대화(`worker:`) — 일반 대화는 창에 들어가면 요약을 답한 뒤로 미루고(answerFirst), 파생 대화는 요청 때 접는다.
  const threadKey = scenario.startsWith("summary") ? `worker:openai-run-${scenario}` : `cli:openai-run-${scenario}`;
  const turnAc = new AbortController();
  let calls = 0;
  let summaryCalls = 0;
  const isSummary = (req: { input?: unknown }): boolean => JSON.stringify(req.input ?? "").includes("다음 대화 조각을 위 지침대로 요약하세요");

  // 시나리오별 가짜 Model — SDK 의 `getStreamedResponse` 계약 그대로(텍스트 델타 → response_done).
  type Req = { signal?: AbortSignal; input?: unknown };
  const behave: (req: Req, n: number) => AsyncGenerator<unknown> = {
    complete: async function* () {
      yield { type: "output_text_delta", delta: "끝" };
      yield { type: "response_done", response: { id: "r", usage, output: [message("끝")] } };
    },
    "abort-before-output": async function* (req: Req) {
      turnAc.abort(new UserCancelledError());
      if (req.signal?.aborted) throw abortError();
      yield { type: "response_done", response: { id: "r", usage, output: [message("안 나와야 한다")] } };
    },
    "abort-mid-text": async function* (req: Req) {
      for (let i = 0; i < 40; i++) {
        if (req.signal?.aborted) throw abortError();
        yield { type: "output_text_delta", delta: `조각${i} ` };
        if (i === 3) turnAc.abort(new TurnTimeoutError(1));
        await sleep(5);
      }
      yield { type: "response_done", response: { id: "r", usage, output: [message("전부")] } };
    },
    "abort-mid-tool": async function* (_req: Req, n: number) {
      // 1번째 호출 = 오래 걸리는 도구 실행 요청, 실행 중에 취소.
      if (n === 1) {
        setTimeout(() => turnAc.abort(new UserCancelledError()), 400);
        yield { type: "response_done", response: { id: "r1", usage, output: [call("Bash", JSON.stringify({ command: "sleep 3", description: "wait" }))] } };
        return;
      }
      yield { type: "response_done", response: { id: "r2", usage, output: [message("도구 뒤 답")] } };
    },
    // facade(`runRegionA`) 경로 — 공용 기록이 취소를 성공으로 남기지 않나(아스트라 회신 §1 «facade 까지»).
    "facade-complete": async function* () {
      yield { type: "output_text_delta", delta: "끝" };
      yield { type: "response_done", response: { id: "r", usage, output: [message("끝")] } };
    },
    "facade-abort": async function* (req: Req) {
      for (let i = 0; i < 40; i++) {
        if (req.signal?.aborted) throw abortError();
        yield { type: "output_text_delta", delta: `조각${i} ` };
        if (i === 3) turnAc.abort(new UserCancelledError());
        await sleep(5);
      }
      yield { type: "response_done", response: { id: "r", usage, output: [message("전부")] } };
    },
    // 도구 미지원 모델 → 도구 없는 Agent 로 1회 재시도(noToolsAgent) — 그 경로에도 주입이 닿아야 한다(적대 검토 G2).
    "no-tools-fallback": async function* (_req: Req, n: number) {
      if (n === 1) throw new Error("400 this model does not support tools");
      yield { type: "output_text_delta", delta: "도구없이" };
      yield { type: "response_done", response: { id: "r", usage, output: [message("도구없이")] } };
    },
    "pre-aborted": async function* () {
      yield { type: "response_done", response: { id: "r", usage, output: [message("안 나와야 한다")] } };
    },
    "external-tool": async function* () {
      yield { type: "response_done", response: { id: "r", usage, output: [call("ext_lookup", JSON.stringify({ q: "x" }))] } };
    },
    "external-then-cancel": async function* () {
      yield { type: "response_done", response: { id: "r", usage, output: [call("ext_lookup", JSON.stringify({ q: "x" }))] } };
    },
    "summary-abort": async function* (req: Req) {
      if (isSummary(req)) {
        summaryCalls += 1;
        for (let i = 0; i < 40; i++) {
          if (req.signal?.aborted) throw abortError();
          yield { type: "output_text_delta", delta: `요약조각${i} 이 부분은 잘린 요약이다. ` };
          if (i === 4) turnAc.abort(new UserCancelledError());
          await sleep(5);
        }
        yield { type: "response_done", response: { id: "s", usage, output: [message("완성 요약")] } };
        return;
      }
      yield { type: "response_done", response: { id: "r", usage, output: [message("본 턴 답")] } };
    },
  }[scenario] as never;
  if (behave === undefined) throw new Error(`unknown scenario ${scenario}`);
  injectRegressionModel({
    getResponse: async () => {
      throw new Error("스트림만 쓴다");
    },
    async *getStreamedResponse(req: Req) {
      calls += 1;
      yield { type: "response_started" };
      yield* behave(req, calls);
    },
  });

  if (scenario === "pre-aborted") turnAc.abort(new UserCancelledError());
  if (scenario === "external-then-cancel") {
    // 외부 도구가 수집된 바로 그 순간에 사용자가 취소한다 — 정상 종료(stopAtToolNames)와 경합.
    // ★«수집 직후» = 우리 표식 도구가 **실행된 뒤**(도구 끝 활동). 도구 호출 이벤트(llm.tool_call_delta) 시점이면 실행 전에 끊겨
    //  수집 목록이 비고, Claude 식 «수집했으면 예외» 변이가 살아남았다(적대 검토 G1).
    getEventBus().subscribe((ev) => {
      const p = ev.payload as { phase?: unknown } | undefined;
      if (ev.type === "llm.activity" && p?.phase === "end" && !turnAc.signal.aborted) turnAc.abort(new UserCancelledError());
    });
  }
  if (scenario === "summary-abort") {
    // 요약 임계를 넘는 이력 — 이 턴 시작 때 요약이 돈다.
    for (let i = 0; i < 6; i++) {
      appendApiTurn({ channel: "cli", threadKey, claudeSessionId: "seed", userContent: `질문 ${i} ${"가".repeat(900)}`, assistantContent: `답 ${i} ${"나".repeat(900)}` });
    }
  }
  // 드라이버가 요약 중단을 «취소» 로 분류하나(실패로 세면 연속 실패 경보·예산 축소) — 로그로 본다(적대 검토 G3).
  const logs: string[] = [];
  for (const m of ["log", "warn", "error"] as const) {
    const orig = console[m].bind(console);
    console[m] = (...a: unknown[]) => {
      logs.push(a.map(String).join(" "));
      if (m !== "log") orig(...a);
    };
  }
  const before = getThreadSummary(threadKey);

  const input = {
    text: "안녕",
    threadKey,
    channel: "cli",
    cwd: process.env.TIGUCLAW_HOME,
    model: "gpt-regression",
    provider: "openai",
    abortSignal: turnAc.signal,
    ...(scenario.startsWith("external")
      ? { externalTools: [{ name: "ext_lookup", description: "외부 조회", parameters: { type: "object", properties: { q: { type: "string" } } } }] }
      : {}),
  };
  const events: string[] = [];
  getEventBus().subscribe((ev) => {
    const tk = (ev.payload as { threadKey?: unknown } | undefined)?.threadKey;
    if (tk === threadKey && (ev.type === "llm.turn_done" || ev.type === "llm.turn_error")) events.push(ev.type);
  });
  let out: Record<string, unknown>;
  try {
    const r = scenario.startsWith("facade")
      ? await (await import("../../core/llm-runtime/index.js")).runRegionA(
          { text: "안녕", threadKey, channel: "cli", cwd: process.env.TIGUCLAW_HOME, abortSignal: turnAc.signal } as never,
          { specs: [{ adapter: "openai", model: "gpt-regression", provider: "openai" }] },
        )
      : await runOpenAi(input as never);
    out = { outcome: "returned", text: r.text, external: (r.externalToolCalls ?? []).length };
  } catch (e) {
    out = { outcome: "threw", name: (e as Error).name, message: String((e as Error).message).slice(0, 120) };
  }
  // 취소된 턴 뒤 «턴 뒤 미리 접기» 가 그 턴의 (끊긴) 설정으로 돌지 않나(적대 검토 P3-1).
  const { compactHistoryAfterTurn } = await import("../../core/llm-runtime/adapters/openai-codex-oauth-history.js");
  const postTurnJob = out.outcome === "threw" ? compactHistoryAfterTurn(threadKey) !== undefined : null;
  const after = getThreadSummary(threadKey);
  process.stdout.write(JSON.stringify({
    ...out,
    calls,
    events,
    summaryCalls,
    summaryBefore: before?.compactedThrough ?? null,
    summaryAfter: after?.compactedThrough ?? null,
    summaryText: after?.summary.slice(0, 40) ?? null,
    postTurnJob,
    summaryCancelledLogged: logs.some((l) => l.includes("요약 취소됨")),
    summaryFailureLogged: logs.some((l) => /요약 호출 실패|압축이 \d+회 연속 실패|요약 실패/.test(l)),
  }) + "\n");
  process.exit(0);
};

main().catch((e) => {
  console.log(JSON.stringify({ outcome: "harness-error", message: String((e as Error)?.stack ?? e).slice(0, 400) }));
  process.exit(0);
});
