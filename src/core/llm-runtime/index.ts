/**
 * 영역 A facade — 모델 풀 + 응답 후 통합 처리 (V5 / 2026-05-24 provider:model 통일).
 *
 * 모델 선택 — `provider:model` 문법 (영역 B `MODELS_*` 와 동일, OpenClaw
 * StaticModelRef 답습). provider 가 어댑터(런타임) 결정, model 이 버전:
 *   anthropic:claude-opus-4-7  → claude 어댑터 (Claude Agent SDK)
 *   codex:gpt-5.5              → codex-oauth 어댑터 (비공식 ChatGPT backend)
 *   openai:gpt-4o              → openai 어댑터 (@openai/agents)
 *
 * 우선순위:
 *  1. `opts.specs` 명시 (호출자 지정 — 단일 또는 풀)
 *  2. `process.env.REGION_A_MODELS` (콤마 풀, 예 "codex:gpt-5.5,anthropic:claude-opus-4-7")
 *  3. `DEFAULT_MODEL_SPEC` (anthropic, model 미지정 → SDK 디폴트)
 *
 * 풀 모드: 순서대로 시도, 첫 성공 즉시 통합 처리 → return. 모두 실패 시 마지막 throw.
 *
 * V5 통합 처리 (어댑터 무관):
 *  1. saveSession({channel, threadKey, claudeSessionId: output.sessionId, model, hash})
 *  2. transcripts 인덱싱:
 *     - output.jsonlPath 있음 (claude) → indexJsonlIfNeeded (jsonl catch-up, 진실 소스)
 *     - 없음 (codex-oauth·openai) → appendTranscript user + assistant 직접 INSERT
 */
import { runClaude } from "./adapters/claude-agent-sdk.js";
import { deliverOutbound } from "../outbound.js";
import { runOpenAi } from "./adapters/openai-agents-sdk.js";
import { runOpenAiCodex } from "./adapters/openai-codex-oauth.js";
import { setSummarizerCooldownPort } from "./adapters/openai-codex-oauth-history.js";
import { saveSession } from "../../store/sessions.js";
import { formatAttachments } from "../prompt-assembly.js";
import { enrichTranscripts } from "./transcription/index.js";
import {
  appendTranscript,
  indexCodexTurn,
  indexJsonlIfNeeded,
} from "../../store/memory.js";
import type {
  RegionASdkInput,
  RegionASdkOutput,
  RegionATurnDonePayload,
  RegionATurnErrorPayload,
} from "./types.js";
import { TurnTimeoutError } from "./turn-timeout.js";
import { IdleTimeoutError } from "./idle-timeout.js";
import {
  saveCooldown,
  deleteCooldown,
  loadLiveCooldowns,
  getCooldownRow,
  markCooldownProbe,
} from "../../store/cooldowns.js";
import { getEventBus } from "../eventbus.js";
// 통지 좌표 도출 — 어댑터 3종·update_self 와 **같은 함수**를 쓴다(좌표 판정 단일 진실).
import { notifyDestFromCoords } from "../self-update.js";
import {
  DEFAULT_COOLDOWN_MS,
  MAX_COOLDOWN_MS,
  isRateLimited,
  parseCooldownMs,
} from "./rate-limit.js";
import {
  resolveProfileChain,
  getDefaultProfileName,
  loadModelProviders,
  loadModelInputLimits,
} from "../settings.js";

// undici fetch 실패는 표면 message "fetch failed", 진짜 원인은 e.cause 에 있음.
// cause 까지 펼쳐 진단 소실 차단.
// export (2026-06-02) — daemon catch 가 사용자 채널 에러 노출에 재사용 (중복 구현 금지).
export const errorDetail = (e: unknown): string => {
  if (!(e instanceof Error)) return String(e);
  const cause = (e as { cause?: unknown }).cause;
  if (cause === undefined || cause === null) return e.message;
  return `${e.message} (cause: ${cause instanceof Error ? cause.message : String(cause)})`;
};

// 모델-거부 식별 — 어댑터 무관 문자열 휴리스틱 1개 (facade 단일 지점).
// 어댑터별 분기 절대 금지 (LLM-agnostic 하드게이트, feedback_every_feature_llm_agnostic).
// 이건 "에러 종류 분류" 이지 모델 카탈로그가 아님 — 화이트리스트가 아니므로
// 정당한 신모델은 영향 없음 (Q5 카탈로그 재구현 회피).
//
// 실측 표면화 (probe 2026-06-02 + codex/openai 소스 — errorDetail 가 .cause 까지
// 펼친 합본 문자열):
//  - claude: SDK result.is_error 시 어댑터가 `claude-agent-sdk error: ${result}` throw.
//    result 본문 = Anthropic CLI raw API 에러. 미존재 모델 실측 원문:
//    `API Error: 404 {"type":"error","error":{"type":"not_found_error",
//     "message":"model: claude-sonnet-4-7"},"request_id":"..."}`
//    (주의: SDK 가 거부를 throw 가 아니라 subtype "success"+is_error=true+result 본문
//     으로 표면화 → 어댑터가 is_error 를 throw 로 승격. 이전 추정 패턴이 빗나간 원인.)
//  - codex : `Codex backend 호출 실패: 404 <body>` (openai-codex-oauth.ts)
//  - openai: `@openai/agents` 가 던지는 model_not_found 류
const MODEL_REJECTED_PATTERNS: RegExp[] = [
  // 세 어댑터 공통 — Anthropic/OpenAI API 의 모델 부재 에러 코드.
  /not_found_error/i,
  /model_not_found/i,
  // claude 실측 — API 에러 본문의 `"message":"model: <id>"`.
  /"message"\s*:\s*"model:/i,
  // 일반형 — "model:" 토큰 + 인근 부재/무효 키워드 (오탐 축소).
  /model:[^"]{0,60}(not found|does not exist|invalid|unknown)/i,
  /unknown model/i,
  // 404 + 모델/에러 문맥 — claude `API Error: 404 {...}` / codex `호출 실패: 404` 공통.
  /(api error|호출 실패)[\s\S]{0,40}404/i,
  /404[\s\S]{0,120}(not_found_error|model)/i,
  // codex narrowing 보강 (QA 2차 P3) — OpenAI Responses backend 가 무효 모델 param 을
  // 404 가 아닌 400/422 로 거부하고 code 가 model_not_found 가 아닐 때(예 invalid_value/
  // null) 본문 시그니처. `호출 실패`(codex 어댑터 throw prefix) 가 동반될 때만 적용해
  // 일반 4xx/네트워크 에러 오탐 차단. 콤마 깨진 모델명 거부가 비-404 일 가능성 커버.
  //  (a) OpenAI 구조화 param 지목 — `"param":"model"` (code 무관 모델 거부 신호).
  /호출 실패[\s\S]{0,200}"param"\s*:\s*"model"/i,
  //  (b) OpenAI 모델 부재 정형 문구 — code 없이도 메시지 본문에 항상 등장.
  /does not exist or you do not have access/i,
];

export const isModelRejected = (errStr: string): boolean =>
  MODEL_REJECTED_PATTERNS.some((re) => re.test(errStr));

// provider-미가용 식별 — 어댑터 사전 인증 가드(키/토큰 부재)로 인한 실패. isModelRejected 와
// 별개의 "설정 에러" 클래스. 런타임 결함(스톨·hang·타임아웃·부분응답)이 아니라 "이 어댑터를
// 애초에 쓸 수 없음"(자격증명 부재)만 좁게 잡는다 — 그래야 override/tier 를 사용자 기본 풀로
// 폴백해도 어댑터 결함을 가리지 않는다(feedback_no_cross_adapter_fallback: claude 폴백 =
// 최후 안전망 only, 결함 마스킹 금지). 세 어댑터의 실측 사전-가드 문구(API 호출 前 throw):
//  - claude : "Claude 인증 없음. ANTHROPIC_API_KEY 또는 CLAUDE_CODE_OAUTH_TOKEN..." (claude-agent-sdk.ts:298)
//  - openai : "'<provider>' 인증 없음. <ENV> 가 필요합니다." (openai-agents-sdk.ts:97)
//  - codex  : "OpenAI Codex OAuth 토큰 없음. `npm run codex-auth`..." (openai-codex-oauth.ts:365)
const PROVIDER_UNAVAILABLE_PATTERNS: RegExp[] = [/인증 없음/, /토큰 없음/];

export const isProviderUnavailable = (errStr: string): boolean =>
  PROVIDER_UNAVAILABLE_PATTERNS.some((re) => re.test(errStr));

export type RegionAAdapter = "claude" | "openai" | "codex-oauth";

/** 모델 스펙 — provider 가 결정한 어댑터(런타임) + 모델 버전. model "" = 어댑터 디폴트. */
export interface ModelSpec {
  adapter: RegionAAdapter;
  model: string;
  /**
   * 신규(additive, 2026-06-15) — round-trip·연결 해석용 provider id.
   * 다대일(openai 어댑터 ← openai/ollama/google) 에서 adapter→provider 역산이
   * 불가능하므로 명시 운반. 미지정 = adapter 의 canonical provider(레거시 spec 호환).
   * 어댑터는 이 값으로 provider-registry self-lookup → baseURL/apiKey 해석.
   */
  provider?: string;
}

// provider id → 어댑터(런타임). 다대일 허용 (openai 어댑터 ← openai/ollama/google).
// 진실 소스는 provider-registry.ts (이 맵은 parse lookup 용 호환 view) — 하드코딩 5종.
// 사용자 정의 provider(settings.json models.providers, 2026-07-18)는 이 맵에 없고
// parseModelSpec 이 loadModelProviders 폴백으로 adapter 를 해석한다(config-driven 개방).
// principle-check: 하드코딩 5종 authoritative — 사용자는 새 이름만 추가(override 불가).
const PROVIDER_TO_ADAPTER: Record<string, RegionAAdapter> = {
  anthropic: "claude",
  codex: "codex-oauth",
  openai: "openai",
  ollama: "openai",
  google: "openai",
};

// known adapter 판정 — RegionAAdapter union 의 런타임 미러(exhaustive record 로 union 변경 시
// 컴파일 에러). ★provider-registry.ts 에도 같은 record 가 있으나 provider-registry→index 는
// type-only(런타임 미로드)로 유지해야 순환이 안 나므로 value import 대신 각자 소유한다
// (cycle-forced 중복, 3키·안정). 사용자 정의 provider 의 미지 adapter 는 여기서 거부한다.
const KNOWN_ADAPTERS: Record<RegionAAdapter, true> = {
  claude: true,
  openai: true,
  "codex-oauth": true,
};
const isKnownAdapter = (a: string): a is RegionAAdapter =>
  Object.prototype.hasOwnProperty.call(KNOWN_ADAPTERS, a);

// 사용자 정의 provider → 어댑터. 하드코딩 5종에 없는 provider 만 settings.json models.providers
// 에서 해석(known adapter 검증). 미지 provider·미지 adapter → undefined(parseModelSpec 이 drop).
const userProviderAdapter = (
  provider: string,
  cwd?: string,
): RegionAAdapter | undefined => {
  const cfg = loadModelProviders(cwd)[provider];
  if (cfg === undefined || !isKnownAdapter(cfg.adapter)) return undefined;
  return cfg.adapter;
};

// adapter id → provider 라벨 (PROVIDER_TO_ADAPTER 역매핑). specLabel 이 사용자 친화
// `provider:model` 복원에 사용. 내부 adapter id(claude/codex-oauth)는 사용자에게 안 노출.
const ADAPTER_TO_PROVIDER: Record<RegionAAdapter, string> = {
  claude: "anthropic",
  "codex-oauth": "codex",
  openai: "openai",
};

// ModelSpec → 사용자 친화 canonical `provider:model` 문자열.
// export (2026-06-02) — daemon 이 `/model` 풀 canonical 저장(round-trip 안전:
// 결과를 다시 parseModelSpecList 에 넣으면 동일 풀)·고지에 사용.
// 주의: provider 라벨 복원(adapter→provider) — codex-oauth 어댑터는 `codex:` 로 표기되어
// parseModelSpec(PROVIDER_TO_ADAPTER) 가 다시 받아낼 수 있어야 round-trip 성립.
// model === "" (DEFAULT_MODEL_SPEC, override 로는 저장 안 됨)만 `(default)` 표시 — 이 경우는
// 고지 display 전용이고 canonical 저장 경로엔 등장 안 함.
// provider 명시 우선(다대일 round-trip 보존), 없으면 canonical 역산(레거시 spec 하위호환).
// openai 어댑터로 가는 ollama/google 은 역산이 불가능하므로 s.provider 가 필수 경로.
export const specLabel = (s: ModelSpec): string => {
  const provider = s.provider ?? ADAPTER_TO_PROVIDER[s.adapter];
  return `${provider}:${s.model === "" ? "(default)" : s.model}`;
};

export const DEFAULT_MODEL_SPEC: ModelSpec = { adapter: "claude", model: "" };

// "provider:model" → ModelSpec (OpenClaw parseStaticModelRef 답습).
// 형식 불일치·미지 provider·빈 model → null (drop).
// V1.1 (2026-05-28) — `/model` 슬래시가 형식 검증·spec 변환에 재사용 (export).
// 2026-07-18 — 하드코딩 5종에 없으면 settings.json models.providers(config-driven) 폴백.
//   precedence: 하드코딩 우선(authoritative). cwd = 프로젝트 스코프 provider 해석용(옵셔널).
export const parseModelSpec = (raw: string, cwd?: string): ModelSpec | null => {
  const trimmed = raw.trim();
  const idx = trimmed.indexOf(":");
  if (idx === -1) return null;
  const provider = trimmed.slice(0, idx).trim();
  const model = trimmed.slice(idx + 1).trim();
  const adapter = PROVIDER_TO_ADAPTER[provider] ?? userProviderAdapter(provider, cwd);
  if (adapter === undefined || model === "") return null;
  // provider 운반(round-trip 핵심) — specLabel 이 역산 대신 이 값을 직접 사용,
  // 어댑터가 provider-registry self-lookup 으로 baseURL/apiKey 해석.
  return { adapter, model, provider };
};

// export (2026-06-02) — `/model` 슬래시(daemon)·router 가 콤마 풀 파싱에 사용.
// 무효 part 는 drop (로직 무변경). 빈/전부무효 → []. cwd = 프로젝트 스코프 user provider 해석용.
export const parseModelSpecList = (raw: string, cwd?: string): ModelSpec[] => {
  const out: ModelSpec[] = [];
  for (const part of raw.split(",")) {
    const spec = parseModelSpec(part, cwd);
    if (spec !== null) out.push(spec);
  }
  return out;
};

export const resolveModelSpecs = (
  override?: ModelSpec[],
  cwd?: string,
): ModelSpec[] => {
  if (override !== undefined && override.length > 0) return override;
  // (신규 2026-07-14, ADR model-profiles / 2026-07-16 models.default 포인터) 메인 턴 암묵 풀 =
  //  기본 프로파일. 이름은 settings.json `models.default` 포인터로 지정(미설정 시 `"default"` —
  //  무회귀: 현행 바이트 동일). 프로파일이 진실 소스, env REGION_A_MODELS 는 레거시 폴백(ADR (a)).
  //  기본 풀은 체인의 자기 pool(chain[0])만 사용(메인 턴은 인터-프로파일 폴백 없이 풀 내 폴백만).
  const defaultChain = resolveProfileChain(getDefaultProfileName(cwd), cwd);
  if (defaultChain.length > 0) {
    const pool = parseModelSpecList(defaultChain[0].join(","), cwd);
    if (pool.length > 0) return pool;
  }
  const env = process.env.REGION_A_MODELS;
  if (env !== undefined && env !== "") {
    const parsed = parseModelSpecList(env, cwd);
    if (parsed.length > 0) return parsed;
  }
  return [DEFAULT_MODEL_SPEC];
};

// 풀의 provider 다양성 — 단일 provider 면 그 백엔드가 흔들릴 때(예: idle 타임아웃)
// 폴백 그물 없이 전 풀이 동시에 전멸한다. 소프트 경고만(차단 아님) — 진짜 한 provider
// 만 가진 사용자도 정상이므로 정보 제공에 그친다(원칙: 가드는 sysprompt·문구 차원).
// 풀이 비었거나 단일 spec(폴백 자체가 없는 별개 사안)이면 null.
export const poolDiversityWarning = (): string | null => {
  const specs = resolveModelSpecs();
  if (specs.length < 2) return null;
  const providers = new Set(specs.map((s) => s.provider ?? s.adapter));
  if (providers.size > 1) return null; // cross-provider 그물 있음 — OK
  return (
    `⚠️ 기본 모델 풀(models.default 가 가리키는 프로파일 또는 REGION_A_MODELS)이 단일 provider` +
    `(${[...providers][0]})뿐 — 그 백엔드가 흔들리면(idle 타임아웃 등) 폴백 그물 없이 ` +
    `전 풀이 동시에 실패합니다. cross-provider 최후 안전망 권장(예: 풀 끝에 codex:gpt-5.5 추가).`
  );
};

// 등급(티어) → 모델 풀. agent 정의의 `model:` 이 등급(high/mid/low)이면
// `MODEL_TIER_<등급>` env 의 콤마 풀(provider:model,...)로 해석 → 폴백 가능.
// provider:model 직접 지정도 허용 (고급 — 특정 모델 강제). 빈/미지 → [] (어댑터 디폴트).
const TIER_ENV: Record<string, string> = {
  high: "MODEL_TIER_HIGH",
  mid: "MODEL_TIER_MID",
  low: "MODEL_TIER_LOW",
  nano: "MODEL_TIER_NANO", // 신규 — 로컬 단순작업 모델 풀 (예 ollama:llama3.2:3b)
};

export const resolveTier = (
  modelStr: string | undefined,
  cwd?: string,
): ModelSpec[] => {
  const raw = (modelStr ?? "").trim();
  if (raw === "") return [];
  // (신규 2026-07-14, ADR model-profiles D3) 이름 앞단 프로파일 lookup — models.profiles[token]
  //  이 있으면 그 프로파일의 자기 pool(intra 폴백)을 단일 풀로 반환. .fallback 체인(inter,
  //  프로파일 간)은 resolveModelChain 이 조립하며, resolveTier 는 하위호환 시그니처 유지를 위해
  //  단일 풀만 반환한다(레거시 티어 이름·직접 spec 폴백은 프로파일 부재 시 아래로 존치).
  //  프로파일 이름은 대소문자 구분(settings 키 그대로) — 티어 소문자화보다 앞에서 원문으로 조회.
  const profileChain = resolveProfileChain(raw, cwd);
  if (profileChain.length > 0) {
    return parseModelSpecList(profileChain[0].join(","));
  }
  // 등급 키워드 → MODEL_TIER_* 콤마 풀 (레거시 폴백).
  const s = raw.toLowerCase();
  const tierEnvKey = TIER_ENV[s];
  if (tierEnvKey !== undefined) {
    const env = process.env[tierEnvKey];
    if (env !== undefined && env !== "") {
      return parseModelSpecList(env);
    }
    return [];
  }
  // provider:model 직접 (티어 아님) — 단일 spec.
  const direct = parseModelSpec(raw);
  return direct !== null ? [direct] : [];
};

/**
 * 토큰 → 순서 있는 풀 체인(ModelSpec[][]) — 프로파일 간(.fallback) 폴백을 분리 운반.
 *  (1) models.profiles[token] → 프로파일 체인(pool + .fallback 풀들). 빈/전부무효 풀은 drop.
 *  (2) 프로파일 아님 → resolveTier(레거시 티어 or 직접 provider:model) 단일 풀 → [pool].
 *  (3) 둘 다 빔 → [](호출자가 어댑터 디폴트로 강등).
 *
 * runRegionA(input, { chain }) 가 chain[0] 을 runPool, 구조적 실패면 chain[1] 로 전진한다.
 * ★ 절대 하나의 ModelSpec[] 로 평탄화하지 마라 — 그러면 프로파일 간 폴백이 런타임 결함
 *  (스톨·타임아웃)에도 터져 feedback_no_cross_adapter_fallback 을 깬다(회귀). 풀 안(runPool)=
 *  임의 실패 폴백 / 풀 간(runRegionA)=구조적 불가만. 이 경계 유지를 위해 체인을 분리해 넘긴다.
 */
export const resolveModelChain = (
  modelStr: string | undefined,
  cwd?: string,
): ModelSpec[][] => {
  const raw = (modelStr ?? "").trim();
  if (raw === "") return [];
  const profileChain = resolveProfileChain(raw, cwd);
  if (profileChain.length > 0) {
    return profileChain
      .map((pool) => parseModelSpecList(pool.join(",")))
      .filter((pool) => pool.length > 0); // 빈/전부무효 풀은 체인에서 제거(다음 풀로 흐름).
  }
  // 프로파일 아님 — 레거시 티어/직접 spec 단일 풀. (resolveTier 가 프로파일 재조회하나 무음.)
  const pool = resolveTier(raw, cwd);
  return pool.length > 0 ? [pool] : [];
};

const callAdapter = (
  adapter: RegionAAdapter,
  input: RegionASdkInput,
): Promise<RegionASdkOutput> => {
  switch (adapter) {
    case "claude":
      return runClaude(input);
    case "openai":
      return runOpenAi(input);
    case "codex-oauth":
      return runOpenAiCodex(input);
  }
};

// turn_done/turn_error 의 adapter 라벨 도메인 — 내부 "codex-oauth" → 관측 "codex"
// (llm.activity payload 와 동일 라벨). claude/openai 는 그대로.
const adapterLabel = (
  a: RegionAAdapter,
): RegionATurnDonePayload["adapter"] =>
  a === "codex-oauth" ? "codex" : a;

// turn_error message cap — PII/대형 본문이 버스 버퍼에 쌓이지 않게.
const TURN_ERROR_MESSAGE_CAP = 500;

// 실패 분류 — facade 단일 휴리스틱 (어댑터별 분기 0, 원칙 2). timeout(1·2층) >
// model_rejected > error 순으로 판정.
const classifyTurnError = (e: unknown): RegionATurnErrorPayload["errorKind"] => {
  if (e instanceof TurnTimeoutError || e instanceof IdleTimeoutError) {
    return "timeout";
  }
  if (isModelRejected(errorDetail(e))) return "model_rejected";
  return "error";
};

/**
 * 프리픽스 캐시가 **식었다**는 판정 — 나쁠 때만 로그 한 줄 (2026-07-30).
 *
 * ★왜 조건부인가: 매 턴 같은 줄을 찍으면 배경소음이 돼 실제로 12일간 묻힌 전례가 있다.
 *  그래서 "정상 = 침묵, 이상 = 판정 수치와 함께 한 줄".
 *
 * 무엇을 지키나: 안정 스캐폴딩(SYSTEM.md·스킬/에이전트 인덱스·AGENT.md ~30KB)을 어댑터
 *  시스템 채널로 올려 프리픽스 캐시를 타게 했는데(prompt-assembly splitSystemContext),
 *  누군가 그 자리에 **턴마다 변하는 값**을 끼워 넣으면 배치 회귀는 전부 초록인 채로
 *  캐시가 다시 죽는다. 그때 남는 유일한 신호가 이 줄이다. 어댑터 무관(#2).
 *
 * ★임계는 **직감이 아니라 실측**으로 잡았다 (첫 판에 10% *비율*로 뒀다가, 정작 이 작업을
 *  촉발한 조건(단일턴 11.7%)이 임계를 넘어 침묵한다는 걸 데이터로 확인하고 갈아엎었다):
 *
 *    배포 전 codex 표본의 `cachedTokens` 분포 — 0:13턴 / 1~3,999:48턴 / 4,000~9,999:8턴
 *    / 10,000~19,999:31턴 / 20,000+:46턴.  **정확히 3,456 인 턴이 48개** = 사고의 지문
 *    (instructions=sysprompt 19,385B 만 적중, 조립 프리픽스는 캐시 밖).
 *
 *  그래서 *비율*이 아니라 **절대 바닥**으로 본다. 비율은 다중 iteration 턴의 턴-내 재사용이
 *  분자를 부풀려 두 모집단(단일턴 11.7% vs 다중 49~62%)이 섞여 신호가 죽는다. 반면
 *  "안정 프리픽스가 걸렸나" 는 절대량으로 깨끗이 갈린다:
 *    - 깨진 상태 = instructions 만 적중 ≈ 3,456 (또는 0)
 *    - 정상 상태 = sysprompt + 안정 스캐폴딩 49,468B ≈ 8,800 토큰 이상
 *  6,000 은 그 사이. 위/아래 어느 쪽에도 붙지 않게 뒀다.
 *
 * 콜드 오탐 방지: 유휴 후 첫 턴은 캐시 TTL 만료로 **정상적으로** 0 이다. 그래서 한 번은
 *  세기만 하고, 같은 대화에서 연속 3턴이면 그때 운다(진짜 회귀는 지속적이다).
 */
const PREFIX_CACHE_MIN_INPUT_TOKENS = 8_000;
/** 이 아래면 "안정 스캐폴딩이 캐시에 안 걸렸다" — 위 주석의 실측 분포에서 유도. */
const PREFIX_CACHE_MIN_CACHED_TOKENS = 6_000;
/** 연속 몇 턴이면 콜드가 아니라 회귀로 볼지. */
const PREFIX_CACHE_COLD_STREAK = 3;

/**
 * 순수 판정 — "이 턴은 안정 프리픽스를 못 탔다". 판정 불가(미보고)·소형 턴은 false.
 * 회귀 검사가 실측 수치로 이 경계를 고정한다(regression/prefix-cache-threshold).
 */
export const isPrefixCacheCold = (usage: {
  inputTokens?: number;
  cachedTokens?: number;
}): boolean => {
  const { inputTokens, cachedTokens } = usage;
  if (inputTokens === undefined || cachedTokens === undefined) return false;
  if (inputTokens < PREFIX_CACHE_MIN_INPUT_TOKENS) return false;
  return cachedTokens < PREFIX_CACHE_MIN_CACHED_TOKENS;
};

/** threadKey → 연속 콜드 턴 수. 정상 턴이 오면 지운다(핫 워킹셋만 바운드). */
const coldStreak = new Map<string, number>();

/**
 * 주기 롤업 — **정상일 때도 로그에 수치를 남긴다** (2026-07-30).
 *
 * ★왜 필요한가(실제로 막혔던 일): 위 경고는 "나쁠 때만" 운다. 그래서 **원격 접속이 안 되는
 *  인스턴스**(회사돌쇠·회사PC·윈도우)에서는 개선이 됐는지 **영영 확인할 수 없다** — 망가진
 *  것만 알 수 있다. 실제로 회사돌쇠 로그 284줄을 받았는데 `usage`·`cached` 문자열이 0건이라
 *  적중률을 못 쟀다(디버그 라인은 `CODEX_DEBUG_USAGE=1` 게이트 뒤).
 *  운영 원칙이 "로그가 1차 진단면 / **성공도 남기고**, 반복은 세라" 인데 뒤쪽만 지켰던 것.
 *
 * 매 턴이 아니라 N턴마다 **집계 한 줄** — 배경소음 0, 로그만으로 판정 가능.
 * 분모는 **턴 합계**(Total 우선)다: "이 하네스가 실제로 태운 입력 중 얼마가 캐시였나"가
 * 알고 싶은 값이라, 마지막 호출 1회가 아니라 턴 전체가 맞다.
 */
/**
 * ★임계는 **프로세스 수명**보다 짧아야 한다 (2026-07-31 실측 교정).
 *
 * 처음엔 50턴/6시간으로 잡았는데 **하루 한 줄도 안 나왔다.** 집계 상태가 인메모리라
 * 프로세스가 죽으면 통째로 사라지는데, dev 데몬은 07-29 에 **32번 재부팅**했다
 * (턴 114 ÷ 부팅 32 = **부팅당 3.6턴**, 평균 수명 45분). 50턴에도 6시간에도 닿을 수가
 * 없었다 — "N턴마다 한 줄" 이라 써놓고 분모를 프로세스 수명과 비교해보지 않았다.
 * 임계를 낮추는 것만으론 부족하다(3.6턴 < 어떤 합리적 N). **종료 시 flush 가 본체**고,
 * 아래 두 수치는 오래 사는 인스턴스(prod)용 상한이다.
 */
const ROLLUP_EVERY_TURNS = 20;
const ROLLUP_MAX_WINDOW_MS = 60 * 60 * 1000;

interface RollupBucket {
  turns: number;
  input: number;
  cached: number;
}
const rollup = new Map<string, RollupBucket>();
let rollupTurns = 0;
let rollupUnreported = 0;
let rollupWindowStart = 0;

const flushPrefixCacheRollup = (now: number): void => {
  const parts: string[] = [];
  let totalIn = 0;
  let totalCached = 0;
  for (const [adapter, b] of [...rollup.entries()].sort()) {
    totalIn += b.input;
    totalCached += b.cached;
    const pct = b.input > 0 ? ((b.cached / b.input) * 100).toFixed(1) : "—";
    parts.push(`${adapter} ${b.turns}턴 ${pct}%`);
  }
  const overall = totalIn > 0 ? ((totalCached / totalIn) * 100).toFixed(1) : "—";
  const mins = Math.round((now - rollupWindowStart) / 60000);
  console.log(
    `[prefix-cache] 최근 ${rollupTurns}턴/${mins}분 적중률 ${overall}% ` +
      `(cached ${totalCached.toLocaleString("en-US")} / input ${totalIn.toLocaleString("en-US")})` +
      (parts.length > 0 ? ` — ${parts.join(" · ")}` : "") +
      (rollupUnreported > 0 ? ` · usage 미보고 ${rollupUnreported}턴` : ""),
  );
  rollup.clear();
  rollupTurns = 0;
  rollupUnreported = 0;
  rollupWindowStart = now;
};

const accumulatePrefixCacheRollup = (
  spec: ModelSpec,
  output: RegionASdkOutput,
): void => {
  const now = Date.now();
  if (rollupWindowStart === 0) rollupWindowStart = now;
  rollupTurns += 1;
  // 턴 전체 소비 기준(Total 우선) — 호출 1회가 아니라 "이 턴이 태운 총량".
  const input = output.usage?.inputTokensTotal ?? output.usage?.inputTokens;
  const cached = output.usage?.cachedTokensTotal ?? output.usage?.cachedTokens;
  if (typeof input === "number" && typeof cached === "number" && input > 0) {
    const adapter = adapterLabel(spec.adapter);
    const b = rollup.get(adapter) ?? { turns: 0, input: 0, cached: 0 };
    b.turns += 1;
    b.input += input;
    b.cached += cached;
    rollup.set(adapter, b);
  } else {
    rollupUnreported += 1; // 미보고 어댑터도 세어 둔다(그 자체가 관측 갭 신호).
  }
  if (
    rollupTurns >= ROLLUP_EVERY_TURNS ||
    now - rollupWindowStart >= ROLLUP_MAX_WINDOW_MS
  ) {
    flushPrefixCacheRollup(now);
  }
};

// ★종료 flush — 이게 짧게 사는 인스턴스의 **주 배출 경로**다(위 임계는 상한).
//  소유자가 자기 훅을 등록한다(index.ts 의 자식 정리 컨벤션과 같은 규약).
//  `beforeExit` 가 아니라 `exit` 인 이유: shutdown() 이 `process.exit(0)` 로 끝내므로
//  beforeExit 는 발화하지 않는다. exit 훅은 동기만 허용 — console.log 뿐이라 충족.
process.on("exit", () => {
  if (rollupTurns > 0) flushPrefixCacheRollup(Date.now());
});

const warnIfPrefixCacheCold = (
  spec: ModelSpec,
  input: RegionASdkInput,
  output: RegionASdkOutput,
): void => {
  // 턴-내 재사용이 섞이지 않도록 **호출 단위** 값으로 본다(Total 은 iteration 합계).
  const inputTokens = output.usage?.inputTokens;
  const cached = output.usage?.cachedTokens;
  if (!isPrefixCacheCold({ inputTokens, cachedTokens: cached })) {
    coldStreak.delete(input.threadKey);
    return;
  }
  // 스레드가 많아져도 무한 성장하지 않게 — 휘발성 카운터라 통째로 버려도 무해.
  if (coldStreak.size > 500) coldStreak.clear();
  const streak = (coldStreak.get(input.threadKey) ?? 0) + 1;
  coldStreak.set(input.threadKey, streak);
  if (streak < PREFIX_CACHE_COLD_STREAK) return;
  console.warn(
    `[prefix-cache] 안정 프리픽스가 ${streak}턴 연속 캐시에 안 걸린다 — ` +
      `cached=${cached} (기대 ${PREFIX_CACHE_MIN_CACHED_TOKENS}+), input=${inputTokens}, ` +
      `adapter=${adapterLabel(spec.adapter)} thread=${input.threadKey}. ` +
      "시스템 채널의 안정 조각이 턴마다 바뀌고 있다는 신호 " +
      '— prompt-assembly buildContextSlots 의 channel:"system" 슬롯을 의심하라 ' +
      "(과거 지문: cached 가 정확히 3,456 = sysprompt 만 적중).",
  );
};

// 견고성(임무 §4) — 발행은 try/catch boundary. 발행 실패가 어댑터 턴/데몬을 절대
// 못 죽이게 (관측은 best-effort). EventBus 자체도 subscriber throw 를 격리하지만
// publish 호출 자체(getEventBus 등)의 만일을 위해 한 겹 더 감싼다.
const publishTurnDone = (
  spec: ModelSpec,
  input: RegionASdkInput,
  output: RegionASdkOutput,
  durationMs: number,
): void => {
  try {
    warnIfPrefixCacheCold(spec, input, output);
    accumulatePrefixCacheRollup(spec, output);
    const payload: RegionATurnDonePayload = {
      channel: input.channel,
      threadKey: input.threadKey,
      adapter: adapterLabel(spec.adapter),
      durationMs,
      ok: true,
      // 거짓값 금지 — 어댑터가 보고한 경우만 포함(미보고 시 키 생략).
      ...(output.model !== undefined && output.model !== null && output.model !== ""
        ? { model: output.model }
        : spec.model !== ""
          ? { model: spec.model }
          : {}),
      // ★시대 표식 (2026-07-30) — 같은 컬럼에 **두 의미**가 섞였다. 07-30 이전 claude 행은
      //  캐시 읽기를 뺀 증분(평균 199), 이후는 호출 단위 전체 입력. 스케일이 수천 배 다르다.
      //  사후 집계(context-windows.ts 주석의 "실사용 358턴" 같은 실측)가 시대를 가르려면
      //  날짜 손목록이 아니라 판정 가능한 필드가 있어야 한다.
      usageSchema: 2,
      ...(output.usage?.inputTokens !== undefined
        ? { inputTokens: output.usage.inputTokens }
        : {}),
      ...(output.usage?.outputTokens !== undefined
        ? { outputTokens: output.usage.outputTokens }
        : {}),
      ...(output.usage?.cachedTokens !== undefined
        ? { cachedTokens: output.usage.cachedTokens }
        : {}),
      ...(output.usage?.iterations !== undefined
        ? {
            iterations: output.usage.iterations,
            inputTokensTotal: output.usage.inputTokensTotal,
            cachedTokensTotal: output.usage.cachedTokensTotal,
          }
        : {}),
      ...(input.subagentDepth !== undefined
        ? { subagentDepth: input.subagentDepth }
        : {}),
      ...(input.workerDepth !== undefined
        ? { workerDepth: input.workerDepth }
        : {}),
    };
    getEventBus().publish({
      type: "llm.turn_done",
      ts: Date.now(),
      payload: payload as unknown as Record<string, unknown>,
    });
  } catch (pubErr) {
    console.error("llm-runtime: turn_done publish failed:", pubErr);
  }
};

const publishTurnError = (
  spec: ModelSpec,
  /**
   * ★이 실패 뒤에 **실제로 시도할 다음 모델이 있는가** (2026-07-30).
   * 대시보드는 지금까지 무조건 "다른 모델로 이어서 시도합니다" 를 붙였는데, 단일 모델
   * 세션(의도적 설정)에서는 **항상 거짓말**이었다 — 사용자는 오지 않을 답을 기다린다.
   * 실측(회사 27분 과부하): `시도=codex-oauth:gpt-5.6-sol` 7회 전부 후보 0인데 그 문구가 떴다.
   */
  hasFallback: boolean,
  input: RegionASdkInput,
  e: unknown,
  durationMs: number,
): void => {
  try {
    const detail = errorDetail(e);
    // 해제 시각 — **등록된 쿨다운을 조회**한다(문자열을 여기서 다시 파싱하지 않는다:
    //  같은 판단이 두 곳에 생기면 반드시 갈린다). 0 이면 한도 실패가 아니거나 미등록.
    const remainMs = cooldownRemainingMs(spec);
    const payload: RegionATurnErrorPayload = {
      channel: input.channel,
      threadKey: input.threadKey,
      adapter: adapterLabel(spec.adapter),
      ...(remainMs > 0 ? { cooldownUntilTs: Date.now() + remainMs } : {}),
      durationMs,
      ok: false,
      errorKind: classifyTurnError(e),
      hasFallback,
      message:
        detail.length > TURN_ERROR_MESSAGE_CAP
          ? `${detail.slice(0, TURN_ERROR_MESSAGE_CAP - 1)}…`
          : detail,
      ...(spec.model !== "" ? { model: spec.model } : {}),
      ...(input.subagentDepth !== undefined
        ? { subagentDepth: input.subagentDepth }
        : {}),
      ...(input.workerDepth !== undefined
        ? { workerDepth: input.workerDepth }
        : {}),
    };
    getEventBus().publish({
      type: "llm.turn_error",
      ts: Date.now(),
      payload: payload as unknown as Record<string, unknown>,
    });
  } catch (pubErr) {
    console.error("llm-runtime: turn_error publish failed:", pubErr);
  }
};

// ─── 어댑터 쿨다운(서킷 브레이커) — 2026-07-17, 사용자 확정 ───────────────────
// "폴백되면 에러 안 올려도 됨, 대신 죽은 어댑터 ~10분 쿨다운" — rate-limit/사용량한도로
// 죽은 어댑터를 매 턴 재두드리는 통신 낭비 제거. 키는 provider(운반값 있으면)·adapter
// (레거시 spec) — poolDiversityWarning/cooldownKey 와 동일 관용구(다대일 openai 어댑터도
// provider 로 구분). 어댑터별 분기 0(문자열 휴리스틱만, 원칙 2 LLM-agnostic 하드게이트).
// 429/사용량한도만 대상 — 일반 에러·모델거부·네트워크는 미등록(기존 폴백 로직 그대로).
const cooldownUntil = new Map<string, number>();

/**
 * 긴 쿨다운을 실제로 찔러보는 간격(ms). env `COOLDOWN_PROBE_INTERVAL_MS`. **기본 4시간.**
 *
 * ★2시간 → 4시간 (2026-08-01, 사용자 결정). 탐침은 공짜가 아니다 — 실패하면 그 턴이
 *  `llm.turn_error` 로 기록되고(실측: 4일 한도 중 하루 12건), 폴백까지 한 박자 늦어진다.
 *  조기 회복을 놓치는 최대 지연이 2h→4h 로 늘지만, 실측 한도는 수일 단위라 그 비율에서
 *  4시간은 여전히 촘촘하다. **탐침 빈도는 "얼마나 빨리 알고 싶은가" 와 "얼마나 자주
 *  헛치는가" 의 교환**이고, 수일짜리 한도에선 후자가 크다.
 */
export const COOLDOWN_PROBE_INTERVAL_MS = ((): number => {
  const raw = process.env.COOLDOWN_PROBE_INTERVAL_MS;
  const n = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isInteger(n) && n > 0 ? n : 4 * 60 * 60_000;
})();

// 명시 값(resets_in_seconds/retry-after) 없을 때 기본. 상한은 오파싱·비정상 값 방어일 뿐
// (실측 codex usage_limit_reached 는 수일(예 5.7일=492480s) 지속 — 그 값은 "정확히" 존중해야
// 무의미 재탐 0 이 성립한다. 24h 로 잡으면 실측 사례 자체가 잘려나가 모순 → 7일로 넉넉히
// 잡아 정상 다일(多日) 한도는 그대로 통과시키고, 진짜 비정상(파싱버그로 인한 천문학적 값)만 방어).

// rate-limit/사용량한도 식별 — src/index.ts formatRegionAError · worker-jobs.ts
// humanizeWorkerError 와 동형 문자열 휴리스틱(진실 통일, 신규 분류축 아님).
// resets_in_seconds(codex 실측) / retry-after(HTTP 표준) 초 단위 파싱 → ms. 없으면 null
// (호출자가 DEFAULT_COOLDOWN_MS 로 강등). src/index.ts 의 동일 정규식과 진실 통일.
// 쿨다운 키 — provider 명시 우선(다대일 openai 어댑터를 ollama/google/openai 로 구분),
// 없으면 adapter(레거시 spec). specLabel/poolDiversityWarning 과 동일 관용구.
const cooldownKey = (spec: ModelSpec): string => spec.provider ?? spec.adapter;

// 남은 쿨다운(ms). 만료됐으면 엔트리 정리하고 0 반환(다음 조회부터 쿨다운 아님).
// export — 격리 검증(_workspace)이 등록/해제 결과를 직접 조회.
export const cooldownRemainingMs = (spec: ModelSpec): number => {
  const key = cooldownKey(spec);
  const now = Date.now();
  // ★진실은 DB (2026-07-28). 메모리 Map 만 보면 **다른 프로세스가 지운 것**(재인증 CLI,
  //  다른 인스턴스)이 돌고 있는 데몬에 안 먹혀 "인증했는데 왜 계속 폴백하지" 가 된다
  //  (실사고: codex 재인증 후에도 4일치 쿨다운이 그대로 남음). Map 은 DB 조회 실패 시의
  //  폴백 캐시로만 둔다 — 조회는 PK 단건이라 비용 무시.
  try {
    const row = getCooldownRow(key, now);
    if (row === null) {
      cooldownUntil.delete(key); // 캐시 동기화.
      return 0;
    }
    cooldownUntil.set(key, row.untilTs);
    // ★주기 탐침 (2026-07-28, 사용자 실측) — 백엔드가 알려준 해제 시각은 **힌트지 사실이
    //  아니다**. codex 는 그 날짜보다 일찍 풀리는 경우가 관측됐다. 시계만 믿고 며칠을
    //  기다리면 이미 풀린 백엔드를 계속 놀린다(그동안 폴백 비용을 계속 낸다).
    //  긴 쿨다운에 한해 일정 간격으로 **실제로 한 번 찔러본다** — 성공하면
    //  clearCooldownOnSuccess 가 즉시 해제하고, 아직이면 429 로 다시 등록될 뿐이다
    //  (자기교정). 탐침 시각을 영속해 재시작이 탐침 폭주가 되지 않게 한다.
    const remaining = row.untilTs - now;
    if (
      remaining > COOLDOWN_PROBE_INTERVAL_MS &&
      now - row.lastProbeTs >= COOLDOWN_PROBE_INTERVAL_MS
    ) {
      markCooldownProbe(key, now);
      console.log(
        `llm-runtime: '${key}' 쿨다운 탐침 — 남은 ${Math.round(remaining / 3600000)}시간이지만 ` +
          `${Math.round(COOLDOWN_PROBE_INTERVAL_MS / 3600000)}시간마다 한 번 실제로 시도합니다(조기 회복 감지).`,
      );
      return 0; // 이번 한 번만 통과 — 실패하면 429 로 재등록된다.
    }
    return remaining;
  } catch {
    // DB 조회 실패 — 쿨다운을 "없음" 으로 오판하면 죽은 백엔드를 다시 두드린다.
    // 메모리 캐시로 폴백(보수적).
    const cached = cooldownUntil.get(key);
    if (cached === undefined) return 0;
    const remaining = cached - now;
    if (remaining <= 0) {
      cooldownUntil.delete(key);
      return 0;
    }
    return remaining;
  }
};

// 관측 — 진입/스킵/해제를 이벤트로(대시보드/진단 "N분 남음" 가시화). best-effort
// (publishTurnDone/Error 와 동형 try/catch) — 발행 실패가 쿨다운 로직·턴에 무영향.
const publishCooldownEvent = (
  action: "enter" | "skip" | "clear",
  key: string,
  remainingMs: number,
): void => {
  try {
    getEventBus().publish({
      type: "llm.cooldown",
      ts: Date.now(),
      payload: { action, key, remainingMs },
    });
  } catch (pubErr) {
    console.error("llm-runtime: cooldown event publish failed:", pubErr);
  }
};

// 쿨다운 스킵 선별 — runPool 이 그대로 사용(로직 단일 소스, 중복 0). rate-limit 걸린
// spec 은 제외하고, ★전부 쿨다운이면 원본 pool 그대로 반환(last-resort) — 유효 풀이 비어
// 턴이 응답 0 으로 죽으면 안 됨(쿨다운은 최적화일 뿐, 하드 차단 아님). export — 격리 검증
// (_workspace) 이 실제 runPool 이 쓰는 이 함수를 직접 호출(mock 어댑터 불필요, 순수 함수).
export const selectEligiblePool = (
  pool: ModelSpec[],
  inputChars = 0,
): ModelSpec[] => {
  // ★용량 스킵 (2026-07-26) — 입력이 그 모델의 관측 상한을 넘으면 **아예 호출하지 않는다**.
  //
  //  동기(실측): 60만자 넘는 요청이 codex 에서 매번 빈 응답으로 돌아왔고(오류조차 아님),
  //  20초를 버린 뒤 다음 모델로 폴백해 결국 성공했다. 앱은 멀쩡해 보이지만 매 호출 20초를
  //  버리고, 사용자는 원인을 모른다.
  //
  //  ★이건 "폴백으로 결함 덮기" 가 아니라 **처음부터 감당 가능한 모델을 고르는 것**이다.
  //   [[feedback_no_cross_adapter_fallback]] 이 금지하는 건 결함을 가리는 폴백이지,
  //   용량에 맞는 라우팅이 아니다. 한도는 관측값이라 코드가 아닌 settings 에서 온다.
  //
  //  한도 미설정 모델은 그대로 통과 — 모르는 것에 추측 한도를 씌우지 않는다.
  const limits = inputChars > 0 ? loadModelInputLimits() : new Map<string, number>();
  const withinCapacity = pool.filter((spec) => {
    // ★키는 `provider:model`(specLabel) — 쿨다운 키(provider 단위)와 다르다. 용량은
    //  같은 provider 안에서도 모델마다 다르므로 모델까지 구분해야 한다.
    const cap = limits.get(specLabel(spec));
    if (cap === undefined || inputChars <= cap) return true;
    console.warn(
      `llm-runtime: '${specLabel(spec)}' 입력 ${inputChars.toLocaleString()}자 > 상한 ` +
        `${cap.toLocaleString()}자 — 호출 없이 스킵(용량 초과).`,
    );
    return false;
  });
  // 전부 초과여도 풀을 비우지 않는다 — 상한은 관측값(추정)이라 하드 차단이면 오관측 하나가
  // 턴을 통째로 죽인다. 마지막엔 그냥 시도해 본다(쿨다운의 last-resort 와 같은 태도).
  const sized = withinCapacity.length > 0 ? withinCapacity : pool;
  const eligible = sized.filter((spec) => {
    const remaining = cooldownRemainingMs(spec);
    if (remaining <= 0) return true;
    const key = cooldownKey(spec);
    console.warn(
      `llm-runtime: '${key}' 쿨다운 중(${Math.ceil(remaining / 60000)}분 남음) — 스킵.`,
    );
    publishCooldownEvent("skip", key, remaining);
    return false;
  });
  return eligible.length > 0 ? eligible : sized;
};

/**
 * 현재 쿨다운 중인 provider 목록 — `/status` 표시용 (2026-07-27).
 *
 * ★왜 필요한가(실사고): ChatGPT Plus 주간 한도 소진으로 codex 가 **6일간** 쿨다운에
 *  들어갔는데, 그 사실이 로그 외 어디에도 안 보였다. 폴백(claude)이 받아내 서비스는
 *  안 끊겼지만 사용자는 "왜 codex 를 안 쓰지?" 를 확인할 방법이 없었다.
 *  **푸시는 안 한다**(폴백이 정상 동작하므로 알림은 노이즈 — 사용자 판단).
 *  물어봤을 때 보이기만 하면 된다.
 *
 * 만료분은 자연히 빠진다(cooldownRemainingMs 가 만료 엔트리를 정리).
 */
export const listActiveCooldowns = (): { key: string; remainingMs: number }[] => {
  const now = Date.now();
  // ★표시도 **집행과 같은 소스**를 본다 (2026-07-29 검토). 종전엔 메모리 Map 만 읽어,
  //  집행(cooldownRemainingMs)은 DB 를 보는데 /status·/cooldown 은 다른 답을 했다.
  //  실측 시나리오: 다른 프로세스(codex-auth)가 DB 를 지우면 표시엔 계속 남고, 반대로
  //  DB 에만 있으면 표시는 비었는데 집행은 계속 막는다 = 자기 잠금 재발 경로.
  try {
    const rows = loadLiveCooldowns(now);
    for (const r of rows) cooldownUntil.set(r.key, r.untilTs); // 캐시 동기화.
    for (const key of [...cooldownUntil.keys()]) {
      if (!rows.some((r) => r.key === key)) cooldownUntil.delete(key);
    }
    return rows
      .map((r) => ({ key: r.key, remainingMs: r.untilTs - now }))
      .filter((c) => c.remainingMs > 0)
      .sort((a, b) => b.remainingMs - a.remainingMs);
  } catch {
    // DB 조회 실패 — 메모리 폴백(보수적: 있는 것을 없다고 하지 않는다).
    const out: { key: string; remainingMs: number }[] = [];
    for (const [key, until] of cooldownUntil) {
      const remaining = until - now;
      if (remaining > 0) out.push({ key, remainingMs: remaining });
    }
    return out.sort((a, b) => b.remainingMs - a.remainingMs);
  }
};

// 실패가 rate-limit 이면 쿨다운 등록(문자열 미매칭 → no-op, 기존 폴백 로직 그대로).
// errorDetail(cause 포함) 문자열로 판정 — isModelRejected 와 동일 지점(facade 단일 휴리스틱).
// export — 격리 검증(_workspace)이 mock 어댑터 없이 직접 호출.
/**
 * 부팅 복원 — 만료 전 쿨다운을 메모리 Map 으로 되살린다. 데몬 부팅 1회 호출.
 * 실패해도 빈 상태로 시작(종전 동작) — 쿨다운은 최적화지 정합성 요건이 아니다.
 */
export const restoreCooldowns = (): void => {
  const live = loadLiveCooldowns(Date.now());
  for (const { key, untilTs } of live) cooldownUntil.set(key, untilTs);
  if (live.length > 0) {
    console.log(
      `llm-runtime: 쿨다운 ${live.length}건 복원 — ${live
        .map((c) => `${c.key}(${Math.ceil((c.untilTs - Date.now()) / 60000)}분 남음)`)
        .join(", ")}`,
    );
  }
};

export { isRateLimited, parseCooldownMs };

/**
 * @returns 이번 호출로 **새로 쿨다운에 들어갔으면** 그 정보, 아니면 null.
 *
 * ★"새로" 를 구분하는 이유 (2026-08-01): 쿨다운 중에도 4시간마다 탐침이 돈다. 탐침이
 *  실패하면 429 로 여기 다시 들어와 쿨다운을 재등록하는데, 그걸 전부 "진입" 으로 치면
 *  사용자에게 **4시간마다 같은 통지**가 간다(4일 한도면 24통). 상태가 바뀐 순간에만
 *  알려야 한다 — 알림의 기준은 "실패했다" 가 아니라 **"상태가 바뀌었다"** 다.
 */
// ★요약 호출도 같은 쿨다운 규칙을 지키게 한다 (2026-08-01).
//  히스토리 압축은 codex 어댑터 **안**에서 일어나 이 판정에 닿을 수 없었다(어댑터→index 는
//  순환). 그래서 메인 턴이 쿨다운으로 건너뛰는 동안에도 요약만 계속 때려 실패했고, 그때마다
//  oldest-drop 으로 맥락이 잘렸다. 판정은 여기 하나로 두고 **포트로 내려보낸다**
//  (index→history 는 순환이 아니다 — history 는 index 를 import 하지 않는다).
setSummarizerCooldownPort({
  remainingMs: (key) => {
    const now = Date.now();
    try {
      const row = getCooldownRow(key, now);
      return row === null ? 0 : Math.max(0, row.untilTs - now);
    } catch {
      return 0; // 조회 실패가 요약을 막지 않는다(관측 심이 기능을 죽이면 안 된다).
    }
  },
  register: (key, detail) => {
    if (!isRateLimited(detail)) return; // 한도 아닌 실패는 쿨다운 대상이 아니다.
    const ms = parseCooldownMs(detail) ?? DEFAULT_COOLDOWN_MS;
    const untilTs = Date.now() + ms;
    cooldownUntil.set(key, untilTs);
    saveCooldown(key, untilTs);
    console.warn(
      `llm-runtime: '${key}' rate-limited(요약 경로) — ${Math.ceil(ms / 60000)}분 쿨다운 등록 ` +
        `(해제 ${new Date(untilTs).toLocaleString("ko-KR")}).`,
    );
    publishCooldownEvent("enter", key, ms);
  },
});

export const registerCooldownIfRateLimited = (
  spec: ModelSpec,
  e: unknown,
): { key: string; untilTs: number } | null => {
  const detail = errorDetail(e);
  if (!isRateLimited(detail)) return null;
  const parsed = parseCooldownMs(detail);
  const ms = parsed ?? DEFAULT_COOLDOWN_MS;
  const key = cooldownKey(spec);
  // 이미 쿨다운 중이었나 — 재등록(탐침 실패)과 신규 진입을 가른다. 만료분은 0 이라 신규.
  const wasCoolingDown = (() => {
    try {
      return getCooldownRow(key, Date.now()) !== null;
    } catch {
      return false; // 조회 실패 시 신규로 본다(알리는 쪽이 안전 — 조용한 누락보다 낫다).
    }
  })();
  const untilTs = Date.now() + ms;
  cooldownUntil.set(key, untilTs);
  saveCooldown(key, untilTs); // 영속 — 재시작해도 죽은 백엔드를 다시 두드리지 않게.
  console.warn(
    // ★출처 분기 병기 (2026-07-30) — "8228분"이 백엔드가 말한 값인지, 파싱 실패로 기본값
    //  인지, 비정상 값이 7일 상한에 잘린 건지 로그만으로는 구분이 안 됐다. 상수를 외워야
    //  산술로 추론해야 했고, 그게 "6일 공백" 사고에서 답을 못 낸 질문이었다.
    `llm-runtime: '${key}' rate-limited — ${Math.ceil(ms / 60000)}분 쿨다운 등록 ` +
      `(${parsed === null ? "기본값" : ms >= MAX_COOLDOWN_MS ? "상한 클램프" : "백엔드 지정"}, ` +
      `해제 ${new Date(untilTs).toLocaleString("ko-KR")}).`,
  );
  publishCooldownEvent("enter", key, ms);
  return wasCoolingDown ? null : { key, untilTs };
};

// 성공 시 조기 회복 — 만료 전이라도 실제 성공하면 즉시 해제(재탐 낭비 축소). 엔트리
// 없으면 no-op(쿨다운 아니었던 정상 어댑터 — 매 턴 no-op 오버헤드 0에 가까움).
// export — 격리 검증(_workspace)이 직접 호출.
export const clearCooldownOnSuccess = (spec: ModelSpec): void => {
  const key = cooldownKey(spec);
  if (cooldownUntil.delete(key)) {
    deleteCooldown(key);
    publishCooldownEvent("clear", key, 0);
  }
};

/**
 * 쿨다운 강제 해제 — 사용자 명시 조치용(`/cooldown clear`).
 *
 * ★왜 필요한가 (2026-07-28): 쿨다운은 "호출이 성공하면" 풀리는데(clearCooldownOnSuccess),
 *  쿨다운 중엔 그 백엔드를 **아예 안 부르므로** 스스로는 절대 안 풀린다 = 자기 잠금.
 *  종전엔 재시작이 메모리를 비워 우연히 탈출구 역할을 했지만, 쿨다운을 영속으로 바꾸면서
 *  (죽은 백엔드를 매 부팅 다시 두드리던 낭비 차단) 그 우연한 탈출구가 사라졌다.
 *  그래서 **재인증·요금제 변경처럼 전제가 바뀐 경우**를 위한 명시적 해제가 필요하다.
 *  메모리와 DB 를 함께 지운다 — 한쪽만 지우면 재시작 때 되살아나거나 즉시 안 먹는다.
 *
 * @param prefix 비우면 전체. 주면 그 접두(예 "codex")로 시작하는 키만.
 * @returns 해제된 키 목록.
 */
export const clearCooldowns = (prefix?: string): string[] => {
  const want = prefix?.trim() ?? "";
  const cleared: string[] = [];
  // ★DB 에만 있는 행도 대상 (2026-07-29 검토). 메모리 Map 만 순회하면, 다른 프로세스가
  //  등록했거나 이 프로세스가 아직 안 읽은 쿨다운은 "해제할 게 없습니다" 라고 답해 놓고
  //  집행은 계속 막힌다 — c8a702e 가 없애려던 자기 잠금이 그대로 재발한다.
  try {
    for (const r of loadLiveCooldowns(Date.now())) cooldownUntil.set(r.key, r.untilTs);
  } catch {
    /* DB 조회 실패 — 메모리에 있는 것만이라도 해제 */
  }
  for (const key of [...cooldownUntil.keys()]) {
    if (want !== "" && !key.startsWith(want)) continue;
    cooldownUntil.delete(key);
    try {
      deleteCooldown(key);
    } catch {
      /* DB 실패해도 메모리는 풀렸다 — 다음 부팅에 되살아나면 다시 해제 가능 */
    }
    publishCooldownEvent("clear", key, 0);
    cleared.push(key);
  }
  return cleared;
};


// V5 — 응답 후 어댑터 무관 통합 처리. 어댑터 차이는 jsonlPath 유무로 표현.
const persistOutput = (
  input: RegionASdkInput,
  output: RegionASdkOutput,
): void => {
  if (output.sessionId === undefined || output.text === "") return;
  const sessionId = output.sessionId;

  // 채널/세션 분리(ADR 2026-07-15 §D1) — 세션-정체성(threads resume sid / transcript_index)
  // 은 canonical 저장 채널로 키잉. route() 가 채널 인입을 세션으로 정규화할 때 sessionChannel
  // (=SESSION_STORAGE_CHANNEL)을 실어보낸다. 미지정(워커·스케줄러·서브에이전트·엔드포인트·
  // Phase 1 이전 채널) → channel 폴백(현행 (channel, threadKey) 키잉 그대로, 회귀 0).
  // 어댑터의 getSession(idChannel) 과 대칭 — 저장·조회가 같은 canonical 키를 봐야 계승됨.
  const idChannel = input.sessionChannel ?? input.channel;

  if (output.jsonlPath !== undefined) {
    // claude 어댑터 — SDK 자체 jsonl 이 진실 소스. saveSession 으로 claude resume sid
    // 갱신 (기존 동작 그대로) + catch-up 인덱싱 (fire-and-forget).
    try {
      saveSession({
        channel: idChannel,
        threadKey: input.threadKey,
        claudeSessionId: sessionId,
        model: output.model ?? null,
        systemPromptHash: output.systemPromptHash ?? null,
        // /status 개편 — usage 미캡처 시 undefined → store NULL-clobber 가드로 기존값 보존.
        lastInputTokens: output.usage?.inputTokens,
        lastOutputTokens: output.usage?.outputTokens,
      });
    } catch (e) {
      console.error("llm-runtime: saveSession failed:", e);
    }
    const jsonlPath = output.jsonlPath;
    void Promise.resolve()
      .then(() =>
        indexJsonlIfNeeded({
          channel: idChannel,
          threadKey: input.threadKey,
          claudeSessionId: sessionId,
          jsonlPath,
        }),
      )
      .catch((e) => {
        console.error("llm-runtime: indexJsonlIfNeeded failed:", e);
      });
  } else {
    // codex·openai 어댑터 — jsonl 없음. (contract Part B v2 §B-4·B-5)
    //  - preserveSessionId:true → codex 가 threads.claude_session_id (claude SDK resume
    //    전용) 를 자기 sid 로 clobber 하지 않음 (model/last_used_at 만 갱신). claude
    //    연속 resume 무손상.
    //  - transcripts 직접 INSERT (user + assistant) 후 indexCodexTurn 으로
    //    transcript_index 에 (channel, threadKey, codex sid) 등록 → loadThreadHistory
    //    가 이 codex turn 을 thread 횡단 회수 가능 (cross-adapter 연속성 완성).
    try {
      saveSession({
        channel: idChannel,
        threadKey: input.threadKey,
        claudeSessionId: sessionId,
        model: output.model ?? null,
        systemPromptHash: output.systemPromptHash ?? null,
        preserveSessionId: true,
        // /status 개편 — codex(preserve) 경로도 usage 전달. 미캡처 시 undefined → 보존.
        lastInputTokens: output.usage?.inputTokens,
        lastOutputTokens: output.usage?.outputTokens,
      });
    } catch (e) {
      console.error("llm-runtime: saveSession failed:", e);
    }
    try {
      // cross-adapter 0유실 — claude jsonl 은 placeholder(첨부 경로+메타)를 자연
      // 인덱싱하나 codex 는 raw text 만 INSERT 하면 이후 claude turn 의
      // loadThreadHistory 가 과거 codex 첨부 사실·경로를 소실. 어댑터가 prompt 에
      // prepend 하는 것과 *동일* formatAttachments 결과를 persist content 에도 prepend
      // (의미적으로 claude jsonl 과 동등, 중복/불일치 0). 첨부 없으면 "" → 현행 동등.
      const attachmentBlock = formatAttachments(input.attachments);
      const userContent =
        attachmentBlock.length > 0
          ? `${attachmentBlock}\n\n${input.text}`
          : input.text;
      appendTranscript({
        claudeSessionId: sessionId,
        role: "user",
        content: userContent,
      });
      appendTranscript({
        claudeSessionId: sessionId,
        role: "assistant",
        content: output.text,
      });
      indexCodexTurn({
        channel: idChannel,
        threadKey: input.threadKey,
        claudeSessionId: sessionId,
      });
    } catch (e) {
      console.error("llm-runtime: appendTranscript/indexCodexTurn failed:", e);
    }
  }
};

/**
 * 영역 A 통합 진입점. 어댑터 풀 폴백 + 응답 후 saveSession·transcripts 자동.
 */
// 풀 1개를 순서대로 시도 — 첫 성공 즉시 persist 후 반환. 모두 실패 시 lastError throw.
// override 경로와 env-풀 폴백 경로가 *동일* 코드로 돌아 parity 보존 (어댑터별 분기 0).
const runPool = async (
  input: RegionASdkInput,
  pool: ModelSpec[],
): Promise<RegionASdkOutput> => {
  let lastError: unknown;
  // 쿨다운 스킵 — rate-limit 걸린 어댑터를 매 턴 재두드리지 않음(호출 자체를 안 함,
  // 레이턴시+통신 낭비 제거). 전부 쿨다운이면 selectEligiblePool 이 원본 pool 그대로
  // 반환(last-resort, 유효 풀이 비어 턴이 응답 0 으로 죽지 않게).
  const effectivePool = selectEligiblePool(pool, input.text?.length ?? 0);
  /** 시도한 spec 체인 — 실패 통보가 "왜 이 어댑터냐"를 설명할 수 있게(2026-07-30). */
  const attemptChain: string[] = [];
  const poolStartedAt = Date.now();
  let specIndex = -1;
  for (const spec of effectivePool) {
    specIndex += 1;
    attemptChain.push(`${spec.adapter}:${spec.model}`);
    // self-growth 입력 — 한 어댑터 run() 호출(=한 턴) wall-clock 측정. 발행은 아래
    // 성공/실패 경로에서 정확히 1회 (turn_done XOR turn_error). 발행 자체는 best-effort
    // (publishTurnDone/Error 내부 try/catch) — 턴/데몬 안 죽임(임무 §4).
    const startedAt = Date.now();
    try {
      // model "" → undefined (어댑터 디폴트). input.model 로 주입.
      // provider 운반 — openai 어댑터가 self-lookup 으로 baseURL/apiKey 해석.
      // claude/codex 어댑터는 이 필드를 읽지 않음(무시) → 회귀 0.
      const output = await callAdapter(spec.adapter, {
        ...input,
        model: spec.model === "" ? undefined : spec.model,
        provider: spec.provider,
      });
      // turn_done — 성공 종료 1회 (parity: 세 어댑터 동일 지점). persist 전에 발행해
      // persist 예외와 무관하게 효율 지표가 남게(persist 는 자체 try/catch 라 throw 0이나
      // 안전 우선).
      // internal(분류성 1회 호출) — turn 이벤트 미발행 + persist skip. self-growth 등
      // 데이터 평면이 자기 분류 호출을 다시 turn 이벤트로 되돌리는 메타-재귀 차단(킬스위치)
      // + 분류는 대화가 아니므로 transcripts/sessions 미오염. 모델 선택/폴백은 동일 경로라
      // 어댑터 락인 0.
      if (input.internal !== true) {
        publishTurnDone(spec, input, output, Date.now() - startedAt);
        persistOutput(input, output);
      }
      // 성공 — 조기 회복(만료 전이라도 쿨다운 해제). internal 호출도 해제(어댑터 헬스는
      // 대화 여부와 무관) — 엔트리 없으면 no-op.
      clearCooldownOnSuccess(spec);
      return output;
    } catch (e) {
      // 사용자 /stop 취소 = 실패 아님 → turn_error 미발행(self-growth 실패 학습 오염 방지) +
      // 폴백 단락(같은 abortSignal 이라 다음 모델도 즉시 죽음 = 무의미). abort reason 의 name 으로
      // 판별 — index.ts UserCancelledError 를 레이어 결합(import) 없이 duck-typing. 핸들러가
      // turnAc.signal.reason 으로 조용히 종료(사용자엔 /stop 이 이미 안내).
      const cancelReason = input.abortSignal?.reason;
      if (
        input.abortSignal?.aborted === true &&
        cancelReason instanceof Error &&
        cancelReason.name === "UserCancelledError"
      ) {
        throw e;
      }
      // 잡 취소(WorkerCancelledError) = 실패 아님 (U-I4 개정) — worker 취소, 그리고 claude
      // native Task 취소(cancelJob → 부모 턴 effectiveAc abort → 어댑터가 이 에러로 승격)가
      // 여기 온다. 후자는 input.abortSignal(부모 turn 신호)이 아닌 effectiveAc 가 abort 된
      // 것이라 위 UserCancelledError 분기가 안 잡는다 → 던져진 에러의 name 으로 duck-typing.
      // turn_error 미발행(취소는 self-growth 실패 학습 대상 아님) + 폴백 단락(같은 abort 라
      // 다음 모델도 즉시 죽음 = 무의미, 또 Task 취소는 폴백=재실행이라 "stop 이 실제 stop" 위반).
      // worker 경로는 onWorkerComplete 가 이미 status="cancelled" 를 보존한다.
      if (e instanceof Error && e.name === "WorkerCancelledError") {
        throw e;
      }
      // turn_error — 실패·타임아웃 종료 1회 (성공 경로의 turn_done 과 상호배타).
      // 폴백 단락(TurnTimeoutError) 전에 발행 — 타임아웃도 self-growth 의 학습 대상.
      // internal(분류성 호출)은 미발행 — 메타-재귀 차단(킬스위치). 분류 실패는 호출자가
      // sentinel("uncertain")로 받아 강등하지, self-growth 의 실패 학습 입력이 되면 안 된다.
      // ★쿨다운 등록을 **발행보다 먼저** 한다 (2026-08-01, 사용자 지적).
      //  종전엔 발행이 먼저라, 알림을 만드는 시점에 우리도 해제 시각을 **아직 몰랐다** —
      //  그래서 사용자에게 "언제 풀리는지" 를 못 알려줬다(429 원문은 200자 컷에 `resets_at`
      //  바로 앞에서 잘려 사람이 읽을 수도 없었다). 등록은 순수 장부라 앞당겨도 안전하고,
      //  앞당기면 **아는 것을 말할 수 있게** 된다.
      const entered = registerCooldownIfRateLimited(spec, e);
      // ★채널 무관 통지 (2026-08-01, 사용자 지적: "텔레그램으로 작업하는 상황에서도
      //  알아야 하는 정보"). 종전엔 대시보드 SSE 렌더에만 있어 폰에서는 모델이 왜
      //  바뀌었는지 알 길이 없었다 — 기능이 채널에 묶이면 안 된다.
      //  ★상태 전이에만 보낸다: 탐침 실패로 인한 **재등록은 통지하지 않는다**
      //   (4시간마다 같은 말 = 배경 소음). 내부 분류 호출도 제외.
      //  LLM 무경유 raw 통지 — 한도가 걸린 상황에서 알리려고 모델을 또 태울 수는 없다.
      if (entered !== null && input.internal !== true) {
        const mins = Math.round((entered.untilTs - Date.now()) / 60000);
        const when = new Date(entered.untilTs).toLocaleString("ko-KR", {
          month: "numeric",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        });
        const dur =
          mins >= 1440
            ? `약 ${Math.round(mins / 1440)}일 뒤`
            : mins >= 60
              ? `약 ${Math.round(mins / 60)}시간 뒤`
              : `${mins}분 뒤`;
        // ★통지 좌표는 **`notifyDest` 가 있으면 그것**이다 (2026-08-06, 로그 실측 유실).
        //  스케줄 턴은 `channel="scheduler"` 로 돈다 — 그건 발송 채널이 아니라 *트리거
        //  이름*이라, 이 알림이 `deliverOutbound: 발송 채널 "scheduler" 이 등록돼 있지
        //  않습니다 — 미배달 87자 [cooldown]` 로 끝났다. 즉 위 주석이 "채널 무관 통지"라고
        //  선언한 바로 그 경로가 **비채널 트리거에서만 조용히 안 갔다**.
        //  스케줄러는 자기 목적지를 이미 `notifyDest`(destChannel/destTarget)로 주입하고
        //  있었다 — 워커 완료 통지는 그걸 쓰고 이것만 안 썼다. 좌표 도출은 새로 만들지
        //  않고 기존 단일 판정(`notifyDestFromCoords`: 캡처 좌표 → threadKey 파싱)에 맡긴다.
        const notifyAt =
          input.notifyDest ??
          notifyDestFromCoords(
            input.channel,
            input.threadKey,
            input.channelAddress,
          );
        void deliverOutbound({
          channel: notifyAt.channel,
          target: notifyAt.target,
          text:
            `⚠️ ${adapterLabel(spec.adapter)} 사용량 한도 — ${when} 해제 예정(${dur}).\n` +
            `그때까지 다른 모델로 자동 전환합니다(대화는 그대로 이어집니다).`,
          label: "cooldown",
        }).catch(() => undefined); // 통지 실패가 턴을 무르지 않는다.
      }
      if (input.internal !== true) {
        publishTurnError(
          spec,
          // ★"다음 후보가 남아있나" 가 아니라 **"실제로 다음 후보를 시도하나"** 여야 한다.
          //  바로 아래 TurnTimeoutError 는 폴백을 명시 단락하므로, 후보가 남아 있어도
          //  시도되지 않는다 — 그런데도 "다른 모델로 이어서 시도합니다" 를 띄우면
          //  단일 모델 세션에서 잡았던 것과 **같은 거짓말**이 타임아웃 경로로 되살아난다.
          specIndex < effectivePool.length - 1 && !(e instanceof TurnTimeoutError),
          input,
          e,
          Date.now() - startedAt,
        );
      }
      // 2층 턴 타임아웃(§6) — 폴백 단락. 턴 전체가 wall-clock 초과로 죽은 것이라
      // 다음 spec 으로 폴백해봐야 같은 turn signal 이 이미 abort 라 즉시 또 죽는다(무의미).
      // TurnTimeoutError 는 isModelRejected 비매칭(TT-I3)이라 runRegionA 의 override
      // 자동폴백도 안 타고 핸들러로 직행 → "⏱️ 중단" 정직 보고. 여기서 명시 단락해 깔끔히.
      if (e instanceof TurnTimeoutError) throw e;
      // (쿨다운 등록은 위 turn_error 발행 **전에** 끝났다 — 발행이 해제 시각을 실어야 해서.)
      lastError = e;
      if (effectivePool.length > 1) {
        // ★진단 수치 병기 (2026-07-30) — 종전엔 "무엇이 실패했다"만 있어 **어느 대화가
        //  죽었는지** 알 수 없었다(동시에 dashboard:*·scheduler:*·worker:* 가 도는 데몬에서
        //  주인 없는 줄). 로그만으로 원인을 좁힐 수 있어야 한다.
        console.warn(
          `llm-runtime: '${spec.adapter}:${spec.model}' failed — ${errorDetail(e)}. 다음 모델로 폴백. ` +
            `(thread=${input.threadKey} ${Date.now() - startedAt}ms in=${input.text?.length ?? 0}자 ` +
            `풀=${specIndex + 1}/${effectivePool.length})`,
        );
      }
    }
  }
  // 풀 크기 무관 진짜 원인 보존 — warn 은 pool.length>1 에서만 찍혀 단일 어댑터
  // 풀이면 cause 가 안 남음. 이 1줄로 풀 크기 무관하게 진짜 원인을 콘솔에 박는다.
  if (lastError !== undefined) {
    console.error(
      `llm-runtime: 모든 어댑터 실패 — ${errorDetail(lastError)} ` +
        `(thread=${input.threadKey} 시도=${attemptChain.join(" → ")} ${Date.now() - poolStartedAt}ms)`,
    );
  }
  throw lastError ?? new Error("llm-runtime: 모델 풀이 비어있음.");
};

export const runRegionA = async (
  input: RegionASdkInput,
  opts?: { specs?: ModelSpec[]; chain?: ModelSpec[][] },
): Promise<RegionASdkOutput> => {
  // 전사 seam(contract §1) — 오디오/음성 첨부를 chain 루프 *전* 1회 전사해 Attachment.transcript 를
  // 채운다. best-effort(enrichTranscripts 자체가 첨부 단위 격리·never-throw). 다운스트림 3 어댑터
  // formatAttachments + persistOutput 이 분기 0 으로 동일 소비 → #2 구조보장·resume 재전사 0.
  // 미설정/실패/비대상 = Attachment.transcript 미설정 → path-reference 폴백(회귀 0).
  await enrichTranscripts(input.attachments, input.cwd);
  // 풀 체인 조립 — 프로파일 간(inter) 폴백을 *분리된 풀들*로 운반한다(평탄화 금지).
  //  (1) opts.chain(신규 — 프로파일 .fallback 체인): 그대로. chain[0]=요청 풀.
  //  (2) opts.specs(레거시 — /model override·서브에이전트 단일 풀): [override, 기본 풀] 2단.
  //      = 기존 "override → env(또는 default 프로파일) 기본 풀 1회 폴백"을 체인으로 표현(의미 불변).
  //  (3) 둘 다 없음: [기본 풀] 단일 — 폴백 대상 없음(일반 turn, 무한 폴백 금지, 현행 동일).
  // hadOverride = chain[0] 이 명시 요청 풀인가(폴백 고지·트리거 게이트).
  let chain: ModelSpec[][];
  let hadOverride: boolean;
  if (opts?.chain !== undefined && opts.chain.length > 0) {
    chain = opts.chain.filter((p) => p.length > 0);
    if (chain.length === 0) chain = [resolveModelSpecs(undefined, input.cwd)];
    hadOverride = true;
  } else if (opts?.specs !== undefined && opts.specs.length > 0) {
    chain = [opts.specs, resolveModelSpecs(undefined, input.cwd)];
    hadOverride = true;
  } else {
    chain = [resolveModelSpecs(undefined, input.cwd)];
    hadOverride = false;
  }

  const requestedLabel = chain[0].map(specLabel).join(",");
  let lastError: unknown;

  for (let i = 0; i < chain.length; i++) {
    const isLast = i === chain.length - 1;
    try {
      const output = await runPool(input, chain[i]);
      // 요청 풀(chain[0]) 성공, 또는 폴백 아님(hadOverride=false) → 고지 없이 그대로 반환.
      if (i === 0 || !hadOverride) return output;
      // 프로파일 간/override 폴백 성공 — 조용한 폴백 금지. 명확 고지 + modelOverrideRejected
      // 신호(router 가 깨진 override 를 DB 에서 제거해 매 turn 경고 반복 방지).
      const fellBackToLabel =
        output.model !== undefined &&
        output.model !== null &&
        output.model !== ""
          ? output.model
          : chain[i].map(specLabel).join(",");
      const notice =
        `\n\n⚠️ 지정 모델 \`${requestedLabel}\` 을(를) 쓸 수 없어 기본 모델로 답했습니다. ` +
        `다시 지정하려면 \`/model <provider:model>\`.`;
      return {
        ...output,
        text: output.text === "" ? output.text : `${output.text}${notice}`,
        modelOverrideRejected: {
          requested: requestedLabel,
          fellBackTo: fellBackToLabel,
        },
      };
    } catch (e) {
      // 사용자 /stop 취소 = 실패 아님 → 폴백 없이 그대로 propagate(runPool 이 이미 rethrow).
      // abort reason name 으로 duck-typing(레이어 결합 회피, 기존과 동일).
      const cancelReason = input.abortSignal?.reason;
      if (
        input.abortSignal?.aborted === true &&
        cancelReason instanceof Error &&
        cancelReason.name === "UserCancelledError"
      ) {
        throw e;
      }
      // 잡 취소(WorkerCancelledError) = 실패 아님 (U-I4 개정) — 프로파일 간 폴백 없이 그대로
      // propagate. isModelRejected 비매칭이라 아래 structural 게이트도 어차피 통과 못 하지만,
      // 명시 단락으로 취소 의도를 분명히 한다(runPool 분류와 대칭).
      if (e instanceof Error && e.name === "WorkerCancelledError") {
        throw e;
      }
      // 2층 턴 타임아웃 단락 — 런타임 결함이라 다음 풀로 폴백해봐야 같은 turn signal 이 이미
      // abort 라 무의미 + 어댑터 결함 마스킹 방지(feedback_no_cross_adapter_fallback).
      if (e instanceof TurnTimeoutError) throw e;
      // 프로파일 간(inter) 폴백은 *구조적 불가*(모델부재 isModelRejected · 자격증명부재
      // isProviderUnavailable)만 트리거. 런타임 스톨/hang/타임아웃은 비트리거 — 그대로 throw.
      // 요청 풀(hadOverride)이면서 구조적 실패이고 다음 풀이 남아있을 때만 전진.
      const detail = errorDetail(e);
      const structural =
        isModelRejected(detail) || isProviderUnavailable(detail);
      if (isLast || !hadOverride || !structural) throw e;
      lastError = e;
      console.warn(
        `llm-runtime: 요청 풀 '${requestedLabel}' 구조적 실패(모델/자격증명 부재) — 체인의 다음 풀로 1회 폴백.`,
      );
    }
  }
  // 도달 불가(마지막 풀 실패는 위에서 throw) — 방어적 안전망.
  throw lastError ?? new Error("llm-runtime: 모델 풀 체인이 비어있음.");
};

// 기존 export 보존 — 회귀 0.
export { runClaude, runOpenAi, runOpenAiCodex };
export type {
  RegionASdk,
  RegionASdkInput,
  RegionASdkOutput,
  ClaudeRunInput,
  ClaudeRunOutput,
} from "./types.js";
