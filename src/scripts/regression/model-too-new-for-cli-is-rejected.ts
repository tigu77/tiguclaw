/**
 * 회귀: **번들 CLI 보다 새 모델은 «모델 거부» 로 분류된다** (2026-09-23).
 *
 * ★사고: 설정한 claude 모델이 번들 Claude Code 보다 새로우면 API 가 400 으로 거절한다
 *  (*"Claude Code 2.1.278 does not support this model; version 2.1.280 or newer is
 *  required."*). 이 문구엔 404 도 `model:` 도 없어 `isModelRejected` 가 false 였고,
 *  errorKind 가 `error` 라 **다음 풀로 폴백하지 않고** 턴이 실패로 끝났다. 최신 opus 를
 *  자동으로 고르는 경로가 있어 새 모델이 나올 때마다 반복된다(이틀에 fable-5-1·opus-5-5).
 *  릴리스 레드팀(v0.58.0)이 실측 문구로 재현했다.
 *
 * 지키는 것 둘 — ★**쌍으로**(넓힘 변이가 초록으로 지나가지 않게):
 *  ① 실측 문구(어댑터가 던지는 합본 그대로)가 모델 거부로 잡힌다.
 *  ② 모델을 못 쓰는 게 아니라 **요청의 일부**를 못 받는 400 은 잡히지 않는다 —
 *     그걸 모델 거부로 세면 멀쩡한 모델에서 엉뚱하게 다음 풀로 넘어간다.
 *
 * 등급: 동작(분류기를 실제로 실행한다).
 */
import { isModelRejected } from "../../core/llm-runtime/index.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

// 실측 원문 — claude 어댑터가 is_error 를 throw 로 승격할 때의 접두까지 그대로.
const CLI_TOO_OLD =
  "claude-agent-sdk error: API Error: 400 Claude Code 2.1.278 does not support this model; " +
  "version 2.1.280 or newer is required. Run 'claude update', or update the Claude desktop " +
  "app, then try again.";

// 같은 400·같은 «does not support» 인데 모델은 멀쩡한 경우.
const FEATURE_UNSUPPORTED =
  'claude-agent-sdk error: API Error: 400 {"type":"error","error":{"type":' +
  '"invalid_request_error","message":"This model does not support tool_choice"}}';

export const check: RegressionCheck = {
  name: "model-too-new-for-cli-is-rejected",
  guards:
    "번들 Claude Code 보다 새 모델의 400 거절이 모델 거부로 분류되지 않아 폴백 없이 턴이 실패하던 것(새 모델마다 반복)",
  run: async (): Promise<Assertion[]> => [
    assert(
      "① 번들 CLI 가 낡아 나는 400 은 모델 거부다(→ 다음 풀로 폴백할 수 있다)",
      isModelRejected(CLI_TOO_OLD),
      isModelRejected(CLI_TOO_OLD) ? "model_rejected" : "★error 로 분류 — 폴백 불가",
    ),
    assert(
      "② 기능 하나를 못 받는 400 은 모델 거부가 아니다(멀쩡한 모델에서 풀을 넘기지 않는다)",
      !isModelRejected(FEATURE_UNSUPPORTED),
      isModelRejected(FEATURE_UNSUPPORTED) ? "★모델 거부로 오분류" : "error 로 남음",
    ),
  ],
};
