/**
 * 회귀: **auth provider id 는 먼저 잡은 쪽이 갖는다** (2026-09-01).
 *
 * ★구독 인증을 플러그인으로 옮기면 종전 규칙(*"같은 id 재등록 시 최신으로 대체"*)이 곧
 *  **가로채기 문**이 된다: 나중에 뜬 플러그인이 `claude-subscription` 을 덮으면
 *  *"이 토큰은 유효하다"* 를 그쪽이 답한다. 코어만 등록하던 동안엔 무해했다.
 *
 * ★규칙은 `tool-name-claim.ts`(도구 이름)와 **같은 질문에 같은 답**이다. 함수를 합치지는
 *  않았다 — 저쪽은 이름 배열과 브리지 맵, 여기는 provider 객체 하나라 제네릭이 판정보다
 *  커진다. 같은 규칙이라는 것은 주석이 잇는다.
 *
 * ★**이건 격리가 아니다.** 격리가 0이라 마음먹은 코드는 다른 문으로 돈다. 여기서 막는 것은
 *  **덮어쓰기 한 가지**이고, 그 이상을 약속하지 않는다.
 *
 * 등급: **동작** — 레지스트리를 실제로 부른다. 전역을 건드리므로 **아무도 안 쓰는 id** 만
 * 쓴다(`regr-claim-*`) — 실제 provider 이름을 쓰면 뒤따르는 검사가 오염된다.
 */
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "auth-id-first-claim-wins",
  guards:
    "auth provider 등록이 «최신으로 대체» 라, 나중에 뜬 플러그인이 구독 인증 판정을 덮어 «이 토큰은 유효하다» 를 그쪽이 답할 수 있던 것",
  run: async (): Promise<Assertion[]> => {
    const { registerAuthProvider, getAuthProvider } = await import(
      "../../core/llm-runtime/auth-registry.js"
    );
    const id = "regr-claim-probe";
    const first = {
      provider: id,
      getAccessToken: (): Promise<string> => Promise.resolve("first"),
      isAuthenticated: (): boolean => false,
    };
    const usurper = {
      provider: id,
      getAccessToken: (): Promise<string> => Promise.resolve("usurper"),
      isAuthenticated: (): boolean => true,
    };

    registerAuthProvider(first);
    registerAuthProvider(usurper);
    const held = getAuthProvider(id);
    const kept = held === first;
    // ★판정까지 본다 — 객체 동일성만 보면 «같은 모양의 다른 객체» 로 덮는 변이를 놓친다.
    const judgment = held?.isAuthenticated?.() ?? true;

    // 같은 객체 재등록은 무해한 중복 배선이다(부팅이 두 번 불려도 경고를 뿜지 않는다).
    // ★**경고를 실제로 가로챈다.** 첫 판은 보유값만 봤는데, 동일 객체를 거절해도 보유값은
    //  그대로라 **판별력이 0이었다**(그 변이가 통과했다). 차이가 경고 한 줄뿐이면 경고를
    //  봐야 한다 — 못 실패하는 단언은 커버리지처럼 읽혀서 없는 것보다 나쁘다.
    const warned: string[] = [];
    const realWarn = console.warn;
    console.warn = (...a: unknown[]): void => {
      warned.push(a.map((x) => String(x)).join(" "));
    };
    try {
      registerAuthProvider(first);
    } finally {
      console.warn = realWarn;
    }
    const stillKept = getAuthProvider(id) === first && warned.length === 0;

    return [
      assert(
        "★★늦게 온 등록이 **먼저 잡은 것을 못 덮는다** — 덮을 수 있으면 인증 판정을 남이 답한다",
        kept && judgment === false,
        `보유=${kept ? "first" : "★usurper"} · 판정=${String(judgment)}`,
      ),
      assert(
        "★같은 객체를 다시 등록하는 것은 막지 않는다(부팅 배선이 두 번 돌아도 조용하다)",
        stillKept,
        stillKept ? "동일 객체 재등록 — 보유 유지 · 경고 0" : `★자기 자신에게 거절당했다(경고 ${warned.length}건)`,
      ),
    ];
  },
};
