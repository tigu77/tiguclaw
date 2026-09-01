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

/**
 * auth provider 등록 — ★**먼저 잡은 쪽이 갖는다** (2026-09-01).
 *
 * ★종전엔 *"멱등 — 같은 id 재등록 시 최신으로 대체"* 였다. 코어만 등록하던 동안엔 무해했지만,
 *  **구독 인증을 플러그인으로 옮기면 그 규칙이 곧 가로채기 문**이 된다: 나중에 뜬 플러그인이
 *  `claude-subscription` 을 덮으면 *"이 토큰은 유효하다"* 를 그쪽이 답하게 된다.
 *
 * ★**규칙은 `tool-name-claim.ts` 와 같다** — 도구 이름도 같은 질문("늦게 온 것이 먼저 잡은
 *  것을 덮지 못하게")에 같은 답을 한다. 함수를 합치지는 않았다: 저쪽은 이름 배열과 브리지
 *  맵을 다루고 여기는 provider 객체 하나라, 하나로 묶으려면 제네릭이 판정보다 커진다.
 *  **같은 규칙이라는 것은 이 주석이 잇는다.**
 *
 * ★**조용히 버리지 않는다.** 거절하면 누가 무엇을 뺏으려 했는지 로그에 남긴다 — 플러그인
 *  작성자는 그걸 봐야 고친다([[feedback_logs_must_stand_alone]]).
 *
 * ★그리고 이건 **격리가 아니다.** 격리가 0이라 남의 코드가 이 모듈을 직접 import 해서
 *  `registry` 를 건드릴 수는 없지만(모듈 지역 변수다), 코어의 다른 문으로 우회할 여지는
 *  남는다. 여기서 막는 것은 **덮어쓰기 한 가지**다 — 그 이상을 약속하지 않는다.
 */
export const registerAuthProvider = (p: AuthProvider): void => {
  const held = registry.get(p.provider);
  if (held !== undefined) {
    if (held === p) return; // 같은 객체 재등록 = 무해한 중복 배선.
    console.warn(
      `[auth] provider id '${p.provider}' 는 이미 등록돼 있어 **거절**했습니다 — ` +
        `먼저 잡은 쪽이 갖습니다. 늦게 온 등록이 인증 판정을 덮으면 "이 토큰은 유효하다" 를 ` +
        `그쪽이 답하게 됩니다. 다른 id 를 쓰세요.`,
    );
    return;
  }
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
