import { fileURLToPath } from "node:url";
import { parseCodexSse } from "../../core/llm-runtime/adapters/openai-codex-oauth-history.js";
import { assert, spawnWithin, type RegressionCheck } from "./_framework.js";
export const check: RegressionCheck = {
  name: "codex-web-search-activity",
  guards: "공급자 검색을 수행한 서브에게 도구 미사용 경고를 내는 오탐",
  run: async () => {
    const parse = async (events: unknown[]) => {
      let count = 0;
      const result = await parseCodexSse(new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join("")).body!, undefined, undefined, undefined, undefined, () => { count++; });
      return { count, localCalls: result.toolCalls.length };
    };
    const event = { type: "response.web_search_call.completed", item_id: "ws_a", output_index: 0 };
    const positive = await parse([event, event, { ...event, item_id: "ws_b", output_index: 1 }]);
    const negative = await parse([
      { ...event, type: "response.web_search_call.searching" },
      { ...event, type: "response.web_search_call.in_progress" },
      { type: "response.output_text.delta", delta: "검색 완료 https://example.com" },
      { type: "response.web_search_call.completed" },
      { type: "response.failed" },
    ]);
    const next = await parse([event]);
    const indexed = await parse([{ type: event.type, output_index: 2 }, { type: event.type, output_index: 2 }]);
    const r = await spawnWithin(45000, "검색 실제 어댑터와 자식 경고", ["--import", "tsx", fileURLToPath(new URL("./_codex-web-search-activity-child.ts", import.meta.url))]);
    const line = r.out.split("\n").find(x => x.startsWith("SEARCH_RESULT "));
    const result = line ? JSON.parse(line.slice(14)) : {};
    // ★끝난 검색이 «⏳ 실행 중» 으로 남지 않게 — 시작만 있고 끝이 없으면 대시보드가 잡이 끝날 때까지
    //  실행 중 뱃지를 켜 둔다(2026-09-26 적대 검토 P3). 같은 seq 의 시작·끝 한 쌍, 끝엔 소요 시간.
    const acts: { seq: unknown; phase: unknown; durationMs: unknown }[] = result.searchActivity ?? [];
    const starts = acts.filter((a) => a.phase === "start");
    const ends = acts.filter((a) => a.phase === "end");
    const paired = starts.length === 1 && ends.length === 1 && starts[0]!.seq === ends[0]!.seq &&
      typeof ends[0]!.durationMs === "number" && (ends[0]!.durationMs as number) >= 0 &&
      acts.every((a) => a.phase === "start" || a.phase === "end");
    return [
      assert("★검색 활동은 같은 seq 의 시작·끝 한 쌍이고 끝에 소요 시간이 실린다(«실행 중» 고착 방지)", paired, acts),
      assert("검색 완료 중복 제거·서로 다른 검색 보존", positive.count === 2 && positive.localCalls === 0, positive),
      assert("진행·답변 주장·식별자 없는 이벤트는 완료로 세지 않음", negative.count === 0, negative),
      assert("다음 요청은 같은 식별자여도 독립 관측", next.count === 1, next),
      assert("항목 ID가 없으면 출력 인덱스로 중복 제거", indexed.count === 1, indexed),
      assert("실제 어댑터→자식 판정: 검색 실행은 경고 없음", result.outcomes?.[0]?.status === "done" && result.outcomes[0].warned === false, line ?? r.err),
      assert("다음 자식의 미사용은 경고 유지·모델 추가 요청 없음", result.outcomes?.[1]?.status === "done" && result.outcomes[1].warned === true && result.requests === 2 && !r.timedOut, line ?? r.err),
    ];
  },
};
