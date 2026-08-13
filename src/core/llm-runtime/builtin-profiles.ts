/**
 * **빌트인 모델 프로파일 — 설정이 없으면 인증된 provider 로 알아서 조립한다** (2026-08-13).
 *
 * 사용자 질문: "만약에 없으면 알아서 등록된 어댑터의 모델들로 기본 셋팅 해줄 수 있나?"
 *
 * 종전엔 `settings.json` 에 프로파일이 없으면 이렇게 흘렀다:
 *   프로파일 0개 → `REGION_A_MODELS` env → 없으면 `DEFAULT_MODEL_SPEC`(claude, 모델 미지정).
 * 즉 **codex 만 인증한 사용자도 claude 로 흘렀고**, `high`/`mid`/`low` 는 아무 의미가 없었다
 * (`npm run init` 을 안 거친 설치·프로파일을 지운 경우가 전부 여기).
 *
 * 이제 그 자리에서 **지금 인증된 provider 들**로 세 등급을 만든다. 인증 판정은
 * `providerAuthAvailable`(단일 정본)에 위임한다 — 여기서 env 를 다시 읽지 않는다.
 *
 * ★디스크에 쓰지 않는다(의도). 파일로 굳히면 그 순간 늙는다 — 나중에 codex 를 인증해도
 *  파일은 안 따라오고, 사용자는 자기가 안 쓴 파일을 고쳐야 한다. 매번 계산하면
 *  자격증명이 바뀌는 즉시 따라오고, 사용자가 `settings.json` 에 하나라도 쓰면
 *  **그게 통째로 이긴다**(아래 소비처는 전부 "프로파일 0개일 때만" 여기로 온다).
 *
 * ★교차 provider 가 공짜로 따라온다: 둘 이상 인증돼 있으면 한 풀에 나란히 들어가
 * `poolDiversityWarning` 이 권하던 안전망이 기본으로 성립한다. 순서 = 아래 ORDER.
 */
import { providerAuthAvailable } from "./provider-availability.js";
import { catalogTierModel } from "./model-catalog.js";
import { PROVIDER_REGISTRY } from "./provider-registry.js";

/** 빌트인이 아는 세 등급. 사용자 프로파일 이름은 자유지만 빌트인은 이 셋뿐이다. */
export const BUILTIN_TIERS = ["high", "mid", "low"] as const;
export type BuiltinTier = (typeof BUILTIN_TIERS)[number];

/** 프로파일이 없을 때의 기본 등급 — 메인 턴이 이걸 쓴다(사용자 결정 2026-08-13). */
export const BUILTIN_DEFAULT_TIER: BuiltinTier = "high";

/**
 * provider id → 등급별 모델. **`PROVIDER_REGISTRY` 의 키여야 한다**(회귀가 검사).
 *
 * ★없는 provider(ollama·google)는 **일부러 비운다** — 로컬/게이트웨이 모델 이름은 우리가
 *  알 수 없고, 모르는 걸 지어내면 "형식은 맞는데 실재하지 않는 ID" 가 되어 매 턴 실패한다.
 *  그런 provider 는 사용자가 `settings.json` 에 직접 적는 게 맞다.
 *
 * ★2026-08-13부터 이 표는 **바닥**이다 — `model-catalog.ts` 가 백엔드에 물어본 값이 있으면
 *  그게 먼저다. 표는 조회가 안 될 때(네트워크·미인증·구버전) 쓰인다.
 *
 * ★이 표는 늙는다. 늙어도 사용자 설정이 이기고, `/models` 가 어디서 온 값인지 표시하며,
 *  온보딩(`npm run init`)이 같은 표를 보여주고 그 자리에서 고치게 한다 — 늙은 값이
 *  조용히 박히는 경로가 없게.
 *
 * ★확인 수준을 구분해 적는다: anthropic 3종은 공식 카탈로그로 **확인**했다(2026-08-13).
 *  `codex`/`openai` 의 `gpt-5.5` 는 2026-07-08부터 init 이 시드해 온 값을 **그대로 물려받은
 *  것**이고 내가 벤더 카탈로그로 확인한 값은 아니다 — codex 는 실사용 로그(`gpt-5.5` 102턴)가
 *  뒷받침하지만 정품 openai API 쪽은 미확인이다. 틀렸다면 그 provider 만 첫 턴에 모델 오류를
 *  내고 풀의 다음으로 넘어간다(조용한 오답이 아니라 시끄러운 실패 — 그래서 방치 가능).
 */
const PROVIDER_TIER_MODELS: Record<string, Record<BuiltinTier, string>> = {
  anthropic: {
    high: "claude-opus-5",
    mid: "claude-sonnet-5",
    low: "claude-haiku-4-5",
  },
  codex: { high: "gpt-5.5", mid: "gpt-5.5", low: "gpt-5.5" },
  openai: { high: "gpt-5.5", mid: "gpt-5.5", low: "gpt-5.5" },
};

/**
 * 풀 안에서의 우선순위. anthropic 이 앞인 이유는 취향이 아니라 원칙 1(Claude Code 슈퍼셋)
 * — 능력 기준선이 거기 있다. 뒤의 것들은 앞이 흔들릴 때의 그물이다. 하나만 인증했다면
 * 순서는 아무 의미가 없다.
 */
const ORDER = ["anthropic", "codex", "openai"] as const;

/**
 * provider·등급 → 모델 이름(접두사 없음). **인증 여부를 보지 않는다** — 온보딩(`npm run init`)
 * 은 "지금 막 고른 provider" 를 물어야 하므로 아직 키가 없는 상태에서도 이름이 필요하다.
 * 런타임 조립(`builtinTierPool`)만 인증을 본다.
 */
export const builtinTierModel = (
  provider: string,
  tier: BuiltinTier,
): string | undefined => PROVIDER_TIER_MODELS[provider]?.[tier];

/** 표의 키가 실제 provider 인지 — 회귀에서 검사(오타·삭제된 provider 방치 방지). */
export const builtinTierProviders = (): string[] => Object.keys(PROVIDER_TIER_MODELS);
export const isRegisteredProvider = (name: string): boolean =>
  Object.prototype.hasOwnProperty.call(PROVIDER_REGISTRY, name);

/**
 * 한 등급의 raw 풀(`provider:model` 문자열들) — 인증된 provider 만, ORDER 순.
 * 인증된 게 없으면 `[]`(호출자가 기존 폴백으로 강등 — 회귀 0).
 */
export const builtinTierPool = (tier: string, cwd?: string): string[] => {
  const t = tier.toLowerCase();
  if (!(BUILTIN_TIERS as readonly string[]).includes(t)) return [];
  const out: string[] = [];
  for (const provider of ORDER) {
    const tiers = PROVIDER_TIER_MODELS[provider];
    if (tiers === undefined) continue;
    if (!providerAuthAvailable(provider, cwd)) continue;
    // ★백엔드에게 물어본 값이 있으면 그게 먼저다 (2026-08-13) — 아래 표는 조회가
    //  안 될 때의 바닥이다. 표가 늙어도 조회가 되는 설치는 최신을 쓴다.
    const live = catalogTierModel(provider, t as BuiltinTier);
    out.push(`${provider}:${live ?? tiers[t as BuiltinTier]}`);
  }
  return out;
};

/**
 * 세 등급 전부 — `/models` 표시·프롬프트 인벤토리용. 인증된 provider 가 없으면 `{}`
 * (보여줄 게 없으면 없다고 말한다 — 빈 풀을 있는 척하지 않는다).
 */
export const builtinModelProfiles = (
  cwd?: string,
): Record<string, { description: string; pool: string[] }> => {
  const out: Record<string, { description: string; pool: string[] }> = {};
  for (const tier of BUILTIN_TIERS) {
    const pool = builtinTierPool(tier, cwd);
    if (pool.length === 0) continue;
    out[tier] = {
      description:
        tier === BUILTIN_DEFAULT_TIER
          ? "빌트인 기본 — 메인 턴 · 인증된 provider 로 자동 조립"
          : `빌트인 — ${tier === "mid" ? "일반" : "단순·대량"} 작업`,
      pool,
    };
  }
  return out;
};

/** 등급 이름 정규화 — 빌트인이 모르는 이름이면 기본 등급으로 강등. */
export const builtinTierFor = (name: string): BuiltinTier =>
  (BUILTIN_TIERS as readonly string[]).includes(name.toLowerCase())
    ? (name.toLowerCase() as BuiltinTier)
    : BUILTIN_DEFAULT_TIER;
