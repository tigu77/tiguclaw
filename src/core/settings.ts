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
import { readFileSync } from "node:fs";
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

/** settings.json 최상위 형태 — 임의 키 허용(hooks·models·기타). */
export interface LoadedSettings {
  hooks?: Record<string, unknown>;
  models?: { profiles?: Record<string, unknown> };
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
  let cur: string | undefined = name;
  while (cur !== undefined && !visited.has(cur)) {
    const prof: ModelProfile | undefined = profiles[cur];
    if (prof === undefined) break; // 댕글링 fallback → 엣지 drop(체인 종료).
    visited.add(cur);
    chain.push(prof.pool);
    cur = prof.fallback; // 다음 프로파일(있으면). 순환은 while 조건이 절단.
  }
  return chain;
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
