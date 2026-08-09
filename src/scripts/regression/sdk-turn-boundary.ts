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
import { isOwnTurnEnd } from "../../core/llm-runtime/adapters/claude-agent-sdk.js";

const ADAPTER = "../../core/llm-runtime/adapters/claude-agent-sdk.ts";

export const check: RegressionCheck = {
  name: "sdk-turn-boundary",
  guards:
    "SDK 가 알림으로 새 턴을 열면 그 텍스트가 사용자 답변에 섞이고 진짜 답변을 덮던 것",
  run: async (): Promise<Assertion[]> => {

    // ★행동 게이트 (2026-08-09 2차 사고). 종전엔 첫 result 를 **무조건** 이 턴의 끝으로 봤고,
    //  알림이 연 합성 턴의 result 가 먼저 오자 그 뒤 24초간 스트리밍된 진짜 답변 49조각을
    //  통째로 버렸다(화면엔 빈 말풍선, turn_done 은 ok:true). 두 사고를 구분하는 판정을
    //  **실행해서** 확인한다 — 소스에 문자열이 있는지 보는 것과 다르다.
    const latchAfterAnswer = isOwnTurnEnd({ chunks: 3, deltas: 120 });   // 08-06 사고
    const latchOnEmpty = isOwnTurnEnd({ chunks: 0, deltas: 0 });         // 08-09 사고
    const latchDeltasOnly = isOwnTurnEnd({ chunks: 0, deltas: 49 });     // 실측 조각 수
    // ★판정이 맞아도 **호출부가 안 쓰면** 무의미하다(변이로 확인 — 판정을 `true` 로 굳혀도
    //  행동 단언 셋은 전부 통과했다). 실제 인자까지 묶어서 본다.
    const wired = await sourceHas(ADAPTER, [
      /const hasOwnAnswer = isOwnTurnEnd\(\{[\s\S]{0,140}chunks: assistantTextChunks\.length/,
      // ★`diagStreamCount`(진단용, 모든 stream_event)가 아니라 **우리 답변의 텍스트 델타**를
      //  세야 한다. 백그라운드 Task 가 도는 중이면 우리가 한 글자도 안 냈는데 참이 돼
      //  고치려던 조건 그대로 경계를 잡았다(적대 검토 C).
      /const hasOwnAnswer = isOwnTurnEnd\(\{[\s\S]{0,160}deltas: ownTextDeltas/,
      // 집행 — 판정이 거짓이면 **경계를 안 잡고 계속 수집**해야 한다. `continue` 가 사라지면
      // 08-06 사고(알림 턴 텍스트 혼입)가 전면 복귀한다(적대 검토 M3).
      /if \(turnResultSeen\) \{[\s\S]{0,600}\n\s{6}continue;\n\s{4}\}/,
      // ★`steering.close()` 는 **첫 result 에 그대로**(데드락 수정 유지) — 조건 안으로 들어가면
      //  내용 없는 턴에서 stdin 이 안 닫힌다(적대 검토 M4b).
      /input\.steering\?\.close\(\);[\s\S]{0,1200}const hasOwnAnswer = isOwnTurnEnd/,
      // 마감이 **빈 result 에도 조각으로 폴백**한다(적대 검토 A — `??` 는 ""에 폴백 안 한다).
      /resultText !== undefined && resultText !== "" \? resultText : chunkText/,
    ]);
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
        "★답변이 이미 있으면 첫 result 로 경계를 잡는다(알림 텍스트 혼입 차단 — 08-06 사고)",
        latchAfterAnswer === true,
        `chunks=3 deltas=120 → ${String(latchAfterAnswer)}`,
      ),
      assert(
        "★답변이 **비어 있으면** 경계를 잡지 않는다(알림이 연 합성 턴 — 08-09 사고)",
        latchOnEmpty === false,
        `chunks=0 deltas=0 → ${String(latchOnEmpty)}`,
      ),
      assert(
        "★스트리밍 조각만 있어도 우리 답변이다(실측 49조각을 버리던 자리)",
        latchDeltasOnly === true,
        `deltas=49 → ${String(latchDeltasOnly)}`,
      ),
      assert(
        "★[배선] 어댑터가 그 판정을 **실제 인자로** 쓴다(판정만 맞고 호출부가 굳으면 무의미)",
        wired.ok,
        wired.ok ? "isOwnTurnEnd(chunks,deltas) → turnResultSeen" : `★누락: ${wired.missing.join(" · ")}`,
      ),

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
