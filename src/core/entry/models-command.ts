/**
 * `/models` 슬래시 — 모델 프로파일 *목록 표시* (읽기 전용). `/model`(단수, 세션 모델 *설정*)
 * 과 짝이다. 채널 입구(`src/index.ts`)에서 파싱되어 이 순수 렌더러로 흐른다.
 *
 * 설계(원칙 2·4, ADR 2026-07-14 model-profiles):
 *  - LLM-agnostic·채널 무관: 순수 텍스트만 낸다(prompt_options 아님 — 고르는 게 아니라
 *    정보 조회). 텔레그램·대시보드·CLI 가 동일 렌더. 어댑터별 분기 0.
 *  - 순수 함수: (프로파일 맵 + 세션 override + env 스냅샷) → 문자열. IO·전역읽기를 인자로
 *    끌어올려 격리 테스트 가능(라이브 데몬 무접촉 검증). 데이터는 `loadModelProfiles`
 *    (settings.json)·`getSessionModelOverride`(SQLite) 가 호출부에서 조달.
 *  - never-throw 는 상위(replyCommand) 몫 — 여기선 순수 변환만.
 */
import type { ModelProfile, PoolEntry } from "../settings.js";

/** 레거시 티어 env 키 — 프로파일 0개일 때만 폴백 안내에 노출(resolveTier 의 TIER_ENV 와 대응). */
const LEGACY_TIER_ENV_KEYS = [
  "MODEL_TIER_HIGH",
  "MODEL_TIER_MID",
  "MODEL_TIER_LOW",
  "MODEL_TIER_NANO",
] as const;

/**
 * 풀 한 줄 포맷 — 폴백 순서를 화살표로. 빈 풀은 명시.
 *
 * ★프로파일이 강도를 덮었으면 **그 자리에 같이 적는다** (2026-08-24). 층이 셋이라
 *  (풀 원소 > models.reasoning > 카탈로그) 어디서 온 값인지 안 보이면, 전역을 바꿔도
 *  안 먹는 이유를 알 수 없다 — 그게 이 기능의 진짜 위험이다.
 */
const formatPool = (pool: readonly PoolEntry[]): string => {
  const parts = pool.filter((e) => e.spec.trim() !== "");
  if (parts.length === 0) return "(빈 풀 — 어댑터 디폴트로 강등)";
  return parts
    .map((e) =>
      e.reasoning === undefined
        ? `\`${e.spec.trim()}\``
        : `\`${e.spec.trim()}\`(강도 ${e.reasoning})`,
    )
    .join(" → ");
};

/** 프로파일 하나를 블록으로. 기본 프로파일(`defaultName` 지목)에는 (기본) 표식. */
const formatProfile = (
  name: string,
  prof: ModelProfile,
  isDefault: boolean,
): string => {
  const lines: string[] = [];
  const desc = prof.description?.trim();
  const tag = isDefault ? " (기본)" : "";
  lines.push(
    desc && desc !== ""
      ? `● \`${name}\`${tag} — ${desc}`
      : `● \`${name}\`${tag}`,
  );
  lines.push(`   풀: ${formatPool(prof.pool)}`);
  if (prof.fallback !== undefined && prof.fallback.trim() !== "") {
    lines.push(`   폴백 프로파일: \`${prof.fallback.trim()}\``);
  }
  return lines.join("\n");
};

/**
 * 프로파일 순서 — 기본 프로파일(`defaultName`)을 맨 앞으로, 나머지는 삽입 순서 유지.
 * 결정적이라 렌더 출력이 안정적(테스트·다채널 동일 — 대시보드 /model-profiles 정렬과 일치).
 */
const orderedNames = (
  profiles: Record<string, ModelProfile>,
  defaultName: string,
): string[] => {
  const keys = Object.keys(profiles);
  const rest = keys.filter((k) => k !== defaultName);
  return keys.includes(defaultName) ? [defaultName, ...rest] : rest;
};

/** 프로파일 0개일 때의 레거시 env 폴백 안내 블록. */
const renderLegacyFallback = (env: NodeJS.ProcessEnv): string => {
  const lines: string[] = [
    "정의된 모델 프로파일이 없습니다 (settings.json 의 `models.profiles` 비어 있음).",
    "",
  ];
  const active: string[] = [];
  const region = (env.REGION_A_MODELS ?? "").trim();
  if (region !== "") active.push(`  REGION_A_MODELS = \`${region}\``);
  for (const key of LEGACY_TIER_ENV_KEYS) {
    const val = (env[key] ?? "").trim();
    if (val !== "") active.push(`  ${key} = \`${val}\``);
  }
  if (active.length > 0) {
    lines.push("레거시 env 폴백으로 동작 중:", ...active);
  } else {
    lines.push(
      "레거시 env(REGION_A_MODELS / MODEL_TIER_*)도 설정되지 않음 → anthropic SDK 디폴트로 동작.",
    );
  }
  lines.push(
    "",
    "프로파일은 `<home>/settings.json` 의 `models.profiles.<이름>` 에 정의합니다.",
  );
  return lines.join("\n");
};

/**
 * `/models` 응답 본문 렌더 — 순수 함수.
 *
 * @param profiles       `loadModelProfiles()` 결과(홈+프로젝트 병합).
 * @param sessionOverride 이 채널/thread 의 세션 모델 override(`getSessionModelOverride`), 없으면 null.
 * @param defaultName    기본 프로파일 이름(`getDefaultProfileName()` = settings.json models.default
 *                        포인터). 정렬(맨 앞)·(기본) 표식 기준. 미지정 시 `"default"`(무회귀).
 * @param env            레거시 폴백 안내용 env 스냅샷(기본 process.env — 테스트는 주입).
 */
export const renderModelProfiles = (
  profiles: Record<string, ModelProfile>,
  sessionOverride: string | null,
  defaultName = "default",
  env: NodeJS.ProcessEnv = process.env,
  builtin = false,
): string => {
  const blocks: string[] = ["🧩 모델 프로파일"];
  // ★출처를 밝힌다 (2026-08-13) — 프로파일이 settings.json 에 없으면 인증된 provider 로
  //  자동 조립한 값을 보여주는데, 그걸 사용자가 적어둔 것과 구분 못 하면 "내가 언제
  //  이걸 설정했지" 가 된다. 자동값은 자동이라고 말하고, 어디를 고치면 되는지 같이 준다.
  if (builtin) {
    blocks.push(
      "출처: **빌트인 자동값** — `settings.json` 에 프로파일이 없어 " +
        "지금 인증된 provider 로 조립했습니다. 하나라도 직접 적으면 그쪽이 이깁니다.",
    );
  }

  // 세션 override 는 프로파일보다 우선(그 대화의 메인 turn 을 고정) — 있으면 맨 위에 명시.
  if (sessionOverride !== null && sessionOverride.trim() !== "") {
    blocks.push(
      `현재: 이 대화의 세션 모델 override \`${sessionOverride.trim()}\` ` +
        "(프로파일 무시 · `/model reset` 으로 해제)",
    );
  }

  const names = orderedNames(profiles, defaultName);
  if (names.length === 0) {
    blocks.push(renderLegacyFallback(env));
    return blocks.join("\n\n");
  }

  blocks.push(
    names
      .map((n) => formatProfile(n, profiles[n]!, n === defaultName))
      .join("\n\n"),
  );
  blocks.push("프로파일 추가·수정은 대화로 요청하세요 (비서가 settings.json 을 편집합니다).");
  return blocks.join("\n\n");
};
