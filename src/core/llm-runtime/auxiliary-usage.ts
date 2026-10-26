import { randomUUID } from "node:crypto";
import { getEventBus } from "../eventbus.js";

const count = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const named = (s: unknown): s is string => typeof s === "string" && s !== "";

/**
 * 별도 요약 실행만 기록한다. 본 작업 누적 usage와 섞지 않는다.
 * `model` 은 시작 때 아는 경우만 준다. 실행 뒤에야 아는 모델(어댑터 보고)은 종료 때 `usage.model` 로 — 그 값이 우선이고,
 * 둘 다 없으면 키를 싣지 않는다(작업명 등 모델이 아닌 값을 채우지 않는다).
 */
export const beginSummaryUsage = (threadKey: string, adapter: string, model?: string) => {
  const executionId = randomUUID();
  const startedAt = Date.now();
  let finished = false;
  return (ok: boolean, usage?: {
    inputTokens?: number; outputTokens?: number; cachedTokens?: number;
    requests?: number; reasoningTokens?: number;
    /** 실행 뒤 어댑터가 보고한 모델 — 시작 때 값보다 우선. */
    model?: string;
    requestUsageEntries?: { model?: string; reasoningTokens?: number; cacheCreationTokens?: number }[];
  }): void => {
    if (finished) return;
    finished = true;
    const reported = named(usage?.model) ? usage.model : named(model) ? model : undefined;
    const payload: Record<string, unknown> = {
      threadKey, adapter, ...(reported !== undefined ? { model: reported } : {}), executionId, purpose: "summary", ok,
      durationMs: Date.now() - startedAt,
    };
    for (const key of ["inputTokens", "outputTokens", "cachedTokens", "requests"] as const) {
      const n = usage?.[key];
      if (count(n)) payload[key] = n;
    }
    // 요청별로는 합계에 없는 것만 남긴다 — 공급자가 보고한 모델·추론·캐시 생성. 미보고는 생략(0 아님).
    if (usage?.requestUsageEntries !== undefined) {
      payload.requestUsageEntries = usage.requestUsageEntries.map((e) => ({
        ...(named(e.model) ? { model: e.model } : {}),
        ...(count(e.reasoningTokens) ? { reasoningTokens: e.reasoningTokens } : {}),
        ...(count(e.cacheCreationTokens) ? { cacheCreationTokens: e.cacheCreationTokens } : {}),
      }));
    }
    try {
      getEventBus().publish({ type: "llm.auxiliary_usage", ts: Date.now(), payload });
    } catch { /* 관측 실패로 원래 요청의 결과를 바꾸지 않는다. */ }
  };
};
