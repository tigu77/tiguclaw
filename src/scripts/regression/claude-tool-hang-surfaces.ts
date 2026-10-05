/**
 * 회귀: claude 어댑터에서 **도구 하드 상한이 끊은 턴은 그 이름으로 올라온다** (2026-10-05 적대 검토 F2).
 *
 * `TOOL_HARD_TIMEOUT_MS` 가 도구를 끊으면 어댑터는 `abort(new ToolHangError(...))` 를 건다. 그런데 승격 목록이
 * 유휴·턴·잡 취소 셋뿐이라 SDK 원문 «Claude Code process aborted by user» 가 그대로 올라갔다 — 사용자 안내
 * 원인이 «사용자가 중단» 이 되고, 이름 분류(`ToolHangError → tool`)는 실제 경로에서 한 번도 안 닿았다.
 * ★승격하면 문장에 **서드파티 도구 이름**이 실린다. 쿨다운 판정이 그 문장을 파싱하면 `rate_limit_status`
 *  같은 이름 하나로 모델이 «사용량 한도» 로 쉬게 된다 — 그 반대편도 같이 잰다.
 *
 * 등급: **동작** — 가짜 SDK 스트림을 runClaude 에 흘린다. 모델 호출 0.
 */
import { runClaude, withFakeClaudeQuery } from "../../core/llm-runtime/adapters/claude-agent-sdk.js";
import { clearCooldowns, parseModelSpec, registerCooldownIfRateLimited } from "../../core/llm-runtime/index.js";
import { ToolHangError } from "../../core/llm-runtime/tool-watchdog.js";
import { failureOutcome, failureKind } from "../../core/worker-jobs.js";
import { isSelfHandled } from "../../core/health-sweep.js";
import { readFileSync } from "node:fs";
import { assert, assertIsolated, within, type Assertion, type RegressionCheck } from "./_framework.js";

type Frame = Record<string, unknown>;

/** 도구를 하나 부르고 그 도구가 끝나지 않는다 — SDK 는 abort 되면 원문 오류를 던지거나(`silentEnd=false`) 조용히 끝난다. */
const hangingQueryWith = (silentEnd: boolean) => ((args: { prompt: unknown; options?: { abortController?: AbortController } }) => {
  const signal = args.options?.abortController?.signal;
  const prompt = args.prompt as AsyncIterable<unknown> | string;
  return (async function* (): AsyncGenerator<Frame> {
    if (typeof prompt !== "string") await prompt[Symbol.asyncIterator]().next();
    yield { type: "system", subtype: "init", session_id: "sess-hang", model: "claude-fake" };
    yield {
      type: "assistant",
      session_id: "sess-hang",
      parent_tool_use_id: null,
      message: {
        role: "assistant",
        model: "claude-fake",
        content: [{ type: "tool_use", id: "toolu_hang1", name: "mcp__ext__rate_limit_status", input: {} }],
      },
    };
    await new Promise<void>((resolve) => {
      if (signal === undefined || signal.aborted) return resolve();
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
    if (silentEnd) return; // SDK 는 abort 시 던지지 않고 조용히 끝나기도 한다 — 그 경로도 승격해야 한다
    throw new Error("Claude Code process aborted by user");
  })();
}) as never;
const hangingQuery = hangingQueryWith(false);

export const check: RegressionCheck = {
  name: "claude-tool-hang-surfaces",
  guards:
    "claude 어댑터가 도구 하드 상한으로 끊은 턴을 SDK 원문 «aborted by user» 로 올려 원인이 «사용자 중단» 으로 안내되던 것 + 그 승격이 서드파티 도구 이름으로 쿨다운을 거는 것",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const saved = { key: process.env.ANTHROPIC_API_KEY, hard: process.env.TOOL_HARD_TIMEOUT_MS };
    process.env.ANTHROPIC_API_KEY = "regression-fake-key";
    process.env.TOOL_HARD_TIMEOUT_MS = "60";
    let err: unknown;
    let silentErr: unknown;
    let silentResult = "";
    try {
      const r = await within(
        10_000,
        "가짜 SDK 도구 멈춤",
        withFakeClaudeQuery(hangingQuery, () =>
          runClaude({ text: "x", threadKey: `regr:tool-hang:${Math.random()}`, channel: "cli" } as never),
        ).catch((e: unknown) => {
          err = e;
        }),
      );
      if ("timedOut" in r) err = new Error(r.timedOut);
      const r2 = await within(
        10_000,
        "가짜 SDK 도구 멈춤(조용한 종결)",
        withFakeClaudeQuery(hangingQueryWith(true), () =>
          runClaude({ text: "x", threadKey: `regr:tool-hang-silent:${Math.random()}`, channel: "cli" } as never),
        ).then(
          (v) => { silentResult = `성공으로 끝남 text=${JSON.stringify((v as { text?: string }).text)}`; },
          (e: unknown) => { silentErr = e; },
        ),
      );
      if ("timedOut" in r2) silentErr = new Error(r2.timedOut);
    } finally {
      if (saved.key === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = saved.key;
      if (saved.hard === undefined) delete process.env.TOOL_HARD_TIMEOUT_MS;
      else process.env.TOOL_HARD_TIMEOUT_MS = saved.hard;
    }
    const outcome = failureOutcome(err);
    const kind = "error" in outcome ? failureKind(outcome.error, outcome.errorName) : undefined;

    const spec = parseModelSpec("codex:gpt-6-sol") // 판정은 spec 과 무관 — 파싱되는 아무 spec;
    const key = spec === null ? "" : (spec.provider ?? spec.adapter);
    if (spec !== null) clearCooldowns(key);
    const cooled = spec === null ? "spec 없음" : registerCooldownIfRateLimited(spec, new ToolHangError("mcp__ext__rate_limit_status", 60));
    if (spec !== null) clearCooldowns(key);
    // 같은 문장을 읽는 다른 두 자리 — 메인 턴 오류 안내(index.ts)와 실패 집계(health-sweep). 문자열만 보면 도구 이름의
    //  «rate_limit» 으로 «사용량 한도» 가 된다(2026-10-05 재검토 P1). 둘 다 이름 먼저다.
    const hangMsg = new ToolHangError("mcp__ext__rate_limit_status", 60).message;
    const sweepHang = isSelfHandled(JSON.stringify({ message: hangMsg, errorName: "ToolHangError" }));
    const sweepLimit = isSelfHandled(JSON.stringify({ message: 'HTTP 429 {"error":{"type":"usage_limit_reached"}}' }));
    const idx = readFileSync(new URL("../../index.ts", import.meta.url), "utf8");
    const formatCalls = idx.match(/formatRegionAError\(detail[^)]*\)/g) ?? [];
    const runtimeSrc = readFileSync(new URL("../../core/llm-runtime/index.ts", import.meta.url), "utf8");
    return [
      assert(
        "★SDK 가 abort 뒤 조용히 끝나도 ToolHangError 로 올라온다(성공·빈 답으로 끝나면 원인이 안 보인다)",
        silentErr instanceof Error && silentErr.name === "ToolHangError",
        silentErr instanceof Error ? `${silentErr.name}` : silentResult || "★던지지 않음",
      ),
      assert(
        "★실패 집계는 멈춘 도구를 «이미 쿨다운 통지된 한도 실패» 로 빼지 않는다 — 진짜 429 는 뺀다",
        sweepHang === false && sweepLimit === true,
        `도구멈춤=${sweepHang} · 429=${sweepLimit}`,
      ),
      assert(
        "★메인 턴 오류 안내가 오류 이름을 받는다(두 호출 다) · turn_error 가 이름을 싣는다 — 문자열만 보면 도구 이름으로 «한도» 안내",
        formatCalls.length >= 2 && formatCalls.every((c) => /detail, errName\)/.test(c)) &&
          /const isLimit = failureKind\(d, errorName\) === "limit"/.test(idx) && /errorName: e\.name/.test(runtimeSrc),
        `호출 ${formatCalls.join(" · ")}`,
      ),
      assert(
        "★도구 하드 상한이 끊은 턴은 ToolHangError 로 올라오고 분류는 «도구» 다(«aborted by user» 아님)",
        err instanceof Error && err.name === "ToolHangError" && kind === "tool",
        err instanceof Error ? `${err.name}: ${err.message.slice(0, 80)} · 분류=${kind}` : `던지지 않음: ${String(err)}`,
      ),
      assert(
        "★도구 이름이 «rate_limit» 이어도 그 모델에 쿨다운을 걸지 않는다(서드파티 이름이 한도 판정에 들어가지 않는다)",
        cooled === null,
        cooled === null ? "쿨다운 없음" : `★쿨다운: ${JSON.stringify(cooled)}`,
      ),
    ];
  },
};
