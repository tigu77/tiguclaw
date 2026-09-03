/**
 * 회귀: **한 종류가 다른 종류를 밀어내지 못한다 + «읽음» 과 «검색에 걸림» 을 가른다**
 * (2026-09-02).
 *
 * ★실측이 문제를 선명하게 보여줬다. 한 통에 넣고 `access_count` 로 줄 세운 결과:
 *  - 1~3위가 전부 **기계가 만든** `feedback_growth_*`(455 / 450 / 309)
 *  - 「사용자를 '정태님'이라고 부른다」는 **193위 / 197건**
 *  - `user`(사람 사실) 10건은 인덱스의 2.7% 인데 순위는 20위·193위로 흩어짐
 *
 * ★원인이 둘이고 **각각 다른 결함**이다:
 *  ① **신호가 거꾸로였다.** `searchMemories`(매 턴 도는 자동 검색)가 히트마다 카운트를
 *    올렸다 → 기계 메모리는 흔한 낱말을 담아 계속 걸리고, 걸릴 때마다 올라 눌러앉는
 *    **자기강화 루프**. 게다가 방향이 반대다 — **검색으로 찾혔다는 건 인덱스 상주가
 *    필요 없다는 증거**인데 그걸 상주 점수로 쓰고 있었다.
 *  ② **자리를 안 나눴다.** 빈도로 줄 세우면 «기계가 쓰고 기계가 읽는» 것이 사람 사실을
 *    구조적으로 이긴다. 순서를 바꿔 풀 문제가 아니라 **몫을 나눠야** 하는 문제다.
 *
 * ★★옛 카운트는 **안 지운다**(사용자 데이터). 그래서 ①만으로는 한동안 왜곡이 남고,
 *  ②가 그 사이를 막는다 — 자동생성이 아무리 뜨거워도 제 몫을 넘어 남의 자리를 못 뺏는다.
 *  **둘이 한 쌍이라 한 검사에 둔다.**
 *
 * 등급: **동작** — 실제 DB 에 픽스처를 넣고 인덱스를 만들어 본다.
 */
import { getDb, initStore } from "../../store/sessions.js";
import { addMemory, getMemory, listMemoriesForIndex, searchMemories } from "../../store/memory.js";
import { assert, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "memory-index-per-type-budget",
  guards:
    "한 통에 넣고 access_count 로 줄 세워 기계가 만든 메모리가 1~3위를 차지하고 「사용자 호칭」이 193/197위로 밀리던 것 + 자동 검색 히트가 카운트를 올려 «검색으로 찾혔다=상주 불필요» 라는 신호를 거꾸로 세던 것(2026-09-02)",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    initStore();
    const db = getDb();
    db.prepare(`DELETE FROM memories`).run();

    // 기계 생성분이 «뜨겁게» 쌓인 상태를 재현한다.
    const big = "설명".repeat(12); // 한 줄 ≈ 100B — 몫 안에 여러 개가 들어가야 «경쟁» 이 성립한다
    for (let i = 0; i < 12; i += 1) {
      addMemory({ type: "feedback", name: `feedback_growth_auto_${String(i)}`, description: big, body: "b" });
    }
    // 사람이 쓴 사실 — 작고, 거의 안 읽히지만 매 턴 필요하다.
    addMemory({ type: "user", name: "user-name-jungtae", description: "호칭은 정태님", body: "b" });
    addMemory({ type: "user", name: "user-hobby", description: "취미는 등산", body: "b" });
    addMemory({ type: "project", name: "proj-a", description: big, body: "b" });

    // 기계분을 압도적으로 뜨겁게(실측의 455 대 2 를 흉내낸다).
    db.prepare(`UPDATE memories SET access_count = 500 WHERE name LIKE 'feedback_growth_%'`).run();
    db.prepare(`UPDATE memories SET access_count = 2 WHERE name = 'user-name-jungtae'`).run();

    // 캡을 좁혀 «경쟁» 을 강제한다 — 넉넉하면 아무것도 안 잘려 검사가 공짜 초록이다.
    const CAP = 6_000; // auto 몫 600B ≈ 4~5줄 — 12건 중 일부만 실려야 한다
    const r = listMemoriesForIndex(CAP);
    const has = (n: string): boolean => r.lines.some((l) => l.includes(n));
    const autoLines = r.lines.filter((l) => l.includes("feedback_growth_auto_")).length;
    let hugeIn = false;
    let seenTypes: string[] = [];

    // ── 신호: 검색 히트는 카운트를 안 올린다 ────────────────────────────────
    const before = getMemory("user-hobby")?.name; // 명시적 fetch 1회(오늘치)
    const c1 = db.prepare(`SELECT access_count c FROM memories WHERE name='user-hobby'`).get() as { c: number };
    searchMemories("등산", 5);
    const c2 = db.prepare(`SELECT access_count c FROM memories WHERE name='user-hobby'`).get() as { c: number };
    getMemory("user-hobby"); // 같은 날 두 번째 fetch
    const c3 = db.prepare(`SELECT access_count c FROM memories WHERE name='user-hobby'`).get() as { c: number };

    return [
      assert(
        "★캡이 실제로 좁아 경쟁이 일어났다(안 잘리면 아래는 공짜 초록이다)",
        r.truncated > 0,
        `실림 ${String(r.lines.length)}건 · 잘림 ${String(r.truncated)}건`,
      ),
      assert(
        "★★기계 생성분이 **제 몫만** 쓴다 — 500회짜리 12건이 통째로 앞을 먹지 못한다",
        autoLines > 0 && autoLines < 12,
        `자동생성 ${String(autoLines)}/12건만 실림`,
      ),
      assert(
        "★★몫이 비면 **첫 항목은 크더라도 들인다** — 안 그러면 그 종류가 통째로 사라진다",
        (() => {
          // `reference` 하나만, 자기 몫보다 크게 만든다.
          addMemory({ type: "reference", name: "ref-huge", description: "참".repeat(400), body: "b" });
          hugeIn = listMemoriesForIndex(CAP).lines.some((l) => l.includes("ref-huge"));
          return hugeIn;
        })(),
        hugeIn ? "몫(600B) 초과 1,200B 항목도 실림" : "★굶었다 — reference 가 통째로 0",
      ),
      assert(
        "★★access 2회짜리 **사용자 호칭이 살아남는다** — 이게 193위였던 그 항목이다",
        has("user-name-jungtae"),
        has("user-name-jungtae") ? "실림" : "★밀려남 — 몫이 안 지켜졌다",
      ),
      assert(
        "★허용된 네 종류가 **각자 자리를 갖는다** — DB 가 `CHECK (type IN …)` 로 넷만 받는다",
        (() => {
          seenTypes = [
            ...new Set(
              listMemoriesForIndex(64 * 1024).lines.map((l) => /^- \[([a-z]+)\]/.exec(l)?.[1]),
            ),
          ].filter((t): t is string => t !== undefined);
          return ["user", "project", "feedback"].every((t) => seenTypes.includes(t));
        })(),
        `실린 종류: ${seenTypes.join(", ")}`,
      ),
      // ── 신호 분리 ────────────────────────────────────────────────────────
      assert(
        "★★검색 히트는 **카운트를 안 올린다** — 낱말로 찾혔다는 건 상주가 필요 없다는 증거다",
        c1.c === c2.c && before === "user-hobby",
        `fetch 후 ${String(c1.c)} → 검색 후 ${String(c2.c)}`,
      ),
      assert(
        "★★같은 날 두 번째 fetch 도 안 올린다 — raw 횟수는 대화 길이지 가치가 아니다",
        c3.c === c1.c,
        `2회차 후 ${String(c3.c)} (1회차 ${String(c1.c)})`,
      ),
    ];
  },
};
