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
import { sourceHas } from "./_wiring.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

// ★해제 시각은 **지금 기준 40분 뒤**로 만든다 (2026-08-09). 종전엔 `2:20am` 고정이라
//  실제로 그 시각을 지난 새벽에 돌리면 파서가 null 을 내 **하루 23시간만 초록**인 검사였다
//  (이날 02:4x 에 걸렸다). 시각에 따라 색이 바뀌는 게이트는 신뢰를 갉아먹는다 —
//  같은 부류의 반대편이 상시 빨간 게이트다([[feedback_gate_must_actually_run]]).
const resetAt = new Date(Date.now() + 40 * 60 * 1000);
const h12 = resetAt.getHours() % 12 === 0 ? 12 : resetAt.getHours() % 12;
const CLAUDE =
  `claude-agent-sdk error: You've hit your limit · resets ${h12}:` +
  `${String(resetAt.getMinutes()).padStart(2, "0")}` +
  `${resetAt.getHours() < 12 ? "am" : "pm"} (Asia/Seoul)`;

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
        // 40분 뒤로 만들었으니 30~50분 사이여야 한다(고정 상한 24h 보다 촘촘하다).
        ms !== null && ms >= 30 * 60 * 1000 && ms <= 50 * 60 * 1000,
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
      assert(
        "★registerCooldownIfRateLimited 이 판정·파서를 실제로 쓴다(배선)",
        (
          await sourceHas("../../core/llm-runtime/index.ts", [
            /isRateLimited\(detail\)/,
            /parseCooldownMs\(detail\)/,
          ])
        ).ok,
        "llm-runtime/index.ts",
      ),
      assert(
        // ★사본이 3곳이었고 1곳만 고쳐서, 사용자 안내는 원문 덤프·매니저 통지는
        //  "잠시 후 다시" 를 냈다(실제론 수 시간 계정 한도). 같은 판정을 쓰는지 고정.
        "★사용자 안내·매니저 통지도 같은 판정을 쓴다(사본 금지)",
        (await sourceHas("../../index.ts", [/isRateLimited\(/])).ok &&
          (await sourceHas("../../core/worker-jobs.ts", [/isRateLimited\(/])).ok,
        "index.ts · worker-jobs.ts",
      ),
    ];
  },
};
