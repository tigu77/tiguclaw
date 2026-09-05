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

/** 화면이 그리는 데 필요한 것만. 이름·인증여부·«로그인 방법이 있나». */
export const handleAuthProviders = async (ctx: RouteCtx): Promise<void> => {
  const items = listAuthProviders().map((p) => ({
    provider: p.provider,
    authenticated: p.isAuthenticated === undefined ? null : p.isAuthenticated(),
    login: p.login === undefined ? null : { label: p.login.label, canFinish: p.login.finish !== undefined },
  }));
  writeJson(ctx.res, 200, { ok: true, providers: items });
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
