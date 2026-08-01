/**
 * 회귀: 쿨다운의 진실은 DB이고, 긴 쿨다운은 주기적으로 실제 시도한다 (2026-07-28).
 *
 * 사고 둘:
 *  ① 재인증했는데 며칠간 계속 폴백 — 쿨다운은 "호출 성공 시" 풀리는데 쿨다운 중엔 호출을
 *    안 하니 자기 잠금. 게다가 메모리 Map 만 봐서 **다른 프로세스가 지운 것**(재인증 CLI)이
 *    돌고 있는 데몬에 안 먹혔다. → DB 를 진실로.
 *  ② 백엔드가 알려준 해제 시각은 **힌트지 사실이 아니다** — codex 는 그 날짜보다 일찍
 *    풀리는 게 관측됐다(사용자 실측). 시계만 믿으면 이미 풀린 백엔드를 며칠 놀린다.
 *    → 긴 쿨다운은 일정 간격으로 한 번 통과시켜 실제로 시도한다(자기교정).
 */
import {
  cooldownRemainingMs,
  clearCooldowns,
  registerCooldownIfRateLimited,
  parseModelSpec,
  COOLDOWN_PROBE_INTERVAL_MS as PROBE_MS,
} from "../../core/llm-runtime/index.js";
import { saveCooldown, markCooldownProbe } from "../../store/cooldowns.js";
import { getDb } from "../../store/sessions.js";
import { assert, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";

// ★탐침 간격은 **구현에서 가져온다** — 사본을 두면 상수를 바꿀 때마다 어긋나고, 그
//  어긋남을 이 검사가 "회귀" 로 보고한다(2026-08-01 2h→4h 에서 실제로 그랬다).
//  검사가 지켜야 할 것은 "구현이 자기 간격을 지키는가" 지 "그 값이 2시간인가" 가 아니다.

export const check: RegressionCheck = {
  name: "cooldown-probe",
  guards: "재인증해도 안 풀리던 자기 잠금 + 백엔드 해제시각을 사실로 믿어 백엔드를 놀리던 것",
  run: async (): Promise<Assertion[]> => {
    assertIsolated(); // 라이브 DB 접촉 차단(러너 밖 실행 방지).
    const spec = parseModelSpec("codex:gpt-5.5");
    if (spec === null) return [assert("spec 파싱", false, "codex:gpt-5.5 파싱 실패")];
    const key = spec.provider ?? spec.adapter;
    const now = Date.now();
    clearCooldowns(key);

    const out: Assertion[] = [
      assert("쿨다운 없으면 0", cooldownRemainingMs(spec) === 0, cooldownRemainingMs(spec)),
    ];

    // ① 짧은 쿨다운(탐침 간격 미만) — 그대로 남아 있어야(불필요한 재시도 금지).
    saveCooldown(key, now + 10 * 60_000);
    markCooldownProbe(key, now); // 방금 탐침한 것으로 둔다.
    const shortRemain = cooldownRemainingMs(spec);
    out.push(assert("짧은 쿨다운은 유지(탐침 대상 아님)", shortRemain > 0, `${Math.round(shortRemain / 60000)}분`));

    // ② 긴 쿨다운 + 탐침한 지 오래됨 → 이번 한 번 통과(=실제로 시도).
    saveCooldown(key, now + 100 * 60 * 60_000); // 100시간
    markCooldownProbe(key, now - PROBE_MS - 60_000); // 마지막 탐침이 간격보다 오래전
    const probed = cooldownRemainingMs(spec);
    out.push(assert("긴 쿨다운은 주기적으로 한 번 통과(조기 회복 감지)", probed === 0, probed));

    // ③ 방금 탐침했으므로 곧바로 또 통과하면 안 된다(폭주 금지).
    const again = cooldownRemainingMs(spec);
    out.push(assert("탐침 직후엔 다시 통과하지 않음(폭주 방지)", again > 0, `${Math.round(again / 3600000)}시간`));

    // ④ ★DB 를 진실로 — 외부(다른 프로세스)가 행을 지우면 즉시 반영돼야 한다.
    getDb().prepare(`DELETE FROM cooldowns WHERE key = ?`).run(key);
    const afterExternalDelete = cooldownRemainingMs(spec);
    out.push(
      assert(
        "외부에서 지우면 즉시 해제(재인증 CLI 가 먹힌다)",
        afterExternalDelete === 0,
        afterExternalDelete,
      ),
    );

    clearCooldowns(key);
    // ★신규 진입과 재등록을 가른다 (2026-08-01) — 통지는 **상태가 바뀐 순간**에만.
    //  쿨다운 중에도 4시간마다 탐침이 돌고, 실패하면 429 로 재등록된다. 그걸 전부
    //  "진입" 으로 치면 4일 한도에 24통이 나간다(배경 소음 = 진짜 신호를 덮는다).
    clearCooldowns(key);
    const err = new Error('429 {"error":{"type":"usage_limit_reached"},"resets_in_seconds":360000}');
    const first = registerCooldownIfRateLimited(spec, err);
    out.push(
      assert(
        "★첫 한도는 '신규 진입' 으로 보고된다(통지 대상)",
        first !== null && first.untilTs > Date.now(),
        first === null ? "null — 통지가 안 나간다" : `해제 ${new Date(first.untilTs).toLocaleString("ko-KR")}`,
      ),
    );
    const reEntry = registerCooldownIfRateLimited(spec, err);
    out.push(
      assert(
        "★쿨다운 중 재등록(탐침 실패)은 진입으로 안 친다(4시간마다 같은 통지 0)",
        reEntry === null,
        reEntry === null ? "null — 조용함" : "★재통지됨 — 스팸",
      ),
    );
    // 대조군 — 쿨다운이 풀린 뒤 다시 걸리면 그건 진짜 신규 진입이다(통지 살아 있어야).
    clearCooldowns(key);
    const afterClear = registerCooldownIfRateLimited(spec, err);
    out.push(
      assert(
        "대조군 — 해제 후 다시 걸리면 신규 진입으로 통지한다(과잉 억제 0)",
        afterClear !== null,
        afterClear === null ? "★영영 조용 — 억제가 과했다" : "신규 진입 인식",
      ),
    );
    // 한도가 아닌 에러는 쿨다운 대상이 아니다(오발사 0).
    clearCooldowns(key);
    out.push(
      assert(
        "한도 아닌 에러는 쿨다운·통지 대상이 아니다",
        registerCooldownIfRateLimited(spec, new Error("보통 실패")) === null,
        "null",
      ),
    );

    return out;
  },
};
