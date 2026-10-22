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
 * 이제 그 자리에서 **지금 인증된 provider 들**로 기본 프로파일 하나를 만든다. 인증 판정은
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
import { catalogDefaultModel } from "./model-catalog.js";
import { PROVIDER_REGISTRY } from "./provider-registry.js";
import { getDefaultProfileName, loadModelProfiles, readBuiltinProfileColors, setBuiltinProfileColor, setProfileColor, isBadgeColor, type ModelProfile } from "../settings.js";

/**
 * 빌트인 프로파일 이름 — **하나뿐이다** (2026-10-22 정태님: «처음 아무것도 셋팅하지 않은 유저를 위한 것뿐이지»).
 * ★종전엔 high/mid/low 셋이었다(2026-08-13). 그런데 사용자가 «high 만 이걸로» 라고 해서 하나를 적으면 사용자 설정이
 *  통째로 이겨 화면엔 high 만 남고, 서브에이전트의 `low` 는 여전히 빌트인 haiku 로 돌았다(화면과 실행이 갈림, 실측).
 *  빌트인을 하나로 두면 «바꾸면 settings.json 에 적히고 적힌 게 이긴다» 하나로 끝난다. 등급 이름(`low` 등)은
 *  같은 이름의 프로파일이 없으면 기본으로 풀린다(`resolveTier`).
 */
export const BUILTIN_PROFILE = "default";

/**
 * provider id → 빌트인 모델. **`PROVIDER_REGISTRY` 의 키여야 한다**(회귀가 검사).
 *
 * ★없는 provider(ollama·google)는 **일부러 비운다** — 로컬/게이트웨이 모델 이름은 우리가
 *  알 수 없고, 모르는 걸 지어내면 "형식은 맞는데 실재하지 않는 ID" 가 되어 매 턴 실패한다.
 *  그런 provider 는 사용자가 `settings.json` 에 직접 적는 게 맞다.
 *
 * ★이 표는 **바닥**이다 — `model-catalog.ts` 가 백엔드에 물어본 값이 있으면 그게 먼저다(2026-08-13).
 *  표는 조회가 안 될 때(네트워크·미인증·구버전) 쓰인다. 늙어도 사용자 설정이 이기고, `/models` 가
 *  어디서 온 값인지 표시하며, 온보딩은 이 표를 디스크에 쓰지 않는다 — 늙은 값이 조용히 박히는 경로가 없게.
 *
 * ★확인 수준: anthropic 은 공식 카탈로그로 **확인**했다(2026-08-13). `codex`/`openai` 의 `gpt-5.5` 는
 *  2026-07-08부터 init 이 시드해 온 값을 물려받은 것이다 — 틀렸다면 그 provider 만 첫 턴에 모델 오류를
 *  내고 풀의 다음으로 넘어간다(조용한 오답이 아니라 시끄러운 실패).
 */
const PROVIDER_DEFAULT_MODELS: Record<string, string> = {
  anthropic: "claude-opus-5",
  codex: "gpt-5.5",
  openai: "gpt-5.5",
};

/**
 * 풀 안에서의 우선순위. anthropic 이 앞인 이유는 취향이 아니라 원칙 1(Claude Code 슈퍼셋)
 * — 능력 기준선이 거기 있다. 뒤의 것들은 앞이 흔들릴 때의 그물이다. 하나만 인증했다면
 * 순서는 아무 의미가 없다.
 */
const ORDER = ["anthropic", "codex", "openai"] as const;

/** 표의 키가 실제 provider 인지 — 회귀에서 검사(오타·삭제된 provider 방치 방지). */
export const builtinProviders = (): string[] => Object.keys(PROVIDER_DEFAULT_MODELS);
export const isRegisteredProvider = (name: string): boolean =>
  Object.prototype.hasOwnProperty.call(PROVIDER_REGISTRY, name);

/**
 * 빌트인 raw 풀(`provider:model` 문자열들) — 인증된 provider 만, ORDER 순.
 * 인증된 게 없으면 `[]`(호출자가 기존 폴백으로 강등).
 */
export const builtinPool = (cwd?: string): string[] => {
  const out: string[] = [];
  for (const provider of ORDER) {
    const model = PROVIDER_DEFAULT_MODELS[provider];
    if (model === undefined) continue;
    if (!providerAuthAvailable(provider, cwd)) continue;
    // ★백엔드에게 물어본 값이 있으면 그게 먼저다 (2026-08-13) — 표가 늙어도 조회가 되는 설치는 최신을 쓴다.
    out.push(`${provider}:${catalogDefaultModel(provider) ?? model}`);
  }
  return out;
};

/**
 * 빌트인 프로파일 — `/models` 표시·프롬프트 인벤토리용. 인증된 provider 가 없으면 `{}`
 * (보여줄 게 없으면 없다고 말한다 — 빈 풀을 있는 척하지 않는다).
 */
export const builtinModelProfiles = (
  cwd?: string,
): Record<string, ModelProfile> => {
  const pool = builtinPool(cwd);
  if (pool.length === 0) return {};
  // 빌트인은 강도를 안 정한다 — 카탈로그 기본이 곧 벤더 설계값이다(오버라이드 0).
  return {
    [BUILTIN_PROFILE]: {
      description: "빌트인 기본 — 모든 작업 · 인증된 provider 의 최신 모델로 자동 조립",
      pool: pool.map((spec) => ({ spec })),
    },
  };
};

/**
 * **지금 이 설치가 실제로 쓰는 프로파일** — 설정이 있으면 그것, 없으면 빌트인 조립.
 *
 * ★소비처마다 폴백을 적지 않기 위해 만든다 (2026-08-19 사용자 신고: "설치하면 기본 모델
 *  프로파일들이 생기지가 않아 — 대시보드에 비어 있는 상태"). 2026-08-13 에 같은 문제를
 *  `/models` 에서 고쳤는데(*"화면과 실행이 갈림"*), 그 폴백을 **그 자리에만** 적었다.
 *  결과: 세 소비처 중 하나만 고쳐졌다.
 *
 *  | 소비처 | 종전 |
 *  |---|---|
 *  | `/models`(채팅) | 빌트인 폴백 있음 ✅ |
 *  | 대시보드 `/model-profiles` | **없음** — 새 설치에서 드롭다운이 빈다 |
 *  | 비서 프롬프트 인벤토리 | **없음** — 모델을 고를 근거가 없다 |
 *
 * ★런타임은 원래 빌트인으로 잘 돈다(설정 0 이어도 인증된 provider 로 조립). 즉 제품은
 *  멀쩡한데 **보여주는 곳만** 비어 있었다 — 사용자에겐 "설치가 덜 된 것" 으로 보인다.
 *
 * @returns `builtin` 은 지금 보여주는 것이 자동 조립인지(화면이 그렇게 표시할 수 있게).
 */
export const resolveModelProfiles = (
  cwd?: string,
): {
  profiles: Record<string, ModelProfile>;
  builtin: boolean;
} => {
  const user = loadModelProfiles(cwd);
  if (Object.keys(user).length > 0) return { profiles: user, builtin: false };
  // 빌트인의 배지 색은 프로파일 밖 칸에 있다(`readBuiltinProfileColors` — 프로파일로 쓰면 자동 조립이 꺼진다).
  const colors = readBuiltinProfileColors(cwd);
  const profiles = builtinModelProfiles(cwd);
  for (const [name, p] of Object.entries(profiles)) if (colors[name] !== undefined) p.color = colors[name];
  return { profiles, builtin: true };
};

/**
 * **고를 수 있는 프로파일인가** — 화면이 보여 주는 목록(`resolveModelProfiles`)과 **같은 판정**.
 * ★종전엔 기본·세션 프로파일 지정이 `loadModelProfiles`(파일에 적힌 것만)로 검사해, 설정 파일이 없는 빌트인 상태에서
 *  화면에 보이는 high/mid/low 를 고르면 «존재하지 않는 프로파일» 400 이었다(2026-10-14, 색 신고와 같은 부류).
 */
export const isSelectableProfile = (name: string, cwd?: string): boolean =>
  resolveModelProfiles(cwd).profiles[name] !== undefined;

/**
 * **실제로 쓰이는 기본 프로파일 이름** — 실행(`resolveModelSpecs`)과 같은 판정: 사용자 프로파일이 있으면
 * `models.default` 가 가리키는 것(`getDefaultProfileName`), 빌트인이면 빌트인 하나(`BUILTIN_PROFILE`).
 */
export const effectiveDefaultProfileName = (cwd?: string): string =>
  resolveModelProfiles(cwd).builtin ? BUILTIN_PROFILE : getDefaultProfileName(cwd);

/**
 * **지금 보이는 프로파일의 배지 색을 쓴다** — 사용자 프로파일이면 그 안에, 빌트인이면 빌트인 색 칸에
 * (2026-10-14 정태님 신고: 설정 파일이 없는 상태에서 색을 고르면 «프로파일을 못 찾음» 400).
 * 어느 쪽인지는 `resolveModelProfiles` 와 **같은 판정**(사용자 프로파일이 하나라도 있나)으로 가른다.
 * @returns 그런 프로파일이 없거나 색 형식이 틀리면 `false`.
 */
export const setResolvedProfileColor = (name: string, color: string | undefined): boolean => {
  if (color !== undefined && !isBadgeColor(color)) return false;
  if (Object.keys(loadModelProfiles()).length > 0) return setProfileColor(name, color);
  if (name !== BUILTIN_PROFILE) return false;
  return setBuiltinProfileColor(name, color);
};
