/**
 * auth-provider 레지스트리 — 라이브-리프레시 구독 인증(Tier 2)용 얇은 심(seam).
 *
 * 설계 근거: `_workspace/auth-provider-plugin_architect_contract.md`
 * (승격 시 docs/decisions/2026-07-18-auth-provider-plugin.md).
 *
 * ★존재 이유(미학 아님): 백엔드 어댑터가 auth 심볼을 정적 import 하면 그 auth 파일을
 * 빌드에서 뺄 때 컴파일이 깨진다. 백엔드가 이 레지스트리(항상 코어)만 참조하고 provider-id
 * 로 조회하면, 등록 배선(auth-providers.ts)을 Business 매니페스트에서 EXCLUDE 해도 백엔드는
 * 컴파일된다 — 레지스트리가 비어 codex 어댑터는 graceful self-disable(§4).
 *
 * §0 단방향 불변식: 코어는 레지스트리 + "어댑터의 자기 provider id"만 안다. 특정 *외부
 * 플러그인 이름* 을 하드코딩하지 않는다 — codex 어댑터가 자기 id "codex" 로 조회하는 것은
 * 자기 정체성 참조라 불변식 대상 아님(계약 §2).
 */

/**
 * 라이브-리프레시 인증 provider 의 최소 계약.
 * refresh·만료판정·PKCE·토큰저장은 전부 provider 내부 은닉 — 호출자는 fresh 토큰만 받는다.
 */
export interface AuthProvider {
  /** 이 auth 가 서빙하는 provider id (예: "codex"). 레지스트리 키 = 어댑터 자기 정체성. */
  readonly provider: string;
  /**
   * 유효한 fresh bearer 토큰을 반환. 재인증 필요(refresh 실패·토큰 0) 시 throw —
   * 호출자(백엔드)는 이를 폴백 신호로 취급한다.
   */
  getAccessToken(): Promise<string>;
  /**
   * **지금 인증돼 있나 — 네트워크 없이, 동기로** (2026-08-13).
   *
   * ★왜 `getAccessToken` 으로 대신할 수 없나: 그건 async 이고 **부작용이 있다**(만료가
   *  가까우면 refresh 를 때려 토큰을 갱신하고 홈 `.env` 를 다시 쓴다). "풀에 이 provider 를
   *  넣을까" 를 묻는 자리(모델 프로파일 조립·모듈 카드)에서 그걸 부르면 화면 한 번 여는
   *  것이 토큰 갱신을 일으킨다. 판정은 판정이어야 한다.
   *
   * ★왜 provider 가 직접 답해야 하나: "무엇이 있으면 인증인가" 는 provider 마다 다르다
   *  (codex 는 access **또는** refresh 만 있어도 살아난다 — refresh 로 새 access 를 받는다).
   *  호출자가 env 이름을 알아서 조합하면 그 판정이 두 벌이 되고, 한쪽만 갱신되는 순간
   *  특정 인증 형태의 사용자가 조용히 빠진다(claude 구독 사용자에게 실제로 그랬다).
   *
   * 미구현(undefined)이면 호출자가 자기 기본 판정으로 강등한다 — 기존 provider 무회귀.
   */
  isAuthenticated?(): boolean;
}

/** provider-id 키 코어 레지스트리. */
const registry = new Map<string, AuthProvider>();

/** auth provider 등록(멱등 — 같은 provider id 재등록 시 최신으로 대체). */
export const registerAuthProvider = (p: AuthProvider): void => {
  registry.set(p.provider, p);
};

/** provider id 로 auth provider 조회. 부재 시 undefined(호출자가 graceful 처리). */
export const getAuthProvider = (provider: string): AuthProvider | undefined =>
  registry.get(provider);

/**
 * auth provider 부재 시 백엔드가 던지는 typed 에러. 부재 = 구독 인증 미설치/미인증
 * (Business EXCLUDE 빌드 또는 미인증 상태) → 기존 폴백 경로(claude 합류)로 전파. 코어 크래시 0.
 */
export class AuthProviderMissingError extends Error {
  constructor(
    readonly provider: string,
    detail = "구독 인증 미설치/미인증",
  ) {
    super(`auth-provider "${provider}" 부재: ${detail}`);
    this.name = "AuthProviderMissingError";
  }
}
