/**
 * 회귀: **플러그인 MCP 팩토리 하나가 던져도 턴은 산다** (2026-10-09, 전체 적대 검토 P4).
 *
 * ★사고(검토자 실행 재현): `getRegisteredMcpServers` 가 팩토리를 격리 없이 `map` 했다. 그래서
 *  «부팅 땐 서버를 내고, 턴마다 설정 값이 없으면 던지는» 흔한 모양의 플러그인 하나가
 *  **모든** 턴을 죽였다 — 메인 턴도, 도구가 필요 없는 내부 분류 호출도. 어댑터 호출 0.
 *
 * 지키는 것 넷:
 *  ① 메인 턴은 **그 서버만 빼고** 어댑터까지 간다(다른 플러그인 도구는 그대로 실린다).
 *  ② `toolPolicy:none` 이면 팩토리를 **아예 안 부른다**(걷어낼 것을 만들려고 남의 코드를 안 돌린다).
 *  ③ 경고는 (서버, 대화) 당 **한 번** — 매 턴 같은 줄은 배경 소음이다.
 *  ④ 화면이 볼 `plugin.error` 가 그 플러그인 이름으로 나간다.
 *
 * 등급: **전부 동작** — 실제 `wirePlugin` 배선 + `runRegionA` 실행(가짜 어댑터).
 */
import { getEventBus } from "../../core/eventbus.js";
import { __setAdapterForTest, runRegionA } from "../../core/llm-runtime/index.js";
import { registerMcpServer, unregisterMcpServer } from "../../core/mcp-registry.js";
import { wirePlugin } from "../../core/plugins/wire.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "plugin-mcp-factory-throw-isolated",
  guards:
    "플러그인 MCP 팩토리 하나가 턴마다 던지면(설정 값 없음 등) 데몬의 모든 LLM 턴 — 메인 턴과 도구가 필요 없는 내부 분류 호출까지 — 이 어댑터 호출 0으로 죽던 것(2026-10-09 전체 적대 검토 P4)",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const FLAKY = "regr-flaky-mcp";
    const GOOD = "regr-good-mcp";
    let factoryCalls = 0;
    class Flaky {
      getMcpServer(host?: { settings?: Record<string, unknown> }): unknown {
        factoryCalls += 1;
        // 부팅(host 없음)엔 서버를 내고, 턴마다(host 있음) 설정이 없으면 던진다 — 흔한 모양.
        if (host !== undefined && host.settings?.["apiKey"] === undefined) {
          throw new Error("apiKey 설정이 필요합니다");
        }
        return { type: "sdk", name: FLAKY, instance: {} };
      }
    }
    const errors: string[] = [];
    const unsub = getEventBus().subscribe((e) => {
      const p = e.payload as { pluginName?: string; phase?: string } | undefined;
      if (e.type === "plugin.error" && p?.pluginName === FLAKY) errors.push(String(p.phase));
    });
    const wired = await wirePlugin(
      {
        manifest: { schemaVersion: 1, kind: ["service"], name: FLAKY, entry: "x" },
        pluginDir: "/tmp/regr-flaky-mcp",
        capabilities: ["service"],
        instance: new Flaky(),
      },
      { bus: getEventBus(), channels: [], serviceStops: [] },
    );
    registerMcpServer(GOOD, () => ({ type: "sdk", name: GOOD, instance: {} }) as never);

    const seen: string[][] = [];
    const restore = __setAdapterForTest(async (_a, input) => {
      seen.push(Object.keys(input.extraMcpServers ?? {}));
      return { text: "ok" } as never;
    });
    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (...a: unknown[]): void => {
      const line = a.map(String).join(" ");
      if (line.includes(FLAKY)) warns.push(line);
      else origWarn(...a);
    };
    const spec = [{ adapter: "claude" as const, model: "regr", provider: "anthropic" }];
    const results: string[] = [];
    try {
      for (let i = 0; i < 2; i++) {
        try {
          const r = await runRegionA(
            { text: "hi", threadKey: "regr:flaky-main", channel: "cli" as never },
            { specs: spec },
          );
          results.push(`main:${r.text}`);
        } catch (e) {
          results.push(`main:THREW ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      const callsBeforeNone = factoryCalls;
      try {
        const r = await runRegionA(
          {
            text: "classify",
            threadKey: "regr:flaky-classify",
            channel: "cli" as never,
            internal: true,
            toolPolicy: { mode: "none" },
          },
          { specs: spec },
        );
        results.push(`none:${r.text}`);
      } catch (e) {
        results.push(`none:THREW ${e instanceof Error ? e.message : String(e)}`);
      }
      const noneFactoryCalls = factoryCalls - callsBeforeNone;

      out.push(
        assert(
          "★★팩토리 하나가 던져도 메인 턴은 **어댑터까지 간다** — 그 서버만 빠지고 다른 플러그인 도구는 그대로 실린다",
          results[0] === "main:ok" &&
            results[1] === "main:ok" &&
            seen.length >= 2 &&
            !seen[0]!.includes(FLAKY) &&
            seen[0]!.includes(GOOD),
          `결과=${results.join(" | ")} · 첫 턴 서버=[${(seen[0] ?? []).join(",")}]`,
        ),
      );
      out.push(
        assert(
          "★★`toolPolicy:none` 이면 팩토리를 **안 부르고** 턴이 끝난다 — 도구가 필요 없던 분류 호출이 남의 예외로 죽지 않는다",
          results[2] === "none:ok" && noneFactoryCalls === 0 && (seen[2] ?? ["x"]).length === 0,
          `결과=${String(results[2])} · none 턴의 팩토리 호출=${String(noneFactoryCalls)} · 실린 서버=[${(seen[2] ?? []).join(",")}]`,
        ),
      );
      out.push(
        assert(
          "★같은 대화에서 두 턴이 실패해도 경고는 **한 번** — 매 턴 같은 줄은 진짜를 묻는다 · plugin.error 도 한 번(runtime)",
          warns.length === 1 && errors.length === 1 && errors[0] === "runtime",
          `경고 ${String(warns.length)}줄 · plugin.error ${JSON.stringify(errors)}`,
        ),
      );
    } finally {
      console.warn = origWarn;
      restore();
      unsub();
      unregisterMcpServer(GOOD);
      await wired.dispose();
    }
    return out;
  },
};
