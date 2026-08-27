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
    // ★판정이 접두가 아니라 **세션 존재**로 바뀌었다(2026-08-27 F1) — 대화 축은 실제
    //  `threads` 행이 있어야 레코드다. 손 목록이 사라진 대가로 픽스처가 이 한 줄만큼 커진다.
    const { getDb } = await import("../../store/sessions.js");
    getDb()
      .prepare(
        "INSERT OR IGNORE INTO threads (channel, channel_thread_id, claude_session_id, last_used_at, created_at) VALUES (?,?,?,?,?)",
      )
      .run("dashboard", "dashboard:default", "sid-fairness", 1, 1);
    // 희귀 단서를 **먼저** 넣는다(가장 오래된 = 종전 규칙이면 제일 먼저 밀려나는 자리).
    for (let i = 0; i < 5; i++) {
      insertEvent(1000 + i, "llm.turn_error", JSON.stringify({ i }));
      insertEvent(2000 + i, "worker.interrupted", JSON.stringify({ i }));
    }
    // 그 뒤에 잦은 활동을 상한의 몇 배로 쏟아붓는다.
    // ★`threadKey` 를 **잡 좌표로** 준다 (2026-08-27). `llm.activity` 는 두 축을 겸하는데
    //  프루닝이 이제 **휘발성 축(worker:/agent:/gateway:)만** 자른다 — 대화 축은 레코드다.
    //  이 검사가 묻는 것은 *"잦은 것이 희귀 단서를 밀어내지 않는가"* 이고, 그 "잦은 것" 의
    //  실체가 바로 잡 스텝이다(실측 70%). 좌표 없이 넣으면 **안 잘리는 축**을 상대로
    //  "잘리는가" 를 묻게 돼 검사가 자기 질문을 잃는다.
    for (let i = 0; i < KEEP * 3; i++) {
      insertEvent(10_000 + i, "llm.activity", JSON.stringify({ i, threadKey: "worker:flood" }));
    }
    // ★대화 축도 함께 넣어 **안 잘리는 것까지** 본다 — 한쪽만 보면 다음에 축이 지워져도 초록이다.
    for (let i = 0; i < KEEP * 2; i++) {
      insertEvent(50_000 + i, "llm.activity", JSON.stringify({ i, threadKey: "dashboard:default" }));
    }
    pruneEvents(KEEP);
    const errs = listEvents({ types: ["llm.turn_error"], limit: 50 }).length;
    const wks = listEvents({ types: ["worker.interrupted"], limit: 50 }).length;
    const all = listEvents({ types: ["llm.activity"], limit: 10_000 });
    const acts = all.filter((e) => e.payload.includes("worker:flood")).length;
    const records = all.filter((e) => e.payload.includes("dashboard:default")).length;
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
        "고volume 타입의 **휘발성 축**은 자기 몫으로 잘린다(무한 증가 0)",
        acts > 0 && acts <= KEEP,
        `잡 스텝 ${acts}건 ≤ ${KEEP}`,
      ),
      assert(
        "프루닝이 실제로 뭔가 지웠다(no-op 아님)",
        acts < KEEP * 3,
        `${KEEP * 3} → ${acts}`,
      ),
      // ★같은 타입인데 **안 잘려야 하는 축** — 대화의 도구 스텝은 레코드다(2026-08-27).
      //  이걸 같이 안 보면 축 구분을 지워도 위 두 단언은 그대로 초록이다.
      assert(
        "★대화 축(도구 스텝)은 같은 타입이어도 안 잘린다",
        records === KEEP * 2,
        `${records}/${KEEP * 2}건 생존 — 줄었으면 옛 대화에서 도구가 사라진다`,
      ),
    ];
  },
};
