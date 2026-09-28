/**
 * 회귀: **보내는 이력 창의 시작점은 요약할 때만 움직인다 — 그 사이엔 한 칸도 안 밀리고, 요약 안 된 턴을 버리지 않는다**
 * (2026-09-26 Codex 캐시 조사).
 *
 * ★사고: 이력 크기를 묶는 장치 셋 중 턴 수 상한(최근 150턴)·글자 상한이 요약(15만 자)보다 먼저 걸려, 새 턴마다
 *  가장 오래된 턴이 빠지며 이력 맨 앞이 바뀌었다 → 이력 전체가 프리픽스 캐시 미적중(실측: 메인 세션 턴 첫
 *  요청 5/5, 1분 간격인데도 ~4.5만 토큰씩). 밀려난 턴은 요약에도 없어 모델이 못 봤다.
 * 처방: 요약 기준 = 보낼 수 있는 이력 예산(`historyTriggerChars`), 턴 수 상한 제거.
 *
 * 실제 드라이버(`compactThreadHistory` + `recentTurnsAfter`)로 짧은 턴을 계속 쌓는다(150턴을 훌쩍 넘게).
 *  ① 요약이 없던 스텝 사이엔 창의 첫 턴이 그대로 ② 창 = 요약 안 된 턴 전부(버리는 턴 0)
 *  ③ 요약은 실제로 일어나고, 미요약 분량이 예산 기준을 넘기 전에 일어난다 ④ 기준 계산의 경계(상한·하한)
 *  ⑤ 큰 턴 스레드(최근 30턴만으로 기준 초과)도 매 턴 요약하지 않는다 ⑥ 기준이 낮아도 저수위가 그 기준에서 계산된다.
 */
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "history-window-stable",
  guards: "턴 수·글자 상한이 요약보다 먼저 걸려 매 턴 이력 창이 한 칸씩 밀리며 캐시를 깨고, 요약 안 된 턴을 모델이 못 보던 것",
  run: async (): Promise<Assertion[]> => {
    const { initStore } = await import("../../store/sessions.js");
    const { appendTranscript, indexCodexTurn } = await import("../../store/memory.js");
    const { clearThreadSummary } = await import("../../store/thread-summaries.js");
    const H = await import("../../core/llm-runtime/adapters/openai-codex-oauth-history.js");
    initStore();
    // 실제 드라이버로 턴을 쌓는다 — 스텝마다 user+assistant 한 쌍.
    const simulate = async (label: string, FIXED: number, turnChars: number, steps: number) => {
      const TK = `regr:history-window-stable:${label}:${Date.now()}`;
      const sid = `regr-hws-${label}`;
      clearThreadSummary("http-bridge", TK);
      indexCodexTurn({ channel: "http-bridge", threadKey: TK, claudeSessionId: sid });
      let ts = 1_700_000_000_000, turns = 0, lastWatermark = -1, slidWithoutFold = 0, dropped = 0, folds = 0, maxUnsummarized = 0;
      let firstKey: string | undefined;
      let summarizeCalls = 0;
      for (let step = 0; step < steps; step++) {
        for (const role of ["user", "assistant"] as const) {
          appendTranscript({ claudeSessionId: sid, role, content: `t${turns++}:` + "나".repeat(turnChars - 10), ts: (ts += 1_000) });
        }
        const r = await H.compactThreadHistory({
          channel: "http-bridge", threadKey: TK, provider: `regr-hws-${label}`, adapter: "codex",
          summarize: async (_t: string, target: number) => { summarizeCalls += 1; return "요약:" + "약".repeat(Math.max(0, Math.min(target, 2_000) - 3)); },
          budget: { instructionsChars: FIXED, promptChars: 0 },
        });
        const unsummarized = r.allTurns.filter((t) => t.id > r.watermark);
        maxUnsummarized = Math.max(maxUnsummarized, unsummarized.reduce((n, t) => n + t.content.length, 0));
        const win = H.recentTurnsAfter(r.allTurns, r.watermark, { budgetUsedChars: FIXED + r.summary.length });
        if (win.length !== unsummarized.length) dropped += 1;
        const key = win[0]?.content.slice(0, 12);
        if (r.watermark !== lastWatermark) { if (lastWatermark >= 0) folds += 1; lastWatermark = r.watermark; }
        else if (firstKey !== undefined && key !== firstKey) slidWithoutFold += 1;
        firstKey = key;
      }
      return { turns, steps, slidWithoutFold, dropped, folds, summarizeCalls, maxUnsummarized, trigger: H.historyTriggerChars(FIXED) };
    };
    // A. 짧은 턴이 옛 턴 수 상한(150)을 훌쩍 넘게 — 턴 수로 밀던 결함
    const A = await simulate("short", 50_000, 400, 220);
    // B. 큰 턴 — 최근 30턴만으로 기준을 넘는 스레드(적대 검토 F1, 실측 scheduler:21)
    const B = await simulate("big", 55_000, 4_500, 120);
    // C. 고정 비용이 커서 기준이 낮은 스레드 — 저수위가 그 기준에서 계산돼야 한 번 접고 한동안 안정(F6)
    const C = await simulate("highfixed", 120_000, 2_000, 120); // 30턴(6만 자)이 저수위보다 커야 저수위가 작용한다
    const trigger = A.trigger;
    // E. 큰 프롬프트 한 번(전체 검토 2026-09-28) — 원문 9만 자 스레드에 15만 자 붙여넣기. 종전(고정 비용 = 지시문 + 프롬프트
    //  전체)이면 기준이 하한(2만)으로 떨어져 그 턴에 원문이 영구히 접혔다. 이제 프롬프트 몫은 상한까지만 센다.
    const tkE = `regr:history-window-stable:bigprompt:${Date.now()}`;
    clearThreadSummary("http-bridge", tkE);
    indexCodexTurn({ channel: "http-bridge", threadKey: tkE, claudeSessionId: "regr-hws-bigprompt" });
    let tsE = 1_800_000_000_000;
    for (let i = 0; i < 45; i++) for (const role of ["user", "assistant"] as const) {
      appendTranscript({ claudeSessionId: "regr-hws-bigprompt", role, content: `e${i}:` + "다".repeat(990), ts: (tsE += 1_000) });
    }
    let eSummaries = 0;
    const E = await H.compactThreadHistory({
      channel: "http-bridge", threadKey: tkE, provider: "regr-hws-bigprompt", adapter: "codex",
      summarize: async () => { eSummaries += 1; return "요약:" + "약".repeat(200); },
      budget: { instructionsChars: 30_000, promptChars: 150_000 },
    });
    const oldTrigger = H.historyTriggerChars(30_000 + 150_000);
    // E2. 이음매 — Codex 이력 조립(`buildTurnHistory`)을 실제로 15만 자 프롬프트로 부른다(호출부가 몫 상한을 쓰나).
    const tkE2 = `regr:history-window-stable:bigprompt-seam:${Date.now()}`;
    clearThreadSummary("http-bridge", tkE2);
    indexCodexTurn({ channel: "http-bridge", threadKey: tkE2, claudeSessionId: "regr-hws-bigprompt-seam" });
    for (let i = 0; i < 45; i++) for (const role of ["user", "assistant"] as const) {
      appendTranscript({ claudeSessionId: "regr-hws-bigprompt-seam", role, content: `s${i}:` + "라".repeat(990), ts: (tsE += 1_000) });
    }
    let seamSummaries = 0;
    H.setSummarizerPort(async () => { seamSummaries += 1; return "요약:" + "약".repeat(200); });
    try {
      await H.buildTurnHistory({ threadKey: tkE2, channel: "http-bridge", provider: "regr-hws-seam" } as never, "붙여넣기 " + "로".repeat(150_000), [], "fake-token", undefined, "fake-model", 30_000);
    } finally { H.setSummarizerPort(null); }
    return [
      assert("★E 큰 프롬프트 한 번(15만 자)으로 원문 9만 자가 요약되지 않는다 — 종전 식이면 기준이 하한까지 떨어진다",
        E.watermark === 0 && eSummaries === 0 && oldTrigger === H.CODEX_SUMMARY_MAX_CHARS && H.historyTriggerChars(H.historyFixedChars(30_000, 150_000)) > 90_000,
        { watermark: E.watermark, eSummaries, oldTrigger, newTrigger: H.historyTriggerChars(H.historyFixedChars(30_000, 150_000)) }),
      assert("★E2 이음매: Codex 이력 조립이 15만 자 프롬프트에서 요약을 부르지 않는다(호출부가 몫 상한을 쓴다)", seamSummaries === 0, { seamSummaries }),
      assert("E 평소 크기 프롬프트는 그대로 센다(몫 상한 아래) · 상한 위는 상한까지만",
        H.historyFixedChars(30_000, 3_000) === 33_000 && H.historyFixedChars(30_000, 150_000) === 30_000 + H.HISTORY_PROMPT_RESERVE_CHARS,
        { small: H.historyFixedChars(30_000, 3_000), big: H.historyFixedChars(30_000, 150_000) }),
      assert("A 쌓인 턴이 옛 턴 수 상한(150)을 훌쩍 넘었다(없으면 아래는 공짜 초록)", A.turns >= 400, A.turns),
      assert("★① 요약이 없던 스텝 사이엔 창의 첫 턴이 한 번도 안 바뀐다(프리픽스 캐시 보존) — A·B·C", [A, B, C].every((x) => x.slidWithoutFold === 0), [A, B, C].map((x) => x.slidWithoutFold)),
      assert("★② 창 = 요약 안 된 턴 전부 — 버리는 턴이 없다(맥락 손실 0) — A·B·C", [A, B, C].every((x) => x.dropped === 0), [A, B, C].map((x) => x.dropped)),
      assert("③ 요약은 실제로 일어나고, 미요약 분량은 예산 기준(+한 스텝)을 넘지 않는다", A.folds > 0 && A.maxUnsummarized <= trigger + 2 * 400, { folds: A.folds, maxUnsummarized: A.maxUnsummarized, trigger }),
      // ★접는 횟수로 본다 — 한 번 접을 때 여러 패스(요약 호출 여럿)가 도는 건 설계다. 결함은 «매 턴 접는 것»이다
      //  (적대 검토 재현: 개수로만 보존하면 120스텝에 105번 접었다).
      assert("★⑤ 큰 턴 스레드(B)도 한 번 접으면 한동안 안정 — 매 턴 접지 않는다(접기 ≤ 스텝의 1/4)", B.folds > 0 && B.folds <= B.steps / 4, { folds: B.folds, summarizeCalls: B.summarizeCalls, steps: B.steps }),
      assert("★⑥ 기준이 낮은 스레드(C)도 매 턴 요약하지 않는다(저수위가 그 기준에서 계산된다)", C.folds > 0 && C.summarizeCalls <= C.steps / 5, { folds: C.folds, summarizeCalls: C.summarizeCalls, steps: C.steps, trigger: C.trigger }),
      assert("④ 기준 = min(15만, 글자 상한 − 고정 비용 − 요약 몫), 하한 = 요약 최대 크기",
        H.historyTriggerChars(0) === Math.min(H.CODEX_HISTORY_COMPACT_TRIGGER_CHARS, 200_000 - H.CODEX_SUMMARY_MAX_CHARS) &&
        H.historyTriggerChars(10_000_000) === H.CODEX_SUMMARY_MAX_CHARS && trigger < H.CODEX_HISTORY_COMPACT_TRIGGER_CHARS,
        { t0: H.historyTriggerChars(0), tMain: trigger, tHuge: H.historyTriggerChars(10_000_000) }),
    ];
  },
};
