/**
 * 회귀: **압축 실패가 조용히 반복되지 않는다** (2026-07-29).
 *
 * ★2026-07-29 사고가 **12일간 안 보인 이유**가 정확히 이것이다. 히스토리 요약이 매 턴
 * 실패했고 로그엔 매 턴 경고가 찍혔는데 **아무도 세지 않았다.** 100번 실패해도 101번째에
 * 같은 걸 보낸다. 사용자는 "말만 하고 진행을 안 해"라는 *증상*만 겪었고 원인은 조용히 쌓였다.
 *
 * 크기 문제는 예산으로 닫았지만, **다음에 다른 이유로 실패하면 똑같이 조용할** 구조가
 * 남아 있었다. 그래서 실패 자체를 관측 대상으로 승격했다 — 연속 실패가 임계에 닿으면
 * 이벤트로 올린다. 일시적 흔들림(429·네트워크)은 성공 시 리셋으로 통과시키고 **고착만** 잡는다.
 */
import { noteCompactionOutcome } from "../../core/llm-runtime/adapters/openai-codex-oauth-history.js";
import { getEventBus } from "../../core/eventbus.js";
import { sourceHasCount } from "./_wiring.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "compaction-fail-observability",
  guards: "압축 실패가 매 턴 반복되는데 아무도 세지 않아 12일간 안 보이던 것",
  run: async (): Promise<Assertion[]> => {
    const seen: Array<Record<string, unknown>> = [];
    const unsub = getEventBus().subscribe((e: { type: string; payload?: unknown }) => {
      if (e.type === "llm.compaction_stuck") seen.push((e.payload ?? {}) as Record<string, unknown>);
    });
    const wired = await sourceHasCount(
      "../../core/llm-runtime/adapters/openai-codex-oauth-history.ts",
      /noteCompactionOutcome\(/,
      5,
    );
    const TK = "regr:compaction";
    try {
      noteCompactionOutcome(TK, false, "빈 결과", 1000);
      const after1 = seen.length;
      noteCompactionOutcome(TK, false, "빈 결과", 1000);
      const after2 = seen.length;
      noteCompactionOutcome(TK, false, "빈 결과", 1000); // 임계 도달
      const after3 = seen.length;
      noteCompactionOutcome(TK, false, "빈 결과", 1000); // 그 뒤론 침묵(폭주 방지)
      const after4 = seen.length;
      // 성공하면 리셋 — 일시적 실패는 통과
      noteCompactionOutcome(TK, true, "", 1000);
      noteCompactionOutcome(TK, false, "빈 결과", 1000);
      const afterReset = seen.length;
      return [
        assert("1~2회 실패는 조용히(일시적 흔들림 통과)", after1 === 0 && after2 === 0, `${after1}/${after2}`),
        assert("★3회 연속 실패에서 이벤트가 올라간다", after3 === 1, String(after3)),
        assert("그 뒤로는 재발행 안 함(로그 폭주 방지)", after4 === 1, String(after4)),
        assert("성공하면 카운터가 리셋된다", afterReset === 1, String(afterReset)),
        assert(
          "이벤트에 진단 정보가 실린다(스레드·연속횟수·크기·사유)",
          typeof seen[0]?.threadKey === "string" &&
            seen[0]?.streak === 3 &&
            typeof seen[0]?.foldChars === "number" &&
            typeof seen[0]?.reason === "string",
          JSON.stringify(seen[0] ?? {}),
        ),
        assert(
          // ★배선 확인 — 순수 계약만 보면 호출부 6곳을 각각 지워도 초록이었다(감사 실측).
          "★호출부가 살아있다(성공·빈결과·예외·수동 경로)",
          wired.ok,
          `noteCompactionOutcome 호출 ${wired.found}회`,
        ),
      ];
    } finally {
      if (typeof unsub === "function") unsub();
    }
  },
};
