/**
 * 회귀: **프로파일로 모델을 정하는 설치본에선 내부 단발 호출이 레거시 `MODEL_TIER_NANO` 를 안 쓴다** (2026-09-26).
 *
 * ★사고(정태님: *"우리 모델프로필만 사용하는데 저 정보가 아직 있나"*): 돌쇠 `.env` 에 6월의
 *  `MODEL_TIER_NANO=ollama:qwen2.5:7b` 가 남아 있었다. high·mid·low 는 같은 이름의 프로파일이
 *  가리지만 `nano` 는 프로파일이 없어, 내부 단발 호출(WebFetch 요약·실패 회고)이 «가장 싼 등급» 을
 *  찾다 그 값으로 떨어졌다 — 9월 WebFetch 요약 127회, 거의 전부 30초 시한 초과·한 건은 중국어 답.
 *
 * 지키는 것(실제 함수, 격리 홈): ① 프로파일이 있고 `nano` 가 없으면 레거시 env 를 안 보고 `low`
 *  프로파일로 ② 프로파일이 하나도 없는 옛 설치본은 종전대로 env ③ `nano` 프로파일이 있으면 그것.
 */
import { fileURLToPath } from "node:url";
import { assert, spawnWithin, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "cheap-tier-follows-profiles",
  guards:
    "프로파일만 쓰는 설치본에서 내부 단발 호출(WebFetch 요약)이 6월 .env 의 MODEL_TIER_NANO(로컬 qwen)로 떨어져 30초씩 시한 초과하던 것",
  run: async () => {
    const r = await spawnWithin(45000, "내부 단발 호출 등급 해석", [
      "--import", "tsx",
      fileURLToPath(new URL("./_cheap-tier-follows-profiles-child.ts", import.meta.url)),
    ]);
    const line = r.out.split("\n").find((x) => x.startsWith("CHEAP_TIER "));
    const got = line ? (JSON.parse(line.slice("CHEAP_TIER ".length)) as Record<string, string[]>) : {};
    // 실패 회고도 **같은 판단**을 지난다 — 사본이 남아 이쪽만 qwen 으로 가던 것(싱크 레드팀 P3).
    const { readFileSync } = await import("node:fs");
    const cf = readFileSync(new URL("../../core/llm-runtime/classify-failure.ts", import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, "");
    const cfUses = /specs: cheapInternalTierSpecs\(\)/.test(cf);
    const cfCopy = /resolveTier\("nano"\)/.test(cf);
    const has = (k: string, m: string) => Array.isArray(got[k]) && got[k]!.some((x) => x.includes(m));
    return [
      assert("자식이 결과를 냈다(없으면 아래는 공짜 초록)", line !== undefined, line ?? r.err.slice(-300)),
      assert("★① 프로파일이 있고 nano 가 없으면 레거시 qwen 이 아니라 low 프로파일", has("profilesNoNano", "haiku") && !has("profilesNoNano", "qwen"), JSON.stringify(got.profilesNoNano)),
      assert("② 프로파일이 없는 옛 설치본은 종전대로 env(nano)", has("noProfiles", "qwen"), JSON.stringify(got.noProfiles)),
      assert("★실패 회고(classify-failure)도 같은 판단 함수를 쓴다(사본 없음)", cfUses && !cfCopy, `공용 사용=${cfUses} · 사본=${cfCopy}`),
      assert("③ nano 프로파일을 만들면 그것을 쓴다(레거시 env 도 low 도 아님)", has("nanoProfile", "sonnet-5") && !has("nanoProfile", "qwen") && !has("nanoProfile", "haiku"), JSON.stringify(got.nanoProfile)),
    ];
  },
};
