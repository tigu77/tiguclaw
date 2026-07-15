/**
 * 영역 A 세 번째 어댑터 — OpenAI Codex backend (ChatGPT OAuth).
 *
 * 진실 소스:
 *  - `_workspace/region_a_v31_oauth_architect_contract.md` §4 (V3.1 OAuth flow)
 *  - `_workspace/codex_strengthening_v51prime_architect_contract.md` (V5.1' 강화 —
 *    OpenClaw payload 답습 + V3.3 raw fetch 복원 + input 누적 세션 재개)
 *
 * V5.1' 강화 (2026-05-23):
 *  - V5.1 의 `@openai/agents` SDK 위임 폐기 — raw fetch + SSE 본체 V3.3 답습.
 *  - payload 6 필드만 (`{model, instructions, input, stream:true, store:false,
 *    prompt_cache_key}`). 금지 필드 (text·prompt_cache_retention·context_management·
 *    parallel_tool_calls·tool_choice·truncation·max_output_tokens) 박지 않음.
 *  - `previous_response_id` 폐기 → `input` 배열에 prior user/assistant 누적으로 세션 재개.
 *  - `prompt_cache_key: input.threadKey` (stable per-thread, OpenAI prefix cache hit).
 *  - SSE parser 의 `response.completed` event 에서 `response.id` 추출 → sessionId 매핑.
 *  - SYSTEM_PROMPT 인라인 (claude 어댑터 동일 본문, 단일 인격 보존) — carry-over.
 *  - AGENT.md / memory index / context snippet user prompt prepend — carry-over.
 *  - `codex-${response.id}` prefix sid + V3 hex sid 가드 (`resp_` prefix) — carry-over.
 *  - `_mcp-bridge.ts` 보존 (V5.2+ 도구 통합용 — import 만 제거).
 *
 * OpenClaw 참조 (사용자 명시 영구 원칙):
 *  - `openai-transport-stream.ts` L802-828 `buildOpenAIResponsesParams` — payload 본체
 *  - `openai-transport-stream.ts` L822-826 — `model / input / stream / prompt_cache_key`
 *  - `openai-responses-payload-policy.ts` L109-119 — `storeMode:"disable"` 분기 → store:false
 *  - `openai-codex-provider.ts` L44 — `OPENAI_CODEX_BASE_URL`
 *
 * 위험 layer (V3.1 4 layer + V5.1' 갱신):
 *  (1) ToS 회색지대 — personal use only, multi-user/production 미보장.
 *  (2) 비공식 endpoint 깨짐 — backend 정책 변화 시 즉시 영향. OpenClaw 정합으로 완화.
 *  (3) token 만료 — V3.3 auto refresh 박힘.
 *  (4) V4.0 어댑터 풀 폴백 — claude 어댑터 자동 합류.
 *  (5) store:false (V5.1 의 store:true 폐기) — OpenAI 서버 저장 0, 클라이언트 측 누적.
 *
 * 라이선스 정합:
 *  - `@openauthjs/openauth` MIT — PKCE 표준 위임.
 *  - 본 어댑터의 transform 층 (HTTP + JSON payload + SSE event 파싱) = 직접 구현
 *    (README §직접 만들 것 vs 라이브러리 의 "채널 어댑터" 면).
 */
import { generatePKCE as generatePkceUpstream } from "@openauthjs/openauth/pkce";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { homeEnvPath } from "../../load-env.js";
import {
  agentSizeWarning,
  readAgent,
  readSystem,
} from "../../identity.js";
import {
  assembleUserPrompt,
  buildSystemContextParts,
  formatAttachments,
  formatConversationContext,
  formatMemoryIndex,
  formatMemorySnippet,
  formatModelProfiles,
} from "../../prompt-assembly.js";
import { createMemoryMcpServer } from "../../memory-mcp.js";
import { retrieveContext } from "../../memory.js";
import { createFileOpsMcpServer } from "../capabilities/file-ops-mcp.js";
import { createTodoMcpServer } from "../capabilities/todo-mcp.js";
import {
  createSkillInvokeMcpServer,
  discoverSkills,
  formatSkillIndex,
} from "../capabilities/skill-registry.js";
import {
  createSpawnAgentMcpServer,
  discoverAgents,
  formatAgentIndex,
} from "../capabilities/agent-registry.js";
import { createWorkerMcpServer } from "../capabilities/worker-registry.js";
import { createEndpointToolsMcpServer } from "../capabilities/endpoint-tools-mcp.js";
import { createCommandToolsMcpServer } from "../capabilities/command-tools-mcp.js";
import { createMcpAdminMcpServer } from "../capabilities/mcp-admin-mcp.js";
import { getConnectedExternalMcpBridges, isProjectMcpCwd } from "../../external-mcp.js";
import { createUpdateSelfMcpServer } from "../capabilities/update-self-mcp.js";
import { createMaintenanceMcpServer } from "../capabilities/maintenance-mcp.js";
import { notifyDestFromCoords } from "../../self-update.js";
import { createReplyIntentMcpServer } from "../capabilities/reply-intent-mcp.js";
import { createSendFileMcpServer } from "../capabilities/send-file-mcp.js";
import { createPromptOptionsMcpServer } from "../capabilities/prompt-options-mcp.js";
import { createProjectRegistryMcpServer } from "../capabilities/project-registry.js";
import { createFindCapabilitiesMcpServer } from "../capabilities/find-capabilities-mcp.js";
import {
  loadThreadHistoryWithIds,
  type CodexTurn,
  type CodexTurnWithId,
} from "../../../store/memory.js";
import {
  getThreadSummary,
  upsertThreadSummary,
} from "../../../store/thread-summaries.js";
import { getPaths } from "../../paths.js";
import { getEventBus } from "../../eventbus.js";
import { stripInternalRuntimeScaffolding } from "../../outbound-sanitize.js";
import type {
  RegionAActivityPayload,
  RegionASdkInput,
  RegionASdkOutput,
} from "../types.js";
import { REGION_A_SYSTEM_PROMPT as SYSTEM_PROMPT } from "./_shared-sysprompt.js";
import { adaptClaudeMcpServer } from "./_mcp-bridge.js";
import { buildActivityDetailFromJson } from "./_activity-detail.js";
import { buildActivityDiffFromJson } from "./_activity-diff.js";
import { buildActivityOutput } from "./_activity-output.js";
import { createDeltaStream } from "./_delta-stream.js";
import { createIdleTimer, IdleTimeoutError } from "../idle-timeout.js";
import { linkAbort, TurnTimeoutError } from "../turn-timeout.js";

// OAuth 상수 — fork (numman-ali/opencode-openai-codex-auth) 의 lib/auth/auth.ts 답습.
// codex_cli_rs originator + chatgpt.com/backend-api = Codex 비공식 endpoint 활성화.
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const REDIRECT_URI = "http://localhost:1455/auth/callback";
const SCOPE = "openid profile email offline_access";
const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
const CODEX_DEFAULT_MODEL = "gpt-5.5";

// fetch 전송 견고성 parity — claude/openai 어댑터는 SDK 내장 retry 가 있으나
// codex 는 raw fetch → transient 전송 실패(undici throw)·일시 backend 에러를
// 흡수해 불필요한 풀 폴백을 줄인다. transient 만 재시도(4xx 429 제외는 즉시 throw).
const CODEX_FETCH_MAX_RETRIES = 2;
const CODEX_FETCH_BACKOFF_MS = [500, 1500];
const RETRIABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

// codex 가 매 턴 재전송하는 thread 히스토리 윈도 (codex 의 1차 컨텍스트 기제).
// 2026-06-12 상향 40→150: gpt-5.5 윈도(400K)의 ~6%만 쓰던 과보수 캡 → "옛 맥락 잊음"
// 완화. ChatGPT 구독 백엔드라 토큰 과금 0(비용=레이턴시뿐). 150턴 ≈ 윈도 ~20%.
// ※ memory.ts 의 동명 export(40)와 *별개 노브* — 그건 claude foreign-delta 등의
//   default 라 claude(200K 윈도) 안전 위해 의도적으로 안 올림(작게 유지).
const CODEX_TURN_HISTORY_LIMIT = 150;

// turn count 위의 char cap — 단일 turn 이 비정상적으로 길 때 overflow 방지.
// 2026-06-12 상향 200K→700K (≈175k token 상한, 윈도 절반). 최신 turn 부터 누적,
// 초과 시 가장 오래된 turn drop. 보통 150턴 limit 가 먼저 binding (이건 안전 ceiling).
const CODEX_TURN_HISTORY_CHAR_CAP = 700_000;

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

const extractAccountId = (accessToken: string): string | undefined => {
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
  const ENV_PATH = homeEnvPath(); // ★홈 .env (레포 아님) — 매 호출 신선 해석.
  let body = "";
  try {
    body = await fs.readFile(ENV_PATH, "utf8");
  } catch {
    // .env 부재 — 새로 작성.
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
  await fs.writeFile(ENV_PATH, out.endsWith("\n") ? out : `${out}\n`, "utf8");

  // process.env in-memory 동기화 — 호출자(runOpenAiCodex 등) 가 같은 turn 안에서
  // 새 토큰 즉시 사용 가능.
  process.env.OPENAI_CODEX_OAUTH_TOKEN = tokens.access;
  process.env.OPENAI_CODEX_OAUTH_REFRESH = tokens.refresh;
  process.env.OPENAI_CODEX_OAUTH_EXPIRES = String(tokens.expires);
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

const ensureFreshAccessToken = async (): Promise<string> => {
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

/**
 * V5.1' — Codex Responses API SSE event 의 부분 타입.
 *
 * V3.3 본체의 `response.output_text.delta` event 누적 + `response.completed`
 * event 의 final fallback 외에, V5.1' 신규 — `response.completed` event 에서
 * `event.response.id` 추출 → sessionId 매핑.
 */
interface CodexSseEvent {
  type?: string;
  delta?: string;
  item?: {
    type?: string;
    id?: string;
    call_id?: string;
    name?: string;
    arguments?: string;
  };
  response?: {
    id?: string;
    output_text?: string;
    output?: Array<{
      content?: Array<{ text?: string; type?: string }>;
    }>;
    // V5.10 — prompt_cache_key 효과 메트릭 (OpenAI Responses API usage shape).
    usage?: {
      input_tokens?: number;
      input_tokens_details?: {
        cached_tokens?: number;
      };
      output_tokens?: number;
      total_tokens?: number;
    };
  };
}

/**
 * V5.3 신규 — function_call lifecycle 누적용 turn 상태.
 *
 * OpenClaw `openai-transport-stream.ts` L407-508 답습:
 *  - `response.output_item.added (item.type==="function_call")` — call 시작.
 *    `currentToolCall` 박음. id / call_id / name 회수.
 *  - `response.function_call_arguments.delta` — `partialJson` 누적.
 *  - `response.output_item.done (item.type==="function_call")` — call 종료.
 *    `pending` 배열에 push. turn 종료 후 agentic loop 가 callTool → 다음 turn input.
 *
 * V5.1' 의 `text` 누적 (assistant message) 본체 보존 — function_call 과 병행 진행.
 */
interface CodexToolCall {
  id: string | undefined; // function_call item id (e.g. `fc_...`)
  callId: string; // `call_id` — function_call_output 의 match key
  name: string;
  partialJson: string;
}

interface CodexSseResult {
  text: string;
  responseId: string | undefined;
  toolCalls: CodexToolCall[];
  /**
   * /status 개편 — 이 turn 의 토큰 사용량 (`response.completed` usage 에서 추출).
   * usage event 부재 시 미설정 (graceful).
   */
  // 2026-06-07 — reasoningTokens 추가 (빈 응답 진단용, optional. 일반 status 표시는 무영향).
  //  ChatGPT 백엔드의 reasoning.effort 가 텍스트 슬롯 잠식하는지 측정.
  usage?: { inputTokens: number; outputTokens: number; reasoningTokens?: number };
}

/**
 * V5.3 — SSE stream parser. V5.1' 본체 + function_call 3 분기 (OpenClaw L407-508).
 *
 * 반환:
 *  - text: accumulated assistant 응답 본문 (`response.output_text.delta` 누적)
 *  - responseId: `response.completed` event 의 `response.id`
 *  - toolCalls: 본 turn 안에서 lifecycle 완성된 function_call 들 (0 또는 N개)
 *
 * 비-JSON 라인 (heartbeat 등) 은 skip. `[DONE]` 시그널 도 skip.
 */
const parseCodexSse = async (
  body: ReadableStream<Uint8Array>,
  // 유휴 타임아웃 heartbeat — chunk 수신마다 호출(타이머 reset). 미지정 = no-op
  // (회귀 0 — 기존 호출부 호환). abort 시 reader.read() 가 reject → throw 전파.
  onChunk?: () => void,
  // llm.delta fan-out — output_text.delta 누적 시점마다 증분 텍스트 호출(onChunk 선례).
  // 미지정 = no-op(회귀 0). coalesce·publish 는 호출부 책임(파서 순수성 보존).
  onTextDelta?: (delta: string) => void,
  // 진전(progress) heartbeat — *실제 진전* 이벤트(output_text.delta·function_call 시작)
  // 에만 호출. no-progress 타이머 reset 용(in_progress heartbeat 는 진전 아님 → 미호출).
  // 미지정 = no-op(회귀 0).
  onProgress?: () => void,
): Promise<CodexSseResult> => {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let responseId: string | undefined;
  let usage:
    | { inputTokens: number; outputTokens: number; reasoningTokens?: number }
    | undefined;
  const toolCalls: CodexToolCall[] = [];
  let currentToolCall: CodexToolCall | null = null;
  const debugTools = process.env.CODEX_DEBUG_TOOLS === "1";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    // chunk 도착 = 살아있음 신호 → 타이머 reset (first→idle 전환).
    onChunk?.();
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const block of parts) {
      for (const line of block.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "" || data === "[DONE]") continue;
        try {
          const event = JSON.parse(data) as CodexSseEvent;
          // 진단(gated) — codex 백엔드가 흘리는 SSE event.type 실측용. "생각 중"에 어떤
          // 이벤트(reasoning delta vs 무이벤트 keep-alive)가 오는지 = progress-aware 가드
          // 가능성 판별. 기본 off (CODEX_DEBUG_TOOLS/INPUT 동형 gated 진단 인프라).
          if (process.env.CODEX_DEBUG_SSE === "1") {
            console.error(`[codex-sse] ${event.type}`);
          }
          // output_text.delta event 의 delta 누적 (표준 SSE 패턴).
          if (
            event.type === "response.output_text.delta" &&
            typeof event.delta === "string"
          ) {
            text += event.delta;
            // llm.delta fan-out — 순수 텍스트 증분만(누적본 아님). 호출부 coalescer 가
            // ~80ms∥120자로 묶어 publish. 미지정(onTextDelta===undefined)이면 no-op.
            onTextDelta?.(event.delta);
            onProgress?.(); // 실제 output = 진전 → no-progress 타이머 reset.
          }
          // V5.3 — function_call lifecycle 1 분기: output_item.added.
          // OpenClaw L407-418 답습 — partialJson 시작값 = item.arguments (대개 "").
          if (
            event.type === "response.output_item.added" &&
            event.item?.type === "function_call"
          ) {
            const callId = event.item.call_id ?? "";
            currentToolCall = {
              id: event.item.id,
              callId,
              name: event.item.name ?? "",
              partialJson: typeof event.item.arguments === "string" ? event.item.arguments : "",
            };
            onProgress?.(); // 도구 호출 시작 = 진전 → no-progress 타이머 reset.
            if (debugTools) {
              // ADR §6 (c) — Codex backend SSE event 라이브 입증용 1줄 로그.
              console.error(
                `[codex-oauth debug] sse event=${event.type} item.type=function_call name=${currentToolCall.name} call_id=${callId}`,
              );
            }
          }
          // V5.3 — function_call lifecycle 2 분기: arguments.delta 누적.
          // OpenClaw L439-449 답습 — partialJson string concat (parse 0, done 시점에서만).
          else if (
            event.type === "response.function_call_arguments.delta" &&
            currentToolCall !== null &&
            typeof event.delta === "string"
          ) {
            currentToolCall.partialJson += event.delta;
          }
          // V5.3 — function_call lifecycle 3 분기: output_item.done.
          // OpenClaw L491-507 답습 — partialJson final 확정 후 toolCalls 에 push.
          else if (
            event.type === "response.output_item.done" &&
            event.item?.type === "function_call" &&
            currentToolCall !== null
          ) {
            // OpenClaw: item.arguments 가 있으면 우선, 없으면 partialJson 사용.
            const finalJson =
              typeof event.item.arguments === "string" && event.item.arguments !== ""
                ? event.item.arguments
                : currentToolCall.partialJson;
            toolCalls.push({
              id: event.item.id ?? currentToolCall.id,
              callId: event.item.call_id ?? currentToolCall.callId,
              name: event.item.name ?? currentToolCall.name,
              partialJson: finalJson,
            });
            currentToolCall = null;
          }
          // response.completed — final output_text fallback + response.id 추출.
          if (event.type === "response.completed") {
            if (text === "" && typeof event.response?.output_text === "string") {
              text = event.response.output_text;
            }
            if (typeof event.response?.id === "string") {
              responseId = event.response.id;
            }
            // /status 개편 — usage 항상 캡처 (CODEX_DEBUG_USAGE gate 밖). 이미 받는
            // event 에서 추출 (추가 호출 0). usage 부재 시 미설정 (graceful).
            if (event.response?.usage) {
              const u = event.response.usage;
              // 2026-06-07 — reasoning_tokens 추출 (output_tokens_details 안에 있음).
              //  ChatGPT 백엔드 응답 shape: usage.output_tokens_details.reasoning_tokens.
              //  부재 시 undefined (graceful — 기존 호출자 무영향, fallback 진단에만 사용).
              const rt = (
                u as { output_tokens_details?: { reasoning_tokens?: number } }
              ).output_tokens_details?.reasoning_tokens;
              usage = {
                inputTokens: u.input_tokens ?? 0,
                outputTokens: u.output_tokens ?? 0,
                ...(typeof rt === "number" ? { reasoningTokens: rt } : {}),
              };
            }
            // V5.10 — prompt_cache_key 효과 메트릭. CODEX_DEBUG_USAGE=1 gate.
            if (process.env.CODEX_DEBUG_USAGE === "1" && event.response?.usage) {
              const u = event.response.usage;
              const cached = u.input_tokens_details?.cached_tokens ?? 0;
              const input = u.input_tokens ?? 0;
              const hitRate = input > 0 ? Math.round((cached / input) * 100) : 0;
              console.log(
                `[codex-oauth debug] usage input=${input} cached=${cached} (${hitRate}%) output=${u.output_tokens ?? 0} total=${u.total_tokens ?? 0}`,
              );
            }
          }
        } catch {
          // 비-JSON 라인 (heartbeat 등) skip.
        }
      }
    }
  }

  return { text, responseId, toolCalls, usage };
};

/**
 * V5.1' 신규 — input 누적 본체. prior turn 들 + 현재 turn 의 ResponseInput[]
 * shape 누적.
 *
 * 정책 (architect 계약서 §5.2):
 *  - prior session 이 `codex-` prefix sid 면 transcripts 회수 → ResponseInput shape 변환.
 *  - prior 가 claude sid (UUID v4) 또는 부재면 새 세션 시작 — 누적 0, 현재 turn user만.
 *  - turn 갯수 limit = `CODEX_TURN_HISTORY_LIMIT` (40).
 *
 * 반환: Codex Responses API 가 받는 `input: [...]` 배열 본체.
 */
// 멀티모달 (2026-05-28) — content 원소에 input_image / input_file 추가. codex
// /responses 가 input_image(이미지) · input_file(PDF) 를 받는다 실측 확인 (둘 다 HTTP
// 200 + 내용 정확 인식: 구글 로고 / PDF 텍스트). 텍스트 전용 가정(구 L566 주석)은 폐기
// — 백엔드는 vision/문서를 지원, 우리가 안 보냈을 뿐이었음.
type ResponseMediaItem =
  | { type: "input_image"; image_url: string }
  | { type: "input_file"; filename: string; file_data: string };
type ResponseContentItem =
  | { type: "input_text" | "output_text"; text: string }
  | ResponseMediaItem;
type ResponseInputMessage = {
  type: "message";
  role: "user" | "assistant";
  content: ResponseContentItem[];
};

// 현재 turn 미디어 첨부 → Responses native content items (data URI).
//  - 현재 turn 만 native 전달. 과거 turn 은 transcripts 의 placeholder text(formatAttachments)
//    로 인지 — cross-adapter 단일 히스토리·연속성 유지 (바이너리 transcripts 미적재).
//  - image → input_image. PDF(application/pdf) → input_file. 그 외(audio/video/voice,
//    비-PDF document)는 placeholder text 경로 인지 유지 (텍스트 문서는 Read 로 충분).
//  - 읽기 실패·과대 파일은 skip → placeholder text 가 경로/메타 인지 보장 (조용한 실패 0).
const MAX_INLINE_MEDIA_BYTES = 10 * 1024 * 1024;
const buildMediaContentItems = async (
  attachments: RegionASdkInput["attachments"],
): Promise<ResponseMediaItem[]> => {
  if (attachments === undefined) return [];
  const items: ResponseMediaItem[] = [];
  for (const a of attachments) {
    if (a.bytes > MAX_INLINE_MEDIA_BYTES) continue;
    try {
      if (a.kind === "image") {
        const b64 = (await fs.readFile(a.path)).toString("base64");
        items.push({
          type: "input_image",
          image_url: `data:${a.mimeType};base64,${b64}`,
        });
      } else if (a.kind === "document" && a.mimeType === "application/pdf") {
        const b64 = (await fs.readFile(a.path)).toString("base64");
        items.push({
          type: "input_file",
          filename: a.filename,
          file_data: `data:application/pdf;base64,${b64}`,
        });
      }
    } catch {
      /* 읽기 실패 → placeholder text 가 경로/메타로 인지 보장. */
    }
  }
  return items;
};

// V5.3 — OpenClaw L302-311 답습. function_call item 은 message 와 동등한 input array 원소.
type ResponseInputFunctionCall = {
  type: "function_call";
  id?: string;
  call_id: string;
  name: string;
  arguments: string;
};

// V5.3 — OpenClaw L324-342 답습. function_call_output 도 input array 의 1 원소.
// (image branch 는 본 어댑터 미사용 — 텍스트 only.)
type ResponseInputFunctionCallOutput = {
  type: "function_call_output";
  call_id: string;
  output: string;
};

export type ResponseInputItem =
  | ResponseInputMessage
  | ResponseInputFunctionCall
  | ResponseInputFunctionCallOutput;

/**
 * 6b — 격리(isolated) 최소 요약 호출. codex 자체 머신(token/headers/CODEX_BASE_URL
 * /responses fetch + parseCodexSse)을 *얇게* 재사용해 codex 안에서 닫는다.
 *
 * 격리 불변식 (재귀·레이어링 방지):
 *  - thread 히스토리 로딩 X (loadThreadHistory* 절대 호출 금지 — 재귀의 핵심 차단).
 *  - 도구 X (tools 키 omit), prompt_cache_key X (메인 캐시 충돌 회피), store:false.
 *  - instructions = "간결 요약기" 단발. 입력 = [요약 지시] + (기존요약 + 오래된 턴).
 *  - idle/turn 타임아웃은 base 구성(작은 bounded 호출 — 전 턴 면제 대상인 비서 작업
 *    turn 이 아니라 컨텍스트 위생 유틸. 실패 시 호출자가 oldest-drop 으로 graceful 폴백).
 *
 * 실패/타임아웃은 throw — 호출자(buildTurnHistory)가 catch 해 oldest-drop 폴백.
 */
const SUMMARIZE_INSTRUCTIONS =
  "당신은 간결한 대화 요약기입니다. 주어진 대화 조각을 한국어 3~6문장으로 요약하세요. " +
  "핵심 결정·사실·미해결 항목·사용자 의도를 보존하고, 인사·잡담은 생략하세요. " +
  "요약 텍스트만 출력하고 머리말/메타설명은 붙이지 마세요.";

async function summarizeViaCodex(
  text: string,
  accessToken: string,
  accountId: string | undefined,
  model: string,
): Promise<string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "OpenAI-Beta": "responses=experimental",
    originator: "codex_cli_rs",
  };
  if (accountId) headers["chatgpt-account-id"] = accountId;

  // 최소 payload — tools 없음, prompt_cache_key 없음(메인 thread 캐시 충돌 회피),
  // store:false, stream:true. reasoning 최소화로 요약 텍스트 슬롯 확보(finalFlush 동형).
  const body = JSON.stringify({
    model,
    instructions: SUMMARIZE_INSTRUCTIONS,
    input: [
      {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: `다음 대화 조각을 위 지침대로 요약하세요:\n\n${text}`,
          },
        ],
      },
    ],
    stream: true,
    store: false,
    reasoning: { effort: "none" },
  });

  // idle/turn 타임아웃 — 작은 bounded 호출이라 base 면 충분(비서 작업 turn 아님 →
  // 전 턴 면제 비대상. 실패해도 호출자 oldest-drop 폴백이라 안전).
  const ac = new AbortController();
  const idleTimer = createIdleTimer(ac);
  try {
    const res = await fetch(`${CODEX_BASE_URL}/responses`, {
      method: "POST",
      headers,
      body,
      signal: ac.signal,
    });
    if (!res.ok) {
      throw new Error(
        `Codex 요약 호출 실패: ${res.status} ${await res.text().catch(() => "")}`,
      );
    }
    if (res.body === null) {
      throw new Error("Codex 요약 응답 body 가 null — SSE 스트림 부재.");
    }
    const result = await parseCodexSse(res.body, () => idleTimer.beat());
    return result.text;
  } finally {
    idleTimer.done();
  }
}

/**
 * 6b — 압축 계획 (순수 함수, LLM·DB 호출 0, 결정적 → 단위 테스트 용이).
 *
 * 입력: watermark 이후 전체 타임라인(allTurns, ts ASC, id 동반) + 현재 watermark.
 * 출력: 이번에 *접을* 오래된 턴 목록(toFold)과, 접은 뒤의 새 watermark(nextWatermark).
 *
 * 트리거 가드: 미요약(= watermark 이후) 턴 수가 TRIGGER_TURNS 이하면 압축 불요
 * (needed=false, toFold=[]). 초과 시에만 [가장 오래된 … (len - keepRecent)] 를 접는다.
 * 최근 keepRecent 턴은 항상 원문 유지(최신 맥락 손상 0). 매 턴 재요약 방지 핵심.
 */
export interface HistoryCompactionPlan {
  needed: boolean;
  toFold: CodexTurnWithId[];
  nextWatermark: number;
}

export const planHistoryCompaction = (
  unsummarizedTurns: CodexTurnWithId[],
  currentWatermark: number,
  opts?: { triggerTurns?: number; keepRecent?: number },
): HistoryCompactionPlan => {
  const triggerTurns = opts?.triggerTurns ?? CODEX_HISTORY_COMPACT_TRIGGER_TURNS;
  const keepRecent = opts?.keepRecent ?? CODEX_HISTORY_COMPACT_KEEP_RECENT;

  // 미요약 턴이 임계 이하 → 압축 불요 (현행 = 요약 호출 0, 회귀 0).
  if (unsummarizedTurns.length <= triggerTurns) {
    return { needed: false, toFold: [], nextWatermark: currentWatermark };
  }
  // 최근 keepRecent 는 원문 유지, 그 이전만 접는다.
  const foldCount = unsummarizedTurns.length - keepRecent;
  if (foldCount <= 0) {
    return { needed: false, toFold: [], nextWatermark: currentWatermark };
  }
  const toFold = unsummarizedTurns.slice(0, foldCount);
  // 접힌 마지막 턴의 transcript id 가 새 watermark (그 id 이하 = 요약에 흡수됨).
  const last = toFold[toFold.length - 1] as CodexTurnWithId;
  return { needed: true, toFold, nextWatermark: last.id };
};

/** 요약 합성 턴 1개 ([summary] → user role 스캐폴딩 메시지). 빈 요약이면 undefined. */
const buildSummaryTurn = (summary: string): ResponseInputItem | undefined => {
  const trimmed = summary.trim();
  if (trimmed === "") return undefined;
  return {
    type: "message",
    role: "user",
    content: [
      {
        type: "input_text",
        text: `<system-reminder>\n${CODEX_SUMMARY_TURN_HEADER}\n${trimmed}\n</system-reminder>`,
      },
    ],
  };
};

/**
 * input 재구성 (순수 함수) — [요약 합성 턴?] + [watermark 이후 원문 턴] + [현재 turn].
 *
 * recentRaw = watermark 이후 원문으로 보낼 턴들 (압축이 끝난 뒤의 최근 턴 = 항상 원문).
 * summary = 누적 롤링 요약 (없으면 ""). charCap/limit 가드는 호출자가 recentRaw 산출
 * 시점에 이미 적용 — 본 함수는 wrap 만 (결정적). 요약 턴은 맨 앞(가장 오래된 맥락).
 */
export const buildCodexInputArray = (
  recentRaw: CodexTurn[],
  summary: string,
  currentTurn: ResponseInputItem,
): ResponseInputItem[] => {
  const out: ResponseInputItem[] = [];
  const summaryTurn = buildSummaryTurn(summary);
  if (summaryTurn !== undefined) out.push(summaryTurn);
  for (const t of recentRaw) {
    // 과거 user 턴의 <system-reminder> 스캐폴딩(SYSTEM.md·AGENT.md·메모리 인덱스 등) 제거.
    // 매 턴 필요한 스캐폴딩은 *현재 턴*(currentTurn)에 fresh 로 들어있으므로, 히스토리
    // 턴마다 중복 재전송하면 SYSTEM.md(~11KB)가 턴 수만큼 곱해져 입력 토큰을 폭증시킨다
    // (claude發 턴은 jsonl 이 조립본을 저장 → codex 가 통째 재전송). assistant 턴엔 스캐폴딩
    // 없음, codex發 raw 턴엔 블록이 없어 no-op. 출구위생 함수 재사용(DRY).
    const text =
      t.role === "assistant"
        ? t.content
        : stripInternalRuntimeScaffolding(t.content).trim() || t.content;
    out.push({
      type: "message",
      role: t.role,
      content: [
        {
          type:
            t.role === "assistant"
              ? ("output_text" as const)
              : ("input_text" as const),
          text,
        },
      ],
    });
  }
  out.push(currentTurn);
  return out;
};

const buildCurrentTurn = (
  currentPromptWithMemory: string,
  mediaItems: ResponseMediaItem[],
): ResponseInputItem => ({
  type: "message",
  role: "user",
  // 현재 turn = [미디어 블록들…] + [텍스트]. 미디어 없으면 텍스트만 (회귀 0).
  content: [...mediaItems, { type: "input_text", text: currentPromptWithMemory }],
});

/**
 * 6b — input 누적 본체 (요약 압축 통합). async — 압축 트리거 시 summarizeViaCodex 1회.
 *
 * 동작:
 *  1) 전체 타임라인(id 동반)을 watermark 기준으로 [요약됨 | 미요약]으로 가른다.
 *  2) 미요약이 임계 초과면(planHistoryCompaction) 오래된 턴 + 기존 요약 → summarizeViaCodex
 *     → 갱신 요약 + watermark 전진(upsert). 임계 이하면 압축 0 (현행 동작).
 *  3) 요약 호출 실패/타임아웃 → console.warn + 현행 oldest-drop 폴백(요약 없이 진행,
 *     턴은 깨지 않음 — 데몬 생존 원칙 3).
 *  4) 입력 = [요약 합성 턴?] + [watermark 이후 원문 턴(charCap 가드)] + [현재 turn].
 *
 * 첫 turn(매핑 0)·짧은 thread(임계 미만) = 요약 0 + 현행과 동일 입력(회귀 0).
 */
const buildTurnHistory = async (
  input: RegionASdkInput,
  currentPromptWithMemory: string,
  mediaItems: ResponseMediaItem[] = [],
  accessToken: string,
  accountId: string | undefined,
  model: string,
): Promise<ResponseInputItem[]> => {
  const currentTurn = buildCurrentTurn(currentPromptWithMemory, mediaItems);

  // 전체 타임라인 (id 동반, cap 없음) — 압축 결정 전용. 첫 turn → [].
  // 채널/세션 분리(ADR 2026-07-15 §D1) — 세션-정체성은 canonical 저장 채널로 키잉
  // (sessionChannel, 미지정 → channel 폴백·회귀 0). runOpenAiCodex 의 idChannel 과 동일 규칙.
  const allTurns = loadThreadHistoryWithIds(
    input.sessionChannel ?? input.channel,
    input.threadKey,
  );
  if (allTurns.length === 0) {
    return [currentTurn];
  }

  // 기존 롤링 요약 + watermark 회수 (없으면 watermark 0 = 전부 미요약).
  let existing = getThreadSummary(input.threadKey);
  let watermark = existing?.compactedThrough ?? 0;
  let summary = existing?.summary ?? "";

  // watermark 이후(미요약) 턴만 추려 압축 트리거 판정.
  const unsummarized = allTurns.filter((t) => t.id > watermark);
  const plan = planHistoryCompaction(unsummarized, watermark);

  if (plan.needed) {
    // 오래된 턴 + 기존 요약 → 요약 LLM 호출 1회 (isolated, 재귀 없음).
    const foldedText = plan.toFold
      .map((t) => `${t.role === "assistant" ? "비서" : "사용자"}: ${t.content}`)
      .join("\n");
    const prompt =
      summary === ""
        ? foldedText
        : `[기존 요약]\n${summary}\n\n[이어지는 대화]\n${foldedText}`;
    try {
      const fresh = await summarizeViaCodex(prompt, accessToken, accountId, model);
      if (fresh.trim() !== "") {
        summary = fresh.trim();
        watermark = plan.nextWatermark;
        upsertThreadSummary({
          threadKey: input.threadKey,
          summary,
          compactedThrough: watermark,
        });
      } else {
        // 빈 요약 = 무의미 → 폴백(요약 미반영, 기존 watermark 유지). 조용히 X.
        console.warn(
          `[codex 6b] 요약 호출이 빈 결과 — oldest-drop 폴백 (threadKey=${input.threadKey})`,
        );
      }
    } catch (e) {
      // 요약 실패/타임아웃 → 현행 oldest-drop 폴백. 턴은 깨지 않음(데몬 생존 원칙 3).
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(
        `[codex 6b] 요약 호출 실패 — oldest-drop 폴백 (threadKey=${input.threadKey}): ${msg}`,
      );
    }
  }

  // watermark 이후 원문 턴 (압축 성공 시 최근 keepRecent + 그간 신규, 실패 시 전체 미요약).
  // charCap/limit 가드 = 최신부터 역누적, 초과 시 oldest drop (요약이 없을 때의 안전망).
  const recentRawAll: CodexTurn[] = allTurns
    .filter((t) => t.id > watermark)
    .map((t) => ({ role: t.role, content: t.content }));

  let charSum = currentPromptWithMemory.length + summary.length;
  const recentRaw: CodexTurn[] = [];
  for (let i = recentRawAll.length - 1; i >= 0; i--) {
    if (recentRaw.length >= CODEX_TURN_HISTORY_LIMIT) break;
    const t = recentRawAll[i] as CodexTurn;
    if (charSum + t.content.length > CODEX_TURN_HISTORY_CHAR_CAP) break;
    charSum += t.content.length;
    recentRaw.unshift(t);
  }

  return buildCodexInputArray(recentRaw, summary, currentTurn);
};

// V5.3 — agentic loop iteration 노브. 2026-07-03 "자동 이어가기" 재설계로 25 cap 의
// 이중 역할(런어웨이 방어 + 작업 완료 신호)을 분리했다.
//
// ★역할 재정의: CODEX_MAX_TOOL_ITERATIONS(25)는 더 이상 *작업 완료 cap* 이 아니라
//   **soft checkpoint 간격**이다 — 25·50·75… 마다 "안 끝났으면 계속하라" 가벼운 진행
//   nudge 1회를 넣을 뿐, 강제 마무리(tools:[])는 하지 않는다(아래 루프 참조).
//   과거 이 값에서 강제 flush 하던 탓에 위키 정리처럼 도구 30~50+ 가 정당한 큰 작업이
//   매번 25 에서 잘려 부분보고로 끝났다. claude SDK 는 사실상 무제한으로 완주하므로
//   이건 #2 LLM-agnostic parity 갭이었다 — 본 변경이 그 갭을 복구한다.
//
// ★런어웨이 방어는 raw iteration count 가 아니라 (a) progress-aware stall 가드
//   (createIdleTimer + CODEX_NO_PROGRESS_MS, output/tool 진전에만 beat), (b) 턴
//   타임아웃 wall-clock 백스톱, (c) 아래 절대 백스톱(HARD) 3중이 담당한다. (a)/(b)는
//   *실제 무진전*만 컷하므로 정당한 긴 작업은 안 끊는다 — count 보다 똑똑한 방어다.
//   ⚠ 본 변경은 (a)/(b)가 루프 바깥에 살아있음에 *의존*한다(런어웨이가 여전히 바운드).
//
// env override — 사용자가 비용/안전 트레이드오프를 데몬 재시작만으로 조정 (양수 정수만).
const parseCapEnv = (raw: string | undefined): number => {
  if (raw === undefined || raw === "") return 25;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : 25;
};
// soft checkpoint 간격 (25·50·75… 마다 진행 nudge). 강제 마무리 아님.
const CODEX_MAX_TOOL_ITERATIONS = parseCapEnv(
  process.env.CODEX_MAX_TOOL_ITERATIONS,
);

// ── Context compaction 상수 (architect contract §6.4, 2026-06-16) ──────────────
// codex 루프(우리 수동 while)가 tool output 을 pruning 0 으로 누적·매 iteration
// 재전송하는 O(N²) 낭비를 잡는 두 노브. LLM 호출 0 — 순수 문자열 truncate + 참조
// 치환만. claude/openai 어댑터는 SDK 가 자체 효율 관리 → 무수정(층2 native 위임,
// LLM-agnostic 하드게이트 정합). 매직넘버 금지 — 보수적 기본값 + env override.
//
// 공통 env 파서 — 양의 정수만, 아니면 기본값. (parseCapEnv 와 동일 정책, 임의 기본.)
const parsePosIntEnv = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

// ★절대 백스톱(HARD ceiling) — agentic 루프의 진짜 상한. 런어웨이 최후 방어(무한 루프
//  0 보장). 일상에선 도달 안 함: 모델이 자연히 도구를 멈추면(toolCalls.length===0 →
//  break, claude 동형) 그게 진짜 완료 신호이고, 그 전에 stall 가드/턴 타임아웃이 무진전을
//  컷하기 때문. 여기까지 도달할 때만 마지막 슬롯에서 강제 "tools:[] 마무리"(final-flush).
//  기본 150 = 옛 25 cap 의 6배 → 위키급 대작업(도구 30~50+)도 자연 완주 여유 충분.
//  parsePosIntEnv 재사용(양수 정수만, 아니면 150). CODEX_MAX_TOOL_ITERATIONS(간격)와
//  독립 env override — 둘 다 데몬 재시작만으로 조정. 매직넘버 금지(상수+주석).
const CODEX_MAX_TOOL_ITERATIONS_HARD = parsePosIntEnv(
  process.env.CODEX_MAX_TOOL_ITERATIONS_HARD,
  150,
);

// C2 — 단일 tool output 의 inputArray 진입 cap. 초과 시 머리+꼬리만 남기고 중간
// 치환. 도구 자체 cap(Bash 1MB·Read 2000라인)과 *별개* 의 어댑터 진입 게이트.
// 16,000자 ≈ 4.5K tok (gpt-5.5 윈도 400K 의 ~1%) — 한 도구 결과가 25 iteration
// 따라다녀도 부담 작은 수준.
const CODEX_TOOL_OUTPUT_ENTRY_CAP = parsePosIntEnv(
  process.env.CODEX_TOOL_OUTPUT_ENTRY_CAP,
  16_000,
);
const CODEX_TOOL_OUTPUT_HEAD_CHARS = parsePosIntEnv(
  process.env.CODEX_TOOL_OUTPUT_HEAD_CHARS,
  8_000,
);
const CODEX_TOOL_OUTPUT_TAIL_CHARS = parsePosIntEnv(
  process.env.CODEX_TOOL_OUTPUT_TAIL_CHARS,
  4_000,
);

// C1 — inputArray 의 오래된 function_call_output 본문을 placeholder 로 치환할 때
// raw 유지할 최근 output 개수 K. 모델이 직전 작업 맥락은 온전히 봐야 다음 행동을
// 정하므로 최근 K개는 raw. K=3 (architect 권고) — 너무 작으면 재호출 핑퐁↑.
const CODEX_COMPACT_KEEP_RECENT = parsePosIntEnv(
  process.env.CODEX_COMPACT_KEEP_RECENT,
  3,
);
// C1 — 이 길이 이하 output 은 압축해도 이득 < placeholder 오버헤드라 그냥 둔다.
const CODEX_COMPACT_MIN_OUTPUT = parsePosIntEnv(
  process.env.CODEX_COMPACT_MIN_OUTPUT,
  2_000,
);

// 압축된 output 임을 표시하는 안정 마커. idempotent 보장 — 이미 이 마커가 박힌
// output 은 (a) 짧아 임계 미달로 자연 제외 + (b) 마커 검사로 명시 제외(이중 안전).
const CODEX_COMPACTED_MARKER = " __codex_compacted__ ";

// ── 6b: 대화 히스토리 롤링 요약 압축 상수 (architect contract §6b, 2026-06-19) ────
// codex 는 resume 없어 매 턴 전체 히스토리 재전송 → loadThreadHistory 의 oldest-drop
// 이 긴 대화 초반을 통째 버린다. 버리는 대신 오래된 턴을 요약 1덩어리로 접어 보존.
// 매직넘버 금지 — 상수 + env override (parsePosIntEnv, idle-timeout 정책 답습).
//
// ⚠ 위 tool-output 압축의 CODEX_COMPACT_KEEP_RECENT(=3, 도구 출력 본문 보존)와는
//    *별개 노브*다. 이쪽은 대화 *턴* 보존 수 → 충돌 회피 위해 별도 env 이름 사용.
//
// 트리거: 미요약(watermark 이후) 턴이 TRIGGER_TURNS 초과 시 압축 1회. 기존 150턴/700KB
// 하드캡(loadThreadHistory)보다 *먼저* 선제 발동(100 < 150)해 초반 맥락이 drop 되기
// 전에 요약으로 흡수. 매 턴 재요약 X — 임계 재초과 시에만(롤링이라 비용 분할상환).
const CODEX_HISTORY_COMPACT_TRIGGER_TURNS = parsePosIntEnv(
  process.env.CODEX_COMPACT_TRIGGER_TURNS,
  100,
);
// 항상 원문 유지할 최근 턴 수 — 최신 맥락 손상 0 (요약은 이보다 오래된 턴만 대상).
const CODEX_HISTORY_COMPACT_KEEP_RECENT = parsePosIntEnv(
  process.env.CODEX_COMPACT_KEEP_RECENT_TURNS,
  30,
);

// ── codex 무진전(no-progress) 감지 + 같은 컨텍스트 스텝 재개 (ADR 2026-07-02) ──────────
// codex raw fetch + 수동 SSE 리더는 read 타임아웃이 없어 백엔드 무응답 시 영원히 대기한다.
// ★진전 기준 가드: SSE 실측 결과 codex 는 "생각 중" response.in_progress heartbeat 만 흘리고
// (output/tool 0), 답/도구가 시작되면 output_text.delta·function_call 이 온다. 그래서 타이머를
// *진전 이벤트(output_text.delta·function_call)에만* reset — in_progress 엔 안 함. 그러면:
//   · 답/도구가 흐르는 스트림 = 아무리 길어도 안 잘림(진전 beat).
//   · in_progress 만 N분(dead=무바이트 포함) = 진짜 무진전 → 컷 → 같은 body 로 재개.
// blunt 시간 cap(정상 긴 작업도 자름)의 위험을 없앤 정밀 가드. 모델 폴백 아님(codex 안에서
// 닫음). 남는 한계: 답 전 *순수 reasoning* 이 N분 초과면 컷(codex 가 생각을 content 로 안 흘림
// = 근본 한계) — N 넉넉+env 튜닝으로 극단만.
/** codex 무진전(output/tool 무수신) 한계(ms). first/idle 공통. env override. */
const CODEX_NO_PROGRESS_MS = parsePosIntEnv(
  process.env.CODEX_NO_PROGRESS_MS,
  300_000,
);
/** 무진전 시 같은 스텝(같은 body) 최대 재개 횟수. env override. */
const CODEX_STALL_MAX_RETRIES = parsePosIntEnv(
  process.env.CODEX_STALL_MAX_RETRIES,
  2,
);
/** 재개 사이 backoff(ms) — 백엔드 회복 여유. env override. */
const CODEX_STALL_BACKOFF_MS = parsePosIntEnv(
  process.env.CODEX_STALL_BACKOFF_MS,
  5_000,
);

// ── codex 단일 SSE 턴 절대 wall-clock 캡 (trickle 가드, 2026-07-03) ─────────────────────
// ★근본 원인(실측): 위 progressTimer(CODEX_NO_PROGRESS_MS)는 진전 이벤트
// (output_text.delta·function_call)마다 beat=리셋된다. 그래서 codex 백엔드가 델타를
// *찔끔찔끔*(trickle; 예: 2분마다 한 조각) 흘리면 5분 무진전 가드가 *영영 안 터지고*
// 한 SSE 턴이 8~22분을 끈다(라이브 2026-07-03: 위키 워커 한 턴 8분 + 22분 trickle 정지
// → 30분 워커 wall-clock 상한만이 죽임). no-progress 가드도 도구 타임아웃(v0.3.12)도
// 못 잡음(도구 hang 아니라 SSE trickle이라).
//
// 이건 progressTimer(dead=무진전)와 *직교*하는 단일 SSE 턴 절대 wall-clock 캡이다:
//   · dead(무진전 5분)  = progressTimer(리셋됨) 담당.
//   · trickle(느리게 흐름 10분) = 이 캡(리셋 안 됨) 담당.
// 무장 시각부터 리셋 없이 이 시간을 넘으면, 진전 여부와 무관하게 idleAc 를 abort →
// effectiveAc(linkAbort) 전파 → fetch/parseCodexSse throw → 기존 catch 의
// IdleTimeoutError 분기가 그대로 *같은 컨텍스트 재개*(progressTimer 발화와 동일 경로,
// 실패 아님). IdleTimeoutError 재사용(shared idle-timeout.ts·facade MODEL_REJECTED_PATTERNS
// 불변식 미변경).
//
// codex 수동 raw-fetch 루프 전용 — claude/openai 는 SDK가 스트림/타임아웃을 관리하므로
// 이미 이 보호를 가진다(parity 복구, cross-adapter 폴백 아님 — codex 안에서 닫음).
//
// ★blunt-cap 트레이드오프: 정상적으로 10분+ 스트리밍하는 긴 생성을 오살할 위험이 있다.
// 단일 codex 턴이 10분+ 순수 스트리밍은 극히 드물고, 컷 후 *실패가 아니라 같은 컨텍스트
// 재개*(위 stall-resume 경로)라 정당한 긴 턴도 spiky 열화에서 완주 기회를 얻는다.
// 넉넉한 10분 기본값 + env 튜닝으로 이 오살을 완화한다.
/** codex 단일 SSE 턴 절대 wall-clock 상한(ms) — 리셋 안 됨(trickle 가드). env override. */
const CODEX_TURN_MAX_MS = parsePosIntEnv(
  process.env.CODEX_TURN_MAX_MS,
  600_000,
);

// ── codex 도구 실행 per-call wall-clock 타임아웃 (2026-07-03) ──────────────────────────
// ★근본 원인: 위 progressTimer(무진전 가드)는 fetch+parseCodexSse(SSE 스트림)만 감시하고
// *도구 실행 직전에 .done()* 된다(의도적 면제 — 긴 정상 도구 오살 0). 그래서 hung 도구가
// 있으면 SSE 밖 = 아무 가드도 없어 턴 전체가 blunt 30분 워커 wall-clock 상한까지 얼어붙는다
// (라이브 사고 2026-07-03: Bash 도구 안 ~19.5분 데몬 이벤트 0 → 30분 상한만이 죽임 → 산출 0).
// 이건 progressTimer/stall-resume 와 *직교*하는 도구 실행 전용 새 가드다.
//
// 설계: 각 callTool 을 이 wall-clock 과 Promise.race → 초과 시 reject(throw) → 기존
// catch (e) { output = `Error: …` } 가 그대로 잡아 function_call_output 으로 push → 루프
// 계속 → 모델이 "그 도구 실패"를 보고 적응(30분 freeze 대신 bounded 에러). abort/resume
// 안 함(턴 안 죽이고 재개 안 함 — 재개는 Write·Bash·memory 중복 부작용 위험).
//
// ⚠ orphan 한계(기존 §4.4 #3): MCP callTool 은 abort 신호가 안 들어가므로 타임아웃돼도 그
// 도구는 detached 로 계속 돌 수 있다. 넉넉한 기본값(8분)이 "완료 직전 오살→중복 부작용"
// 위험을 최소화한다.
//
// 기본 480000=8분: 30분 워커 상한보다 아래(freeze 차단) + 정상 긴 도구(sub-agent·긴 Bash)
// 보다는 위(오살 최소). parsePosIntEnv 재사용, env override.
/** codex 개별 도구 호출(callTool) wall-clock 상한(ms). env override. */
const CODEX_TOOL_TIMEOUT_MS = parsePosIntEnv(
  process.env.CODEX_TOOL_TIMEOUT_MS,
  480_000,
);

// ★도구 조기 경고 (2026-07-03) — 도구가 이 시간 안 끝나면 8분 타임아웃 *전에* 로그 경고.
// 실측: 워커 도구(Bash 등)가 **macOS 권한 요청 다이얼로그**에 막혀 조용히 멈췄는데, 도구
// 시작(llm.activity)만 찍히고 완료 신호가 없어 "느림 vs 막힘" 구분이 안 돼 30분+ 헤맸다.
// → 도구가 오래 안 끝나면 ~90초에 `[tool-slow]` 로 알려 "권한 요청 확인" 같은 조치를 빨리
// 하게. 죽이지 않고 경고만(정상 긴 도구=무해한 로그 1줄). env override.
const CODEX_TOOL_SLOW_WARN_MS = parsePosIntEnv(
  process.env.CODEX_TOOL_SLOW_WARN_MS,
  90_000,
);

// 요약 합성 턴을 감싸는 스캐폴딩 헤더 — assembleUserPrompt 의 <system-reminder> 패턴
// 답습. 메인 모델이 "하네스가 주는 배경 정보(사용자 발화 아님)"로 인지 → 그대로 echo
// 하지 않음. user role 메시지지만 내부 스캐폴딩 형태라 딴소리·메아리 방지.
const CODEX_SUMMARY_TURN_HEADER =
  "〔이전 대화 요약 — 하네스 제공 배경, 사용자 발화 아님〕";

/**
 * C2: 단일 tool output 의 inputArray 진입 cap. 임계 초과 시 머리+꼬리만 남기고
 * 중간을 참조 안내로 치환. 순수 함수 (LLM 호출 0, 결정적).
 *
 * - cap 이하면 원본 그대로 반환 (짧은 출력 = 현행과 100% 동일, 회귀 0).
 * - head+tail 이 cap 이상이면 잘릴 게 없으므로 원본 반환 (방어).
 */
export const capToolOutputForEntry = (
  output: string,
  opts?: { cap?: number; headChars?: number; tailChars?: number },
): string => {
  const cap = opts?.cap ?? CODEX_TOOL_OUTPUT_ENTRY_CAP;
  const headChars = opts?.headChars ?? CODEX_TOOL_OUTPUT_HEAD_CHARS;
  const tailChars = opts?.tailChars ?? CODEX_TOOL_OUTPUT_TAIL_CHARS;
  if (output.length <= cap) return output;
  // 머리+꼬리가 원본 이상이면 절약 없음 → 그대로.
  if (headChars + tailChars >= output.length) return output;
  const omitted = output.length - headChars - tailChars;
  // 경계에서 surrogate pair(이모지 등)가 쪼개지면 lone surrogate(깨진 글자)가 남는다.
  // head 끝의 lone high-surrogate, tail 앞의 lone low-surrogate 만 제거(최대 1 code unit).
  const head = output.slice(0, headChars).replace(/[\uD800-\uDBFF]$/, "");
  const tail = output.slice(output.length - tailChars).replace(/^[\uDC00-\uDFFF]/, "");
  return (
    `${head}\n…[중략 ${omitted}자 — 전체 출력이 잘렸습니다. ` +
    `특정 부분이 필요하면 Read offset/limit 또는 Grep 으로 좁혀 재요청하세요.]…\n` +
    `${tail}`
  );
};

/**
 * C1: inputArray 의 오래된 function_call_output 본문을 placeholder 로 치환한다.
 * in-place 변형 (push-only 구조에 압축 패스로 삽입). 순수하진 않으나(부수효과)
 * LLM 호출 0·결정적.
 *
 * 불변식 (architect §6.3):
 *  - call_id 쌍 정합: function_call item·call_id 는 절대 손대지 않고, 오직
 *    function_call_output 의 `output` 문자열만 교체 (삭제 0 → Responses shape 무손상).
 *  - 최근 keepRecent 개의 function_call_output 은 raw 유지 (모델 직전 맥락 보존).
 *  - minOutputChars 이하 output 은 압축 안 함 (placeholder 오버헤드 회피).
 *  - idempotent: 이미 마커가 박힌 output 은 건너뜀.
 */
export const compactOldToolOutputs = (
  inputArray: ResponseInputItem[],
  opts?: { keepRecent?: number; minOutputChars?: number },
): void => {
  const keepRecent = opts?.keepRecent ?? CODEX_COMPACT_KEEP_RECENT;
  const minOutputChars = opts?.minOutputChars ?? CODEX_COMPACT_MIN_OUTPUT;

  // function_call_output 만의 인덱스 목록 (시간순 = 배열순). 최근 keepRecent 개는
  // 보존, 그 이전(= 앞쪽 인덱스)만 압축 대상.
  const outputIdxs: number[] = [];
  for (let i = 0; i < inputArray.length; i++) {
    if (inputArray[i]?.type === "function_call_output") outputIdxs.push(i);
  }
  if (outputIdxs.length <= keepRecent) return; // 압축할 만큼 안 쌓임 → no-op.

  const compactUntil = outputIdxs.length - keepRecent; // [0, compactUntil) 만 압축.
  for (let j = 0; j < compactUntil; j++) {
    const item = inputArray[outputIdxs[j] as number] as ResponseInputFunctionCallOutput;
    const body = item.output;
    if (body.length < minOutputChars) continue; // 짧음 → 그냥 둠.
    if (body.startsWith(CODEX_COMPACTED_MARKER)) continue; // 이미 압축됨 (idempotent).
    item.output =
      `${CODEX_COMPACTED_MARKER}[이전 도구 출력 생략 — 약 ${body.length}자. ` +
      `필요하면 같은 인자로 도구를 재호출하세요.]`;
  }
};

// persistence 보강 (2026-05-27, contract Q1(B)) — codex 전용 instructions delta.
// claude 는 SDK 도구 루프가 작업 완료까지 자율 persistence (코드 차원). codex 는 우리
// 수동 while 루프라 모델이 도구를 일찍 끊지 않도록 prompt 로 유도하는 책임이 추가.
// 이건 인격 분기가 아니라 *행동을 claude 에 맞추는 parity 정합* (사용자가 보는 행동 = 둘 다
// 끝까지 일함). 공유 SYSTEM_PROMPT 뒤에 append → 공유 헌법 우선, persistence 는 codex 전용
// 보강. claude 어댑터(options.systemPrompt = SYSTEM_PROMPT)는 무영향 → SYSTEM_PROMPT_HASH
// 무변 → claude 세션 회귀 0. 공유 sysprompt 의 「사용자 동사 보호」 정정(턴 경계 vs 턴 내부)과
// 의미 정합 — 아래 4번째 bullet 이 두 문서의 일관성을 명시.
const CODEX_PERSISTENCE_PROMPT = [
  "작업 수행 지속성 (persistence):",
  "- 주어진 작업이 완료될 때까지 필요한 도구를 계속 사용하세요. 한 도구를 쓰고 중간 보고만 한 뒤 멈추지 마세요.",
  "- 작업이 아직 끝나지 않았는데 텍스트만 내고 멈추려는 충동을 억제하세요. 다음 필요한 도구 호출을 이어서 수행하세요.",
  "- 중간에 사용자에게 「계속할까요?」 류의 확인을 구하려고 멈추지 마세요 — 이미 받은 요청은 자율적으로 완수합니다. 단, 위험 도구(파일·디렉터리 삭제, 외부 메시지 발송, 시스템 변경, 자격 증명, 자기 코어·헌법 수정 등) 사전 승인은 「보안 책임」 섹션대로 예외로 유지하고, 그 외 일상 작업은 묻지 말고 진행하세요.",
  "- 위 「사용자 동사 보호」와 충돌하지 않습니다: 동사 보호는 *다른 종류의 작업으로 전환*을 막는 것이고, persistence 는 *주어진 그 작업을 끝까지* 하라는 것입니다. 현재 동사 범위 안에서는 끝까지, 다음 동사로는 넘어가지 않습니다.",
  "- 모든 작업이 실제로 완료되고 더 호출할 도구가 없을 때, 사용자에게 결과를 요약한 최종 텍스트를 반드시 작성하세요. 빈 응답으로 끝내지 마세요.",
].join("\n");

/**
 * V5.3 — MCP tool list → OpenAI Responses `tools` shape 변환.
 *
 * OpenClaw `convertResponsesTools` L349-372 답습 (strict 분기 미사용 — codex backend 는
 * strict 옵션 거부 위험, V5.1' 정합. MCP server 의 inputSchema 가 이미 JSON Schema 라
 * 직접 매핑).
 *
 * MCP Tool shape (modelcontextprotocol/sdk):
 *   { name, description?, inputSchema: { type:"object", properties?, required? } }
 *
 * Codex Responses tools 원소:
 *   { type:"function", name, description, parameters }
 */
const convertMcpToolsToResponsesTools = (
  mcpTools: ReadonlyArray<{
    name: string;
    description?: string;
    inputSchema?: unknown;
  }>,
): Array<{
  type: "function";
  name: string;
  description: string;
  parameters: unknown;
}> =>
  mcpTools.map((t) => ({
    type: "function" as const,
    name: t.name,
    description: t.description ?? "",
    // inputSchema 는 MCP 표준 JSON Schema → Responses `parameters` 직접 매핑.
    // null/undefined 방어: 빈 object schema 로 폴백.
    parameters:
      t.inputSchema !== undefined && t.inputSchema !== null
        ? t.inputSchema
        : { type: "object", properties: {}, required: [] },
  }));

// V3.1 = hello world 1 case 라이브 PASS. V3.3 = token auto refresh.
// V5.1' = raw fetch + SSE 본체 V3.3 답습 + payload 6 필드 + input 누적 + response.id 추출.
// V5.3 = MCP memory 도구 1종 통합 — payload 에 tools 필드 + function_call SSE 3 분기 +
//        agentic loop (max 10) 자체 구현. 도구 turn 은 transcripts 미박음 (role 필터로 자동 격리).
// V5.5 = file-ops MCP server (Read/Glob/Grep 3 종 읽기 전용) 추가 — codex 어댑터만 회수
//        (claude 어댑터는 SDK builtin 그대로). 두 서버 tools 한 배열에 합쳐 8 도구 노출,
//        tool name → bridge 라우팅 테이블로 callTool 디스패치. cwd 외부 path 접근 거부.
// 깨짐 시 error throw — V4 폴백 (claude 어댑터 자동 합류) 후속.
export const runOpenAiCodex = async (
  input: RegionASdkInput,
): Promise<RegionASdkOutput> => {
  // 채널/세션 분리(ADR 2026-07-15 §D1) — 세션-정체성(context/transcripts)은 canonical
  // 저장 채널로 키잉(sessionChannel, 미지정 → channel 폴백·회귀 0). 표시/감사는 input.channel
  // 유지 — claude/openai 어댑터와 parity(#2).
  const idChannel = input.sessionChannel ?? input.channel;

  const accessToken = await ensureFreshAccessToken();
  const accountId = extractAccountId(accessToken);
  // model 우선순위: facade 주입(input.model) > env > 디폴트.
  const model =
    input.model ?? process.env.OPENAI_CODEX_MODEL ?? CODEX_DEFAULT_MODEL;

  // V5.1 carry-over + V7.0 — user prompt prefix 조립 (claude 어댑터 L150-167 동형):
  //   [AGENT body] + [AGENT warning] + [memory index] + [formatMemorySnippet]
  //   + [skill index]  ← V7.0 추가: 현재 turn 의 의도 매칭 면, memorySnippet 다음.
  //   + [user text]
  const agent = readAgent();
  const agentWarn = agentSizeWarning(agent);
  // leanMemory (2026-06-15, architect §2c I-5) — lean child 는 메모리 스니펫·인덱스
  // prepend 생략(장기기억 = 단순작업 잡음). persona(SYSTEM.md/AGENT.md)는 불가침(I-4).
  // openai/claude 어댑터와 동형 신호(I-2).
  const leanMemory = input.leanMemory === true;
  const memoryIndex = leanMemory ? "" : formatMemoryIndex();
  const memorySnippet = leanMemory
    ? ""
    : formatMemorySnippet(
        retrieveContext(idChannel, input.threadKey, input.text, {
          limit: 5,
        }),
      );
  // V7.0 — 스킬 인덱스 (auto-invoke 가능 스킬만, `disable-model-invocation: true`
  // 제외). 빈 list 면 prepend 0 — 헤더 자체 안 박음.
  // V7.1 — discoverSkills 가 user/project + `plugins/<plugin>/skills/` 모두 회수
  // (source: "plugin" 자동 포함). 본 호출 본문 변경 0, 효력은 자동 반영.
  // V9.3 — input.cwd 전파 → 프로젝트 스킬(`<cwd>/skills`) 발견 정합. 미지정 시 홈.
  // β (2026-05-25): 폴백 cwd 를 process.cwd() → getPaths().home 으로 (claude 어댑터
  //  L131 cwd=home 과 parity — 두 어댑터가 같은 base 에서 스킬·에이전트·프로젝트 스코프
  //  발견). input.cwd 우선순위 유지.
  const discoveryCwd = input.cwd ?? getPaths().home;
  const skills = await discoverSkills(discoveryCwd);
  const skillIndex = formatSkillIndex(skills);
  // V7.2.b — sub-agent 인덱스. depth 0 turn 만 노출 (child turn 은 spawn 도구
  // 미등록 → 인덱스도 박지 않음, 재spawn 유도 0). 빈 list 면 prepend 0.
  const depth = input.subagentDepth ?? 0;
  const agentIndex =
    depth === 0
      ? formatAgentIndex(await discoverAgents(discoveryCwd))
      : "";
  // 모델 프로파일 인지 — depth 0 만 (agentIndex 게이트 parity). 부재/오류 시 ""(graceful).
  const modelProfiles = depth === 0 ? formatModelProfiles(discoveryCwd) : "";
  // 현재 대화 컨텍스트 — depth 0(실제 사용자 대화)만. sub-agent 는 dest 무관.
  const convoContext =
    depth === 0
      ? formatConversationContext(
          input.channel,
          input.threadKey,
          input.channelAddress,
        )
      : "";

  // 멀티모달 V1 — 현재 turn 첨부 placeholder (경로+메타). 미지정/빈 배열 → "" (회귀 0).
  // codex 는 file-ops MCP read 로 절대경로를 읽음. 이미지 vision 해석 격차는
  // formatAttachments 가 명시 안내(claude 전환)로 처리 (조용한 격차 0, contract Q4).
  const attachmentBlock = formatAttachments(input.attachments);

  // SYSTEM.md(작동 헌법) — 매 turn 최상단 (on-demand Read 아님, 2026-05-27). claude parity.
  const system = readSystem();
  // 시스템 컨텍스트(매 turn 주입 스캐폴딩) ↔ 사용자 turn 분리 (2026-05-28 딴소리 fix,
  //  claude 어댑터와 동일 — parity). 첨부 블록은 사용자 turn 쪽으로 그룹.
  // 중립 override(게이트웨이) 지정 시 tiguclaw context prefix 전부 스킵(페르소나·컨텍스트 누수 0).
  const systemContextParts =
    input.systemPromptOverride !== undefined
      ? []
      : buildSystemContextParts({
          system,
          agent,
          agentWarn,
          convoContext,
          memoryIndex,
          memorySnippet,
          skillIndex,
          agentIndex,
          modelProfiles,
        });
  const userTurnParts = [attachmentBlock, input.text];
  const promptWithMemory = assembleUserPrompt(systemContextParts, userTurnParts);

  // V5.1' 신규 — input 누적 (prior turn 들 + 현재 turn).
  // V5.3 — agentic loop 중 function_call / function_call_output 을 같은 배열에 append.
  // 멀티모달 — 현재 turn 미디어 첨부(image/PDF)를 native content 로 인코딩해 전달.
  const mediaItems = await buildMediaContentItems(input.attachments);
  // 6b — 롤링 요약 압축 통합 (async — 압축 트리거 시 summarizeViaCodex 1회). 요약
  // 호출은 isolated(히스토리 로딩 X, 도구 X) → 재귀 없음. 실패 시 oldest-drop 폴백.
  const inputArray: ResponseInputItem[] = await buildTurnHistory(
    input,
    promptWithMemory,
    mediaItems,
    accessToken,
    accountId,
    model,
  );

  // V5.3 — MCP memory server (claude 어댑터와 동일 instance) in-memory bridge 회수.
  // V5.5 — file-ops MCP server (codex 어댑터 전용 — claude 는 SDK builtin Read/Glob/Grep)
  // 추가. 두 서버의 listTools() 결과를 한 배열에 합쳐 OpenAI Responses tools shape 박음.
  // callTool 디스패치는 tool name → server 매핑 (memory 5종 + file-ops 3종 = 8종).
  // 모든 bridge 를 모아 finally 에서 일괄 close — in-memory transport 누수 방지.
  // (그간 memory/file-ops/reply-intent 3개만 닫혀 todo·skill·send-file·agents·workers·
  // endpoints·commands·extra bridge 가 매 turn 누적됐음, P1.) openai 어댑터의 mcpServers
  // 일괄 close(openai-agents-sdk) 와 동형. 생성하는 모든 bridge 를 여기 push 한다.
  const allBridges: Array<{ close: () => Promise<void> }> = [];
  const memoryBridge = await adaptClaudeMcpServer(createMemoryMcpServer(), "memory");
  // 3b — baseCwd=discoveryCwd(input.cwd ?? home) 주입 → 상대경로 기준점이 턴 cwd
  // (프로젝트). claude(SDK options.cwd) 와 대칭 = #2 parity(ADR 2026-07-06 §3b).
  const fileOpsBridge = await adaptClaudeMcpServer(
    createFileOpsMcpServer(discoveryCwd),
    "file-ops",
  );
  // V7.7 — 태스크 관리 (TodoWrite 동등). claude 는 SDK builtin, codex 만 등록.
  const todoBridge = await adaptClaudeMcpServer(createTodoMcpServer(), "todo");
  // 프로젝트 레지스트리 (register/list/update/forget) — 양 어댑터 공통(#2). 진실은
  // 각 폴더 PROJECT.md, 이 도구는 파싱→얇은 store 인덱스 upsert(단방향, 코어 무참조).
  const projectBridge = await adaptClaudeMcpServer(
    createProjectRegistryMcpServer(),
    "projects",
  );
  // V7.8 — invoke_skill 단일 정의(skill-registry) bridge. claude 어댑터도 동일
  // server 등록 (양 어댑터 공통, file-ops 중복 정의 제거 후 통일).
  // V9.3 — 싱글톤 → factory. cwd 는 위 스킬 인덱스(discoverSkills(discoveryCwd))와
  // 동일 소스로 호출 → 인덱스↔invoke cwd 정합(비대칭 해소). β: discoveryCwd = home 폴백.
  const skillBridge = await adaptClaudeMcpServer(
    createSkillInvokeMcpServer(discoveryCwd, {
      channel: input.channel,
      threadKey: input.threadKey,
      adapter: "codex",
    }),
    "skills",
  );
  // reply-intent — per-call factory. 무인자 도구 실행 시 클로저로 플래그 set
  // (bridge tool 이라 callTool → onCalled). 함수 지역 변수 → turn 별 격리 (contract §5.2).
  let replyToTrigger = false;
  const replyIntentBridge = await adaptClaudeMcpServer(
    createReplyIntentMcpServer(() => {
      replyToTrigger = true;
    }),
    "reply-intent",
  );
  // 런타임 유지보수 detect (2026-07-12, P1) — maintenance_status. 읽기전용·저위험 =
  // memory/projects/skills 와 동일 무조건 등록(claude/openai 와 parity, 계약서 §3.1).
  const maintenanceBridge = await adaptClaudeMcpServer(
    createMaintenanceMcpServer(),
    "maintenance",
  );
  // 무조건 생성되는 bridge 7종 등록 (close 누락 방지).
  allBridges.push(
    memoryBridge,
    fileOpsBridge,
    todoBridge,
    projectBridge,
    skillBridge,
    replyIntentBridge,
    maintenanceBridge,
  );
  // send-file — 네이티브 멱등 아웃바운드 전송 (claude 어댑터와 parity). per-turn
  // dedup Set(클로저 지역) → 같은 경로 재호출 시 실제 전송 차단(멱등 핵심).
  // 채널 전송 클로저가 있을 때만 bridge 생성 → undefined 면 미등록(도구 노출 0).
  const sentFiles = new Set<string>();
  const sendFileBridge =
    input.sendAttachment !== undefined
      ? await adaptClaudeMcpServer(
          createSendFileMcpServer(input.sendAttachment, sentFiles),
          "send-file",
        )
      : undefined;
  if (sendFileBridge !== undefined) allBridges.push(sendFileBridge);
  // prompt-options(축1, 2026-06-25) — 객관식 선택지 제시 (claude 어댑터와 parity).
  // per-turn dedup Set(클로저 지역) → 같은 질문 재호출 시 중복 렌더 차단. 채널 렌더
  // 클로저가 있을 때만 bridge 생성 → undefined 면 미등록(도구 노출 0). send-file 1:1 동형.
  const askedQuestions = new Set<string>();
  const promptOptionsBridge =
    input.presentOptions !== undefined
      ? await adaptClaudeMcpServer(
          createPromptOptionsMcpServer(input.presentOptions, askedQuestions),
          "prompt-options",
        )
      : undefined;
  if (promptOptionsBridge !== undefined) allBridges.push(promptOptionsBridge);
  // lean 도구 정책 (2026-06-15, architect §2a I-2). 중립 신호 toolPolicy 를 *codex
  // 도구 집합*(bridge MCP 도구들)에서 해석 — 도구명 매핑은 어댑터 안(추상 누수 0, I-3).
  //  - {mode:"none"}: bridge 도구 배열을 빈 배열로 → 도구 0 lean child.
  //    (= gemma 400 graceful·로컬 nano 경로 자연 해결, architect §2a.)
  //  - {mode:"allow"}: 정밀 allowlist 필터 후속(YAGNI §2a) — 안전 degrade = 전체 유지.
  //  - undefined: 현행 전체 도구 (회귀 0). openai/claude 동형 규칙(I-2).
  const toolsNone = input.toolPolicy?.mode === "none";

  // tool name → bridge 라우팅 테이블. function_call 도착 시 어느 server 의 도구인지 판별.
  const toolBridgeMap = new Map<string, typeof memoryBridge>();
  const mcpTools: Awaited<ReturnType<typeof memoryBridge.listTools>> = [];

  if (!toolsNone) {
    const memoryToolsRaw = await memoryBridge.listTools();
    const fileOpsToolsRaw = await fileOpsBridge.listTools();
    const todoToolsRaw = await todoBridge.listTools();
    const projectToolsRaw = await projectBridge.listTools();
    const skillToolsRaw = await skillBridge.listTools();
    const replyIntentToolsRaw = await replyIntentBridge.listTools();
    const maintenanceToolsRaw = await maintenanceBridge.listTools();

    for (const t of memoryToolsRaw) {
      toolBridgeMap.set((t as { name: string }).name, memoryBridge);
    }
    for (const t of fileOpsToolsRaw) {
      toolBridgeMap.set((t as { name: string }).name, fileOpsBridge);
    }
    for (const t of todoToolsRaw) {
      toolBridgeMap.set((t as { name: string }).name, todoBridge);
    }
    for (const t of projectToolsRaw) {
      toolBridgeMap.set((t as { name: string }).name, projectBridge);
    }
    for (const t of skillToolsRaw) {
      toolBridgeMap.set((t as { name: string }).name, skillBridge);
    }
    for (const t of replyIntentToolsRaw) {
      toolBridgeMap.set((t as { name: string }).name, replyIntentBridge);
    }
    for (const t of maintenanceToolsRaw) {
      toolBridgeMap.set((t as { name: string }).name, maintenanceBridge);
    }

    mcpTools.push(
      ...memoryToolsRaw,
      ...fileOpsToolsRaw,
      ...todoToolsRaw,
      ...projectToolsRaw,
      ...skillToolsRaw,
      ...replyIntentToolsRaw,
      ...maintenanceToolsRaw,
    );

    // send-file — 채널 전송 클로저가 있을 때만 등록 (claude 어댑터 조건부 주입과 parity).
    if (sendFileBridge !== undefined) {
      const sendFileToolsRaw = await sendFileBridge.listTools();
      for (const t of sendFileToolsRaw) {
        toolBridgeMap.set((t as { name: string }).name, sendFileBridge);
      }
      mcpTools.push(...sendFileToolsRaw);
    }

    // prompt-options(축1) — 채널 렌더 클로저가 있을 때만 등록 (claude 어댑터와 parity).
    if (promptOptionsBridge !== undefined) {
      const promptOptionsToolsRaw = await promptOptionsBridge.listTools();
      for (const t of promptOptionsToolsRaw) {
        toolBridgeMap.set((t as { name: string }).name, promptOptionsBridge);
      }
      mcpTools.push(...promptOptionsToolsRaw);
    }

    // V7.2.b — depth 0 turn 만 spawn_agent 등록. child(depth 1) 는 미등록 →
    // 재spawn 물리적 불가. runner = runOpenAiCodex 자기 자신 (circular 회피 인자 주입).
    if (depth === 0) {
      const spawnServer = createSpawnAgentMcpServer(input);
      const spawnBridge = await adaptClaudeMcpServer(spawnServer, "agents");
      allBridges.push(spawnBridge);
      const spawnToolsRaw = await spawnBridge.listTools();
      for (const t of spawnToolsRaw) {
        toolBridgeMap.set((t as { name: string }).name, spawnBridge);
      }
      mcpTools.push(...spawnToolsRaw);
    }

    // 백그라운드 워커 발사 도구 (2026-06-17) — run_in_background/list_workers.
    // depth 0(서브에이전트 아님) + workerDepth 0(워커 안 아님) turn 만 등록 →
    // 워커가 또 워커를 발사 불가(W-I5). spawn_agent depth 가드와 동형. claude/openai
    // 어댑터와 동일 의미(W-I3 — 어댑터 분기 0).
    if (depth === 0 && (input.workerDepth ?? 0) === 0) {
      const workerServer = createWorkerMcpServer(input);
      const workerBridge = await adaptClaudeMcpServer(workerServer, "workers");
      allBridges.push(workerBridge);
      const workerToolsRaw = await workerBridge.listTools();
      for (const t of workerToolsRaw) {
        toolBridgeMap.set((t as { name: string }).name, workerBridge);
      }
      mcpTools.push(...workerToolsRaw);
    }

    // 커스텀 HTTP 엔드포인트 등록/조회/삭제 도구 (2026-06-18) — register_endpoint/
    // list_endpoints/delete_endpoint. worker 와 *동일* 가드(이 블록은 !toolsNone 안 +
    // depth 0 && workerDepth 0). lean(none = restricted 엔드포인트 턴)이면 이 블록
    // 자체가 미실행 → 엔드포인트가 또 엔드포인트를 만드는 재귀 자연 차단. claude/openai
    // 와 동일 의미(어댑터 분기 0).
    if (depth === 0 && (input.workerDepth ?? 0) === 0) {
      const endpointServer = createEndpointToolsMcpServer();
      const endpointBridge = await adaptClaudeMcpServer(endpointServer, "endpoints");
      allBridges.push(endpointBridge);
      const endpointToolsRaw = await endpointBridge.listTools();
      for (const t of endpointToolsRaw) {
        toolBridgeMap.set((t as { name: string }).name, endpointBridge);
      }
      mcpTools.push(...endpointToolsRaw);
    }

    // 커스텀 슬래시 명령 등록/조회/삭제 도구 (2026-06-18) — register_command/
    // list_commands/delete_command. endpoint/worker 와 *동일* 가드(이 블록은 !toolsNone
    // 안 + depth 0 && workerDepth 0). lean(none) 이면 이 블록 자체가 미실행. claude/openai
    // 와 동일 의미(어댑터 분기 0). 슬래시 명령은 항상 prompt 라 mode 무관.
    if (depth === 0 && (input.workerDepth ?? 0) === 0) {
      const commandServer = createCommandToolsMcpServer();
      const commandBridge = await adaptClaudeMcpServer(commandServer, "commands");
      allBridges.push(commandBridge);
      const commandToolsRaw = await commandBridge.listTools();
      for (const t of commandToolsRaw) {
        toolBridgeMap.set((t as { name: string }).name, commandBridge);
      }
      mcpTools.push(...commandToolsRaw);
    }

    // 외부 MCP 등록 도구 (2026-07-07) — add/list/remove_mcp_server. command 와 동일 가드.
    // 파일(<home>/mcp.json)만 다룸. claude/openai 와 parity(#2). (실연결 브리지=Phase 2.)
    if (depth === 0 && (input.workerDepth ?? 0) === 0) {
      const mcpAdminBridge = await adaptClaudeMcpServer(
        createMcpAdminMcpServer(),
        "mcp-admin",
      );
      allBridges.push(mcpAdminBridge);
      const mcpAdminToolsRaw = await mcpAdminBridge.listTools();
      for (const t of mcpAdminToolsRaw) {
        toolBridgeMap.set((t as { name: string }).name, mcpAdminBridge);
      }
      mcpTools.push(...mcpAdminToolsRaw);
    }

    // ★외부 MCP 실연결(Phase 2, #2) — <home>/mcp.json 서버를 @mcp/sdk 클라이언트로 연결한
    // persistent 브리지 도구를 노출(claude 네이티브와 parity). ★allBridges 에 넣지 않는다
    // — 외부 브리지는 persistent(캐시)라 per-turn 일괄 close 대상이 아니다(연결 유지). depth0만.
    // 메인 턴(전역) 또는 프로젝트 위임 서브/워커(전역+프로젝트 <cwd>/.mcp.json — 지연연결 캐시).
    if ((depth === 0 && (input.workerDepth ?? 0) === 0) || isProjectMcpCwd(input.cwd)) {
      for (const extBridge of await getConnectedExternalMcpBridges(input.cwd)) {
        const extToolsRaw = await extBridge.listTools();
        for (const t of extToolsRaw) {
          toolBridgeMap.set((t as { name: string }).name, extBridge);
        }
        mcpTools.push(...extToolsRaw);
      }
    }

    // 자가 업데이트 도구 (2026-06-26) — update_self. command-tools 와 *동일* 가드
    // (depth 0 + workerDepth 0) — 워커/서브에이전트가 자가 업데이트 트리거 불가(재귀
    // 차단). 위험 로직 0(전부 runSelfUpdate). notify 좌표는 현재 turn 의 channel/threadKey
    // 에서 도출 — 재시작 후 부팅이 요청자에게 "완료" 회신. claude/openai 와 parity(#2).
    if (depth === 0 && (input.workerDepth ?? 0) === 0) {
      const updateSelfServer = createUpdateSelfMcpServer(
        notifyDestFromCoords(
          input.channel,
          input.threadKey,
          input.channelAddress,
        ),
      );
      const updateSelfBridge = await adaptClaudeMcpServer(
        updateSelfServer,
        "update-self",
      );
      allBridges.push(updateSelfBridge);
      const updateSelfToolsRaw = await updateSelfBridge.listTools();
      for (const t of updateSelfToolsRaw) {
        toolBridgeMap.set((t as { name: string }).name, updateSelfBridge);
      }
      mcpTools.push(...updateSelfToolsRaw);
    }

    // V7.5 (parity P0 fix) — extraMcpServers 도 bridge. router 가 facade 통해
    // plugin MCP (scheduler/file-watch 의 add_schedule 등, getRegisteredMcpServers())
    // 를 전달하는데 codex 어댑터가 그간 무시 → plugin 생태가 codex 모드에서 끊김.
    // claude 어댑터 mcpServers spread 와 동등 (LLM-agnostic parity).
    for (const [name, server] of Object.entries(input.extraMcpServers ?? {})) {
      const extraBridge = await adaptClaudeMcpServer(server, name);
      allBridges.push(extraBridge);
      const extraToolsRaw = await extraBridge.listTools();
      for (const t of extraToolsRaw) {
        toolBridgeMap.set((t as { name: string }).name, extraBridge);
      }
      mcpTools.push(...extraToolsRaw);
    }

    // find_capabilities (P1, capability-awareness contract §3c) — 여기까지 채운
    // toolBridgeMap 의 bridge 들이 *이번 턴 실제 활성* 서버 집합(게이트-aware, 병렬
    // static list 0 — §3b). skills 와 동일하게 depth 무관 + !toolsNone 만 게이트.
    // 자기 자신은 아직 등록 전이라 활성 목록에 안 잡힘(§3d, 순환 없음). claude/openai
    // 와 parity — 동일 팩토리·동일 카탈로그, 이 어댑터 몫은 activeNames 주입뿐(분기 0).
    const capabilityActiveNames = [
      ...new Set([...toolBridgeMap.values()].map((b) => b.name)),
    ];
    const findCapabilitiesBridge = await adaptClaudeMcpServer(
      createFindCapabilitiesMcpServer(
        capabilityActiveNames,
        undefined,
        input.extraMcpServers,
      ),
      "find-capabilities",
    );
    allBridges.push(findCapabilitiesBridge);
    const findCapabilitiesToolsRaw = await findCapabilitiesBridge.listTools();
    for (const t of findCapabilitiesToolsRaw) {
      toolBridgeMap.set((t as { name: string }).name, findCapabilitiesBridge);
    }
    mcpTools.push(...findCapabilitiesToolsRaw);
  }

  const functionTools = convertMcpToolsToResponsesTools(
    mcpTools as ReadonlyArray<{
      name: string;
      description?: string;
      inputSchema?: unknown;
    }>,
  );

  // V7.6 (parity P1) — codex backend native web_search tool. claude 어댑터는
  // SDK builtin WebSearch 제공, codex 는 그간 WebFetch 만 → parity 갭. OpenClaw
  // `buildCodexNativeWebSearchTool` (codex-native-web-search.shared.ts L145-167)
  // 답습 — payload tools 에 `{type:"web_search"}` 추가 시 backend 가 자체 검색
  // (function_call 흐름 안 거침, backend internal). dep 0 · API 키 0.
  // env CODEX_WEB_SEARCH="0"/"false" 시 opt-out (backend 거부 등 비상 가드).
  // lean(toolsNone) child 는 native web_search 도구도 미부착 (도구 0 = 진짜 lean,
  // 도구 미지원 모델 graceful). bridge 도구 배열 빈 처리와 동일 의도 — architect §2a.
  const webSearchEnabled =
    !toolsNone &&
    process.env.CODEX_WEB_SEARCH !== "0" &&
    process.env.CODEX_WEB_SEARCH !== "false";
  const responsesTools = webSearchEnabled
    ? [...functionTools, { type: "web_search" as const }]
    : functionTools;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "OpenAI-Beta": "responses=experimental",
    originator: "codex_cli_rs",
  };
  if (accountId) headers["chatgpt-account-id"] = accountId;

  // V5.3 payload — V5.1' 6 필드 + tools 1 필드 = 7 필드.
  // V5.1' 금지 목록 정합 유지: text · prompt_cache_retention · parallel_tool_calls ·
  // tool_choice · truncation · max_output_tokens · store:true 박지 않음.
  // OpenClaw `buildOpenAIResponsesParams` L802-844 답습 — `params.tools = convert...(tools)`.

  // V5.3 agentic loop — function_call 발생 → callTool → function_call_output input 에 push
  // → 다음 turn 재요청. 절대 상한 = CODEX_MAX_TOOL_ITERATIONS_HARD(런어웨이 최후 방어),
  // CODEX_MAX_TOOL_ITERATIONS 는 soft checkpoint 간격(진행 nudge).
  let finalText = "";
  let finalResponseId: string | undefined;
  // /status 개편 — 마지막 turn 의 usage 보존 (마지막 turn = 가장 큰 누적 input →
  // "얼마나 찼나" 의 정확 proxy). usage 미캡처 turn 은 갱신 안 함 (graceful).
  let finalUsage:
    | { inputTokens: number; outputTokens: number; reasoningTokens?: number }
    | undefined;
  let iteration = 0;
  // llm.activity — 어댑터 로컬 단조 시퀀스 (iteration 가로질러 누적). nonce 아님.
  let activitySeq = 0;
  const bus = getEventBus();

  // llm.delta — 토큰 스트리밍 fan-out(보조 점증 렌더). depth-0 가드: 메인 답변만 발행
  // (서브에이전트/워커 depth>0 turn 은 out 도 안 내므로 화면 버블 대상 아님 = no-op).
  // codex SSE delta 는 토큰 단위(고빈도) → coalescer 가 ~80ms∥120자로 묶음. seq 는
  // iteration 가로질러 단조(activitySeq 동형). parseCodexSse 의 onTextDelta 콜백으로 push,
  // 각 iteration SSE 소비 후 flush(도구 실행 전 잔여 발행).
  const deltaStream = createDeltaStream({
    enabled: depth === 0 && (input.workerDepth ?? 0) === 0,
    channel: input.channel,
    threadKey: input.threadKey,
    adapter: "codex",
    model,
  });
  // 대시보드 인터리브(2026-07-13) — codex 는 도구가 iteration SSE 완전 소비 후 사후
  // 일괄 발행되는 구조라(실현가능성 감사 `_workspace/interleave_region_feasibility.md`
  // §1) claude/openai 처럼 "그 도구 직전"에 못 닫는다. 대신 "iteration 확정 완료"
  // 시점(sseResult destructure 직후, toolCalls 발행 루프 진입 직전)에 그 iteration
  // 이 흘린 텍스트를 kind:"text" 로 닫는다 — iteration 단위 인터리브(문서화된 degrade,
  // 실전 트래픽은 사실상 완전 충실도). seq 는 도구와 같은 activitySeq 카운터.
  // ★stall 재시도가 도는 finally(위 progressTimer.done() 옆)에는 넣지 않는다 — 재시도
  // 중간에 닫으면 진행 중 텍스트가 유실/중복될 위험(감사 §3 명시 경고).
  const closeTextSegment = (): void => {
    const text = deltaStream.closeSegment();
    if (text === undefined) return; // 빈 세그먼트 — no-op.
    const segSeq = activitySeq++;
    try {
      bus.publish({
        type: "llm.activity",
        ts: Date.now(),
        payload: {
          channel: input.channel,
          threadKey: input.threadKey,
          adapter: "codex",
          model,
          seq: segSeq,
          kind: "text",
          label: "text",
          text,
        } satisfies RegionAActivityPayload,
      });
    } catch {
      /* 관측 발행 실패가 turn 을 무르지 않는다(원칙 3). */
    }
  };
  // ★워커/서브에이전트 서술 트레이스 (2026-07-03) — deltaStream(대시보드 fan-out)은 depth-0
  // 전용이라 워커(workerDepth>0)·서브에이전트(depth>0) 서술이 그간 어디에도 안 남아 사후
  // 진단 불가였다(실측: 워커 크롤/루프를 델타 미영속으로 확인 못 함). event-persist 의
  // stream-trace 는 llm.delta(=depth-0만 발행)를 보므로 그것도 워커를 못 잡는다. → deltaStream
  // 이 *꺼진* 턴에서만(중복 회피) 서술을 coalesce 해 `[stream-trace]` 로그로 남긴다. 로그 전용
  // (events DB 미기록 — 보존 오염 0, event-persist 정책과 동일). 형식도 event-persist 와 동형.
  const traceDelta = !(depth === 0 && (input.workerDepth ?? 0) === 0);
  let traceBuf = "";
  let traceTotal = 0;
  const traceFlush = (reason: string): void => {
    if (!traceDelta || traceBuf === "") return;
    const tail = traceBuf.length > 400 ? `…${traceBuf.slice(-400)}` : traceBuf;
    console.log(
      `[stream-trace] ${input.threadKey} total=${traceTotal} +${traceBuf.length}(${reason}) tail: ${tail
        .replace(/\s+/g, " ")
        .slice(-140)}`,
    );
    traceBuf = "";
  };
  const tracePush = (delta: string): void => {
    if (!traceDelta) return;
    traceBuf += delta;
    traceTotal += delta.length;
    if (traceBuf.length >= 1500) traceFlush("chunk");
  };
  // persistence 보강 (2026-05-27, contract Q3 + recon §5):
  //  - finalFlushRequested: 절대 백스톱(HARD)-1 도달 시 set(또는 empty-break cap 소진 시).
  //    다음 turn 은 tools 비우고 "마무리 텍스트만" 요청 → 도구 한도 도달해도 빈 finalText 격감.
  //  - emptyBreakRetries: 모델이 도구 0 + 텍스트 0 으로 조기 종료(gpt 계열 성향)할 때
  //    "끝났으면 답을, 아니면 계속" nudge 를 1회 재요청. 무한 재요청 방어 cap=1.
  let finalFlushRequested = false;
  // 2026-06-05 (C+) — finalFlush turn 자체도 빈 텍스트 종료하는 경우 1회 더 강한 nudge
  //  로 재시도. 기존엔 flush 응답이 비어도 즉시 break → fallback 메시지로 떨어졌음.
  //  postFlushRetry 1회 한정 (재시도 무한 방지 — flag 한 번 set 되면 다음엔 break).
  let postFlushRetryUsed = false;
  // 2026-07-03 soft checkpoint — 같은 iteration 에서 진행 nudge 를 두 번 push 하지 않도록
  //  마지막으로 nudge 를 낸 iteration 을 기록(무한 중복 방지 가드). checkpoint nudge 는
  //  iteration++ 를 하지 않으므로(슬롯 대체 아님) 이 가드 없이는 같은 값에서 재진입할 수
  //  있다 — 하지만 실제로는 nudge 후 반드시 도구 turn 이 돌아 iteration 이 오르므로 안전판.
  let lastCheckpointIteration = -1;
  let emptyBreakRetries = 0;
  // 2026-06-05 — cap 1→2. gpt 계열 빈 응답이 1회 nudge 로도 안 풀리는 케이스가 관측돼
  //  여유 1회 더. 강화된 nudge(아래)와 합쳐 빈 fallback 발생률 추가 감소.
  const MAX_EMPTY_BREAK_RETRIES = 2;
  // codex empty-response fix (2026-05-24) — 부작용 도구 실행 플래그.
  // file-ops 3종(Read/Glob/Grep)은 읽기전용이라 무해(재실행 안전). 그 외 bridge —
  // memory(add/update/delete_memory), todo(update_todos), spawn_agent(agents),
  // skills(invoke_skill), extraMcpServers(plugin 예: scheduler add_schedule) — 은
  // 부작용을 낸다. 하나라도 실행되면 풀 폴백(claude) 재실행이 턴을 처음부터 다시 돌려
  // 중복 부작용을 낸다. 따라서 부작용 도구가 한 번이라도 실행됐으면 최종 빈 텍스트여도
  // throw 금지(중복 회피) — 대신 정직한 fallback 텍스트 반환. 부작용 0(순수 읽기/빈 턴)
  // 일 때만 throw 해 안전하게 풀 폴백 유도.
  let sideEffectExecuted = false;
  // 2026-06-05 — agentic loop 중 *성공적으로 실행된* MCP 도구 이름 누적. 빈 응답 nudge
  //  와 fallback 메시지에 사용 (사용자가 텔레그램 응답에서 "방금 무엇을 했는지" 즉시 인지).
  //  Set 이라 중복 자동 제거 — 같은 도구 N번 실행도 1개로 노출 (이름 노출이 목적).
  const executedToolNames = new Set<string>();
  // 2026-06-07 — 무해(claude 폴백 안전) 도구 명시 화이트리스트. 이전엔 `bridge !==
  //  fileOpsBridge` 로 분류했는데 (a) Edit/Write/Bash 도 같은 fileOpsBridge 라 부작용
  //  도구가 무해로 잘못 분류, (b) reply_to_current_message · update_todos 는 turn-local
  //  /플래그라 무해인데 부작용으로 잘못 분류 → 0:10·0:12 fallback 오발화. 이름 기반
  //  정밀 분류로 교체:
  //    무해: 읽기 도구 (Read/Glob/Grep/WebFetch/WebSearch) + turn-local 도구
  //          (reply_to_current_message/update_todos).
  //    부작용: Edit·Write·Bash · 메모리 CRUD · spawn_agent · invoke_skill · 외부 플러그인.
  //    Bash 는 명령에 따라 무해할 수 있으나 (ls/git status) git commit·rm 류 재실행 중복
  //    위험이 더 크므로 보수적 분류 (부작용).
  //  화이트리스트 외 도구는 부작용으로 간주 (외부 플러그인 도구·미등록·신규 능력 안전).
  const HARMLESS_TOOLS = new Set<string>([
    "Read",
    "Glob",
    "Grep",
    "WebFetch",
    "WebSearch",
    "reply_to_current_message",
    "update_todos",
  ]);

  try {
    while (iteration < CODEX_MAX_TOOL_ITERATIONS_HARD) {
      // 2층 도구 루프 가드 (TT-I6, §4.4 #1) — iteration 진입(다음 LLM 호출) 직전 체크.
      // codex 는 수동 agentic 루프라 callTool 에 signal 이 안 들어간다(MCP 한계). 직전
      // iteration 의 도구 1개가 행이었어도 *그 도구가 반환하면* 여기서 다음 fetch 진입을
      // 막아 루프 폭주를 차단한다. reason(TurnTimeoutError)을 throw → 바깥 catch(§4.4)가
      // sideEffectExecuted 따라 안전 처리. 어댑터 *내부* abort 전파(facade 분기 아님).
      if (input.abortSignal?.aborted) throw input.abortSignal.reason;
      const body: Record<string, unknown> = {
        model,
        // persistence 보강 — 공유 헌법 + codex 전용 persistence delta (claude 무영향).
        // 중립 override(게이트웨이) 지정 시 그 값이 instructions — 헌법·persistence 대체.
        instructions:
          input.systemPromptOverride ?? `${SYSTEM_PROMPT}\n${CODEX_PERSISTENCE_PROMPT}`,
        input: inputArray,
        stream: true,
        store: false,
        prompt_cache_key: input.threadKey,
        // persistence 보강 — final-flush turn 은 tools 를 비워 모델이 도구 못 부르고
        // 텍스트만 내게 강제 (빈 응답 근절). V5.1' 금지 목록(parallel_tool_calls·
        // tool_choice 등)은 절대 안 박음 — tools:[] 만으로 도구 사용을 차단(OpenClaw 답습
        // payload shape 보존). 🔬 라이브 검증 필요: codex backend 가 `tools: []` 를
        // 거부하면(거부 시 res.ok=false → throw → 풀 폴백) 대안 = tools 키 omit. 현재는
        // 빈 배열 우선 (function tools shape 와 동일 키 보존, 안전한 1차 시도).
        tools: finalFlushRequested ? [] : responsesTools,
      };
      // 가설 A (2026-06-07): finalFlush turn 에서 reasoning.effort=minimal 강제.
      //  ChatGPT 백엔드 기본 = medium. medium 은 reasoning 토큰을 충분히 소비해 final
      //  output_text 슬롯이 0자로 끝나는 케이스가 관측됨 (0:10·0:12 fallback 사례).
      //  마지막 마무리 슬롯은 *생각* 이 아니라 *텍스트 출력* 이 목적이므로 reasoning
      //  최소화 → 텍스트 슬롯 확보. 일반 도구 호출 turn (~iteration cap-1) 은 기본값
      //  유지 (도구 인자 추론 품질 보존).
      //  ⚠️ 2026-06-11 회귀 수정: gpt-5.5 는 'minimal' 미지원(400 unsupported_value —
      //   'minimal' 은 gpt-5 전용, 5.1+ 에서 'none' 으로 대체). finalFlush 의도(reasoning
      //   0 → 텍스트 슬롯 최대)와도 'none' 이 정확히 일치. 지원값: none/low/medium/high/xhigh.
      if (finalFlushRequested) {
        body.reasoning = { effort: "none" };
      }

      if (process.env.CODEX_DEBUG_INPUT === "1") {
        console.error(
          `[codex-oauth debug] input turns=${inputArray.length} iteration=${iteration} threadKey=${input.threadKey}`,
        );
        console.error(
          `[codex-oauth debug] input body=${JSON.stringify(inputArray, null, 2).slice(0, 4000)}`,
        );
      }

      // 유휴 타임아웃 — iteration(LLM 스트림 1회)마다 새 ac/timer (I-4: 도구 실행
      // 구간은 timer.done() 후라 타임아웃 대상 아님). fetch 에 signal 주입(현재 미주입 =
      // ~20분 행의 직접 원인) + parseCodexSse chunk 수신마다 heartbeat. abort 시 undici
      // reader.read() 가 reject → parseCodexSse throw → 아래 catch 가 IdleTimeoutError 로.
      // codex 는 resume 없음 → 매 iteration 전체 input 재전송. 단일 stringify 로 sizing +
      // fetch body 둘 다 사용(이중 직렬화 회피). 스톨 재개 시 같은 body 를 재전송한다.
      const bodyJson = JSON.stringify(body);
      // 무진전(no-progress) 감지 + 같은 컨텍스트 스텝 재개 (ADR 2026-07-02). ★메인·워커
      // 한방향 — codex 스핀은 워커뿐 아니라 메인 인터랙티브 턴도 때리므로 분기 없이 통일.
      // 타이머는 *진전 이벤트(output_text.delta·function_call)에만* reset(onProgress) —
      // response.in_progress heartbeat 로는 reset 안 됨. 그래서 답/도구가 흐르면(진전) 아무리
      // 길어도 안 잘리고, in_progress 만 N분(dead=무바이트 포함) = 진짜 무진전만 컷 → 같은
      // body(=같은 대화 컨텍스트)로 재개(이전 완료 스텝은 inputArray 보존). 타이머는 스트림
      // (fetch) 단위 + 도구 실행 전 done()(finally) 이라 긴 도구 오살 0. per-iteration idleAc
      // 발화는 turn/워커 예산(input.abortSignal)과 별개라 재개에 예산이 남는다. 모델 폴백 아님.
      let sseResult: CodexSseResult;
      let stallAttempt = 0;
      for (;;) {
        const idleAc = new AbortController();
        // no-progress 타이머 — onProgress(진전)에만 beat. abort 시 linkAbort 가 fetch signal 로.
        const progressTimer = createIdleTimer(idleAc, {
          idleMs: CODEX_NO_PROGRESS_MS,
          firstMs: CODEX_NO_PROGRESS_MS,
        });
        // trickle 가드 — 단일 SSE 턴 절대 wall-clock 캡(리셋 안 됨). progressTimer(진전마다
        // 리셋)와 직교: 델타가 찔끔찔끔 흘러 progressTimer 가 영영 안 터지는 trickle 를 잡는다.
        // 초과 시 idleAc 를 IdleTimeoutError("idle") 로 abort → effectiveAc(linkAbort) 전파 →
        // fetch/parseCodexSse throw → 기존 catch 의 IdleTimeoutError 분기가 *같은 컨텍스트 재개*
        // (실패 아님). turnWallExceeded 는 catch 에서 dead/spinning 과 trickle 을 구분(관측).
        let turnWallExceeded = false;
        const turnWallTimer = setTimeout(() => {
          turnWallExceeded = true;
          if (!idleAc.signal.aborted) {
            idleAc.abort(new IdleTimeoutError("idle", CODEX_TURN_MAX_MS));
          }
        }, CODEX_TURN_MAX_MS);
        (turnWallTimer as { unref?: () => void }).unref?.();
        // 계측 — 이 iteration 스트림의 청크 수·마지막청크 시각 (dead=chunks0 vs spinning 판별).
        let iterChunks = 0;
        let iterLastChunkAt = 0;
        const iterStart = Date.now();
        // 2층 합성 (TT-I2) — 1층 idle AC 와 핸들러 turn signal 을 OR 결합해 fetch signal 로.
        const effectiveAc = linkAbort(idleAc.signal, input.abortSignal);
        try {
        // 전송 견고성 retry — *초기 fetch + res.ok 확인*만 감싼다. parseCodexSse
        // (SSE 스트림 소비)는 retry 밖(스트림 중간 실패 재시도는 별개). transient 만
        // 재시도: (a) fetch 자체 throw(전송 실패), (b) status ∈ {429,500,502,503,504}.
        // 4xx(429 제외)는 진짜 에러 → 즉시 throw. cause 보존(throw fe — 원본 그대로).
        // abort 된 fetch 는 transient 아님(IdleTimeoutError) → retry 대상 아님(throw).
        let res: Response;
        let attempt = 0;
        while (true) {
          try {
            res = await fetch(`${CODEX_BASE_URL}/responses`, {
              method: "POST",
              headers,
              body: bodyJson,
              signal: effectiveAc.signal,
            });
          } catch (fe) {
            // 유휴(1층)·턴(2층) abort 면 retry 금지(즉시 해당 에러 승격) — first 타임아웃이
            // 연결 스톨을 잡는 경로, 턴 백스톱은 전체 중단. 그 외 전송 실패만 기존 retry.
            const reason = effectiveAc.signal.reason;
            if (
              effectiveAc.signal.aborted &&
              (reason instanceof IdleTimeoutError ||
                reason instanceof TurnTimeoutError)
            ) {
              throw reason;
            }
            if (attempt < CODEX_FETCH_MAX_RETRIES) {
              await sleep(CODEX_FETCH_BACKOFF_MS[attempt]);
              attempt += 1;
              continue;
            }
            throw fe;
          }
          if (
            !res.ok &&
            RETRIABLE_STATUS.has(res.status) &&
            attempt < CODEX_FETCH_MAX_RETRIES
          ) {
            await sleep(CODEX_FETCH_BACKOFF_MS[attempt]);
            attempt += 1;
            continue;
          }
          break;
        }
        if (!res.ok) {
          throw new Error(
            `Codex backend 호출 실패: ${res.status} ${await res.text().catch(() => "")}`,
          );
        }
        if (res.body === null) {
          throw new Error("Codex backend response.body 가 null — SSE 스트림 부재.");
        }

        sseResult = await parseCodexSse(
          res.body,
          () => {
            // onChunk — 계측만(진전 아님, 타이머 beat X). in_progress heartbeat 도 여기 잡힘.
            iterChunks += 1;
            iterLastChunkAt = Date.now();
          },
          (delta) => {
            deltaStream.push(delta); // llm.delta fan-out (coalesce → publish, depth-0).
            tracePush(delta); // 워커/서브에이전트 서술 로그 트레이스(deltaStream 꺼진 턴만).
          },
          () => progressTimer.beat(), // onProgress — 실제 output/tool = 진전 → 타이머 reset.
        );
        break; // 스트림 소비 성공 → 재시도 루프 탈출.
      } catch (e) {
        // abort 가 유휴(1층)·턴(2층) 타임아웃이면 해당 에러로 승격 (facade 일관 신호,
        // 둘 다 비매칭 — I-3/TT-I3). reason 은 linkAbort 가 effectiveAc 로 보존.
        // sideEffectExecuted 시 throw 대신 fallback 텍스트는 함수 바깥 catch (§4.4)에서.
        const reason = effectiveAc.signal.reason;
        // 무진전(IdleTimeoutError = no-progress 타이머)이고 워커/턴 예산이 아직 살아있고
        // 재시도 여유가 있으면 → turn 을 죽이지 말고 *같은 body(같은 대화 컨텍스트)로* 스텝
        // 재개(모델 폴백 아님). 계측을 로그·이벤트로 남겨 dead(chunks=0) vs spinning(chunks>0,
        // in_progress 만 흐름)을 드러낸다.
        if (
          reason instanceof IdleTimeoutError &&
          stallAttempt < CODEX_STALL_MAX_RETRIES &&
          input.abortSignal?.aborted !== true
        ) {
          stallAttempt += 1;
          const iterSec = Math.round((Date.now() - iterStart) / 1000);
          const lastChunkAgoSec =
            iterLastChunkAt > 0
              ? Math.round((Date.now() - iterLastChunkAt) / 1000)
              : -1;
          // turnWallExceeded 면 trickle(느리게 흐르다 wall-clock 캡 초과) — dead/spinning
          // (progressTimer 발화)과 구분해 관측 정확성 확보. resume 동작은 세 경우 모두 동일.
          const kind = turnWallExceeded
            ? "trickle"
            : iterChunks > 0
              ? "무진전(spinning)"
              : "무응답(dead)";
          const eventKind = turnWallExceeded
            ? "trickle"
            : iterChunks > 0
              ? "spinning"
              : "dead";
          console.warn(
            turnWallExceeded
              ? `codex 턴 wall-clock 상한 초과(trickle, ${
                  Date.now() - iterStart
                }ms; chunks=${iterChunks}, iteration=${iteration}, thread=${input.threadKey}) — 같은 컨텍스트로 스텝 재개 ${stallAttempt}/${CODEX_STALL_MAX_RETRIES}`
              : `codex ${kind} (chunks=${iterChunks}, iter=${iterSec}s, 마지막청크 ${
                  lastChunkAgoSec < 0 ? "없음" : `${lastChunkAgoSec}s 전`
                }, iteration=${iteration}, thread=${input.threadKey}) — 같은 컨텍스트로 스텝 재개 ${stallAttempt}/${CODEX_STALL_MAX_RETRIES}`,
          );
          try {
            bus.publish({
              type: "llm.stream_stall",
              ts: Date.now(),
              payload: {
                channel: input.channel,
                threadKey: input.threadKey,
                adapter: "codex",
                model,
                iteration,
                kind: eventKind,
                trickle: turnWallExceeded,
                chunks: iterChunks,
                iterMs: Date.now() - iterStart,
                lastChunkAgoMs:
                  iterLastChunkAt > 0 ? Date.now() - iterLastChunkAt : -1,
                attempt: stallAttempt,
                maxRetries: CODEX_STALL_MAX_RETRIES,
              },
            });
          } catch {
            /* 관측 발행 실패는 재개를 막지 않는다. */
          }
          // progressTimer.done()·deltaStream.flush() 는 아래 finally 가 continue 시에도 수행.
          await sleep(CODEX_STALL_BACKOFF_MS);
          continue; // 같은 body 로 iteration 재시도.
        }
        if (
          effectiveAc.signal.aborted &&
          (reason instanceof IdleTimeoutError ||
            reason instanceof TurnTimeoutError)
        ) {
          throw reason;
        }
        throw e;
      } finally {
        // 타이머 누수 0 (I-6) + 도구 실행 구간 진입 전 해제 (I-4 — LLM 스트림만 대상).
        progressTimer.done();
        // trickle 가드 타이머도 매 iteration 정리(재시도 루프라 매번 새로 무장·정리 → 누수 0).
        clearTimeout(turnWallTimer);
        // 이 iteration SSE 잔여 델타 flush(도구 실행/다음 iteration 전 발행) + 타이머 정리.
        // best-effort — 실패해도 out 전체본이 권위 교체. seq 는 다음 iteration 으로 단조 유지.
        deltaStream.flush();
        traceFlush("iter"); // 워커 서술 트레이스도 iteration 경계마다 flush(길게 끄는 턴도 로그).
      }
      }
      const { text, responseId, toolCalls, usage } = sseResult;
      if (usage !== undefined) finalUsage = usage;
      // 이 iteration 이 흘린 텍스트를 kind:"text" 로 닫는다 — "iteration 확정 완료"
      // 시점(재시도 루프 아님, 여기 도달 = SSE 완전 소비·결과 확정)에서, 이번 iteration
      // 의 toolCalls 보다 앞선 seq 를 받게 도구 발행 루프 진입 전에 닫는다.
      closeTextSegment();
      // llm.activity — 모델이 호출하려는 도구당 1 activity (실행 성공/실패 무관,
      // 의도 시점이 곧 "무엇을 하려는 중"). callTool 실행 루프와 별개. final-flush(tools:[])
      // turn 은 toolCalls 가 비어 자연히 0 publish.
      // 실행시간(#3) — callId → 그 도구의 activity seq. 아래 callTool 병렬 실행이 완료 시
      // phase:"end"+durationMs 를 같은 seq 로 발행(대시보드가 시작 스텝에 실행시간 주석).
      const callIdToSeq = new Map<string, number>();
      for (const tc of toolCalls) {
        const seq = activitySeq++;
        if (tc.callId) callIdToSeq.set(tc.callId, seq);
        // detail — function_call arguments(partialJson) 에서 중립 인자 요약(축3 사이드바).
        bus.publish({
          type: "llm.activity",
          ts: Date.now(),
          payload: {
            channel: input.channel,
            threadKey: input.threadKey,
            adapter: "codex",
            model,
            seq,
            kind: "tool",
            label: tc.name || "tool",
            detail: buildActivityDetailFromJson(tc.partialJson),
            ...(() => {
              const diff = buildActivityDiffFromJson(tc.name || "tool", tc.partialJson);
              return diff !== undefined ? { diff } : {};
            })(),
          } satisfies RegionAActivityPayload,
        });
      }
      // codex empty-response fix (2026-05-24) Fix 1 — 텍스트 누적 (덮어쓰기 제거).
      // 기존 `finalText = text` 는 매 iteration 덮어써서, iteration 1 이 텍스트+도구호출을
      // 내고 도구 실행 후 iteration 2 가 reasoning 만 하고 빈 메시지면 앞 텍스트가 소실 →
      // 빈 응답. 비지 않은 turn 텍스트만 누적해 도구 루프 중간 텍스트("확인할게요")와 최종
      // 텍스트를 보존하고, 빈 턴이 앞 텍스트를 지우지 못하게 한다.
      if (text !== "") {
        finalText = finalText === "" ? text : `${finalText}\n\n${text}`;
      }
      if (responseId !== undefined) finalResponseId = responseId;

      // 2026-06-11 (Fix 2 — 가설 B) — nudge 에 사용자 원 입력 재주입. 큰 컨텍스트
      //  (216k+) 안에서 짧은 입력("어 진행해") 이 묻혀 모델이 "결국 뭘 답해야" 하는지
      //  잃는 케이스 관측. nudge 마다 input.text 다시 보여줘 의도 고정.
      const userTextEcho = `사용자가 이렇게 물었습니다: "${input.text.slice(0, 200)}".`;
      const ranListMsg =
        executedToolNames.size > 0
          ? ` 이번 턴에 이미 실행한 도구: ${[...executedToolNames].join(", ")}.`
          : "";

      // persistence 보강 — final-flush turn 의 응답을 받았으면 종료. tools:[] 였으므로
      // 모델은 텍스트만 냈을 것 (위 누적에 반영됨). flush 턴인데도 도구를 시도했더라도
      // 실행하지 않고 방어적 종료 — 무한 루프 0 보장.
      // 2026-06-05 (C+) — flush turn 도 빈 텍스트면 fallback 으로 직행하기 전에 1회 더
      //  강한 nudge 로 재시도. tools:[] 유지(flag true) → 도구 우회 불가. 1회 한정.
      if (finalFlushRequested) {
        if (finalText === "" && text === "" && !postFlushRetryUsed) {
          postFlushRetryUsed = true;
          inputArray.push({
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: `**FINAL CHANCE** — ${userTextEcho} 도구 호출 0 으로 강제된 마지막 슬롯도 빈 텍스트로 끝났습니다.${ranListMsg} 지금 응답 텍스트를 작성하지 않으면 사용자에게 fallback 메시지("요약 텍스트 생성 실패")가 전송됩니다. 도구 사용 없이 *반드시* 1~3 줄로 위 질문에 직접 답하세요 — 빈 응답 절대 금지.`,
              },
            ],
          });
          continue;
        }
        break;
      }

      // 도구 호출 0 — 모델이 도구 없이 turn 종료.
      if (toolCalls.length === 0) {
        // persistence 보강 (recon §5) — 도구 0 + 텍스트 0 (gpt 계열 조기 종료 성향:
        // reasoning 만 하거나 "이제 끝" 신호로 빈 turn) + 누적 텍스트도 0 + 재요청 여유 →
        // "끝났으면 답을, 아니면 계속" nudge. 텍스트가 조금이라도 있으면(중간 보고)
        // nudge 0 — 정상 종료로 취급(과도 재요청 회피).
        if (text === "" && finalText === "") {
          if (emptyBreakRetries < MAX_EMPTY_BREAK_RETRIES) {
            emptyBreakRetries += 1;
            // 2026-06-05/06-11 — nudge 에 실행 도구 목록 + 사용자 원 입력 재주입.
            inputArray.push({
              type: "message",
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: `당신의 마지막 응답이 비어있습니다 — 사용자에게 *반드시* 텍스트 답변이 필요합니다. ${userTextEcho}${ranListMsg} 작업이 끝났으면 위 질문에 답하는 형식으로 1~3 줄 요약. 아직 작업이 남았으면 도구로 계속 진행하세요. 빈 응답은 금지.`,
                },
              ],
            });
            iteration += 1;
            continue;
          }
          // 2026-06-11 (Fix 1) — emptyBreak cap 도달했는데도 빈 응답 → 그냥 break 하면
          //  finalFlush 우회한 채 fallback 직행. 대신 finalFlush 로 강제 전환 (tools:[]
          //  + reasoning minimal + FINAL-CHANCE 류 nudge). 마지막 안전망까지 거치게.
          //  이미 flush 트리거됐으면 (위 분기에서) 그냥 break.
          if (!finalFlushRequested) {
            finalFlushRequested = true;
            inputArray.push({
              type: "message",
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: `당신은 빈 응답을 ${MAX_EMPTY_BREAK_RETRIES} 회 연속으로 냈습니다. 이번엔 도구가 금지됐고 (tools:[]) 이게 *마지막 기회* 입니다. ${userTextEcho}${ranListMsg} 도구 없이 위 질문에 1~3 줄로 직접 답하세요 — 빈 응답 금지.`,
                },
              ],
            });
            continue;
          }
        }
        break;
      }

      // persistence 보강 (contract Q3) — 절대 백스톱(HARD ceiling)-1 도달: 이번 turn 의
      // 도구는 실행하지 않고 "도구 한도 도달, 마무리하라" system note 를 박은 뒤 다음
      // turn 을 tools:[] 로 돌려 마무리 텍스트만 받는다. 도구를 실행하면 백스톱 안에 또
      // 도구 turn 이 끼어 마무리 기회를 잃으므로, 마지막 슬롯은 마무리 전용으로 비운다.
      //
      // ★2026-07-03 재타겟: 이 강제 마무리 트리거를 CODEX_MAX_TOOL_ITERATIONS(옛 25 cap)
      // 에서 CODEX_MAX_TOOL_ITERATIONS_HARD(절대 백스톱, 기본 150)-1 로 옮겼다. 즉 강제
      // "tools:[] 마무리"는 *절대 백스톱에서만* 발동하고 일상에선 도달하지 않는다 — 정당한
      // 긴 작업은 모델의 자연 종료(toolCalls.length===0 → break)로 완주한다. flush
      // 메커니즘(tools:[]·reasoning none·postFlushRetry·nudge)은 그대로, 트리거 지점만 이동.
      //
      // ⚠ iteration 을 *증가시키지 않는다* — flush turn 이 곧 마지막 슬롯이다. HARD-1 에서
      // iteration++ 하면 while(iteration < HARD) 가 즉시 거짓이 되어 flush 요청이 영영
      // 전송 안 됨(빈 finalText 그대로 종료). flush 는 HARD-1 슬롯을 *대체*하므로 다음
      // 루프 진입이 보장돼야 한다. flush turn 응답은 위 `if (finalFlushRequested) break`
      // 가 종료를 보장 → 무한 루프 0.
      if (iteration === CODEX_MAX_TOOL_ITERATIONS_HARD - 1) {
        finalFlushRequested = true;
        // 2026-06-11 (Fix 2) — flush nudge 에도 사용자 원 입력 재주입.
        inputArray.push({
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: `도구 호출 한도에 도달했습니다. ${userTextEcho}${ranListMsg} 지금까지의 결과로 위 질문에 답하는 형식의 최종 요약 텍스트를 작성하세요. 추가 도구 사용 없이 정리만.`,
            },
          ],
        });
        continue;
      }

      // ★2026-07-03 soft checkpoint nudge — CODEX_MAX_TOOL_ITERATIONS(옛 25 cap = 이제
      // "간격") 의 배수마다(25·50·75…) 가벼운 진행 nudge 1개를 push. 강제 마무리(위 HARD-1
      // flush) 와 달리 tools:[] 로 막지 *않는다* — 도구를 계속 쓸 수 있고 iteration++ 도
      // 하지 않는다(슬롯 대체 아님, 그냥 다음 fetch 컨텍스트에 추가). 문구는 조기 종료를
      // 유발하지 않게 "안 끝났으면 계속"을 주문장으로 두고(과거 cap-1 문구처럼 "마무리하라"를
      // 앞세우지 않음), update_todos 로 진행을 추적하도록 안내. lastCheckpointIteration
      // 가드로 같은 iteration 에서 두 번 push 하지 않는다(무한 중복 방지).
      if (
        iteration > 0 &&
        iteration % CODEX_MAX_TOOL_ITERATIONS === 0 &&
        lastCheckpointIteration !== iteration
      ) {
        lastCheckpointIteration = iteration;
        inputArray.push({
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: `지금까지 도구를 ${iteration}회 사용했습니다. 작업이 실제로 끝나지 않았으면 계속 진행하세요 — 중단하지 마세요. 진행 상황은 update_todos 로 추적하고, 정말 다 끝났을 때에만 요약으로 마무리하세요.`,
            },
          ],
        });
      }

      // V5.3 — 도구 호출 lifecycle: 각 function_call 을 input 배열에 그대로 push
      // (OpenClaw L300-311 shape) → callTool 실행 → function_call_output push
      // (L324-342 shape). 도구 에러는 output 에 "Error: <msg>" 박고 loop 계속.
      // Phase D (2026-07-04) — 한 turn 의 도구들을 *병렬* 실행(Claude Code parity: 독립
      // tool_use 동시 실행 → 서브에이전트 팬아웃 등). 동시 callTool 안전은 probe-concurrent-
      // calltool 로 검증(요청↔응답 매칭 정확), MCP 인스턴스는 v0.3.16 팩토리로 turn 격리 →
      // 한 브리지에 동시 요청 안전. 단일 도구 turn 은 Promise.all([1]) = 순차와 동일(회귀 0).
      // 순서: function_call 을 먼저 순서대로 push(의도 보존) → 병렬 실행 → output 을 결과
      // 배열 순서대로 push(call_id 매칭). per-tool 타임아웃·slow·side-effect·에러는 각 콜백 내.
      // 2층 도구 루프 가드(TT-I6, §4.4 #2) — 배치 시작 *직전* 1회 체크(이미 시작된 배치는
      // callTool 에 signal 이 없어 못 끊음 = orphan §4.4 #3, 기존 순차와 동일 한계). abort 시
      // reason(TurnTimeoutError) throw → 다음 배치 미시작.
      if (input.abortSignal?.aborted) throw input.abortSignal.reason;
      // function_call item 순서대로 누적 — assistant 가 보낸 호출 의도 보존 (다음 turn 필수).
      for (const tc of toolCalls) {
        inputArray.push({
          type: "function_call",
          ...(tc.id !== undefined ? { id: tc.id } : {}),
          call_id: tc.callId,
          name: tc.name,
          arguments: tc.partialJson === "" ? "{}" : tc.partialJson,
        });
      }
      const toolOutputs = await Promise.all(
        toolCalls.map(
          async (tc): Promise<{ callId: string; output: string }> => {
            let output: string;
            let toolErr = false; // 리치 출력 프리뷰 isError 표기용.
            const toolT0 = Date.now(); // 실행시간(#3) — callTool 벽시계 시작.
            try {
              const args =
                tc.partialJson === ""
                  ? {}
                  : (JSON.parse(tc.partialJson) as Record<string, unknown>);
              // V5.5 — bridge 라우팅. memory 도구는 memoryBridge, file-ops 도구는 fileOpsBridge.
              // 미등록 tool 명 시 명확 에러 (LLM 환각 호출 방어).
              const bridge = toolBridgeMap.get(tc.name);
              if (bridge === undefined) {
                throw new Error(`unknown tool: ${tc.name}`);
              }
              // 2026-06-07 — 도구 이름 화이트리스트 기반 정밀 분류. HARMLESS_TOOLS 에 없으면
              //  부작용 가능성 → claude 폴백 차단 set. (이전엔 bridge 객체 비교라 false
              //  positive·negative 양쪽 다 났음 — 위 HARMLESS_TOOLS 정의 참조.)
              if (!HARMLESS_TOOLS.has(tc.name)) sideEffectExecuted = true;
              // 2026-07-03 — 도구 실행 per-call wall-clock 가드 (CODEX_TOOL_TIMEOUT_MS 정의부
              // 주석 참조). callTool 을 타임아웃과 Promise.race → 초과 시 reject → 아래 catch 가
              // "Error: …" 로 잡아 루프 계속(hung 도구가 턴을 30분 얼리는 것 차단). abort/resume
              // 안 함. 타이머는 callTool 이 먼저 끝나면 clearTimeout(누수 0), setTimeout .unref()
              // (이벤트루프 잔류 0). orphan: MCP callTool 은 signal 없어 timeout 후 detached 로 계속
              // 돌 수 있음(§4.4 #3) — 넉넉한 기본값이 완료 직전 오살 위험 최소화.
              let toolTimer: ReturnType<typeof setTimeout> | undefined;
              // 조기 경고 — 타임아웃(8분) 전에 ~90초에 로그로 알림(권한 요청/hung/느림 조기 발견).
              // 죽이지 않고 경고만. callTool 이 먼저 끝나면 아래 finally 가 clearTimeout(누수 0).
              const slowTimer: ReturnType<typeof setTimeout> = setTimeout(() => {
                console.warn(
                  `[tool-slow] ${input.threadKey} 도구 ${tc.name} 이(가) ${Math.round(
                    CODEX_TOOL_SLOW_WARN_MS / 1000,
                  )}s+ 실행 중 — 권한 다이얼로그(OS) 대기·외부 MCP 백엔드 부재(서버는 연결됐어도 대상 앱/에디터 미실행)·hung·느림 의심. ${Math.round(
                    CODEX_TOOL_TIMEOUT_MS / 60_000,
                  )}분에 타임아웃.`,
                );
                // 관측 이벤트 — worker-jobs 가 구독해 워커면 사용자에게 "멈춤, 권한 확인" 핑(잡당 1회).
                // 채널 무결합(어댑터는 event 만, dest 라우팅은 worker 계층). best-effort.
                try {
                  bus.publish({
                    type: "llm.tool_slow",
                    ts: Date.now(),
                    payload: {
                      channel: input.channel,
                      threadKey: input.threadKey,
                      tool: tc.name,
                      ms: CODEX_TOOL_SLOW_WARN_MS,
                    },
                  });
                } catch {
                  /* best-effort */
                }
              }, CODEX_TOOL_SLOW_WARN_MS);
              slowTimer.unref?.();
              const result = await Promise.race([
                bridge.callTool(tc.name, args),
                new Promise<never>((_, reject) => {
                  toolTimer = setTimeout(() => {
                    reject(
                      new Error(
                        `도구 ${tc.name} 응답 시간 초과 (${Math.round(
                          CODEX_TOOL_TIMEOUT_MS / 60_000,
                        )}분) — 무응답(재개 없이 에러 처리)`,
                      ),
                    );
                  }, CODEX_TOOL_TIMEOUT_MS);
                  toolTimer.unref?.();
                }),
              ]).finally(() => {
                if (toolTimer !== undefined) clearTimeout(toolTimer);
                clearTimeout(slowTimer);
              });
              // 도구 실행 성공 — 이름 누적 (빈응답 nudge·fallback 에 사용). 실패는 카운트 X.
              executedToolNames.add(tc.name);
              // MCP CallToolResult.content = Array<{type:"text", text:string} | ...>.
              // text 노드만 join. (memory · file-ops 도구는 모두 text 반환.)
              const arr = Array.isArray(result) ? result : [];
              output = arr
                .filter(
                  (c) =>
                    c !== null && typeof c === "object" && (c as { type?: string }).type === "text",
                )
                .map((c) => String((c as { text?: unknown }).text ?? ""))
                .join("");
              if (output === "") output = JSON.stringify(result ?? {});
            } catch (e) {
              output = `Error: ${e instanceof Error ? e.message : String(e)}`;
              toolErr = true;
            }
            // 실행시간(#3) — 성공/실패/타임아웃 무관 도구 실행 벽시계를 phase:"end" 로 발행.
            // 같은 seq → 대시보드가 시작 스텝에 실행시간 주석. best-effort(원칙 3).
            const endSeq = tc.callId ? callIdToSeq.get(tc.callId) : undefined;
            if (endSeq !== undefined) {
              const outPreview = buildActivityOutput(tc.name || "tool", output, toolErr);
              try {
                bus.publish({
                  type: "llm.activity",
                  ts: Date.now(),
                  payload: {
                    channel: input.channel,
                    threadKey: input.threadKey,
                    adapter: "codex",
                    model,
                    seq: endSeq,
                    kind: "tool",
                    label: tc.name || "tool",
                    phase: "end",
                    durationMs: Date.now() - toolT0,
                    ...(outPreview !== undefined ? { output: outPreview } : {}),
                  } satisfies RegionAActivityPayload,
                });
              } catch {
                /* 관측 발행 실패가 turn 을 무르지 않는다(원칙 3). */
              }
            }
            return { callId: tc.callId, output };
          },
        ),
      );

      // C2 (compaction, architect §C2) — inputArray *진입* 직전 단발 cap. 큰 단일
      // output(Bash 1MB·Read 대용량)이 turn 끝까지 매 iteration 재전송되며 비용을
      // 지배하므로, 진입 시점에 머리+꼬리만 남긴다. 도구 자체 cap 과 별개. 에러
      // 문자열("Error: …")은 보통 짧아 자연히 cap 미달 → 무영향. function_call_output 은
      // 결과 배열 순서대로 push → call_id 매칭(병렬이라도 순서·매칭 보존, canonical shape).
      for (const { callId, output } of toolOutputs) {
        inputArray.push({
          type: "function_call_output",
          call_id: callId,
          output: capToolOutputForEntry(output),
        });
      }

      // C1 (compaction, architect §C1) — 매 iteration 새 output push 후, 다음 전송
      // 전 압축 패스. inputArray 의 오래된 function_call_output 본문(최근 K개 제외)을
      // placeholder 로 치환해 O(N²) 누적 재전송을 선형으로 묶는다. call_id 쌍은
      // 보존(output 문자열만 교체) → Responses shape 무손상. 압축 대상이 없는 짧은
      // 루프(대부분의 일반 대화)는 no-op → 현행과 100% 동일(회귀 0).
      compactOldToolOutputs(inputArray);

      iteration += 1;
    }
  } catch (e) {
    // 유휴 타임아웃 (§4.4) — 부작용 도구 상호작용. LLM 스트림이 idle abort 되어
    // IdleTimeoutError 가 올라온 경우, codex 의 부작용 모델 차이에 따른 native 처리:
    //  - sideEffectExecuted === true: throw 하면 풀 폴백이 턴을 처음부터 재실행 →
    //    memory/todo/schedule 등 부작용 *중복* 위험(기존 빈-응답 분기 L1519 동일 논리).
    //    따라서 throw 대신 정직한 timeout fallback 텍스트 반환(중복 회피, claude 폴백 X
    //    = feedback_no_cross_adapter_fallback 명시 예외). 빈 응답 분기와 동형 안전 처리.
    //  - false: 부작용 없음 → throw 로 풀 폴백 안전 재실행(중복 없음).
    // 이건 어댑터 *내부* 안전 처리(facade 분기 아님) — 동작(타임아웃→안전 종료)은 동일.
    // 2층 턴 타임아웃(§4.4, TT-I6) — IdleTimeoutError 와 달리 *항상 throw*. facade 는
    // TurnTimeoutError 를 isModelRejected 비매칭으로 보아 폴백하지 않고(중복 재실행 0,
    // §6 runPool 단락) 핸들러로 그대로 올려 "⏱️ 중단" 정직 보고를 시킨다. orphan 도구는
    // 이미 실행됐어도 facade 가 턴을 재실행하지 않으므로 중복 위험 없음 — 즉 1층의
    // sideEffectExecuted 중복 방어가 2층엔 불요. 큐 무한 점유 해소가 핵심 목적(TT-I6).
    if (e instanceof TurnTimeoutError) {
      throw e;
    }
    if (e instanceof IdleTimeoutError && sideEffectExecuted) {
      const ranList =
        executedToolNames.size > 0
          ? `\n\n이번 턴에 실행한 도구: ${[...executedToolNames].join(", ")}.`
          : "";
      finalText = `응답이 지연되어 중단했습니다.${ranList}\n\n결과를 확인하시거나 다시 한 번 물어봐 주세요.`;
    } else {
      throw e; // 부작용 없음 or 일반 에러 → 정직 throw (풀 폴백 / 정직 에러).
    }
  } finally {
    // 생성한 모든 bridge 일괄 close (in-memory transport 누수 0). 개별 try 로 격리 —
    // 한 bridge close 실패가 나머지 정리를 막지 않음. 실패해도 응답 흐름 영향 0.
    for (const bridge of allBridges) {
      try {
        await bridge.close();
      } catch {
        /* noop */
      }
    }
  }

  // V5.1' sid 매핑 — `codex-${response.id}` 박음. response.id 부재 시 randomBytes
  // fallback (V3 hex sid 형식). V5.1 의 `resp_` prefix 가드는 input 누적 lookup
  // 시점에서 처리 (buildTurnHistory) — 응답에서 받은 response.id 는 항상 `resp_` 형식.
  // 최종 assistant text turn 만 사용 — runRegionA(facade)의 appendTranscript 가
  // user + assistant 한 쌍만 transcripts INSERT (function_call/output 자동 격리).
  // loadCodexTurnHistoryBySessionId 의 `role IN ('user','assistant')` 필터로 다음 turn
  // 복원 시 도구 turn 자동 제외 — V5 통합 게이트 회귀 0.
  // codex empty-response fix (2026-05-24) Fix 2 — 최종 빈 출력 처리.
  // 기존 `"(빈 응답)"` 플레이스홀더를 텔레그램에 그대로 보내던 성공 반환이 폴백을
  // 가로막았다(runRegionA 풀 폴백은 throw 시에만 작동). 누적(Fix 1) 후에도 finalText 가
  // 비면:
  //  - 부작용 도구 0 (순수 읽기/빈 단일 턴): throw → runRegionA(facade) catch → 다음 풀
  //    모델(anthropic:claude-opus-4-7) 로 턴 전체 안전 재실행. 부작용이 없으니 중복 없음.
  //  - 부작용 도구 1+ 실행됨: throw 시 claude 재실행이 memory/todo/spawn/schedule 등을
  //    중복 실행하므로 throw 금지. 요청은 처리됐으나 모델이 사용자용 요약 텍스트를 0 생성한
  //    상태 → 정직한 비어있지 않은 fallback 텍스트 반환(중복 회피).
  if (finalText === "") {
    // 2026-06-07 — 빈 응답 진단 캡처 (env gate 없이 자동 — 희귀 이벤트, 노이즈 0).
    //  가설 A(reasoning effort 가 텍스트 슬롯 잠식) 검증 + 다음 가설 진단에 사용.
    //  데몬 stderr 로 한 줄 — 사용자 텔레그램 노출 X.
    console.error(
      `[codex empty-response] threadKey=${input.threadKey} iteration=${iteration}/${CODEX_MAX_TOOL_ITERATIONS_HARD}` +
        ` finalFlush=${finalFlushRequested} postFlushRetry=${postFlushRetryUsed}` +
        ` emptyBreakRetries=${emptyBreakRetries}/${MAX_EMPTY_BREAK_RETRIES}` +
        ` sideEffect=${sideEffectExecuted}` +
        ` usage=input:${finalUsage?.inputTokens ?? "?"}/output:${finalUsage?.outputTokens ?? "?"}` +
        `/reasoning:${finalUsage?.reasoningTokens ?? "?"}` +
        ` tools=[${[...executedToolNames].join(",")}]` +
        ` userText=${JSON.stringify(input.text.slice(0, 80))}`,
    );
    if (!sideEffectExecuted) {
      throw new Error(
        "codex: 최종 응답 텍스트 비어있음 (부작용 도구 미실행) — 풀 폴백 유도",
      );
    }
    // 2026-06-05 — 실행된 도구 이름을 fallback 텍스트에 자동 포함. 사용자가 텔레그램
    //  응답에서 "방금 무엇이 처리됐는지" 즉시 인지 (이전엔 본문 0 = UX 깜깜).
    const ranList =
      executedToolNames.size > 0
        ? `\n\n이번 턴에 실행한 도구: ${[...executedToolNames].join(", ")}.`
        : "";
    finalText = `요청은 처리했지만 요약 텍스트를 만들지 못했어요.${ranList}\n\n결과를 확인하시거나 다시 한 번 물어봐 주세요.`;
  }

  return {
    text: finalText,
    sessionId:
      finalResponseId !== undefined
        ? `codex-${finalResponseId}`
        : `codex-${randomBytes(16).toString("hex")}`,
    model,
    replyToTrigger,
    usage: finalUsage,
  };
};
