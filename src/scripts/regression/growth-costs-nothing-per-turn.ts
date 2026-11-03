/**
 * 회귀: **자가성장은 매 턴 비용이 0이고, 자기 카운터를 올리지 않는다** (2026-09-05 재구성).
 *
 * 사용자 질문(*"자가성장 교훈 시스템이 잘 되어 있나 · 메모리 적재도 꼭 필요할까?"*)에서
 * DB 를 열어 나온 것 둘:
 *
 * ①**자기부풀림.** `bumpAccess` 의 호출처는 **단 하나**(`getMemory`)인데, self-growth 가
 *   «이미 박았나?» 를 묻는 **멱등 검사 12곳**에서 그 문을 썼다. 그래서 자기가 쓴 메모리의
 *   `access_count` 를 자기가 올렸다 — 실측 상위 769·455·450회. 인덱스 정렬이 **hot-first**
 *   라 그 부풀림이 곧 **자기 산출물을 인덱스 상석에 올리는 힘**이 됐다(캡 25.6KB 의 84% 가
 *   찬 자리에서 사람이 쓴 규범을 밀어냈다). 판정은 판정이어야 한다 — 세는 행위가 재는
 *   대상을 바꾸면 그건 계측이 아니다.
 *
 * ②**자리.** 제안은 «한 번 닿으면 되는 것» 인데 «매 턴 실리는 자리» 에 있었다. 실측:
 *   살아있는 성장 메모리 24건 = 3,568B = 인덱스 원재료의 **16.5%**, 그 상태로 4개월간
 *   확정 지침 **0건**. 이 레포가 두 번 적어둔 규칙이 정확히 여기다 — *"자리는 중요도가
 *   아니라 «매 턴 필요한가» 로 정한다"* · *"캡 있는 자리에 반드시 도달해야 할 것을 두지
 *   마라"*([[project_hotpath_bound_preserve_record]]).
 *
 * ★2026-08-02 의 «재발 시 갱신으로 인덱스에 남긴다» 는 증상 처방이었다(캡 있는 자리에
 *  계속 두면서 들어가게 만들었다). 이 검사는 **그 되돌림을 막는다** — 다시 인덱스로
 *  올리려면 이 단언들을 먼저 지워야 한다.
 *
 * ★2026-11-03 자가성장 플러그인 제거: 플러그인 소스를 훑던 단언(멱등 검사=peek · 박는 문=내리는 문 · 포인터 메모 없음 ·
 *  빈 원인 미기록)은 대상과 함께 지웠다. 남는 것은 **코어의 문**이다 — access 를 올리는 문은 하나 · 세지 않고 보는 문 ·
 *  `/status` 의 한 번 도달 · 쓰기 전 확인이 카운터를 안 올린다(동작).
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readEntrySource } from "./_wiring.js";
import { assert, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export const check: RegressionCheck = {
  name: "growth-costs-nothing-per-turn",
  guards:
    "쓰기 전 «있었나» 확인이 자기 access 를 올려 인덱스 상석을 차지하던 것(자기부풀림) + 내려둔 것의 도달 경로(`/status`)가 사라지는 것",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const out: Assertion[] = [];

    // ── ① 계측이 계측을 바꾸지 않는다 ─────────────────────────────────────────
    const store = readFileSync(path.join(REPO, "src/store/memory.ts"), "utf8");
    // 정의는 `const bumpAccess = (` 라 아래 패턴에 안 걸린다 — 호출만 센다.
    const bumpSites = [...store.matchAll(/\bbumpAccess\(db/g)].length;
    out.push(
      assert(
        "access 를 올리는 문은 여전히 하나다(늘면 어디서 세는지 추적이 끊긴다)",
        bumpSites === 1,
        `bumpAccess 호출 ${bumpSites}곳`,
      ),
    );
    out.push(
      assert(
        "세지 않고 보는 문이 있다(peekMemory)",
        /export const peekMemory/.test(store),
        /export const peekMemory/.test(store) ? "있음" : "★없음",
      ),
    );

    // ── ③ 도달은 «매 턴» 이 아니라 «한 번» 이다 ───────────────────────────────
    // 진입 경로 전체(진입점 + core/entry) — `/status` 본문이 옮겨갔다(구조 감사 ③).
    const index = readEntrySource();
    out.push(
      assert(
        "★내려둔 것이 쌓이면 `/status` 가 한 번 말한다(안 실리는 대신 도달은 남긴다)",
        /countArchivedMemories\(\)/.test(index) && /미열람/.test(index),
        /countArchivedMemories\(\)/.test(index) ? "status 줄 있음" : "★도달 경로가 없다",
      ),
    );
    out.push(
      assert(
        "그 줄은 이름을 모른다(코어가 플러그인 이름을 하드코딩하지 않는다 — §0 단방향)",
        !/countArchivedMemories[\s\S]{0,400}feedback_growth/.test(index),
        `countArchivedMemories 주변 400자에 growth 접두=${/countArchivedMemories[\s\S]{0,400}feedback_growth/.test(index)}`,
      ),
    );

    // ── ★«쓰기 전 확인» 이 접근 카운터를 올리지 않는다 — **동작으로** (2026-09-06) ──
    //  (종전) 플러그인 스캔은 자가성장 플러그인 소스 **한 디렉터리만** 봤다. 그래서 정작 코어의 문
    //  (`memory-mcp.ts addMemoryWithGuard`)은 범위 밖이었고, 거기서 `peekMemory` 를
    //  `getMemory` 로 되돌려도 **2,928건이 초록**이었다(변이로 확인).
    //  ★손으로 고른 디렉터리가 판정 범위이면 그 밖은 안 보인다
    //   ([[feedback_hand_maintained_lists]]). 그리고 이건 **4개월 묻혔던 부류**다 —
    //   되돌아가면 `save_memory` 할 때마다 그 메모리가 자기 access 를 올려 hot-first
    //   인덱스 상석을 자기가 차지한다.
    //  ★그래서 소스를 넓히는 대신 **문을 실제로 두드린다** — 어떤 함수를 쓰든 «카운터가
    //   안 오른다» 는 성질만 본다. 구현이 바뀌어도 성질은 그대로 검사된다.
    const prevHome = process.env.TIGUCLAW_HOME;
    const home = mkdtempSync(path.join(tmpdir(), "growth-guard-"));
    process.env.TIGUCLAW_HOME = home;
    try {
      const { __resetPathsCache } = await import("../../core/paths.js");
      __resetPathsCache?.();
      const { initStore } = await import("../../store/sessions.js");
      initStore();
      const { addMemoryWithGuard } = await import("../../core/memory-mcp.js");
      const { archiveMemory, countArchivedMemories } = await import("../../store/memory.js");

      // ★`Memory` 는 `access_count` 를 노출하지 않는다. 그래서 **공개 API 로 관측 가능한
      //  형태**로 본다 — 아카이브하면 `countArchivedMemories().unread` 가 `access_count = 0`
      //  인 것만 센다. 카운터가 올랐으면 «미열람» 에서 빠진다.
      const NAME = "feedback_guard_probe";
      await addMemoryWithGuard({ type: "feedback", name: NAME, description: "첫 기록", body: "{}" });
      // 같은 이름으로 두 번 더 쓴다 — «있었나» 확인이 매번 일어난다.
      await addMemoryWithGuard({ type: "feedback", name: NAME, description: "갱신 1", body: "{}" });
      await addMemoryWithGuard({ type: "feedback", name: NAME, description: "갱신 2", body: "{}" });
      archiveMemory(NAME);
      const c = countArchivedMemories();
      out.push(
        assert(
          "★★쓰기 전 «있었나» 확인이 접근 카운터를 안 올린다 — 올리면 그 메모리가 자기 인덱스 상석을 만들고(자기부풀림) «미열람» 신호도 죽는다",
          c.unread === 1 && c.total === 1,
          `쓰기 3회 뒤 아카이브 ${c.total}건 중 미열람 ${c.unread}${c.unread === 1 ? "" : " ★카운터가 올랐다"}`,
        ),
      );
    } finally {
      if (prevHome === undefined) delete process.env.TIGUCLAW_HOME;
      else process.env.TIGUCLAW_HOME = prevHome;
      rmSync(home, { recursive: true, force: true });
    }

    return out;
  },
};
export default check;
