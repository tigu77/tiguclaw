/**
 * 내부 단발 LLM 호출 — region facade(runRegionA) 재사용, LLM-agnostic.
 *
 * 설계 본질:
 *  - **새 어댑터·새 HTTP 클라이언트 0.** runRegionA 를 그대로 재사용해 현재 활성 어댑터(claude/codex/openai/local
 *    무엇이든)로 호출 — provider 선택·폴백은 runPool 의 *동일* 코드(resolveModelSpecs)를 타므로 어댑터 if 분기 0, 모델 하드코딩 0.
 *  - **경량화**: leanMemory:true + toolPolicy:{mode:"none"} — 메모리 인덱스 prepend 생략 + 도구 0.
 *  - **internal:true** — facade 가 turn_done/turn_error 미발행 + transcripts/sessions 미persist(내부 호출이 사용자 턴처럼
 *    집계·관측되지 않게).
 *  - **견고성**: 시한 + 실패·시한 초과 → 호출자가 대신할 값(throw 0). 데몬·턴 절대 안 죽음.
 *
 * 모델 tier: 작은 작업이라 `low` 를 쓴다 — 사용자가 `low` 프로파일을 적었으면 그것, 아니면 기본 풀(`resolveTier` 의 등급 별칭).
 * ★종전엔 자가성장 플러그인이 쓰던 모순 판정도 여기 살았다 — 플러그인과 함께 뺐다(2026-11-03).
 */
import { assertRuntimeModelAllowed, resolveTier, runRegionA, type ModelSpec } from "./index.js";
import { beginSummaryUsage } from "./auxiliary-usage.js";

/**
 * **내부 단발 호출**의 싼 tier 풀 해석 — `low` → undefined(facade 디폴트). 어댑터 무관.
 *
 * ★2026-08-15: `WebFetch(prompt)` 추출도 같은 판단이 필요해져 **export** 했다. 복사하면
 *  "가장 싼 tier 고르기" 라는 같은 판단이 두 곳에 생기고, 한쪽만 늙는다. 이름도
 *  classify 전용에서 중립으로 바꿨다(정의점은 여기 하나).
 * ★`nano` 를 먼저 찾지 않는다 (2026-10-22 정태님 «나노는 아예 빼기로»). `nano` 가 기본 풀로 풀리게 된 뒤 남은 특례가
 *  명시한 `low` 를 건너뛰고 기본(opus)을 골랐다(아스트라 P2 재현). `low` 프로파일이 없으면 기본 풀, `low` 가 안 풀리면
 *  undefined 로 일반 디폴트(기본 프로파일·빌트인)에 안전 degrade.
 */
export const cheapInternalTierSpecs = (): ModelSpec[] | undefined => {
  assertRuntimeModelAllowed();
  // 프로파일 설치본에서 레거시 `MODEL_TIER_*` 를 가리는 판단은 `resolveTier` 한 곳에 있다(2026-09-28 — 종전엔 여기서
  //  `nano` 만 막아 `low` 가 새었다). 9/26 사고: 6월 .env 의 nano 값(ollama qwen2.5 7B)으로 WebFetch 요약 127회 시한 초과.
  const low = resolveTier("low");
  if (low.length > 0) return low;
  return undefined; // facade 디폴트(기본 프로파일 → 빌트인)
};

/**
 * **오래 도는 매니저의 진행 요약** 1회 — `job-progress.ts` 가 주입받아 쓴다(2026-10-14).
 * 경량 단발(internal·leanMemory·도구 0·싼 등급) — 글을 쓰는 일이라 시한은 30초.
 * 사용량은 그 잡의 «요약» 칸으로 남긴다(`llm.auxiliary_usage`, threadKey `worker:<jobId>` — 잡 장부가 그 키로 귀속한다).
 * never-throw: 실패·시한 초과 → undefined(호출자가 기계 요약으로 대신 보낸다).
 */
export const summarizeJobProgress = async (prompt: string, ctx: { jobId: string }): Promise<string | undefined> => {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 30_000);
  // 모델은 시작 때 모른다(등급 풀·폴백) — 어댑터가 보고한 것을 끝에 싣는다. `adapter: "internal"` 은 이 경로의 표식이다(실제 어댑터는 출력에 없다).
  const finish = beginSummaryUsage(`worker:${ctx.jobId}`, "internal");
  try {
    const output = await runRegionA(
      {
        text: prompt,
        threadKey: `job-progress:${ctx.jobId}`,
        channel: "internal",
        internal: true,
        leanMemory: true,
        toolPolicy: { mode: "none" },
        abortSignal: ac.signal,
      },
      { specs: cheapInternalTierSpecs() },
    );
    const u = output.usage;
    // 비었는지는 기록 함수가 판단한다(한 곳).
    const model = output.model ?? undefined;
    finish(true, u === undefined ? { model } : {
      model,
      inputTokens: u.inputTokensTotal ?? u.inputTokens,
      outputTokens: u.outputTokensTotal ?? u.outputTokens,
      ...(u.cachedTokensTotal ?? u.cachedTokens) !== undefined ? { cachedTokens: (u.cachedTokensTotal ?? u.cachedTokens) as number } : {},
      ...(u.requests !== undefined ? { requests: u.requests } : {}),
      ...(u.requestUsageEntries !== undefined ? { requestUsageEntries: u.requestUsageEntries } : {}),
    });
    return output.text;
  } catch {
    finish(false);
    return undefined;
  } finally {
    clearTimeout(timer);
  }
};
