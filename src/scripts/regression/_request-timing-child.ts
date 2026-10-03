/**
 * 요청별 시간 분해가 **어댑터가 실제로 시각을 찍는 순서**대로 나오는가 — 가짜 codex 백엔드로 잰다. 네트워크 0.
 *
 * 백엔드가 헤더까지 H, 응답 시작 뒤 첫 진전까지 T, 첫 진전 뒤 끝까지 O 를 쉬게 만든다. 그러면 요청 두 번(도구 한 번)의
 * «첫출력까지» 는 2·(H+T), «출력» 은 2·O 근처여야 한다. 시각을 엉뚱한 자리에서 찍거나 시도마다 초기화를 빼먹으면
 * 이 숫자가 갈린다(순수 함수 검사로는 안 보이던 부류 — 적대 검토 2026-10-02 G1).
 * 실패 턴: 첫 진전 뒤 스트림이 깨지면 `[codex-turn-fail]` 이 «출력 중» 에 멈췄다고 남겨야 한다.
 * 무진전 재개: 첫 시도가 진전 없이 멈추면(부모가 CODEX_NO_PROGRESS_MS 를 줄여 준다) 같은 요청을 다시 보낸다 — 버린 시도는
 *  «무진전» 칸으로 가고, «첫출력까지» 는 **마지막 시도만**이어야 한다(시도마다 하던 초기화를 빼면 여기가 부푼다).
 */
import { fileURLToPath } from "node:url";
import { initStore } from "../../store/sessions.js";
import { registerAuthProvider } from "../../core/llm-runtime/auth-registry.js";
import { getEventBus } from "../../core/eventbus.js";
import { assertIsolated, fakeNetwork, pinModelForTest } from "./_framework.js";
assertIsolated();
pinModelForTest("codex:gpt-5.6-sol");
initStore();
registerAuthProvider({ provider: "codex", getAccessToken: async () => "regression-fake-token" });

const H = 60;
const T = 120;
const O = 80;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
let calls = 0;
let failMode = false;
let stallMode = false;
let stallCalls = 0;
globalThis.fetch = fakeNetwork(async (_url: unknown, init?: RequestInit) => {
  await sleep(H); // 헤더까지
  calls += 1;
  if (stallMode) stallCalls += 1;
  const stalled = stallMode && stallCalls === 1;
  const tool = !failMode && !stallMode && calls === 1;
  const enc = new TextEncoder();
  const send = (c: ReadableStreamDefaultController<Uint8Array>, e: unknown): void => c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
  const item = { type: "function_call", id: "fc-t", call_id: "call-t", name: "Read", arguments: JSON.stringify({ path: fileURLToPath(import.meta.url), limit: 4 }) };
  const body = new ReadableStream<Uint8Array>({
    async start(c) {
      // 실제 fetch 처럼 요청 신호가 끊기면 본문도 끊긴다(무진전 판정이 스트림을 끊는 경로).
      init?.signal?.addEventListener("abort", () => {
        try {
          c.error(init.signal?.reason ?? new Error("aborted"));
        } catch {
          /* 이미 닫힘 */
        }
      }, { once: true });
      send(c, { type: "response.created", response: { id: "t" } });
      if (stalled) {
        // 진전 없이 붙잡고 있다 — 무진전 타이머가 끊는다(안 끊겨도 결국 닫는다).
        await sleep(2_000);
        try {
          c.close();
        } catch {
          /* 이미 취소됨 */
        }
        return;
      }
      await sleep(T); // 응답 시작 뒤 첫 진전까지
      if (tool) send(c, { type: "response.output_item.added", item });
      else send(c, { type: "response.output_text.delta", delta: "끝" });
      await sleep(O); // 첫 진전 뒤 끝까지
      if (failMode) {
        c.error(new Error("regression: stream broke mid-output"));
        return;
      }
      if (tool) send(c, { type: "response.output_item.done", item });
      send(c, { type: "response.completed", response: { id: "t", usage: { input_tokens: 100, output_tokens: 5, input_tokens_details: { cached_tokens: 50 } } } });
      c.close();
    },
  });
  return new Response(body, { status: 200 });
});

const lines: string[] = [];
const realLog = console.log.bind(console);
console.log = (...a: unknown[]): void => {
  const s = a.map((x) => String(x)).join(" ");
  if (/^\[codex-turn-(end|fail)\]|^\[cache-curve\] regr:timing /.test(s)) lines.push(s);
};
let turnDoneTiming: unknown;
getEventBus().subscribe((ev) => {
  if (ev.type === "llm.turn_done" && (ev.payload as { threadKey?: string }).threadKey === "regr:timing") {
    turnDoneTiming = (ev.payload as { timing?: unknown }).timing;
  }
});

const { runClaude: runRegionA } = await import("../../core/claude.js");
const out = await runRegionA({ text: "시간 분해 확인", channel: "cli", threadKey: "regr:timing" } as never);
failMode = true;
let failed = false;
try {
  await runRegionA({ text: "깨지는 스트림", channel: "cli", threadKey: "regr:timing-fail" } as never);
} catch {
  failed = true;
}
stallMode = true;
failMode = false;
const stallOut = await runRegionA({ text: "무진전 뒤 재개", channel: "cli", threadKey: "regr:timing-stall" } as never);
console.log = realLog;
console.log(
  "TIMING_RESULT " +
    JSON.stringify({
      H, T, O,
      endLine: lines.find((l) => l.startsWith("[codex-turn-end] regr:timing ")) ?? null,
      // 요청별 상세 줄의 «헤더» 칸 — 턴 줄은 헤더를 «첫출력까지» 에 묶으므로 헤더 시각이 틀려도 거기선 안 보인다.
      headerSecs: lines.filter((l) => l.startsWith("[cache-curve] regr:timing ")).map((l) => Number(/헤더 ([\d.]+)s/.exec(l)?.[1] ?? "NaN")),
      failLine: lines.find((l) => l.startsWith("[codex-turn-fail] regr:timing-fail ")) ?? null,
      outputTiming: (out as { timing?: unknown }).timing ?? null,
      turnDoneTiming: turnDoneTiming ?? null,
      failed,
      stallTiming: (stallOut as { timing?: unknown }).timing ?? null,
      stallCalls,
    }),
);
process.exit(0);
