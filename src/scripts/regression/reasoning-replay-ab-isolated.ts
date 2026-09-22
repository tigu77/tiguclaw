/**
 * A/B 비교의 **전제**를 실행으로 못 박는다 (2026-09-22, Codex 검토 ④).
 *
 * 비교 질문은 «재전송 reasoning 보존이 차이를 만드나» 인데, 그게 성립하려면
 * **A 와 B 의 다음 요청 차이가 reasoning 에만 한정**돼야 한다. 아니면 재는 것이
 * reasoning 이 아니라 «message phase 나 도구 구조» 가 된다.
 *
 * ★종전엔 이 대조가 **스크래치에만** 있어 독립 재현이 불가능했다. 회귀로 내린다.
 *
 * 등급: **동작 검사** — 제품 함수 `compatibleReplayOutput` 을 실제로 부른다.
 * 네트워크 0(SSE 결과 객체를 직접 만든다).
 *
 * ★**«본문 완전 동일» 이라고 말하지 않는다.** 실제 벤치는 작업 경로·홈·식별자가 달라서
 *  전체 본문은 다를 수 있다. 여기서 못 박는 것은 **재전송 항목 배열**이고, 허용하는 차이는
 *  reasoning 항목의 유무 하나뿐이다.
 */
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

/** 조건 A — 벤치 격리 사본이 적용할 한 줄. 여기 두어 diff 가 한 곳임을 보인다. */
const conditionA = (items: readonly { type?: string }[]): unknown[] =>
  items.filter((i) => i.type !== "reasoning");

export const check: RegressionCheck = {
  name: "reasoning-replay-ab-isolated",
  guards:
    "A/B 벤치가 reasoning 아닌 축(메시지 phase·도구 호출·결과)까지 바꿔 «reasoning 효과» 를 잘못 재는 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const { compatibleReplayOutput } = await import(
      "../../core/llm-runtime/adapters/openai-codex-oauth-history.js"
    );

    const reasoning = { type: "reasoning", id: "rs_ab", summary: [], encrypted_content: "opaque-ab" };
    const message = {
      type: "message", id: "msg_ab", role: "assistant", status: "completed", phase: "commentary",
      content: [{ type: "output_text", text: "읽겠습니다", annotations: [] }],
    };
    const call = {
      type: "function_call", id: "fc_ab", call_id: "call_ab", name: "Read",
      arguments: JSON.stringify({ path: "/nonexistent-ab" }),
    };
    const sse = {
      text: "읽겠습니다",
      toolCalls: [{ callId: "call_ab", name: "Read", partialJson: JSON.stringify({ path: "/nonexistent-ab" }) }],
      replayOutput: [reasoning, message, call],
    } as never;

    const B = compatibleReplayOutput(sse);
    out.push(
      assert(
        "★전제 — B(현행)는 재전송분을 내고 거기 reasoning 이 있다",
        Array.isArray(B) && B.some((i) => (i as { type?: string }).type === "reasoning"),
        `B=${JSON.stringify(B)?.slice(0, 120)}`,
      ),
    );
    const A = conditionA((B ?? []) as { type?: string }[]);
    const strip = (x: readonly unknown[]): string =>
      JSON.stringify(x.filter((i) => (i as { type?: string }).type !== "reasoning"));

    out.push(
      assert(
        "★★**A/B 차이는 reasoning 에만 한정된다** — 걷어내면 두 배열이 같다",
        strip(A) === strip(B ?? []),
        `A(−reasoning)=${strip(A).slice(0, 100)} · B(−reasoning)=${strip(B ?? []).slice(0, 100)}`,
      ),
    );
    out.push(
      assert(
        "★A 는 reasoning 만 없앤다 — 항목 수 차이가 정확히 reasoning 개수다",
        (B ?? []).length - A.length ===
          (B ?? []).filter((i) => (i as { type?: string }).type === "reasoning").length,
        `B=${(B ?? []).length} A=${A.length}`,
      ),
    );
    const phase = (x: readonly unknown[]): string =>
      JSON.stringify(x.filter((i) => (i as { type?: string }).type === "message").map((i) => (i as { phase?: string }).phase));
    out.push(
      assert(
        "★★message **phase** 가 안 바뀐다 — 전체를 끄면 여기가 갈린다(그래서 한 줄 패치다)",
        phase(A) === phase(B ?? []) && phase(A).includes("commentary"),
        `A=${phase(A)} B=${phase(B ?? [])}`,
      ),
    );
    const calls = (x: readonly unknown[]): string =>
      JSON.stringify(x.filter((i) => (i as { type?: string }).type === "function_call"));
    out.push(
      assert(
        "★도구 호출이 안 바뀐다(call_id·name·arguments)",
        calls(A) === calls(B ?? []) && calls(A).includes("call_ab"),
        calls(A).slice(0, 120),
      ),
    );
    out.push(
      assert(
        "★**반대 방향** — 전체를 끄면(재전송 없음) 그건 A 가 아니다(비교가 성립 안 함)",
        // 인계가 지목한 함정: `compatibleReplayOutput` 을 통째로 무효화하면 message 와
        // 도구 호출까지 사라져 «reasoning 만의 비교» 가 아니게 된다.
        phase([]) !== phase(B ?? []) && calls([]) !== calls(B ?? []),
        // ★증거는 **관측**이다 — 기대값("~여야 한다")을 적으면 빨간불을 봐도 무엇이
        //  관측됐는지 모른다(`suite-selfcheck` 래칫이 이걸 잡는다).
        `전체끄기 phase=${phase([])} 도구=${calls([])} · B phase=${phase(B ?? [])} 도구=${calls(B ?? []).slice(0, 60)}`,
      ),
    );
    return out;
  },
};
