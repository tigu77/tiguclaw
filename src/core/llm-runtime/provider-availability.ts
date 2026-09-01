/**
 * **"이 provider 로 지금 답할 수 있나" — 단일 판정** (2026-08-13).
 *
 * ★왜 별도 모듈인가: 같은 판정이 이미 세 곳에 흩어져 있었다 —
 *  claude 어댑터의 인증 가드(`ANTHROPIC_API_KEY || CLAUDE_CODE_OAUTH_TOKEN`),
 *  openai 어댑터의 `conn.apiKey` 검사, 대시보드 모듈 카드의 `authenticated` 표시.
 *  빌트인 프로파일(사용 가능한 어댑터로 기본 풀을 조립)이 **네 번째 사본**을 만들 참이라
 *  판정을 여기 하나로 모으고 소비처가 부른다([[feedback_hand_maintained_lists]]).
 *
 * ★provider 마다 인증 신호가 다르다는 게 핵심이다 — `apiKey` 유무만 보면 **claude 구독
 *  사용자가 통째로 빠진다**(그들은 `ANTHROPIC_API_KEY` 가 아니라 `CLAUDE_CODE_OAUTH_TOKEN`
 *  을 가진다). 조용히 빠지면 "키를 넣었는데 왜 이 모델을 안 쓰지" 가 된다.
 *
 * 의존은 provider-registry(연결 해석) + auth-registry(구독 인증 심)뿐 — 어댑터를 import 하지
 * 않는다(어댑터가 이걸 부르므로 반대 방향이면 순환).
 */
import { resolveProviderConn } from "./provider-registry.js";
import { getAuthProvider } from "./auth-registry.js";

/**
 * claude 어댑터 인증 — 키 **또는** 구독 OAuth 토큰. 어댑터의 가드가 이걸 부른다
 * (그래서 이 판정과 실제 실행 조건이 갈릴 수 없다).
 */
export const claudeAuthAvailable = (): boolean =>
  (process.env.ANTHROPIC_API_KEY ?? "") !== "" ||
  // ★구독 경로는 **심에게 묻는다** (2026-09-01). 종전엔 여기서 env 를 직접 읽어서, Business
  //  판이 codex 구독만 빼고 claude 구독은 계속 쓰는 **비대칭**이었다 — 뺄 자리가 없었다.
  //  이제 `auth-providers.ts`(EXCLUDE 단위)가 없으면 심도 없고 구독 경로가 닫힌다.
  //  **없는 상태가 안전한 상태**다: 심은 제약이 아니라 능력이고, 빠져도 API 키는 위 줄로
  //  그대로 된다(레지스트리를 안 지난다). 능력 손실이 아니라 비용 차이다.
  (getAuthProvider("claude-subscription")?.isAuthenticated?.() ?? false);

/**
 * provider id → 지금 인증돼 있나. 미지 provider = false.
 *
 * ★구독(auth-provider) 계열은 **등록과 인증을 구분한다** (2026-08-13 수정). 처음엔
 *  "레지스트리에 있으면 가용" 으로 뒀는데 그건 틀렸다 — `auth-providers.ts` 는 부팅 때
 *  **무조건** 등록하므로, codex 토큰을 한 번도 발급하지 않은 설치에서도 등록은 돼 있다.
 *  그대로 두면 빈 인증을 풀에 넣어 매번 한 번씩 실패하고, `/models` 는 "인증됨" 이라고
 *  거짓말한다. 둘 다 필요하다: **심이 있고(등록)** + **토큰이 있다(`isAuthenticated`)**.
 *
 * ★토큰 판정은 provider 가 한다. codex 는 access 가 없어도 refresh 만 있으면 살아나는데,
 *  그 규칙은 codex 어댑터 안에 있다 — 여기서 env 이름을 다시 조합하면 두 벌이 된다.
 *  `isAuthenticated` 미구현 provider 는 env 키 유무로 강등(무회귀).
 */
export const providerAuthAvailable = (provider: string, cwd?: string): boolean => {
  const conn = resolveProviderConn(provider, cwd);
  if (conn === null) return false;
  if (conn.adapter === "claude") return claudeAuthAvailable();
  if (conn.adapter === "codex-oauth") {
    // 심이 없으면(Business 빌드 EXCLUDE·미로드) 어댑터가 AuthProviderMissingError 로
    // 죽는다 — 실행이 못 하는 것을 가용이라 말하지 않는다.
    // ★키는 provider 이름이 아니라 **어댑터 자기 정체성 "codex"** 다 — codex 어댑터가
    //  실행할 때 그렇게 조회한다(openai-codex-oauth.ts). 사용자가 codex-oauth 어댑터로
    //  다른 이름의 provider 를 정의해도 인증은 같은 심을 탄다.
    const auth = getAuthProvider("codex");
    if (auth === undefined) return false;
    return auth.isAuthenticated?.() ?? (process.env[conn.apiKeyEnv] ?? "") !== "";
  }
  // openai 어댑터(openai·ollama·google·사용자 정의) — 어댑터 가드와 같은 조건.
  return conn.apiKey !== undefined && conn.apiKey !== "";
};
