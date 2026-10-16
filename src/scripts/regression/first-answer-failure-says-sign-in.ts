/**
 * 회귀: **첫 답이 계정 문제로 실패하면 «다시 로그인» 으로 잇는다** (2026-10-16 대시보드 중심 온보딩 2단계 마무리).
 *
 * 사고: 첫 대화가 곧 AI 연결 확인인데, 계정이 없거나 만료되면 `OpenAI Codex OAuth token missing — run npm run codex-auth to get one.`
 *  같은 영어 개발자 문구가 «⚠️ 요청 처리 중 오류» 안에 그대로 나갔다. 대시보드엔 구독 로그인 흐름이 이미 있었다.
 *
 * 본다: 사전 가드(이름·문구)·401·만료는 어느 계정의 로그인인지 가려 안내 · 한도·일반 오류는 이 안내가 아님 · 진입점이 한도 판정보다 먼저 부른다.
 * 등급: **실행**(리프 판정) + 배선(소스).
 */
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";
import { readSourceSync, stripComments } from "./_wiring.js";

export const check: RegressionCheck = {
  name: "first-answer-failure-says-sign-in",
  guards: "첫 답이 계정 없음·만료로 실패하면 영어 개발자 문구(npm run codex-auth)가 그대로 나가던 것 — 대시보드 로그인으로 잇는다",
  run: async (): Promise<Assertion[]> => {
    const { signInGuideFor } = await import("../../core/llm-runtime/sign-in-guide.js");
    const { translate } = await import("../../core/i18n.js");
    const codex = translate("srv.turn.signIn.codex");
    const claude = translate("srv.turn.signIn.claude");
    const got = {
      codexMissing: signInGuideFor("OpenAI Codex OAuth token missing — run `npm run codex-auth` to get one."),
      codexExpired: signInGuideFor("codex 호출 실패: 401 OAuth token has expired"),
      // 갱신 실패엔 codex 라는 낱말이 없다 — 구독 사용자의 실제 만료 경로(레드팀 B F5)
      codexRefresh: signInGuideFor("OAuth token refresh failed: 401 invalid_grant"),
      claudeMissing: signInGuideFor("Claude credentials missing — set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN."),
      claude401: signInGuideFor("claude-agent-sdk error: API Error: 401 authentication_error"),
      byName: signInGuideFor("'groq' credentials are not set", "ProviderUnavailableError"),
      limit: signInGuideFor("codex usage_limit_reached 429"),
      other: signInGuideFor("socket hang up"),
    };
    const out: Assertion[] = [
      assert("계정 없음·만료·401 은 그 계정의 로그인 안내 · 이름만 있는 사전 가드는 일반 계정 안내 · 한도·일반 오류는 아님",
        got.codexMissing === codex && got.codexExpired === codex && got.codexRefresh === codex && got.claudeMissing === claude && got.claude401 === claude &&
          typeof got.byName === "string" && got.byName !== codex && got.byName !== claude &&
          got.limit === undefined && got.other === undefined,
        Object.fromEntries(Object.entries(got).map(([k, v]) => [k, v === undefined ? null : v.slice(0, 40)]))),
    ];
    const idx = stripComments(readSourceSync("src/index.ts"));
    const fn = idx.slice(idx.indexOf("const formatRegionAError"), idx.indexOf("const formatRegionAError") + 2500);
    const callAt = fn.indexOf("signInGuideFor(d, errorName)");
    const limitAt = fn.indexOf('failureKind(d, errorName) === "limit"');
    out.push(assert("진입점이 한도 판정보다 먼저 로그인 안내를 본다", callAt > 0 && limitAt > callAt, { callAt, limitAt }));
    return out;
  },
};
