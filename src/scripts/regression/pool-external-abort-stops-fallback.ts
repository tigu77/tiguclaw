/**
 * 회귀: **밖에서 끊긴 턴은 풀의 다음 후보로 안 간다** (2026-10-09, 전체 적대 검토 P2~3).
 *
 * ★사고(검토자 실행 재현): `runPool` 의 단락이 **이름**으로 골랐다(UserCancelled·
 *  WorkerCancelled·TurnTimeout). 신호를 끊는 주체는 그 셋만이 아니다 — 매니저 시한
 *  (`WorkerTimeoutError`)·재시작 중단·분류 8초 시한도 같은 `abortSignal` 을 끊는다. 그래서
 *  [codex,claude,openai] 에서 매니저 시한이 지나면 어댑터 **3회**, `turn_error` **3건**, 그중
 *  둘이 `hasFallback:true`(«다른 모델로 이어서 시도합니다» — 거짓 안내)였다.
 *
 * 지키는 것 셋:
 *  ① 어댑터는 **한 번만** 불린다(같은 신호라 다음 후보도 즉시 죽는다 — 시도가 무의미).
 *  ② `turn_error` 는 **한 건**이고 `hasFallback:false` 다(후처리는 지나고 단락한다).
 *  ③ 신호가 멀쩡하면 종전대로 다음 후보로 간다(단락이 폴백 자체를 죽이면 그것도 결함이다).
 *
 * 등급: **전부 동작** — `runRegionA` 실행(가짜 어댑터) + 버스 관측.
 */
import { getEventBus } from "../../core/eventbus.js";
import { __setAdapterForTest, runRegionA } from "../../core/llm-runtime/index.js";
import { WorkerTimeoutError } from "../../core/worker-jobs.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const POOL = [
  { adapter: "codex-oauth" as const, model: "regr-a", provider: "codex" },
  { adapter: "claude" as const, model: "regr-b", provider: "anthropic" },
  { adapter: "openai" as const, model: "regr-c", provider: "openai" },
];

export const check: RegressionCheck = {
  name: "pool-external-abort-stops-fallback",
  guards:
    "매니저 시한·재시작 중단·분류 시한처럼 이름 목록에 없는 주체가 턴 신호를 끊어도 runPool 이 풀의 나머지 후보를 다 시도해, 어댑터 3회·turn_error 3건·«다른 모델로 이어서 시도합니다» 거짓 안내가 나가던 것(2026-10-09 전체 적대 검토)",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const errs: Array<{ tk: string; hasFallback: boolean }> = [];
    const unsub = getEventBus().subscribe((e) => {
      if (e.type !== "llm.turn_error") return;
      const p = e.payload as { threadKey?: string; hasFallback?: boolean };
      if (p.threadKey?.startsWith("regr:abort-") === true) {
        errs.push({ tk: p.threadKey, hasFallback: p.hasFallback === true });
      }
    });
    const calls: Record<string, string[]> = {};
    const restore = __setAdapterForTest(async (adapter, input) => {
      (calls[input.threadKey] ??= []).push(adapter);
      if (input.abortSignal?.aborted === true) throw input.abortSignal.reason as Error;
      throw new Error("regression: 이 후보는 실패한다 — 다음 후보로 가야 한다");
    });
    try {
      // ① ② 매니저 시한으로 끊긴 신호.
      const ac = new AbortController();
      ac.abort(new WorkerTimeoutError(1));
      let thrown = "";
      try {
        await runRegionA(
          { text: "probe", threadKey: "regr:abort-timeout", channel: "cli" as never, abortSignal: ac.signal },
          { chain: [POOL] },
        );
      } catch (e) {
        thrown = e instanceof Error ? e.name : String(e);
      }
      const aborted = calls["regr:abort-timeout"] ?? [];
      const abortedErrs = errs.filter((x) => x.tk === "regr:abort-timeout");
      out.push(
        assert(
          "★★밖에서 끊긴 신호면 어댑터는 **한 번만** 불린다 — 같은 신호라 다음 후보도 즉시 죽는다",
          aborted.length === 1 && thrown === "WorkerTimeoutError",
          `어댑터 ${String(aborted.length)}회 [${aborted.join(",")}] · 던진 것=${thrown}`,
        ),
      );
      out.push(
        assert(
          "★★`turn_error` 는 **한 건**, `hasFallback:false` — «다른 모델로 이어서 시도합니다» 는 거짓이다",
          abortedErrs.length === 1 && abortedErrs[0]?.hasFallback === false,
          `turn_error ${String(abortedErrs.length)}건 · hasFallback=${JSON.stringify(abortedErrs.map((x) => x.hasFallback))}`,
        ),
      );

      // ③ 신호가 멀쩡하면 종전대로 폴백한다.
      try {
        await runRegionA(
          { text: "probe", threadKey: "regr:abort-none", channel: "cli" as never, abortSignal: new AbortController().signal },
          { chain: [POOL] },
        );
      } catch {
        /* 셋 다 실패하도록 지었다 */
      }
      const normal = calls["regr:abort-none"] ?? [];
      const normalErrs = errs.filter((x) => x.tk === "regr:abort-none");
      out.push(
        assert(
          "★신호가 멀쩡하면 **종전대로** 다음 후보로 간다 — 단락이 폴백 자체를 죽이면 그것도 결함이다",
          normal.length === 3 && normalErrs.length === 3 && normalErrs[0]?.hasFallback === true,
          `어댑터 ${String(normal.length)}회 · turn_error ${String(normalErrs.length)}건 · hasFallback=${JSON.stringify(normalErrs.map((x) => x.hasFallback))}`,
        ),
      );
    } finally {
      restore();
      unsub();
    }
    return out;
  },
};
