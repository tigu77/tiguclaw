/** SDK가 이미 보존한 요청 경계를 버리던 경로를 실제 Usage 인스턴스와 이벤트 발행으로 검사한다. */
import { randomUUID } from "node:crypto";
import { Usage } from "@openai/agents-core";
import { extractUsage, extractRequestUsageEntries } from "../../core/llm-runtime/adapters/openai-agents-sdk.js";
import { publishTurnDone } from "../../core/llm-runtime/index.js";
import { getEventBus, type EventBusEvent } from "../../core/eventbus.js";
import { assert, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "openai-request-usage",
  guards: "SDK 요청별 사용량을 실행 합계만으로 축소하고 관측된 캐시 0도 미보고로 바꾸던 것",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const assertions: Assertion[] = [];
    const sdk = new Usage();
    sdk.add(new Usage({ inputTokens: 150_000, outputTokens: 100, inputTokensDetails: { cached_tokens: 0 } }));
    sdk.add(new Usage({ inputTokens: 300_000, outputTokens: 200, inputTokensDetails: { cached_tokens: 250_000 }, requestUsageEntries: [
      { inputTokens: 300_000, outputTokens: 200, totalTokens: 300_200, inputTokensDetails: { cached_tokens: 250_000 }, endpoint: "responses.compact" },
    ] }));
    const result = extractUsage({ state: { usage: sdk } });
    const entries = result?.requestUsageEntries;
    assertions.push(assert("실제 SDK의 두 요청 경계 보존", entries?.length === 2 && entries[0]?.inputTokens === 150_000 && entries[1]?.inputTokens === 300_000, entries));
    assertions.push(assert("출력·캐시 0·압축 endpoint 보존", entries?.[0]?.cachedTokens === 0 && entries[1]?.outputTokens === 200 && entries[1]?.endpoint === "responses.compact", entries));
    assertions.push(assert("기존 합계 소비 계약은 그대로", result?.inputTokens === 450_000 && result.outputTokens === 300 && result.cachedTokens === 250_000, result));
    sdk.requestUsageEntries![0]!.inputTokens = 9;
    assertions.push(assert("SDK 후속 변경이 반환 기록을 바꾸지 않음", entries?.[0]?.inputTokens === 150_000, entries));
    const zero = extractUsage({ state: { usage: new Usage({ inputTokens: 10, outputTokens: 2, inputTokensDetails: { cached_tokens: 0 } }) } });
    const unknown = extractUsage({ state: { usage: new Usage({ inputTokens: 10, outputTokens: 2 }) } });
    assertions.push(assert("관측된 캐시 0과 미보고 구별", zero?.cachedTokens === 0 && unknown?.cachedTokens === undefined, { zero, unknown }));
    const partialCache = extractUsage({ state: { usage: { inputTokens: 10, outputTokens: 2, inputTokensDetails: [{ cached_tokens: 0 }, {}] } } });
    assertions.push(assert("일부 요청의 캐시 미보고를 합계 0으로 승격하지 않음", partialCache?.cachedTokens === undefined, partialCache));
    assertions.push(assert("합계를 가상의 요청 한 건으로 만들지 않음", unknown?.requestUsageEntries === undefined && result?.requestUsageEntries?.length === 2, { unknown, result }));
    for (const raw of [undefined, [], [{ inputTokens: 1 }], [{ inputTokens: -1, outputTokens: 0 }], [{ inputTokens: NaN, outputTokens: 0 }], [{ inputTokens: 1, outputTokens: 0, inputTokensDetails: { cached_tokens: 2 } }], [{ inputTokens: 1, outputTokens: 0 }, null]]) {
      const got = extractRequestUsageEntries(raw);
      assertions.push(assert("불완전·잘못된 요청 목록에서 일부만 정상인 목록을 만들지 않음", got === undefined, { raw, got }));
    }
    const minimal = extractRequestUsageEntries([{ inputTokens: 0, outputTokens: 0, prompt: "should not persist" }]);
    assertions.push(assert("보고된 토큰 0 보존·본문 필드 제외", minimal?.[0]?.inputTokens === 0 && minimal[0].cachedTokens === undefined && !JSON.stringify(minimal).includes("should not persist"), minimal));
    const threadKey = `request-usage-${randomUUID()}`;
    const events: EventBusEvent[] = [];
    const unsub = getEventBus().subscribe(e => { if (e.payload.threadKey === threadKey) events.push(e); });
    try {
      // facade는 공급자별 분기 없이 같은 요청 기록을 전달한다.
      for (const adapter of ["openai", "claude", "codex-oauth"] as const) {
        publishTurnDone({ adapter, model: "synthetic" }, { channel: "cli", threadKey, text: "synthetic" }, { text: "done", usage: result }, 1);
      }
      assertions.push(assert("세 어댑터 라벨 모두 완료 이벤트에 요청 기록 전달", events.length === 3 && events.every(e => Array.isArray(e.payload.requestUsageEntries) && e.payload.requestUsageEntries.length === 2 && e.payload.requestUsageEntries[0]?.inputTokens === 150_000 && e.payload.requestUsageEntries[1]?.endpoint === "responses.compact"), events));
    } finally { unsub(); }
    return assertions;
  },
};
