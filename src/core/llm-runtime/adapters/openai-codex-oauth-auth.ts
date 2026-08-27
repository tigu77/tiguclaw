/**
 * OpenAI Codex backend — OAuth / 토큰 라이프사이클 서브모듈.
 *
 * ★순수 구조 분해 (2026-07-16): openai-codex-oauth.ts 에서 로직 변경 0 으로 이동만.
 * 진실 소스·설계 근거는 메인 파일(openai-codex-oauth.ts) 헤더 주석 참조.
 * 공개 표면은 메인 파일의 배럴 re-export 로 보존된다.
 */
import { generatePKCE as generatePkceUpstream } from "@openauthjs/openauth/pkce";
import { upsertHomeEnvVars } from "../../env-file.js";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { homeEnvPath } from "../../load-env.js";
import type { AuthProvider } from "../auth-registry.js";

// OAuth 상수 — fork (numman-ali/opencode-openai-codex-auth) 의 lib/auth/auth.ts 답습.
// codex_cli_rs originator + chatgpt.com/backend-api = Codex 비공식 endpoint 활성화.
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const REDIRECT_URI = "http://localhost:1455/auth/callback";
const SCOPE = "openid profile email offline_access";

/**
 * 취소 가능한 대기. ★signal 을 안 받던 시절 백오프 총합 27초 동안 `/stop`·턴 타임아웃이
 * 먹히지 않았다 — 사용자가 멈추라고 한 뒤에도 죽은 백엔드에 계속 재전송했다.
 * abort 시 **reject 하지 않고 조기 resolve** 한다 — 호출부는 곧바로 자기 abort 검사에
 * 걸려 정상 경로로 빠져나간다(대기 지점마다 try/catch 를 심을 필요가 없다).
 */
export const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    const finish = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
  });

export interface PKCEPair {
  verifier: string;
  challenge: string;
}

export interface AuthorizationFlow {
  pkce: PKCEPair;
  state: string;
  url: string;
}

export interface OAuthTokens {
  access: string;
  refresh: string;
  expires: number;
}

interface JWTPayload {
  "https://api.openai.com/auth"?: {
    chatgpt_account_id?: string;
  };
  [k: string]: unknown;
}

export const generatePKCE = async (): Promise<PKCEPair> => {
  const up = (await generatePkceUpstream()) as {
    verifier: string;
    challenge: string;
  };
  return { verifier: up.verifier, challenge: up.challenge };
};

export const createAuthorizationFlow = async (): Promise<AuthorizationFlow> => {
  const pkce = await generatePKCE();
  const state = randomBytes(16).toString("hex");

  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("code_challenge", pkce.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("originator", "codex_cli_rs");

  return { pkce, state, url: url.toString() };
};

export const exchangeAuthorizationCode = async (
  code: string,
  verifier: string,
): Promise<OAuthTokens> => {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
    }),
  });
  if (!res.ok) {
    throw new Error(
      `OAuth code exchange failed: ${res.status} ${await res.text().catch(() => "")}`,
    );
  }
  const json = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (
    !json.access_token ||
    !json.refresh_token ||
    typeof json.expires_in !== "number"
  ) {
    throw new Error("OAuth token response missing required fields.");
  }
  return {
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + json.expires_in * 1000,
  };
};

// V3.1 = 정적 시그니처만 (라이브 호출 0). V3.2 라이브 검증 후속.
export const refreshAccessToken = async (
  refreshToken: string,
): Promise<OAuthTokens> => {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }),
  });
  if (!res.ok) {
    throw new Error(
      `OAuth token refresh failed: ${res.status} ${await res.text().catch(() => "")}`,
    );
  }
  const json = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (
    !json.access_token ||
    !json.refresh_token ||
    typeof json.expires_in !== "number"
  ) {
    throw new Error("OAuth refresh response missing required fields.");
  }
  return {
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + json.expires_in * 1000,
  };
};

const decodeJWT = (token: string): JWTPayload | null => {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = Buffer.from(parts[1] as string, "base64").toString("utf8");
    return JSON.parse(payload) as JWTPayload;
  } catch {
    return null;
  }
};

export const extractAccountId = (accessToken: string): string | undefined => {
  const decoded = decodeJWT(accessToken);
  return decoded?.["https://api.openai.com/auth"]?.chatgpt_account_id;
};

// V3.3 — .env 자동 upsert 헬퍼 (CLI · 자동 refresh 공유).
// `<home>/.env` 의 OPENAI_CODEX_OAUTH_{TOKEN,REFRESH,EXPIRES} 3 키 in-place 갱신.
// 기존 다른 키 유지, 부재 시 append.
// ★홈 .env 에 쓴다(레포 오염 방지) — load-env 의 `homeEnvPath()` 와 동일 정본.
//   과거 `path.resolve(".env")`=cwd(레포) 라 codex 토큰 갱신이 공개 레포를 더럽혔음(수정).
// V5 — doctor 가 codex 토큰 키를 하드코딩 중복 없이 재사용하도록 export.
export const TOKEN_KEYS = [
  "OPENAI_CODEX_OAUTH_TOKEN",
  "OPENAI_CODEX_OAUTH_REFRESH",
  "OPENAI_CODEX_OAUTH_EXPIRES",
] as const;

/**
 * /status 개편 — codex OAuth access token 만료 시각(epoch ms). 미설정/파싱불가 →
 * undefined. /status 가 만료 임박(<2일) 경고 표시용. 순수 함수 — env 진실 소스
 * (DB 아님). refresh 는 ensureFreshAccessToken 책임 — 여기선 표시만 (refresh 무관).
 */
export const getCodexTokenExpiry = (): number | undefined => {
  const raw = process.env.OPENAI_CODEX_OAUTH_EXPIRES;
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
};

export const upsertCodexTokens = async (tokens: OAuthTokens): Promise<void> => {
  // ★쓰기 규칙(ENOENT 만 신규 · 원자적 rename · 0600 유지 · in-memory 먼저)은 전부
  //  `core/env-file.ts` 로 옮겼다 (2026-08-27). `claude-auth` 가 같은 걸 필요로 했는데,
  //  베끼면 다음 사고 때 한쪽만 고쳐진다 — 이 함수들은 전부 실사고에서 나온 것이다.
  await upsertHomeEnvVars({
    OPENAI_CODEX_OAUTH_TOKEN: tokens.access,
    OPENAI_CODEX_OAUTH_REFRESH: tokens.refresh,
    OPENAI_CODEX_OAUTH_EXPIRES: String(tokens.expires),
  });
};

// V3.3 — token 자동 refresh. 만료 임박(5분 이내) 시 refresh 호출 + .env 갱신.
// 호출 후 새 access token 반환. refresh token 부재 또는 refresh 실패 시 throw.
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

const isExpiringSoon = (expiresEnv: string | undefined): boolean => {
  if (expiresEnv === undefined || expiresEnv === "") return false;
  const expires = Number(expiresEnv);
  if (!Number.isFinite(expires)) return false;
  return Date.now() >= expires - REFRESH_BUFFER_MS;
};

/**
 * **codex 인증돼 있나 — 네트워크 없이 동기 판정** (2026-08-13).
 *
 * ★access 토큰 하나만 보면 안 된다: 이 어댑터는 access 가 비었거나 만료돼도
 *  **refresh 토큰만 있으면 살아난다**(아래 `ensureFreshAccessToken` 이 새로 받아온다).
 *  그래서 인증 여부는 `access || refresh` 다 — access 만 보는 판정은 refresh 로 오래
 *  굴러온 설치를 "인증 없음" 으로 오판하고, 그 사용자에게만 codex 가 조용히 빠진다.
 *  (claude 구독 사용자가 `ANTHROPIC_API_KEY` 만 보는 판정에서 빠지던 것과 같은 부류.)
 *
 * ★`ensureFreshAccessToken` 의 throw 조건이 **이 함수의 부정**이다 — 두 벌이 되지 않게
 *  거기서도 이걸 부른다. "가용" 이라 해놓고 실행이 던지면 풀에 넣은 의미가 없다.
 */
export const codexAuthAvailable = (): boolean =>
  (process.env.OPENAI_CODEX_OAUTH_TOKEN ?? "") !== "" ||
  (process.env.OPENAI_CODEX_OAUTH_REFRESH ?? "") !== "";

export const ensureFreshAccessToken = async (): Promise<string> => {
  const currentAccess = process.env.OPENAI_CODEX_OAUTH_TOKEN;
  const expiresEnv = process.env.OPENAI_CODEX_OAUTH_EXPIRES;

  if (currentAccess !== undefined && currentAccess !== "" && !isExpiringSoon(expiresEnv)) {
    return currentAccess;
  }

  if (!codexAuthAvailable()) {
    throw new Error(
      "OpenAI Codex OAuth 토큰 없음. `npm run codex-auth` 로 발급 필요.",
    );
  }
  const refresh = process.env.OPENAI_CODEX_OAUTH_REFRESH;
  if (refresh === undefined || refresh === "") {
    // access 는 있는데 refresh 가 없다 — 갱신은 못 하지만 지금 것으로는 돈다.
    return currentAccess as string;
  }

  const refreshed = await refreshAccessToken(refresh);
  await upsertCodexTokens(refreshed);
  return refreshed.access;
};

// ★auth-provider 심(2026-07-18) — codex 를 Tier 2(라이브-리프레시 구독) auth-provider 로
// 얇게 어댑팅. 로직 변경 0: 기존 ensureFreshAccessToken 에 그대로 위임(refresh·PKCE·만료·
// 토큰저장은 이미 그 함수 뒤 은닉). provider id "codex" = 이 어댑터 자기 정체성(계약 §2, §0
// 불변식 대상 아님). 실제 등록은 side-effect 모듈 auth-providers.ts(=Business EXCLUDE 단위).
export const codexAuthProvider: AuthProvider = {
  provider: "codex",
  getAccessToken: ensureFreshAccessToken,
  // ★"쓸 수 있나" 를 provider 가 직접 답한다 — 호출자가 env 이름을 조합하면 그 판정이
  //  두 벌이 되고, refresh 만 남은 설치가 한쪽에서만 빠진다(auth-registry 헤더 참조).
  isAuthenticated: codexAuthAvailable,
};
