/**
 * `fix-fallout` ③ 의 **동작** 검사용 자식 프로세스 (2026-07-31 승격).
 *
 * ★왜 자식인가: 이 검사는 `globalThis.fetch` 를 스텁하고 auth provider 를 전역 등록하며,
 *  스톨 노브를 **import 시점에 읽히는 모듈 상수**로 주입해야 한다. 스위트 프로세스 안에서
 *  하면 뒤에 오는 검사들이 그 오염을 물려받는다 → 프로세스를 갈라 격리한다.
 *
 * ★왜 grep 이 아닌가: 원래 이 자리는 "동일성 판정 코드가 소스에 있다" 는 정규식이었다.
 *  그 코드는 멀쩡히 있는 채로 **상류가 엉뚱한 에러를 던져** 판정을 비껴갔고(2026-07-31
 *  A3a), 정규식은 그걸 통과시켰다. 코드의 존재가 아니라 **취소가 실제로 올라오는지**를 본다.
 *
 * 출력: 마지막 줄에 JSON 한 줄 `{"outcome":"threw"|"returned","identical":bool,"name":string}`.
 */
// ★노브는 어댑터 import 보다 먼저 — 모듈 최상위 상수라 나중에 바꿔도 안 먹는다.
//  기본값(무진전 300s)이면 스톨 분기에 **아예 안 들어가** 검사가 조용히 무의미해진다.
process.env.CODEX_NO_PROGRESS_MS = "1200";
process.env.CODEX_STALL_BACKOFF_MS = "5000";

import { registerAuthProvider } from "../../core/llm-runtime/auth-registry.js";
import { initStore } from "../../store/sessions.js";
import type { RegionASdkInput } from "../../core/llm-runtime/types.js";

class UserCancelledError extends Error {
  constructor() {
    super("사용자가 중단했습니다");
    this.name = "UserCancelledError";
  }
}

const sse = (events: unknown[]): string =>
  events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");

const streamOf = (
  chunks: string[],
  opts: { stall?: boolean; signal?: AbortSignal },
): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const c of chunks) controller.enqueue(enc.encode(c));
      if (opts.stall !== true) {
        controller.close();
        return;
      }
      // 스톨 = 닫지 않고 매달린다. abort 시 undici 네이티브와 동형으로 error 를 흘린다.
      const sig = opts.signal;
      if (sig === undefined) return;
      const onAbort = (): void => {
        try {
          controller.error(sig.reason);
        } catch {
          /* 이미 닫혔을 수 있음 */
        }
      };
      if (sig.aborted) onAbort();
      else sig.addEventListener("abort", onAbort, { once: true });
    },
  });

/**
 * 시나리오
 *  - `read`  (대조군): 부작용 도구 실행 후 **SSE 읽는 중** 취소 → 원래도 전파되던 경로.
 *  - `stall` (본체):   부작용 도구 실행 후 **스톨 백오프 중** 취소 → A3a 가 삼키던 경로.
 */
const run = async (mode: "read" | "stall"): Promise<void> => {
  let call = 0;
  const turnAc = new AbortController();
  const cancel = (): void => turnAc.abort(new UserCancelledError());

  (globalThis as unknown as { fetch: unknown }).fetch = async (
    _url: string,
    init: { signal?: AbortSignal },
  ): Promise<Response> => {
    call += 1;
    if (call === 1) {
      // iteration 1 — 부작용 도구(add_memory)를 실행시킨다. `sideEffectExecuted=true` 가
      //  돼야 "삼킴" 경로가 열린다(그게 A3a 의 전제였다).
      const args = JSON.stringify({
        name: "regr-cancel-probe",
        kind: "note",
        summary: "회귀 검사용",
        body: "x",
      });
      return new Response(
        streamOf(
          [
            sse([
              {
                type: "response.output_item.added",
                item: { type: "function_call", id: "fc1", call_id: "c1", name: "add_memory" },
              },
              { type: "response.function_call_arguments.delta", delta: args },
              {
                type: "response.output_item.done",
                item: {
                  type: "function_call",
                  id: "fc1",
                  call_id: "c1",
                  name: "add_memory",
                  arguments: args,
                },
              },
              {
                type: "response.completed",
                response: { id: "resp_1", usage: { input_tokens: 10, output_tokens: 5 } },
              },
            ]),
          ],
          {},
        ),
        { status: 200 },
      );
    }
    // iteration 2 — 아무것도 안 보내고 매달린다.
    if (mode === "read") setTimeout(cancel, 300); // 무진전 한계(1200ms) 전 = SSE 읽는 중.
    return new Response(streamOf([], { stall: true, signal: init.signal }), { status: 200 });
  };

  // 무진전 1200ms 에 스톨 진입 → backoff 5000ms 시작. 그 한복판에서 취소한다.
  if (mode === "stall") setTimeout(cancel, 2000);

  initStore();
  registerAuthProvider({
    provider: "codex",
    getAccessToken: async () => "regression-fake-token",
  });
  const { runOpenAiCodex } = await import(
    "../../core/llm-runtime/adapters/openai-codex-oauth.js"
  );

  const input = {
    text: "회귀 검사용 요청",
    threadKey: "regr:cancel",
    channel: "cli",
    abortSignal: turnAc.signal,
  } as RegionASdkInput;

  try {
    await runOpenAiCodex(input);
    // 반환 = 취소가 삼켜졌다(사용자에겐 정상 응답으로 보이고 턴이 성공 적재된다).
    console.log(JSON.stringify({ outcome: "returned", identical: false, name: "" }));
  } catch (e) {
    console.log(
      JSON.stringify({
        outcome: "threw",
        identical: e === turnAc.signal.reason,
        name: e instanceof Error ? e.name : String(e),
      }),
    );
  }
};

const mode = process.argv[2] === "read" ? "read" : "stall";
void run(mode).then(
  () => process.exit(0),
  (e: unknown) => {
    console.log(
      JSON.stringify({ outcome: "harness-error", identical: false, name: String(e) }),
    );
    process.exit(1);
  },
);
