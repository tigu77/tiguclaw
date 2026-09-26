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
process.env.MODEL_TIER_NANO = "ollama:qwen2.5:7b";
delete process.env.MODEL_TIER_LOW;
// 가드는 fetch 로만 통신하는 경로를 «가짜 네트워크» 일 때만 통과시킨다 — 실제 호출은 0이다.
globalThis.fetch = fakeNetwork(async () => new Response("{}"));

const { cheapInternalTierSpecs } = await import("../../core/llm-runtime/classify.js");
const models = () => (cheapInternalTierSpecs() ?? []).map((s) => `${s.provider}:${s.model}`);
const out: Record<string, unknown> = {};
setProfiles({ low: { pool: ["anthropic:claude-haiku-4-5"] }, high: { pool: ["anthropic:claude-opus-5-5"] } });
out.profilesNoNano = models();
setProfiles(undefined);
out.noProfiles = models();
setProfiles({ low: { pool: ["anthropic:claude-haiku-4-5"] }, nano: { pool: ["anthropic:claude-sonnet-5"] } });
out.nanoProfile = models();
console.log("CHEAP_TIER " + JSON.stringify(out));
process.exit(0);
