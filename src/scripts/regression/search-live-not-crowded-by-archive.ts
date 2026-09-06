/**
 * 회귀: **아카이브가 쌓여도 살아 있는 기억이 검색에서 밀리지 않는다** (2026-09-06 정태님).
 *
 * 기제: 이 레포의 정리 정책은 «지우지 않는다 — 아카이브한다»(`skills/memory-tidy` 하드룰).
 * 그래서 아카이브는 **단조 증가**한다. 그런데 `searchMemories` 는 아카이브를 포함하고
 * (그게 콜드 메모리의 도달 경로다), 그 검색을 `retrieveContext` 가 **매 턴** 부른다.
 * 그대로 두면 언젠가 상위 칸을 옛것이 먹고 **모델이 매 턴 옛것을 본다.**
 *
 * ★**«언제 그 날이 오나» 를 지켜보지 않는다** — 정태님 지적: *"시스템적으로 보완을 해야지,
 *  언제 발생할지는 유저마다 다를 테니까."* 실측(2026-09-06 이 기계): 230건 중 아카이브
 *  53건이고 어휘 넷에서 매칭 아카이브 0건 — **이 기계는** 여유가 있다. 그 여유를 근거로
 *  두면 다른 사용자에게는 이미 온 뒤다. 그래서 임계가 아니라 **불변식**으로 막는다.
 *
 * ★상수는 «1» 하나이고 그건 «0 이 아니다» 라는 뜻이다 — 직감으로 고른 임계가 아니다
 *  ([[project_prompt_prefix_cache_position]] 「임계를 직감으로 정하지 마라」).
 */
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { mergeSearchHits } from "../../store/memory.js";

const L = (n: number): string[] => Array.from({ length: n }, (_, i) => `live${i}`);
const A = (n: number): string[] => Array.from({ length: n }, (_, i) => `arch${i}`);

export const check: RegressionCheck = {
  name: "search-live-not-crowded-by-archive",
  guards:
    "정리 정책이 «지우지 않는다» 라 아카이브가 단조 증가하는데, 검색이 아카이브를 포함하고 그 검색을 매 턴 컨텍스트가 부른다 — 언젠가 상위 칸을 옛것이 먹어 모델이 매 턴 옛것을 보게 되던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];

    // ── ① 아카이브가 아무리 많아도 live 를 밀지 못한다 ────────────────────────
    //  이게 이 검사의 본체다. 아카이브 1,000건은 «오래 쓴 사용자» 를 뜻한다.
    const flood = mergeSearchHits(L(10), A(1000), 10);
    const liveKept = flood.filter((x) => x.startsWith("live")).length;
    out.push(
      assert(
        "★★아카이브 1,000건이 있어도 살아 있는 기억이 상위를 지킨다(≥ 9/10) — 매 턴 컨텍스트가 이 결과를 먹는다",
        liveKept >= 9,
        `live ${liveKept}/10 · 결과: ${flood.slice(0, 4).join(", ")}…`,
      ),
    );

    // ── ② 그래도 아카이브는 도달 가능하다 — 최소 한 칸 ───────────────────────
    //  «검색으로는 계속 찾힌다» 가 아카이브의 존재 이유다. live 가 칸을 다 써도 죽으면 안 된다.
    const archKept = flood.filter((x) => x.startsWith("arch")).length;
    out.push(
      assert(
        "★live 가 칸을 다 채워도 아카이브가 최소 한 칸은 나온다 — 안 그러면 «검색으로 찾힌다» 가 조용히 죽는다",
        archKept >= 1,
        `아카이브 ${archKept}칸 · 마지막 원소 ${flood[flood.length - 1]}`,
      ),
    );

    // ── ③ live 가 적으면 아카이브가 나머지를 채운다(빈 칸을 낭비하지 않는다) ──
    const sparse = mergeSearchHits(L(2), A(50), 10);
    out.push(
      assert(
        "live 가 적으면 아카이브가 남은 칸을 채운다(빈 칸을 낭비하지 않는다)",
        sparse.length === 10 && sparse.filter((x) => x.startsWith("live")).length === 2,
        `${sparse.length}칸 · live 2 + 아카이브 ${sparse.filter((x) => x.startsWith("arch")).length}`,
      ),
    );

    // ── ④ 아카이브가 없으면 종전과 똑같다(무회귀) ────────────────────────────
    const none = mergeSearchHits(L(10), [], 10);
    out.push(
      assert(
        "아카이브 매칭이 없으면 종전 동작 그대로다",
        none.length === 10 && none.every((x) => x.startsWith("live")),
        `${none.length}칸 전부 live=${none.every((x) => x.startsWith("live"))}`,
      ),
    );

    // ── ⑤ 가장자리 — 한도 1, 0, 양쪽 비었을 때 ───────────────────────────────
    const edges = [
      ["limit 1 · 양쪽 있음", mergeSearchHits(L(5), A(5), 1), 1],
      ["limit 0", mergeSearchHits(L(5), A(5), 0), 0],
      ["둘 다 없음", mergeSearchHits([], [], 10), 0],
      ["live 만 없음", mergeSearchHits([], A(3), 10), 3],
    ] as const;
    const bad = edges.filter(([, got, want]) => got.length !== want);
    out.push(
      assert(
        "가장자리에서 칸 수가 어긋나지 않는다",
        bad.length === 0,
        edges.map(([n, g]) => `${n}=${g.length}`).join(" · "),
      ),
    );

    // ── ⑥ ★★배선 — `searchMemories` 가 그 불변식을 **실제로 지난다** ──────────
    //  순수 함수만 재면 배선이 빠진다. 실제로 확인했다: 검색을 종전처럼 한 쿼리로
    //  되돌리는 변이가 **위 ①~⑤ 를 전부 통과**했다. 오늘 이 레포가 반복해서 맞은 병이다
    //  («순수 함수는 재는데 이음매는 안 잰다»). 그래서 **DB 를 세워 실제로 검색한다.**
    const prevHome = process.env.TIGUCLAW_HOME;
    const home = mkdtempSync(path.join(tmpdir(), "srch-"));
    process.env.TIGUCLAW_HOME = home;
    try {
      const { __resetPathsCache } = await import("../../core/paths.js");
      __resetPathsCache?.();
      const { initStore } = await import("../../store/sessions.js");
      initStore();
      const { addMemory, archiveMemory, searchMemories } = await import("../../store/memory.js");

      // 같은 낱말로 매칭되는 «오래 쓴 사용자» 를 만든다: 아카이브 40 · 살아 있는 것 5.
      for (let i = 0; i < 40; i += 1) {
        const n = `arch_widget_${i}`;
        addMemory({ type: "reference", name: n, description: "대시보드 위젯 배치 규칙", body: "대시보드 위젯" });
        archiveMemory(n);
      }
      for (let i = 0; i < 5; i += 1) {
        addMemory({
          type: "feedback",
          name: `live_widget_${i}`,
          description: "대시보드 위젯 배치 규칙",
          body: "대시보드 위젯",
        });
      }
      // ★검사어는 **3글자 이상**이어야 한다 — `queryToTrigrams` 가 3글자 미만 낱말을 버린다.
      //  첫 판이 "위젯"(2글자)이라 무변이에서도 0칸이었다(검사가 틀렸지 코드가 아니다).
      // ── ⑥-A 자동 경로(기본) — 아카이브가 **아예 안 나온다** ────────────────
      //  정태님 지적: *"매 턴 검색에 아카이브한 게 나올 이유가 있나."* 없다 —
      //  스스로 돌아오지 않으니(실행 확인) 자리만 먹고 «내렸다» 는 결정을 반쯤 무른다.
      const auto = searchMemories("대시보드", 8);
      const autoArch = auto.filter((m) => m.name.startsWith("arch_")).length;
      const autoLive = auto.filter((m) => m.name.startsWith("live_")).length;
      out.push(
        assert(
          "★★매 턴 자동 검색(기본)에는 아카이브가 안 나온다 — 돌아오지도 않는데 자리만 먹는다",
          autoArch === 0 && autoLive === 5,
          `아카이브 ${autoArch}칸(기대 0) · live ${autoLive}/5`,
        ),
      );

      // ── ⑥-B 명시 경로(옵트인) — 아카이브가 나오되 live 를 안 민다 ──────────
      const opted = searchMemories("대시보드", 8, { includeArchived: true });
      const live = opted.filter((m) => m.name.startsWith("live_")).length;
      const arch = opted.filter((m) => m.name.startsWith("arch_")).length;
      out.push(
        assert(
          "★★명시적으로 찾을 땐 아카이브가 나오되 **살아 있는 것이 안 밀린다**(아카이브 40건 상대로)",
          live === 5 && arch >= 1,
          `live ${live}/5 · 아카이브 ${arch} · 총 ${opted.length}칸`,
        ),
      );
      // ── ⑦ ★★배선의 **한 겹 위** — `retrieveContext` 가 실제로 뭘 싣나 ──────────
      //  ⑥-A 는 `searchMemories` 를 직접 부른다. 그런데 매 턴 도는 건 `retrieveContext`
      //  이고, 거기서 `includeArchived: true` 를 주입하는 변이가 ⑥-A 를 **통과했다**.
      //  오늘 이 레포가 반복해서 맞은 병이라(«한 겹 위 이음매») 그 층에서 다시 잰다.
      const { retrieveContext } = await import("../../core/memory.js");
      const ctx = retrieveContext("cli", "probe", "대시보드");
      const ctxArch = ctx.memories.filter((m) => m.name.startsWith("arch_")).length;
      out.push(
        assert(
          "★★매 턴 컨텍스트(`retrieveContext`)에 아카이브가 안 실린다 — 이게 «옛것을 매 턴 본다» 를 막는 마지막 문이다",
          ctxArch === 0,
          `컨텍스트 ${ctx.memories.length}건 중 아카이브 ${ctxArch}건(기대 0)`,
        ),
      );

      // ── ⑧ ★아카이브 **시각**은 정리 작업이 덮지 않는다 ────────────────────
      //  실사고: 전량을 훑는 백필이 한 번 돌자 46건의 «언제 내려갔나» 가 전부 그날로
      //  덮였다. 아카이브의 값은 «되돌릴 수 있다» 인데 그 판단 재료를 정리가 지웠다.
      const { peekMemory } = await import("../../store/memory.js");
      const first = peekMemory("arch_widget_0");
      const firstAt = (first as { archivedAt?: number } | undefined)?.archivedAt;
      archiveMemory("arch_widget_0"); // 이미 내려간 것을 다시 아카이브
      const second = peekMemory("arch_widget_0");
      const secondAt = (second as { archivedAt?: number } | undefined)?.archivedAt;
      // `Memory` 가 archivedAt 을 노출하지 않으므로 **반환값**으로 본다:
      // 이미 내려간 것이면 `undefined`(=바꾼 게 없다) 여야 한다.
      const noop = archiveMemory("arch_widget_0") === undefined;
      out.push(
        assert(
          "★이미 내려간 것을 다시 아카이브하면 **아무것도 안 바꾼다**(시각을 덮지 않는다)",
          noop,
          noop ? "재-아카이브 = no-op(반환 undefined)" : "★시각이 덮인다 — 정리할 때마다 «언제 내려갔나» 가 사라진다",
        ),
      );
      void firstAt;
      void secondAt;
    } finally {
      if (prevHome === undefined) delete process.env.TIGUCLAW_HOME;
      else process.env.TIGUCLAW_HOME = prevHome;
      rmSync(home, { recursive: true, force: true });
    }

    return out;
  },
};
export default check;
