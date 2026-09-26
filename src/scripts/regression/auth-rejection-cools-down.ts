/**
 * 회귀: **인증 거부(401)도 쿨다운에 들어간다** — 재로그인 전까지 매 턴 다시 두드리지 않게 (2026-09-26).
 *
 * ★사고(돌쇠 9/26 08:00~08:10): Codex 가 `401 invalid_api_key` 를 6턴 연속 냈다. 한도가 아니라 쿨다운에
 *  안 걸려 매 턴 Codex 부터 시도해 0.6~1.9초씩 버리고 Claude 로 폴백했고, 요약 호출 2회도 같은 벽에
 *  부딪혀 «크기 탓» 으로 다음 요약 예산까지 줄였다.
 *
 * 지키는 것(실제 함수, 격리 저장소):
 *  ① 판정 — 401·invalid_api_key·토큰 만료는 인증 거부, 한도 문구는 한도(인증으로 오분류 안 함), 일반 실패는 둘 다 아님
 *  ② 인증 거부 = 새 진입(reason=auth)·약 12시간 쉼 ③ 이미 쉬는 중에 또 오면 재통지 안 함(상태가 안 바뀜)
 *  ④ 성공 응답 한 번이면 즉시 풀린다(재로그인·자동 회복)  ⑤ 요약 경로도 인증 실패를 크기 탓으로 안 센다
 */
import { readFileSync } from "node:fs";
import {
  clearCooldowns,
  clearCooldownOnSuccess,
  cooldownRemainingMs,
  markCooldownAnnounced,
  __summarizerCooldownPortForTest,
  parseModelSpec,
  registerCooldownIfRateLimited,
} from "../../core/llm-runtime/index.js";
import { AUTH_COOLDOWN_MS, isAuthRejected, isRateLimited, keepsFoldBudget } from "../../core/llm-runtime/rate-limit.js";
import { saveCooldown } from "../../store/cooldowns.js";
import { assert, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "auth-rejection-cools-down",
  guards:
    "Codex 가 401 invalid_api_key 를 내는 동안 쿨다운에 안 걸려 매 턴 Codex 부터 시도해 시간을 버리고, 요약 실패를 크기 탓으로 세던 것",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const spec = parseModelSpec("codex:gpt-6-sol");
    if (spec === null) return [assert("spec 파싱", false, `parseModelSpec(codex:gpt-6-sol) = ${String(spec)}`)];
    const key = spec.provider ?? spec.adapter;
    clearCooldowns(key);
    // 실측 문자열(돌쇠 9/26 08:00) — 본 호출·요약 호출 모두 이 모양.
    const AUTH = 'Codex backend 호출 실패: 401 {\n  "code": "invalid_api_key",\n  "message": "Invalid token"\n}';
    const LIMIT = 'HTTP 429 {"error":{"type":"usage_limit_reached","resets_in_seconds":600}}';
    const positives = [AUTH, "API Error: 401 {\"type\":\"error\",\"error\":{\"type\":\"authentication_error\"}}",
      "Invalid API key · Please run /login", "OAuth token has expired", "OAuth token revoked", "HTTP 401 Unauthorized",
      // openai SDK 는 상태를 맨 앞에 둔다 · Codex 토큰 갱신 실패(재검토 F1 — 첫 좁힘이 놓쳤다)
      "401 Incorrect API key provided: sk-****", "401 User not found.", "401 status code (no body)",
      'OAuth token refresh failed: 401 {"error":{"code":"refresh_token_reused"}}'];
    // ★인증이 아닌데 첫 판이 잡던 것(싱크 레드팀 P3) — 멀쩡한 provider 를 12시간 막고 «다시 로그인» 을 거짓 안내.
    const negatives = ["codex: 조립된 입력 612,401자가 상한을 넘습니다", "최종 응답 텍스트 비어있음 (요청이 712,401자로 매우 큽니다)",
      "400 Invalid 'input[401].content': string too long", "File content (12,401 tokens) exceeds maximum",
      "MCP server 'github' failed: Unauthorized", "fetch failed: ECONNRESET", LIMIT];
    const posMiss = positives.filter((x) => !isAuthRejected(x));
    const negHit = negatives.filter((x) => isAuthRejected(x));
    const first = registerCooldownIfRateLimited(spec, new Error(AUTH));
    const remain = cooldownRemainingMs(spec);
    if (first !== null) markCooldownAnnounced(first.key, first.untilTs); // 실제 흐름: 통지를 보낸 자리가 남긴다
    const second = registerCooldownIfRateLimited(spec, new Error(AUTH));
    // 재등록(연장) 뒤에도 표시가 따라 늘어 — 첫 해제 시각이 지나도 같은 사건을 다시 알리지 않는다(재검토 F2).
    //  첫 해제 시각을 «지난 것» 으로 당긴 뒤 재등록 → 여전히 조용해야 한다.
    if (first !== null) markCooldownAnnounced(first.key, Date.now() + 30);
    registerCooldownIfRateLimited(spec, new Error(AUTH)); // 연장(탐침 실패) — 표시도 새 해제 시각까지 늘어야
    await new Promise((r) => setTimeout(r, 60)); // 옛 표시 시각을 지나 본다
    const extended = registerCooldownIfRateLimited(spec, new Error(AUTH));
    // 대조군 — 표시가 **정말로** 만료되면(사건 종료) 다음 실패는 새 사건으로 알린다(M4: 영구 표시 방지).
    if (first !== null) markCooldownAnnounced(first.key, Date.now() - 1);
    const afterExpiry = registerCooldownIfRateLimited(spec, new Error(AUTH));
    clearCooldownOnSuccess(spec);
    const afterOk = cooldownRemainingMs(spec);
    // ★P4 — 요약 경로·내부 호출이 먼저 **조용히** 등록해도 다음 본 턴이 통지를 받는다.
    clearCooldowns(key);
    saveCooldown(key, Date.now() + AUTH_COOLDOWN_MS); // 요약 포트가 하는 일(통지 없음)
    const afterSilent = registerCooldownIfRateLimited(spec, new Error(AUTH));
    // 요약 경로(포트)도 인증 거부를 12시간으로 등록한다(레드팀 M3 — 이 분기가 무검사였다).
    clearCooldowns(key);
    __summarizerCooldownPortForTest.register(key, AUTH);
    const portRemain = cooldownRemainingMs(spec);
    // 한도 문구는 한도로 — 인증 쿨다운(12시간)이 아니라 백엔드가 말한 10분.
    clearCooldowns(key);
    const lim = registerCooldownIfRateLimited(spec, new Error(LIMIT));
    const limRemain = cooldownRemainingMs(spec);
    clearCooldowns(key);
    const hist = readFileSync(new URL("../../core/llm-runtime/adapters/openai-codex-oauth-history.ts", import.meta.url), "utf8")
      .replace(/^\s*\/\/.*$/gm, "");
    // 알림을 **실제로 보내는 자리**가 «알렸음» 을 남긴다 — 빠지면 4시간 탐침 실패마다 같은 알림(스팸).
    const idx = readFileSync(new URL("../../core/llm-runtime/index.ts", import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, "");
    const notifySite = /if \(entered !== null && input\.internal !== true\) \{\s*\n\s*markCooldownAnnounced\(entered\.key, entered\.untilTs\);/.exec(idx)?.[0] ?? "";
    const budget = { auth: keepsFoldBudget(AUTH), limit: keepsFoldBudget(LIMIT), size: keepsFoldBudget("요약 결과가 비었습니다(시한 초과)") };
    const wired = /\(keepsFoldBudget\(msg\)\s*\?/.test(hist);
    return [
      assert("① 실제 인증 거부 문구는 전부 잡는다", posMiss.length === 0, posMiss.length === 0 ? `${positives.length}건 전부` : `★놓침: ${posMiss.join(" | ")}`),
      assert("★① 인증이 아닌 실패(숫자 속 401·인덱스·도구 오류·한도)는 안 잡는다", negHit.length === 0, negHit.length === 0 ? `${negatives.length}건 전부 아님` : `★오분류: ${negHit.join(" | ")}`),
      assert(
        "★② 인증 거부는 새 진입(reason=auth)으로 약 12시간 쉰다",
        first?.reason === "auth" && remain > AUTH_COOLDOWN_MS - 60_000 && remain <= AUTH_COOLDOWN_MS,
        `reason=${String(first?.reason)} 남음=${Math.round(remain / 60000)}분`,
      ),
      assert("③ 이미 쉬는 중에 또 오면 재통지하지 않는다(상태가 안 바뀜)", second === null && extended === null, JSON.stringify({ second, extended })),
      assert("③ 알린 사건이 정말로 끝난 뒤 다시 막히면 새로 알린다(표시가 영구가 아니다)", afterExpiry?.reason === "auth", JSON.stringify(afterExpiry)),
      assert("④ 성공 응답 한 번이면 즉시 풀린다", afterOk === 0, `남음=${afterOk}`),
      assert(
        "한도 문구는 한도로 — 백엔드가 말한 시간만 쉰다(인증 12시간으로 오분류 안 함)",
        lim?.reason === "limit" && limRemain > 0 && limRemain <= 600_000,
        `reason=${String(lim?.reason)} 남음=${Math.round(limRemain / 1000)}초`,
      ),
      assert("요약 경로(포트)도 인증 거부를 약 12시간 쉰다", portRemain > AUTH_COOLDOWN_MS - 60_000, `남음=${Math.round(portRemain / 60000)}분`),
      assert("통지를 보내는 자리가 «알렸음» 을 남긴다(탐침 실패마다 재통지 방지)", notifySite !== "", notifySite.replace(/\s+/g, " ") || "★통지 자리에서 표시를 안 남김"),
      assert("★P4 요약 경로가 먼저 조용히 등록해도 본 턴이 통지를 받는다", afterSilent?.reason === "auth", JSON.stringify(afterSilent)),
      assert("⑤ 요약 예산 — 한도·인증은 유지, 크기 실패는 줄인다(판정 함수 + 호출부 연결)", budget.auth && budget.limit && !budget.size && wired, JSON.stringify({ ...budget, wired })),
    ];
  },
};
