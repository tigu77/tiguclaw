/**
 * `stall-notice-counts` 의 어댑터 쪽 자식 프로세스 (2026-10-05).
 *
 * ★왜 자식인가: `globalThis.fetch` 스텁·auth 전역 등록·**import 시점에 읽히는** 무진전 노브를 쓴다(`_codex-cancel-child` 와 같은 이유).
 * 실제 스톨 루프를 돈다 — 가짜 서버가 생존 신호·추론 이벤트만 흘리며 매달리면 무진전, 답 텍스트를 흘리면 진전.
 *
 * 출력: 마지막 줄에 JSON 한 줄 `{ turns: { [name]: { stalls: [...], logs: [...], outcome } } }`.
 */
process.env.CODEX_NO_PROGRESS_MS = "700";
process.env.CODEX_STALL_BACKOFF_MS = "300";

import { fakeNetwork } from "./_framework.js";
import { registerAuthProvider } from "../../core/llm-runtime/auth-registry.js";
import { initStore } from "../../store/sessions.js";
import { getEventBus } from "../../core/eventbus.js";
import type { RegionASdkInput } from "../../core/llm-runtime/types.js";

const SECRET = "THINKING-SECRET-7731";
const enc = new TextEncoder();
const data = (e: unknown): string => `data: ${JSON.stringify(e)}\n\n`;
const completedText = (text: string): string =>
  data({ type: "response.output_item.added", item: { type: "message", id: "m1", role: "assistant" } }) +
  data({ type: "response.output_text.delta", delta: text }) +
  data({ type: "response.output_item.done", item: { type: "message", id: "m1", role: "assistant", content: [{ type: "output_text", text }] } }) +
  data({ type: "response.completed", response: { id: "resp", usage: { input_tokens: 10, output_tokens: 3 } } });

/** 매달리는 스트림 — 생존 신호(in_progress)·SSE 주석·추론 요약 조각만 주기적으로 흘린다(진전 아님). abort 되면 오류로 끝난다. */
const hanging = (signal: AbortSignal | undefined, firstText = false): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc.encode(data({ type: "response.created", response: { id: "r" } })));
      // 답 조각 하나를 낸 뒤 멈춘다 — «진전 뒤 무진전»(마지막 진전 종류가 로그에 남아야 한다).
      if (firstText) c.enqueue(enc.encode(data({ type: "response.output_item.added", item: { type: "message", id: "m0", role: "assistant" } }) + data({ type: "response.output_text.delta", delta: "앞 " })));
      let n = 0;
      const t = setInterval(() => {
        n += 1;
        try {
          c.enqueue(enc.encode(n % 3 === 0 ? ": keepalive\n\n" : n % 3 === 1 ? data({ type: "response.in_progress" }) : data({ type: "response.reasoning_summary_text.delta", delta: SECRET })));
        } catch { clearInterval(t); }
      }, 100);
      const stop = (): void => { clearInterval(t); try { c.error(signal?.reason); } catch { /* 닫힘 */ } };
      if (signal?.aborted === true) stop();
      else signal?.addEventListener("abort", stop, { once: true });
    },
  });

/**
 * 진전이 흐르는 긴 스트림 — 답 조각을 무진전 한계(700ms)보다 오래(1.6초) 흘린 뒤 끝난다.
 * ★실제 fetch 본문처럼 **취소되면 오류로 끝난다** — 안 그러면 진전 beat 이 끊겨 타이머가 터져도 스트림이 끝까지 흘러 «정상 완료» 로
 *  보이고, 이 시나리오가 아무것도 못 잰다(첫 판이 그랬다: beat 를 지운 변이가 초록).
 */
const slowText = (signal: AbortSignal | undefined): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(c) {
      const stop = (): void => { clearInterval(t); try { c.error(signal?.reason); } catch { /* 닫힘 */ } };
      signal?.addEventListener("abort", stop, { once: true });
      c.enqueue(enc.encode(data({ type: "response.output_item.added", item: { type: "message", id: "m1", role: "assistant" } })));
      let n = 0;
      const t: ReturnType<typeof setInterval> = setInterval(() => {
        n += 1;
        if (n <= 8) { c.enqueue(enc.encode(data({ type: "response.output_text.delta", delta: "조각 " }))); return; }
        clearInterval(t);
        c.enqueue(enc.encode(data({ type: "response.output_item.done", item: { type: "message", id: "m1", role: "assistant", content: [{ type: "output_text", text: "조각 ".repeat(8) }] } }) +
          data({ type: "response.completed", response: { id: "resp", usage: { input_tokens: 10, output_tokens: 3 } } })));
        c.close();
      }, 200);
    },
  });

type Plan = ("hang" | "hangAfterText" | "ok" | "slow")[];

const run = async (): Promise<void> => {
  initStore();
  registerAuthProvider({ provider: "codex", getAccessToken: async () => "regression-fake-token" });
  const stalls: Record<string, unknown>[] = [];
  getEventBus().subscribe((e) => { if (e.type === "llm.stream_stall") stalls.push(e.payload as Record<string, unknown>); });
  const logs: string[] = [];
  const keep = (args: unknown[]): void => {
    const line = args.map(String).join(" ");
    if (/무진전|무응답|codex-stall/.test(line)) logs.push(line);
  };
  const ow = console.warn, ol = console.log;
  console.warn = (...a: unknown[]) => { keep(a); };
  console.log = (...a: unknown[]) => { keep(a); };

  const { runOpenAiCodex } = await import("../../core/llm-runtime/adapters/openai-codex-oauth.js");
  const turns: Record<string, unknown> = {};
  const turn = async (name: string, plan: Plan, cancelAtMs?: number): Promise<void> => {
    let call = 0;
    (globalThis as unknown as { fetch: unknown }).fetch = fakeNetwork(async (_u: string, init: { signal?: AbortSignal }) => {
      const step = plan[Math.min(call, plan.length - 1)];
      call += 1;
      if (step === "hang") return new Response(hanging(init.signal), { status: 200 });
      if (step === "hangAfterText") return new Response(hanging(init.signal, true), { status: 200 });
      if (step === "slow") return new Response(slowText(init.signal), { status: 200 });
      return new Response(completedText("완료"), { status: 200 });
    });
    const ac = new AbortController();
    if (cancelAtMs !== undefined) setTimeout(() => ac.abort(Object.assign(new Error("사용자 중단"), { name: "UserCancelledError" })), cancelAtMs);
    const s0 = stalls.length, l0 = logs.length;
    let outcome = "returned";
    try {
      await runOpenAiCodex({ text: "회귀", threadKey: `regr:stall:${name}`, channel: "cli", abortSignal: ac.signal } as RegionASdkInput);
    } catch (e) {
      outcome = e === ac.signal.reason ? "cancelled" : `threw:${e instanceof Error ? e.name : String(e)}`;
    }
    turns[name] = { stalls: stalls.slice(s0), logs: logs.slice(l0), outcome, calls: call };
  };

  // ① 같은 요청이 두 번 연달아 멈춘 뒤 세 번째에 끝남 → 이번 요청 1/2 → 2/2 · 결과=완료
  await turn("twice", ["hang", "hang", "ok"]);
  // ② 다음 요청(새 턴) — 다시 멈추면 이번 요청 표시는 1/2 부터
  await turn("next", ["hang", "ok"]);
  // ③ 답 조각이 한계보다 오래 흘러도 진전이다 — 멈춤 아님
  await turn("progress", ["slow"]);
  // ④ 무진전 감지 → 백오프 중 취소 → 재개 아님(이벤트 없음) · 결과=취소
  await turn("cancel", ["hang", "ok"], 700 + 120);
  // ⑤ 세 번 다 멈춤 → 재시도 2/2 뒤 소진 · 결과=소진 · 턴은 실패로 끝난다
  await turn("exhaust", ["hang", "hang", "hang"]);
  // ⑥ 답 조각 하나 뒤 멈춤 → 마지막 진전 종류(text)가 로그·이벤트에 · 이벤트가 무진전 한계를 싣는다
  await turn("afterText", ["hangAfterText", "ok"]);
  // ⑦ 재시도가 시작된 뒤 그 스트림 도중 취소 → 결과=실패(취소) — 종전엔 결과 줄이 없었다
  await turn("cancelInRetry", ["hang", "hang", "ok"], 700 + 300 + 400);

  console.warn = ow; console.log = ol;
  console.log(JSON.stringify({ turns }));
};

void run().then(
  () => process.exit(0),
  (e: unknown) => { console.log(JSON.stringify({ error: String(e) })); process.exit(1); },
);
