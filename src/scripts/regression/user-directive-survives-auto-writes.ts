/**
 * 회귀: **자동 학습은 사용자 확정 규칙을 덮지 못한다** (2026-10-13 아스트라 검토,
 *  `docs/decisions/2026-10-13-user-directive-overwrite-review-handoff.md`).
 *
 * 사고(기제 + VM 재현): 자동 쪽은 읽고 → 판단(LLM, 수 초) → 쓰기다. 그 사이에 사용자가 `confirm_feedback` 으로 같은 key 를
 *  고치면 ①재발 처리기가 **읽어 둔 옛 본문을 되써** 본문이 되돌아가고(출처만 user) ②늦게 도착한 자동 착지가 `source:"auto"` 로
 *  **출처까지 강등**했다. 사용자에겐 «올렸습니다» 가 나간 뒤다.
 *
 * 재는 것(격리 홈 · 실제 저장소 · 순서는 직접 배치 — sleep 없음):
 *  ① 자동 읽기 → 사용자 set → 옛 본문 되쓰기·시각 갱신: 사용자 본문·출처 유지
 *  ② 사용자 set → 늦은 auto 저장: 본문·출처 유지 + 돌려준 항목으로 «안 바뀌었다» 를 알 수 있다
 *  ③ 정상 경로 유지: auto 재발 시각 갱신(본문 그대로) · auto→user 승격 · user→user 수정 · auto→auto 덮어쓰기
 *  ④ 읽은 뒤 사용자가 retire 하면 시각 갱신이 되살리지 않는다
 *
 * ★한계: 플러그인 `failure.ts` 의 «판단 뒤 착지» 갈래는 LLM 판단이 회귀 가드에 막혀(«불확실») 여기서 실행되지 않는다.
 *  그 갈래가 쓰는 계약(②의 돌려준 출처)만 저장소에서 잰다. 재발 갈래는 `growth-failure-path-runs` 가 실제로 돌린다.
 * ★별도 후속 실패가 지워진 지침을 **새로** 만드는 정책은 로드맵 P-a 이고 여기서 닫지 않는다.
 *
 * 등급: **동작**.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { assert, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "user-directive-survives-auto-writes",
  guards:
    "사용자가 확정한 규칙을, 그 전에 읽어 둔 자동 학습이 옛 본문으로 되돌리거나 늦은 자동 저장이 출처를 auto 로 내리던 것",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const md = await import("../../store/self-growth-md.js");
    const { confirmFeedback } = await import("../../core/llm-runtime/capabilities/directives-mcp.js");
    const { getPaths } = await import("../../core/paths.js");
    const K = "regr-protect";
    const snap = async () => {
      const d = await md.getDirective(K);
      return d === null ? null : { text: d.text, source: d.source, updatedAt: d.updatedAt };
    };
    /** 만료 시계를 과거로 돌려 «갱신됐나» 를 시각 경합 없이 잰다. */
    const ageAll = () => {
      const f = getPaths().selfGrowthMd;
      writeFileSync(f, readFileSync(f, "utf8").replace(/"updatedAt":\d+/g, `"updatedAt":1000`));
    };

    // ① 자동이 읽어 둔 뒤 사용자가 고친다 → 옛 방식 되쓰기(출처 생략)와 새 방식 시각 갱신 둘 다 사용자 값을 못 건드린다
    await md.upsertDirective({ key: K, text: "AUTO_OLD", source: "auto", group: "failure" });
    const stale = await md.getDirective(K);
    const userSet = await confirmFeedback({ key: K, text: "USER_NEW" });
    await md.upsertDirective({ key: K, text: stale?.text ?? "", group: stale?.group });
    const afterRewrite = await snap();
    await md.touchDirective(K);
    const afterTouch = await snap();
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
    ageAll();
    const touched = await md.touchDirective(K);
    const autoTouched = await snap();
    const promote = await confirmFeedback({ key: K, text: "USER_1" });
    const promoted = await snap();
    const edit = await confirmFeedback({ key: K, text: "USER_2" });
    const edited = await snap();
    await md.deleteDirective(K);

    // ④ 읽은 뒤 retire → 시각 갱신이 되살리지 않는다
    await md.upsertDirective({ key: K, text: "AUTO_GONE", source: "auto" });
    await md.getDirective(K);
    const retire = await confirmFeedback({ key: K, action: "retire" });
    const touchGone = await md.touchDirective(K);
    const afterGone = await snap();

    return [
      assert(
        "★① 자동이 읽어 둔 옛 본문을 사용자 확정 뒤에 되써도 사용자 본문·출처가 남는다(재발 시각 갱신도 마찬가지)",
        !userSet.isError &&
          afterRewrite?.text === "USER_NEW" && afterRewrite.source === "user" &&
          afterTouch?.text === "USER_NEW" && afterTouch.source === "user",
        { 되쓰기뒤: afterRewrite, 시각갱신뒤: afterTouch },
      ),
      assert(
        "★② 사용자 확정 뒤 늦은 auto 저장은 본문·출처를 못 바꾸고, 돌려준 항목의 출처로 «안 바뀌었다» 를 알 수 있다",
        afterLate?.text === "USER_KEEP" && afterLate.source === "user" && late?.source === "user" && late.text === "USER_KEEP",
        { 최종: afterLate, 돌려준것: late === null ? null : { text: late.text, source: late.source } },
      ),
      assert(
        "③ 정상 경로는 그대로 — auto 끼리 덮어쓰기 · 재발 시각 갱신(본문 그대로) · auto→user 승격 · user→user 수정",
        autoOverwrite?.text === "AUTO_B" && autoOverwrite.source === "auto" &&
          touched !== null && autoTouched?.text === "AUTO_B" && (autoTouched.updatedAt ?? 0) > 1000 &&
          !promote.isError && promoted?.text === "USER_1" && promoted.source === "user" &&
          !edit.isError && edited?.text === "USER_2" && edited.source === "user",
        { autoOverwrite, autoTouched, promoted, edited },
      ),
      assert(
        "★④ 읽은 뒤 사용자가 내린 지침을 재발 시각 갱신이 되살리지 않는다",
        !retire.isError && touchGone === null && afterGone === null,
        { retire: retire.text, 갱신결과: touchGone, 최종: afterGone },
      ),
    ];
  },
};

export default check;
