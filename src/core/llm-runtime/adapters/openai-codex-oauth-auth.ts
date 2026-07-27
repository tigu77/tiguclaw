/**
 * OpenAI Codex backend — OAuth / 토큰 라이프사이클 서브모듈.
 *
 * ★순수 구조 분해 (2026-07-16): openai-codex-oauth.ts 에서 로직 변경 0 으로 이동만.
 * 진실 소스·설계 근거는 메인 파일(openai-codex-oauth.ts) 헤더 주석 참조.
 * 공개 표면은 메인 파일의 배럴 re-export 로 보존된다.
 */
import { generatePKCE as generatePkceUpstream } from "@openauthjs/openauth/pkce";
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

export const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

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
  // in-memory 먼저 — 파일 write 성패와 무관하게 현재 turn 이 새 토큰을 즉시 사용한다.
  process.env.OPENAI_CODEX_OAUTH_TOKEN = tokens.access;
  process.env.OPENAI_CODEX_OAUTH_REFRESH = tokens.refresh;
  process.env.OPENAI_CODEX_OAUTH_EXPIRES = String(tokens.expires);

  const ENV_PATH = homeEnvPath(); // ★홈 .env (레포 아님) — 매 호출 신선 해석.
  let body = "";
  try {
    body = await fs.readFile(ENV_PATH, "utf8");
  } catch (err) {
    // ★ENOENT(진짜 부재)만 "새로 작성". 그 외 읽기 실패(일시적 EBUSY·업데이트 중 파일
    //  교체 레이스 등)를 "부재"로 오인하면 body="" → OAuth 3키만 write → 기존 다른 키
    //  (TELEGRAM_BOT_TOKEN·HTTP_BRIDGE_TOKEN 등) 전부 소멸(데이터 손실 사고). 부재가
    //  아니면 clobber 방지 위해 파일 갱신을 건너뛴다(process.env 는 위에서 이미 갱신됨).
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      console.error(
        `[codex] upsertCodexTokens: .env 읽기 실패(${String(err)}) at ${ENV_PATH} — ` +
          `기존 .env clobber 방지 위해 파일 갱신 skip (process.env 는 갱신됨).`,
      );
      return;
    }
    // ENOENT — 진짜 부재, 새로 작성 OK.
  }
  const updates: Record<string, string> = {
    OPENAI_CODEX_OAUTH_TOKEN: tokens.access,
    OPENAI_CODEX_OAUTH_REFRESH: tokens.refresh,
    OPENAI_CODEX_OAUTH_EXPIRES: String(tokens.expires),
  };
  const lines = body === "" ? [] : body.split("\n");
  const seen = new Set<string>();
  const next = lines.map((line) => {
    const match = line.match(/^(OPENAI_CODEX_OAUTH_\w+)=/);
    if (match !== null) {
      const key = match[1]!;
      if (updates[key] !== undefined) {
        seen.add(key);
        return `${key}=${updates[key]}`;
      }
    }
    return line;
  });
  for (const key of TOKEN_KEYS) {
    if (!seen.has(key)) next.push(`${key}=${updates[key]}`);
  }
  const out = next.join("\n");
  const finalBody = out.endsWith("\n") ? out : `${out}\n`;
  // ★원자적 write — temp 파일에 쓰고 rename. 재작성 도중 프로세스가 죽어도(업데이트
  //  stop·crash) 기존 .env 가 truncate 되지 않는다(rename 은 원자적). in-memory 동기화는
  //  함수 상단에서 이미 완료.
  const tmp = `${ENV_PATH}.tmp-${process.pid}`;
  // ★0600 유지 (2026-07-28) — mode 미지정이면 tmp 가 0644 로 생기고 rename 이 그 퍼미션을
  //  가져간다. 사용자가 chmod 600 해도 **다음 토큰 refresh 때 0644 로 되돌아가는** 루프였다.
  await fs.writeFile(tmp, finalBody, { encoding: "utf8", mode: 0o600 });
  await fs.rename(tmp, ENV_PATH);
  // 기존 파일이 이미 느슨하면 승격(신규는 위 mode 로 충분 — 이건 구 설치본 치유).
  await fs.chmod(ENV_PATH, 0o600).catch(() => {});
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

export const ensureFreshAccessToken = async (): Promise<string> => {
  const currentAccess = process.env.OPENAI_CODEX_OAUTH_TOKEN;
  const expiresEnv = process.env.OPENAI_CODEX_OAUTH_EXPIRES;

  if (currentAccess !== undefined && currentAccess !== "" && !isExpiringSoon(expiresEnv)) {
    return currentAccess;
  }

  const refresh = process.env.OPENAI_CODEX_OAUTH_REFRESH;
  if (refresh === undefined || refresh === "") {
    // refresh token 0 + access 만료 — 사용자 재인증 필요.
    if (currentAccess !== undefined && currentAccess !== "") return currentAccess;
    throw new Error(
      "OpenAI Codex OAuth 토큰 없음. `npm run codex-auth` 로 발급 필요.",
    );
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
};
