/**
 * 회귀: **자동(auto) 쓰기는 사용자 확정 규칙을 덮지 못한다** (2026-10-13 아스트라 검토,
 *  `docs/decisions/2026-10-13-user-directive-overwrite-review-handoff.md`).
 *
 * ★2026-11-03: 자동 쪽 작성자(자가성장 플러그인)는 뺐다. 그래도 `upsertDirective` 의 보호는 남긴다 — 기존 파일에 auto 블록이
 *  남아 있고, 저장소 API 는 `source:"auto"` 쓰기를 여전히 받는다. 재발 시각 갱신 갈래는 그 함수와 함께 지웠다.
 *
 * 사고(기제 + VM 재현): 자동 쪽은 읽고 → 판단(LLM, 수 초) → 쓰기다. 그 사이에 사용자가 `confirm_feedback` 으로 같은 key 를
 *  고치면 ①재발 처리기가 **읽어 둔 옛 본문을 되써** 본문이 되돌아가고(출처만 user) ②늦게 도착한 자동 착지가 `source:"auto"` 로
 *  **출처까지 강등**했다. 사용자에겐 «올렸습니다» 가 나간 뒤다.
 *
 * 재는 것(격리 홈 · 실제 저장소 · 순서는 직접 배치 — sleep 없음):
 *  ① 자동 읽기 → 사용자 set → 옛 본문 되쓰기(출처 생략 = auto): 사용자 본문·출처 유지
 *  ② 사용자 set → 늦은 auto 저장: 본문·출처 유지 + 돌려준 항목으로 «안 바뀌었다» 를 알 수 있다
 *  ③ 정상 경로 유지: auto→user 승격 · user→user 수정 · auto→auto 덮어쓰기
 *
 * 등급: **동작**.
 */
import { assert, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "user-directive-survives-auto-writes",
  guards:
    "사용자가 확정한 규칙을, 그 전에 읽어 둔 자동 학습이 옛 본문으로 되돌리거나 늦은 자동 저장이 출처를 auto 로 내리던 것",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const md = await import("../../store/self-growth-md.js");
    const { confirmFeedback } = await import("../../core/llm-runtime/capabilities/directives-mcp.js");
    const K = "regr-protect";
    const snap = async () => {
      const d = await md.getDirective(K);
      return d === null ? null : { text: d.text, source: d.source, updatedAt: d.updatedAt };
    };

    // ① 자동이 읽어 둔 뒤 사용자가 고친다 → 옛 방식 되쓰기(출처 생략)가 사용자 값을 못 건드린다
    await md.upsertDirective({ key: K, text: "AUTO_OLD", source: "auto", group: "failure" });
    const stale = await md.getDirective(K);
    const userSet = await confirmFeedback({ key: K, text: "USER_NEW" });
    await md.upsertDirective({ key: K, text: stale?.text ?? "", group: stale?.group });
    const afterRewrite = await snap();
    await md.deleteDirective(K);

    // ② 사용자 확정 뒤 늦은 auto 착지
    await confirmFeedback({ key: K, text: "USER_KEEP" });
    const late = await md.upsertDirective({ key: K, text: "LATE_AUTO", source: "auto", group: "failure" });
    const afterLate = await snap();
    await md.deleteDirective(K);

    // ③ 정상 경로
    await md.upsertDirective({ key: K, text: "AUTO_A", source: "auto" });
    await md.upsertDirective({ key: K, text: "AUTO_B", source: "auto" });
    const autoOverwrite = await snap();
    const promote = await confirmFeedback({ key: K, text: "USER_1" });
    const promoted = await snap();
    const edit = await confirmFeedback({ key: K, text: "USER_2" });
    const edited = await snap();
    await md.deleteDirective(K);

    return [
      assert(
        "★① 자동이 읽어 둔 옛 본문을 사용자 확정 뒤에 되써도(출처 생략) 사용자 본문·출처가 남는다",
        !userSet.isError && afterRewrite?.text === "USER_NEW" && afterRewrite.source === "user",
        { 되쓰기뒤: afterRewrite },
      ),
      assert(
        "★② 사용자 확정 뒤 늦은 auto 저장은 본문·출처를 못 바꾸고, 돌려준 항목의 출처로 «안 바뀌었다» 를 알 수 있다",
        afterLate?.text === "USER_KEEP" && afterLate.source === "user" && late?.source === "user" && late.text === "USER_KEEP",
        { 최종: afterLate, 돌려준것: late === null ? null : { text: late.text, source: late.source } },
      ),
      assert(
        "③ 정상 경로는 그대로 — auto 끼리 덮어쓰기 · auto→user 승격 · user→user 수정",
        autoOverwrite?.text === "AUTO_B" && autoOverwrite.source === "auto" &&
          !promote.isError && promoted?.text === "USER_1" && promoted.source === "user" &&
          !edit.isError && edited?.text === "USER_2" && edited.source === "user",
        { autoOverwrite, promoted, edited },
      ),
    ];
  },
};

export default check;
