/** SDK가 이미 보존한 요청 경계를 버리던 경로를 실제 Usage 인스턴스와 이벤트 발행으로 검사한다. */
import { randomUUID } from "node:crypto";
import { Usage } from "@openai/agents-core";
import { extractUsage, extractRequestUsageEntries } from "../../core/llm-runtime/adapters/openai-agents-sdk.js";
import { publishTurnDone } from "../../core/llm-runtime/index.js";
import { getEventBus, type EventBusEvent } from "../../core/eventbus.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, assertIsolated, spawnWithin, type Assertion, type RegressionCheck } from "./_framework.js";

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
    // ★계약(types.ts) 의미로 (2026-10-18, 동등성 감사 7번) — 종전엔 이 줄이 «inputTokens = run 합계» 를 지켰는데 그건 계약 이탈이었다
    //  (codex·claude 는 마지막 호출). 합계는 *Total 로 — 실비용(`turnSpend`)·게이트웨이는 호출 2회 이상이면 *Total 을 읽어 값이 그대로다.
    // 사용량을 못 받은 요청이 섞이면 «마지막 관측 요청 ≠ 실제 마지막 요청» 일 수 있다 — 그 수를 낸다(재검토 10-18 그물 구멍).
    const gap = new Usage();
    gap.add(new Usage({ inputTokens: 100, outputTokens: 10 }));
    gap.add(new Usage({ requests: 1, inputTokens: 0, outputTokens: 0, totalTokens: 0 }));
    gap.add(new Usage({ inputTokens: 120, outputTokens: 12 }));
    const gapUsage = extractUsage({ state: { usage: gap } });
    // ★개수만으로는 «중간 누락» 과 «마지막 누락» 을 못 가른다 — 응답 목록이 없으면 마지막 호출은 «모름»(2026-10-19 아스트라 인계).
    assertions.push(assert("못 받은 요청 수를 unreportedRequests 로 내고 · 응답 목록이 없으면 마지막 호출을 «모름» 으로 둔다(합계는 보존)",
      gapUsage?.unreportedRequests === 1 && gapUsage.lastCallUnknown === true && gapUsage.inputTokensTotal === 220 && gapUsage.iterations === 3, gapUsage));

    // ── 아스트라 인계(10-19) 표 — 마지막 호출을 **증명할 수 있을 때만** 마지막 호출로 ──────────────────────────────
    const R = (inputTokens: number, outputTokens: number, cached?: number) =>
      ({ usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, ...(cached !== undefined ? { inputTokensDetails: { cached_tokens: cached } } : {}) } });
    const one = extractUsage({ state: { usage: { requests: 1, inputTokens: 90, outputTokens: 9 } } });
    const twoNoList = extractUsage({ state: { usage: { requests: 2, inputTokens: 250, outputTokens: 25 } } });
    const lastMissing = extractUsage({ state: { usage: { requests: 2, inputTokens: 100, outputTokens: 10, requestUsageEntries: [{ inputTokens: 100, outputTokens: 10 }] } }, rawResponses: [R(100, 10), R(0, 0)] });
    const midMissing = extractUsage({ state: { usage: { requests: 3, inputTokens: 220, outputTokens: 22, requestUsageEntries: [{ inputTokens: 100, outputTokens: 10 }, { inputTokens: 120, outputTokens: 12 }] } }, rawResponses: [R(100, 10), R(0, 0), R(120, 12, 0)] });
    const cacheUnseen = extractUsage({ state: { usage: { requests: 1, inputTokens: 50, outputTokens: 5 } }, rawResponses: [R(50, 5)] });
    assertions.push(assert("요청 1회 · 목록 없음 — 그 값이 곧 마지막 호출(확정)", one !== undefined && one.inputTokens === 90 && one.lastCallUnknown === undefined && one.iterations === undefined, one));
    assertions.push(assert("★요청 2회 · 목록 없음 — 마지막 호출 «모름» · 합계는 보존(250)", twoNoList?.lastCallUnknown === true && twoNoList.inputTokensTotal === 250, twoNoList));
    assertions.push(assert("★첫 요청 관측 · 마지막 요청 미관측 — «모름»(관측한 첫 요청을 마지막으로 내지 않는다)", lastMissing?.lastCallUnknown === true && lastMissing.unreportedRequests === 1, lastMissing));
    assertions.push(assert("중간 누락 · 마지막 관측 — 응답 목록의 마지막 응답으로 확정(120) · 캐시 0 은 관측된 0", midMissing !== undefined && midMissing.lastCallUnknown === undefined && midMissing.inputTokens === 120 && midMissing.cachedTokens === 0, midMissing));
    assertions.push(assert("캐시 미관측은 0 으로 꾸미지 않는다(생략)", cacheUnseen !== undefined && cacheUnseen.lastCallUnknown === undefined && cacheUnseen.cachedTokens === undefined, cacheUnseen));
    assertions.push(assert("마지막 호출 = 마지막 요청 항목 · 턴 합계 = *Total · 호출 수",
      result?.inputTokens === 300_000 && result.outputTokens === 200 && result.cachedTokens === 250_000 &&
        result.inputTokensTotal === 450_000 && result.outputTokensTotal === 300 && result.cachedTokensTotal === 250_000 && result.iterations === 2, result));
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
    // ── 실행형 — 실제 SDK 루프 + facade + 세션 저장(아스트라 인계 10-19 «소비처까지 연결한 검사») ──────────────────
    const child = path.join(path.dirname(fileURLToPath(import.meta.url)), "_openai-run-child.ts");
    const r = await spawnWithin(60_000, "openai-usage-last-missing", ["--import", "tsx", child, "facade-usage-last-missing"], { stdio: ["ignore", "pipe", "pipe"], env: process.env });
    const line = r.out.trim().split("\n").filter((l) => l.startsWith("{")).pop();
    const j = (line === undefined ? {} : JSON.parse(line)) as { afterFirst?: number | null; afterSecond?: number | null; td2?: { inputTokens: unknown; inputTokensTotal: unknown; iterations: unknown } };
    assertions.push(assert("★세션 저장 — 사용량을 받은 턴은 현재 컨텍스트(77)를 저장 · 마지막 응답의 사용량이 빠진 턴은 그 값을 **비운다**(지난 턴 값을 남기지 않는다)",
      j.afterFirst === 77 && j.afterSecond === null, JSON.stringify({ afterFirst: j.afterFirst, afterSecond: j.afterSecond, err: r.err.slice(-160) })));
    assertions.push(assert("★턴 기록 — 마지막 호출 값은 싣지 않고 합계(100)·호출 수는 남긴다",
      j.td2?.inputTokens === null && j.td2.inputTokensTotal === 100 && j.td2.iterations === 2, JSON.stringify(j.td2)));
    return assertions;
  },
};
