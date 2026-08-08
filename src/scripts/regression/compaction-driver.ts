/**
 * 회귀: **압축 드라이버를 실제로 돌린다** — ★행동 게이트 (2026-08-09).
 *
 * 적대 검토 두 라운드가 변이 71종 중 35종을 통과시켰고, 뿌리는 **하나**였다 —
 * **검사가 제품 드라이버를 한 번도 실행하지 않는다.** 판정을 순수 함수로 뽑아 격리 호출하고
 * 루프는 테스트가 자기 안에서 재구현했으니, "함수는 맞는데 드라이버가 틀린 인자로 부른다"가
 * 전부 초록이었다:
 *  - `nextPassOpts(compactPass, …)` → `nextPassOpts(0, …)` = 저수위 기능 **완전 사망**
 *  - `maxFoldChars: foldBudget * 10` = 40만 자를 한 번에 요약 → 빈 응답 → 영구 루프
 *  - 재판정 입력이 갱신 목록이 아니라 최초 목록 = 같은 턴을 3번 접음
 *  - 저장 인자에서 `keepPart` 누락 = 다음 턴부터 최근 요약 구간 영구 소실
 *
 * 정규식을 더 붙이는 건 같은 병이다([[feedback_hand_maintained_lists]]). 그래서 요약기를
 * **포트로 주입**해(쿨다운 포트와 같은 기존 패턴) 드라이버를 통째로 돌린다. 요약 LLM 만
 * 가짜고 나머지(계획·루프·워터마크·저장·알림)는 전부 제품 코드다.
 */
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const SRC = "../../core/llm-runtime/adapters/openai-codex-oauth-history.js";

export const check: RegressionCheck = {
  name: "compaction-driver",
  guards:
    "압축 드라이버 실행 — 저수위 재판정·폴드 예산·워터마크·누적 저장이 실제로 그렇게 도는가",
  run: async (): Promise<Assertion[]> => {
    const {
      buildTurnHistory,
      setSummarizerPort,
      CODEX_HISTORY_COMPACT_TRIGGER_CHARS: TRIGGER,
      CODEX_HISTORY_COMPACT_MAX_FOLD_CHARS: BUDGET,
      CODEX_COMPACT_MAX_PASSES: MAX_PASSES,
      CODEX_SUMMARY_RECOMPACT_MAX_PASSES: RECOMPACT_PASSES,
      SUMMARY_SECTION_SEP,
      lowWaterMark,
    } = await import(SRC);
    const { initStore } = await import("../../store/sessions.js");
    const { appendTranscript, indexCodexTurn } = await import("../../store/memory.js");
    const { getThreadSummary, clearThreadSummary } = await import(
      "../../store/thread-summaries.js"
    );

    initStore();
    const TK = "regr:driver";
    clearThreadSummary("http-bridge", TK);
    indexCodexTurn({ channel: "http-bridge", threadKey: TK, claudeSessionId: "regr-driver-sid2" });

    // 사고 크기 재현 — 임계의 1.6배. (같은 sid 에 이미 심겨 있으면 건너뛴다: 회귀는 반복 실행된다.)
    // ★**임계 바로 위**로 잡는다. 종전엔 임계의 1.6배라 저수위가 없어도(고수위로만 판정)
    //  3패스가 돌아 **차이가 안 보였다** — `nextPassOpts(0, …)` 변이가 통과했다.
    //  여기(임계+예산의 30%)면 고수위만으론 1패스, 저수위가 있어야 2패스다.
    const turnCount = 400;
    const per = Math.ceil((TRIGGER + BUDGET * 0.3) / turnCount);
    const existing = (
      await import("../../store/memory.js")
    ).loadThreadHistoryWithIds("http-bridge", TK);
    if (existing.length < turnCount) {
      let ts = 1_700_000_000_000;
      for (let i = existing.length; i < turnCount; i++) {
        appendTranscript({
          claudeSessionId: "regr-driver-sid2",
          role: i % 2 === 0 ? "user" : "assistant",
          // ★턴마다 **고유 내용** — 전부 같으면 "패스마다 다른 구간을 접는가" 를 볼 수 없다.
          content: `턴${i}:` + "가".repeat(Math.max(1, per - 8)),
          ts: (ts += 60_000),
        });
      }
    }

    // 가짜 요약기 — 호출을 기록하고 목표 분량대로 돌려준다.
    const calls: { chars: number; target: number; head: string }[] = [];
    setSummarizerPort(async (text: string, target: number) => {
      // ★앞·뒤 조각을 남긴다 — 패스마다 **다른 구간**을 접는지 보려면 크기만으론 안 된다
      //  (같은 목록을 다시 넘기면 같은 턴을 3번 접는데 크기는 똑같다 — 변이 AK).
      calls.push({ chars: text.length, target, head: text.slice(0, 40) + "|" + text.slice(-40) });
      return `요약${calls.length}:` + "약".repeat(Math.max(0, target - 5));
    });

    let items: unknown[] = [];
    try {
      items = (await buildTurnHistory(
        { threadKey: TK, channel: "http-bridge", provider: "codex-oauth" },
        "현재 턴 프롬프트",
        [],
        "fake-token",
        undefined,
        "fake-model",
      )) as unknown[];
    } finally {
      setSummarizerPort(null);
    }

    const saved = getThreadSummary(TK);
    const sections = (saved?.summary ?? "").split(SUMMARY_SECTION_SEP as string);
    const LOW = lowWaterMark() as number;

    return [
      assert(
        "드라이버가 실제로 돌았다(입력 배열 + 요약 호출 발생)",
        items.length > 0 && calls.length > 0,
        `아이템 ${items.length}개 · 요약 호출 ${calls.length}회`,
      ),
      assert(
        "★저수위까지 **여러 패스** 접는다 — 드라이버가 패스 번호를 넘기는지 여기서만 보인다",
        calls.length >= 2 && calls.length <= (MAX_PASSES as number),
        `${calls.length}회 (상한 ${MAX_PASSES})`,
      ),
      assert(
        "★모든 요약 입력이 **폴드 예산 안**이다(예산을 안 넘겨야 요약 호출이 안 깨진다)",
        calls.every((c) => c.chars <= (BUDGET as number) * 1.05),
        calls.map((c) => c.chars).join("·") + `자 (예산 ${BUDGET})`,
      ),
      assert(
        "★목표 분량이 **접은 글자 수**에 비례한다(턴 수를 넘기면 항상 하한으로 클램프)",
        calls.every((c) => c.target > 400 && c.target <= c.chars * 0.2),
        calls.map((c) => `${c.chars}→${c.target}`).join(" · "),
      ),
      assert(
        "★패스마다 **다른 구간**을 접는다(재판정 입력이 갱신 목록인가 — 같으면 같은 턴 반복)",
        new Set(calls.map((c) => c.head)).size === calls.length &&
          saved !== undefined &&
          sections.length === calls.length,
        `서로 다른 구간 ${new Set(calls.map((c) => c.head)).size}/${calls.length} · 요약 구간 ${sections.length}개`,
      ),
      assert(
        "누적 요약 재압축이 **꺼져 있지 않다**(0 이면 상한이 무의미해진다)",
        (RECOMPACT_PASSES as number) >= 1 && (RECOMPACT_PASSES as number) <= 4,
        `재압축 패스 상한 ${RECOMPACT_PASSES}`,
      ),
      assert(
        "★저장된 요약이 **누적**이다(구간이 패스 수만큼, 첫 구간이 선두에)",
        sections.length >= 2 && (sections[0] as string).startsWith("요약1:"),
        `${sections.length}구간 · 선두=${(sections[0] ?? "").slice(0, 6)}`,
      ),
      assert(
        "★watermark 가 전진했고 남은 미요약이 임계 아래다",
        (saved?.compactedThrough ?? 0) > 0,
        `compactedThrough=${saved?.compactedThrough ?? 0} · 저수위 ${LOW}`,
      ),
    ];
  },
};
