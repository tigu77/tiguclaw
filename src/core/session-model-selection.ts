/** 대시보드·/model·router가 공유하는 세션 모델 선택. 모델 호출이나 실행 중 턴 변경은 하지 않는다. */
import { getSessionModelOverride, getSessionModelProfile, selectSessionModelProfile } from "../store/sessions.js";
import { effectiveDefaultProfileName, isSelectableProfile, resolveModelProfiles } from "./llm-runtime/builtin-profiles.js";
import { parseModelSpecList, resolveSessionProfilePool } from "./llm-runtime/index.js";

export const listSessionModelProfiles = () => {
  const { profiles: map, builtin } = resolveModelProfiles();
  const defaultName = effectiveDefaultProfileName();
  const names = Object.keys(map);
  const ordered = names.includes(defaultName)
    ? [defaultName, ...names.filter((n) => n !== defaultName)] : names;
  const profiles = ordered.map((name) => {
    const p = map[name]!;
    return {
      name, isDefault: name === defaultName,
      ...(p.description !== undefined ? { description: p.description } : {}),
      pool: p.pool,
      ...(p.fallback !== undefined ? { fallback: p.fallback } : {}),
      ...(p.color !== undefined ? { color: p.color } : {}),
    };
  });
  return { profiles, builtin };
};

/** 기존 대시보드의 상속 aliases 보존. /model reset(raw만 해제)과는 다른 동작이다. */
export const normalizeSessionModelProfile = (name: string): string | null =>
  name === "" || name === "default" || name === effectiveDefaultProfileName() ? null : name;

export class UnknownSessionModelProfile extends Error {}

export const applySessionModelProfile = (channel: string, sessionId: string, name: string): string | null => {
  const profile = normalizeSessionModelProfile(name);
  if (profile !== null && (!Object.hasOwn(resolveModelProfiles().profiles, profile) || !isSelectableProfile(profile))) {
    throw new UnknownSessionModelProfile(`존재하지 않는 프로파일: ${name}`);
  }
  selectSessionModelProfile(channel, sessionId, profile);
  return profile;
};

/** 메인 턴은 자기 풀만 적용한다(프로파일 간 fallback 체인을 추가하지 않는다). */
export const resolveSessionModelSelection = (channel: string, sessionId: string) => {
  const raw = getSessionModelOverride(channel, sessionId);
  const profileName = getSessionModelProfile(channel, sessionId);
  const rawPool = raw === null ? [] : parseModelSpecList(raw);
  if (rawPool.length > 0) return { raw, profileName, pool: rawPool, appliedProfile: null, source: "raw" as const };
  const profilePool = profileName === null ? [] : resolveSessionProfilePool(profileName, process.cwd());
  if (profilePool.length > 0) return { raw, profileName, pool: profilePool, appliedProfile: profileName, source: "profile" as const };
  return { raw, profileName, pool: [], appliedProfile: null, source: "default" as const };
};
