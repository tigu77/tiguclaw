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
        // ★형상 비종속 추출 — 문서(SDK 타입)와 이 백엔드 실물이 다르다(1차 실측: 문서대로
        //  top-level code/message 를 읽었더니 빈 error 였다). 특정 경로를 더 추측하는 대신
        //  payload 안을 깊이 제한으로 훑는다. 내려갈 키를 손목록으로 정하지 않는다.
        /const digFailure = \(/,
        /if \(depth > 3 \|\| o === null \|\| typeof o !== "object"\) return;/,
        /k === "reason" && found\.code === undefined/,
        // 내용 있는 쪽으로 승격(사유 없는 error 가 먼저, 사유 있는 failed 가 뒤에 온다).
        /if \(!hasDetail\(failure\)\) \{/,
        // 문서와 실물이 다를 수 있으니 원문도 남긴다.
        /raw: redactSecrets\(data\)\.slice\(0, 400\)/,
      ],
    );
    out.push(
      assert(
        "★파서가 error·response.failed·response.incomplete 를 읽고 사유를 보존한다",
        parser.ok,
        parser.ok ? "8개 확인" : `누락 ${parser.missing.join(" ")}`,
      ),
    );

    // ③ 소비부 — 사유가 있으면 로그로 남기고, 안전할 때만 진짜 사유로 throw.
    const consumer = await sourceHas(
      "../../core/llm-runtime/adapters/openai-codex-oauth.ts",
      [
        /\[codex-backend-failure\]/,
        /sseResult\.failure !== undefined/,
        /throw new CodexBackendFailureError\(why\)/,
        // ★같은 body 재전송 — 백엔드 보고 실패는 HTTP 5xx 와 같은 부류다. 종전엔 모델
        //  nudge 경로로 흘러 17.8초를 태우고 턴이 죽었다(사용자: "중간에 멈춤").
        /\[codex-backend-retry\]/,
        /backendFailAttempt < CODEX_FETCH_MAX_RETRIES/,
        /continue; \/\/ 같은 body 로 재전송\./,
      ],
    );
    out.push(
      assert(
        "★소비부가 사유를 로그·에러로 올린다(빈 응답 경로로 안 흘린다)",
        consumer.ok,
        consumer.ok ? "5개 확인" : `누락 ${consumer.missing.join(" ")}`,
      ),
    );

    // ★부작용 판단은 **함수 바깥 catch(§4.4)에 위임**한다 — 안쪽에서 중복 구현하면
    //  (a) 기준이 두 곳으로 갈리고 (b) 실제로 `break` 가 `for(;;)` 스톨 루프만 빠져나가
    //  sseResult 미할당 지점으로 떨어졌다(tsc 가 잡음). 재시도 소진 시엔 그냥 throw 한다.
    const delegate = await sourceHas(
      "../../core/llm-runtime/adapters/openai-codex-oauth.ts",
      [/재시도 소진 → \*\*그냥 throw\*\*/],
    );
    out.push(
      assert(
        "★재시도 소진 시 부작용 판단을 바깥 catch 에 위임한다(중복 구현 금지)",
        delegate.ok,
        delegate.ok ? "위임 확인" : "안쪽에서 부작용 분기를 재구현하고 있다",
      ),
    );
    return out;
  },
};
