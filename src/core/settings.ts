/**
 * 공용 settings.json 로더 (2026-07-14, ADR docs/decisions/2026-07-14-model-profiles-settings-json.md).
 *
 * 진실 소스: Claude Code `settings.json` 표준. `<home>/settings.json`(홈) + 프로젝트
 *  `.tiguclaw/settings.json`(+레거시 flat) 을 병합해 읽는다. 이 파일은 hook-runner 의
 *  사설 로더(loadSettingsHooks) 를 일반화한 것 — 소비자 2개(hooks + models.profiles).
 *
 * 설계 원칙(ADR D4·D5·(d)):
 *  - never-throw: 부재·파싱실패는 조용히 스킵(부팅/턴 생존 우선, 원칙 3). 기존
 *    loadSettingsHooks 의 per-file try/catch 격리를 정확히 계승.
 *  - 병합 순서: 홈 → 프로젝트(.tiguclaw) → 프로젝트(레거시 flat). 소비자별 병합 의미는
 *    다르다(hooks=concat/추가, profiles=이름별 override/뒤가 이김) → 그래서 여기서는
 *    "레이어 배열"만 순서대로 돌려주고, 각 소비자가 자기 의미로 접는다.
 *  - resolve-time 신선 읽기: 캐시 없음(hooks 동형). settings.json 편집이 재시작 없이
 *    라이브 반영된다. 읽기 IO 는 동기(readFileSync) — 모델 해석 경로(resolveTier/
 *    resolveModelSpecs)가 동기라 async 전파를 피해 시그니처 보존. 파일은 <1KB, 턴당 1회.
 *
 * 시크릿은 여기 없다(D5): API 키·토큰은 `.env`(provider-registry). 프로파일 pool 은
 *  `provider:model` 문자열만 참조.
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getPaths, projectScope, projectScopeLegacy } from "./paths.js";

/** 명명된 모델 프로파일 — settings.json `models.profiles.<name>` 의 검증된 형태. */
export interface ModelProfile {
  /** 사람용 설명 (optional). */
  description?: string;
  /** `provider:model` 배열 — 풀 안 순차 폴백(runPool). 파싱은 소비자 몫(parseModelSpecList). */
  pool: string[];
  /** 단일 프로파일 참조 — 프로파일 간(inter) 폴백 체인. 리스트 아님(순환·댕글링 차단). */
  fallback?: string;
}

/**
 * 사용자 정의 LLM provider — settings.json `models.providers.<name>` 의 검증된 형태
 * (2026-07-18, config-driven provider 개방). 하드코딩 5종(provider-registry) 과 동형이되
 * **새 이름만 추가**한다(precedence: 하드코딩 authoritative). 시크릿은 여기 없다 — apiKeyEnv
 * 로 env 를 참조하고 raw 키는 파일에 두지 않는다(loadModelProfiles 의 D5 원칙 계승).
 *
 * ★adapter 는 여기서 문자열로만 검증(비어있지 않음). "알려진 adapter 인가"(openai/claude/
 * codex-oauth) 판정은 LLM 층(provider-registry·llm-runtime)에서 — settings.ts 는 llm-runtime
 * 무참조(순환 0)라 RegionAAdapter 를 알지 못한다. 미지 adapter 거부는 소비 지점의 몫.
 */
export interface ModelProviderConfig {
  /** 이 provider 가 타는 어댑터 이름(문자열). known 검증은 LLM 층. */
  adapter: string;
  /** OpenAI-compatible baseURL(optional). undefined = 어댑터 정품 경로. */
  baseURL?: string;
  /** apiKey 를 읽을 env 변수명. 파일에 raw 키 금지 — env 참조만. */
  apiKeyEnv: string;
}

/** settings.json 최상위 형태 — 임의 키 허용(hooks·models·기타). */
export interface LoadedSettings {
  hooks?: Record<string, unknown>;
  /**
   * `models.default` = 기본 프로파일 포인터(어떤 프로파일이든 기본 지정), `models.profiles` =
   * 명명된 풀, `models.providers` = 사용자 정의 LLM provider(config-driven, 2026-07-18).
   */
  models?: {
    default?: unknown;
    profiles?: Record<string, unknown>;
    providers?: Record<string, unknown>;
  };
  /**
   * `modules.disabled` = 사용자가 끈 `kind:plugin` 모듈 이름 목록(ADR
   * 2026-07-17-module-capability-model §5.6 MVP). loadPlugins 가 이 목록을 스킵.
   * 코어(라우터·스토어)는 이 목록과 무관 — 애초에 kind:plugin 이 아니다.
   */
  modules?: { disabled?: unknown };
  [key: string]: unknown;
}

/** 한 파일 읽기·파싱 — 부재/파싱실패/비객체 = undefined (never throw). */
const readOne = (p: string): LoadedSettings | undefined => {
  try {
    const raw = readFileSync(p, "utf8");
    const json = JSON.parse(raw) as unknown;
    if (json !== null && typeof json === "object" && !Array.isArray(json)) {
      return json as LoadedSettings;
    }
    return undefined;
  } catch {
    // 부재·파싱 실패 격리 (기존 loadSettingsHooks 동작 계승).
    return undefined;
  }
};

/**
 * settings.json 레이어를 우선순위 순서로 반환: 홈 → 프로젝트(.tiguclaw) → 프로젝트(레거시 flat).
 * 존재·파싱 성공한 것만. 병합은 호출자가 자기 의미로 수행(hooks=concat / profiles=override).
 * cwd 옵셔널(기본 process.cwd()) — 프로젝트 스코프 정합.
 */
export const loadSettingsLayers = (
  cwd: string = process.cwd(),
): LoadedSettings[] => {
  const paths = [
    getPaths().settings,
    projectScope(cwd).settings,
    projectScopeLegacy(cwd).settings,
  ];
  const layers: LoadedSettings[] = [];
  for (const p of paths) {
    const s = readOne(p);
    if (s !== undefined) layers.push(s);
  }
  return layers;
};

/** 한 프로파일 값 shape 검증 — pool 이 문자열 배열이 아니면 무효(undefined). */
const validateProfile = (
  name: string,
  val: unknown,
  diagnose: boolean,
): ModelProfile | undefined => {
  if (val === null || typeof val !== "object" || Array.isArray(val)) {
    if (diagnose) {
      console.warn(`[settings] models.profiles.${name}: 객체가 아님 — 무시.`);
    }
    return undefined;
  }
  const o = val as Record<string, unknown>;
  const pool = o.pool;
  if (!Array.isArray(pool) || !pool.every((x) => typeof x === "string")) {
    if (diagnose) {
      console.warn(
        `[settings] models.profiles.${name}: pool 이 문자열 배열이 아님 — 무시.`,
      );
    }
    return undefined;
  }
  const profile: ModelProfile = { pool: pool as string[] };
  if (typeof o.description === "string") profile.description = o.description;
  if (typeof o.fallback === "string" && o.fallback.trim() !== "") {
    profile.fallback = o.fallback.trim();
  }
  return profile;
};

/**
 * 검증된 모델 프로파일 맵 — 홈→프로젝트 병합(이름 충돌 시 프로젝트가 이김).
 * 무효 프로파일은 drop. diagnose=true(부팅 진단)일 때만 콘솔 경고(resolve-time 은 무음
 * — 턴당 스팸 방지). resolve-time 순환/댕글링은 resolveProfileChain 의 cycle-guard 가 처리.
 */
export const loadModelProfiles = (
  cwd: string = process.cwd(),
  diagnose = false,
): Record<string, ModelProfile> => {
  const merged: Record<string, ModelProfile> = {};
  // 홈이 먼저, 프로젝트가 나중 → 같은 이름은 프로젝트가 override(뒤가 이김).
  for (const layer of loadSettingsLayers(cwd)) {
    const profiles = layer.models?.profiles;
    if (profiles === null || typeof profiles !== "object") continue;
    for (const [name, val] of Object.entries(
      profiles as Record<string, unknown>,
    )) {
      const validated = validateProfile(name, val, diagnose);
      if (validated !== undefined) merged[name] = validated;
    }
  }
  return merged;
};

/**
 * 한 provider 값 shape 검증(2026-07-18) — adapter·apiKeyEnv 가 비어있지 않은 문자열이어야
 * 유효. baseURL 은 optional 문자열. adapter 의 "known 여부"(openai/claude/codex-oauth)는 여기서
 * 판정하지 않는다(settings.ts 는 llm-runtime 무참조) — 소비 지점(provider-registry·parseModelSpec)
 * 이 미지 adapter 를 거부한다.
 */
const validateProviderConfig = (
  name: string,
  val: unknown,
  diagnose: boolean,
): ModelProviderConfig | undefined => {
  if (val === null || typeof val !== "object" || Array.isArray(val)) {
    if (diagnose) {
      console.warn(`[settings] models.providers.${name}: 객체가 아님 — 무시.`);
    }
    return undefined;
  }
  const o = val as Record<string, unknown>;
  if (typeof o.adapter !== "string" || o.adapter.trim() === "") {
    if (diagnose) {
      console.warn(
        `[settings] models.providers.${name}: adapter 가 비어있지 않은 문자열이 아님 — 무시.`,
      );
    }
    return undefined;
  }
  if (typeof o.apiKeyEnv !== "string" || o.apiKeyEnv.trim() === "") {
    if (diagnose) {
      console.warn(
        `[settings] models.providers.${name}: apiKeyEnv 가 비어있지 않은 문자열이 아님 — 무시.`,
      );
    }
    return undefined;
  }
  const config: ModelProviderConfig = {
    adapter: o.adapter.trim(),
    apiKeyEnv: o.apiKeyEnv.trim(),
  };
  if (typeof o.baseURL === "string" && o.baseURL.trim() !== "") {
    config.baseURL = o.baseURL.trim();
  }
  return config;
};

/**
 * 검증된 사용자 provider 맵(2026-07-18) — 홈→프로젝트 병합(이름 충돌 시 프로젝트가 이김,
 * loadModelProfiles 동형). 무효 config 는 drop. diagnose=true(부팅 진단)일 때만 콘솔 경고.
 *
 * ★precedence 는 여기서 강제하지 않는다 — 이 맵은 "settings.json 에 쓰인 것"의 순수 뷰다.
 * 하드코딩 5종이 authoritative(사용자가 override 못 함)라는 규칙은 소비 지점(provider-registry
 * resolveProviderConn / listProviderNames)이 하드코딩 우선 lookup 으로 강제한다.
 */
export const loadModelProviders = (
  cwd: string = process.cwd(),
  diagnose = false,
): Record<string, ModelProviderConfig> => {
  const merged: Record<string, ModelProviderConfig> = {};
  for (const layer of loadSettingsLayers(cwd)) {
    const providers = layer.models?.providers;
    if (providers === null || typeof providers !== "object") continue;
    for (const [name, val] of Object.entries(
      providers as Record<string, unknown>,
    )) {
      const validated = validateProviderConfig(name, val, diagnose);
      if (validated !== undefined) merged[name] = validated;
    }
  }
  return merged;
};

/**
 * config-driven 오디오 전사 설정(2026-07-18, ADR 후보
 * docs/decisions/2026-07-18-transcription-config-driven.md) — settings.json `transcription:{}`.
 * `models.providers` 로더 패턴 동형(never-throw·layer 병합·diagnose 경고). 시크릿은 여기 없다 —
 * openai apiKey 는 `models.providers.<name>.apiKeyEnv`(env 참조) 경유. settings.ts 는 llm-runtime
 * 무참조라 provider/model 문자열만 담고, "known 여부"·해석은 소비 지점(transcription/ 팩토리) 몫.
 */
export interface TranscriptionConfig {
  /** 생략=true. false = 전사 끔(현행 path-reference 렌더). */
  enabled: boolean;
  /** 선택된 impl — "openai" | "local"(미래 user-defined). 생략 시 "openai". */
  provider: string;
  /** 언어 힌트(양 provider 공유, 예 "ko"). 미지정 = provider 자동감지. */
  language?: string;
  /** openai impl 설정(HTTP `/audio/transcriptions`). */
  openai?: {
    /** models.providers 중 baseURL/apiKey 공급원 이름. 생략 = "openai". */
    provider?: string;
    /** 전사 model 문자열. 생략 시 소비 지점 기본("gpt-4o-transcribe"). */
    model?: string;
  };
  /** local impl 설정(CLI spawn). */
  local?: {
    /** 바이너리 경로/이름(예 "whisper-cli"). */
    command?: string;
    /** 인자 배열 — 플레이스홀더 {file}/{language} 치환. */
    args?: string[];
    /** spawn 타임아웃(ms). 생략 시 소비 지점 기본. */
    timeoutMs?: number;
    /** 출력 회수 방식 지정 파일 — 지정 시 stdout 대신 이 파일({file} 치환 가능)을 읽음. */
    outputFile?: string;
  };
}

/**
 * 한 transcription 값 shape 검증 — never-throw, 무효/부재 필드는 안전 기본으로 채운다.
 * validateProviderConfig 동형(diagnose=true 부팅 진단에서만 경고). 최상위가 객체 아니면 undefined
 * → 로더가 해당 레이어 스킵. enabled 생략=true, provider 생략="openai".
 */
const validateTranscriptionConfig = (
  val: unknown,
  diagnose: boolean,
): TranscriptionConfig | undefined => {
  if (val === null || typeof val !== "object" || Array.isArray(val)) {
    if (diagnose) {
      console.warn(`[settings] transcription: 객체가 아님 — 무시.`);
    }
    return undefined;
  }
  const o = val as Record<string, unknown>;
  const config: TranscriptionConfig = {
    enabled: o.enabled === undefined ? true : o.enabled === true,
    provider:
      typeof o.provider === "string" && o.provider.trim() !== ""
        ? o.provider.trim()
        : "openai",
  };
  if (typeof o.language === "string" && o.language.trim() !== "") {
    config.language = o.language.trim();
  }
  if (o.openai !== null && typeof o.openai === "object" && !Array.isArray(o.openai)) {
    const oa = o.openai as Record<string, unknown>;
    const openai: NonNullable<TranscriptionConfig["openai"]> = {};
    if (typeof oa.provider === "string" && oa.provider.trim() !== "") {
      openai.provider = oa.provider.trim();
    }
    if (typeof oa.model === "string" && oa.model.trim() !== "") {
      openai.model = oa.model.trim();
    }
    config.openai = openai;
  }
  if (o.local !== null && typeof o.local === "object" && !Array.isArray(o.local)) {
    const lo = o.local as Record<string, unknown>;
    const local: NonNullable<TranscriptionConfig["local"]> = {};
    if (typeof lo.command === "string" && lo.command.trim() !== "") {
      local.command = lo.command.trim();
    }
    if (Array.isArray(lo.args) && lo.args.every((x) => typeof x === "string")) {
      local.args = lo.args as string[];
    }
    if (typeof lo.timeoutMs === "number" && Number.isFinite(lo.timeoutMs) && lo.timeoutMs > 0) {
      local.timeoutMs = lo.timeoutMs;
    }
    if (typeof lo.outputFile === "string" && lo.outputFile.trim() !== "") {
      local.outputFile = lo.outputFile.trim();
    }
    config.local = local;
  }
  return config;
};

/**
 * 병합된 전사 설정(2026-07-18) — 홈→프로젝트(.tiguclaw) layer 병합(뒤가 이김, loadModelProfiles
 * 동형). 어느 레이어에도 `transcription` 키가 없으면 `undefined` 반환(호출자가 "기본 openai" 판정).
 * never-throw. diagnose=true(부팅 진단)일 때만 무효 shape 경고.
 *
 * ★반환 undefined 의 의미 = "명시 설정 없음"이지 "전사 끔"이 아니다 — 소비 지점(팩토리)이
 * undefined 를 "기본 openai enabled" 로 해석(contract §3, apiKey 부재면 graceful fallback).
 */
export const loadTranscriptionConfig = (
  cwd: string = process.cwd(),
  diagnose = false,
): TranscriptionConfig | undefined => {
  let merged: TranscriptionConfig | undefined;
  for (const layer of loadSettingsLayers(cwd)) {
    if (!("transcription" in layer)) continue;
    const validated = validateTranscriptionConfig(layer.transcription, diagnose);
    if (validated !== undefined) merged = validated; // 뒤 레이어(프로젝트)가 이김.
  }
  return merged;
};

/**
 * 프로파일 이름 → 순서 있는 풀 체인(raw `provider:model` 배열들).
 *  - 각 원소 = 한 프로파일의 pool(파싱 전 raw). 파싱/ModelSpec 변환은 llm-runtime 몫.
 *  - `.fallback` 을 따라 조립하되 visited-set 로 순환 절단, 댕글링 참조는 그 엣지 drop(체인 종료).
 *  - 빈 풀도 그대로 push(다운스트림이 [] 로 걸러 다음 풀로 흐름 — ADR (d)).
 *  - name 이 프로파일이 아니면 [](직접 spec·어댑터 디폴트는 호출자가 폴백 처리).
 */
export const resolveProfileChain = (
  name: string,
  cwd: string = process.cwd(),
): string[][] => {
  const profiles = loadModelProfiles(cwd);
  if (profiles[name] === undefined) return [];
  const chain: string[][] = [];
  const visited = new Set<string>();
  // 한 프로파일에서 .fallback 링크를 따라가며 풀을 누적(순환·댕글링 절단). visited 공유.
  const follow = (start: string | undefined): void => {
    let cur = start;
    while (cur !== undefined && !visited.has(cur)) {
      const prof: ModelProfile | undefined = profiles[cur];
      if (prof === undefined) break; // 댕글링 fallback → 엣지 drop(체인 종료).
      visited.add(cur);
      chain.push(prof.pool);
      cur = prof.fallback; // 다음 프로파일(있으면). 순환은 while 조건이 절단.
    }
  };
  follow(name);
  // ★최종 폴백 = 지정된 default 프로파일(사용자 요청 2026-07-18). 명시 .fallback 체인이
  //  default 를 안 거쳤으면 default 프로파일 풀(+그 자신의 .fallback 체인)을 말미에 덧붙인다.
  //  요청 프로파일이 default 이거나 이미 경유했으면 visited 로 no-op. 이건 인터-프로파일
  //  (구조적) 폴백 층 — 풀 내(runPool) 임의실패 폴백과 분리 유지(feedback_no_cross_adapter_fallback).
  follow(getDefaultProfileName(cwd));
  return chain;
};

/**
 * 기본 프로파일 이름 — settings.json `models.default`(포인터).
 *  - 어떤 프로파일도 기본이 될 수 있게 하는 간접 지시자. resolveModelSpecs 의 메인 턴 풀 해석이
 *    하드코딩 `"default"` 대신 이 값을 쓴다.
 *  - 병합 의미: 홈→프로젝트 순서로 훑어 마지막 비어있지 않은 문자열이 이김(프로파일 override 와 동형).
 *  - ★미지정/댕글링 폴백 = **첫 프로파일**(사용자 요청 2026-07-18). 포인터가 없거나 오타·
 *    삭제된 이름을 가리키면, 하드코딩 `"default"` 가 아니라 settings.json 에 쓰인 순서상
 *    첫 프로파일을 기본으로 쓴다(사용자가 커스텀 이름만 뒀을 때 어댑터 디폴트로 무너지지
 *    않게). 프로파일이 0개면 `"default"`(어댑터 디폴트로 흐르는 무해한 이름).
 */
export const getDefaultProfileName = (
  cwd: string = process.cwd(),
): string => {
  let explicit: string | undefined;
  for (const layer of loadSettingsLayers(cwd)) {
    const d = layer.models?.default;
    if (typeof d === "string" && d.trim() !== "") explicit = d.trim();
  }
  const profiles = loadModelProfiles(cwd);
  // 명시 포인터가 실존 프로파일이면 그것.
  if (explicit !== undefined && profiles[explicit] !== undefined) return explicit;
  // 미지정/댕글링 → 첫 프로파일(순서상 처음). 없으면 "default"(어댑터 디폴트 폴백).
  const first = Object.keys(profiles)[0];
  return first ?? "default";
};

/**
 * 기본 프로파일 포인터 쓰기 — **홈 settings.json**(`getPaths().settings`) read-modify-write.
 *  - ★나머지 키 전부 보존: 파일 전체를 parse → `models.default` 만 세팅 → 2-space stringify.
 *    hooks·models.profiles·기타 최상위 키를 절대 건드리지 않는다(데이터 안전 핵심).
 *  - 파일 부재/파싱 실패 시 최소 `{}` 에서 시작(신규 생성). 원자적 쓰기(temp→rename)로 부분쓰기 차단.
 *  - name 유효성(실존 프로파일 여부)은 호출자(엔드포인트)가 검증 — 여기선 순수 저장.
 */
export const setDefaultProfile = (name: string): void => {
  const file = getPaths().settings;
  let root: Record<string, unknown> = {};
  try {
    const raw = readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      root = parsed as Record<string, unknown>;
    }
  } catch {
    // 부재/파싱 실패 → 최소 {} 신설(다른 키 없음).
  }
  const existingModels = root.models;
  const models: Record<string, unknown> =
    existingModels !== null &&
    typeof existingModels === "object" &&
    !Array.isArray(existingModels)
      ? (existingModels as Record<string, unknown>)
      : {};
  models.default = name;
  root.models = models;
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(root, null, 2) + "\n", "utf8");
  renameSync(tmp, file);
};

/**
 * 모듈(kind:plugin) 비활성 목록 — `modules.disabled` 문자열 배열을 레이어(홈→프로젝트)
 * 전체에서 합집합(union)으로 읽는다. hooks(concat) 와 같은 "추가적" 병합 의미 — 어느
 * 레이어든 그 이름을 disabled 로 올리면 전체에서 비활성(로컬이 홈 설정을 몰래 되살리지
 * 못하게 — 안전 쪽으로 편향). MVP 는 홈 settings.json 만 쓰지만(setModuleDisabled),
 * 읽기는 loadSettingsLayers 동형으로 프로젝트 레이어도 존중.
 */
const readDisabledModules = (cwd: string = process.cwd()): Set<string> => {
  const disabled = new Set<string>();
  for (const layer of loadSettingsLayers(cwd)) {
    const list = layer.modules?.disabled;
    if (!Array.isArray(list)) continue;
    for (const name of list) {
      if (typeof name === "string" && name.trim() !== "") disabled.add(name.trim());
    }
  }
  return disabled;
};

/** 모듈(plugin) 이름 → 사용자가 껐는지(disabled). "off" 만 참 — 목록 부재/미기재는 false(inactive 아님, 이 함수 관할 밖). */
export const isModuleDisabled = (
  name: string,
  cwd: string = process.cwd(),
): boolean => readDisabledModules(cwd).has(name);

/** 현재 disabled 목록 스냅샷(진단/엔드포인트 노출용) — 정렬된 배열. */
export const listDisabledModules = (cwd: string = process.cwd()): string[] =>
  [...readDisabledModules(cwd)].sort();

/**
 * 모듈 활성/비활성 쓰기 — **홈 settings.json** read-modify-write(setDefaultProfile 동형).
 *  - ★나머지 키 전부 보존(hooks·models·기타 최상위 키 무수정). 원자적 쓰기(temp→rename).
 *  - disabled=true → 목록에 추가(dedup). disabled=false → 목록에서 제거. 목록이 빈
 *    배열이 되면 `modules.disabled: []` 로 남긴다(부재와 동일 의미지만 파일에 흔적을
 *    남겨 다음 read 가 명시적 — 삭제 대신 빈 배열, 데이터 보존 철학).
 *  - name 유효성(실존 플러그인 여부)은 호출자(엔드포인트)가 검증 — 여기선 순수 저장.
 *  - MVP(ADR §5.6): 재시작해야 loadPlugins 스킵이 적용된다(핫토글 아님) — 호출자가
 *    안내(`requiresRestart:true`).
 */
export const setModuleDisabled = (name: string, disabled: boolean): void => {
  const file = getPaths().settings;
  let root: Record<string, unknown> = {};
  try {
    const raw = readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      root = parsed as Record<string, unknown>;
    }
  } catch {
    // 부재/파싱 실패 → 최소 {} 신설(다른 키 없음).
  }
  const existingModules = root.modules;
  const modules: Record<string, unknown> =
    existingModules !== null &&
    typeof existingModules === "object" &&
    !Array.isArray(existingModules)
      ? (existingModules as Record<string, unknown>)
      : {};
  const existingList = modules.disabled;
  const current = new Set<string>(
    Array.isArray(existingList)
      ? existingList.filter((x): x is string => typeof x === "string")
      : [],
  );
  if (disabled) current.add(name);
  else current.delete(name);
  modules.disabled = [...current].sort();
  root.modules = modules;
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(root, null, 2) + "\n", "utf8");
  renameSync(tmp, file);
};

/**
 * 부팅 진단 — 프로파일의 댕글링 fallback·순환·빈 풀을 사람이 읽을 경고 문자열로 수집.
 * 데몬을 죽이지 않는다(never-throw at boot, ADR (d)) — 호출자가 로그로 표면화만.
 * resolve-time cycle-guard(resolveProfileChain)가 실집행이라 여기서는 가시화가 목적.
 */
export const diagnoseModelProfiles = (
  cwd: string = process.cwd(),
): string[] => {
  const issues: string[] = [];
  // diagnose=true → 무효 shape 프로파일은 loadModelProfiles 가 콘솔로 직접 경고(+drop).
  const profiles = loadModelProfiles(cwd, true);
  for (const [name, prof] of Object.entries(profiles)) {
    if (prof.pool.length === 0) {
      issues.push(`프로파일 '${name}' 의 pool 이 비어 있습니다(어댑터 디폴트/폴백으로 강등).`);
    }
    if (prof.fallback !== undefined && profiles[prof.fallback] === undefined) {
      issues.push(
        `프로파일 '${name}' 의 fallback '${prof.fallback}' 이 존재하지 않습니다(댕글링 — 폴백 없음처럼 처리).`,
      );
    }
  }
  // 순환 탐지 — 각 프로파일에서 fallback 을 따라가다 재방문하면 순환.
  for (const start of Object.keys(profiles)) {
    const seen = new Set<string>();
    let cur: string | undefined = start;
    while (cur !== undefined) {
      const prof: ModelProfile | undefined = profiles[cur];
      if (prof === undefined) break; // 댕글링 — 별도 위 진단.
      if (seen.has(cur)) {
        issues.push(
          `프로파일 '${start}' 의 fallback 체인에 순환이 있습니다('${cur}' 에서 절단).`,
        );
        break;
      }
      seen.add(cur);
      cur = prof.fallback;
    }
  }
  return issues;
};
