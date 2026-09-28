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
import { framesClaimSteer, isOwnTurnEnd, joinAnswers, keepAnswerOnThrow, settleAnswer, STEER_TURN_FAILED_NOTE } from "../../core/llm-runtime/adapters/claude-agent-sdk.js";

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
      /if \(turnResultSeen\) \{[\s\S]{0,2200}\n\s{6}continue;\n\s{4}\}/,
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
    // ★줄 선 입력이 연 턴은 **이어 붙인다** (2026-09-28 실사고 — 두 번째 메시지의 답이 버려짐).
    //  판정은 SDK 의 `user_message_uuids` 로 한다(우리 추정 아님 — 첫 판의 추정은 적대 검토가 둘 다 뚫었다).
    const ours = new Set(["u-ours"]);
    const claimAssistant = framesClaimSteer({ type: "assistant", user_message_uuids: ["u-other", "u-ours"] }, ours);
    const claimSingle = framesClaimSteer({ type: "result", user_message_uuid: "u-ours" }, ours);
    const claimNotice = framesClaimSteer({ type: "assistant", user_message_uuids: ["u-notice"] }, ours); // 알림 턴
    const claimInit = framesClaimSteer({ type: "system", subtype: "init" }, ours); // 식별자 없는 프레임
    const claimNoSteer = framesClaimSteer({ type: "assistant", user_message_uuids: ["u-ours"] }, new Set());
    const joined = joinAnswers(["  앞 답\n\n", undefined, "", "\n\n뒤 답  "]);
    const queuedWired = await sourceHas(ADAPTER, [
      // steer 마다 **우리 uuid** 를 달아 보낸다 — 이게 없으면 SDK 가 돌려줄 게 없다.
      /steerUuids\.add\(uuid\);\s*\n\s*yield \{ \.\.\.toUserMessage\(content\), uuid \};/,
      // 가드 **앞에서**, 그 프레임이 우리 입력을 소비했을 때만 이어 받는다.
      /if \(turnResultSeen && framesClaimSteer\(msg, steerUuids\)\) \{[\s\S]{0,700}turnResultSeen = false;[\s\S]{0,600}\n\s{4}\}\n\s{4}if \(turnResultSeen\) \{/,
      // 이어 받은 턴의 «내용 있음» 은 **그 턴의 조각만** 센다(08-09 빈 result 보호가 두 번째 턴에도).
      /chunks: assistantTextChunks\.length - chunkBase,\s*\n\s*deltas: ownTextDeltas - deltaBase,/,
      // 이어 받던 턴의 에러 result 가 **앞 답까지** 버리지 않는다(07-28 규칙).
      /if \(msg\.is_error === true\) \{[\s\S]{0,300}if \(settledAnswer !== undefined\) \{[\s\S]{0,400}continue;\s*\n\s*\}\s*\n\s*throw new Error/,
      // 마감은 앞 답 + 이 턴(실패면 안내).
      /: settleAnswer\(settledAnswer, currentText, steerTurnFailed\);/,
      // ★던진 실패(에러 result 뒤 CLI 종료 코드 1 → SDK throw)도 확정된 답을 버리지 않는다 — **resume 재시도보다 앞**에서.
      /keepAnswerOnThrow\(\{\s*settled: settledAnswer !== undefined,\s*firstTurnDone: turnResultSeen && succeeded,\s*cancelled,\s*\}\)[\s\S]{0,600}break;\s*\}\s*\}\s*if \(\s*!resumeRetried &&/,
      // 가운데 턴이 실패하면 그 턴 조각을 버리고 다음 이어 받기에서 그 자리에 안내.
      /steerTurnFailed = true;\s*\n\s*turnResultSeen = true;\s*\n\s*chunkBase = assistantTextChunks\.length;/,
      /settledAnswer = settleAnswer\([\s\S]{0,200}steerTurnFailed,[\s\S]{0,120}\);\s*\n\s*steerTurnFailed = false;/,
      // 결과 뒤 command_lifecycle 은 턴이 아니다(경고가 틀린 원인을 찍지 않게).
      /if \(turnResultSeen\) \{\s*if \(\(msg as \{ type: string \}\)\.type === "command_lifecycle"\) continue;\s*postResultMsgs \+= 1;/,
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
        "★SDK 가 우리 uuid 를 돌려준 턴만 이어 받는다 — 알림 턴·식별자 없는 프레임·steer 없는 턴은 버린다",
        claimAssistant && claimSingle && !claimNotice && !claimInit && !claimNoSteer,
        `복수=${claimAssistant} 단수=${claimSingle} 알림=${claimNotice} init=${claimInit} steer없음=${claimNoSteer}`,
      ),
      assert(
        "★확정된 답은 뒤따르는 실패로 안 버린다 — 첫 턴 완료·이어 받은 답이 있으면 유지, **취소**만 전파, 답 없으면 전파",
        keepAnswerOnThrow({ settled: true, firstTurnDone: false, cancelled: false }) &&
          keepAnswerOnThrow({ settled: false, firstTurnDone: true, cancelled: false }) &&
          !keepAnswerOnThrow({ settled: true, firstTurnDone: true, cancelled: true }) &&
          !keepAnswerOnThrow({ settled: false, firstTurnDone: false, cancelled: false }),
        JSON.stringify([
          keepAnswerOnThrow({ settled: true, firstTurnDone: false, cancelled: false }),
          keepAnswerOnThrow({ settled: false, firstTurnDone: true, cancelled: false }),
          keepAnswerOnThrow({ settled: true, firstTurnDone: true, cancelled: true }),
          keepAnswerOnThrow({ settled: false, firstTurnDone: false, cancelled: false }),
        ]),
      ),
      assert(
        "가운데 턴이 실패하면 그 자리엔 안내가, 성공하면 답이 — 실패 턴의 조각은 싣지 않는다",
        settleAnswer("A1", "API Error: 529 overloaded", true) === `A1\n\n${STEER_TURN_FAILED_NOTE}` &&
          settleAnswer(settleAnswer("A1", "", true), "A3", false) === `A1\n\n${STEER_TURN_FAILED_NOTE}\n\nA3` &&
          settleAnswer(undefined, "A1", false) === "A1",
        JSON.stringify(settleAnswer("A1", "API Error: 529", true)),
      ),
      assert(
        "두 답은 빈 조각 없이 문단 하나로 잇는다(실패 안내 문구도 비어 있지 않다)",
        joined === "앞 답\n\n뒤 답" && STEER_TURN_FAILED_NOTE.length > 10,
        JSON.stringify(joined),
      ),
      assert(
        "★[배선] uuid 부착 → 가드 앞 이어 받기 → 그 턴 조각만 판정 → 에러가 앞 답을 안 버림 → 마감 결합",
        queuedWired.ok,
        queuedWired.ok ? "배선 5곳" : `★누락: ${queuedWired.missing.join(" · ")}`,
      ),
      assert("중간 빈 결과는 앞서 받은 텍스트가 있어도 종료하지 않음", !isOwnTurnEnd({ chunks: 3, deltas: 120, emptyQueuedResult: true }), {}),
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
