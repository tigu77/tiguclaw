/**
 * Provider 연결 레지스트리 — provider id → 연결 정보(adapter / baseURL / apiKey) 해석.
 *
 * 진실 소스: `_workspace/local-llm_region_routing.md` §3.2(b).
 *
 * 설계 의도:
 *  - `PROVIDER_TO_ADAPTER`(index.ts) 가 provider→adapter 매핑(다대일 허용)의 호환 view 라면,
 *    이 레지스트리가 **진실 소스**다. openai/ollama/google 3 provider 가 모두 openai 어댑터로
 *    가되, 차이는 baseURL/apiKey 뿐 — 그 차이를 여기서 단일 지점으로 해석한다.
 *  - 이건 **고정 상수 5종 테이블**이지 런타임 플러그인 로더가 아니다(principle-check:
 *    동적 일반화 금지). provider 가 실제로 5종을 넘을 때만 키를 추가한다.
 *  - 어댑터별 특수 분기 0 — openai 어댑터는 `resolveProviderConn(input.provider)` 로
 *    self-lookup 해 받은 conn 대로 client 를 만들 뿐, "내가 ollama 인가 google 인가"를
 *    if 로 분기하지 않는다 (LLM-agnostic 하드게이트).
 */
import type { RegionAAdapter } from "./index.js";

export interface ProviderConn {
  /** 이 provider 가 실제로 타는 어댑터(런타임). */
  adapter: RegionAAdapter;
  /**
   * OpenAI-compatible baseURL. undefined = openai 정품(api.openai.com) 경로 →
   * 현행 string model 흐름 유지(회귀 0). 지정 시 ChatCompletions 모델 강제 경로.
   */
  baseURL?: string;
  /** apiKey 를 읽을 env 변수명. */
  apiKeyEnv: string;
  /** 키가 불필요한 provider(ollama 로컬)용 더미 fallback. env 미설정 시 사용. */
  apiKeyFallback?: string;
}

// Ollama baseURL — OLLAMA_BASE_URL(없으면 http://localhost:11434) + "/v1" 규약.
// env 가 이미 끝에 슬래시를 가질 수 있으니 중복 슬래시 방지.
const ollamaBaseURL = (): string => {
  const raw = (process.env.OLLAMA_BASE_URL ?? "http://localhost:11434").replace(
    /\/+$/,
    "",
  );
  return `${raw}/v1`;
};

// 5종 하드코딩 상수 테이블. baseURL 이 env(ollama) 에 의존하므로 함수로 lazy 해석.
// (모듈 로드 시점이 아니라 호출 시점 env 를 읽어야 .env 로드 순서·런타임 변경 안전.)
export const PROVIDER_REGISTRY: Record<string, () => ProviderConn> = {
  openai: () => ({ adapter: "openai", apiKeyEnv: "OPENAI_API_KEY" }),
  ollama: () => ({
    adapter: "openai",
    baseURL: ollamaBaseURL(),
    apiKeyEnv: "OLLAMA_API_KEY",
    apiKeyFallback: "ollama",
  }),
  google: () => ({
    adapter: "openai",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
    apiKeyEnv: "GOOGLE_GENERATIVE_AI_API_KEY",
  }),
  anthropic: () => ({ adapter: "claude", apiKeyEnv: "ANTHROPIC_API_KEY" }),
  codex: () => ({
    adapter: "codex-oauth",
    apiKeyEnv: "OPENAI_CODEX_OAUTH_TOKEN",
  }),
};

/**
 * provider id → 연결 정보 + 해석된 apiKey. 미지 provider → null.
 *
 * apiKey 해석: env[apiKeyEnv] ?? apiKeyFallback. 둘 다 없으면 undefined
 * (호출자가 인증 부재로 판단). ollama 는 fallback("ollama") 덕에 키 없이도 동작.
 */
export const resolveProviderConn = (
  provider: string | undefined,
): (ProviderConn & { apiKey?: string }) | null => {
  if (provider === undefined) return null;
  const factory = PROVIDER_REGISTRY[provider];
  if (factory === undefined) return null;
  const conn = factory();
  const apiKey = process.env[conn.apiKeyEnv] ?? conn.apiKeyFallback;
  return { ...conn, apiKey };
};
