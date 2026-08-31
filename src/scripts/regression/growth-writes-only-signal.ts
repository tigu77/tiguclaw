/**
 * 회귀: **자가성장은 신호가 있을 때만 기억에 쓴다** (2026-08-31).
 *
 * ★사고(실측): 주간 회고가 **신호 0이어도 무조건** 기억을 만들었다. 그래서 *"segment 0건,
 *  drift 0건"* 이라는 **무내용 항목이 매주 한 건씩** 인덱스에 적립됐다 — 6건 중 **4건이
 *  읽힘 0**, 연 52건 페이스, 바운드 없음. 본문은 스스로 *"이번 주 신호 0 — 정상 운영"*
 *  이라고 적으면서 자리를 차지했다.
 *
 * ★왜 결함인가: 기억 인덱스는 **캡이 있는 자리**다(40,960B). 거기에 아무도 안 읽는 항목이
 *  매주 쌓이면 **읽혀야 할 것을 밀어낸다** — 실측으로 캡 밖에 밀린 것 중에 사용자가 준
 *  말투 규칙(`style-use-emojis-moderately`)이 있었다
 *  ([[project_hotpath_bound_preserve_record]] 의 "캡 있는 자리" 그대로).
 *
 * ★**기록을 지우는 게 아니다** — 애초에 안 만드는 것이다. 신호가 있으면 그대로 쓴다.
 * ★그리고 **안 썼으면 «추가됨» 을 알리지 않는다** — 계약을 바꿨으니 호출부까지 봤다
 *  ([[feedback_scope_of_a_fix]]). 안 쓰고 이벤트만 내면 그게 거짓말이다.
 *
 * 등급: **동작** — 격리 홈에서 실제로 돌리고 기억이 늘었는지 센다.
 */
import { assert, loadPluginModule, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "growth-writes-only-signal",
  guards:
    "주간 회고가 신호 0이어도 매주 기억을 만들어, 아무도 안 읽는 무내용 항목이 캡 있는 인덱스에 무한 적립되던 것(실측 6건 중 4건 읽힘 0) — 그 자리는 사용자가 준 말투 규칙을 밀어냈다",
  run: async (): Promise<Assertion[]> => {
    // ★**홈을 새로 만들지 않는다** — 스위트가 이미 격리 홈을 준다. 첫 판은 여기서
    //  `process.env.TIGUCLAW_HOME` 을 갈아끼웠고, 그게 **다른 검사를 깨뜨렸다**
    //  (`history-inflight-turn` 이 "격리 홈에서만 돈다" 며 던졌다). 검사가 전역을 바꾸면
    //  그 검사만 틀리는 게 아니라 **뒤따르는 전부가 오염된다.**
    const { listMemories, addMemory } = await import("../../store/memory.js");
    // 리터럴 지정자는 tsc 가 정적으로 따라가 `npm run build` 를 깨뜨린다 — 계산해서 부른다.
    const { generateWeeklyReview } = await loadPluginModule<{
      generateWeeklyReview: (
        force?: boolean,
      ) => { reviewName: string; segmentCount: number; driftCount: number; written: boolean } | null;
    }>("../../../plugins/self-growth/src/efficiency.ts");

    // ① 신호 0 — 빈 기계에서 돌린다.
    // ★**회고만 센다** — 처음엔 feedback 전체를 셌는데, ②에서 내가 심은 픽스처 때문에
    //  개수가 늘어 *"아무것도 안 쓰는"* 변이가 통과했다. 세는 대상이 판정을 흐리면 안 된다.
    const reviews = (): number =>
      listMemories({ type: "feedback", limit: 10000 }).filter((m) =>
        m.name.startsWith("feedback_growth_weekly_review_"),
      ).length;
    const before = reviews();
    const quiet = generateWeeklyReview(true);
    const afterQuiet = reviews();
    // ★**여기가 판정 자리다** (적대 검토 P2). 방금 «봤지만 안 썼다». 이 시점엔 회고 메모가
    //  **0** 이므로, 가드가 «메모리가 있나» 로 서면 **또 돈다**. «봤나» 로 서야 skip 한다.
    //  ★처음엔 이 두 줄을 신호 케이스 **뒤에** 뒀는데, 그때는 이미 회고가 하나 있어서
    //   **옛 가드도 통과**했다 — 픽스처 상태가 판정을 흐린 것이다. 순서가 곧 판정이다.
    const guardAfterQuiet = generateWeeklyReview(false);

    // ② 신호 있음 — segment reflection 을 하나 심고 다시 돌린다.
    addMemory({
      type: "feedback",
      // ★접두사는 **실물에서 확인한 것**이다(`feedback_growth_reflection_segment_`).
      //  첫 판은 짐작으로 `_segment_` 를 썼고 필터에 안 걸려 "반대 방향" 단언이 거짓 실패했다.
      name: "feedback_growth_reflection_segment_probe",
      description: "탐침용 segment reflection",
      body: "{}",
    });
    const loud = generateWeeklyReview(true);
    const afterLoud = reviews();

    return [
      assert(
        "★★신호가 0이면 **기억을 만들지 않는다** — 무내용 항목이 캡 있는 자리에 매주 쌓이면 읽혀야 할 것을 밀어낸다",
        afterQuiet === before && quiet?.written === false,
        `전 ${String(before)} → 후 ${String(afterQuiet)} · written=${String(quiet?.written)}`,
      ),
      assert(
        "★★반대 방향 — **신호가 있으면 그대로 쓴다**(전부 안 쓰면 자가성장이 죽는다)",
        afterLoud > afterQuiet && loud?.written === true,
        `${String(afterQuiet)} → ${String(afterLoud)} · written=${String(loud?.written)}`,
      ),
      assert(
        "★안 썼으면 **«추가됨» 을 알리지 않는다** — 계약이 바뀌면 호출부까지 본다(안 쓰고 이벤트만 내면 거짓말이다)",
        quiet !== null && quiet.written === false && loud !== null && loud.written === true,
        `조용=${String(quiet?.written)} · 신호=${String(loud?.written)}`,
      ),
      assert(
        "★★**안 썼어도 다시 안 본다** — 멱등 가드가 «메모리가 있나» 가 아니라 «봤나» 로 선다. 안 그러면 조용한 인스턴스에서 주 1회이던 회고가 시간당 1회가 되고, 매시 기억 전량 스캔이 따라온다",
        guardAfterQuiet === null && afterQuiet === before,
        `회고 ${String(afterQuiet)}건인 상태에서 재호출 = ${guardAfterQuiet === null ? "skip ✅" : "★또 돎"}`,
      ),
    ];
  },
};
