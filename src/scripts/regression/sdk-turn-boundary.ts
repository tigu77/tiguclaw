/**
 * 회귀: **한 스트림에 여러 턴이 실려도 답변은 이 턴의 것만** (2026-08-06 실사고).
 *
 * 사고: 사용자가 아무 말도 안 했는데 비서가 "알겠습니다. 멈추겠습니다" 라고 답했다.
 * 실측(회사 PC 대시보드 세션, 마지막 사용자 입력 14:36:03 / 다음 인입 14:59:57):
 *   14:59:44 result/success            ← 진짜 답변(작업 요약)
 *   14:59:45 system/task_notification  ← SDK 백그라운드 Task 가 끝났다는 알림
 *   14:59:45 system/init               ← ★그 알림이 **새 턴**을 시작시켰다
 *   14:59:56 result/success            ← "알겠습니다. 멈추겠습니다"(알림에 대한 대답)
 *
 * SDK 0.3 의 새 동작이다(0.1 엔 없었다): 블로킹 도구를 백그라운드로 돌리면 턴이 즉시
 * 이어지고, 작업이 settle 하면 `task_notification`(completed|failed|stopped)이 나며 그게
 * 대화를 재개한다. 우리 루프는 `result` 에서 안 끊고 스트림 끝까지 먹었으므로:
 *  ①두 턴 텍스트가 한 답변으로 이어붙어 화면에 나갔고(`…알려드리겠습니다.Unity MCP는…`)
 *  ②`resultText = msg.result` 가 **대입**이라 첫 result 본문이 마지막 것으로 덮였다 —
 *   스트림 1,646자 / 확정 답변 279자. 사용자가 시키지도 않은 문장만 기록에 남았다.
 *
 * ★부류: **상류 SDK 가 계약을 넓혔는데 우리 소비가 옛 가정에 머문 것**. `dependency-minor-drift`
 *  가 버전 드리프트를 잡는다면 이건 *의미* 드리프트다 — 같은 필드가 다른 것을 뜻하게 된 것
 *  (usage 필드가 0.3 에서 스냅샷이 된 것과 같은 날 같은 부류로 두 번째다).
 */
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";
import { sourceHas, sourceOrder } from "./_wiring.js";

const ADAPTER = "../../core/llm-runtime/adapters/claude-agent-sdk.ts";

export const check: RegressionCheck = {
  name: "sdk-turn-boundary",
  guards:
    "SDK 가 알림으로 새 턴을 열면 그 텍스트가 사용자 답변에 섞이고 진짜 답변을 덮던 것",
  run: async (): Promise<Assertion[]> => {
    // ★순서가 곧 정확성이다: 가드가 **타입 분기보다 앞**에 있어야 새 턴의 assistant·
    //  stream_event·result 가 전부 걸린다. 뒤에 두면 텍스트는 이미 조립된 뒤다.
    const order = await sourceOrder(ADAPTER, [
      /let turnResultSeen = false;/,
      /if \(turnResultSeen\) \{/, // ← 분기 전 가드
      /if \(msg\.type === "system" && msg\.subtype === "init"\)/,
      /msg\.type === "result"/,
      /turnResultSeen = true;/,
    ]);
    // 버리되 **조용히** 버리지 않는다(이 레포에서 조용한 폐기는 반복 사고다).
    const loud = await sourceHas(ADAPTER, [
      /\[claude-turn-boundary\]/,
      /postResultMsgs/,
    ]);
    // 알림 status 를 로그에 싣는다 — 이번 진단에서 stopped 인지 completed 인지 못 갈랐다.
    const statusLogged = await sourceHas(ADAPTER, [
      /sub === "task_notification"/,
      /status=\$\{String\(\(msg as \{ status\?: unknown \}\)\.status\)\}/,
    ]);

    return [
      assert(
        "★첫 result 이후 도착분이 답변 조립 **이전에** 걸러진다(순서까지)",
        order.ok,
        order.ok ? "가드가 타입 분기보다 앞" : `순서 위반: ${order.detail}`,
      ),
      assert(
        "폐기가 로그에 남는다(조용한 폐기 0)",
        loud.ok,
        loud.ok ? "claude-turn-boundary" : `누락: ${loud.missing.join(" / ")}`,
      ),
      assert(
        "★백그라운드 Task 알림의 status 가 로그에 실린다(stopped/completed 판별)",
        statusLogged.ok,
        statusLogged.ok ? "status+summary" : `누락: ${statusLogged.missing.join(" / ")}`,
      ),
    ];
  },
};
