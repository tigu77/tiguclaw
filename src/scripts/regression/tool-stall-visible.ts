/**
 * 회귀: **도구가 멈추면 사용자가 안다** (2026-08-06 사용자 신고 + 회사 PC 로그).
 *
 * 사고: 도구 호출이 응답 없이 멈췄는데 **사용자에게 아무 신호도 안 갔다.** 화면엔
 * "작업 중 · 39분" 만 돌았고, 느린 건지 멈춘 건지 구분할 수단이 없었다. 실측
 * (2026-08-05 회사 PC): `add_schedule`·`list_schedules`·`Task` 4건이 경고 뒤 완료 기록
 * 없이 멈췄고 마지막 건은 로그 끝까지 조용했다.
 *
 * ★두 겹으로 조용했다:
 *  ①`llm.tool_slow` 이벤트를 **대시보드가 안 그렸다**(핸들러 부재 — 경고가 로그에만).
 *  ②채널 푸시는 **워커 전용**이었다(`worker:` 접두가 아니면 즉시 return). 대화 중
 *    메인 턴이 멈추면 텔레그램 사용자는 영영 모른다.
 *
 * ★이 부류는 재발이다 — `llm.compaction_stuck` 도 "발행했는데 소비처가 없어" 로그에만
 *  남았다. 그래서 신호는 **발행이 아니라 도달**을 검사한다.
 *
 * 배선을 본다(실제 채널 전송·브라우저 렌더는 여기서 못 돌린다). 배포본엔 `.ts`·대시보드
 * 파일이 다 있으므로 읽기 실패 시에만 통과(오탐 0).
 */
import { sourceHas } from "./_wiring.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "tool-stall-visible",
  guards: "도구가 멈춰도 사용자에게 아무 신호가 안 가 39분간 '작업 중'만 돌던 것(대시보드 미렌더 + 채널 푸시 워커 전용)",
  run: async (): Promise<Assertion[]> => {
    const dash = await sourceHas("../../../packages/dashboard/js/sse.js", [
      // 대시보드가 지연 이벤트를 **그린다**(종전엔 핸들러 자체가 없었다).
      /ev\.type === "llm\.tool_slow"/,
      /renderLocalChat\(/,
      // 자기 세션에만 — 남의 세션 지연이 내 대화에 끼어들면 오독.
      /isActiveThread\(p\.threadKey\)/,
    ]);
    const notify = await sourceHas("../../core/worker-jobs.ts", [
      // ★메인 턴 분기 — `worker:` 가 아니어도 처리한다(종전엔 즉시 return).
      /if \(!tk\.startsWith\("worker:"\)\) \{/,
      /mainTurnSlowNotified/,
      // 화면을 안 보는 채널만 민다(대시보드는 SSE 로 보므로 중복 푸시 금지).
      /extractTelegramChatId\(tk\)/,
      // 턴이 끝나면 1회 마커 해제 — 안 그러면 그 세션은 **영영 한 번만** 알린다.
      /mainTurnSlowNotified\.delete\(doneTk\)/,
    ]);
    const hardCut = await sourceHas("../../core/llm-runtime/tool-watchdog.ts", [
      // 경고만으로는 안 끊긴다 — 하드 상한이 실제 중단 레버를 부른다.
      /onHard\?\.\(input\.tool, hardMs\)/,
      /tool-hang/,
    ]);
    const claudeLever = await sourceHas(
      "../../core/llm-runtime/adapters/claude-agent-sdk.ts",
      [
        // claude 는 MCP 를 SDK 에 직접 넘겨 브리지 11분 상한 밖이다 — 레버가 여기 없으면
        // 이 어댑터만 그물이 없다(원칙 #2: 어댑터별로 안전망이 다르면 안 된다).
        /onHard: \(tool, ms\) =>/,
        /effectiveAc\.abort\(/,
      ],
    );

    return [
      assert(
        "★대시보드가 도구 지연을 화면에 띄운다(로그에만 있으면 없는 것과 같다)",
        dash.ok,
        dash.ok ? "sse.js" : `누락: ${dash.missing.join(" / ")}`,
      ),
      assert(
        "★메인 턴 지연도 채널로 알린다(종전엔 워커 전용이라 대화 중 멈춤은 무통지)",
        notify.ok,
        notify.ok ? "worker-jobs.ts" : `누락: ${notify.missing.join(" / ")}`,
      ),
      assert(
        "하드 상한이 실제 중단 레버를 호출한다(경고만으로는 먹통이 안 풀린다)",
        hardCut.ok,
        hardCut.ok ? "tool-watchdog.ts" : `누락: ${hardCut.missing.join(" / ")}`,
      ),
      assert(
        "★claude 어댑터가 중단 레버를 넘긴다(브리지 상한 밖이라 여기만 그물이 없었다)",
        claudeLever.ok,
        claudeLever.ok ? "claude-agent-sdk.ts" : `누락: ${claudeLever.missing.join(" / ")}`,
      ),
    ];
  },
};
