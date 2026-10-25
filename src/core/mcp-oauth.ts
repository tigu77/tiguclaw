/**
 * **원격 MCP OAuth — 코어 한 곳** (2026-10-18, 원격 MCP 2단계 · [설계 검토](../../docs/decisions/2026-10-18-remote-mcp-oauth-review-request.md)·
 * [아스트라 회신](../../docs/decisions/2026-10-18-remote-mcp-oauth-astra-review.md) 반영).
 *
 * ★OAuth 를 세 벌로 만들지 않는다 — 로그인 시작·코드 교환·갱신·보관·삭제는 **여기만** 한다. 어댑터는 판단하지 않고, `external-mcp` 가 설정을
 *  읽을 때 이 모듈이 준 액세스 토큰을 `Authorization` 헤더로 합성한다(Claude 는 그 설정을 SDK 에 그대로, Codex·OpenAI 는 브리지 연결에). 그래서
 *  한 번 로그인하면 어느 모델로 돌아도 붙는다.
 * ★브리지에도 SDK `authProvider` 를 주지 않는다 — 주면 전송이 401 때 **스스로** 갱신해 이 모듈의 갱신과 겹친다(회전형 refresh 토큰이면 한쪽이
 *  무효가 된다). 갱신은 여기 한 곳에서 **한 번에 하나**(같은 대상 동시 요청은 결과를 나눠 가진다).
 * ★SDK 가 주는 것은 다시 만들지 않는다(원칙 #5): 로그인 = `auth()`(탐색 RFC 9728/8414 · 동적 등록 RFC 7591 · PKCE · 코드 교환),
 *  갱신 = `refreshAuthorization`. 갱신에 `auth()` 를 안 쓰는 이유는 하나 — `auth()` 는 갱신이 **네트워크 오류**로 실패해도 새 로그인(REDIRECT)으로
 *  넘어가 «일시 실패» 와 «다시 로그인해야 함» 을 못 가른다(SDK `authInternal` 의 refresh catch).
 * ★비밀(code·verifier·토큰·client secret)은 로그·도구 답·대화에 싣지 않는다. 상태 이름만 밖으로 나간다. 예외 하나 — **인가 링크**는
 *  사용자가 열어야 하므로 도구 답에 실리고, 링크엔 state 가 들어 있다(공급자 규약). state 만으로는 아무것도 못 한다(code 가 함께 와야 한다).
 *
 * 보관: `<home>/mcp-oauth/<열쇠 해시>.json` — 열쇠 = (설정 파일 경로 · 서버 이름 · URL). 프로젝트가 같은 이름을 덮어써도 파일이 다르면 따로,
 *  URL 이 바뀌면 옛 토큰을 안 쓴다. 쓰기는 임시 파일 → 교체(원자적). 0600 은 Unix 에서만 의미가 있다 — Windows 는 홈 폴더 권한에 기댄다.
 * 진행 중 로그인(state·verifier)은 **메모리에만** 둔다 — 재시작하면 로그인을 다시 시작한다(콜백이 와도 «만료» 로 답한다).
 */
import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  auth,
  discoverOAuthServerInfo,
  refreshAuthorization,
  selectResourceURL,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { OAuthError, ServerError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { getPaths } from "./paths.js";
import { translate } from "./i18n.js";

/** 로그인 대상 하나 — 어느 설정 파일의 어느 이름·어느 URL. */
export interface McpOAuthKey {
  file: string;
  name: string;
  url: string;
}
export type McpOAuthStatus = "authorized" | "login-needed" | "none";

interface StoredRecord {
  file: string;
  name: string;
  url: string;
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  /** 액세스 토큰 만료 시각(ms) — `expires_in` 이 없으면 없다(만료를 모름 = 401 이 올 때까지 쓴다). */
  expiresAt?: number;
  discovery?: OAuthDiscoveryState;
  /** 갱신이 거절됐다 — 다시 로그인해야 한다. */
  loginNeeded?: boolean;
}

/** 브리지 콜백 경로 — 브리지가 이 경로만 토큰 없이 받는다(state 로 지킨다). */
export const MCP_OAUTH_CALLBACK_PATH = "/oauth/mcp/callback";
/** 콜백 주소 — 브리지와 같은 포트 규칙(`HTTP_BRIDGE_PORT`, 기본 17011). 네이티브 앱 OAuth 의 루프백 리다이렉트. */
export const mcpOAuthRedirectUrl = (env: NodeJS.ProcessEnv = process.env): string =>
  `http://127.0.0.1:${env.HTTP_BRIDGE_PORT?.trim() || "17011"}${MCP_OAUTH_CALLBACK_PATH}`;

/** 로그인 시도의 수명 — 넘으면 콜백·붙여넣기 모두 «만료». */
export const MCP_OAUTH_ATTEMPT_TTL_MS = 10 * 60 * 1000;
/** 이만큼 남았으면 미리 갱신한다(턴 도중 만료를 줄인다 — 긴 턴은 다음 턴에 회복). */
const REFRESH_SKEW_MS = 5 * 60 * 1000;
/**
 * 갱신 요청 하나의 시한 · 턴이 갱신을 기다리는 최대 시간 · 일시 실패 뒤 다시 갱신하지 않는 시간.
 * ★셋이 없을 때: 인가 서버가 요청을 받고 답하지 않으면 원격 서버마다 서버 기본 시한(~5분)씩 **매 턴** 막혔다(적대 검토 P1 — 3개에 904초).
 *  기다림을 넘기면 아직 유효한 토큰으로(없으면 헤더 없이) 가고, 갱신은 뒤에서 마저 한다 — 다음 읽기가 그 결과를 쓴다.
 */
const REFRESH_FETCH_TIMEOUT_MS = 10_000;
const REFRESH_WAIT_MS = 3_000;
const REFRESH_RETRY_AFTER_MS = 60_000;

const storeDir = (): string => path.join(getPaths().home, "mcp-oauth");
const keyHash = (k: McpOAuthKey): string =>
  createHash("sha256").update(JSON.stringify([path.resolve(k.file), k.name, k.url])).digest("hex").slice(0, 32);
const recordPath = (k: McpOAuthKey): string => path.join(storeDir(), `${keyHash(k)}.json`);

const readRecord = async (k: McpOAuthKey): Promise<StoredRecord | undefined> => {
  try {
    const r = JSON.parse(await fs.readFile(recordPath(k), "utf8")) as StoredRecord;
    return r.name === k.name && r.url === k.url ? r : undefined;
  } catch {
    return undefined;
  }
};
const writeRecord = async (k: McpOAuthKey, r: StoredRecord): Promise<void> => {
  await fs.mkdir(storeDir(), { recursive: true, mode: 0o700 });
  const dest = recordPath(k);
  const tmp = `${dest}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(r), { encoding: "utf8", mode: 0o600 });
  await fs.rename(tmp, dest);
};

/**
 * 대상별 세대 — 서버 제거(`forgetMcpOAuth`)가 올린다. 늦게 끝난 로그인·갱신은 시작 때의 세대와 다르면 **저장하지 않는다**
 *  (지운 서버의 인증이 되살아나지 않게). 메모리 값이다 — 재시작 뒤엔 진행 중인 것이 없으니 충분하다.
 */
const generations = new Map<string, number>();
/**
 * (설정 파일, 서버 이름) 단위 세대 — 삭제는 **디스크 기록이 있든 없든** 이것을 올린다. ★첫 로그인 준비가 `auth()` 를 기다리는 동안엔 기록도 시도도
 *  아직 없어서, 삭제가 무효화할 대상이 없었고 늦게 돌아온 로그인이 지운 서버의 인증을 되살렸다(아스트라 10-19 재현). URL 별 격리는 위 세대가 그대로 진다.
 */
const nameGenerations = new Map<string, number>();
const nameKey = (file: string, name: string): string => `${path.resolve(file)}\u0000${name}`;
const genOf = (k: McpOAuthKey): number => (generations.get(keyHash(k)) ?? 0) + (nameGenerations.get(nameKey(k.file, k.name)) ?? 0);

interface Attempt {
  key: McpOAuthKey;
  state: string;
  verifier?: string;
  authorizationUrl?: string;
  redirectUrl: string;
  createdAt: number;
  gen: number;
  /** 콜백 주소가 바뀌어 다시 등록한 클라이언트 — 완료 때 기록에 넣는다(`startMcpLogin`). */
  client?: OAuthClientInformationMixed;
}
/** 진행 중 로그인 — state → 시도. 대상마다 하나(새로 시작하면 옛 시도는 취소). */
const attempts = new Map<string, Attempt>();
const dropAttemptsFor = (k: McpOAuthKey): void => {
  const h = keyHash(k);
  for (const [s, a] of attempts) if (keyHash(a.key) === h) attempts.delete(s);
};

/** SDK 가 부르는 보관 자리 — 레코드 사본을 고치고, 호출부가 끝에 한 번 저장한다. */
const providerFor = (rec: StoredRecord, opts: { redirectUrl?: string; attempt?: Attempt; ignoreTokens?: boolean }): OAuthClientProvider => ({
  get redirectUrl() {
    return opts.redirectUrl;
  },
  get clientMetadata() {
    return {
      client_name: "tiguclaw",
      redirect_uris: opts.redirectUrl !== undefined ? [opts.redirectUrl] : [],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  },
  ...(opts.attempt !== undefined ? { state: () => opts.attempt!.state } : {}),
  clientInformation: () => rec.client,
  saveClientInformation: (ci) => {
    rec.client = ci;
  },
  tokens: () => (opts.ignoreTokens === true ? undefined : rec.tokens),
  saveTokens: (t) => {
    rec.tokens = t;
    rec.expiresAt = typeof t.expires_in === "number" ? Date.now() + t.expires_in * 1000 : undefined;
    rec.loginNeeded = false;
  },
  redirectToAuthorization: (u) => {
    if (opts.attempt !== undefined) opts.attempt.authorizationUrl = u.toString();
  },
  saveCodeVerifier: (v) => {
    if (opts.attempt !== undefined) opts.attempt.verifier = v;
  },
  codeVerifier: () => {
    if (opts.attempt?.verifier === undefined) throw new Error("mcp-oauth: no code verifier for this attempt");
    return opts.attempt.verifier;
  },
  saveDiscoveryState: (s) => {
    rec.discovery = s;
  },
  discoveryState: () => rec.discovery,
  invalidateCredentials: (scope) => {
    if (scope === "all" || scope === "client") rec.client = undefined;
    if (scope === "all" || scope === "tokens") {
      rec.tokens = undefined;
      rec.expiresAt = undefined;
    }
    if (scope === "all" || scope === "discovery") rec.discovery = undefined;
  },
});

/** 지금 상태 — 밖에 내보내는 것은 이 이름뿐이다. */
export const mcpOAuthStatus = async (k: McpOAuthKey): Promise<McpOAuthStatus> => {
  const r = await readRecord(k);
  if (r === undefined) return "none";
  if (r.loginNeeded === true) return "login-needed";
  return r.tokens !== undefined ? "authorized" : "none";
};

/** 로그인이 필요하다고 적는다. 토큰은 지우지 않는다(다음 로그인이 덮는다). 그 사이 서버가 지워졌으면 적지 않는다(지운 서버를 되살리지 않게). */
export const markMcpLoginNeeded = async (k: McpOAuthKey, gen: number = genOf(k)): Promise<void> => {
  const r = (await readRecord(k)) ?? { file: path.resolve(k.file), name: k.name, url: k.url };
  if (r.loginNeeded === true || gen !== genOf(k)) return;
  r.loginNeeded = true;
  await writeRecord(k, r);
};

/** 401 을 받은 액세스 토큰 — 다음 읽기는 만료와 무관하게 **한 번** 갱신한다. */
const forceRefresh = new Map<string, string>();
/**
 * 401 뒤 강제 갱신으로 받은 토큰 중 **아직 한 번도 인증에 성공하지 못한 것** — 그 토큰을 보내 401 이면 «로그인 필요»(갱신을 끝없이 되풀이하지
 *  않는다). 그 토큰으로 연결이 한 번이라도 되면(`noteMcpAuthorized`) 지운다 — 그 뒤의 401 은 «새 토큰도 거절» 이 아니라 평범한 무효화다.
 * ★고정 시간 창(10분)을 두었다가 뺐다(아스트라 회신 Q2) — 사용자 인증 상태를 바꾸는 판정을 근거 없는 시간으로 하지 않는다. 증거로 가른다.
 */
const forcedToken = new Map<string, string>();
/** 일시 실패한 시각 — `REFRESH_RETRY_AFTER_MS` 안에서는 다시 갱신하지 않는다. */
const refreshFailedAt = new Map<string, number>();

/**
 * 연결이 인증으로 거절됐다(사용자 인증 헤더 없이) — 갱신할 수 있으면 다음 읽기가 한 번 갱신하고(그 갱신이 거절되면 그때 «로그인 필요»),
 *  갱신할 수 없으면 바로 «로그인 필요».
 * ★401 하나로 곧장 «로그인 필요» 로 두면 살아 있는 refresh 토큰을 버린다(적대 검토 P2-1) — 공급자가 `expires_in` 을 안 주거나 토큰을 일찍
 *  무효화한 경우, 일시 실패 동안 헤더 없이 붙어 401 을 받은 경우가 전부 영구 재로그인이 됐다.
 */
export const noteMcpUnauthorized = async (k: McpOAuthKey, sentToken?: string): Promise<void> => {
  const gen0 = genOf(k);
  const h = keyHash(k);
  const r = await readRecord(k);
  if (r?.loginNeeded === true) return;
  // 이미 바뀐 토큰에 대한 늦은 401 — refresh 가 없는 공급자에서도 방금 한 로그인을 버리지 않는다(재검토 10-18).
  if (sentToken !== undefined && r?.tokens !== undefined && sentToken !== r.tokens.access_token) return;
  if (r?.tokens?.refresh_token === undefined || r.client === undefined) {
    await markMcpLoginNeeded(k, gen0);
    return;
  }
  // ★판정은 **실제로 보낸 토큰**으로 한다(재검토 P2-a) — 기록 속 토큰으로 보면, 헤더 없이 받은 401·이미 바뀐 토큰에 대한 늦은 401 이
  //  방금 받은 새 토큰을 «또 거절됨» 으로 읽어 살아 있는 refresh 를 버렸다.
  //  헤더 없이 받은 401: 갱신할 수 있으니 표시하지 않는다(다음 읽기가 만료·백오프대로 갱신) · 옛 토큰에 대한 401: 이미 지나간 일.
  if (sentToken === undefined || sentToken !== r.tokens.access_token) return;
  // 만료 시각을 알고 이미 지났으면 정상 만료다 — «갱신 직후 새 토큰도 거절» 과 같게 보지 않는다(아스트라 회신 Q2).
  const expired = r.expiresAt !== undefined && r.expiresAt <= Date.now();
  if (!expired && forcedToken.get(h) === sentToken) {
    await markMcpLoginNeeded(k, gen0);
    return;
  }
  forceRefresh.set(h, sentToken);
};

/** 이 토큰으로 인증에 성공했다(연결됨) — 강제 갱신으로 받은 토큰이면 «검증됨» 으로 둔다(`forcedToken` 주석). 디스크를 안 읽는다. */
export const noteMcpAuthorized = (k: McpOAuthKey, sentToken: string | undefined): void => {
  const h = keyHash(k);
  if (sentToken !== undefined && forcedToken.get(h) === sentToken) forcedToken.delete(h);
};
/** 검증을 기다리는 강제 갱신 토큰이 있나 — 성공 통지를 보낼지 호출부가 싸게 거른다. */
export const hasUnverifiedForcedToken = (): boolean => forcedToken.size > 0;

/**
 * 로그인 시작 — 인가 URL 을 돌려준다(데몬은 브라우저를 열지 않는다 — 화면 없는 기계일 수 있다). 이미 쓸 수 있는 토큰이 있으면 `authorized`.
 * ★링크를 만든 것은 로그인 성공이 아니다 — 완료는 콜백이나 붙여넣기(`completeMcpLogin`)가 한다.
 */
export const startMcpLogin = async (
  k: McpOAuthKey,
  redirectUrl: string = mcpOAuthRedirectUrl(),
  fetchFn?: typeof fetch,
): Promise<{ status: "redirect"; url: string; expiresInMs: number } | { status: "authorized" }> => {
  const rec: StoredRecord = (await readRecord(k)) ?? { file: path.resolve(k.file), name: k.name, url: k.url };
  // ★등록한 클라이언트는 그때의 콜백 주소에 묶인다 — 브리지 포트가 바뀌었으면 다시 등록한다(안 하면 공급자가 redirect_uri 불일치로
  //  영구 거절했다, 리뷰 10-18). 등록 응답에 주소 목록이 없으면 판단할 수 없으니 그대로 쓴다.
  const registered = (rec.client as { redirect_uris?: unknown } | undefined)?.redirect_uris;
  const reRegister = Array.isArray(registered) && !registered.includes(redirectUrl);
  if (rec.tokens !== undefined && rec.loginNeeded !== true && (rec.expiresAt === undefined || rec.expiresAt > Date.now() + REFRESH_SKEW_MS)) {
    return { status: "authorized" };
  }
  dropAttemptsFor(k);
  const attempt: Attempt = { key: k, state: randomBytes(32).toString("base64url"), redirectUrl, createdAt: Date.now(), gen: genOf(k) };
  // 옛 토큰으로 갱신을 시도하지 않는다 — 사용자가 로그인을 시작했다(갱신은 `mcpAccessToken` 몫).
  // ★다시 등록한 클라이언트는 **로그인을 마칠 때** 저장한다 — 지금 기록에 넣으면 옛 클라이언트가 발급한 refresh 와 짝이 어긋나, 이 로그인을
  //  버리면 다음 갱신이 새 client_id 로 나가 거절된다(재검토 10-18). 그때까지는 시도에 둔다.
  const work: StoredRecord = reRegister ? { ...rec, client: undefined } : rec;
  const result = await auth(providerFor(work, { redirectUrl, attempt, ignoreTokens: true }), { serverUrl: k.url, ...(fetchFn !== undefined ? { fetchFn } : {}) });
  if (result !== "REDIRECT" || attempt.authorizationUrl === undefined) {
    throw new Error("mcp-oauth: the server did not start an authorization flow");
  }
  // 준비하는 사이에 서버가 지워졌으면 아무것도 남기지 않는다(기록·시도 게시 전 — 아스트라 10-19).
  if (attempt.gen !== genOf(k)) throw new Error("mcp-oauth: the server was removed while the sign-in was being prepared");
  if (reRegister) attempt.client = work.client;
  else await writeRecord(k, rec); // 동적 등록한 클라이언트·탐색 결과
  attempts.set(attempt.state, attempt);
  return { status: "redirect", url: attempt.authorizationUrl, expiresInMs: MCP_OAUTH_ATTEMPT_TTL_MS };
};

/** 붙여넣은 주소 또는 콜백 쿼리에서 code·state — **기대하는 콜백 주소일 때만**(엉뚱한 URL 은 파싱하지 않는다). 그 주소로 요청을 보내지 않는다. */
export const parseMcpOAuthRedirect = (raw: string): { code: string; state: string } | null => {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.pathname !== MCP_OAUTH_CALLBACK_PATH) return null;
  const code = u.searchParams.get("code");
  const state = u.searchParams.get("state");
  return code !== null && code !== "" && state !== null && state !== "" ? { code, state } : null;
};

/** 실패 이유 → 사용자 문구(명령 답·콜백 화면 공용). 키를 그대로 적는다 — 번역 카탈로그 검사가 쓰임을 본다. */
export const mcpLoginReasonText = (reason: Exclude<McpLoginCompletion, { ok: true }>["reason"]): string =>
  reason === "unknown-or-used" ? translate("srv.mcpLogin.reason.unknownOrUsed")
    : reason === "expired" ? translate("srv.mcpLogin.reason.expired")
    : reason === "stale" ? translate("srv.mcpLogin.reason.stale")
    : reason === "denied" ? translate("srv.mcpLogin.reason.denied")
    : translate("srv.mcpLogin.reason.exchangeFailed");

export type McpLoginCompletion =
  | { ok: true; name: string }
  | { ok: false; reason: "unknown-or-used" | "expired" | "stale" | "denied" | "exchange-failed" };

/**
 * 로그인 완료 — 콜백·붙여넣기 공통 종착점. state 는 **한 번만** 쓴다(자동 콜백과 붙여넣기가 겹쳐도 교환은 한 번). 시작 뒤 서버가 지워졌으면 저장하지 않는다.
 * ★실패 이유는 이름만 — 공급자가 준 오류 설명은 code 를 되비출 수 있어 싣지 않는다.
 */
export const completeMcpLogin = async (
  input: { state: string; code?: string; error?: string },
  fetchFn?: typeof fetch,
): Promise<McpLoginCompletion> => {
  const attempt = attempts.get(input.state);
  if (attempt === undefined) return { ok: false, reason: "unknown-or-used" };
  attempts.delete(input.state); // 점유 — 두 번째 도착은 «이미 씀».
  if (Date.now() - attempt.createdAt > MCP_OAUTH_ATTEMPT_TTL_MS) return { ok: false, reason: "expired" };
  if (attempt.gen !== genOf(attempt.key)) return { ok: false, reason: "stale" };
  if (input.error !== undefined || input.code === undefined || input.code === "") return { ok: false, reason: "denied" };
  const rec: StoredRecord = (await readRecord(attempt.key)) ?? { file: path.resolve(attempt.key.file), name: attempt.key.name, url: attempt.key.url };
  if (attempt.client !== undefined) rec.client = attempt.client;
  try {
    const r = await auth(providerFor(rec, { redirectUrl: attempt.redirectUrl, attempt }), {
      serverUrl: attempt.key.url,
      authorizationCode: input.code,
      ...(fetchFn !== undefined ? { fetchFn } : {}),
    });
    if (r !== "AUTHORIZED" || rec.tokens === undefined) return { ok: false, reason: "exchange-failed" };
  } catch {
    return { ok: false, reason: "exchange-failed" };
  }
  if (attempt.gen !== genOf(attempt.key)) return { ok: false, reason: "stale" }; // 교환하는 사이에 지워졌다.
  await writeRecord(attempt.key, rec);
  return { ok: true, name: attempt.key.name };
};

/** 붙여넣기 완료 명령 — 채널 입구(`src/index.ts`)가 모델로 보내지 않고 이것만 부른다. 답에는 서버 이름·결과 이름만. */
export const MCP_LOGIN_COMMAND = "/mcp_login";
export const runMcpLoginCommand = async (text: string): Promise<string> => {
  const parsed = parseMcpOAuthRedirect(text.trim().slice(MCP_LOGIN_COMMAND.length).trim());
  if (parsed === null) return translate("srv.mcpLogin.usage");
  const r = await completeMcpLogin(parsed).catch((): McpLoginCompletion => ({ ok: false, reason: "exchange-failed" }));
  return r.ok ? translate("srv.mcpLogin.done", { name: r.name }) : translate("srv.mcpLogin.failed", { reason: mcpLoginReasonText(r.reason) });
};

/** 진행 중 갱신 — 대상당 하나. */
const refreshing = new Map<string, Promise<string | undefined>>();

/**
 * 저장 값이 **다른 인가 서버**에 묶여 있나 — SDK `auth()` 의 발급 서버 묶음(1.32, `issuer` 표식)을 우리 갱신 경로에도 그대로 건다.
 *  표식이 없으면(옛 판이 저장한 것) 묶이지 않은 것으로 본다 — SDK 와 같이 처음 받아 준 서버에 묶는다. 비교는 URL 로 읽어(표기 차이 무시)
 *  끝 `/` 하나 차이를 허용한다. ★SDK 의 `issuersMatch` 를 옮겨 적은 두 번째 자리다 — SDK 가 내보내지 않아서다(SDK 를 올리면 같이 본다).
 */
const boundElsewhere = (stamp: unknown, issuer: string): boolean => {
  if (typeof stamp !== "string") return false;
  let [x, y] = [stamp, issuer];
  try {
    [x, y] = [new URL(stamp).href, new URL(issuer).href];
  } catch {
    /* URL 이 아니면 적힌 그대로 비교 */
  }
  return !(x === y || (x.endsWith("/") && x.slice(0, -1) === y) || (y.endsWith("/") && y.slice(0, -1) === x));
};

/** 갱신 요청에 시한을 건다 — 호출부 신호가 있으면 둘 중 먼저. */
const timedFetch = (f: typeof fetch): typeof fetch => (u, init) => {
  const t = AbortSignal.timeout(REFRESH_FETCH_TIMEOUT_MS);
  return f(u, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, t]) : t });
};
/** 최대 `ms` 기다린다 — 넘기거나 실패하면 `fallback()`. 작업은 끊지 않는다(뒤에서 마저 끝나 다음 읽기가 쓴다). */
const waitAtMost = <T>(p: Promise<T>, ms: number, fallback: () => T): Promise<T> =>
  new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback()), ms);
    timer.unref?.();
    p.then(
      (v) => (clearTimeout(timer), resolve(v)),
      () => (clearTimeout(timer), resolve(fallback())),
    );
  });

/**
 * 갱신 한 번 — 대상당 하나만 돈다. ★레코드를 **작업 안에서** 다시 읽는다: 밖에서 읽은 사본은 직전 갱신이 끝나기 전 것일 수 있고, 그 사본의
 *  (이미 회전된) refresh 토큰으로 두 번째 갱신을 하면 invalid_grant → 로그인이 풀렸다(적대 검토 P2-2 — 30회 중 1회 재현).
 */
const startRefresh = (k: McpOAuthKey, fetchFn: typeof fetch | undefined): Promise<string | undefined> => {
  const h = keyHash(k);
  const job = (async (): Promise<string | undefined> => {
    const gen0 = genOf(k);
    const rec = await readRecord(k);
    if (rec?.tokens === undefined || rec.loginNeeded === true) return undefined;
    const forced = forceRefresh.get(h) === rec.tokens.access_token;
    if (!forced && (rec.expiresAt === undefined || rec.expiresAt > Date.now() + REFRESH_SKEW_MS)) return rec.tokens.access_token;
    const stillValid = (): string | undefined =>
      !forced && rec.tokens !== undefined && rec.expiresAt !== undefined && rec.expiresAt > Date.now() ? rec.tokens.access_token : undefined;
    if (rec.tokens.refresh_token === undefined || rec.client === undefined) {
      if (stillValid() !== undefined) return stillValid();
      if (gen0 === genOf(k)) await markMcpLoginNeeded(k, gen0);
      return undefined;
    }
    const f = timedFetch(fetchFn ?? fetch);
    try {
      const info = rec.discovery?.authorizationServerUrl !== undefined
        ? { authorizationServerUrl: rec.discovery.authorizationServerUrl, authorizationServerMetadata: rec.discovery.authorizationServerMetadata, resourceMetadata: rec.discovery.resourceMetadata }
        : await discoverOAuthServerInfo(k.url, { fetchFn: f });
      // ★발급 서버 묶음 — 다른 인가 서버에 찍힌 refresh 토큰·클라이언트는 이 서버에 보내지 않는다(SDK `auth()` 와 같은 규칙). 다시 로그인한다.
      //  없을 때: SDK 1.32 가 로그인 때 찍은 `issuer` 를 첫 자체 갱신이 지웠고(전체 교체 저장), 탐색이 다른 서버를 가리켜도 그대로 보냈다(GPT 검토 10-25).
      const issuer = String(info.authorizationServerUrl);
      if (boundElsewhere(rec.tokens.issuer, issuer) || boundElsewhere(rec.client.issuer, issuer)) {
        forceRefresh.delete(h);
        if (gen0 === genOf(k)) await markMcpLoginNeeded(k, gen0);
        console.warn(`mcp-oauth: '${k.name}' 저장된 인증이 다른 인가 서버에 묶여 있어 갱신하지 않음 — 다시 로그인이 필요합니다.`);
        return undefined;
      }
      const provider = providerFor(rec, {});
      const resource = await selectResourceURL(k.url, provider, info.resourceMetadata);
      const fresh = await refreshAuthorization(info.authorizationServerUrl, {
        metadata: info.authorizationServerMetadata,
        clientInformation: rec.client,
        refreshToken: rec.tokens.refresh_token,
        ...(resource !== undefined ? { resource } : {}),
        fetchFn: f,
      });
      provider.saveTokens({ ...fresh, issuer });
      if (typeof rec.client.issuer !== "string") rec.client = { ...rec.client, issuer }; // 옛 기록 — 받아 준 이 서버에 묶는다(SDK `bindClientInformation`)
      refreshFailedAt.delete(h);
      forceRefresh.delete(h);
      if (forced) forcedToken.set(h, fresh.access_token);
      else forcedToken.delete(h);
      if (gen0 !== genOf(k)) return undefined; // 갱신하는 사이에 지워졌다 — 되살리지 않는다.
      await writeRecord(k, rec);
      return fresh.access_token;
    } catch (e) {
      if (e instanceof OAuthError && !(e instanceof ServerError)) {
        // 공급자가 거절했다(잘못된 grant·클라이언트 등) — 다시 로그인해야 한다.
        forceRefresh.delete(h);
        rec.tokens = undefined;
        rec.expiresAt = undefined;
        rec.loginNeeded = true;
        if (gen0 === genOf(k)) await writeRecord(k, rec);
        console.warn(`mcp-oauth: '${k.name}' 토큰 갱신이 거절됨 — 다시 로그인이 필요합니다(${e.name}).`);
        return undefined;
      }
      // 일시 실패 — 아직 만료 전이면 그대로 쓴다. 잠시 뒤(`REFRESH_RETRY_AFTER_MS`) 다시 갱신한다.
      refreshFailedAt.set(h, Date.now());
      console.warn(`mcp-oauth: '${k.name}' 토큰 갱신 일시 실패 — ${e instanceof Error ? e.name : "error"} (${REFRESH_RETRY_AFTER_MS / 1000}초 뒤 다시 시도)`);
      return stillValid();
    }
  })().finally(() => refreshing.delete(h));
  refreshing.set(h, job);
  return job;
};

/**
 * 설정에 합성할 액세스 토큰 — 없으면 undefined(헤더를 안 붙인다). 만료가 가깝거나 401 을 받았으면 갱신한다(대상당 한 번에 하나).
 * 갱신이 거절되면(잘못된 grant 등) «로그인 필요» 로 적고 undefined · 일시 실패(네트워크·서버 오류·시한)면 아직 안 만료된 토큰은 그대로 쓴다.
 * ★턴은 갱신을 `REFRESH_WAIT_MS` 까지만 기다린다.
 */
export const mcpAccessToken = async (k: McpOAuthKey, fetchFn?: typeof fetch): Promise<string | undefined> => {
  const h = keyHash(k);
  const rec = await readRecord(k);
  if (rec?.tokens === undefined || rec.loginNeeded === true) return undefined;
  const forced = forceRefresh.get(h) === rec.tokens.access_token;
  if (!forced && (rec.expiresAt === undefined || rec.expiresAt > Date.now() + REFRESH_SKEW_MS)) return rec.tokens.access_token;
  const validNow = (): string | undefined =>
    !forced && rec.tokens !== undefined && rec.expiresAt !== undefined && rec.expiresAt > Date.now() ? rec.tokens.access_token : undefined;
  const failedAt = refreshFailedAt.get(h);
  if (!refreshing.has(h) && failedAt !== undefined && Date.now() - failedAt < REFRESH_RETRY_AFTER_MS) return validNow();
  return waitAtMost(refreshing.get(h) ?? startRefresh(k, fetchFn), REFRESH_WAIT_MS, validNow);
};

/** 서버 제거·로그아웃 — 그 파일·이름의 모든 레코드(URL 무관)를 로컬에서 지우고 세대를 올린다. ★공급자 쪽 토큰 폐기(revocation)는 하지 않는다. */
export const forgetMcpOAuth = async (file: string, name: string): Promise<number> => {
  const abs = path.resolve(file);
  // 기록이 없어도 — 진행 중인 로그인 준비까지 무효화한다(위 `nameGenerations` 주석).
  nameGenerations.set(nameKey(file, name), (nameGenerations.get(nameKey(file, name)) ?? 0) + 1);
  let removed = 0;
  let entries: string[] = [];
  try {
    entries = await fs.readdir(storeDir());
  } catch {
    return 0;
  }
  for (const f of entries) {
    if (!f.endsWith(".json")) continue;
    try {
      const r = JSON.parse(await fs.readFile(path.join(storeDir(), f), "utf8")) as StoredRecord;
      if (path.resolve(r.file) !== abs || r.name !== name) continue;
      const k = { file: r.file, name: r.name, url: r.url };
      generations.set(keyHash(k), (generations.get(keyHash(k)) ?? 0) + 1);
      for (const m of [forceRefresh, forcedToken, refreshFailedAt]) m.delete(keyHash(k));
      dropAttemptsFor(k);
      await fs.rm(path.join(storeDir(), f), { force: true });
      removed += 1;
    } catch {
      /* 깨진 레코드 — 건너뛴다 */
    }
  }
  return removed;
};

/** 사용자가 인증 헤더를 직접 줬나(대소문자 무관) — 줬으면 OAuth 를 타지 않는다(사용자가 정한 인증이 우선). 일반 헤더만 있으면 해당 없음. */
export const hasUserAuthorization = (headers: Record<string, string> | undefined): boolean =>
  headers !== undefined && Object.keys(headers).some((h) => h.toLowerCase() === "authorization");
