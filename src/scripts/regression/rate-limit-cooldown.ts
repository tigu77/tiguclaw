/**
 * 회귀: **백엔드 한도 초과를 쿨다운으로 인식한다** (2026-07-30 라이브).
 *
 * 사고(윈도우 인스턴스 새벽): claude 가 `You've hit your limit · resets 2:20am (Asia/Seoul)`
 * 로 한도를 알렸는데 판정 정규식(`usage_limit_reached|rate-limit|429|quota|too many requests`)에
 * **어느 것도 안 걸려** 쿨다운이 등록되지 않았다. 그래서 죽은 백엔드를 00:39·00:40·00:43
 * 매 턴 다시 때렸고, 같은 시간 codex 도 흔들려 "모든 어댑터 실패"가 반복 = 사용자에겐 먹통.
 *
 * 게다가 해제 시각이 **초가 아니라 벽시계**(`2:20am`)라 기존 파서도 못 읽었다 → 값이 있는데
 * 기본값(10분)으로 강등.
 */
import { isRateLimited, parseCooldownMs } from "../../core/llm-runtime/index.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const CLAUDE = "claude-agent-sdk error: You've hit your limit · resets 2:20am (Asia/Seoul)";

export const check: RegressionCheck = {
  name: "rate-limit-cooldown",
  guards: "claude 한도 초과가 쿨다운으로 안 잡혀 죽은 백엔드를 매 턴 다시 때리던 것",
  run: async (): Promise<Assertion[]> => {
    const ms = parseCooldownMs(CLAUDE);
    return [
      assert("★claude 한도 문구를 rate-limit 으로 인식", isRateLimited(CLAUDE), "hit your limit"),
      assert(
        "기존 패턴도 계속 인식(회귀 0)",
        isRateLimited('{"resets_in_seconds":492480,"type":"usage_limit_reached"}') &&
          isRateLimited("HTTP 429 Too Many Requests"),
        "codex·429",
      ),
      assert(
        "★벽시계 해제 시각을 ms 로 환산한다(초 단위가 아니어도)",
        ms !== null && ms > 0 && ms <= 24 * 60 * 60 * 1000,
        `${ms === null ? "null" : Math.round(ms / 60000) + "분"}`,
      ),
      assert(
        "초 단위 값이 있으면 그걸 그대로 존중(다일 한도 보존)",
        parseCooldownMs('{"resets_in_seconds":492480}') === 492480 * 1000,
        String(parseCooldownMs('{"resets_in_seconds":492480}')),
      ),
      assert(
        "한도와 무관한 오류는 쿨다운 아님(오탐 0)",
        !isRateLimited("Operation aborted") && !isRateLimited("ETIMEDOUT"),
        "오탐 방지",
      ),
      assert(
        "시각 정보가 없으면 null(호출자가 기본값으로 강등)",
        parseCooldownMs("some unrelated failure") === null,
        "null",
      ),
    ];
  },
};
