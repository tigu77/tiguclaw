/** 실제 SDK → 완료 이벤트 → 잡 합계와 화면 함수까지 사용량 의미를 검증한다. */
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { Usage } from "@openai/agents-core";
import { getEventBus } from "../../core/eventbus.js";
import { beginSummaryUsage } from "../../core/llm-runtime/auxiliary-usage.js";
import { extractUsage } from "../../core/llm-runtime/adapters/openai-agents-sdk.js";
import { publishTurnDone } from "../../core/llm-runtime/index.js";
import { turnSpend } from "../../core/llm-runtime/turn-spend.js";
import { __resetJobsForTest, registerJob, getJob } from "../../core/worker-jobs.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const read = (file: string) => readFileSync(new URL(`../../../${file}`, import.meta.url), "utf8");
// 실제 브라우저 함수 본문을 실행한다. 부팅·DOM 배치가 아니라 표시 계약을 검사한다.
const fn = (source: string, name: string) => {
  const start = source.indexOf(`      const ${name} =`);
  const end = source.indexOf("\n      };", start);
  if (start < 0 || end < 0) throw Error(`missing function ${name}`);
  return source.slice(start, end + "\n      };".length);
};
export const check: RegressionCheck = {
  name: "usage-reporting-integrity",
  guards: "SDK 3회 호출이 1회가 되고 캐시 미보고가 섞인 작업을 정확한 적중률처럼 표시하던 것",
  run: async () => {
    const out: Assertion[] = [];
    __resetJobsForTest();
    try {
      const id = registerJob({ label: "usage", task: "synthetic", threadKey: "dashboard:usage", channel: "dashboard", channelUserId: "u" });
      const emit = (usage: ReturnType<typeof extractUsage>) => publishTurnDone(
        { adapter: "openai", model: "synthetic" },
        { channel: "cli", threadKey: `worker:${id}`, text: "synthetic" }, { text: "done", usage }, 1,
      );
      const sdk = new Usage();
      for (let i = 0; i < 3; i++) sdk.add(new Usage({ requests: 1, inputTokens: 1000, outputTokens: 10, inputTokensDetails: { cached_tokens: 800 } }));
      const usage = extractUsage({ state: { usage: sdk } });
      emit(usage);
      const known = structuredClone(getJob(id)!.usage!);
      out.push(assert("SDK 3요청의 누적 토큰을 곱하지 않고 잡까지 전달", known.requests === 3 && known.inputTokens === 3000 && known.outputTokens === 30 && known.cachedTokens === 2400 && known.unreportedCacheTurns === 0, known));
      emit(extractUsage({ state: { usage: new Usage({ requests: 1, inputTokens: 1000, outputTokens: 10 }) } }));
      // 미보고 뒤 보고된 0이 와도 완전한 합계로 되돌리지 않는다.
      emit(extractUsage({ state: { usage: new Usage({ requests: 1, inputTokens: 1000, outputTokens: 10, inputTokensDetails: { cached_tokens: 0 } }) } }));
      const partial = structuredClone(getJob(id)!.usage!);
      out.push(assert("미보고와 관측된 캐시 0을 구별하며 후속 턴에도 유지", partial.unreportedCacheTurns === 1 && partial.unreportedTurns === 0 && partial.cachedTokens === 2400 && partial.inputTokens === 5000 && partial.requests === 5, partial));
      const locale = JSON.parse(read("locales/ko.json"));
      const tokenSource = read("packages/dashboard/js/token-delta.js");
      const script = fn(tokenSource, "usageSummary") + "\n" + fn(read("packages/dashboard/js/background-drawer.js"), "setJobUsage") + "\n" + fn(tokenSource, "setTurnCost") + "\n({setJobUsage,setTurnCost})";
      const card = { costEl: { textContent: "", title: "", classList: { add() {} } } };
      const ui = runInNewContext(script, {
        fmtTokens: (n: number) => String(n),
        i18n: (key: string, args: Record<string, unknown> = {}) => (locale[key] as string).replace(/\{(\w+)\}/g, (_, k: string) => String(args[k])),
        cardByThread: new Map([["test", card]]),
      });
      const render = (u: unknown) => { const entry = { usageEl: { textContent: "", title: "", style: {} } }; ui.setJobUsage(entry, u); return entry.usageEl; };
      const fullView = render(known), partialView = render(partial);
      out.push(assert("완전한 합계는 적중률 표시, 불완전 합계는 비율·실효 입력 대신 안내", fullView.textContent.includes("80%") && !partialView.textContent.includes("%") && partialView.title.includes(locale["bg.usage.cacheUnknown"]) && !partialView.title.includes("2,600"), { fullView, partialView }));
      emit(undefined);
      const absent = render({ ...known, unreportedTurns: getJob(id)!.usage!.unreportedTurns });
      out.push(assert("턴 전체 미보고도 캐시 계산을 숨기고 하한 표시", absent.textContent.endsWith("+") && !absent.textContent.includes("%"), absent));
      const failedId = registerJob({ label: "failed", task: "synthetic", threadKey: "dashboard:usage", channel: "dashboard", channelUserId: "u" });
      const fail = (threadKey: string) => getEventBus().publish({ type: "llm.turn_error", ts: Date.now(), payload: { threadKey, errorKind: "unknown", hasFallback: true } });
      fail(`agent:${failedId}`);
      fail("dashboard:usage");
      fail("worker:missing");
      const failedOnly = { ...getJob(failedId)!.usage! };
      const failedView = render(failedOnly);
      out.push(assert("실패뿐인 자식 잡은 관측 요청 0을 실제 비용 0으로 표시하지 않음", failedOnly.turns === 0 && failedOnly.requests === 0 && failedOnly.unreportedFailedAttempts === 1 && failedView.textContent.includes("실패 시도 1회") && failedView.textContent.includes("미확인"), { failedOnly, failedView }));
      publishTurnDone({ adapter: "openai", model: "synthetic" }, { channel: "cli", threadKey: `agent:${failedId}`, text: "synthetic" }, { text: "done", usage }, 1);
      const recovered = { ...getJob(failedId)!.usage! };
      const recoveredView = render(recovered);
      out.push(assert("실패 후 성공해도 실패 비용 미확인·하한 표시를 유지하며 성공분만 합산", recovered.turns === 1 && recovered.requests === 3 && recovered.inputTokens === 3000 && recovered.unreportedFailedAttempts === 1 && recoveredView.textContent.endsWith("+") && !recoveredView.textContent.includes("%"), { recovered, recoveredView }));
      const replayEntry = { usageEl: { textContent: "", title: "", style: {} } };
      ui.setJobUsage(replayEntry, recovered);
      const beforeReplay = replayEntry.usageEl.textContent;
      ui.setJobUsage(replayEntry, { ...recovered, unreportedFailedAttempts: 0 });
      out.push(assert("같은 완료 턴 수의 오래된 스냅샷이 실패 미보고 상태를 지우지 않음", replayEntry.usageEl.textContent === beforeReplay, replayEntry));
      const summaryId = registerJob({ label: "summary", task: "synthetic", threadKey: "dashboard:usage", channel: "dashboard", channelUserId: "u" });
      let summaryEvent: Record<string, unknown> | undefined;
      const offSummary = getEventBus().subscribe(e => { if (e.type === "llm.auxiliary_usage") summaryEvent = e.payload; });
      beginSummaryUsage(`agent:${summaryId}`, "openai", "synthetic")(true, { inputTokens: 100, outputTokens: 10 });
      offSummary();
      getEventBus().publish({ type: "llm.auxiliary_usage", ts: Date.now(), payload: summaryEvent! });
      const summaryOnly = structuredClone(getJob(summaryId)!.usage!);
      const summaryView = render(summaryOnly);
      out.push(assert("별도 요약은 중복 합산 없이 본 작업 0턴과 분리 표시", summaryOnly.turns === 0 && summaryOnly.inputTokens === 0 && summaryOnly.summary?.executions === 1 && summaryOnly.summary.inputTokens === 100 && summaryView.textContent.includes("요약 1회") && summaryView.textContent.includes("100"), { summaryOnly, summaryView }));
      beginSummaryUsage(`agent:${summaryId}`, "openai", "synthetic")(false);
      publishTurnDone({ adapter: "openai", model: "synthetic" }, { channel: "cli", threadKey: `agent:${summaryId}`, text: "synthetic" }, { text: "done", usage }, 1);
      const both = structuredClone(getJob(summaryId)!.usage!);
      const bothView = render(both);
      out.push(assert("본 작업과 요약을 구분하고 요약 미보고도 유지", both.inputTokens === 3000 && both.summary?.inputTokens === 100 && both.summary.unreported === 1 && bothView.textContent.includes("본 작업") && bothView.textContent.includes("요약 2회") && bothView.textContent.includes("미확인"), { both, bothView }));
      const summaryEntry = { usageEl: { textContent: "", title: "", style: {} } };
      ui.setJobUsage(summaryEntry, both);
      ui.setJobUsage(summaryEntry, { ...both, summary: summaryOnly.summary });
      out.push(assert("과거 스냅샷이 요약 누적을 되돌리지 않음", summaryEntry.usageEl.textContent === bothView.textContent, summaryEntry));
      emit({ ...usage!, unreportedRequests: 1 });
      const retryState = structuredClone(getJob(id)!.usage!);
      const retryView = render(retryState);
      out.push(assert("완료 이벤트의 미관측 요청 계수가 잡 원장과 화면까지 전달", retryState.unreportedRequests === 1 && retryView.textContent.endsWith("+") && !retryView.textContent.includes("%") && retryView.title.includes("전송 시도 1회"), { retryState, retryView }));
      ui.setTurnCost("test", { spend: turnSpend(usage), inputTokens: usage!.inputTokens });
      out.push(assert("누적 SDK 입력을 마지막 호출 입력으로 오표시하지 않음", card.costEl.textContent.includes("3회") && !card.costEl.title.includes("마지막") && card.costEl.title.includes("3,000"), card.costEl));
      // 같은 페이로드를 채팅 줄도 하한으로 그린다 — 잡 카드만 «미확인» 이면 메인 스레드는 정확값처럼 보인다(싱크 레드팀 A P1).
      ui.setTurnCost("test", { spend: { input: 1000, cached: 800, output: 10, requests: 1 }, inputTokens: 1000, unreportedRequests: 1 });
      out.push(assert("채팅 줄도 미관측 전송 시도가 있으면 하한 표시·적중률 숨김", card.costEl.textContent.endsWith("+") && !card.costEl.textContent.includes("%") && card.costEl.title.includes("전송 시도 1회"), card.costEl));
      ui.setTurnCost("test", { spend: { input: 1000, cached: 800, output: 10, requests: 1 }, inputTokens: 1000 });
      out.push(assert("미관측이 없으면 채팅 줄은 종전대로 적중률 표시", card.costEl.textContent.includes("80%") && !card.costEl.textContent.endsWith("+"), card.costEl));
      const loop = turnSpend({ inputTokens: 1000, outputTokens: 10, iterations: 3, inputTokensTotal: 2500, outputTokensTotal: 25 });
      out.push(assert("기존 Claude/Codex 반복 합계 선택 유지", loop?.requests === 3 && loop.input === 2500 && loop.output === 25, loop));
      for (const requests of [-1, 0, 1.5, NaN]) {
        const invalid = extractUsage({ state: { usage: { requests, inputTokens: 10, outputTokens: 1 } } });
        out.push(assert(`잘못된 SDK 횟수 ${String(requests)}를 관측값으로 보존하지 않음`, invalid?.requests === undefined, { requests: String(requests), invalid }));
      }
      return out;
    } finally { __resetJobsForTest(); }
  },
};
