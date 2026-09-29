/**
 * **옛 `.env` 모델 설정을 프로파일로 한 번 옮긴다** (2026-09-29 정태님 결정 — «A: 한 번 옮기고 없애기»).
 *
 * ★왜: 모델은 `settings.json` 프로파일(세션 기본 프로파일 + 빌트인)로 정한다. 그런데 해석 순서 사이에
 *  `.env` 의 `REGION_A_MODELS`(메인 풀)·`MODEL_TIER_*`(등급 풀)가 **프로파일이 0개일 때만** 끼어 있었다 —
 *  v0.3.95(2026-07-14) 이전 설치의 흔적이다. 층이 둘이면 «지금 무엇으로 도나» 를 두 곳에서 답하게 된다
 *  (`/model` 이 프로파일 풀을 «env 풀» 이라 부르고, `doctor` 가 프로파일이 있어도 env 가 비면 치명으로 셌다).
 * ★그래서 그 값이 **실제로 모델을 정하던 설치**(프로파일 0개 + 값 있음)만 프로파일로 옮기고, 런타임은 env 를 더
 *  읽지 않는다. 사용자가 적어 둔 모델은 그대로 유지된다([[feedback_existing_settings_are_deliberate]]).
 * ★두 값을 **같이** 옮긴다 — 프로파일이 하나라도 생기면 `MODEL_TIER_*` 는 원래도 안 읽혔으므로(`resolveTier`),
 *  메인 풀만 옮기면 서브에이전트 등급이 조용히 빌트인으로 바뀐다.
 * ★옮기기 전 원본을 `settings.json.before-legacy-model-env` 로 남긴다. `.env` 는 건드리지 않는다(안 읽힐 뿐).
 * ★판단은 순수 함수(`planLegacyModelMigration`)에 — 쓰기는 얇게. 검사가 설정 파일 없이 판정을 돌린다.
 */
import { copyFileSync, existsSync, writeFileSync } from "node:fs";
import { getPaths } from "./paths.js";
import type { ModelProfile } from "./settings.js";
import { countHomeModelProfiles, profileToSettingsJson } from "./settings.js";
import { readSettingsRootForWrite, writeSettingsRootAtomic } from "./settings-file.js";

const TIERS = [
  ["high", "MODEL_TIER_HIGH"],
  ["mid", "MODEL_TIER_MID"],
  ["low", "MODEL_TIER_LOW"],
  ["nano", "MODEL_TIER_NANO"],
] as const;

const splitPool = (v: string | undefined): string[] =>
  (v ?? "").split(",").map((s) => s.trim()).filter((s) => s !== "");

export interface LegacyModelPlan {
  profiles: Record<string, ModelProfile>;
  /** 세션 기본 프로파일 — 항상 정한다(못 정하면 옮기지 않는다 — 아래 `planLegacyModelMigration`). */
  defaultName: string;
  /** 메인 풀이 없어서 **지금 빌트인 기본 풀**을 적었나 — 그 메인은 자동 최신을 더 따르지 않는다(로그로 말한다). */
  frozeBuiltinMain: boolean;
}

/**
 * 옮길 게 있나 — 없으면 null. `homeProfiles` > 0 이면 env 는 원래도 안 읽혔으므로 옮기지 않는다(**홈 층**만 센다).
 * 메인 풀이 어떤 등급 풀과 같으면(옛 설치 마법사가 `REGION_A_MODELS = MODEL_TIER_HIGH` 로 썼다) 그 등급을 기본으로,
 * 다르면 `default` 프로파일을 만든다.
 * ★메인 풀이 **없으면** 옛 메인은 빌트인이었다 — 그 자리를 비워 두면 «첫 프로파일» 이 메인이 된다(적대 검토 P-1 재현:
 *  `MODEL_TIER_NANO=ollama:…` 만 둔 자동 설치의 **메인 턴이 로컬 qwen 으로** 갔다). 그래서 `builtinMain`(지금 빌트인이 메인에
 *  주는 풀)을 `default` 로 적고 기본으로 지정한다 — 오늘의 메인 모델이 그대로다. 대가: 이 드문 모양에선 메인이 자동 최신을 더
 *  따르지 않는다(로그로 말한다).
 * ★빌트인 풀도 비었으면(인증 0) **이번엔 옮기지 않는다**(null — 표식도 안 남는다). 등급만 옮기고 기본을 비우면 첫 프로파일이
 *  메인이 되고(P-1 그대로), 적을 메인도 없다. 인증이 잡힌 뒤 부팅에서 옮긴다(재검토 P-A: 종전엔 자리표시 라벨
 *  `anthropic:(default)` 가 메인 풀로 굳었다).
 */
export const planLegacyModelMigration = (
  env: Record<string, string | undefined>,
  homeProfiles: number,
  builtinMain: readonly string[] = [],
): LegacyModelPlan | null => {
  if (homeProfiles > 0) return null;
  const main = splitPool(env.REGION_A_MODELS);
  const tiers = TIERS.map(([name, key]) => [name, key, splitPool(env[key])] as const).filter(([, , p]) => p.length > 0);
  if (main.length === 0 && tiers.length === 0) return null;
  const profiles: Record<string, ModelProfile> = {};
  let defaultName = "default";
  let frozeBuiltinMain = false;
  if (main.length > 0) {
    const same = tiers.find(([, , p]) => p.join(",") === main.join(","));
    if (same !== undefined) defaultName = same[0];
    else profiles.default = { description: "옛 .env REGION_A_MODELS 에서 옮김", pool: main.map((spec) => ({ spec })) };
  } else if (builtinMain.length > 0) {
    profiles.default = { description: "옮길 때의 자동(빌트인) 메인 풀", pool: builtinMain.map((spec) => ({ spec })) };
    frozeBuiltinMain = true;
  } else {
    return null;
  }
  for (const [name, key, pool] of tiers) {
    profiles[name] = { description: `옛 .env ${key} 에서 옮김`, pool: pool.map((spec) => ({ spec })) };
  }
  return { profiles, defaultName, frozeBuiltinMain };
};

/** 옮긴 적이 있다는 표식 — 사용자가 나중에 프로파일을 비워도(자동으로 되돌리려는 의도) 다시 옮기지 않는다(P-2). */
const markerPath = (): string => `${getPaths().settings}.legacy-model-env-migrated`;

/**
 * 부팅 때 — 옮겼으면 옮긴 프로파일 이름, 옮길 게 없으면 null. 실패는 던지지 않고 로그로 말한다
 * (옮기지 못하면 이번 부팅은 빌트인으로 돈다 — 그 사실을 로그만 보고 알 수 있어야 한다).
 * ★«한 번만» 은 표식 파일로 지킨다 — 종전엔 프로파일이 0개면 매 부팅 다시 돌아, 비운 프로파일이 되살아나고 백업도 덮였다.
 * ★기존 `models.profiles` 원문은 **합친다**(읽히지 않던 항목도 이름이 겹치지 않으면 그대로 둔다 — P-6).
 */
export const migrateLegacyModelEnv = (
  env: Record<string, string | undefined> = process.env,
  builtinMain: () => readonly string[] = () => [],
): string[] | null => {
  if (existsSync(markerPath())) return null;
  const homeProfiles = countHomeModelProfiles();
  const builtin = builtinMain();
  const plan = planLegacyModelMigration(env, homeProfiles, builtin);
  if (plan === null) {
    if (homeProfiles === 0 && builtin.length === 0 && TIERS.some(([, key]) => splitPool(env[key]).length > 0))
      console.warn("[settings] 옛 .env MODEL_TIER_* 가 있지만 인증된 모델이 없어 아직 옮기지 않았습니다 — 인증한 뒤 재시작하면 프로파일로 옮깁니다(그때까지 이 값은 읽지 않습니다)");
    return null;
  }
  const file = getPaths().settings;
  const backup = `${file}.before-legacy-model-env`;
  try {
    const root = readSettingsRootForWrite(file); // 깨진 파일이면 던진다 — 그 위에 덮지 않는다(백업도 만들지 않는다).
    if (existsSync(file) && !existsSync(backup)) copyFileSync(file, backup); // 첫 원본만 — 덮지 않는다.
    const models =
      root.models !== null && typeof root.models === "object" && !Array.isArray(root.models)
        ? (root.models as Record<string, unknown>)
        : {};
    const existing =
      models.profiles !== null && typeof models.profiles === "object" && !Array.isArray(models.profiles)
        ? (models.profiles as Record<string, unknown>)
        : {};
    // 파일 모양으로 쓴다(`profileToSettingsJson`) — 메모리 모양을 그대로 쓰면 읽히지 않는다.
    models.profiles = {
      ...existing,
      ...Object.fromEntries(Object.entries(plan.profiles).map(([n, p]) => [n, profileToSettingsJson(p)])),
    };
    models.default = plan.defaultName;
    root.models = models;
    writeSettingsRootAtomic(file, root);
    writeFileSync(markerPath(), `${new Date().toISOString()}\n`);
    const names = Object.keys(plan.profiles);
    console.log(
      `[settings] 옛 .env 모델 설정을 프로파일로 옮겼습니다: ${names.join(", ")}` +
        ` (기본=${plan.defaultName})` +
        (plan.frozeBuiltinMain
          ? " — 메인 풀이 없어 지금 쓰던 자동(빌트인) 메인 풀을 `default` 로 적었습니다(이 메인은 새 모델을 자동으로 따르지 않습니다 — 자동으로 되돌리려면 그 프로파일을 지우세요)"
          : "") +
        ` — 이제 .env 의 REGION_A_MODELS·MODEL_TIER_* 는 읽지 않습니다. 원본: ${backup}`,
    );
    return names;
  } catch (e) {
    console.error(
      `[settings] 옛 .env 모델 설정을 옮기지 못했습니다 — 이번 부팅은 빌트인 모델로 돕니다(${file} 확인): ` +
        (e instanceof Error ? e.message : String(e)),
    );
    return null;
  }
};
