/**
 * 회귀: **누적 요약 상한이 이력 상한(창)을 따른다** — ★행동 게이트 (2026-10-04).
 *
 * 이력 상한은 09-30 에 창 기준(Codex ≈40만 자)으로 커졌는데 누적 요약 상한은 2만 자 고정으로 남았다. 큰 대화에선
 * 한 번 접을 때마다 요약이 4~5천 자씩 붙어 **매 턴** 상한을 넘었고, 매 턴 가장 오래된 구간을 다시 요약했다
 * (벤치 `long-session-compaction`: 재압축이 요청마다 ≈80초 + 초반 구간이 턴마다 한 세대씩 더 뭉개짐).
 * 정태님 기준: «한 번 요약한 뒤 곧바로 또 요약하면 안 된다 · 능력이 떨어지면 안 된다».
 *
 * 드라이버(`compactThreadHistory`)를 실제로 돌린다 — 요약기만 포트로 가짜, 나머지는 제품 코드다
 * (`compaction-driver` 와 같은 방식). 같은 3만 자 요약을 두고:
 *  - 창이 큰 모델(이력 상한 40만) → 재압축 **없음**
 *  - 창을 모르는 모델(기본 상한) → 재압축 **있음**(종전 그대로)
 */
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const SRC = "../../core/llm-runtime/adapters/openai-codex-oauth-history.js";

export const check: RegressionCheck = {
  name: "summary-cap-follows-window",
  guards:
    "누적 요약 상한이 2만 자 고정이라 창이 큰 모델에서 매 턴 재압축(요약의 요약)이 돌고 요청마다 수십 초를 쓰던 것",
  run: async (): Promise<Assertion[]> => {
    const H = await import(SRC);
    const { initStore } = await import("../../store/sessions.js");
    const { appendTranscript, indexCodexTurn } = await import("../../store/memory.js");
    const { getThreadSummary, upsertThreadSummary, clearThreadSummary } = await import("../../store/thread-summaries.js");
    initStore();

    const BIG = 400_000;
    // 기본 이력 상한은 store 가 정본이다(어댑터 모듈은 내보내지 않는다 — 첫 판은 여기서 undefined 를 받아 기본 인자로 우연히 통과했다).
    const { CODEX_TURN_HISTORY_CHAR_CAP: DEF } = (await import("../../store/memory.js")) as { CODEX_TURN_HISTORY_CHAR_CAP: number };
    const SEP = H.SUMMARY_SECTION_SEP as string;
    const summary30k = [0, 1, 2].map((i) => `구간${i}:` + "요".repeat(10_000 - 4)).join(SEP);

    const drive = async (tk: string, capChars: number | undefined, postTurn = false) => {
      clearThreadSummary("http-bridge", tk);
      indexCodexTurn({ channel: "http-bridge", threadKey: tk, claudeSessionId: `${tk}-sid` });
      const { loadThreadHistoryWithIds } = await import("../../store/memory.js");
      if (loadThreadHistoryWithIds("http-bridge", tk).length < 2) {
        let ts = 1_700_000_000_000;
        for (const role of ["user", "assistant"] as const) appendTranscript({ claudeSessionId: `${tk}-sid`, role, content: `${role} 짧은 턴`, ts: (ts += 60_000) });
      }
      upsertThreadSummary({ threadKey: tk, summary: summary30k, compactedThrough: 0 });
      const calls: number[] = [];
      // 재압축은 호출부가 넘긴 `summarize` 를 부른다(포트는 접기 경로의 codex 요약기 자리) — 여기서 센다.
      await H.compactThreadHistory({
        channel: "http-bridge", threadKey: tk, provider: "codex-oauth", adapter: "codex",
        budget: { instructionsChars: 1_000, promptChars: 100, ...(capChars !== undefined ? { capChars } : {}) },
        ...(postTurn ? { postTurn: true, capFor: () => capChars ?? DEF } : {}),
        summarize: async (text: string, target: number) => { calls.push(text.length); return "재압축:" + "약".repeat(Math.max(0, target - 4)); },
      });
      return { calls, after: getThreadSummary(tk)?.summary.length ?? 0, turns: loadThreadHistoryWithIds("http-bridge", tk).length };
    };

    const big = await drive("regr:summary-cap-big", BIG);
    // ★턴 뒤 접기 — 09-29 이후 실제 접기 대부분이 여기서 돈다(적대 검토 H: 이 경로만 옛 2만으로 되돌려도 초록이었다).
    const bigAfter = await drive("regr:summary-cap-big-after", BIG, true);
    // ★중간 창(실측 밀도 1.8~2.3 → 상한 22.5만~30만) — 한 점(40만)만 찍으면 경계를 30만으로 좁혀도 초록이었다(적대 검토 P).
    const MID = 260_000;
    const midSummary = H.summaryCapChars(MID) as number;
    const def = await drive("regr:summary-cap-default", undefined);
    const capBig = H.summaryCapChars(BIG) as number;

    return [
      assert(
        "요약 상한: 창을 모르면(기본 이력 상한) 종전 2만 자 · 커진 몫의 20% 를 더한다(40만 → 6만 · 26만 → 3.2만)",
        H.summaryCapChars(DEF) === H.CODEX_SUMMARY_MAX_CHARS && capBig === 60_000 && midSummary === 32_000,
        { def: H.summaryCapChars(DEF), big: capBig, mid: midSummary },
      ),
      assert(
        "★연속·단조 — 기본 상한을 1자 넘어도 요약 상한이 튀지 않고, 원문 기준은 상한과 함께 늘기만 한다(역전 금지)",
        (H.summaryCapChars(DEF + 1) as number) - (H.summaryCapChars(DEF) as number) <= 1 &&
          [DEF, DEF + 1, 250_000, 300_000, BIG].every((c, i, a) => i === 0 || H.historyTriggerChars(1_000, c) >= H.historyTriggerChars(1_000, a[i - 1])),
        [DEF, DEF + 1, 250_000, 300_000, BIG].map((c) => `${c}→${H.historyTriggerChars(1_000, c)}`).join(" · "),
      ),
      assert(
        "★재압축 목표 천장도 상한을 따른다 — 상한 6만에서 앞 구간 3.2만 자를 35% 이상으로(고정 8천이면 25%) · 상한 2만이면 종전 8천",
        (H.recompactTargetFor(32_000, capBig) as number) >= 32_000 * 0.35 && H.recompactTargetFor(20_000) === 8_000,
        { big: H.recompactTargetFor(32_000, capBig), def: H.recompactTargetFor(20_000) },
      ),
      assert(
        "★턴 뒤 접기도 같은 상한 — 큰 창에서 3만 자 요약을 다시 요약하지 않는다",
        bigAfter.turns === 2 && bigAfter.calls.length === 0 && bigAfter.after === summary30k.length,
        bigAfter,
      ),
      assert(
        "이력 기준이 같은 요약 상한을 뺀다(요약이 커진 만큼 원문 몫이 준다 — 둘이 갈리면 창을 넘는다)",
        H.historyTriggerChars(1_000, BIG) === BIG - 1_000 - capBig - H.FOLDED_TOOL_INDEX_MAX_CHARS,
        { trigger: H.historyTriggerChars(1_000, BIG), expect: BIG - 1_000 - capBig - H.FOLDED_TOOL_INDEX_MAX_CHARS },
      ),
      assert(
        "★창이 큰 모델: 3만 자 누적 요약을 **다시 요약하지 않는다**(곧바로 또 요약 금지)",
        big.turns === 2 && big.calls.length === 0 && big.after === summary30k.length,
        big,
      ),
      assert(
        "창을 모르는 모델: 종전대로 2만 자를 넘으면 앞 구간을 재압축한다(상한이 꺼지지 않았다)",
        def.turns === 2 && def.calls.length >= 1 && def.after < summary30k.length,
        def,
      ),
    ];
  },
};
