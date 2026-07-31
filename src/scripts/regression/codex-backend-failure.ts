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
        // ★`terminal` 판정을 통째로 겨냥한다. 세 줄을 따로 보면 **같은 파일의 lastEvent
        //  블록**이 대신 매칭돼(각 2회 등장), `const terminal = false` 로 사유를 통째로
        //  버려도 초록이었다 — 이 검사가 존재하는 이유 자체가 무력화됐다(검토 변이 확인).
        /const terminal =\s*event\.type === "error" \|\|\s*event\.type === "response\.failed" \|\|\s*event\.type === "response\.incomplete";/,
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
        parser.ok ? "6개 확인" : `누락 ${parser.missing.join(" ")}`,
      ),
    );

    // ③ 소비부 — 사유가 있으면 로그로 남기고, 안전할 때만 진짜 사유로 throw.
    const consumer = await sourceHas(
      "../../core/llm-runtime/adapters/openai-codex-oauth.ts",
      [
        /\[codex-backend-failure\]/,
        // ★모델명 — 2026-07-30 실사고: 특정 모델(gpt-5.6-sol) 하나만 막혔는데 로그에
        //  모델이 없어 "서브에이전트는 다른 모델일 것" 이라는 **추정**으로 반나절을 갔다.
        //  같은 초에 agent 스레드 234K 성공 / 메인 96K 실패가 찍혔는데도 못 갈랐다.
        /`model=\$\{model\} sideEffect=/,
        /sseResult\.failure !== undefined/,
        // (why=로그용 · userWhy=사용자용 · retryable=결정적 실패 구분 — 2026-07-31 분리)
        /throw new CodexBackendFailureError\(\s*why,/,
        // ★같은 body 재전송 — 백엔드 보고 실패는 HTTP 5xx 와 같은 부류다. 종전엔 모델
        //  nudge 경로로 흘러 17.8초를 태우고 턴이 죽었다(사용자: "중간에 멈춤").
        // 모델명을 못박는다 — 재시도 줄만 보고도 "어느 모델이 몇 번째냐" 가 갈려야 한다.
        /\[codex-backend-retry\] \$\{model\} /,
        /backendFailAttempt < CODEX_BACKEND_FAIL_BACKOFF_MS\.length/,
        /continue; \/\/ 같은 body 로 재전송\./,
      ],
    );
    out.push(
      assert(
        "★소비부가 사유를 로그·에러로 올린다(빈 응답 경로로 안 흘린다)",
        consumer.ok,
        consumer.ok ? "6개 확인" : `누락 ${consumer.missing.join(" ")}`,
      ),
    );

    // ★부작용 가드 — 내가 "바깥 catch 가 이미 판단한다"고 단언했는데 **틀렸다**(2026-07-30).
    //  그 분기는 IdleTimeoutError 에만 걸려 있어서, 백엔드 실패는 sideEffect=true 여도
    //  throw 되어 폴백 모델이 턴을 재실행 → memory/todo/schedule 중복 적용 위험이었다.
    //  실측에선 체인에 codex 하나뿐이라 드러나지 않았다(운이 좋았을 뿐).
    const guard = await sourceHas(
      "../../core/llm-runtime/adapters/openai-codex-oauth.ts",
      [
        // ★진입 조건이 **부작용 유무**여야 한다 — 에러 이름 열거가 아니라.
        //  두 번 같은 방식으로 틀렸다: IdleTimeoutError 만 → 07-30 에 손으로 하나 추가 →
        //  형제인 HTTP-status 실패(502·body null·전송 소진, 전부 plain Error)는 여전히
        //  비껴갔다(2026-07-31 검토 확인). 이름을 늘리지 말고 조건을 뒤집는다.
        /if \(sideEffectExecuted\) \{/,
      ],
    );
    out.push(
      assert(
        "★부작용이 났으면 **에러 종류 무관** throw 하지 않는다(폴백 재실행 중복 방지)",
        guard.ok,
        guard.ok
          ? "부작용 유무로 진입 판정"
          : "에러 이름 열거로 되돌아갔다 — 목록에 없는 실패가 폴백을 타 도구를 중복 실행한다",
      ),
    );

    // ★과부하 백오프 — [500,1500] 은 실측에서 5초 만에 포기했다(17:59:08→13). 백엔드가
    //  "try again later" 라고 말하는데 2초 기다리고 포기하면 재전송의 의미가 없다.
    const backoff = await sourceHas(
      "../../core/llm-runtime/adapters/openai-codex-oauth.ts",
      [/CODEX_BACKEND_FAIL_BACKOFF_MS = \[1_000, 3_000, 8_000, 15_000\]/],
    );
    out.push(
      assert(
        "★백엔드 실패 백오프는 과부하를 견딜 만큼 길다(총 27초)",
        backoff.ok,
        backoff.ok ? "1s+3s+8s+15s" : "전송 재시도용 짧은 백오프를 그대로 쓰고 있다",
      ),
    );
    // ★"다른 모델로 이어서 시도합니다" 는 후보가 있을 때만 — 단일 모델 세션(의도적 설정)에서
    //  무조건 붙으면 **항상 거짓말**이고 사용자는 오지 않을 답을 기다린다(실측 27분 과부하,
    //  7회 전부 후보 0). 코어가 hasFallback 을 싣고 UI 가 분기해야 성립한다 — 양쪽 다 본다.
    const honest = await sourceHas("../../core/llm-runtime/index.ts", [
      /hasFallback,/,
      /specIndex < effectivePool\.length - 1 && !\(e instanceof TurnTimeoutError\)/,
    ]);
    out.push(
      assert(
        "★코어가 '다음 후보 있음' 을 실어 보낸다",
        honest.ok,
        honest.ok ? "2개 확인" : `누락 ${honest.missing.join(" ")}`,
      ),
    );
    const ui = await sourceHas("../../../packages/dashboard/js/sse.js", [
      /p\.hasFallback/,
      /재시도할 다른 모델이 없습니다/,
    ]);
    out.push(
      assert(
        "★UI 가 후보 없을 때 다른 문구를 낸다(거짓 안내 0)",
        ui.ok,
        ui.ok ? "분기 확인" : `누락 ${ui.missing.join(" ")}`,
      ),
    );
    // ★"인풋이 커서 실패하나" 에 답하려면 요청 **크기 분해**가 있어야 한다. 종전 로그의
    //  inputChars 는 사용자 발화 길이(예: 5자)라 아무 답도 못 줬다. 실패 때만 재면 비교
    //  대상이 없으므로 **정상 턴에도** 남긴다(instructions/input/tools 를 따로 — 누적
    //  컨텍스트 문제인지 고정 스캐폴딩 문제인지 갈라야 한다).
    const size = await sourceHas(
      "../../core/llm-runtime/adapters/openai-codex-oauth.ts",
      [
        /lastReqBytes = \{\s*\n\s*total: bodyJson\.length,/,
        /instructions: String\(body\.instructions \?\? ""\)\.length/,
        /req=\$\{lastReqBytes\.total\.toLocaleString\(\)\}자/,
        /req=\$\{lastReqBytes\.total\.toLocaleString\(\)\}\(i/,
      ],
    );
    out.push(
      assert(
        "★요청 크기를 instructions/input/tools 로 갈라 실패·정상 양쪽에 남긴다",
        size.ok,
        size.ok ? "4개 확인" : `누락 ${size.missing.join(" ")}`,
      ),
    );
    return out;
  },
};
