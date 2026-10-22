/**
 * `cheap-tier-follows-profiles` 의 자식 — 격리 홈에서 **실제** `cheapInternalTierSpecs` 를 돌린다.
 * 자식인 이유: `getPaths()` 가 첫 호출에 홈을 동결한다(`_profile-pool-reasoning-child` 와 같은 사정).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fakeNetwork } from "./_framework.js";

const home = process.env.TIGUCLAW_HOME ?? "";
mkdirSync(home, { recursive: true });
process.chdir(home); // 레포의 프로젝트 설정층이 섞이지 않게.
const settingsFile = path.join(home, "settings.json");
const setProfiles = (profiles: Record<string, unknown> | undefined) =>
  writeFileSync(settingsFile, JSON.stringify(profiles === undefined ? {} : { models: { default: "low", profiles } }, null, 2) + "\n");
// 6월 설치본처럼 레거시 env 가 남아 있다.
process.env.MODEL_TIER_NANO = "google:qwen2.5:7b";
delete process.env.MODEL_TIER_LOW;
// 빌트인 조립에 인증된 provider 하나 — 없으면 «기본 풀» 이 비어 ② 가 공짜로 맞는다.
process.env.ANTHROPIC_API_KEY = "sk-test-cheap-tier";
// 가드는 fetch 로만 통신하는 경로를 «가짜 네트워크» 일 때만 통과시킨다 — 실제 호출은 0이다.
globalThis.fetch = fakeNetwork(async () => new Response("{}"));

const { cheapInternalTierSpecs } = await import("../../core/llm-runtime/classify.js");
const models = () => (cheapInternalTierSpecs() ?? []).map((s) => `${s.provider}:${s.model}`);
const out: Record<string, unknown> = {};
const write = (models: Record<string, unknown>) => writeFileSync(settingsFile, JSON.stringify({ models }, null, 2) + "\n");
// ★① 아스트라 P2 재현 모양 — 기본 high(opus) + 명시 low(haiku), nano 없음 → 내부 선택은 low.
write({ default: "high", profiles: { high: { pool: ["anthropic:claude-opus-5"] }, low: { pool: ["anthropic:claude-haiku-4-5"] } } });
out.explicitLow = models();
setProfiles({ low: { pool: ["anthropic:claude-haiku-4-5"] }, high: { pool: ["anthropic:claude-opus-5-5"] } });
out.profilesNoNano = models();
setProfiles(undefined);
out.noProfiles = models();
const { resolveModelSpecs } = await import("../../core/llm-runtime/index.js");
out.noProfilesDefault = resolveModelSpecs().map((s) => `${s.provider}:${s.model}`);
// ★`nano` 프로파일이 있어도 특례가 없다 — 내부 선택은 low(정태님 «나노는 아예 빼기로»).
setProfiles({ low: { pool: ["anthropic:claude-haiku-4-5"] }, nano: { pool: ["anthropic:claude-sonnet-5"] } });
out.nanoProfile = models();
// ④ `low` 도 같은 병(전체 검토 2026-09-28) — 프로파일은 있는데 등급 이름 프로파일이 없고 옛 MODEL_TIER_LOW 가 남은 설치본.
//  게이트웨이 `tier:low`·서브에이전트 `model: low` 는 `resolveTier` 를 직접 지난다 — 그 함수로 본다.
const { resolveTier } = await import("../../core/llm-runtime/index.js");
const tier = (t: string) => resolveTier(t).map((s) => `${s.provider}:${s.model}`);
process.env.MODEL_TIER_LOW = "google:qwen-legacy-low";
setProfiles({ everyday: { pool: ["anthropic:claude-haiku-4-5"] } });
out.lowShadowed = tier("low");
out.nanoShadowed = tier("nano");
out.cheapShadowed = models();
setProfiles(undefined);
out.lowLegacy = tier("low");
// ⑥ `low` 가 안 풀리면(옮기지 않은 `ollama:…`) undefined — 호출자가 일반 디폴트로 간다(종전 안전 폴백).
write({ default: "high", profiles: { high: { pool: ["anthropic:claude-opus-5"] }, low: { pool: ["ollama:qwen2.5:7b"] } } });
out.lowUnresolved = cheapInternalTierSpecs() === undefined ? "undefined" : models();
console.log("CHEAP_TIER " + JSON.stringify(out));
process.exit(0);
