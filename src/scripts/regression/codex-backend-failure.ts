/**
 * 회귀: **백엔드가 보고한 실패를 먹지 않는다** (2026-07-30).
 *
 * 사고: 회사 인스턴스가 "중간에 완료도 안 됐는데 멈춘다"를 반복. 심어둔 이벤트 히스토그램이
 * 원인을 확정했다 — 실패한 스트림 전부가 동일했다:
 *   `events=[response.created×1, response.in_progress×1, error×1, response.failed×1]`
 *
 * 즉 백엔드는 **HTTP 200 으로 스트림을 열어놓고 그 안에서 실패를 명시 통보**하고 있었다.
 * 그런데 우리 쪽엔 그 실패를 인지할 자리가 세 계층 모두 없었다:
 *   ①타입(`CodexSseEvent`)에 error/failed/incomplete 필드 없음
 *   ②파서에 분기 없음 — JSON 파싱은 되므로 catch 에도 안 걸리고 조용히 지나감(무관심)
 *   ③소비부는 `res.ok` 통과 = 성공으로 확정하고 `break // 스트림 소비 성공`
 * 결과: 사유를 버리고 빈 텍스트만 보고 "모델이 침묵" 으로 오진 → nudge 3회(17.8초) →
 * "최종 응답 텍스트 비어있음 (부작용 도구 미실행)" 이라는 **틀린 진단**을 사용자에게.
 *
 * 형상은 공식 SDK(`node_modules/openai/resources/responses/responses.d.ts`)에서 확인했다:
 *   error            → { type, code, message, param, sequence_number }   (최상위)
 *   response.failed  → { type, response: { error: { code, message } } }
 *   response.incomplete → { type, response: { incomplete_details: { reason } } }
 */
import { sourceHas } from "./_wiring.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "codex-backend-failure",
  guards:
    "백엔드가 200 스트림 안에서 보고한 실패(error/response.failed)를 파서가 버려 '모델이 빈 응답' 으로 오진하던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];

    // ①+② 파서 — 공식 3종 터미널 이벤트를 **전부** 읽고 사유를 보존한다.
    const parser = await sourceHas(
      "../../core/llm-runtime/adapters/openai-codex-oauth-history.ts",
      [
        /event\.type === "error"/,
        /event\.type === "response\.failed"/,
        /event\.type === "response\.incomplete"/,
        // 사유 필드를 실제로 꺼낸다(분기만 만들고 버리는 것 방지).
        /source: "error"/,
        /event\.response\?\.error/,
        /incomplete_details\?\.reason/,
        // 첫 실패 보존 — 뒤 이벤트가 사유를 덮어쓰지 않게.
        /if \(failure === undefined\) \{/,
      ],
    );
    out.push(
      assert(
        "★파서가 error·response.failed·response.incomplete 를 읽고 사유를 보존한다",
        parser.ok,
        parser.ok ? "7개 확인" : `누락 ${parser.missing.join(" ")}`,
      ),
    );

    // ③ 소비부 — 사유가 있으면 로그로 남기고, 안전할 때만 진짜 사유로 throw.
    const consumer = await sourceHas(
      "../../core/llm-runtime/adapters/openai-codex-oauth.ts",
      [
        /\[codex-backend-failure\]/,
        /sseResult\.failure !== undefined/,
        /codex 백엔드가 요청 실행 실패를 보고했습니다|codex 백엔드가 요청 실패를 보고했습니다/,
      ],
    );
    out.push(
      assert(
        "★소비부가 사유를 로그·에러로 올린다(빈 응답 경로로 안 흘린다)",
        consumer.ok,
        consumer.ok ? "3개 확인" : `누락 ${consumer.missing.join(" ")}`,
      ),
    );

    // ★부작용 가드 — 도구가 이미 돌았으면 throw 금지. throw 하면 폴백 모델이 턴을
    //  처음부터 재실행해 memory/todo/schedule 이 **중복 실행**된다(기존 sideEffectExecuted
    //  가드와 같은 이유). 사유를 얻었다고 이 가드를 깨면 새 사고가 난다.
    const guard = await sourceHas(
      "../../core/llm-runtime/adapters/openai-codex-oauth.ts",
      [/sseResult\.toolCalls\.length === 0 &&\s*\n\s*!sideEffectExecuted/],
    );
    out.push(
      assert(
        "★부작용 도구가 돌았으면 throw 하지 않는다(폴백 재실행 중복 방지)",
        guard.ok,
        guard.ok ? "가드 확인" : "부작용 가드 없음 — 폴백이 도구를 중복 실행한다",
      ),
    );
    return out;
  },
};
