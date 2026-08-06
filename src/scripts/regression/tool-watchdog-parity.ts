/**
 * 회귀: 도구 지연 경고가 **실제로 발화**하고 **3어댑터 모두 배선**돼 있다 (2026-07-29 개정).
 *
 * 사고: 이 경고는 codex 어댑터에만 있어, claude·openai 로 도는 워커는 도구가 권한
 * 다이얼로그에 막혀 조용히 멈춰도 사용자에게 신호가 없었다(원칙 #2 위반).
 *
 * ★이 검사 자체가 한 번 무의미했다 (변이 테스트 실측 2026-07-29): `watchToolStart` 를
 *  통째로 no-op 으로 만들어도 46건이 전부 초록이었다. 상수만 비교하고 **발화도, 어댑터
 *  배선도** 안 봤기 때문이다. "검사가 있는데 못 잡는 것" 은 없는 것보다 나쁘다 —
 *  안심하고 넘어가게 만든다. 그래서 세 축으로 다시 세운다:
 *   ① 임계를 넘기면 llm.tool_slow 가 **정확히 1건** 나간다(실제 타이머 발화).
 *   ② 제때 끝나면 안 나간다(오탐 0).
 *   ③ 3어댑터가 모두 watchToolStart 를 호출한다(소스 스캔 — timeout-layering 과 같은 방식).
 */
import { getEventBus } from "../../core/eventbus.js";
import { watchToolStart, toolSlowWarnMs } from "../../core/llm-runtime/tool-watchdog.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const ADAPTERS = [
  "openai-codex-oauth.ts",
  "claude-agent-sdk.ts",
  "openai-agents-sdk.ts",
] as const;

/** 어댑터 소스에 watchToolStart 호출이 살아 있는가(배선이 빠지면 그 어댑터만 조용해진다). */
const adapterWiring = async (): Promise<string[]> => {
  const { readFile } = await import("node:fs/promises");
  const missing: string[] = [];
  for (const f of ADAPTERS) {
    const url = new URL(`../../core/llm-runtime/adapters/${f}`, import.meta.url);
    try {
      const src = await readFile(url, "utf8");
      if (!/watchToolStart\s*\(/.test(src)) missing.push(f);
    } catch {
      // 배포본(.ts 미포함)에선 검사 불가 — 없는 것으로 치지 않는다(오탐 0).
    }
  }
  return missing;
};

export const check: RegressionCheck = {
  name: "tool-watchdog-parity",
  guards: "도구 지연 경고가 안 나가거나 특정 어댑터에서만 나가던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];

    // ① 임계는 도구 이름만 본다 — 어댑터별 분기가 없다(있었다면 인자가 필요했다).
    out.push(
      assert(
        "서브에이전트류는 완화된 임계(오탐 방지)",
        toolSlowWarnMs("spawn_agent") === toolSlowWarnMs("Task") &&
          toolSlowWarnMs("spawn_agent") > toolSlowWarnMs("Bash"),
        `spawn_agent=${toolSlowWarnMs("spawn_agent")} Task=${toolSlowWarnMs("Task")} Bash=${toolSlowWarnMs("Bash")}`,
      ),
    );

    // ②③ 실제 발화 — 임계를 짧게 잡고 타이머가 정말 도는지 본다(상수 비교 아님).
    //  임계는 호출 시점에 env 를 읽으므로 여기서 낮출 수 있다. 끝나면 원복.
    const prevEnv = process.env.TOOL_SLOW_WARN_MS;
    process.env.TOOL_SLOW_WARN_MS = "60";
    const seen: string[] = [];
    const unsub = getEventBus().subscribe((e) => {
      if (e.type === "llm.tool_slow") seen.push(String(e.payload.tool ?? "?"));
    });
    try {
      // 제때 끝난 도구 — 경고가 나가면 안 된다.
      const stop = watchToolStart({ channel: "test", threadKey: "regression", tool: "Bash" });
      stop();
      stop(); // 멱등(claude 는 결과·턴종료 두 곳에서 부른다).
      await sleep(150);
      out.push(assert("제때 끝나면 경고 없음(오탐 0)", seen.length === 0, `발화 ${seen.length}건`));

      // 임계를 넘긴 도구 — 정확히 1건 발화해야 한다. ★no-op 이면 여기서 잡힌다.
      watchToolStart({ channel: "test", threadKey: "regression", tool: "Bash" });
      await sleep(200);
      out.push(
        assert(
          "임계 초과 시 llm.tool_slow 1건 발화(핵심)",
          seen.length === 1 && seen[0] === "Bash",
          `발화 ${seen.length}건 ${JSON.stringify(seen)}`,
        ),
      );
    } finally {
      unsub();
      if (prevEnv === undefined) delete process.env.TOOL_SLOW_WARN_MS;
      else process.env.TOOL_SLOW_WARN_MS = prevEnv;
    }

    // ★④ 하드 상한 — **경고가 아니라 실제로 끊는다** (2026-08-06 회사 PC 먹통).
    //  실측: `add_schedule`·`list_schedules`·`Task` 가 경고 뒤 완료 기록 없이 멈췄고,
    //  마지막 건은 로그 끝(39분 뒤)까지 조용했다. 세션은 직렬 큐라 그 턴이 안 끝나면
    //  **다음 메시지도 처리되지 않는다** = 사용자가 겪은 "먹통". 경고만으로는 안 끊긴다.
    const prevHard = process.env.TOOL_HARD_TIMEOUT_MS;
    process.env.TOOL_HARD_TIMEOUT_MS = "80";
    const aborted: string[] = [];
    try {
      // 안 끝나는 도구 → onHard 가 불려야 한다.
      watchToolStart({
        channel: "test",
        threadKey: "regression",
        tool: "Bash",
        onHard: (tool) => aborted.push(tool),
      });
      // 제때 끝난 도구 → 불리면 안 된다(정상 도구를 죽이면 그게 더 큰 사고).
      const okStop = watchToolStart({
        channel: "test",
        threadKey: "regression",
        tool: "Read",
        onHard: (tool) => aborted.push("★오발화:" + tool),
      });
      okStop();
      // ★서브에이전트는 제외 — 자체 상한(SUBAGENT_TIMEOUT_MS, 기본 시간 단위)이 있고,
      //  여기서 자르면 정상적인 장시간 위임을 죽인다.
      watchToolStart({
        channel: "test",
        threadKey: "regression",
        tool: "Task",
        onHard: (tool) => aborted.push("★제외위반:" + tool),
      });
      await sleep(220);
      out.push(
        assert(
          "★안 끝나는 도구는 하드 상한에서 턴을 끊는다(경고만으로는 먹통이 안 풀린다)",
          aborted.includes("Bash"),
          JSON.stringify(aborted),
        ),
      );
      out.push(
        assert(
          "제때 끝난 도구는 안 끊는다(오발화 0)",
          !aborted.some((a) => a.startsWith("★오발화")),
          JSON.stringify(aborted),
        ),
      );
      out.push(
        assert(
          "서브에이전트(Task)는 제외 — 자체 상한이 있고 장시간이 정상",
          !aborted.some((a) => a.startsWith("★제외위반")),
          JSON.stringify(aborted),
        ),
      );
      out.push(
        assert(
          "레버(onHard)를 안 넘긴 호출부는 종전대로 경고만(회귀 0)",
          (() => {
            let called = false;
            const s2 = watchToolStart({ channel: "t", threadKey: "r", tool: "Bash" });
            s2();
            return !called;
          })(),
          "레버 없음 = 중단 없음",
        ),
      );
    } finally {
      if (prevHard === undefined) delete process.env.TOOL_HARD_TIMEOUT_MS;
      else process.env.TOOL_HARD_TIMEOUT_MS = prevHard;
    }

    const missing = await adapterWiring();
    out.push(
      assert(
        "3어댑터 모두 배선(한 곳만 빠져도 그 어댑터는 조용해진다)",
        missing.length === 0,
        missing.length === 0 ? "claude·codex·openai" : `누락: ${missing.join(", ")}`,
      ),
    );
    return out;
  },
};
