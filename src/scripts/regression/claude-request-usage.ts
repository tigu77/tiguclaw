import { readFileSync } from "node:fs";
import { createClaudeRequestUsage } from "../../core/llm-runtime/adapters/_claude-request-usage.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const base = { inputTokens: 100, outputTokens: 20, inputTokensTotal: 500 };
const event = (e: unknown, parent: string | null = null) => ({ type: "stream_event", parent_tool_use_id: parent, event: e });
const start = (id: string, usage: unknown = { input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 30, output_tokens: 1 }) =>
  event({ type: "message_start", message: { id, model: "synthetic-model", usage } });
const delta = (usage: unknown) => event({ type: "message_delta", usage });
const stop = () => event({ type: "message_stop" });

export const check: RegressionCheck = {
  name: "claude-request-usage",
  guards: "Claude의 요청 시작 스냅샷과 최종 사용량을 구분하지 못하고 요청 경계를 버리던 것",
  run: async (): Promise<Assertion[]> => {
    const assertions: Assertion[] = [];
    const c = createClaudeRequestUsage();
    c.observe(start("a"));
    assertions.push(assert("시작 스냅샷은 완료 요청이 아님", c.withUsage(base)?.requestUsageEntries === undefined, c.withUsage(base)));
    c.observe(delta({ output_tokens: 5 })); c.observe(delta({ output_tokens: 12 }));
    assertions.push(assert("델타만 받은 진행 중 요청도 보류", c.withUsage(base)?.requestUsageEntries === undefined, c.withUsage(base)));
    c.observe(stop());
    const one = c.withUsage(base);
    assertions.push(assert("시작 입력과 최종 누적 출력 조립", one?.requestUsageEntries?.[0]?.inputTokens === 60 && one.requestUsageEntries[0].outputTokens === 12, one));
    assertions.push(assert("캐시 생성·읽기·실제 모델 구별", one?.requestUsageEntries?.[0]?.cacheCreationTokens === 30 && one.requestUsageEntries[0].cachedTokens === 20 && one.requestUsageEntries[0].model === "synthetic-model", one));
    assertions.push(assert("마지막 호출 보존, 세션 누적 대신 현재 요청만 집계", one?.inputTokens === 100 && one.outputTokens === 20 && one.inputTokensTotal === 60 && one.outputTokensTotal === 12 && one.cachedTokensTotal === 20 && one.iterations === 1, one));
    c.observe(stop()); c.observe(start("a")); c.observe(delta({ output_tokens: 100 })); c.observe(stop());
    assertions.push(assert("동일 메시지 재전달·중복 stop 중복 계상 방지", c.withUsage(base)?.requestUsageEntries?.length === 1, c.withUsage(base)));
    c.observe(start("broken")); c.observe(delta({ output_tokens: 99 })); c.resetPending(); c.observe(stop());
    c.observe(start("b", { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })); c.observe(delta({ output_tokens: 0 })); c.observe(stop());
    const two = c.withUsage(base);
    assertions.push(assert("재개 이전 누적·중복·미완료·재시도를 현재 턴 합계에 더하지 않음", two?.inputTokensTotal === 60 && two.outputTokensTotal === 12 && two.iterations === 2, two));
    assertions.push(assert("완료 요청이 없으면 세션 합계를 폴백하지 않음", createClaudeRequestUsage().withUsage(base)?.inputTokensTotal === 100, {}));
    assertions.push(assert("재시도는 미완료 요청만 버리고 이전 완료 기록 유지", two?.requestUsageEntries?.length === 2 && two.requestUsageEntries[0]?.outputTokens === 12, two));
    assertions.push(assert("명시 0 요청은 보존", two?.requestUsageEntries?.[1]?.inputTokens === 0 && two.requestUsageEntries[1].outputTokens === 0 && two.requestUsageEntries[1].cachedTokens === 0, two));
    two!.requestUsageEntries![0]!.inputTokens = 999;
    assertions.push(assert("반환 객체 변경과 수집 상태 격리", c.withUsage(base)?.requestUsageEntries?.[0]?.inputTokens === 60, c.withUsage(base)));
    const nested = { ...start("nested"), parent_tool_use_id: "tool-child" };
    c.observe(nested); c.observe(event({ type: "message_delta", usage: { output_tokens: 20 } }, "tool-child")); c.observe(event({ type: "message_stop" }, "tool-child"));
    assertions.push(assert("SDK 중첩 요청을 부모 기록에 섞지 않음", c.withUsage(base)?.requestUsageEntries?.length === 2, c.withUsage(base)));
    for (const usage of [{ input_tokens: 1 }, { input_tokens: -1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, { input_tokens: 1, cache_read_input_tokens: "0", cache_creation_input_tokens: 0 }]) {
      const bad = createClaudeRequestUsage(); bad.observe(start("bad", usage)); bad.observe(delta({ output_tokens: 1 })); bad.observe(stop());
      assertions.push(assert("누락·잘못된 입력을 0으로 채우지 않음", bad.withUsage(base)?.requestUsageEntries === undefined, { usage, result: bad.withUsage(base) }));
    }
    // 완료 A → 미완료 B → 중복/잘못된 start 뒤 델타가 B로 흘러가면 안 된다.
    for (const [label, nextStart] of [
      ["중복", start("seen")],
      ["message 누락", event({ type: "message_start" })],
      ["id 형식 오류", event({ type: "message_start", message: { id: 7 } })],
    ] as const) {
      const boundary = createClaudeRequestUsage();
      boundary.observe(start("seen")); boundary.observe(delta({ output_tokens: 2 })); boundary.observe(stop());
      const completed = JSON.stringify(boundary.withUsage(base)?.requestUsageEntries);
      boundary.observe(start("unfinished")); boundary.observe(delta({ output_tokens: 50 }));
      boundary.observe(nextStart); boundary.observe(delta({ output_tokens: 99 })); boundary.observe(stop());
      assertions.push(assert(`${label} start: 이전 미완료 요청과 합치지 않음`, JSON.stringify(boundary.withUsage(base)?.requestUsageEntries) === completed, boundary.withUsage(base)));
      boundary.observe(start("next", { input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }));
      boundary.observe(delta({ output_tokens: 3 })); boundary.observe(stop());
      const entries = boundary.withUsage(base)?.requestUsageEntries;
      assertions.push(assert(`${label} start 뒤 정상 요청은 독립 기록`, entries?.length === 2 && entries[1]?.inputTokens === 1 && entries[1]?.outputTokens === 3, entries));
    }
    const interrupted = createClaudeRequestUsage(); interrupted.observe(start("c")); interrupted.observe(stop());
    assertions.push(assert("최종 출력 없이 시작의 1을 기록하지 않음", interrupted.withUsage(base)?.requestUsageEntries === undefined, interrupted.withUsage(base)));
    const replaced = createClaudeRequestUsage(); replaced.observe(start("d")); replaced.observe(delta({ output_tokens: 7, input_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })); replaced.observe(stop());
    assertions.push(assert("최종 입력 갱신도 누적 합산하지 않고 대체", replaced.withUsage(base)?.requestUsageEntries?.[0]?.inputTokens === 40, replaced.withUsage(base)));
    assertions.push(assert("사용량 없는 기존 반환은 그대로", c.withUsage(undefined) === undefined, { result: c.withUsage(undefined) }));
    const source = readFileSync(new URL("../../core/llm-runtime/adapters/claude-agent-sdk.ts", import.meta.url), "utf8");
    assertions.push(assert("배선: 수집·재시도 경계·두 반환 연결", source.includes("requestUsage.observe(msg)") && source.includes("requestUsage.resetPending()") && source.includes("requestUsage.withUsage(toolCallUsage)") && source.includes("requestUsage.withUsage(lastUsage)"), { observe: source.includes("requestUsage.observe(msg)"), reset: source.includes("requestUsage.resetPending()"), returns: source.match(/requestUsage.withUsage\(/g)?.length }));
    return assertions;
  },
};
