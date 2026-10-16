/**
 * **계정이 없거나 거절된 실패 → 다시 로그인 안내** (2026-10-16 대시보드 중심 온보딩).
 *
 * ★첫 대화가 곧 AI 연결 확인이라, 처음 쓰는 사람이 처음 보는 실패가 이것이다. 종전엔 `OpenAI Codex OAuth token missing — run
 *  npm run codex-auth to get one.` 같은 영어 개발자 문구가 그대로 나갔다. 대시보드엔 구독 로그인 흐름(플러그인 → *-subscription-auth)이
 *  이미 있으니 그리로 잇는다. 텔레그램에도 같은 문구가 가므로 대시보드 길과 터미널 길을 함께 적는다.
 * 리프다 — `src/index.ts` 안에 두면 회귀가 실행할 수 없다(import 가 데몬을 띄운다).
 */
import { translate } from "../i18n.js";
import { isProviderUnavailable } from "./index.js";
import { isAuthRejected } from "./rate-limit.js";
import { subscriptionAuthAvailable } from "../auth-plugin-presence.js";

/** 로그인 안내가 맞는 실패면 그 문구, 아니면 undefined. 판정은 이름(사전 가드) → 문구(감싸진 오류·401·만료). */
export const signInGuideFor = (detail: string, errorName?: string): string | undefined => {
  const d = detail || "";
  if (!(errorName === "ProviderUnavailableError" || isProviderUnavailable(d) || isAuthRejected(d))) return undefined;
  // 키는 리터럴로 — 카탈로그 검사가 호출부를 글자로 대조한다(조립하면 «고아 번역» 으로 보인다).
  // ★Codex 토큰 **갱신** 실패(`OAuth token refresh failed: 401`)엔 codex 라는 낱말이 없다 — 구독 사용자의 실제 만료 경로라 같이 본다(레드팀 B F5).
  // ★구독 로그인 단추는 그 인증 플러그인이 **있을 때만** 가리킨다 — 없는 설치에 없는 단추를 권하지 않는다(doctor 와 같은 판정).
  if (/codex|chatgpt|OAuth token refresh failed/i.test(d) && subscriptionAuthAvailable("codex")) return translate("srv.turn.signIn.codex");
  if (/claude|anthropic/i.test(d) && subscriptionAuthAvailable("claude-subscription")) return translate("srv.turn.signIn.claude");
  return translate("srv.turn.signIn.other", { detail: d.slice(0, 200) });
};
