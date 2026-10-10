/**
 * Provider 연결 레지스트리 — provider id → 연결 정보(adapter / baseURL / apiKey) 해석.
 *
 * 진실 소스: `_workspace/local-llm_region_routing.md` §3.2(b).
 *
 * 설계 의도:
 *  - `PROVIDER_TO_ADAPTER`(index.ts) 가 provider→adapter 매핑(다대일 허용)의 호환 view 라면,
 *    이 레지스트리가 **진실 소스**다. openai/google 2 provider 가 모두 openai 어댑터로
 *    가되, 차이는 baseURL/apiKey 뿐 — 그 차이를 여기서 단일 지점으로 해석한다.
 *  - **고정 상수 4종 테이블 = authoritative baseline**(런타임 플러그인 로더 아님). 다만
 *    2026-07-18 부터 사용자가 settings.json `models.providers` 로 **새 이름을 추가**할 수 있다
 *    (config-driven, 코어 코드 0 — 채널 균일 플러그인화의 LLM 판, principle-check 재판정 통과:
 *    사용자 명시 요청 + config-data(런타임 코드로더 아님) + 원칙#2 직접 서빙). ★precedence:
 *    하드코딩 4종이 authoritative — 사용자는 override 못 하고 **새 이름만** 추가한다. 그래서
 *    resolveProviderConn/listProviderNames 는 항상 하드코딩을 먼저 lookup 한다. ★user provider 의
 *    adapter 는 기존 known 3종(openai/claude/codex-oauth) 중 하나여야 하고, 미지 adapter 는
 *    거부(null·미열거)한다 — 신규 엔진은 parity harness 별건이다.
 *  - 어댑터별 특수 분기 0 — openai 어댑터는 `resolveProviderConn(input.provider)` 로
 *    self-lookup 해 받은 conn 대로 client 를 만들 뿐, "내가 google 인가 사용자 서버인가"를
 *    if 로 분기하지 않는다 (LLM-agnostic 하드게이트). user provider 도 같은 경로로 자동 서빙.
 */
import type { RegionAAdapter } from "./index.js";
import { loadModelProviders } from "../settings.js";
import { isTrustedProjectDir } from "../project-trust.js";

export interface ProviderConn {
  /** 이 provider 가 실제로 타는 어댑터(런타임). */
  adapter: RegionAAdapter;
  /**
   * OpenAI-compatible baseURL. undefined = openai 정품(api.openai.com) 경로 →
   * 현행 string model 흐름 유지(회귀 0). 지정 시 ChatCompletions 모델 강제 경로.
   */
  baseURL?: string;
  /**
   * apiKey 를 읽을 env 변수명. ★없으면 **키 없는 서버**(사용자 정의 provider 의 로컬 서버 — ollama·LM Studio 등)다:
   * 주소(`baseURL`)를 명시해 설정한 것 자체가 «쓸 수 있음» 이고, 클라이언트에는 자리표시 키를 준다.
   */
  apiKeyEnv?: string;
}

/** env 값 — **빈 문자열은 «없음»** 이다(설치 템플릿이 `KEY=` 빈 줄을 쓴다). `??` 는 빈 문자열을 통과시킨다. */
export const envValue = (name: string): string | undefined => {
  const v = (process.env[name] ?? "").trim();
  return v === "" ? undefined : v;
};

/**
 * 키 없는 서버에 넘기는 자리표시 키 — OpenAI 클라이언트는 빈 키를 거부하고, 로컬 서버는 키를 보지 않는다.
 * ★2026-09-28 전엔 내장 `ollama` 가 `OLLAMA_BASE_URL`·대체 키·주소 변수라는 **자기만의 규칙 셋**을 들고 있었다
 *  (설정 여부 판정·카드 안내·doctor·설치 템플릿이 각자 그 사정을 알았다). 사용자 정의 provider 가 키 없는 서버를
 *  받게 되면서 내장을 뺐다 — 로컬 서버는 이제 다른 OpenAI 호환 서버와 **같은 한 경로**다.
 */
export const KEYLESS_API_KEY = "not-needed";

// 하드코딩 4종 상수 테이블(호출마다 새 객체 — 호출자가 고쳐도 테이블이 안 바뀐다).
export const PROVIDER_REGISTRY: Record<string, () => ProviderConn> = {
  openai: () => ({ adapter: "openai", apiKeyEnv: "OPENAI_API_KEY" }),
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

// known adapter 판정 — RegionAAdapter union 의 런타임 미러(exhaustive record 로 컴파일 타임
// 강제: union 에 멤버가 추가되면 여기서 타입 에러가 나 갱신을 잊지 못한다). ★index.ts 에도 같은
// 판정이 있으나(parseModelSpec), provider-registry→index 는 type-only(런타임 미로드)여야
// 순환이 안 나므로 value 를 import 하지 않고 이 작은 record 를 각자 소유한다(cycle-forced 중복,
// 3키·안정). user provider 의 미지 adapter 는 여기서 거부한다.
const KNOWN_ADAPTERS: Record<RegionAAdapter, true> = {
  claude: true,
  openai: true,
  "codex-oauth": true,
};
const isKnownAdapter = (a: string): a is RegionAAdapter =>
  Object.prototype.hasOwnProperty.call(KNOWN_ADAPTERS, a);

/**
 * 사용자 정의 provider(settings.json `models.providers`) → ProviderConn. 미지 adapter 는
 * null 로 거부(신규 엔진 별건). precedence 강제는 호출자 몫(하드코딩 먼저 lookup 후 여기).
 */
const resolveUserProviderConn = (
  provider: string,
  cwd?: string,
): ProviderConn | null => {
  // ★믿지 않는 폴더(등록 안 된 레포)의 프로젝트 설정은 연결 해석에 쓰지 않는다 (2026-10-10). 그 레포의 settings.json 이 서버 주소
  //  (`baseURL`)와 키 변수(`apiKeyEnv`)를 정하면 **사용자 키가 레포가 고른 서버로** 나간다. 믿는 폴더 판정은 MCP·훅과 같은 한 곳이다.
  const cfg = loadModelProviders(cwd !== undefined && !isTrustedProjectDir(cwd) ? undefined : cwd)[provider];
  if (cfg === undefined) return null;
  if (!isKnownAdapter(cfg.adapter)) return null; // 미지 adapter 거부.
  const conn: ProviderConn = { adapter: cfg.adapter };
  if (cfg.apiKeyEnv !== undefined) conn.apiKeyEnv = cfg.apiKeyEnv;
  if (cfg.baseURL !== undefined) conn.baseURL = cfg.baseURL;
  return conn;
};

/**
 * provider id → 연결 정보 + 해석된 apiKey. 미지 provider → null.
 *
 * precedence: 하드코딩 4종(PROVIDER_REGISTRY) 먼저 — authoritative(사용자 override 불가).
 * 없으면 사용자 정의 provider(settings.json models.providers, known adapter 검증) 폴백.
 * apiKey 해석: env[apiKeyEnv](빈 값 = 없음). 없으면 undefined(호출자가 인증 부재로 판단). 키 변수가 없는 provider
 * (키 없는 서버)는 자리표시 키.
 */
export const resolveProviderConn = (
  provider: string | undefined,
  cwd?: string,
): (ProviderConn & { apiKey?: string }) | null => {
  if (provider === undefined) return null;
  const factory = PROVIDER_REGISTRY[provider];
  const conn = factory !== undefined ? factory() : resolveUserProviderConn(provider, cwd);
  if (conn === null) return null;
  const apiKey = conn.apiKeyEnv === undefined ? KEYLESS_API_KEY : envValue(conn.apiKeyEnv);
  return { ...conn, apiKey };
};

/**
 * 열거 가능한 provider 이름 — 하드코딩 4종 + 사용자 정의(known adapter 만). 하드코딩 우선,
 * 사용자 이름은 하드코딩과 겹치지 않는 것만 뒤에 추가(precedence: 하드코딩이 이김·중복 제거).
 * 대시보드 llm-adapter 모듈 열거(providers.ts) 등이 소비. 미지 adapter user provider 는 제외.
 */
export const listProviderNames = (cwd?: string): string[] => {
  const names = Object.keys(PROVIDER_REGISTRY);
  const seen = new Set(names);
  for (const [name, cfg] of Object.entries(loadModelProviders(cwd))) {
    if (seen.has(name)) continue; // 하드코딩이 authoritative — override 무시.
    if (!isKnownAdapter(cfg.adapter)) continue; // 미지 adapter 제외.
    names.push(name);
    seen.add(name);
  }
  return names;
};
