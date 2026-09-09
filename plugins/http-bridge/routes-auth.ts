/**
 * 구독 인증 라우트 — **화면에서 인증한다** (2026-09-05 정태님 요청).
 *
 * ★없던 건 능력이 아니라 손잡이였다. 발급 수단(`npm run codex-auth`·`claude-auth`)은 전부
 *  **터미널 안**이라, 폰이나 원격에서는 인증할 길이 아예 없었다.
 *
 * ★**이름을 열거하지 않는다.** 어떤 구독이 있는지는 auth 레지스트리가 안다(플러그인이 등록한
 *  것이 곧 이 설치가 가진 것). 여기서 provider 이름을 박으면 셋째 구독이 생길 때 조용히
 *  빠진다([[feedback_hand_maintained_lists]]).
 *
 * ★**토큰은 절대 안 나간다.** 응답에 실리는 것은 «인증됐나» 라는 불리언과 사람이 읽는 안내
 *  뿐이다. `getAccessToken` 은 여기서 부르지 않는다 — 그건 refresh 부작용까지 있다.
 */
import {
  listAuthProviders,
  getAuthProvider,
} from "../../src/core/llm-runtime/auth-registry.js";
import { writeJson } from "../../src/core/net/write-json.js";
import { readJsonBody } from "./http-body.js";
import type { RouteCtx } from "./route-ctx.js";

/**
 * 화면이 그리는 데 필요한 것만. 이름·인증여부·«로그인 방법이 있나»·**한도가 얼마나 남았나**.
 *
 * ★**한도는 여기서 안 가져온다** (2026-09-09 정태님: *"플러그인 상세정보는 플러그인 자체를
 *  눌렀을 때 처리해도 되지 않아?"*). 종전엔 이 목록 응답이 **모든 provider 의 사용량을
 *  전부 기다렸다** — claude 는 CLI 를 spawn 하고(시한 25초), codex 는 외부를 때린다(5초).
 *  그런데 그 숫자를 그리는 자리는 **상세 카드 하나뿐**이고(`buildPluginCard`), 목록 행엔
 *  아예 안 나온다. **아무도 안 볼 수도 있는 숫자 때문에 플러그인 메뉴 전체가 멈췄다.**
 *  ★더구나 의도는 원래 그게 아니었다 — `codex-subscription-auth/usage.ts` 머리말이
 *  *"구독 플러그인 **상세를 열 때** 한 번 가져온다"* 라고 적어두고 배선만 목록에 붙어
 *  있었다. 자리를 옮기면 «느린 provider 가 목록을 막는다» 는 문제 자체가 사라진다
 *  (비동기로 뒤에서 채우는 부품을 새로 만들 필요가 없다).
 *  → 사용량은 `handleAuthUsage`(provider 하나)가 상세를 열 때 가져온다.
 * ★**문장을 여기서 만들지 않는다** (2026-09-07 정태님) — 모양만 그대로 나른다. 코어도
 *  플러그인도 «한도» 라는 도메인을 알 필요가 없고, 문장은 **카탈로그가 있는 대시보드**가
 *  만든다(플러그인이 만들면 영어 화면에 한국어가 샌다 — `i18n-catalogs-and-coverage`).
 * ★모르는 provider 는 `null` 이다(claude 는 사용률을 못 받는다). 화면은 빈 자리를 «모름» 으로
 *  읽어야 하고, 0% 로 뭉개면 안 된다.
 * ★한 provider 가 느리거나 실패해도 나머지는 그린다 — `allSettled` 로 서로를 안 막는다.
 */
export const handleAuthProviders = async (ctx: RouteCtx): Promise<void> => {
  const providers = listAuthProviders();
  const items = providers.map((p) => ({
    provider: p.provider,
    authenticated: p.isAuthenticated === undefined ? null : p.isAuthenticated(),
    login: p.login === undefined ? null : { label: p.login.label, canFinish: p.login.finish !== undefined },
    /** 이 provider 가 한도를 **말해줄 수 있나** — 화면이 조회를 걸지 말지 정한다. */
    hasUsage: p.getUsage !== undefined,
  }));
  writeJson(ctx.res, 200, { ok: true, providers: items });
};

/**
 * **한도가 얼마나 남았나 — provider 하나** (2026-09-09).
 *
 * ★상세를 여는 것이 곧 «지금 알고 싶다» 이므로 여기선 기다려도 된다 — 누른 사람이 그
 *  숫자를 보려고 기다리는 것이다. 목록(위)이 기다리던 것과는 성질이 다르다.
 * ★`?force=1` — 사용자가 **새로고침을 눌렀을 때**. 캐시가 «화면 한 번 여는 동안의 중복
 *  호출을 접는 것» 이라면, 다시 누른 것은 정의상 그 중복이 아니다.
 * ★모르는 provider·조회 실패는 **200 + usage:null**(«모름»)이다. 없는 숫자를 0으로
 *  뭉개지 않고, 화면은 빈 자리를 «모름» 으로 읽는다.
 */
export const handleAuthUsage = async (ctx: RouteCtx): Promise<void> => {
  const provider = (ctx.url.searchParams.get("provider") ?? "").trim();
  const force = ctx.url.searchParams.get("force") === "1";
  const p = provider === "" ? undefined : getAuthProvider(provider);
  if (p === undefined || p.getUsage === undefined) {
    writeJson(ctx.res, 200, { ok: true, provider, usage: null });
    return;
  }
  let u;
  try {
    u = await p.getUsage(force);
  } catch {
    u = undefined; // 조용히 «모름» — 비공식 경로는 언제든 막힌다.
  }
  writeJson(ctx.res, 200, {
    ok: true,
    provider,
    usage:
        u === undefined
          ? null
          : {
              windows: u.windows,
              measuredAt: u.measuredAt,
              ...(u.retryAt === undefined ? {} : { retryAt: u.retryAt }),
              ...(u.unavailable === undefined ? {} : { unavailable: u.unavailable }),
              ...(u.limitReached === undefined ? {} : { limitReached: u.limitReached }),
            },
  });
};

/** 로그인 시작 — provider 가 «무엇을 해야 하나» 를 돌려준다(열 URL·터미널 한 줄·붙여넣기 안내). */
export const handleAuthLoginBegin = async (ctx: RouteCtx): Promise<void> => {
  const body = await readJsonBody(ctx.req);
  const provider = typeof body.provider === "string" ? body.provider.trim() : "";
  const p = provider === "" ? undefined : getAuthProvider(provider);
  if (p === undefined || p.login === undefined) {
    writeJson(ctx.res, 400, { error: "이 설치에 그 인증 방법이 없습니다." });
    return;
  }
  try {
    const plan = await p.login.begin();
    writeJson(ctx.res, 200, { ok: true, provider, plan, canFinish: p.login.finish !== undefined });
  } catch (e) {
    // never-throw — 인증 시작 실패로 브리지가 죽지 않는다(핫경로 격리).
    writeJson(ctx.res, 200, { ok: false, error: e instanceof Error ? e.message : String(e) });
  }
};

/** 로그인 마무리 — 사용자가 붙여넣은 것(리다이렉트 주소·토큰)을 provider 에 넘긴다. */
export const handleAuthLoginFinish = async (ctx: RouteCtx): Promise<void> => {
  const body = await readJsonBody(ctx.req);
  const provider = typeof body.provider === "string" ? body.provider.trim() : "";
  const pasted = typeof body.pasted === "string" ? body.pasted : "";
  const p = provider === "" ? undefined : getAuthProvider(provider);
  if (p === undefined || p.login?.finish === undefined) {
    writeJson(ctx.res, 400, { error: "이 설치에 그 인증 방법이 없습니다." });
    return;
  }
  if (pasted.trim() === "") {
    writeJson(ctx.res, 200, { ok: false, message: "붙여넣은 내용이 비어 있습니다." });
    return;
  }
  try {
    const r = await p.login.finish(pasted);
    // ★결과는 남기되 **붙여넣은 값은 절대 안 남긴다**(그게 토큰이다).
    console.log(`[auth] ${provider} 인증 마무리: ${r.ok ? "성공" : "실패"} — ${r.message}`);
    writeJson(ctx.res, 200, {
      ok: r.ok,
      message: r.message,
      authenticated: p.isAuthenticated === undefined ? null : p.isAuthenticated(),
    });
  } catch (e) {
    writeJson(ctx.res, 200, { ok: false, message: e instanceof Error ? e.message : String(e) });
  }
};
