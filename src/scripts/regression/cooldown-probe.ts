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
  parseModelSpec,
} from "../../core/llm-runtime/index.js";
import { saveCooldown, markCooldownProbe } from "../../store/cooldowns.js";
import { getDb } from "../../store/sessions.js";
import { assert, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";

const PROBE_MS = 2 * 60 * 60_000; // 기본 탐침 간격(구현 기본값과 동일 가정 — 어긋나면 아래가 잡는다).

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
    return out;
  },
};
