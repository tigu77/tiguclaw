/**
 * **매니저 턴이 스트림 중간에 죽으면 그때까지 쓴 보고가 답장에 실리는가** — 동작 검사용 자식.
 *
 * ★사고(2026-09-01 실측): `worker:999d3987` 이 iter=15 에서 `TypeError: terminated` 로 죽었고
 *  로그는 `shown=0자`, 직전 트레이스는 `total=3859` — 모델이 쓰던 마무리 보고가 통째로
 *  사라지고 사용자에겐 일반 오류 문구만 갔다.
 *
 * ★왜 자식인가: `globalThis.fetch` 를 스텁하고 auth provider 를 전역 등록한다. 스위트
 *  프로세스에서 하면 뒤따르는 검사가 그 오염을 물려받는다(`_codex-cancel-child` 와 같은 이유).
 *
 * ★왜 `workerDepth: 1` 인가: 이 결함의 **조건 그 자체**다. `deltaStream` 은
 *  `depth === 0 && workerDepth === 0` 에서만 켜지고, 꺼진 턴에서는 삼킴 경로가 «이미 흘러간
 *  텍스트» 를 꺼낼 데가 없었다. 0 으로 두면 이 검사는 아무것도 안 잰다.
 *
 * 출력: 마지막 줄에 JSON `{"outcome","text","hasPartial","hasNotice"}`.
 */
import { registerAuthProvider } from "../../core/llm-runtime/auth-registry.js";
import { initStore } from "../../store/sessions.js";
import type { RegionASdkInput } from "../../core/llm-runtime/types.js";

/** 답장에 이게 있으면 «끊기기 전 텍스트가 살아남았다». */
const MARKER = "부분보고-표식-XYZ";

const sse = (events: unknown[]): string =>
  events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");

const run = async (): Promise<void> => {
  let call = 0;
  (globalThis as unknown as { fetch: unknown }).fetch = async (): Promise<Response> => {
    call += 1;
    if (call === 1) {
      // ① 부작용 도구를 실행시킨다 — `sideEffectExecuted=true` 여야 삼킴 경로가 열린다.
      const args = JSON.stringify({
        name: "regr-partial-probe",
        kind: "note",
        summary: "회귀 검사용",
        body: "x",
      });
      const evts = [
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
        { type: "response.completed", response: { id: "r1", output: [] } },
      ];
      return new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new TextEncoder().encode(sse(evts)));
            c.close();
          },
        }),
        { status: 200 },
      );
    }
    // ② 보고를 쓰다가 **`response.completed` 없이** 연결이 끊긴다 — 실사고와 같은 모양.
    // ★`enqueue` 뒤에 곧바로 `error()` 를 부르면 **큐에 든 청크가 버려진다**(스트림 스펙).
    //  첫 판이 그래서 델타가 0건이었고, 검사가 «고쳤는데 안 고쳐졌다» 고 잘못 말할 뻔했다.
    //  `pull` 로 나눠 청크가 **전달된 뒤** 끊는다 — 실사고와 같은 순서다.
    let stage = 0;
    return new Response(
      new ReadableStream<Uint8Array>({
        pull(c) {
          if (stage === 0) {
            stage = 1;
            c.enqueue(
              new TextEncoder().encode(
                sse([
                  { type: "response.output_text.delta", delta: `정리하면 다음과 같습니다. ` },
                  { type: "response.output_text.delta", delta: `${MARKER} 회귀 21/21 통과.` },
                ]),
              ),
            );
            return;
          }
          c.error(new TypeError("terminated"));
        },
      }),
      { status: 200 },
    );
  };

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
    threadKey: "worker:regr-partial",
    channel: "cli",
    workerDepth: 1, // ★이 결함의 조건 — deltaStream 이 꺼진다.
  } as RegionASdkInput;

  try {
    const out = await runOpenAiCodex(input);
    console.log(
      JSON.stringify({
        outcome: "returned",
        text: out.text.slice(0, 400),
        hasPartial: out.text.includes(MARKER),
        hasNotice: /오류가 발생했습니다|처리하지 못했습니다/.test(out.text),
      }),
    );
  } catch (e) {
    console.log(
      JSON.stringify({
        outcome: "threw",
        text: e instanceof Error ? e.message.slice(0, 200) : String(e),
        hasPartial: false,
        hasNotice: false,
      }),
    );
  }
};

void run().then(
  () => process.exit(0),
  (e: unknown) => {
    console.log(
      JSON.stringify({ outcome: "harness-error", text: String(e), hasPartial: false, hasNotice: false }),
    );
    process.exit(1);
  },
);
