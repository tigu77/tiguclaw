/**
 * 회귀: **잦은 이벤트가 희귀 이벤트를 밀어내지 않는다** (2026-07-30).
 *
 * 사고: 프루닝이 **전체 건수** 기준이라 `llm.activity` 가 상한을 혼자 채웠다.
 * 실측: events 10,118건 중 8,925건(**88.2%**)이 `llm.activity` → 보존창 **3.8일**.
 * 그 창 안에만 `llm.turn_error`·`worker.*`·`llm.compaction_stuck` 같은 사고 단서가 남는다.
 * 오늘 고친 버그가 **12일** 묻혔던 것을 감안하면 조사 창 4일은 너무 짧다.
 *
 * 그래서 고volume 타입은 자기 몫으로 먼저 자르고, 남는 상한을 희귀 타입이 쓰게 했다.
 */
import { insertEvent, pruneEvents, listEvents } from "../../store/events.js";
import { assert, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "event-retention-fairness",
  guards: "잦은 이벤트가 상한을 혼자 채워 에러·lifecycle 단서를 밀어내던 것",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const KEEP = 100;
    // 희귀 단서를 **먼저** 넣는다(가장 오래된 = 종전 규칙이면 제일 먼저 밀려나는 자리).
    for (let i = 0; i < 5; i++) {
      insertEvent(1000 + i, "llm.turn_error", JSON.stringify({ i }));
      insertEvent(2000 + i, "worker.interrupted", JSON.stringify({ i }));
    }
    // 그 뒤에 잦은 활동을 상한의 몇 배로 쏟아붓는다.
    for (let i = 0; i < KEEP * 3; i++) {
      insertEvent(10_000 + i, "llm.activity", JSON.stringify({ i }));
    }
    pruneEvents(KEEP);
    const errs = listEvents({ types: ["llm.turn_error"], limit: 50 }).length;
    const wks = listEvents({ types: ["worker.interrupted"], limit: 50 }).length;
    const acts = listEvents({ types: ["llm.activity"], limit: 10_000 }).length;
    return [
      assert(
        "★희귀 단서(turn_error)가 활동 폭주에도 살아남는다",
        errs === 5,
        `${errs}/5건 생존`,
      ),
      assert(
        "★lifecycle(worker.interrupted)도 살아남는다",
        wks === 5,
        `${wks}/5건 생존`,
      ),
      assert(
        "고volume 타입은 자기 몫으로 잘린다(무한 증가 0)",
        acts > 0 && acts <= KEEP,
        `${acts}건 ≤ ${KEEP}`,
      ),
      assert(
        "프루닝이 실제로 뭔가 지웠다(no-op 아님)",
        acts < KEEP * 3,
        `${KEEP * 3} → ${acts}`,
      ),
    ];
  },
};
