/**
 * 회귀: **게이트웨이 `/v1/models` 가 광고하는 등급은 요청하면 실제로 해석된다** (2026-09-28 적대 검토 P4).
 *
 * ★사고: 목록이 `MODEL_TIER_*` env 를 **따로** 읽었다(요청 쪽 `resolveTier` 의 사본). 프로파일 설치본에선 요청 쪽이 옛 env 를
 *  가리게 됐는데(전체 검토 2026-09-28) 목록은 계속 읽어, `tier:nano` 를 광고해 놓고 요청하면 조용히 기본 풀로 갔다.
 *  처방: 목록이 같은 판정(`resolveTier`)을 부른다 — 광고와 실제가 갈릴 수 없다.
 */
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "gateway-models-list-matches-resolution",
  guards: "게이트웨이 모델 목록이 옛 MODEL_TIER_* env 로 등급을 광고하는데 요청은 그 등급을 못 풀어 기본 풀로 조용히 빠지던 것",
  run: async (): Promise<Assertion[]> => {
    const { existsSync, readFileSync, writeFileSync, rmSync } = await import("node:fs");
    const path = await import("node:path");
    const { getPaths } = await import("../../core/paths.js");
    const { resolveTier } = await import("../../core/llm-runtime/index.js");
    const { buildModelsListResponse } = await import(new URL("../../../plugins/http-bridge/gateway.ts", import.meta.url).href) as {
      buildModelsListResponse: (poolRaw: string) => { data: Array<{ id: string }> };
    };
    const settingsFile = path.join(getPaths().home, "settings.json");
    const prevSettings = existsSync(settingsFile) ? readFileSync(settingsFile, "utf8") : undefined;
    const prevNano = process.env.MODEL_TIER_NANO;
    const ids = () => buildModelsListResponse("").data.map((d) => d.id);
    try {
      process.env.MODEL_TIER_NANO = "google:gemini-legacy-nano";
      // 프로파일 설치본 — 옛 env 는 가려진다.
      writeFileSync(settingsFile, JSON.stringify({ models: { default: "low", profiles: { low: { pool: ["anthropic:claude-haiku-4-5"] } } } }) + "\n");
      const withProfiles = { ids: ids(), nano: resolveTier("nano").length };
      // 첫 풀이 안 풀리는 프로파일(옮기지 않은 `ollama:…`) — 폴백이 있으면 그리로, 없으면 광고하지 않는다(적대 검토 P4-1).
      writeFileSync(settingsFile, JSON.stringify({ models: { default: "low", profiles: {
        low: { pool: ["anthropic:claude-haiku-4-5"] },
        local: { pool: ["ollama:qwen3:8b"] },
        chained: { pool: ["ollama:qwen3:8b"], fallback: "low" },
      } } }) + "\n");
      const stale = { ids: ids(), chained: resolveTier("chained").length, local: resolveTier("local").length };
      const everyAdvertisedResolves = stale.ids.filter((i) => i.startsWith("tier:")).every((i) => resolveTier(i.slice(5)).length > 0);
      // 아무 풀도 안 풀리는 프로파일도 광고하지 않는다.
      writeFileSync(settingsFile, JSON.stringify({ models: { default: "local", profiles: { local: { pool: ["ollama:qwen3:8b"] } } } }) + "\n");
      const dead = { ids: ids(), local: resolveTier("local").length };
      // 옛 설치본(프로파일 없음) — env 가 그대로 쓰인다.
      writeFileSync(settingsFile, "{}\n");
      const legacy = { ids: ids(), nano: resolveTier("nano").length };
      return [
        assert("★프로파일 설치본: 요청이 못 푸는 `tier:nano` 를 광고하지 않는다", !withProfiles.ids.includes("tier:nano") && withProfiles.nano === 0 && withProfiles.ids.includes("tier:low"), withProfiles),
        assert("★광고한 `tier:*` 는 전부 요청하면 풀린다 — 첫 풀이 안 풀리는 프로파일은 광고하지 않는다(요청하면 게이트웨이 풀로 가므로)",
          everyAdvertisedResolves && !stale.ids.includes("tier:local") && !stale.ids.includes("tier:chained") && stale.local === 0 && stale.chained === 0,
          stale),
        assert("★아무 풀도 안 풀리는 프로파일은 광고하지 않는다", !dead.ids.includes("tier:local") && dead.local === 0, dead),
        assert("반대 방향: 옛 설치본은 env 등급을 그대로 광고하고, 요청도 푼다", legacy.ids.includes("tier:nano") && legacy.nano > 0, legacy),
      ];
    } finally {
      if (prevNano === undefined) delete process.env.MODEL_TIER_NANO; else process.env.MODEL_TIER_NANO = prevNano;
      if (prevSettings === undefined) rmSync(settingsFile, { force: true }); else writeFileSync(settingsFile, prevSettings);
    }
  },
};
