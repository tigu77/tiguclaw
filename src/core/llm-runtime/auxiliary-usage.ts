import { randomUUID } from "node:crypto";
import { getEventBus } from "../eventbus.js";

/** 별도 요약 실행만 기록한다. 본 작업 누적 usage와 섞지 않는다. */
export const beginSummaryUsage = (threadKey: string, adapter: string, model: string) => {
  const executionId = randomUUID();
  const startedAt = Date.now();
  let finished = false;
  return (ok: boolean, usage?: {
    inputTokens?: number; outputTokens?: number; cachedTokens?: number;
    requests?: number; reasoningTokens?: number;
    requestUsageEntries?: { reasoningTokens?: number }[];
  }): void => {
    if (finished) return;
    finished = true;
    const payload: Record<string, unknown> = {
      threadKey, adapter, model, executionId, purpose: "summary", ok,
      durationMs: Date.now() - startedAt,
    };
    for (const key of ["inputTokens", "outputTokens", "cachedTokens", "requests"] as const) {
      const n = usage?.[key];
      if (typeof n === "number" && Number.isSafeInteger(n) && n >= 0) payload[key] = n;
    }
    if (usage?.requestUsageEntries !== undefined) {
      payload.requestUsageEntries = usage.requestUsageEntries.map((e) =>
        typeof e.reasoningTokens === "number" && Number.isSafeInteger(e.reasoningTokens) && e.reasoningTokens >= 0
          ? { reasoningTokens: e.reasoningTokens } : {});
    }
    try {
      getEventBus().publish({ type: "llm.auxiliary_usage", ts: Date.now(), payload });
    } catch { /* 관측 실패로 원래 요청의 결과를 바꾸지 않는다. */ }
  };
};
