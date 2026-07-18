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
import { runOpenAi } from "./adapters/openai-agents-sdk.js";
import { runOpenAiCodex } from "./adapters/openai-codex-oauth.js";
import { saveSession } from "../../store/sessions.js";
import { formatAttachments } from "../prompt-assembly.js";
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
import { getEventBus } from "../eventbus.js";
import {
  resolveProfileChain,
  getDefaultProfileName,
  loadModelProviders,
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
      ...(output.usage?.inputTokens !== undefined
        ? { inputTokens: output.usage.inputTokens }
        : {}),
      ...(output.usage?.outputTokens !== undefined
        ? { outputTokens: output.usage.outputTokens }
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
  input: RegionASdkInput,
  e: unknown,
  durationMs: number,
): void => {
  try {
    const detail = errorDetail(e);
    const payload: RegionATurnErrorPayload = {
      channel: input.channel,
      threadKey: input.threadKey,
      adapter: adapterLabel(spec.adapter),
      durationMs,
      ok: false,
      errorKind: classifyTurnError(e),
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

// 명시 값(resets_in_seconds/retry-after) 없을 때 기본. 상한은 오파싱·비정상 값 방어일 뿐
// (실측 codex usage_limit_reached 는 수일(예 5.7일=492480s) 지속 — 그 값은 "정확히" 존중해야
// 무의미 재탐 0 이 성립한다. 24h 로 잡으면 실측 사례 자체가 잘려나가 모순 → 7일로 넉넉히
// 잡아 정상 다일(多日) 한도는 그대로 통과시키고, 진짜 비정상(파싱버그로 인한 천문학적 값)만 방어).
const DEFAULT_COOLDOWN_MS = 10 * 60 * 1000; // 10분
const MAX_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000; // 7일 상한(비정상 값 방어, 실측 다일 한도는 통과)

// rate-limit/사용량한도 식별 — src/index.ts formatRegionAError · worker-jobs.ts
// humanizeWorkerError 와 동형 문자열 휴리스틱(진실 통일, 신규 분류축 아님).
const isRateLimited = (errStr: string): boolean =>
  /usage_limit_reached|rate[-_ ]?limit|too many requests|\bquota\b|\b429\b/i.test(errStr);

// resets_in_seconds(codex 실측) / retry-after(HTTP 표준) 초 단위 파싱 → ms. 없으면 null
// (호출자가 DEFAULT_COOLDOWN_MS 로 강등). src/index.ts 의 동일 정규식과 진실 통일.
const parseCooldownMs = (errStr: string): number | null => {
  const m =
    errStr.match(/"resets_in_seconds"\s*:\s*(\d+)/) ||
    errStr.match(/retry[-_ ]?after["'\s:=]+(\d+)/i);
  if (m === null) return null;
  const sec = Number(m[1]);
  if (!Number.isFinite(sec) || sec <= 0) return null;
  return Math.min(sec * 1000, MAX_COOLDOWN_MS);
};

// 쿨다운 키 — provider 명시 우선(다대일 openai 어댑터를 ollama/google/openai 로 구분),
// 없으면 adapter(레거시 spec). specLabel/poolDiversityWarning 과 동일 관용구.
const cooldownKey = (spec: ModelSpec): string => spec.provider ?? spec.adapter;

// 남은 쿨다운(ms). 만료됐으면 엔트리 정리하고 0 반환(다음 조회부터 쿨다운 아님).
// export — 격리 검증(_workspace)이 등록/해제 결과를 직접 조회.
export const cooldownRemainingMs = (spec: ModelSpec): number => {
  const key = cooldownKey(spec);
  const until = cooldownUntil.get(key);
  if (until === undefined) return 0;
  const remaining = until - Date.now();
  if (remaining <= 0) {
    cooldownUntil.delete(key);
    return 0;
  }
  return remaining;
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
export const selectEligiblePool = (pool: ModelSpec[]): ModelSpec[] => {
  const eligible = pool.filter((spec) => {
    const remaining = cooldownRemainingMs(spec);
    if (remaining <= 0) return true;
    const key = cooldownKey(spec);
    console.warn(
      `llm-runtime: '${key}' 쿨다운 중(${Math.ceil(remaining / 60000)}분 남음) — 스킵.`,
    );
    publishCooldownEvent("skip", key, remaining);
    return false;
  });
  return eligible.length > 0 ? eligible : pool;
};

// 실패가 rate-limit 이면 쿨다운 등록(문자열 미매칭 → no-op, 기존 폴백 로직 그대로).
// errorDetail(cause 포함) 문자열로 판정 — isModelRejected 와 동일 지점(facade 단일 휴리스틱).
// export — 격리 검증(_workspace)이 mock 어댑터 없이 직접 호출.
export const registerCooldownIfRateLimited = (spec: ModelSpec, e: unknown): void => {
  const detail = errorDetail(e);
  if (!isRateLimited(detail)) return;
  const ms = parseCooldownMs(detail) ?? DEFAULT_COOLDOWN_MS;
  const key = cooldownKey(spec);
  cooldownUntil.set(key, Date.now() + ms);
  console.warn(
    `llm-runtime: '${key}' rate-limited — ${Math.ceil(ms / 60000)}분 쿨다운 등록.`,
  );
  publishCooldownEvent("enter", key, ms);
};

// 성공 시 조기 회복 — 만료 전이라도 실제 성공하면 즉시 해제(재탐 낭비 축소). 엔트리
// 없으면 no-op(쿨다운 아니었던 정상 어댑터 — 매 턴 no-op 오버헤드 0에 가까움).
// export — 격리 검증(_workspace)이 직접 호출.
export const clearCooldownOnSuccess = (spec: ModelSpec): void => {
  const key = cooldownKey(spec);
  if (cooldownUntil.delete(key)) {
    publishCooldownEvent("clear", key, 0);
  }
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
  const effectivePool = selectEligiblePool(pool);
  for (const spec of effectivePool) {
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
      if (input.internal !== true) {
        publishTurnError(spec, input, e, Date.now() - startedAt);
      }
      // 2층 턴 타임아웃(§6) — 폴백 단락. 턴 전체가 wall-clock 초과로 죽은 것이라
      // 다음 spec 으로 폴백해봐야 같은 turn signal 이 이미 abort 라 즉시 또 죽는다(무의미).
      // TurnTimeoutError 는 isModelRejected 비매칭(TT-I3)이라 runRegionA 의 override
      // 자동폴백도 안 타고 핸들러로 직행 → "⏱️ 중단" 정직 보고. 여기서 명시 단락해 깔끔히.
      if (e instanceof TurnTimeoutError) throw e;
      // rate-limit/사용량한도면 쿨다운 등록(문자열 미매칭 → no-op, 폴백 로직 그대로).
      registerCooldownIfRateLimited(spec, e);
      lastError = e;
      if (effectivePool.length > 1) {
        console.warn(
          `llm-runtime: '${spec.adapter}:${spec.model}' failed — ${errorDetail(e)}. 다음 모델로 폴백.`,
        );
      }
    }
  }
  // 풀 크기 무관 진짜 원인 보존 — warn 은 pool.length>1 에서만 찍혀 단일 어댑터
  // 풀이면 cause 가 안 남음. 이 1줄로 풀 크기 무관하게 진짜 원인을 콘솔에 박는다.
  if (lastError !== undefined) {
    console.error(`llm-runtime: 모든 어댑터 실패 — ${errorDetail(lastError)}`);
  }
  throw lastError ?? new Error("llm-runtime: 모델 풀이 비어있음.");
};

export const runRegionA = async (
  input: RegionASdkInput,
  opts?: { specs?: ModelSpec[]; chain?: ModelSpec[][] },
): Promise<RegionASdkOutput> => {
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
