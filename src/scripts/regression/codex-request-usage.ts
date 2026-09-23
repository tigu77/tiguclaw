/** SSE 파서의 완료 요청 → 실제 반환 조립 함수. 라이브 인증·모델 호출 없음. */
import { readFileSync } from "node:fs";
import { parseCodexSse, type CodexSseResult } from "../../core/llm-runtime/adapters/openai-codex-oauth-history.js";
import { withTurnTotals } from "../../core/llm-runtime/adapters/openai-codex-oauth.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const stream = (events: unknown[]) => new ReadableStream<Uint8Array>({
  start(c) { c.enqueue(new TextEncoder().encode(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(""))); c.close(); },
});
const completed = (input: number, output: number, cache?: number, reasoning?: number) => ({ type: "response.completed", response: {
  id: "synthetic", usage: { input_tokens: input, output_tokens: output,
    ...(reasoning !== undefined ? { output_tokens_details: { reasoning_tokens: reasoning } } : {}),
    ...(cache !== undefined ? { input_tokens_details: { cached_tokens: cache } } : {}) },
} });
export const check: RegressionCheck = {
  name: "codex-request-usage",
  guards: "Codex가 요청별 usage를 받으면서 마지막 값과 턴 합계만 반환해 장문 경계를 잃던 것",
  run: async (): Promise<Assertion[]> => {
    const assertions: Assertion[] = [];
    const first = await parseCodexSse(stream([completed(272_000, 100, 0, 37)]));
    const second = await parseCodexSse(stream([completed(272_001, 200, 250_000)]));
    const requests: NonNullable<CodexSseResult["usage"]>[] = [first.usage!, second.usage!];
    const totals = { iterations: 2, inputTokens: 544_001, outputTokens: 300, cachedTokens: 250_000 };
    const got = withTurnTotals(second.usage, totals, requests);
    assertions.push(assert("요청 경계를 합계로 대체하지 않음", got?.requestUsageEntries?.length === 2 && got.requestUsageEntries[0]?.inputTokens === 272_000 && got.requestUsageEntries[1]?.inputTokens === 272_001, got));
    assertions.push(assert("요청별 출력과 캐시 0 보존", got?.requestUsageEntries?.[0]?.cachedTokens === 0 && got.requestUsageEntries[1]?.outputTokens === 200 && got.requestUsageEntries[1]?.cachedTokens === 250_000, got));
    assertions.push(assert("요청별 추론 토큰 생산과 미보고 구별", got?.requestUsageEntries?.[0]?.reasoningTokens === 37 && got.requestUsageEntries[1]?.reasoningTokens === undefined, got));
    assertions.push(assert("마지막 호출·기존 합계 계약 유지", got?.inputTokens === 272_001 && got.outputTokens === 200 && got.inputTokensTotal === 544_001 && got.outputTokensTotal === 300 && got.cachedTokensTotal === 250_000 && got.iterations === 2, got));
    const one = withTurnTotals(first.usage, { iterations: 1, inputTokens: 272_000, outputTokens: 100, cachedTokens: 0 }, [first.usage!]);
    assertions.push(assert("단일 요청도 기록하되 불필요한 합계 필드는 유지하지 않음", one?.requestUsageEntries?.length === 1 && one.iterations === undefined && one.inputTokensTotal === undefined, one));
    requests[0]!.inputTokens = 1; requests.push({ inputTokens: 9, outputTokens: 9 });
    assertions.push(assert("반환 후 원본 배열·객체 변경과 격리", got?.requestUsageEntries?.length === 2 && got.requestUsageEntries[0]?.inputTokens === 272_000, got));
    const noCache = await parseCodexSse(stream([completed(12, 2)]));
    const missingCache = withTurnTotals(noCache.usage, { iterations: 1, inputTokens: 12, outputTokens: 2, cachedTokens: 0 }, [noCache.usage!]);
    assertions.push(assert("미보고 캐시를 요청 기록의 0으로 바꾸지 않음", missingCache?.requestUsageEntries?.[0]?.cachedTokens === undefined, missingCache));
    const noUsage = await parseCodexSse(stream([{ type: "response.completed", response: { id: "synthetic" } }]));
    const empty = withTurnTotals(noUsage.usage, { iterations: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0 }, []);
    assertions.push(assert("미관측 요청의 토큰을 만들지 않음", noUsage.usage === undefined && empty === undefined, { noUsage, empty }));
    for (const raw of [{}, { output_tokens: 1 }, { input_tokens: 1 }, { input_tokens: -1, output_tokens: 1 }, { input_tokens: "1", output_tokens: 1 }]) {
      const invalid = await parseCodexSse(stream([{ type: "response.completed", response: { usage: raw } }]));
      assertions.push(assert("공급자의 누락·잘못된 토큰을 0으로 만들지 않음", invalid.usage === undefined, { raw, usage: invalid.usage }));
    }
    const invalidCache = await parseCodexSse(stream([completed(12, 2, 13)]));
    assertions.push(assert("입력보다 큰 캐시도 미확정", invalidCache.usage?.cachedTokens === undefined && invalidCache.usage?.inputTokens === 12, invalidCache.usage));
    const zero = await parseCodexSse(stream([completed(0, 0, 0)]));
    const zeroResult = withTurnTotals(zero.usage, { iterations: 1, inputTokens: 0, outputTokens: 0, cachedTokens: 0 }, [zero.usage!]);
    assertions.push(assert("보고된 0 토큰 요청도 남음", zeroResult?.requestUsageEntries?.[0]?.inputTokens === 0 && zeroResult.requestUsageEntries[0].outputTokens === 0, zeroResult));
    // 실제 라이브 루프 실행은 아니다. 반환 조립 함수의 두 호출부와 수집 연결 누락만 별도 감시한다.
    const source = readFileSync(new URL("../../core/llm-runtime/adapters/openai-codex-oauth.ts", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    const returns = source.match(/withTurnTotals\(finalUsage, turnTotals\(\), requestUsageEntries\)/g)?.length ?? 0;
    assertions.push(assert("배선: 일반·외부 도구 반환과 완료 요청 수집 연결", returns === 2 && source.includes("requestUsageEntries.push({ ...usage })"), { returns, captures: source.includes("requestUsageEntries.push({ ...usage })") }));
    return assertions;
  },
};
