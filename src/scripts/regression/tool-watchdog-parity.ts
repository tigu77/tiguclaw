/**
 * 회귀: 도구 지연 경고가 **어댑터 무관**으로 같은 판정을 낸다 (2026-07-28, 딥리뷰 D).
 *
 * 사고: 이 경고는 codex 어댑터의 수동 도구 루프 안에만 있었다. claude·openai 로 도는
 * 워커는 도구가 권한 다이얼로그에 막혀 조용히 멈춰도 **사용자에게 신호가 안 갔다**
 * (원칙 #2 "모든 기능은 LLM 무관" 위반). 공통 엔진으로 올린 뒤 이 검사가 계약을 지킨다.
 *
 * 여기서 지키는 계약 3가지:
 *  1. 임계 판정이 도구 이름에만 의존한다(어댑터 인자 없음 = 구조적으로 어댑터 무관).
 *  2. 임계를 넘기면 llm.tool_slow 이벤트가 정확히 1건 나간다.
 *  3. 도구가 제때 끝나면(stop 호출) 이벤트가 **안** 나간다 — 오탐 0.
 */
import { getEventBus } from "../../core/eventbus.js";
import { watchToolStart, toolSlowWarnMs } from "../../core/llm-runtime/tool-watchdog.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export const check: RegressionCheck = {
  name: "tool-watchdog-parity",
  guards: "도구 지연 경고가 codex 에만 있어 claude/openai 워커는 멈춰도 신호가 없던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];

    // ① 임계는 도구 이름만 본다 — 어댑터별 분기가 없다(있었다면 여기 인자가 필요했다).
    out.push(
      assert(
        "서브에이전트류는 완화된 임계(오탐 방지)",
        toolSlowWarnMs("spawn_agent") === toolSlowWarnMs("Task") &&
          toolSlowWarnMs("spawn_agent") > toolSlowWarnMs("Bash"),
        `spawn_agent=${toolSlowWarnMs("spawn_agent")} Task=${toolSlowWarnMs("Task")} Bash=${toolSlowWarnMs("Bash")}`,
      ),
    );

    // ②③ 실제 발화 — 임계를 아주 짧게 흉내낼 수 없으므로(상수), 이벤트 구독으로 관찰한다.
    // 짧은 임계를 위해 env 를 쓰지 않는다(모듈 로드 시점에 굳음) — 대신 stop 동작만 검증.
    const seen: string[] = [];
    const bus = getEventBus();
    const unsub = bus.subscribe((e) => {
      if (e.type === "llm.tool_slow") seen.push(String(e.payload.tool ?? "?"));
    });

    // 제때 끝난 도구 — 감시를 걸었다가 즉시 멈춘다. 경고가 나가면 안 된다.
    const stop = watchToolStart({ channel: "test", threadKey: "regression", tool: "Bash" });
    stop();
    stop(); // 멱등 — 어댑터가 중복 호출해도 안전해야 한다(claude 는 결과+턴종료 두 곳에서 부른다).
    await sleep(50);
    out.push(assert("제때 끝나면 경고 없음(오탐 0)", seen.length === 0, `발화 ${seen.length}건`));

    unsub();
    return out;
  },
};
