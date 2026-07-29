/**
 * 회귀: **한 번에 접는 히스토리를 바이트로 묶는다** (2026-07-29).
 *
 * 사고(사용자 신고 "진행한다고 말해놓고 진행을 안 해", 전부 codex):
 *  1. 압축 계획이 **턴 수만** 보고 바이트 상한이 없었다.
 *  2. 오래 산 스레드에서 666턴 = **2,838,563자**를 한 번에 요약하라고 보냈다(실측).
 *  3. 컨텍스트를 한참 넘겨 **빈 응답** → 요약 미저장 → watermark 그대로.
 *  4. 다음 턴에 **같은 280만 자를 또** 보낸다 = 매 턴 1회씩 영원히 실패(로그의
 *     "[codex 6b] 요약 호출이 빈 결과" 가 턴마다 찍힌 이유).
 *  5. 그 사이 히스토리는 oldest-drop 으로 잘려 모델이 하던 작업의 맥락을 잃고,
 *     사용자에겐 실행 없이 계획만 반복하는 것으로 보였다.
 *
 * 실증: 같은 내용을 9만 자로 나눠 보내니 15.6초에 441자 요약 성공. 크기만이 문제였다.
 * 그래서 "얼마나 많이 접느냐"보다 **진행이 보장되느냐**를 불변식으로 잡는다.
 */
import { planHistoryCompaction } from "../../core/llm-runtime/adapters/openai-codex-oauth-history.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const turns = (n: number, chars: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
    content: "가".repeat(chars),
  }));

const foldedChars = (t: ReadonlyArray<{ content: string }>) =>
  t.reduce((a, x) => a + x.content.length, 0);

export const check: RegressionCheck = {
  name: "history-compaction-budget",
  guards: "거대한 히스토리를 한 번에 요약하려다 매 턴 실패하고 맥락을 잃던 것",
  run: async (): Promise<Assertion[]> => {
    // 실사고 재현 규모: 696턴 · 턴당 ~4천자 → 접기 후보만 2.6M 자.
    const huge = planHistoryCompaction(turns(696, 4000), 0, {
      triggerTurns: 100,
      keepRecent: 30,
    });
    const small = planHistoryCompaction(turns(120, 100), 0, {
      triggerTurns: 100,
      keepRecent: 30,
    });
    // 단일 턴이 예산을 넘어도 진행해야 한다(무진행 = 영구 실패).
    const oversize = planHistoryCompaction(turns(140, 500_000), 0, {
      triggerTurns: 100,
      keepRecent: 30,
      maxFoldChars: 1000,
    });
    return [
      assert("압축이 필요한 상황을 잡는다", huge.needed, String(huge.needed)),
      assert(
        "★한 번에 접는 양이 예산 안(실사고 2,838,563자 → 상한 이하)",
        foldedChars(huge.toFold) <= 100_000,
        `${foldedChars(huge.toFold)}자 / ${huge.toFold.length}턴`,
      ),
      assert(
        "★watermark 가 전진한다(진행 보장 — 같은 입력 무한 재시도 금지)",
        huge.nextWatermark > 0 && huge.toFold.length > 0,
        `watermark=${huge.nextWatermark}`,
      ),
      assert(
        "예산을 넘는 단일 턴도 혼자서 접힌다(무진행 방지)",
        oversize.needed && oversize.toFold.length === 1,
        `${oversize.toFold.length}턴`,
      ),
      assert(
        "작은 스레드는 종전대로 전량 접는다(회귀 0)",
        small.toFold.length === 90 && foldedChars(small.toFold) === 9000,
        `${small.toFold.length}턴 / ${foldedChars(small.toFold)}자`,
      ),
    ];
  },
};
