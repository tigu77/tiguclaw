/**
 * 회귀: **다음 메시지 제안 호출의 모양** — 프로파일이 실제로 쓰이고, 데드라인이 폴백을
 * 단락한다 (2026-08-24).
 *
 * 두 결함을 동시에 막는다. 둘 다 **조용했다** — 답변 경로엔 아무 해가 없어서 아무도
 * 신고하지 않았고, 로그를 뒤져야 보였다.
 *
 * ① **`profile` 이 배선돼 있지 않았다.** `SuggestionSettings.profile` 이 있고 주석이
 *    *"작고 빠른 것을 권장"* 이라 적혀 있었는데, 파서만 읽고 **소비처가 0**이었다
 *    (`readSuggestionSettings()` 의 두 호출부가 전부 `.enabled` 만 봤다). 사용자가
 *    `"profile": "low"` 를 적으면 아무 일도 안 일어났다 — 제안은 늘 기본 프로파일
 *    (=비서 본체와 같은 무거운 풀)로 돌았다. [[feedback_hand_maintained_lists]] 와 같은
 *    부류다: **있는데 안 도는 것.**
 *
 * ② **시간 상한이 없었다.** 실측(2026-08-24 회사 인스턴스): 529 과부하에서
 *    claude-opus-5 가 SDK 내부 재시도로 **199,146ms · 200,599ms · 194,271ms** 를 쓰고
 *    턴마다 반복했다. 정상일 땐 이 기능 자신의 실측이 **중앙 3.9초 · 최대 11.9초**다.
 *
 * ★등급: **행동 게이트**. 판정을 `next-message-suggestion.ts` 의 순수 함수로 뽑아
 *  실행한다 — 종전엔 이 결정이 `index.ts` 핸들러 안에 있어서 동작을 보려면 데몬을 띄워야
 *  했고, 그래서 그물이 소스 grep 밖에 못 됐다(그 사이 ①이 살아 있었다). Q7 그대로다:
 *  **검사가 껄끄러우면 코드가 잘못 놓인 것.**
 */
import {
  SUGGESTION_DEADLINE_MS,
  resolveSuggestionChain,
  suggestionDeadlineReason,
} from "../../core/next-message-suggestion.js";
import { TurnTimeoutError } from "../../core/llm-runtime/turn-timeout.js";
import { isModelRejected } from "../../core/llm-runtime/index.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

/** 실측 최대(2026-08-18, ghost-suggest.js) — 데드라인은 이보다 넉넉히 커야 한다. */
const MEASURED_MAX_MS = 11_900;
/** 실측된 병리(2026-08-24) — 데드라인은 이보단 확실히 작아야 의미가 있다. */
const MEASURED_PATHOLOGICAL_MS = 194_271;

const run = async (): Promise<Assertion[]> => {
  const out: Assertion[] = [];

  // ── ① 프로파일 배선 ──────────────────────────────────────────────────────
  const POOL = [[{ adapter: "codex", model: "gpt-5.6-sol" }]];
  const resolve = (name: string): unknown[] => (name === "low" ? POOL : []);

  const unset = resolveSuggestionChain(undefined, resolve);
  out.push(
    assert(
      "프로파일 미지정 = 기본 프로파일(빈 체인) · 경고 없음",
      unset.chain.length === 0 && unset.missing === null,
      `chain=${unset.chain.length} missing=${String(unset.missing)}`,
    ),
  );

  const set = resolveSuggestionChain("low", resolve);
  out.push(
    assert(
      "★지정한 프로파일이 **실제로 쓰인다**(설정만 읽고 버리지 않는다)",
      set.chain.length === 1 && set.missing === null,
      set.chain.length === 1
        ? "지정 체인 사용"
        : "★체인이 안 잡혔다 — profile 이 다시 죽은 손잡이가 됐다",
    ),
  );

  const blank = resolveSuggestionChain("   ", resolve);
  out.push(
    assert(
      "공백뿐인 이름은 미지정과 같다(없는 프로파일이라고 떠들지 않는다)",
      blank.chain.length === 0 && blank.missing === null,
      `missing=${String(blank.missing)}`,
    ),
  );

  const bogus = resolveSuggestionChain("없는프로파일", resolve);
  out.push(
    assert(
      "★없는 이름은 기본으로 떨어지되 **조용히는 아니다**(호출자가 말할 근거를 준다)",
      bogus.chain.length === 0 && bogus.missing === "없는프로파일",
      `chain=${bogus.chain.length} missing=${String(bogus.missing)}`,
    ),
  );

  // ── ② 데드라인 ───────────────────────────────────────────────────────────
  out.push(
    assert(
      `데드라인이 실측 최대(${MEASURED_MAX_MS}ms)보다 넉넉하다 — 정상 동작을 안 자른다`,
      SUGGESTION_DEADLINE_MS > MEASURED_MAX_MS,
      `${SUGGESTION_DEADLINE_MS}ms`,
    ),
    assert(
      `데드라인이 실측 병리(${MEASURED_PATHOLOGICAL_MS}ms)보다 확실히 작다 — 그걸 자르는 게 목적이다`,
      SUGGESTION_DEADLINE_MS < MEASURED_PATHOLOGICAL_MS / 2,
      `${SUGGESTION_DEADLINE_MS}ms`,
    ),
  );

  const reason = suggestionDeadlineReason();
  out.push(
    assert(
      "★데드라인 abort 사유가 `TurnTimeoutError` 다 — 이 타입이라야 폴백이 단락된다",
      reason instanceof TurnTimeoutError,
      reason instanceof TurnTimeoutError
        ? reason.name
        : `★${reason.name} — 평범한 Error 면 abort 는 되지만 다음 모델로 또 200초를 쓴다`,
    ),
    // TT-I3 — 이 사유가 "모델 거부" 로 분류되면 멀쩡한 모델이 깨진 것으로 제거된다.
    assert(
      "데드라인 사유는 '모델 거부' 로 오분류되지 않는다 (TT-I3)",
      !isModelRejected(reason.message),
      reason.message,
    ),
  );

  return out;
};

export const check: RegressionCheck = {
  name: "suggestion-call-shape",
  guards:
    "제안 호출이 설정된 프로파일을 무시하고 기본(무거운) 풀로 돌던 것 + 시간 상한이 없어 529 과부하에 턴마다 200초를 쓰던 것",
  run,
};
export default check;
